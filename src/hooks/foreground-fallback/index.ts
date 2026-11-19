/**
 * Runtime model fallback for foreground (interactive) agent sessions.
 *
 * Retry hooks select an untried model from the agent's configured chain and
 * switch the host's current turn in place. Content-filter refusals and no-route
 * failures share selection and continue the request after a confirmed switch.
 *
 * Spent-allowance errors (issue #966) mark the failing provider exhausted
 * for the descent: failover skips that provider's remaining chain entries,
 * and the error surfaces to the user once no other provider remains.
 *
 */

import type { PluginInput } from '@opencode-ai/plugin';
import { responseError, stringifyError } from '../../utils/child-transcript';
import { isRecord } from '../../utils/guards';
import { createInternalAgentTextPart } from '../../utils/internal-initiator';
import { log } from '../../utils/logger';
import { getClient } from '../../utils/opencode-client';
import {
  normalizeAgentHint,
  resolveSessionAgent,
} from '../../utils/prompt-agent';
import { redactSecretsForLog } from '../../utils/redact';
import {
  OperationTimeoutError,
  parseModelReference,
  withTimeout,
} from '../../utils/session';
import type { TimerHandle, TimerSeam } from '../../utils/timer-seam';
import type { ExperimentalV2, V2GenerateModelRef } from '../../v2/client-shim';
import {
  isNoRouteAnchor,
  noRouteModel,
  noRouteOutcomeID,
} from '../../v2/terminal-fallback';
import type { SessionLifecycle } from '../session-lifecycle';
import { asHttpStatus } from './dedup';

/** Timer port for deterministic test control (see `src/utils/test-timers.ts`):
 *  `now` is observation time; scheduling
 *  comes from `TimerSeam`. Wire both from one harness only when a test wants
 *  them to track together. */
export interface ForegroundFallbackTimers extends TimerSeam {
  now?: () => number;
}

type V2SwitchDetail = {
  agentName: string | undefined;
  variant: string | undefined;
};
type V2SwitchModel = NonNullable<ExperimentalV2['switchModel']>;
type ChildOutcome = Promise<string | undefined>;
type SessionStatusProps = {
  sessionID?: string;
  info?: { id?: string };
  status?: {
    type?: string;
    message?: string;
    attempt?: number;
    next?: number;
  };
  error?: unknown;
};
type V2RefusalStep = {
  assistantMessageID: string;
  agent: string;
  model: V2GenerateModelRef | undefined;
  epoch: number;
};

// ---------------------------------------------------------------------------
// Retryable error detection
// ---------------------------------------------------------------------------

// Match quota/billing codes and phrases, not generic credits/billing text.
const QUOTA_BILLING_PATTERNS = [
  /\bpersonal-team-blocked\b/i,
  /\bspending.?limit\b/i,
  /\b(?:ran|run) out of credits\b/i,
  // Quoted Zhipu codes also cover non-English JSON error bodies.
  /"1113"/,
  /"1308"/,
  /"1309"/,
  /"1310"/,
  /\bcoding plan package has expired\b/i,
  /\b(?:weekly|monthly) limit exhausted\b/i,
  // Deterministic claude-agent subscription-limit signature (issue #1918):
  // "You've hit your weekly limit · Resets at <ISO timestamp>". No HTTP
  // status and type provider.unknown, so only this exact phrasing can
  // classify it. Narrow by design: a bare "weekly limit" without the
  // "You've hit your" prefix must not match.
  /you['’]?ve hit your (?:weekly|5-hour) limit/i,
  /\bindividual quota reached\b/i,
  /\bupgrade your subscription to increase your limits\b/i,
  /\baccount pool (?:has no account available|is unavailable)\b/i,
  /\bquota resets? in\s+\d+(?:\.\d+)?\s*[dhms]\b/i,
  /\brequested Antigravity model is not available to the configured accounts\b/i,
];

const PROVIDER_ERROR_PATTERNS = [
  /\b429\b/,
  /rate.?limit/i,
  /too many requests/i,
  // NOTE: spent-allowance wording (isSpentQuotaError, issue #966) still
  // fails over, but excludes the failing provider for the descent.
  /quota.?exceeded/i,
  /\bquota\b.*\bexhausted/i,
  /quota.?threshold/i,
  /usage.?exceeded/i,
  /ExceededBudget/i,
  /over.?budget/i,
  /usage limit/i,
  /overloaded/i,
  /resource.?exhausted/i,
  /insufficient.?(quota|balance)/i,
  /high concurrency/i,
  /reduce concurrency/i,
  /monthly usage limit/i,
  /5-hour usage limit/i,
  /weekly usage limit/i,
  // Forbidden / 403 — providers return these instead of explicit rate-limit
  // signals, but they are equally transient and should trigger fallback.
  /\b403\b/,
  /forbidden/i,
  /blocked by gateway/i,
  // Auth/credential availability (e.g. CliProxyAPI disables an exhausted
  // upstream and returns 503 "auth_unavailable: no auth available ...").
  // The provider is temporarily unavailable, so the next model should be
  // tried instead of retrying the same dead model.
  /no auth available/i,
  /auth_unavailable/i,
  // 401 upstream auth/provider errors — the provider rejected the request,
  // so the next model should be tried instead of retrying the dead one.
  // Match the status code only, not the generic "upstream request failed" /
  // "provider returned error" wording, which wraps any provider 4xx (e.g. a
  // genuine 400 the next model would reproduce) and must stay a hard error.
  /\b401\b/,
  ...QUOTA_BILLING_PATTERNS,
];

// Spent allowance (issue #966): waiting on this provider cannot recover, so
// the provider is skipped for the descent — unless the same carrier carries
// short-horizon retry phrasing.
const SPENT_QUOTA_PATTERNS = [
  /quota.?exceeded/i,
  /usage.?exceeded/i,
  /usage.?limit has been reached/i,
  /usage.?limit reached/i,
];

// Short-horizon retry phrasing: the quota may reset soon, so the normal
// failover applies. Excludes bare "Resets in X days/min" (issue #966).
const SHORT_HORIZON_RETRY_PATTERN =
  /retry (after|in)|resets? (after|at)|will reset at|try again|per minute|per day|\btpm\b|\brpm\b/i;

const PROVIDER_STATUS_CODES = new Set([401, 402, 403, 429, 500, 502, 503, 504]);
// v2 host classification ({type, message, status?}); status is omitted when
// the failure carried no HTTP status (e.g. stream-level provider errors).
const FAILOVER_ERROR_TYPES = new Set([
  'provider.rate-limit',
  'provider.quota',
  'provider.auth',
  'provider.internal',
  'provider.transport',
]);
// (ponytail) validated against real OpenCode error shapes
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);
const TRANSPORT_MESSAGE_PATTERNS = [
  /^fetch failed$/i,
  /^socket hang up$/i,
  /^provider request timeout$/i,
  /^request timeout$/i,
  /^connect ECONNREFUSED\b/i,
  /^getaddrinfo ENOTFOUND\b/i,
  // Bun's fetch aborts connections whose response headers never arrive
  // (e.g. an upstream holding the request instead of answering) with this
  // client-side phrasing. Classify it as failover so a hanging upstream
  // triggers the model chain instead of dying as an opaque error.
  /response headers timed out/i,
  // Provider SDKs also report connection failures with natural-language
  // messages (e.g. "stream error: Cannot connect to API") that carry no
  // transport code. Match the narrow phrase only.
  /cannot connect to api/i,
  /did not begin a response within the pre-response time limit/i,
  // Provider auth plugins throw this once their lifecycle ends (e.g.
  // "Antigravity plugin has been disposed" after a host reload). The
  // provider is gone for this request, so the next model should be tried.
  /\bplugin has been disposed\b/i,
];
const PROVIDER_OUTAGE_PATTERNS = [
  /\binternal server error\b/i,
  /\bbad gateway\b/i,
  /\bgateway timeout\b/i,
  /\bservice unavailable\b/i,
  /\bupstream outage\b/i,
  /\bprovider outage\b/i,
  /\bprovider unavailable\b/i,
  /\bno available channel/i,
];
const REQUEST_ERROR_PATTERNS = [
  // Match policy/filter signatures, not generic flagged/policy error text.
  /\bcyber_policy\b/,
  /\bcontent_policy_violation\b/,
  /flagged for possible cybersecurity risk/i,
  /rejected as a result of our safety system/i,
  /response was blocked by the provider's content filter/i,
  /consecutive unknown assistant finishes without tool calls/i,
  /"1301"/,
  /potentially unsafe or sensitive content/i,
  /rejected because it was considered high risk/i,
  /\b(?:DataInspectionFailed|data_inspection_failed)\b/,
  /may contain inappropriate content/i,
  /Content blocked by guardrail/i,
  /\bflagged_input\b/,
  /"error_type"\s*:\s*"refusal"/,
  /\bmodel\b.*\bnot available\b/i,
  /\bmodel is not available\b/i,
  /\bunsupported model\b/i,
  /\bunknown model\b/i,
  /\bmodel unavailable\b/i,
  /\bvariant unavailable\b/i,
  // OpenCode's ProviderModelNotFoundError uses "Model not found" wording; the
  // model may exist on a later entry in the configured chain.
  /\bmodel not found\b/i,
  // Model retired/end-of-life (HTTP 410 Gone) — the model no longer exists,
  // so the next model must be tried instead of retrying the dead one.
  /\bend of life\b/i,
  /\bno longer available\b/i,
  /\breached its end of life\b/i,
  // The AI SDK surfaces HTTP 410 as the bare title "Gone" in the message,
  // with the detail in responseBody. Match the bare title and explicit 410.
  /(?:^|\s)Gone(?:$|\s)/i,
  /\bHTTP 410\b/i,
  /\bstatus.?410\b/i,
];
// Gateways can report transient streaming backpressure without an HTTP status.
// A deterministic 4xx in the same failure still takes precedence.
const GATEWAY_BACKPRESSURE_PATTERNS = [
  /\bstreaming response failed\b/i,
  /\brequest queue is full\b/i,
  /\bworker local total request limit reached\b/i,
];
/** 4xx other than 408 (timeout) and 429 (rate limit). */
const DETERMINISTIC_4XX_PATTERN = /\b4(?!08\b|29\b)\d\d\b/;
// "upstream error" alone is ambiguous: proxies wrap deterministic 4xx (a
// 400-bodied validation failure, a policy rejection) in the same wording.
// Only treat it as transient when the same message carries a 5xx status,
// an outage marker, or a timeout/unavailable marker.
const UPSTREAM_ERROR_PATTERN = /\bupstream error\b/i;
const UPSTREAM_TRANSIENT_MARKERS = [
  /\b5\d\d\b/,
  /time.?out/i,
  /timed out/i,
  /\bunavailable\b/i,
  /\boverload/i,
  /\btry again\b/i,
  /\brate.?limit\b/i,
  /\b429\b/,
];

/** True when the failure carries a 4xx other than 408/429, in its status
 *  or its text: every replay of that request would reproduce it. */
function hasDeterministic4xx(
  text: string,
  statusCode: number | undefined,
): boolean {
  return (
    (statusCode !== undefined &&
      statusCode >= 400 &&
      statusCode < 500 &&
      statusCode !== 408 &&
      statusCode !== 429) ||
    DETERMINISTIC_4XX_PATTERN.test(text)
  );
}

/** True for "upstream error" with transient context, or gateway
 *  backpressure wording, when no deterministic 4xx is present. */
function isTransientGatewayError(
  text: string,
  statusCode: number | undefined,
): boolean {
  if (hasDeterministic4xx(text, statusCode)) return false;
  return (
    (UPSTREAM_ERROR_PATTERN.test(text) &&
      UPSTREAM_TRANSIENT_MARKERS.some((pattern) => pattern.test(text))) ||
    GATEWAY_BACKPRESSURE_PATTERNS.some((pattern) => pattern.test(text))
  );
}

function nestedField(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined;
}

/** Structured provider body (v2 wraps it in `data.body` or a raw JSON
 *  `responseBody`), plus the raw string for whole-carrier matching. */
function errorBody(error: Record<string, unknown>): {
  rawBody: string | undefined;
  bodyObj: Record<string, unknown> | undefined;
  bodyError: Record<string, unknown> | undefined;
} {
  const { data, cause, response } = error;
  const body =
    nestedField(data, 'body') ??
    nestedField(response, 'body') ??
    nestedField(cause, 'body') ??
    error.body;
  const raw =
    nestedField(data, 'responseBody') ??
    nestedField(cause, 'responseBody') ??
    error.responseBody;
  const rawBody = typeof raw === 'string' ? raw : undefined;
  let bodyObj = isRecord(body) ? body : undefined;
  if (!bodyObj && rawBody !== undefined) {
    try {
      const parsed = JSON.parse(rawBody);
      if (isRecord(parsed)) bodyObj = parsed;
    } catch {
      // Not JSON: the raw string still reaches errorMessages.
    }
  }
  const bodyError = isRecord(bodyObj?.error) ? bodyObj.error : undefined;
  return { rawBody, bodyObj, bodyError };
}

function extractStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const { data, cause, response } = error;
  const dataObj = isRecord(data) ? data : undefined;
  const causeObj = isRecord(cause) ? cause : undefined;
  const responseObj = isRecord(response) ? response : undefined;
  const { bodyObj, bodyError } = errorBody(error);

  const candidates = [
    error.statusCode,
    nestedField(dataObj, 'statusCode'),
    nestedField(causeObj, 'statusCode'),
    error.status,
    nestedField(responseObj, 'status'),
    nestedField(responseObj, 'statusCode'),
    nestedField(dataObj, 'status'),
    nestedField(nestedField(dataObj, 'response'), 'status'),
    nestedField(causeObj, 'status'),
    nestedField(nestedField(causeObj, 'response'), 'status'),
    nestedField(bodyError, 'code'),
    nestedField(bodyObj, 'code'),
  ];
  return candidates.map(asHttpStatus).find((status) => status !== undefined);
}

function eventSessionID(props: {
  sessionID?: string;
  info?: { id?: string };
}): string | undefined {
  return props.sessionID ?? props.info?.id;
}

/** Per-carrier wording texts a spent-quota signal can hide in (issue #966). */
function failoverCarriers(err: Record<string, unknown>): string[] {
  return [
    err.code,
    err.message,
    nestedField(err.data, 'code'),
    nestedField(err.data, 'message'),
    nestedField(err.data, 'responseBody'),
    nestedField(err.cause, 'code'),
    nestedField(err.cause, 'message'),
    err.responseBody,
  ]
    .filter(
      (value): value is string | number =>
        (typeof value === 'string' && value !== '') ||
        typeof value === 'number',
    )
    .map(String);
}

/**
 * Spent allowance (issue #966): spent-quota wording without short-horizon
 * retry phrasing in the same carrier. The manager excludes the failing
 * provider for the rest of the descent and surfaces the error once no chain
 * entry on another provider remains. Free-tier plan exhaustion is exempt:
 * upstream routes it as permanent billing (immediate failover, budget skip).
 */
const FREE_TIER_BILLING_PATTERN = /free usage exceeded|subscribe to go/i;

export function isSpentQuotaError(error: unknown): boolean {
  if (typeof error === 'string') {
    return (
      SPENT_QUOTA_PATTERNS.some((pattern) => pattern.test(error)) &&
      !SHORT_HORIZON_RETRY_PATTERN.test(error) &&
      !FREE_TIER_BILLING_PATTERN.test(error)
    );
  }
  if (!isRecord(error)) return false;
  return failoverCarriers(error).some(
    (carrier) =>
      SPENT_QUOTA_PATTERNS.some((pattern) => pattern.test(carrier)) &&
      !SHORT_HORIZON_RETRY_PATTERN.test(carrier) &&
      !FREE_TIER_BILLING_PATTERN.test(carrier),
  );
}

function errorMessages(error: unknown): string[] {
  if (typeof error === 'string') return [error];
  if (!isRecord(error)) return [];
  const { data, cause } = error;
  const dataObj = isRecord(data) ? data : undefined;
  const causeObj = isRecord(cause) ? cause : undefined;
  const { rawBody, bodyObj, bodyError } = errorBody(error);

  return [
    error.message,
    nestedField(dataObj, 'message'),
    rawBody,
    nestedField(causeObj, 'message'),
    nestedField(nestedField(causeObj, 'data'), 'message'),
    typeof error.status === 'string' ? error.status : undefined,
    typeof nestedField(dataObj, 'status') === 'string'
      ? (nestedField(dataObj, 'status') as string)
      : undefined,
    nestedField(bodyObj, 'message'),
    nestedField(bodyError, 'message'),
    typeof nestedField(bodyObj, 'status') === 'string'
      ? (nestedField(bodyObj, 'status') as string)
      : undefined,
    typeof nestedField(bodyError, 'status') === 'string'
      ? (nestedField(bodyError, 'status') as string)
      : undefined,
  ].map((value) => (typeof value === 'string' ? value : ''));
}

const ANTIGRAVITY_412_PATTERNS = [
  /\baccount pool (?:has no account available|is unavailable)\b/i,
  /\brequested Antigravity model is not available to the configured accounts\b/i,
  /\bAntigravity did not begin a response within the pre-response time limit\b/i,
  /\bFAILED_PRECONDITION\b/,
  /\bquota resets? in\s+\d+(?:\.\d+)?\s*[dhms]\b/i,
];

function isAntigravity412Error(text: string, statusCode?: number): boolean {
  if (ANTIGRAVITY_412_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  // A bare "Precondition Failed" 412 is a request rejection (e.g. If-Match):
  // require an Antigravity, pool, or quota signal.
  return (
    statusCode === 412 &&
    (/\bantigravity\b/i.test(text) ||
      /\baccount pool\b/i.test(text) ||
      /\bquota\b/i.test(text))
  );
}

function failoverScope(error: unknown): 'provider' | 'request' | undefined {
  const messages = errorMessages(error);
  const text = messages.join(' ');
  const statusCode = extractStatusCode(error);
  // Recognizable failover bodies count under HTTP 400; other 400s stay hard.
  // OpenRouter can wrap policy rejections in HTTP 403. The request-specific
  // reason must win over provider status/type/transport signals. 421 and 451
  // are request rejections (content filter / legal), not provider outages.
  if (
    nestedField(error, 'type') === 'provider.content-filter' ||
    nestedField(error, 'type') === 'provider.no-route' ||
    statusCode === 410 ||
    statusCode === 421 ||
    statusCode === 451 ||
    REQUEST_ERROR_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return 'request';
  }
  if (
    isAntigravity412Error(text, statusCode) ||
    PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(text)) ||
    PROVIDER_OUTAGE_PATTERNS.some((pattern) => pattern.test(text)) ||
    messages.some((message) =>
      TRANSPORT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message)),
    )
  ) {
    return 'provider';
  }
  // "upstream error" alone is ambiguous: proxies wrap deterministic 4xx
  // (a 400-bodied validation failure, a policy rejection) in the same
  // wording. Only treat it as failover with transient context in the
  // same message.
  if (isTransientGatewayError(text, statusCode)) return 'provider';
  if (!isRecord(error)) return undefined;
  if (
    (statusCode !== undefined && PROVIDER_STATUS_CODES.has(statusCode)) ||
    (typeof error.type === 'string' && FAILOVER_ERROR_TYPES.has(error.type)) ||
    [
      error.code,
      nestedField(error.cause, 'code'),
      nestedField(error.data, 'code'),
    ].some((code) => typeof code === 'string' && TRANSPORT_CODES.has(code))
  ) {
    return 'provider';
  }
  return undefined;
}

export function isFailoverError(error: unknown): boolean {
  return failoverScope(error) !== undefined;
}

const INLINE_STATUS_CODES = new Set([401, 410]);
const PERMANENT_QUOTA_BILLING_PATTERNS = [
  ...QUOTA_BILLING_PATTERNS,
  /\bfree usage exceeded\b/i,
  /\bsubscribe to go\b/i,
  /\b(?:1113|1308|1309|1310)\b/,
  /\bFAILED_PRECONDITION\b/,
  // Spent-allowance wording stays out: it keeps the configured initial
  // delay (a recovery window for intercepting plugins).
];

/**
 * Permanent exhaustion skips the initial delay and fails over immediately.
 * Spent-allowance wording is excluded and keeps the configured initial delay.
 */
export function isPermanentQuotaBillingError(error: unknown): boolean {
  const statusCode = extractStatusCode(error);
  if (statusCode === 402) return true;
  const messages = errorMessages(error);
  const text =
    typeof error === 'string'
      ? error
      : isRecord(error)
        ? [
            error.code,
            nestedField(error.data, 'code'),
            nestedField(error.cause, 'code'),
            ...messages,
          ]
            .filter(
              (value): value is string | number =>
                typeof value === 'string' || typeof value === 'number',
            )
            .map(String)
            .join(' ')
        : '';
  // Short-horizon quota resets (e.g. "Rate limited, quota resets in 30s") are
  // transient rate limits, not permanent exhaustion.
  if (
    /\bquota resets? in\s+\d+(?:\.\d+)?\s*s\b/i.test(text) &&
    !/\bquota resets? in\s+\d+(?:\.\d+)?\s*[dhm]\b/i.test(text) &&
    !/\baccount pool (?:has no account available|is unavailable)\b/i.test(
      text,
    ) &&
    !/\bindividual quota reached\b/i.test(text) &&
    !/\brequested Antigravity model is not available to the configured accounts\b/i.test(
      text,
    )
  ) {
    return false;
  }
  if (statusCode === 412 && isAntigravity412Error(text, statusCode)) {
    return true;
  }
  return PERMANENT_QUOTA_BILLING_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * True when the error is the kind the runtime surfaces inline (401 auth,
 * 410 model gone) — persistent, user-visible, already in the conversation.
 * These should NOT get a toast; the runtime's inline rendering is enough.
 * Other failover errors (429 rate-limit, outage, etc.) get a toast instead.
 */
export function isInlineFailoverError(error: unknown): boolean {
  // The AI SDK surfaces 401/410 as bare strings ("Gone",
  // "AI_APICallError: Gone"); match those directly so they stay inline too.
  const statusCode = extractStatusCode(error);
  if (statusCode !== undefined && INLINE_STATUS_CODES.has(statusCode)) {
    return true;
  }
  const text = errorMessages(error).join(' ');
  return (
    /(?:^|\s)Gone(?:$|\s)/i.test(text) ||
    /\b401\b/i.test(text) ||
    /\b410\b/i.test(text) ||
    /\bend of life\b/i.test(text) ||
    /\bno longer available\b/i.test(text)
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Longer host backoffs should use the configured model chain instead. */
const MAX_HOST_RETRY_DELAY_MS = 30 * 60_000;
const PROVIDER_MARK_TTL_MS = 30 * 60_000;
/** Ceiling on host calls: a hung transport must not stall fallback. */
const HOST_CALL_TIMEOUT_MS = 2_000;
const REFUSAL_CONTINUATION =
  "The previous response was stopped by the provider's content filter. Continue from where it stopped without repeating completed content.";
const NO_ROUTE_CONTINUATION =
  'The selected model was unavailable. Continue the previous request using the fallback model.';
/** Transcript tail size for resolving a no-route failure. */
const FALLBACK_REPLAY_TAIL_MESSAGES = 50;

const FALLBACK_IN_PROGRESS_KEY = Symbol.for(
  'oh-my-opencode-slim.foreground-fallback.in-progress',
);

function getProcessFallbacksInProgress(): Set<string> {
  const globalWithStore = globalThis as typeof globalThis & {
    [FALLBACK_IN_PROGRESS_KEY]?: Set<string>;
  };
  globalWithStore[FALLBACK_IN_PROGRESS_KEY] ??= new Set();
  return globalWithStore[FALLBACK_IN_PROGRESS_KEY];
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export type ForegroundFallbackModel = string | { id: string; variant?: string };

type FallbackDescent = {
  model: string;
  variant?: string;
  fallback: string;
  fallbackVariant?: string;
  midTurnAt?: number;
};

export type ForegroundFallbackOptions = {
  /**
   * Ordered fallback chains per agent.
   * e.g. { orchestrator: ['anthropic/claude-opus-4-5', 'openai/gpt-4o'] }
   * Scan from the head, skipping tried models and providers abandoned by
   * this session or its parent.
   */
  chains: Record<string, ReadonlyArray<ForegroundFallbackModel>>;
  input: PluginInput;
  /** Host retry events tolerated before the first model switch. @default 3 */
  maxRetries?: number;
  coordinator?: SessionLifecycle;
  onSessionModelChanged?: (
    sessionID: string,
    model: string,
    detail?: V2SwitchDetail,
  ) => void;
  /**
   * Delay before first fallback; gives intercepting plugins time to recover.
   * @default 0
   */
  initialRetryDelayMs?: number;
  /**
   * Delay between consecutive fallback attempts.
   * @default 500
   */
  retryDelayMs?: number;
  /** Enables steering of host retry decisions. */
  v2RetryEnabled?: boolean;
  timers?: ForegroundFallbackTimers;
};

/**
 * Manages runtime model fallback for foreground agent sessions.
 *
 * Constructed at plugin init with the ordered fallback chains for each agent
 * (built from _modelArray entries in agents.<name>.model).
 */
export class ForegroundFallbackManager {
  private readonly input: PluginInput;
  private readonly maxRetries: number;
  private readonly initialRetryDelayMs: number;
  private readonly retryDelayMs: number;
  private readonly v2RetryEnabled: boolean;
  private readonly chainSource: Record<
    string,
    ReadonlyArray<ForegroundFallbackModel>
  >;
  /** sessionID → chain generation pinned when the session registered (the
   *  same generation as its v2 runtime profile). Shallow copies of the
   *  published table: entry arrays are shared, so publishers replace arrays
   *  and never mutate them in place — pinned generations stay stable. */
  private readonly sessionChains = new Map<
    string,
    Record<string, ReadonlyArray<ForegroundFallbackModel>>
  >();
  /** sessionID → last observed model string ("providerID/modelID") */
  private readonly sessionModel = new Map<string, string>();
  /** sessionID → confirmed fallback model. */
  private readonly activeFallback = new Map<string, string>();
  private readonly descent = new Map<string, FallbackDescent>();
  private readonly restoredFrom = new Map<string, FallbackDescent>();
  private readonly busy = new Set<string>();
  private readonly awaitingRun = new Set<string>();
  private readonly restoreTimers = new Map<string, TimerHandle>();
  private readonly restoring = new Set<string>();
  /** Provider failure timestamps survive internal returns to the primary. */
  private readonly downProviders = new Map<string, Map<string, number>>();
  /** sessionID → agent name observed from the host. */
  private readonly sessionAgent = new Map<string, string>();
  /** True when a SessionLifecycle coordinator owns deletion cleanup. */
  private hasCoordinator = false;

  private readonly sessionRetryEnabled = new Map<string, boolean>();
  private retryEnabledFor(sessionID: string): boolean {
    return this.sessionRetryEnabled.get(sessionID) ?? this.v2RetryEnabled;
  }
  /** child sessionID → parent sessionID (from session.created info). */
  private readonly sessionParent = new Map<string, string>();
  /** sessionID → set of models already attempted this session */
  private readonly sessionTried = new Map<string, Set<string>>();
  /** Request-scoped rejections remain ineligible until the next external turn. */
  private readonly requestRejected = new Map<string, Set<string>>();
  /** sessionID → providers whose allowance is spent (issue #966). The chain
   *  walk skips them; once every chain provider is listed the error
   *  surfaces. Holds at most the providers seen failing, and re-arms with
   *  the retry budget (external turn, recovery, return to primary). A
   *  switch still records the provider in downProviders. */
  private readonly quotaExhaustedProviders = new Map<string, Set<string>>();
  /** Process-local sessions with an active fallback switch in flight. */
  private readonly inProgress = getProcessFallbacksInProgress();
  /** The turn in which a session used its one v2 authentication grace retry. */
  private readonly authGrace = new Map<string, number>();
  // Timer seams
  private readonly now: () => number;
  private readonly setTimer: (
    callback: () => void,
    delay: number,
  ) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly timerSeam: TimerSeam;
  /** Confirmed external user-turn generations fence suspended work. */
  private readonly turnEpoch = new Map<string, number>();
  private readonly startedAt: number;
  private readonly v2Steps = new Map<string, V2RefusalStep>();
  private readonly childOutcomes = new Map<string, ChildOutcome>();
  private readonly refusalRecoveries = new Map<
    string,
    { outcome: ChildOutcome; message: string }
  >();
  /** Seen user IDs keep old host re-emissions from rewinding a newer turn. */
  private readonly observedUserMessageIds = new Map<string, Set<string>>();
  /** Absorbed host retries in the current fallback descent. */
  private readonly sessionRetries = new Map<string, number>();
  /** True after the first initial delay or immediate permanent intervention
   *  has started in the current fallback descent. */
  private readonly initialDelayUsed = new Set<string>();
  /** Exhaustion stage: 0 before exhaustion, 1 after the sticky fallback,
   *  and 2 when no further switch is attempted. */
  private readonly chainExhaustion = new Map<string, number>();
  /** Fences suspended switches after the plugin is disposed. */
  private disposed = false;
  /** Notifies consumers when a session switches models. */
  private readonly onSessionModelChanged?: (
    sessionID: string,
    model: string,
    detail?: V2SwitchDetail,
  ) => void;
  /** Reports an in-flight fallback switch. */
  isFallbackInProgress(sessionID: string): boolean {
    return this.inProgress.has(sessionID);
  }

  /**
   * Disable the fallback chain for a specific agent.
   * After calling this, rate-limit errors for that agent surface instead of
   * silently falling back through the chain.
   */
  disableChain(agentName: string): void {
    // Keep the key present (known agent, no chain) rather than deleting it,
    // so resolveChain's "known agent without a chain" path applies and the
    // normalized chains retain the agent entry.
    this.chainSource[agentName] = [];
  }

  private pinnedChains(
    sessionID: string,
  ): Record<string, ReadonlyArray<ForegroundFallbackModel>> {
    let pinned = this.sessionChains.get(sessionID);
    if (!pinned) {
      pinned = { ...this.chainSource };
      this.sessionChains.set(sessionID, pinned);
    }
    return pinned;
  }

  /** Pin the chain generation in effect when a session registers, so an
   *  in-flight fallback sequence finishes against its own generation even if
   *  a hot refresh publishes a new chain table mid-descent. First call wins;
   *  chain resolution pins lazily as a safety net. */
  pinSessionChains(
    sessionID: string,
    chains?: Record<string, ReadonlyArray<ForegroundFallbackModel>>,
    enabled?: boolean,
  ): void {
    if (enabled !== undefined) this.sessionRetryEnabled.set(sessionID, enabled);
    if (chains) {
      this.sessionChains.set(
        sessionID,
        Object.fromEntries(
          Object.entries(chains).map(([name, entries]) => [
            name,
            entries.map((entry) =>
              typeof entry === 'string' ? entry : { ...entry },
            ),
          ]),
        ),
      );
      return;
    }
    this.pinnedChains(sessionID);
  }

  /** Release a session's pinned generation so a retry after a failed
   *  admission recaptures against the generation current at that retry.
   *  Only safe when no request has run — the capture failed before
   *  admission, so no descent can be mid-flight. */
  releaseSessionChains(sessionID: string): void {
    this.sessionChains.delete(sessionID);
    this.sessionRetryEnabled.delete(sessionID);
  }

  registerSessionAgent(sessionID: string, agentName: string): void {
    const normalizedAgentName = normalizeAgentHint(agentName);
    if (
      !sessionID ||
      !normalizedAgentName ||
      this.sessionAgent.has(sessionID)
    ) {
      return;
    }
    this.sessionAgent.set(sessionID, normalizedAgentName);
    this.pinSessionChains(sessionID);
  }

  private v2AgentName(sessionID: string, hint?: string): string | undefined {
    const agent = hint ? normalizeAgentHint(hint) : undefined;
    return agent && this.pinnedChains(sessionID)[agent]?.length
      ? agent
      : (this.sessionAgent.get(sessionID) ?? agent);
  }

  /** Cancel restore timers and fence off in-flight switches. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.restoreTimers.values()) this.clearTimer(timer);
    this.restoreTimers.clear();
    this.descent.clear();
    this.restoredFrom.clear();
    this.busy.clear();
    this.awaitingRun.clear();
    this.childOutcomes.clear();
    this.refusalRecoveries.clear();
    this.observedUserMessageIds.clear();
    this.downProviders.clear();
    this.authGrace.clear();
  }

  private rememberOutcome(key: string, outcome: ChildOutcome) {
    if (this.childOutcomes.size >= 1024) {
      const oldest = this.childOutcomes.keys().next().value;
      if (oldest !== undefined) this.childOutcomes.delete(oldest);
    }
    this.childOutcomes.set(key, outcome);
    return outcome;
  }

  private refusalOutcome(
    sessionID: string,
    step: V2RefusalStep,
    error: unknown,
    rawFinish?: unknown,
  ): Promise<string | undefined> {
    const key = `${sessionID}\0${step.assistantMessageID}`;
    const existing = this.childOutcomes.get(key);
    if (existing) return existing;
    const outcome = this.rememberOutcome(
      key,
      this.handleV2Refusal(sessionID, step, error, rawFinish),
    );
    const message = nestedField(error, 'message');
    if (typeof message === 'string' && message)
      this.refusalRecoveries.set(sessionID, { outcome, message });
    return outcome;
  }

  refusalRecovery(sessionID: string) {
    const recovery = this.refusalRecoveries.get(sessionID);
    if (!recovery) return;
    return {
      message: recovery.message,
      model: withTimeout(
        recovery.outcome,
        HOST_CALL_TIMEOUT_MS,
        'refusal decision timed out',
        this.timerSeam,
      ).catch(() => undefined),
    };
  }

  pendingRefusalOutcome(sessionID: string, assistantMessageID: string) {
    return this.childOutcomes.get(`${sessionID}\0${assistantMessageID}`);
  }

  /** Model switches persist across external turns. */
  noteExternalTurn(sessionID: string, model?: string): void {
    if (model !== undefined && this.activeFallback.get(sessionID) !== model) {
      this.activeFallback.delete(sessionID);
      this.downProviders.delete(sessionID);
      this.sessionModel.set(sessionID, model);
    }
  }

  noteV2Prompt(sessionID: string): void {
    this.requestRejected.delete(sessionID);
    this.turnEpoch.set(sessionID, (this.turnEpoch.get(sessionID) ?? 0) + 1);
  }

  /** v2 `session.prompt` fence, observed before the hook's awaits: a new
   *  external prompt supersedes in-flight retry switches of the previous turn.
   *  Budgets stay (v2); the shared registry ignores repeated intents. */
  observeExternalPromptIntent(sessionID: string, messageID: string): void {
    if (
      this.disposed ||
      this.observedUserMessageIds.get(sessionID)?.has(messageID)
    )
      return;
    this.restoredFrom.delete(sessionID);
    this.rememberUserMessage(sessionID, messageID);
    this.turnEpoch.set(sessionID, (this.turnEpoch.get(sessionID) ?? 0) + 1);
  }

  private isCurrentTurn(sessionID: string, epoch: number): boolean {
    return !this.disposed && (this.turnEpoch.get(sessionID) ?? 0) === epoch;
  }

  private rememberUserMessage(sessionID: string, messageID: string): void {
    let ids = this.observedUserMessageIds.get(sessionID);
    if (!ids) {
      ids = new Set();
      this.observedUserMessageIds.set(sessionID, ids);
    }
    ids.add(messageID);
  }
  constructor(options: ForegroundFallbackOptions) {
    const {
      chains,
      input,
      maxRetries = 3,
      coordinator,
      onSessionModelChanged,
      initialRetryDelayMs = 0,
      retryDelayMs = 500,
      v2RetryEnabled = false,
      timers,
    } = options;
    this.input = input;
    this.maxRetries = maxRetries;
    this.initialRetryDelayMs = initialRetryDelayMs;
    this.retryDelayMs = retryDelayMs;
    this.v2RetryEnabled = v2RetryEnabled;
    this.chainSource = chains;
    this.onSessionModelChanged = onSessionModelChanged;
    if (coordinator) {
      this.hasCoordinator = true;
      coordinator.onSessionDeleted((id) => this.forgetSession(id));
    }

    // Timer seams: defaults to platform globals
    // Late-bound: tests may patch the Date.now global after construction.
    this.now = timers?.now ?? (() => Date.now());
    this.setTimer =
      timers?.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = timers?.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.startedAt = this.now();
    this.timerSeam = {
      setTimeout: this.setTimer,
      clearTimeout: this.clearTimer,
    };
  }

  /** Drop all per-session state once the session is deleted. */
  private forgetSession(id: string): void {
    this.clearRestoreTimer(id);
    this.descent.delete(id);
    this.restoredFrom.delete(id);
    this.busy.delete(id);
    this.awaitingRun.delete(id);
    this.refusalRecoveries.delete(id);
    this.sessionModel.delete(id);
    this.sessionParent.delete(id);
    this.activeFallback.delete(id);
    this.downProviders.delete(id);
    this.sessionAgent.delete(id);
    this.sessionTried.delete(id);
    this.requestRejected.delete(id);
    this.sessionChains.delete(id);
    this.sessionRetryEnabled.delete(id);
    this.authGrace.delete(id);
    this.v2Steps.delete(id);
    // An in-flight switch releases inProgress in its own finally block.
    this.turnEpoch.set(id, (this.turnEpoch.get(id) ?? 0) + 1);
    this.observedUserMessageIds.delete(id);
    this.sessionRetries.delete(id);
    this.chainExhaustion.delete(id);
    this.quotaExhaustedProviders.delete(id);
    this.initialDelayUsed.delete(id);
  }

  /** Confirmed fallback serving this session, including unexpired provider failures. */
  getActiveFallback(sessionID: string) {
    const model = this.activeFallback.get(sessionID);
    if (!model) return;
    return { model, downProviders: this.getDownProviders(sessionID) };
  }

  private getDownProviders(sessionID: string): Set<string> {
    const downProviders = new Set<string>();
    const now = this.now();
    for (const [provider, recordedAt] of this.downProviders.get(sessionID) ??
      []) {
      if (now - recordedAt < PROVIDER_MARK_TTL_MS) downProviders.add(provider);
    }
    return downProviders;
  }

  restoreTarget(
    sessionID: string,
    midTurn = false,
  ): { model: string; variant?: string } | undefined {
    const descent = this.descent.get(sessionID);
    if (
      !descent ||
      this.disposed ||
      (midTurn
        ? descent.midTurnAt === undefined || this.now() < descent.midTurnAt
        : this.busy.has(sessionID)) ||
      this.awaitingRun.has(sessionID) ||
      this.isFallbackInProgress(sessionID) ||
      this.getDownProviders(sessionID).has(
        parseModelReference(descent.model)?.providerID ?? '',
      )
    )
      return;
    return {
      model: descent.model,
      ...(descent.variant ? { variant: descent.variant } : {}),
    };
  }

  private clearRestoreTimer(sessionID: string): void {
    const timer = this.restoreTimers.get(sessionID);
    if (timer !== undefined) this.clearTimer(timer);
    this.restoreTimers.delete(sessionID);
  }

  private commitRestore(
    sessionID: string,
    descent: { model: string; variant?: string },
    preserveQuota = false,
  ): void {
    this.descent.delete(sessionID);
    this.activeFallback.delete(sessionID);
    this.sessionModel.set(sessionID, descent.model);
    this.resetRecoveryState(sessionID, preserveQuota);
    this.clearRestoreTimer(sessionID);
    this.onSessionModelChanged?.(sessionID, descent.model, {
      agentName: this.sessionAgent.get(sessionID),
      variant: descent.variant,
    });
    log('[foreground-fallback] restored original model', {
      sessionID,
      model: descent.model,
    });
  }

  private async restoreV2(sessionID: string, midTurn = false): Promise<void> {
    const descent = this.descent.get(sessionID);
    if (!descent || this.disposed || this.restoring.has(sessionID)) return;
    const target = this.restoreTarget(sessionID, midTurn);
    if (!target) {
      if (midTurn) return;
      const provider = parseModelReference(descent.model)?.providerID;
      const markedAt = provider
        ? this.downProviders.get(sessionID)?.get(provider)
        : undefined;
      if (
        markedAt !== undefined &&
        markedAt + PROVIDER_MARK_TTL_MS > this.now() &&
        !this.restoreTimers.has(sessionID)
      ) {
        this.restoreTimers.set(
          sessionID,
          this.setTimer(
            () => {
              this.restoreTimers.delete(sessionID);
              void this.restoreV2(sessionID);
            },
            markedAt + PROVIDER_MARK_TTL_MS - this.now(),
          ),
        );
      }
      return;
    }
    const switchModel = (
      this.input as PluginInput & { experimental_v2?: ExperimentalV2 }
    ).experimental_v2?.switchModel;
    const session = getClient(this.input).session;
    if (!switchModel || typeof session.get !== 'function') return;
    this.restoring.add(sessionID);
    let keepMarker = false;
    try {
      const result = await withTimeout(
        session.get({ path: { id: sessionID } }),
        HOST_CALL_TIMEOUT_MS,
        'foreground restore session lookup timed out',
        this.timerSeam,
      );
      const data: unknown = result.data;
      if (
        result.error ||
        !isRecord(data) ||
        !isRecord(data.model) ||
        this.descent.get(sessionID) !== descent ||
        !this.restoreTarget(sessionID, midTurn)
      )
        return;
      const current = data.model;
      const hostModel =
        typeof current.providerID === 'string' && typeof current.id === 'string'
          ? `${current.providerID}/${current.id}`
          : undefined;
      if (!hostModel) return;
      if (
        hostModel === descent.model &&
        (current.variant ?? 'default') === (descent.variant ?? 'default')
      ) {
        this.commitRestore(sessionID, descent);
        return;
      }
      if (
        hostModel !== descent.fallback ||
        (current.variant ?? 'default') !==
          (descent.fallbackVariant ?? 'default')
      ) {
        this.descent.delete(sessionID);
        this.activeFallback.delete(sessionID);
        this.sessionModel.set(sessionID, hostModel);
        this.clearRestoreTimer(sessionID);
        return;
      }
      const ref = parseModelReference(target.model);
      if (!ref) return;
      if (midTurn) this.restoredFrom.set(sessionID, descent);
      await withTimeout(
        switchModel(sessionID, {
          providerID: ref.providerID,
          id: ref.modelID,
          ...(target.variant ? { variant: target.variant } : {}),
        }),
        HOST_CALL_TIMEOUT_MS,
        'foreground restore model switch timed out',
        this.timerSeam,
      );
      if (!this.disposed && this.descent.get(sessionID) === descent) {
        // The triggering step reset old quota; retain evidence from the ACK wait.
        this.commitRestore(sessionID, descent, midTurn);
        keepMarker = true;
      }
    } catch (error) {
      // A timed-out switch may still have landed on the host.
      keepMarker = error instanceof OperationTimeoutError;
      log('[foreground-fallback] v2 restore failed', {
        sessionID,
        error: stringifyError(error),
      });
    } finally {
      if (!keepMarker && this.restoredFrom.get(sessionID) === descent)
        this.restoredFrom.delete(sessionID);
      this.restoring.delete(sessionID);
    }
  }

  private commitSwitch(
    sessionID: string,
    from: string | undefined,
    model: string,
    error: unknown,
    detail?: V2SwitchDetail,
    fromVariant?: string,
  ): void {
    const fromProvider = from
      ? parseModelReference(from)?.providerID
      : undefined;
    if (from) {
      const previous = this.descent.get(sessionID);
      // v2 records the fallback variant; a different one there is a manual pick.
      const sameFallback =
        previous?.fallback === from &&
        (previous.fallbackVariant ?? 'default') === (fromVariant ?? 'default');
      const extend = sameFallback ? previous : undefined;
      const originExhausted =
        (isSpentQuotaError(error) || isPermanentQuotaBillingError(error)) &&
        (!extend ||
          (fromProvider !== undefined &&
            fromProvider === parseModelReference(extend.model)?.providerID));
      this.descent.set(sessionID, {
        model: extend?.model ?? from,
        variant: extend ? extend.variant : fromVariant,
        fallback: model,
        fallbackVariant: detail?.variant,
        midTurnAt: originExhausted
          ? undefined
          : extend
            ? extend.midTurnAt
            : failoverScope(error) === 'provider'
              ? this.now() + PROVIDER_MARK_TTL_MS
              : undefined,
      });
      this.clearRestoreTimer(sessionID);
    }
    const downProviders = new Map(this.downProviders.get(sessionID));
    if (fromProvider && failoverScope(error) === 'provider') {
      downProviders.set(fromProvider, this.now());
    }
    const toProvider = parseModelReference(model)?.providerID;
    if (toProvider) downProviders.delete(toProvider);
    this.downProviders.set(sessionID, downProviders);
    this.activeFallback.set(sessionID, model);
    this.sessionModel.set(sessionID, model);
    this.onSessionModelChanged?.(sessionID, model, detail);
    log('[foreground-fallback] active fallback committed', {
      sessionID,
      model,
      downProviders: [...downProviders.keys()].sort(),
    });
  }

  /**
   * Process an OpenCode plugin event.
   * Call this from the plugin's `event` hook for every event received.
   */
  async handleEvent(rawEvent: unknown): Promise<void> {
    if (!this.v2RetryEnabled && this.sessionRetryEnabled.size === 0) return;
    const event = rawEvent as {
      type: string;
      properties?: unknown;
      data?: unknown;
    };
    if (!event?.type) return;
    switch (event.type) {
      case 'session.execution.failed':
        await this.handleV2ExecutionFailed(
          event,
          rawEvent as { created?: unknown },
        );
        break;

      case 'session.step.started':
        this.handleV2StepStarted(event);
        break;

      case 'session.step.failed':
        this.handleV2StepFailed(event);
        break;

      case 'session.step.ended':
      case 'session.execution.succeeded':
        await this.handleV2StepEnded(event);
        break;

      case 'session.status':
        await this.handleSessionStatus(event);
        break;

      case 'session.idle':
        await this.handleSessionIdle(event);
        break;

      case 'session.created':
        this.handleSessionCreated(event);
        break;

      case 'session.deleted':
        this.handleSessionDeleted(event);
        break;
    }
  }

  private async handleV2ExecutionFailed(
    event: { properties?: unknown; data?: unknown },
    rawEvent: { created?: unknown },
  ): Promise<void> {
    const props = isRecord(event.data) ? event.data : event.properties;
    if (
      isRecord(props) &&
      typeof props.sessionID === 'string' &&
      isRecord(props.error) &&
      props.error.type === 'provider.no-route' &&
      typeof rawEvent.created === 'number'
    ) {
      await this.handleV2NoRoute(props.sessionID, props.error, {
        time: { completed: rawEvent.created },
      });
    }
  }

  private handleV2StepStarted(event: {
    properties?: unknown;
    data?: unknown;
  }): void {
    const props = isRecord(event.data) ? event.data : event.properties;
    if (
      isRecord(props) &&
      typeof props.sessionID === 'string' &&
      typeof props.assistantMessageID === 'string' &&
      typeof props.agent === 'string' &&
      isRecord(props.model) &&
      typeof props.model.providerID === 'string' &&
      typeof props.model.id === 'string' &&
      (props.model.variant === undefined ||
        typeof props.model.variant === 'string')
    ) {
      this.v2Steps.set(props.sessionID, {
        assistantMessageID: props.assistantMessageID,
        agent: props.agent,
        epoch: this.turnEpoch.get(props.sessionID) ?? 0,
        model: {
          providerID: props.model.providerID,
          id: props.model.id,
          ...(typeof props.model.variant === 'string'
            ? { variant: props.model.variant }
            : {}),
        },
      });
    }
  }

  private handleV2StepFailed(event: {
    properties?: unknown;
    data?: unknown;
  }): void {
    const props = isRecord(event.data) ? event.data : event.properties;
    if (
      isRecord(props) &&
      typeof props.sessionID === 'string' &&
      typeof props.assistantMessageID === 'string' &&
      props.finish === 'content-filter'
    ) {
      const step = this.v2Steps.get(props.sessionID);
      if (step?.assistantMessageID === props.assistantMessageID)
        void this.refusalOutcome(
          props.sessionID,
          step,
          props.error,
          props.rawFinish,
        );
    }
  }

  private async handleV2StepEnded(event: {
    type: string;
    properties?: unknown;
    data?: unknown;
  }): Promise<void> {
    const props = isRecord(event.data) ? event.data : event.properties;
    if (
      isRecord(props) &&
      typeof props.sessionID === 'string' &&
      (event.type === 'session.execution.succeeded' ||
        props.finish === 'stop' ||
        props.finish === 'tool-calls' ||
        props.finish === 'length')
    ) {
      const step = this.v2Steps.get(props.sessionID);
      const restored = this.restoredFrom.get(props.sessionID);
      if (
        event.type === 'session.step.ended' &&
        step !== undefined &&
        restored !== undefined &&
        step.assistantMessageID === props.assistantMessageID &&
        step.model &&
        `${step.model.providerID}/${step.model.id}` === restored.model &&
        (step.model.variant ?? 'default') === (restored.variant ?? 'default')
      )
        this.restoredFrom.delete(props.sessionID);
      this.resetRecoveryState(props.sessionID);
      if (event.type === 'session.step.ended' && props.finish === 'tool-calls')
        await this.restoreV2(props.sessionID, true);
    }
  }

  private async handleSessionStatus(event: {
    properties?: unknown;
  }): Promise<void> {
    const props = event.properties as SessionStatusProps | undefined;
    if (!props) return;
    const sessionID = eventSessionID(props);
    if (!sessionID) return;
    if (props.status?.type === 'busy' || props.status?.type === 'retry') {
      this.busy.add(sessionID);
      this.awaitingRun.delete(sessionID);
    } else if (props.status?.type === 'idle') {
      this.busy.delete(sessionID);
      if (!this.inProgress.has(sessionID) && !this.awaitingRun.has(sessionID))
        this.refusalRecoveries.delete(sessionID);
    }
  }
  private async handleSessionIdle(event: {
    properties?: unknown;
  }): Promise<void> {
    const props = event.properties as { sessionID?: string } | undefined;
    const sessionID = props?.sessionID;
    if (!sessionID) return;
    this.busy.delete(sessionID);
    await this.restoreV2(sessionID);
  }

  private handleSessionCreated(event: { properties?: unknown }): void {
    const info = (
      event.properties as
        | { info?: { id?: string; parentID?: string } }
        | undefined
    )?.info;
    if (info?.id && info.parentID) {
      this.sessionParent.set(info.id, info.parentID);
    }
  }

  private handleSessionDeleted(event: { properties?: unknown }): void {
    const props = event.properties as
      | { sessionID?: string; info?: { id?: string } }
      | undefined;
    const id = props?.info?.id || props?.sessionID;
    if (id) {
      log('[foreground-fallback] session.deleted observed', {
        sessionID: id,
      });
      this.sessionParent.delete(id);
      // Without a lifecycle coordinator this event is the only deletion
      // signal, so it must clear the retry/terminal state too.
      if (!this.hasCoordinator) this.forgetSession(id);
    }
  }

  /** v2 retry-hook steering. The host calls this hook whenever it is about
   *  to retry (or give up on) a provider failure for a session, passing the
   *  mutable `decision` the host will honor. Steering absorbs host retries
   *  up to `maxRetries`, then switches the model in place via
   *  `session.switchModel` and mutates `decision` so the host retries the
   *  CURRENT turn on the new model — no transcript replay; per-turn races
   *  with new user turns are guarded by epoch validation and `v2RetryEnabled`. */
  async handleV2Retry(
    event: {
      sessionID: string;
      agent?: string;
      model: { providerID: string; id: string; variant?: string };
      error: unknown;
      decision?: { retry: boolean; delay?: number };
    },
    switchModel: (
      sessionID: string,
      model: { providerID: string; id: string },
    ) => Promise<unknown>,
  ): Promise<void> {
    const { sessionID } = event;
    const restored = this.restoredFrom.get(sessionID);
    this.restoredFrom.delete(sessionID);
    const epoch = this.turnEpoch.get(sessionID) ?? 0;
    const from = `${event.model.providerID}/${event.model.id}`;
    let failover = false;
    try {
      const scope = failoverScope(event.error);
      failover = scope !== undefined;
      if (
        !this.retryEnabledFor(sessionID) ||
        this.disposed ||
        this.inProgress.has(sessionID)
      )
        return;
      if (!failover) return;
      // After a timed-out switch the descent is still live, so the normal
      // path stays safe; only a pending or confirmed restore needs this.
      if (
        restored?.fallback === from &&
        (this.restoring.has(sessionID) ||
          this.descent.get(sessionID) !== restored)
      ) {
        if (scope === 'request') {
          const rejected = this.requestRejected.get(sessionID) ?? new Set();
          rejected.add(from);
          this.requestRejected.set(sessionID, rejected);
        }
        this.markQuotaExhausted(sessionID, from, event.error);
        event.decision = { retry: true, delay: this.retryDelayMs };
        return;
      }
      // initialRetryDelayMs has no steering form: the delay exists to give
      // intercepting plugins a recovery window before a REPLAY, and
      // steering performs no replay — the host's own retry backoff is
      // the window. Note the divergence once per session instead of the
      // old silent skip, which disabled the whole steering path whenever
      // the delay was configured.
      if (
        this.initialRetryDelayMs > 0 &&
        !this.initialDelayUsed.has(sessionID)
      ) {
        this.initialDelayUsed.add(sessionID);
        log('[foreground-fallback] retry hook ignores initial delay', {
          sessionID,
          from,
          delayMs: this.initialRetryDelayMs,
        });
      }
      if (
        this.sessionTried.get(sessionID)?.has(from) &&
        this.sessionModel.get(sessionID) !== from
      )
        return;
      const agent = this.v2AgentName(sessionID, event.agent);
      if (agent) this.sessionAgent.set(sessionID, agent);
      this.sessionModel.set(sessionID, from);
      // Spent allowance on every chain provider: leave the host decision.
      // The host names the model whose attempt failed, so attribution is
      // direct: no echo heuristic on this path (an old model's late retry
      // was already dropped by the tried-model check above).
      if (this.surfacesSpentQuota(sessionID, event.error, from)) return;
      const auth401 =
        isRecord(event.error) &&
        event.error.type === 'provider.auth' &&
        event.error.status === 401;
      if (auth401 && this.authGrace.get(sessionID) !== epoch) {
        this.authGrace.set(sessionID, epoch);
        event.decision = { retry: true, delay: 0 };
        return;
      }
      if (event.decision?.retry === true) {
        this.rearmIfFreshDescent(sessionID);
        // Request rejections and spent allowance cannot recover by retrying
        // this model, so steer without charging the host-retry budget.
        if (
          !auth401 &&
          !isPermanentQuotaBillingError(event.error) &&
          !isSpentQuotaError(event.error) &&
          scope !== 'request' &&
          this.absorbHostRetry(sessionID, event.decision.delay)
        )
          return;
      }
      this.inProgress.add(sessionID);
      try {
        const nextModel = await this.switchV2InPlace(
          sessionID,
          from,
          event.error,
          switchModel,
          epoch,
          event.model.variant,
        );
        if (nextModel)
          event.decision = { retry: true, delay: this.retryDelayMs };
      } finally {
        this.inProgress.delete(sessionID);
      }
    } catch (err) {
      log(
        '[foreground-fallback] retry hook switch failed; host decision unchanged',
        { sessionID: event?.sessionID, error: stringifyError(err) },
      );
    } finally {
      const error = isRecord(event.error) ? event.error : undefined;
      log('[foreground-fallback] v2 retry hook observed', {
        sessionID,
        agent: event.agent,
        from,
        failover,
        steering: this.retryEnabledFor(sessionID),
        type: typeof error?.type === 'string' ? error.type : undefined,
        status: typeof error?.status === 'number' ? error.status : undefined,
        message:
          typeof error?.message === 'string'
            ? redactSecretsForLog(error.message).slice(0, 300)
            : undefined,
        retryAfterMs:
          typeof error?.retryAfterMs === 'number'
            ? error.retryAfterMs
            : undefined,
        decision: event.decision,
      });
    }
  }

  private async switchV2InPlace(
    sessionID: string,
    from: string | undefined,
    error: unknown,
    switchModel: V2SwitchModel,
    /** Retry-hook turn fence. The refusal path omits it: its switch is a
     *  durable selection change that a newer prompt still runs on, so only
     *  its continuation is epoch-fenced (by the caller). */
    epoch?: number,
    fromVariant?: string,
  ): Promise<string | undefined> {
    const live = () =>
      epoch === undefined
        ? !this.disposed
        : this.isCurrentTurn(sessionID, epoch);
    let picked: string | undefined;
    let switchRequest: Promise<unknown> | undefined;
    let detail: V2SwitchDetail | undefined;
    let confirmed = false;
    try {
      const selected = this.selectFallbackModel(sessionID, error);
      if (!selected || selected === 'exhausted') return;
      const { agentName, nextModel, ref, variant } = selected;
      picked = nextModel;
      detail = { agentName, variant };
      switchRequest = switchModel(sessionID, {
        providerID: ref.providerID,
        id: ref.modelID,
        ...(variant ? { variant } : {}),
      });
      await withTimeout(
        switchRequest,
        HOST_CALL_TIMEOUT_MS,
        'foreground retry model switch timed out',
        this.timerSeam,
      );
      if (!live()) return;
      confirmed = true;
      this.commitSwitch(sessionID, from, nextModel, error, detail, fromVariant);
      this.showFallbackToast(agentName, nextModel, error);
      log('[foreground-fallback] v2 switched model in place', {
        sessionID,
        from,
        to: nextModel,
      });
      return nextModel;
    } catch (err) {
      if (confirmed) {
        log('[foreground-fallback] v2 switch bookkeeping failed', {
          sessionID,
          error: stringifyError(err),
        });
        return picked;
      }
      // Unconfirmed switch: keep the target selectable on the current turn
      // (a timed-out switch may still land; the next event's model is the
      // host truth). A stale turn's timeout must not delete picked from a
      // fresh descent's tried set.
      if (picked && live()) {
        this.sessionTried.get(sessionID)?.delete(picked);
      }
      const pendingSwitch = switchRequest;
      if (err instanceof OperationTimeoutError && picked && pendingSwitch) {
        // Late landing: the timeout cannot cancel the host call. Reconcile
        // only if this turn is still current and the observed model is still
        // the source or already the target; leave any newer, different
        // selection untouched. A new user turn suppresses late reconciliation.
        // The check/write run synchronously. No toast here: the next event's
        // success path notifies; this only repairs state.
        const target = picked;
        void pendingSwitch
          .then(
            () => {
              const observedModel = this.sessionModel.get(sessionID);
              if (
                !live() ||
                (observedModel !== from && observedModel !== target)
              )
                return;
              this.commitSwitch(
                sessionID,
                from,
                target,
                error,
                detail,
                fromVariant,
              );
              log('[foreground-fallback] v2 reconciled a late model switch', {
                sessionID,
                from,
                to: target,
              });
            },
            () => {},
          )
          .catch((lateError) => {
            log('[foreground-fallback] v2 late switch bookkeeping failed', {
              sessionID,
              error: stringifyError(lateError),
            });
          });
      }
      log('[foreground-fallback] v2 model switch failed', {
        sessionID,
        error: stringifyError(err),
      });
    }
  }

  private async handleV2NoRoute(
    sessionID: string,
    error: Record<string, unknown>,
    entry: Record<string, unknown>,
  ): Promise<string | undefined> {
    if (
      !this.retryEnabledFor(sessionID) ||
      this.disposed ||
      error.type !== 'provider.no-route' ||
      typeof error.message !== 'string' ||
      !isRecord(entry.time) ||
      typeof entry.time.completed !== 'number' ||
      !Number.isFinite(entry.time.completed) ||
      entry.time.completed < this.startedAt
    )
      return;
    const failedAt = entry.time.completed;
    const epoch = this.turnEpoch.get(sessionID) ?? 0;
    try {
      const session = getClient(this.input).session;
      const result = await withTimeout(
        session.get({ path: { id: sessionID } }),
        HOST_CALL_TIMEOUT_MS,
        'foreground no-route session lookup timed out',
      );
      const data: unknown = result.data;
      if (responseError(result) !== undefined || !isRecord(data)) return;
      if (typeof data.parentID === 'string' && data.parentID) {
        this.sessionParent.set(sessionID, data.parentID);
      }
      let anchor = entry;
      if (typeof anchor.id !== 'string') {
        let history: { data?: unknown; error?: unknown };
        try {
          history = await withTimeout(
            session.messages({ path: { id: sessionID } }),
            HOST_CALL_TIMEOUT_MS,
            'foreground no-route context lookup timed out',
          );
          if (
            responseError(history) !== undefined ||
            !Array.isArray(history.data)
          )
            throw new Error('foreground no-route context unavailable');
        } catch (error) {
          if (data.parentID) throw error;
          history = await withTimeout(
            session.messages({
              path: { id: sessionID },
              query: { limit: FALLBACK_REPLAY_TAIL_MESSAGES },
            }),
            HOST_CALL_TIMEOUT_MS,
            'foreground no-route tail lookup timed out',
          );
        }
        if (
          responseError(history) !== undefined ||
          !Array.isArray(history.data)
        )
          return;
        const input = history.data.findLast(
          (message: unknown) =>
            isRecord(message) &&
            isRecord(message.info) &&
            isNoRouteAnchor(message.info.role, message.info.status),
        );
        if (!isRecord(input) || !isRecord(input.info)) return;
        anchor = {
          ...input.info,
          id:
            typeof input.info.id === 'string'
              ? noRouteOutcomeID(input.info.id, error.message)
              : undefined,
        };
      }
      if (
        typeof anchor.id !== 'string' ||
        !isRecord(anchor.time) ||
        typeof anchor.time.created !== 'number' ||
        anchor.time.created > failedAt ||
        !this.isCurrentTurn(sessionID, epoch)
      )
        return;
      const agent =
        this.v2AgentName(
          sessionID,
          typeof data.agent === 'string'
            ? data.agent
            : typeof anchor.agent === 'string'
              ? anchor.agent
              : undefined,
        ) ??
        (await resolveSessionAgent(getClient(this.input), sessionID, {
          directory: this.input.directory,
        }));
      if (!agent || !this.isCurrentTurn(sessionID, epoch)) return;
      const current = isRecord(data.model) ? data.model : undefined;
      const failure =
        noRouteModel(error.message) ??
        (typeof current?.providerID === 'string' &&
        typeof current.id === 'string'
          ? `${current.providerID}/${current.id}`
          : this.sessionModel.get(sessionID));
      const ref = failure ? parseModelReference(failure) : undefined;
      const model = ref
        ? {
            providerID: ref.providerID,
            id: ref.modelID,
            ...(current?.providerID === ref.providerID &&
            current.id === ref.modelID &&
            typeof current.variant === 'string'
              ? { variant: current.variant }
              : {}),
          }
        : undefined;
      return this.refusalOutcome(
        sessionID,
        {
          assistantMessageID: anchor.id,
          agent,
          model,
          epoch,
        },
        error,
        undefined,
      );
    } catch (error) {
      log('[foreground-fallback] v2 no-route lookup failed', {
        sessionID,
        error: stringifyError(error),
      });
    }
  }

  private async handleV2Refusal(
    sessionID: string,
    step: V2RefusalStep,
    error: unknown,
    rawFinish: unknown,
  ): Promise<string | undefined> {
    const restored = this.restoredFrom.get(sessionID);
    this.restoredFrom.delete(sessionID);
    const switchModel = (
      this.input as PluginInput & { experimental_v2?: ExperimentalV2 }
    ).experimental_v2?.switchModel;
    if (
      !this.retryEnabledFor(sessionID) ||
      this.disposed ||
      this.inProgress.has(sessionID) ||
      !isFailoverError(error) ||
      !switchModel
    )
      return;
    const from = step.model
      ? `${step.model.providerID}/${step.model.id}`
      : undefined;
    if (
      from &&
      this.sessionTried.get(sessionID)?.has(from) &&
      this.sessionModel.get(sessionID) !== from
    )
      return;
    this.v2Steps.delete(sessionID);
    const agent = this.v2AgentName(sessionID, step.agent);
    if (!this.hasFallbackChain(sessionID, agent)) return;
    const epoch = step.epoch;
    this.inProgress.add(sessionID);
    log('[foreground-fallback] v2 refusal observed', {
      sessionID,
      agent: step.agent,
      from,
      rawFinish,
    });
    try {
      const session = getClient(this.input).session;
      if (typeof session.get !== 'function') return;
      const result = await withTimeout(
        session.get({ path: { id: sessionID } }),
        HOST_CALL_TIMEOUT_MS,
        'foreground refusal session lookup timed out',
      );
      const data: unknown = result.data;
      if (this.disposed || !isRecord(data)) return;
      const current = data.model;
      const restoredStep =
        restored &&
        from === restored.fallback &&
        (step.model?.variant ?? 'default') ===
          (restored.fallbackVariant ?? 'default') &&
        isRecord(current) &&
        typeof current.providerID === 'string' &&
        typeof current.id === 'string' &&
        `${current.providerID}/${current.id}` === restored.model &&
        (current.variant ?? 'default') === (restored.variant ?? 'default');
      if (
        (typeof data.agent === 'string' && data.agent !== step.agent) ||
        (!restoredStep &&
          current !== undefined &&
          step.model !== undefined &&
          (!isRecord(current) ||
            current.providerID !== step.model.providerID ||
            current.id !== step.model.id ||
            (current.variant ?? 'default') !==
              (step.model.variant ?? 'default')))
      )
        return;
      if ((this.turnEpoch.get(sessionID) ?? 0) !== epoch) return;
      if (typeof data.parentID === 'string' && data.parentID) {
        this.sessionParent.set(sessionID, data.parentID);
      }
      if (agent) this.sessionAgent.set(sessionID, agent);
      if (from && !restoredStep) this.sessionModel.set(sessionID, from);
      if (restoredStep && from && failoverScope(error) === 'request') {
        const rejected = this.requestRejected.get(sessionID) ?? new Set();
        rejected.add(from);
        this.requestRejected.set(sessionID, rejected);
      }
      const nextModel = restoredStep
        ? restored.model
        : await this.switchV2InPlace(
            sessionID,
            from,
            error,
            switchModel,
            undefined,
            step.model?.variant,
          );
      if (
        !nextModel ||
        this.disposed ||
        (this.turnEpoch.get(sessionID) ?? 0) !== epoch
      )
        return;
      this.awaitingRun.add(sessionID);
      const promptResult = await withTimeout(
        session.promptAsync({
          path: { id: sessionID },
          body: {
            agent: step.agent,
            parts: [
              createInternalAgentTextPart(
                nestedField(error, 'type') === 'provider.no-route'
                  ? NO_ROUTE_CONTINUATION
                  : REFUSAL_CONTINUATION,
              ),
            ],
          },
        }),
        HOST_CALL_TIMEOUT_MS,
        'foreground refusal continuation timed out',
      );
      if (isRecord(promptResult) && responseError(promptResult) !== undefined) {
        this.awaitingRun.delete(sessionID);
        return;
      }
      return nextModel;
    } catch (err) {
      // A timed-out admission may still land; only its busy event releases
      // the continuation fence, never this uncertain failure.
      log('[foreground-fallback] v2 refusal recovery failed', {
        sessionID,
        error: stringifyError(err),
      });
    } finally {
      this.inProgress.delete(sessionID);
      // The failed run's idle may have arrived during this refusal.
      if ((this.turnEpoch.get(sessionID) ?? 0) === epoch)
        void this.restoreV2(sessionID);
    }
  }

  // ---------------------------------------------------------------------------
  // Retry budget
  // ---------------------------------------------------------------------------

  /** Charge an available host retry against the current descent. */
  private absorbHostRetry(sessionID: string, delayMs?: number): boolean {
    const hasChain = this.hasFallbackChain(sessionID);
    if (hasChain && (delayMs ?? 0) > MAX_HOST_RETRY_DELAY_MS) return false;
    if (!hasChain && (this.chainExhaustion.get(sessionID) ?? 0) >= 2) {
      return false;
    }
    const tried = this.sessionRetries.get(sessionID) ?? 0;
    if (tried < this.maxRetries) {
      this.sessionRetries.set(sessionID, tried + 1);
      log('[foreground-fallback] rate-limit retry', {
        sessionID,
        attempt: tried + 1,
        remaining: this.maxRetries - tried - 1,
      });
      return true;
    }
    return false;
  }

  /** A confirmed recovery starts a new descent, including inherit+chain agents. */
  private resetRecoveryState(sessionID: string, preserveQuota = false): void {
    this.sessionRetries.delete(sessionID);
    this.chainExhaustion.delete(sessionID);
    this.initialDelayUsed.delete(sessionID);
    this.authGrace.delete(sessionID);
    this.sessionTried.delete(sessionID);
    if (!preserveQuota) this.quotaExhaustedProviders.delete(sessionID);
  }

  /** Record a spent allowance (issue #966) against the failing model's
   *  provider. Other errors leave the record untouched. */
  private markQuotaExhausted(
    sessionID: string,
    model: string | undefined,
    error: unknown,
  ): ReadonlySet<string> | undefined {
    const provider = model ? parseModelReference(model)?.providerID : undefined;
    if (provider && isSpentQuotaError(error)) {
      let exhausted = this.quotaExhaustedProviders.get(sessionID);
      if (!exhausted) {
        exhausted = new Set();
        this.quotaExhaustedProviders.set(sessionID, exhausted);
      }
      exhausted.add(provider);
    }
    return this.quotaExhaustedProviders.get(sessionID);
  }

  /** Mark spent allowance and surface the error when no provider remains. */
  private surfacesSpentQuota(
    sessionID: string,
    error: unknown,
    failingModel: string,
  ): boolean {
    if (!isSpentQuotaError(error)) return false;
    const { chain } = this.resolveChain(
      this.sessionAgent.get(sessionID),
      failingModel,
      sessionID,
    );
    const exhausted = this.markQuotaExhausted(sessionID, failingModel, error);
    const viable = chain.some(
      (entry) => !exhausted?.has(parseModelReference(entry)?.providerID ?? ''),
    );
    if (viable) return false;
    log(
      '[foreground-fallback] spent quota on every chain provider; surfacing',
      {
        sessionID,
        model: failingModel,
        exhausted: [...(exhausted ?? [])].sort(),
      },
    );
    return true;
  }
  /** A return to the OBSERVED configured primary starts a new descent. An
   *  inferred head, dynamic inherit+chain head, or committed fallback does
   *  not count. */
  private rearmIfFreshDescent(sessionID: string): void {
    const observedModel = this.sessionModel.get(sessionID);
    if (!observedModel) return;
    if (this.activeFallback.get(sessionID) === observedModel) return;
    const tried = this.sessionTried.get(sessionID);
    if (!tried || tried.size <= 1) return;
    const agentName = this.sessionAgent.get(sessionID);
    const configuredHead =
      agentName === undefined
        ? undefined
        : this.pinnedChains(sessionID)[agentName]?.[0];
    const rearmHead =
      (configuredHead === undefined
        ? undefined
        : typeof configuredHead === 'string'
          ? configuredHead
          : configuredHead.id) ??
      this.resolveChain(agentName, observedModel, sessionID).chain[0];
    if (observedModel !== rearmHead) return;
    // A head whose allowance is spent (issue #966) is not a recovery: the
    // descent continues, so returning to it cannot reopen the chain.
    // A new external turn or a successful response re-arms it instead.
    const headProvider = parseModelReference(observedModel)?.providerID;
    if (
      headProvider &&
      this.quotaExhaustedProviders.get(sessionID)?.has(headProvider)
    )
      return;
    this.sessionTried.set(sessionID, new Set());
    this.quotaExhaustedProviders.delete(sessionID);
    this.sessionRetries.delete(sessionID);
    this.chainExhaustion.delete(sessionID);
    this.initialDelayUsed.delete(sessionID);
  }

  private selectFallbackModel(sessionID: string, error?: unknown) {
    const observedModel = this.sessionModel.get(sessionID);
    let currentModel = observedModel;
    const agentName = this.sessionAgent.get(sessionID);
    const { chain, entries } = this.resolveChain(
      agentName,
      currentModel,
      sessionID,
    );
    // Callers pre-check via hasFallbackChain; keep as defensive guard only.
    if (!chain.length) return;
    // When the agent is known but no model was captured, infer the current
    // model as the chain's first entry. Without this, the
    // fallback would incorrectly re-select the primary model as the
    // "next" fallback target.
    if (!currentModel && agentName && chain.length > 0) {
      currentModel = chain[0];
    }

    if (!this.sessionTried.has(sessionID)) {
      this.sessionTried.set(sessionID, new Set());
    }
    // A fresh turn or continuation returning to the observed configured head
    // re-arms a previous descent. An inferred head or our committed fallback
    // does not: landing on the head mid-descent must retain tried models.
    // A single-entry chain never has tried.size > 1.
    this.rearmIfFreshDescent(sessionID);
    // biome-ignore lint/style/noNonNullAssertion: We just set this above
    const tried = this.sessionTried.get(sessionID)!;

    // Once the sticky retry has failed, leave subsequent errors to the host.
    const exhaustion = this.chainExhaustion.get(sessionID) ?? 0;
    if (exhaustion === 2) return;
    if (currentModel) tried.add(currentModel);
    if (observedModel && failoverScope(error) === 'request') {
      const rejected = this.requestRejected.get(sessionID) ?? new Set();
      rejected.add(observedModel);
      this.requestRejected.set(sessionID, rejected);
    }
    const rejected = this.requestRejected.get(sessionID);
    // Re-mark after a re-arm above: the failing provider stays excluded.
    const quotaExhausted = this.markQuotaExhausted(
      sessionID,
      currentModel,
      error,
    );
    const hasAllowance = (model: string) =>
      !quotaExhausted?.has(parseModelReference(model)?.providerID ?? '');

    const downProviders = this.getDownProviders(sessionID);
    const parentID = this.sessionParent.get(sessionID);
    const parentDownProviders = parentID
      ? this.getDownProviders(parentID)
      : undefined;
    // A failure after the sticky retry ends the descent even if switching to
    // the sticky entry cleared its provider from the exclusions.
    let nextModel = exhaustion
      ? undefined
      : chain.find((model) => {
          const provider = parseModelReference(model)?.providerID ?? '';
          return (
            !tried.has(model) &&
            !rejected?.has(model) &&
            hasAllowance(model) &&
            !downProviders.has(provider) &&
            !parentDownProviders?.has(provider)
          );
        });
    if (!nextModel) {
      if (chain.length > 1) {
        // Retry the last chain entry once, ignoring provider exclusions but
        // retaining tried models. After it fails, stop intervening. Spent
        // allowance (issue #966) is never retried.
        const stickyFallback = chain.findLast(hasAllowance);
        if (stickyFallback === undefined) {
          log(
            '[foreground-fallback] spent quota on every chain provider; surfacing',
            {
              sessionID,
              agentName,
              currentModel,
              exhausted: [...(quotaExhausted ?? [])].sort(),
            },
          );
          return;
        }
        if (exhaustion >= 1) {
          this.chainExhaustion.set(sessionID, 2);
          log('[foreground-fallback] chain exhausted after re-fallback', {
            sessionID,
            agentName,
            currentModel,
            tried: [...tried],
          });
          return 'exhausted' as const;
        }
        this.chainExhaustion.set(sessionID, 1);
        log('[foreground-fallback] chain exhausted; retrying sticky fallback', {
          sessionID,
          agentName,
          currentModel,
          tried: [...tried],
          nextModel: stickyFallback,
        });
        nextModel = stickyFallback;
      } else {
        this.chainExhaustion.set(sessionID, 2);
        log('[foreground-fallback] fallback chain exhausted', {
          sessionID,
          agentName,
          tried: [...tried],
        });
        return 'exhausted' as const;
      }
    }
    tried.add(nextModel);
    const ref = parseModelReference(nextModel);
    if (!ref) {
      log('[foreground-fallback] invalid model format', {
        sessionID,
        nextModel,
      });
      return;
    }
    const variant = entries.find((entry) => entry.id === nextModel)?.variant;
    return { agentName, currentModel, nextModel, ref, variant };
  }
  /**
   * Surface a TUI toast when the fallback switches models, so the user isn't
   * surprised by a different model responding (e.g. after a rate-limit on the
   * primary). 401/410 errors (auth, model gone) are already rendered inline by
   * the runtime, so those get no toast — the inline rendering is the notice.
   * Fire-and-forget; a failed toast is never fatal.
   */
  private showFallbackToast(
    agentName: string | undefined,
    nextModel: string,
    error?: unknown,
  ): void {
    // 401/410 surface inline in the conversation; don't toast on top of them.
    if (isInlineFailoverError(error)) return;
    this.input.client?.tui
      ?.showToast({
        body: {
          title: 'Model fallback',
          message: `${agentName ? `@${agentName} ` : ''}switched to ${nextModel}`,
          variant: 'warning',
          duration: 6_000,
        },
      })
      .catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Chain resolution
  // ---------------------------------------------------------------------------
  /** True when resolveChain yields at least one model for this session. */
  private hasFallbackChain(
    sessionID: string,
    agent = this.sessionAgent.get(sessionID),
  ): boolean {
    return (
      this.resolveChain(agent, this.sessionModel.get(sessionID), sessionID)
        .chain.length > 0
    );
  }

  /**
   * Determine the fallback chain to use for a session.
   *
   * Priority:
   * 1. Agent name known AND has a configured chain → return it, with the
   *    session's live model prepended as a dynamic head when that model is
   *    not part of the configured chain (combined inheritModelFrom + chain
   *    mode: follow the session model first, descend into the configured
   *    entries only when it fails)
   * 2. Agent name known but NO chain in the pinned generation → fall back
   *    to the live chain table for the SAME agent (#1927: a scalar-era
   *    snapshot has no entry at all, so failover would otherwise stay
   *    disabled for it). An explicitly disabled (empty) chain stays empty,
   *    and this never bleeds into other agents' chains.
   * 3. Agent name unknown, current model known → search all chains for
   *    the model to infer which chain to use
   * 4. Nothing matches → flatten all chains as a last resort (only
   *    reached when both agent name and current model are unavailable)
   */
  private resolveChain(
    agentName: string | undefined,
    currentModel: string | undefined,
    sessionID: string,
  ): {
    chain: string[];
    entries: Array<{ id: string; variant?: string }>;
    source?: string;
  } {
    // Resolve against the session's pinned generation (lazily pinned on
    // first use), so an in-flight descent never observes a chain swap
    // mid-sequence while its tried-set and exhaustion stage stay valid.
    const generation = this.pinnedChains(sessionID);
    const chains: Record<string, string[]> = {};
    const chainEntries: Record<
      string,
      Array<{ id: string; variant?: string }>
    > = {};
    for (const [name, entries] of Object.entries(generation)) {
      const normalized = entries.map((entry) =>
        typeof entry === 'string' ? { id: entry } : entry,
      );
      chainEntries[name] = normalized;
      chains[name] = normalized.map((entry) => entry.id);
    }
    if (agentName) {
      let chain = chains[agentName];
      let entries = chainEntries[agentName];
      if (chain === undefined) {
        // No entry in the pinned generation: the session snapshot predates
        // the chain config (scalar-era bundle, #1927) — fall back to the
        // live chain table for the SAME agent. An explicitly disabled chain
        // keeps its empty entry and stays disabled, and this never bleeds
        // into another agent's chain.
        const live = this.chainSource[agentName];
        if (live?.length) {
          const normalized = live.map((entry) =>
            typeof entry === 'string' ? { id: entry } : { ...entry },
          );
          // Adopt into the existing pin so refreshes cannot change the
          // chain while this session retains its retry and exhaustion state.
          generation[agentName] = normalized;
          entries = normalized;
          chain = normalized.map((entry) => entry.id);
        }
      }
      if (chain) {
        // Dynamic head: when the session runs a model outside the
        // configured chain (session-inherited or /model-picked), that model
        // leads the descent and the configured entries back it. The head is
        // never re-picked — selectFallbackModel marks the current model
        // tried before scanning, so the scan starts at the configured head.
        // Empty chains (disableChain) must stay empty: prepending onto []
        // would resurrect fallback for an agent whose chain was disabled.
        if (currentModel && chain.length > 0 && !chain.includes(currentModel)) {
          return {
            chain: [currentModel, ...chain],
            entries,
            source: agentName,
          };
        }
        return { chain, entries, source: agentName };
      }
      // Any known agent without a configured chain: no fallback.
      // Don't bleed into other agents' chains via model-matching —
      // that switches the session to the wrong agent (e.g. Build
      // inherits Orchestrator's chain and becomes Orchestrator).
      return { chain: [], entries: [] };
    }

    // Agent unknown: try to infer from the current model.
    if (currentModel) {
      for (const [name, chain] of Object.entries(chains)) {
        if (chain.includes(currentModel)) {
          return { chain, entries: chainEntries[name], source: name };
        }
      }
    }

    // Last resort: merged list across all agents preserving insertion order.
    // Only reached when both agent name and current model are unavailable.
    const all: string[] = [];
    const seen = new Set<string>();
    for (const chain of Object.values(chains)) {
      for (const m of chain) {
        if (!seen.has(m)) {
          seen.add(m);
          all.push(m);
        }
      }
    }
    return { chain: all, entries: [] };
  }
}
