/**
 * Runtime model fallback for foreground (interactive) agent sessions.
 *
 * When OpenCode fires a session.error, message.updated, or session.status
 * event containing a transient error (rate-limit, 403/Forbidden, etc.), this
 * manager:
 *   1. Looks up the next untried model in the agent's configured chain
 *   2. Aborts host retry or unknown-finish loops via client.session.abort();
 *      other session.error and message.updated paths re-prompt directly
 *      without abort.
 *   3. Sends an internal reminder via client.session.promptAsync() with
 *      the new model, which reads the user's request from history -
 *      promptAsync returns immediately so we never block the event handler
 *      waiting for a full LLM response.
 *
 * Spent-allowance errors (issue #966) mark the failing provider exhausted
 * for the descent: failover skips that provider's remaining chain entries,
 * and the error surfaces to the user once no other provider remains.
 *
 * Sessions with no fallback chain (unknown agents, councillor-style
 * self-managed sessions) retry the current model instead: transient
 * upstream errors (streaming 5xx/524, queue-full, worker-limit) often
 * resolve when the replay lands on a different worker. The same-model
 * path reuses the shared sessionRetries host budget and, once spent,
 * sticks in a terminal exhausted state until the next success, user turn,
 * or session deletion.
 *
 * This mirrors the same fallback loop used for delegated sessions, but operates
 * reactively through the event system instead of wrapping prompt() in a
 * try/catch, which is not possible for interactive (foreground) sessions.
 */

import { randomBytes } from 'node:crypto';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  responseError,
  stringifyError,
  structuredErrorMessage,
} from '../../utils/child-transcript';
import { isRecord } from '../../utils/guards';
import {
  createInternalAgentTextPart,
  isInternalInitiatorPart,
  isNativeBackgroundTaskNotification,
  SLIM_INTERNAL_INITIATOR_MARKER,
} from '../../utils/internal-initiator';
import { log } from '../../utils/logger';
import { getClient } from '../../utils/opencode-client';
import {
  normalizeAgentHint,
  resolveSessionAgent,
} from '../../utils/prompt-agent';
import {
  abortSessionWithTimeout,
  OperationTimeoutError,
  parseModelReference,
  type TimerHandle,
  type TimerSeam,
  withTimeout,
} from '../../utils/session';
import { isInternalAdmission } from '../../v2/internal-admissions';
import type { SessionLifecycle } from '../session-lifecycle';
import type { createBackgroundFallbackHandoff } from '../task-session-manager/fallback-observation-transfer';
import { isReplayableUserMessage } from '../types';

/** Timer port for deterministic test control (see `src/utils/test-timers.ts`):
 *  `now` is observation time (dedup windows, incident clocks); scheduling
 *  comes from `TimerSeam`. Wire both from one harness only when a test wants
 *  them to track together. */
export interface ForegroundFallbackTimers extends TimerSeam {
  now?: () => number;
}

type BackgroundFallbackHandoff = ReturnType<
  typeof createBackgroundFallbackHandoff
>;

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
  /\bindividual quota reached\b/i,
  /\bupgrade your subscription to increase your limits\b/i,
  /\baccount pool (?:has no account available|is unavailable)\b/i,
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
// Streaming/proxy backpressure (issue #947: same-model retry for agents
// without chains). Gateways shed load with these wordings instead of an
// HTTP status, so the next model (or a same-model replay on a different
// worker) should be tried — unless the same failure carries a
// deterministic 4xx (e.g. "Streaming response failed: [400] invalid
// request"), which every replay would reproduce.
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

/** True when a promptAsync rejection proves the session is busy (the only
 *  rejection that justifies aborting and re-sending the replay). */
function isBusyRefusalError(error: unknown): boolean {
  return /\bbusy\b/i.test(stringifyError(error));
}

const CONTENT_FILTER_ERROR = {
  name: 'ContentFilterError',
  message: "The response was blocked by the provider's content filter",
};
const UNKNOWN_FINISH_LOOP_ERROR = {
  name: 'UnknownFinishLoopError',
  message: 'Consecutive unknown assistant finishes without tool calls',
};

function asHttpStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 100 && value <= 599 ? value : undefined;
  }
  if (typeof value === 'string' && /^\d{3}$/.test(value)) {
    const parsed = Number(value);
    return parsed >= 100 && parsed <= 599 ? parsed : undefined;
  }
  return undefined;
}

function nestedField(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined;
}

function extractStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const { data, cause, response } = error;
  const candidates = [
    error.statusCode,
    nestedField(data, 'statusCode'),
    nestedField(cause, 'statusCode'),
    error.status,
    nestedField(response, 'status'),
    nestedField(response, 'statusCode'),
    nestedField(data, 'status'),
    nestedField(nestedField(data, 'response'), 'status'),
    nestedField(cause, 'status'),
    nestedField(nestedField(cause, 'response'), 'status'),
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

/** Identity of a spent-quota signal across event shapes: the carrier text
 *  that marks it spent, so a status message and the structured error it
 *  summarises compare equal. Other errors fall back to their full text. */
function spentQuotaSignature(error: unknown): string {
  const carriers =
    typeof error === 'string'
      ? [error]
      : isRecord(error)
        ? failoverCarriers(error)
        : [];
  return (
    carriers.find((carrier) => isSpentQuotaError(carrier)) ??
    stringifyError(error)
  );
}

function errorMessages(error: unknown): string[] {
  if (typeof error === 'string') return [error];
  return [
    nestedField(error, 'message'),
    nestedField(nestedField(error, 'data'), 'message'),
    nestedField(nestedField(error, 'data'), 'responseBody'),
    nestedField(nestedField(error, 'cause'), 'message'),
    nestedField(error, 'responseBody'),
  ].map((value) => (typeof value === 'string' ? value : ''));
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
    statusCode === 410 ||
    statusCode === 421 ||
    statusCode === 451 ||
    REQUEST_ERROR_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return 'request';
  }
  if (
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
  // Spent-allowance wording stays out: it keeps the configured initial
  // delay (a recovery window for intercepting plugins).
];

/**
 * Permanent exhaustion skips the initial delay and fails over immediately.
 * Spent-allowance wording is excluded and keeps the configured initial delay.
 */
export function isPermanentQuotaBillingError(error: unknown): boolean {
  if (extractStatusCode(error) === 402) return true;
  const text =
    typeof error === 'string'
      ? error
      : isRecord(error)
        ? [
            error.code,
            error.message,
            nestedField(error.data, 'code'),
            nestedField(error.data, 'message'),
            nestedField(error.data, 'responseBody'),
            nestedField(error.cause, 'code'),
            nestedField(error.cause, 'message'),
            error.responseBody,
          ]
            .filter(
              (value): value is string | number =>
                typeof value === 'string' || typeof value === 'number',
            )
            .map(String)
            .join(' ')
        : '';
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

/** Bounds stale-retry rejection, incident correlation, and incident dedup. */
const DEDUP_WINDOW_MS = 5_000;
const REPROMPT_DELAY_MS = 500;
/** Longer host backoffs should use the configured model chain instead. */
const MAX_HOST_RETRY_DELAY_MS = 30 * 60_000;
const PROVIDER_MARK_TTL_MS = 30 * 60_000;
/** Ceiling on host calls: a hung transport must not stall fallback. */
const HOST_CALL_TIMEOUT_MS = 2_000;
/** The replay send's ack can lag after the host admitted it: wait as long as
 *  the tracker's own `promptAsync`, so a slow ack is not read as a refusal. */
const REPLAY_SEND_TIMEOUT_MS = 10_000;
/** Transcript tail size for the fallback replay read: the replay only needs
 *  the last replayable user message plus the trailing message id (handoff
 *  baseline), never the full history. */
const FALLBACK_REPLAY_TAIL_MESSAGES = 50;

/** Replay reads share the host's event loop. After a stall, the expired timer
 *  runs before the read's response, so give that same read one more window. */
async function readForReplay<T>(
  sessionID: string,
  read: Promise<T>,
  message: string,
  timers?: TimerSeam,
): Promise<T> {
  const started = Date.now();
  try {
    return await withTimeout(read, HOST_CALL_TIMEOUT_MS, message, timers);
  } catch (err) {
    if (!(err instanceof OperationTimeoutError)) throw err;
    log('[foreground-fallback] replay read missed its window; waiting once', {
      sessionID,
      elapsedMs: Date.now() - started,
    });
    return withTimeout(read, HOST_CALL_TIMEOUT_MS, message, timers);
  }
}
/** Trailer marking a same-model replay; identical at every call site so the
 *  replay is recognizable as an internal retry, never a user turn. */
const SAME_MODEL_RETRY_TRAILER = 'Same-model retry after transient error.';
/** Prompt admissions per same-model replay: the initial send plus a single
 *  busy-path re-send after abort. */
const SAME_MODEL_REPLAY_ATTEMPTS = 2;

// Shaped like a v1 host id: v2's Session.Message.ID (and its import of
// v1 rows) requires msg_, and v1 orders ids by this 48-bit ms clock;
// counter 0 sorts before a host reply minted in the same millisecond.
function createReplayMessageID(now: () => number = Date.now): string {
  const clock = (BigInt(now()) * 0x1000n) & 0xffff_ffff_ffffn;
  const random = randomBytes(7).toString('hex');
  return `msg_${clock.toString(16).padStart(12, '0')}${random}`;
}

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

/**
 * Manages runtime model fallback for foreground agent sessions.
 *
 * Constructed at plugin init with the ordered fallback chains for each agent
 * (built from _modelArray entries in agents.<name>.model).
 */
export class ForegroundFallbackManager {
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
  /** sessionID → confirmed fallback and provider failure timestamps.
   *  Kept separate from sessionModel because synthetic admissions may emit
   *  message.updated events for another model without changing the model
   *  serving the user's active turn. */
  private readonly activeFallback = new Map<
    string,
    { model: string; downProviders: ReadonlyMap<string, number> }
  >();
  /** sessionID → agent name (populated from message.updated info.agent field) */
  private readonly sessionAgent = new Map<string, string>();
  /** True when a SessionLifecycle coordinator owns deletion cleanup. */
  private hasCoordinator = false;

  /** True when the agent's chain is explicitly disabled (an empty chain
   *  in the session's pinned generation: configured empty or disableChain).
   *  Unknown agents (no entry at all) are NOT disabled — failing open
   *  preserves recovery where no owner claimed the session. */
  private isChainExplicitlyDisabled(
    sessionID: string,
    agentName: string | undefined,
  ): boolean {
    return (
      agentName !== undefined &&
      this.pinnedChains(sessionID)[agentName]?.length === 0
    );
  }
  private readonly sessionRetryEnabled = new Map<string, boolean>();
  private retryEnabledFor(sessionID: string): boolean {
    return this.sessionRetryEnabled.get(sessionID) ?? this.v2RetryEnabled;
  }
  /** child sessionID → parent sessionID (from session.created info).
   *  Lets the fallback abort path promote a foreground task() waiter to
   *  background first, so the waiting tool resolves via backgroundResult
   *  instead of "Task cancelled" while the child continues on fallback. */
  private readonly sessionParent = new Map<string, string>();
  /** sessionID → set of models already attempted this session */
  private readonly sessionTried = new Map<string, Set<string>>();
  /** sessionID → providers whose allowance is spent (issue #966). The chain
   *  walk skips them; once every chain provider is listed the error
   *  surfaces. Holds at most the providers seen failing, and re-arms with
   *  the retry budget (external turn, recovery, return to primary). A
   *  switch still records the provider in activeFallback.downProviders. */
  private readonly quotaExhaustedProviders = new Map<string, Set<string>>();
  /** Process-local sessions with an active fallback switch in flight. */
  private readonly inProgress = getProcessFallbacksInProgress();
  /** One-shot v2 retry-hook delivery notices, keyed by sessionID and the
   *  failing model ("providerID/modelID"). Proves hook delivery per
   *  session/model episode without per-event log noise. */
  private readonly v2RetryNotices = new Map<string, Set<string>>();
  /** sessionID → timestamp of last trigger (stale retry guard only) */
  private readonly lastTrigger = new Map<string, number>();
  /** sessionID → model in use when lastTrigger was set; a model change starts
   *  a new failure episode and lets the fallback cascade continue. */
  private readonly lastTriggerModel = new Map<string, string>();
  /** Turn identity associated with the last failure dedup marker. */
  private readonly lastTriggerTurn = new Map<string, number>();
  /** The last replay trigger: the model it failed on and its error
   *  signature. Kept only until the replacement emits a message; until then
   *  an uncorrelated spent-quota session.error or status retry repeating
   *  this signature is that trigger's echo (issue #966). The v2 retry hook
   *  names its failing model and never consults this. */
  private readonly lastSwitchTrigger = new Map<
    string,
    { model: string; signature: string; turn: number; time: number }
  >();

  // Timer seams
  private readonly now: () => number;
  private readonly setTimer: (
    callback: () => void,
    delay: number,
  ) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly timerSeam: TimerSeam;
  /** Recent event identities deduplicate only repeated observations of one incident. */
  private readonly triggerIncidents = new Map<
    string,
    Map<string, { turn: number; time: number; model?: string }>
  >();
  /** One-shot bridge between uncorrelated session.error and its matching
   *  errored message.updated event. */
  private readonly pendingErrorCorrelation = new Map<
    string,
    {
      incidentID: string;
      turn: number;
      model: string | undefined;
      fingerprint: string;
      time: number;
    }
  >();
  private incidentSequence = 0;
  /** Confirmed external user-turn generations fence suspended work. */
  private readonly turnEpoch = new Map<string, number>();
  private readonly lastUserMessageID = new Map<string, string>();
  /** Arrival order fences stale asynchronous transcript identity probes. */
  private readonly userEventSequence = new Map<string, number>();
  private readonly replayMessageIds = new Map<string, Set<string>>();
  /** Last host retry attempt charged for each turn/model episode. */
  private readonly retryAttempt = new Map<
    string,
    { turn: number; model: string | undefined; attempt: number }
  >();
  /** sessionID -> absorbed host retries plus same-model replay charges in
   *  the current fallback descent. The counter is shared: host-retry
   *  absorbs and same-model replays draw from the same maxRetries budget.
   *  Reset on recovery, fresh primary descent, or session deletion. */
  private readonly sessionRetries = new Map<string, number>();
  /** Completed unknown IDs stay deduped until the next external user turn. */
  private readonly unknownFinishStreak = new Map<
    string,
    { count: number; seen: Set<string> }
  >();
  /** sessionID -> pending initial delay and latest trigger mode.
   *  Cleared on recovery or session deletion. */
  private readonly pendingInitialDelay = new Map<
    string,
    {
      timer: TimerHandle;
      needsAbort: boolean;
      turn: number;
      retryAttempt?: number;
      error?: unknown;
      incidentID?: string;
    }
  >();
  /** True after the first initial delay or immediate permanent intervention
   *  has started in the current fallback descent. */
  private readonly initialDelayUsed = new Set<string>();
  /** sessionID -> timestamp of last fallback attempt.
   *  Used to enforce retryDelayMs between consecutive attempts. */
  private readonly lastFallbackTime = new Map<string, number>();
  /** sessionID → chain-exhaustion stage:
   *   0 = not exhausted; 1 = chain exhausted once, sticky fallback retry;
   *   2 = exhausted again, aborted — stop intervening.
   *   Reset to 0 on successful responses or session deletion. */
  private readonly chainExhaustion = new Map<string, number>();
  /** Sessions blocked by a deterministic same-model failure (inline 401/410,
   *  permanent billing, unparseable model). Separate from chainExhaustion so
   *  a later retryable-transient error can lift it; cleared alongside
   *  chainExhaustion on recovery, fresh turns, and session deletion. */
  private readonly deterministicTerminal = new Set<string>();
  /** True once dispose() ran. `opencode reload` destroys this instance's
   *  context mid-attempt; in-flight fallback chains check this at every
   *  suspension point so their continuation never touches the old
   *  generation's client (transcript reads, aborts, re-prompts). */
  private disposed = false;
  /** sessionID → notified when the session switched to a new model mid-flight
   *  (e.g. after a fallback re-prompt). Lets the background-task admission
   *  scheduler migrate provider/model accounting to the new model. */
  private readonly onSessionModelChanged?: (
    sessionID: string,
    model: string,
  ) => void;
  /** sessionID + transcript baseline + the board generation captured
   *  BEFORE the admission await, notified when a fallback re-prompt was
   *  admitted for a background child. The host's native task notifier is
   *  bound to the original background job and does not re-arm for the
   *  re-prompted execution, so without this transfer nobody observes the
   *  substituted run's transcript — the quiescent stop-confirmation then
   *  publishes a false `stopped` even though the fallback's final answer
   *  is already persisted (false-stop incident). The pre-await generation
   *  fences relaunches: a generation change during the admission must not
   *  enroll the new run under the stale attempt's baseline. */
  private readonly backgroundFallbackHandoff?: BackgroundFallbackHandoff;
  /** Synchronous board read returning the tracked generation for a
   *  confirmed BACKGROUND child only — undefined for foreground or
   *  unmanaged sessions (that undefined means "handoff not
   *  applicable", never a wildcard). Captured before ANY await in the
   *  fallback preparation. */
  private readonly readBackgroundGeneration?: (
    sessionID: string,
  ) => number | undefined;

  /** Exposed for task-session-manager: prevents idle reconciliation
   *  while a fallback abort/re-prompt is in flight for this session, or
   *  while its initial retry delay is still pending — the re-prompt is
   *  equally "coming" in both windows. */
  isFallbackInProgress(sessionID: string): boolean {
    return (
      this.inProgress.has(sessionID) || this.pendingInitialDelay.has(sessionID)
    );
  }

  /**
   * True when this manager could still recover the session via fallback:
   * a path is enabled (replay, or v2 retry-hook steering) and the chain
   * is not exhausted (stage < 2). No-chain sessions report a pending
   * same-model retry while budget remains, the model is known, and the
   * chain was not explicitly disabled. Consumers
   * (task-session-manager event router) defer terminal bookkeeping for
   * persistent 401/410 errors until recovery is actually impossible.
   */
  willAttemptFallback(sessionID: string): boolean {
    if (!this.enabled && !this.retryEnabledFor(sessionID)) return false;
    if (this.inProgress.has(sessionID)) return true;
    if ((this.chainExhaustion.get(sessionID) ?? 0) >= 2) return false;
    if (this.deterministicTerminal.has(sessionID)) return false;
    // Chain check BEFORE the child exclusion: chained background children
    // still recover via their chain; the exclusion only stops the
    // foreground-only same-model retry below.
    if (this.hasFallbackChain(sessionID)) return true;
    if (
      this.sessionParent.has(sessionID) ||
      this.readBackgroundGeneration?.(sessionID) !== undefined
    ) {
      return false;
    }
    return (
      (this.sessionRetries.get(sessionID) ?? 0) < this.maxRetries &&
      this.sessionModel.get(sessionID) !== undefined &&
      !this.isChainExplicitlyDisabled(
        sessionID,
        this.sessionAgent.get(sessionID),
      )
    );
  }

  fallbackFailureReason(sessionID: string): string {
    if (!this.enabled && !this.retryEnabledFor(sessionID))
      return 'Model fallback is disabled.';
    if (!this.hasFallbackChain(sessionID))
      return `No model fallback chain for ${this.sessionAgent.get(sessionID) ?? 'this agent'}.`;
    if (this.chainExhaustion.get(sessionID) === 2)
      return `Model fallback chain exhausted; tried: ${[...(this.sessionTried.get(sessionID) ?? [])].join(', ') || 'none'}.`;
    const model = this.sessionModel.get(sessionID);
    return `Model fallback did not recover${model ? ` from ${model}` : ''}.`;
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

  async preflightEvent(rawEvent: unknown): Promise<void> {
    if (!this.enabled || !isRecord(rawEvent)) return;
    if (rawEvent.type !== 'session.error' || !isRecord(rawEvent.properties))
      return;
    const props = rawEvent.properties;
    const sessionID = eventSessionID(props);
    if (sessionID && props.error && isFailoverError(props.error)) {
      await this.ensureSessionAgent(sessionID);
    }
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

  /** Plugin dispose: cancel scheduled initial-delay timers and fence off
   *  in-flight fallback chains. `opencode reload` destroys this instance
   *  mid-attempt — pending timers are cancelled here, and suspension
   *  points inside tryFallback/tryFallbackWithAbort/execFallback abandon
   *  their continuation (see abandonedByDispose) so no replay, abort, or
   *  transcript read runs through the destroyed generation's client. */
  dispose(): void {
    this.disposed = true;
    for (const pending of this.pendingInitialDelay.values()) {
      this.clearTimer(pending.timer);
    }
    this.pendingInitialDelay.clear();
    this.replayMessageIds.clear();
    this.userEventSequence.clear();
    this.v2RetryNotices.clear();
  }

  /** Dispose fence for fallback chains: true when this generation was
   *  disposed and the caller must abandon its attempt. Deterministic log
   *  (fixed text, sessionID only — no timestamps or per-call ids). The
   *  caller's `finally` still clears the process-global inProgress slot,
   *  so the reloaded generation is never blocked by the abandoned one. */
  private abandonedByDispose(sessionID: string): boolean {
    if (!this.disposed) return false;
    log(
      '[foreground-fallback] disposed while fallback in flight; abandoning stale attempt',
      { sessionID },
    );
    return true;
  }

  private noteExternalTurn(sessionID: string, messageID: string): void {
    this.lastUserMessageID.set(sessionID, messageID);
    this.turnEpoch.set(sessionID, (this.turnEpoch.get(sessionID) ?? 0) + 1);
    this.lastTrigger.delete(sessionID);
    this.lastTriggerModel.delete(sessionID);
    this.lastTriggerTurn.delete(sessionID);
    this.lastSwitchTrigger.delete(sessionID);
    this.triggerIncidents.delete(sessionID);
    this.pendingErrorCorrelation.delete(sessionID);
    this.lastFallbackTime.delete(sessionID);
    this.initialDelayUsed.delete(sessionID);
    this.sessionRetries.delete(sessionID);
    this.quotaExhaustedProviders.delete(sessionID);
    this.unknownFinishStreak.delete(sessionID);
    this.retryAttempt.delete(sessionID);
    this.chainExhaustion.delete(sessionID);
    this.deterministicTerminal.delete(sessionID);
    this.v2RetryNotices.delete(sessionID);
    this.cancelInitialDelay(sessionID);
  }

  private nextUserEventSequence(sessionID: string): number {
    const next = (this.userEventSequence.get(sessionID) ?? 0) + 1;
    this.userEventSequence.set(sessionID, next);
    return next;
  }

  private isKnownInternalReplayUserMessage(
    sessionID: string,
    messageID: string,
    parts: unknown[],
  ): boolean {
    if (this.replayMessageIds.get(sessionID)?.has(messageID)) return true;
    // v1 chat.message records internal admissions before message.updated.
    // Recognize them before advancing the external-turn probe sequence.
    if (isInternalAdmission(sessionID, messageID)) return true;
    const marked = parts.some(
      (part) =>
        isInternalInitiatorPart(part) ||
        isNativeBackgroundTaskNotification(part) ||
        (isRecord(part) &&
          typeof part.text === 'string' &&
          part.text.includes(SLIM_INTERNAL_INITIATOR_MARKER)),
    );
    if (marked) this.rememberReplayMessage(sessionID, messageID);
    return marked;
  }

  private incidentForMessageError(
    sessionID: string,
    messageID: string | undefined,
    error: unknown,
  ): string {
    const pending = this.pendingErrorCorrelation.get(sessionID);
    this.pendingErrorCorrelation.delete(sessionID);
    if (
      pending &&
      pending.turn === (this.turnEpoch.get(sessionID) ?? 0) &&
      pending.model === this.sessionModel.get(sessionID) &&
      pending.fingerprint === stringifyError(error) &&
      this.now() - pending.time < DEDUP_WINDOW_MS
    ) {
      return pending.incidentID;
    }
    const incidentID = messageID
      ? `message:${messageID}`
      : `message-error:${++this.incidentSequence}`;
    if (messageID) {
      this.pendingErrorCorrelation.set(sessionID, {
        incidentID,
        turn: this.turnEpoch.get(sessionID) ?? 0,
        model: this.sessionModel.get(sessionID),
        fingerprint: stringifyError(error),
        time: this.now(),
      });
    }
    return incidentID;
  }

  private incidentForSessionError(
    sessionID: string,
    messageID: string | undefined,
    error: unknown,
  ): string {
    if (messageID) return `message:${messageID}`;
    const pending = this.pendingErrorCorrelation.get(sessionID);
    this.pendingErrorCorrelation.delete(sessionID);
    if (
      pending &&
      pending.turn === (this.turnEpoch.get(sessionID) ?? 0) &&
      pending.model === this.sessionModel.get(sessionID) &&
      pending.fingerprint === stringifyError(error) &&
      this.now() - pending.time < DEDUP_WINDOW_MS
    ) {
      return pending.incidentID;
    }
    const incidentID = `session-error:${++this.incidentSequence}`;
    this.pendingErrorCorrelation.set(sessionID, {
      incidentID,
      turn: this.turnEpoch.get(sessionID) ?? 0,
      model: this.sessionModel.get(sessionID),
      fingerprint: stringifyError(error),
      time: this.now(),
    });
    return incidentID;
  }

  private isCurrentTurn(sessionID: string, epoch: number): boolean {
    return !this.disposed && (this.turnEpoch.get(sessionID) ?? 0) === epoch;
  }

  private retryAlreadyObserved(sessionID: string, attempt: number): boolean {
    const turn = this.turnEpoch.get(sessionID) ?? 0;
    const model = this.sessionModel.get(sessionID);
    const previous = this.retryAttempt.get(sessionID);
    if (
      previous &&
      previous.turn === turn &&
      previous.model === model &&
      attempt <= previous.attempt
    ) {
      return true;
    }
    return false;
  }

  private recordRetryAttempt(sessionID: string, attempt: number): void {
    this.retryAttempt.set(sessionID, {
      turn: this.turnEpoch.get(sessionID) ?? 0,
      model: this.sessionModel.get(sessionID),
      attempt,
    });
  }

  /** True when an error incident already charged this turn/model episode. */
  private hasSameTurnErrorIncident(sessionID: string): boolean {
    if (
      this.lastTriggerModel.get(sessionID) !== this.sessionModel.get(sessionID)
    ) {
      return false;
    }
    const incidents = this.triggerIncidents.get(sessionID);
    if (!incidents) return false;
    const turn = this.turnEpoch.get(sessionID) ?? 0;
    const now = this.now();
    let matched = false;
    for (const [id, previous] of incidents) {
      if (previous.turn !== turn || now - previous.time >= DEDUP_WINDOW_MS) {
        incidents.delete(id);
        continue;
      }
      if (
        id.startsWith('message:') ||
        id.startsWith('message-error:') ||
        id.startsWith('session-error:')
      ) {
        matched = true;
      }
    }
    return matched;
  }

  private rememberReplayMessage(sessionID: string, messageID: string): void {
    let ids = this.replayMessageIds.get(sessionID);
    if (!ids) {
      ids = new Set();
      this.replayMessageIds.set(sessionID, ids);
    }
    ids.add(messageID);
  }

  private async messageHasNoTools(
    sessionID: string,
    messageID: string | undefined,
  ): Promise<boolean | undefined> {
    if (!messageID || this.disposed) return;
    try {
      const result = await withTimeout(
        getClient(this.input).session.message({
          path: { id: sessionID, messageID },
        }),
        HOST_CALL_TIMEOUT_MS,
        'foreground message parts lookup timed out',
        this.timerSeam,
      );
      const parts = result.data?.parts;
      if (!Array.isArray(parts)) return;
      return !parts.some((part) => part.type === 'tool');
    } catch {
      return;
    }
  }

  private async isInternalReplayUserMessage(
    sessionID: string,
    messageID: string,
    eventParts: unknown[],
    partsAvailable: boolean,
  ): Promise<boolean> {
    // In v1, message.updated can carry only info while message parts are
    // emitted separately. When parts are present on this event and contain
    // no internal marker (the caller checked them), it is an external turn.
    if (partsAvailable && eventParts.length > 0) return false;

    try {
      const result = await getClient(this.input).session.messages({
        path: { id: sessionID },
        query: { limit: FALLBACK_REPLAY_TAIL_MESSAGES },
      });
      const messages = (result.data ?? []) as unknown[];
      const found = [...messages].reverse().find((message) => {
        if (!isRecord(message)) return false;
        const info = isRecord(message.info) ? message.info : undefined;
        return info?.id === messageID || message.id === messageID;
      });
      if (isRecord(found)) {
        const parts = Array.isArray(found.parts) ? found.parts : [];
        const internal =
          parts.some(
            (part) =>
              isInternalInitiatorPart(part) ||
              (isRecord(part) &&
                typeof part.text === 'string' &&
                part.text.includes(SLIM_INTERNAL_INITIATOR_MARKER)),
          ) ||
          (typeof found.text === 'string' &&
            found.text.includes(SLIM_INTERNAL_INITIATOR_MARKER));
        if (internal) this.rememberReplayMessage(sessionID, messageID);
        return internal;
      }
    } catch {
      // An unavailable transcript is unknown identity, not proof of a user
      // turn. A retained replay record covers this window conservatively.
    }
    return false;
  }

  private withholdsAbortForLiveChildren(sessionID: string): boolean {
    if (
      (this.input as PluginInput & { hostFlavor?: string }).hostFlavor ===
        'v2' ||
      !this.hasRunningChildren?.(sessionID)
    )
      return false;
    log('[foreground-fallback] abort withheld for live background children', {
      sessionID,
    });
    return true;
  }

  constructor(
    /**
     * Ordered fallback chains per agent.
     * e.g. { orchestrator: ['anthropic/claude-opus-4-5', 'openai/gpt-4o'] }
     * Scan from the head, skipping tried models and providers abandoned by
     * this session or its parent.
     */
    chains: Record<string, ReadonlyArray<ForegroundFallbackModel>>,
    private readonly enabled: boolean,
    private readonly input: PluginInput,
    /** Host retry events tolerated before the first model switch. No-chain
     *  sessions reuse the same budget for same-model retries (the shared
     *  sessionRetries counter bounds host absorbs and replay charges
     *  together). */
    private readonly maxRetries: number = 3,
    coordinator?: SessionLifecycle,
    onSessionModelChanged?: (sessionID: string, model: string) => void,
    /** Delay before first fallback; gives intercepting plugins time to recover. */
    private readonly initialRetryDelayMs: number = 0,
    /** Delay between consecutive fallback attempts. */
    private readonly retryDelayMs: number = 500,
    /** Terminal-observation handoff for background children: prepare()
     *  arms the stop-gate deferral BEFORE the admission await (with the
     *  baseline from the same transcript read that produced the replay);
     *  admit() converts it into a tracked run once the host accepts the
     *  re-prompt; reject() withdraws it on any non-admitted outcome. */
    backgroundFallbackHandoff?: BackgroundFallbackHandoff,
    /** Synchronous board read returning the tracked generation for a
     *  confirmed BACKGROUND child only (undefined = foreground or
     *  unmanaged — the handoff is not applicable, never a wildcard).
     *  Captured before ANY await in the fallback preparation. */
    readBackgroundGeneration?: (sessionID: string) => number | undefined,
    /** Synchronous check for running background children OF this session. */
    private readonly hasRunningChildren?: (sessionID: string) => boolean,
    /** v2 retry-hook steering enablement. Independent of `enabled` (the
     *  replay path) because the two paths carry different race profiles:
     *  the replay path aborts and re-prompts — impossible to keep
     *  consistent without a host per-turn/atomic conditional switch —
     *  while the steering path only mutates the host's in-flight retry
     *  decision and calls session.switchModel, so it can run on v2 hosts.
     *  Defaults to `enabled` for hosts where both paths apply. */
    private readonly v2RetryEnabled: boolean = enabled,
    timers?: ForegroundFallbackTimers,
  ) {
    this.chainSource = chains;
    this.onSessionModelChanged = onSessionModelChanged;
    this.backgroundFallbackHandoff = backgroundFallbackHandoff;
    this.readBackgroundGeneration = readBackgroundGeneration;
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
    this.timerSeam = {
      setTimeout: this.setTimer,
      clearTimeout: this.clearTimer,
    };
  }

  /** Sleep for ms using the injected timer seam. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => this.setTimer(() => resolve(), ms));
  }

  /** Drop all per-session state once the session is deleted. */
  private forgetSession(id: string): void {
    this.sessionModel.delete(id);
    this.activeFallback.delete(id);
    this.sessionAgent.delete(id);
    this.sessionTried.delete(id);
    this.sessionChains.delete(id);
    this.sessionRetryEnabled.delete(id);
    this.unknownFinishStreak.delete(id);
    this.v2RetryNotices.delete(id);
    // NOTE: inProgress is intentionally NOT cleared here —
    // the finally blocks in tryFallback() and tryFallbackWithAbort()
    // manage inProgress lifecycle. Clearing it here would make
    // isFallbackInProgress() return false during the abort/re-prompt
    // cycle, letting the task-session-manager treat the abort idle
    // as a real completion and report a background task as cancelled.
    this.lastTrigger.delete(id);
    this.lastTriggerModel.delete(id);
    this.lastTriggerTurn.delete(id);
    this.lastSwitchTrigger.delete(id);
    this.triggerIncidents.delete(id);
    this.pendingErrorCorrelation.delete(id);
    this.turnEpoch.set(id, (this.turnEpoch.get(id) ?? 0) + 1);
    this.lastUserMessageID.delete(id);
    this.userEventSequence.delete(id);
    this.replayMessageIds.delete(id);
    this.retryAttempt.delete(id);
    this.sessionRetries.delete(id);
    this.chainExhaustion.delete(id);
    this.quotaExhaustedProviders.delete(id);
    this.deterministicTerminal.delete(id);
    this.lastFallbackTime.delete(id);
    this.initialDelayUsed.delete(id);
    // Cancel any pending initial delay
    this.cancelInitialDelay(id);
  }

  /** Confirmed fallback serving this session, including unexpired provider failures. */
  getActiveFallback(sessionID: string) {
    const active = this.activeFallback.get(sessionID);
    if (!active) return;
    const downProviders = new Set<string>();
    const now = this.now();
    for (const [provider, recordedAt] of active.downProviders) {
      if (now - recordedAt < PROVIDER_MARK_TTL_MS) downProviders.add(provider);
    }
    return { model: active.model, downProviders };
  }

  /** Restart the count with a new record so replies still being read are
   *  dropped; the seen IDs stay deduped until the next user turn. */
  private resetUnknownFinishStreak(sessionID: string): void {
    const streak = this.unknownFinishStreak.get(sessionID);
    if (streak)
      this.unknownFinishStreak.set(sessionID, { ...streak, count: 0 });
  }

  private commitSwitch(
    sessionID: string,
    from: string | undefined,
    model: string,
    error: unknown,
  ): void {
    const downProviders = new Map(
      this.activeFallback.get(sessionID)?.downProviders,
    );
    const fromProvider = from
      ? parseModelReference(from)?.providerID
      : undefined;
    if (fromProvider && failoverScope(error) === 'provider') {
      downProviders.set(fromProvider, this.now());
    }
    const toProvider = parseModelReference(model)?.providerID;
    if (toProvider) downProviders.delete(toProvider);
    this.activeFallback.set(sessionID, { model, downProviders });
    this.sessionModel.set(sessionID, model);
    this.resetUnknownFinishStreak(sessionID);
    this.onSessionModelChanged?.(sessionID, model);
    log('[foreground-fallback] active fallback committed', {
      sessionID,
      model,
      downProviders: [...downProviders.keys()].sort(),
    });
  }

  /** Reconcile an internal continuation that explicitly selected a model.
   *  Returning to the configured primary ends the previous fallback episode,
   *  while retaining the confirmed fallback keeps its delegation hint live. */
  observeContinuationModel(sessionID: string, model: string): void {
    const previousModel = this.sessionModel.get(sessionID);
    this.sessionModel.set(sessionID, model);
    if (this.activeFallback.get(sessionID)?.model !== model) {
      this.activeFallback.delete(sessionID);
    }
    if (previousModel !== model) {
      this.onSessionModelChanged?.(sessionID, model);
    }
  }

  /** v1 overrides are per-message; v2 switches persist across external turns. */
  observeExternalTurn(sessionID: string, model: string | undefined): void {
    if (model === undefined) return;
    if (this.activeFallback.get(sessionID)?.model !== model) {
      this.activeFallback.delete(sessionID);
      this.sessionModel.set(sessionID, model);
    }
  }

  /**
   * Process an OpenCode plugin event.
   * Call this from the plugin's `event` hook for every event received.
   */
  async handleEvent(rawEvent: unknown): Promise<void> {
    // Bookkeeping (turn detection, agent/model tracking, descent-state
    // resets) must run whenever ANY path is enabled: on v2 the replay
    // interventions below stay gated, but without the resets a later
    // turn in the same session inherits the previous descent's
    // tried/retry/exhaustion state and skips fallbacks that are
    // available again. Intervention branches are gated on `enabled`
    // individually.
    if (
      !this.enabled &&
      !this.v2RetryEnabled &&
      this.sessionRetryEnabled.size === 0
    )
      return;
    const event = rawEvent as {
      type: string;
      properties?: unknown;
      data?: unknown;
    };
    if (!event?.type) return;
    const isV2Host =
      (this.input as PluginInput & { hostFlavor?: string }).hostFlavor === 'v2';

    switch (event.type) {
      case 'session.step.ended':
      case 'session.execution.succeeded': {
        if (!isV2Host) break;
        const props = isRecord(event.data) ? event.data : event.properties;
        if (
          isRecord(props) &&
          typeof props.sessionID === 'string' &&
          (event.type === 'session.execution.succeeded' ||
            props.finish === 'stop' ||
            props.finish === 'tool-calls' ||
            props.finish === 'length')
        ) {
          this.resetRecoveryState(props.sessionID);
        }
        break;
      }

      case 'message.updated': {
        const info = (
          event.properties as { info?: Record<string, unknown> } | undefined
        )?.info;
        if (!info) break;
        const sessionID = info.sessionID as string | undefined;
        if (!sessionID) break;
        if (info.role === 'user') {
          const props = event.properties as { parts?: unknown[] } | undefined;
          const parts = Array.isArray(props?.parts)
            ? props.parts
            : Array.isArray(info.parts)
              ? info.parts
              : [];
          if (
            typeof info.id === 'string' &&
            !this.isKnownInternalReplayUserMessage(sessionID, info.id, parts)
          ) {
            // A re-emitted update of the observed turn (v1: one per step
            // finish) is inert: no transcript probe, no model re-seed (fallback
            // may have advanced it), no sequence bump superseding a newer turn.
            if (this.lastUserMessageID.get(sessionID) === info.id) break;
            const eventSequence = this.nextUserEventSequence(sessionID);
            const isInternal = await this.isInternalReplayUserMessage(
              sessionID,
              info.id,
              parts,
              Array.isArray(props?.parts) || Array.isArray(info.parts),
            );
            if (this.userEventSequence.get(sessionID) !== eventSequence) {
              break;
            }
            if (!isInternal) this.noteExternalTurn(sessionID, info.id);
            if (!isInternal && isRecord(info.model)) {
              const providerID = info.model.providerID;
              const modelID = info.model.modelID ?? info.model.id;
              if (
                typeof providerID === 'string' &&
                typeof modelID === 'string'
              ) {
                this.sessionModel.set(sessionID, `${providerID}/${modelID}`);
              }
            }
          }
        }
        // Assistant identity may belong to compaction or a stale agent turn.
        if (info.role === 'user' && typeof info.agent === 'string') {
          this.registerSessionAgent(sessionID, info.agent);
        }
        // Track the model currently serving this session
        const messageID = typeof info.id === 'string' ? info.id : undefined;
        const priorMessageIncident = messageID
          ? this.triggerIncidents.get(sessionID)?.get(`message:${messageID}`)
          : undefined;
        const recentlyHandledMessage =
          priorMessageIncident?.turn === (this.turnEpoch.get(sessionID) ?? 0) &&
          this.now() - priorMessageIncident.time < DEDUP_WINDOW_MS;
        if (
          info.role !== 'user' &&
          !recentlyHandledMessage &&
          typeof info.providerID === 'string' &&
          typeof info.modelID === 'string'
        ) {
          const model = `${info.providerID}/${info.modelID}`;
          this.sessionModel.set(sessionID, model);
          // The replacement spoke: later errors are its own.
          if (model !== this.lastSwitchTrigger.get(sessionID)?.model)
            this.lastSwitchTrigger.delete(sessionID);
        }
        const messageTime = info.time;
        const isCompletedAssistant =
          info.role === 'assistant' &&
          isRecord(messageTime) &&
          typeof messageTime.completed === 'number';
        const isCompletedSuccessfulAssistant =
          isCompletedAssistant &&
          !info.error &&
          // OpenCode v1 publishes a content-filter turn as completed before it
          // attaches the ContentFilterError: a failure, not a recovery.
          info.finish !== 'content-filter';
        const epoch = this.turnEpoch.get(sessionID) ?? 0;
        const readsParts =
          this.enabled &&
          isCompletedSuccessfulAssistant &&
          info.finish === 'unknown';
        // Every reset swaps this record, so a reply whose parts were still
        // being read when the count was reset is not counted afterwards.
        let streak = this.unknownFinishStreak.get(sessionID);
        if (readsParts && !streak) {
          streak = { count: 0, seen: new Set<string>() };
          this.unknownFinishStreak.set(sessionID, streak);
        }
        const noTools = readsParts
          ? await this.messageHasNoTools(sessionID, messageID)
          : false;
        if (!this.isCurrentTurn(sessionID, epoch)) break;
        let isUnknownLoop = false;
        if (
          noTools &&
          messageID !== undefined &&
          streak &&
          this.unknownFinishStreak.get(sessionID) === streak
        ) {
          if (!streak.seen.has(messageID)) {
            streak.seen.add(messageID);
            isUnknownLoop = ++streak.count >= 3;
            if (isUnknownLoop) streak.count = 0;
          }
        } else if (isCompletedAssistant && noTools === false) {
          this.resetUnknownFinishStreak(sessionID);
        }
        // OpenCode v1 can publish `finish: 'content-filter'` before attaching
        // its ContentFilterError. Treat that terminal finish as the error
        // event itself; the later message/session error is deduped by ID.
        const messageError = isUnknownLoop
          ? UNKNOWN_FINISH_LOOP_ERROR
          : info.finish === 'content-filter' && !isFailoverError(info.error)
            ? CONTENT_FILTER_ERROR
            : info.error;
        const incidentID =
          this.enabled && messageError && isFailoverError(messageError)
            ? this.incidentForMessageError(sessionID, messageID, messageError)
            : undefined;
        if (
          incidentID !== undefined &&
          messageError &&
          // The error belongs to this message's own model, which may differ
          // from sessionModel once a re-emitted update follows a switch.
          !this.surfacesSpentQuota(
            sessionID,
            messageError,
            typeof info.providerID === 'string' &&
              typeof info.modelID === 'string'
              ? `${info.providerID}/${info.modelID}`
              : undefined,
            incidentID,
          )
        ) {
          if (
            this.bypassInitialFallbackDelay(sessionID, messageError) ||
            !this.delayInitialFallback(
              sessionID,
              isUnknownLoop,
              undefined,
              messageError,
              incidentID,
            )
          ) {
            if (isUnknownLoop) {
              await this.tryFallbackWithAbort(
                sessionID,
                messageError,
                undefined,
                incidentID,
              );
            } else {
              await this.tryFallback(sessionID, messageError, incidentID);
            }
          }
        } else if (
          !isV2Host &&
          isCompletedSuccessfulAssistant &&
          noTools === false
        ) {
          // v2 completed-message synthesis is telemetry, not recovery evidence.
          this.resetRecoveryState(sessionID);
        }
        break;
      }

      case 'message.part.updated': {
        const part = (
          event.properties as { part?: Record<string, unknown> } | undefined
        )?.part;
        if (!part) break;
        const isInternalPart =
          isInternalInitiatorPart(part) ||
          (typeof part.text === 'string' &&
            part.text.includes(SLIM_INTERNAL_INITIATOR_MARKER));
        if (
          isInternalPart &&
          typeof part.sessionID === 'string' &&
          typeof part.messageID === 'string'
        ) {
          this.rememberReplayMessage(part.sessionID, part.messageID);
        }
        break;
      }

      case 'session.error': {
        const props = event.properties as
          | { sessionID?: string; info?: { id?: string }; error?: unknown }
          | undefined;
        if (!props) break;
        const sessionID = eventSessionID(props);
        if (
          !this.enabled ||
          !sessionID ||
          !props.error ||
          !isFailoverError(props.error)
        ) {
          break;
        }
        const incidentID = this.incidentForSessionError(
          sessionID,
          typeof props.info?.id === 'string' ? props.info.id : undefined,
          props.error,
        );
        if (
          this.surfacesSpentQuota(sessionID, props.error, undefined, incidentID)
        ) {
          break;
        }
        if (this.bypassInitialFallbackDelay(sessionID, props.error)) {
          await this.tryFallback(sessionID, props.error, incidentID);
        } else if (
          !this.delayInitialFallback(
            sessionID,
            false,
            undefined,
            props.error,
            incidentID,
          )
        ) {
          await this.tryFallback(sessionID, props.error, incidentID);
        }
        break;
      }

      case 'session.status': {
        const props = event.properties as
          | {
              sessionID?: string;
              info?: { id?: string };
              status?: {
                type?: string;
                message?: string;
                attempt?: number;
                next?: number;
              };
              error?: unknown;
            }
          | undefined;
        if (!props) break;
        const sessionID = eventSessionID(props);
        if (!sessionID) break;
        const isFailoverRetry =
          props.status?.type === 'retry' &&
          (isFailoverError(props.error) ||
            (props.status.message !== undefined &&
              isFailoverError({ message: props.status.message })));
        if (isFailoverRetry && this.enabled) {
          // Guard: stale retry event from a previous model's retry loop.
          // After a fallback, lastTriggerModel holds the OLD model (set by
          // isDeduped before the fallback), while sessionModel holds the NEW
          // model. A stale retry from the old model arrives with attempt > 1
          // (continuation of old retry loop). A genuine retry from the new
          // model arrives with attempt === 1 (first retry for new model).
          const prevModel = this.lastTriggerModel.get(sessionID);
          const curModel = this.sessionModel.get(sessionID);
          const lastTriggerTime = this.lastTrigger.get(sessionID) ?? 0;
          const attempt = props.status?.attempt ?? 1;
          const modelChanged =
            prevModel !== undefined &&
            curModel !== undefined &&
            prevModel !== curModel;
          const withinDedupWindow =
            this.now() - lastTriggerTime < DEDUP_WINDOW_MS;
          if (modelChanged && withinDedupWindow && attempt > 1) {
            // Model changed since last trigger, within dedup window, and
            // attempt > 1: this is a stale retry from the old model's
            // retry loop (continuation of previous attempts). Skip it.
            break;
          }
          // An overlapping retry cannot be admitted by the active fallback;
          // leave both the retry identity and host budget untouched.
          if (this.inProgress.has(sessionID)) break;
          this.rearmIfFreshDescent(sessionID);
          if (this.retryAlreadyObserved(sessionID, attempt)) break;
          // A no-chain status paired with a same-turn error incident is the
          // host retrying that already-handled failure (or its replay):
          // consume it without charging or sending another prompt.
          if (
            !this.hasFallbackChain(sessionID) &&
            this.hasSameTurnErrorIncident(sessionID)
          ) {
            this.recordRetryAttempt(sessionID, attempt);
            this.cancelInitialDelay(sessionID);
            break;
          }
          const incidentID = `retry:${curModel ?? 'unknown'}:${attempt}`;
          const retryError = props.error ?? {
            message: props.status?.message ?? '',
          };
          if (this.surfacesSpentQuota(sessionID, retryError)) break;
          // Permanent quota/billing exhaustion and spent allowance never
          // recover by host retries on this provider — skip the host-retry
          // budget and fall back at once. Otherwise (attempt === 1, or model
          // didn't change, or outside dedup window): process as genuine
          // retry for current model.
          if (
            !isPermanentQuotaBillingError(retryError) &&
            !isSpentQuotaError(retryError) &&
            this.absorbHostRetry(
              sessionID,
              props.status?.next === undefined
                ? undefined
                : props.status.next - this.now(),
            )
          ) {
            this.recordRetryAttempt(sessionID, attempt);
            this.cancelInitialDelay(sessionID);
            break;
          }
          if (this.bypassInitialFallbackDelay(sessionID, retryError)) {
            await this.tryFallbackWithAbort(
              sessionID,
              retryError,
              attempt,
              incidentID,
            );
          } else if (
            !this.delayInitialFallback(
              sessionID,
              true,
              attempt,
              retryError,
              incidentID,
            )
          ) {
            // Failover may have been detected from status.message (e.g.
            // 'AI_APICallError: Gone') with no separate error property;
            // forward that message so 401/410 inline errors suppress the
            // toast on this path too, matching session.error behavior.
            await this.tryFallbackWithAbort(
              sessionID,
              retryError,
              attempt,
              incidentID,
            );
          }
          break;
        }

        // Note: do NOT clear sessionRetries here on non-rate-limit statuses.
        // Abort events triggered by our own fallback carry non-rate-limit
        // messages and would reset the counter, creating an infinite loop:
        // abort → fallback → set retries to 1 → abort event clears retries
        // → next retry sees tried=0 → abort+fallback again → repeat.
        // Retries are only cleared on a completed successful assistant
        // response or session deletion.
        break;
      }

      case 'session.created': {
        const info = (
          event.properties as
            | { info?: { id?: string; parentID?: string } }
            | undefined
        )?.info;
        if (info?.id && info.parentID) {
          this.sessionParent.set(info.id, info.parentID);
        }
        break;
      }

      case 'subagent.session.created': {
        // Some builds of OpenCode include the agent name here.
        const props = event.properties as
          | { sessionID?: string; agentName?: unknown }
          | undefined;
        if (props?.sessionID && typeof props.agentName === 'string') {
          this.registerSessionAgent(props.sessionID, props.agentName);
        }
        break;
      }

      case 'session.deleted': {
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
        break;
      }
    }
  }

  /** v2 retry-hook steering. The host calls this hook whenever it is about
   *  to retry (or give up on) a provider failure for a session, passing the
   *  mutable `decision` the host will honor. Steering absorbs host retries
   *  up to `maxRetries`, then switches the model in place via
   *  `session.switchModel` and mutates `decision` so the host retries the
   *  CURRENT turn on the new model — no transcript replay, so the a3ac0bee
   *  per-turn race cannot occur. Guarded by `v2RetryEnabled`, independent
   *  of the replay path's `enabled`. */
  async handleV2Retry(
    event: {
      sessionID: string;
      agent?: string;
      model: { providerID: string; id: string };
      error: unknown;
      decision?: { retry: boolean; delay?: number };
    },
    switchModel: (
      sessionID: string,
      model: { providerID: string; id: string },
    ) => Promise<unknown>,
  ): Promise<void> {
    let picked: string | undefined;
    let switchRequest: Promise<unknown> | undefined;
    const from = `${event.model.providerID}/${event.model.id}`;
    try {
      const { sessionID } = event;
      // One-shot deterministic delivery notice (evidence gate): proves the
      // host invokes this hook for this session, and how the error was
      // classified, independent of steering enablement. One line per
      // session and failing model, so a disabled steering path can never
      // masquerade as a working hook (a3ac0bee postmortem).
      const failover = isFailoverError(event.error);
      let notices = this.v2RetryNotices.get(sessionID);
      if (!notices) {
        notices = new Set();
        this.v2RetryNotices.set(sessionID, notices);
      }
      if (!notices.has(from)) {
        notices.add(from);
        log('[foreground-fallback] v2 retry hook observed', {
          sessionID,
          agent: event.agent,
          from,
          failover,
          steering: this.retryEnabledFor(sessionID),
        });
      }
      if (
        !this.retryEnabledFor(sessionID) ||
        this.disposed ||
        this.inProgress.has(sessionID)
      )
        return;
      if (!failover) return;
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
      if (event.agent) this.registerSessionAgent(sessionID, event.agent);
      this.sessionModel.set(sessionID, from);
      // Spent allowance on every chain provider: leave the host decision.
      // The host names the model whose attempt failed, so attribution is
      // direct: no echo heuristic on this path (an old model's late retry
      // was already dropped by the tried-model check above).
      if (this.surfacesSpentQuota(sessionID, event.error, from)) return;
      if (event.decision?.retry === true) {
        this.rearmIfFreshDescent(sessionID);
        // Permanent quota/billing exhaustion and spent allowance never
        // recover by host retries on this provider — skip the host-retry
        // budget and steer at once.
        if (
          !isPermanentQuotaBillingError(event.error) &&
          !isSpentQuotaError(event.error) &&
          this.absorbHostRetry(sessionID, event.decision.delay)
        )
          return;
      }
      const selected = this.selectFallbackModel(sessionID, event.error);
      if (!selected || selected === 'exhausted') return;
      const { agentName, nextModel, ref, variant } = selected;
      picked = nextModel;
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
      if (this.disposed) return;
      event.decision = { retry: true, delay: this.retryDelayMs };
      this.commitSwitch(sessionID, from, nextModel, event.error);
      this.showFallbackToast(agentName, nextModel, event.error);
      log('[foreground-fallback] retry hook switched model in place', {
        sessionID,
        from,
        to: nextModel,
      });
    } catch (err) {
      // Unconfirmed switch: keep the target selectable (a timed-out switch
      // may still land; the next event's model is the host truth).
      if (picked) this.sessionTried.get(event.sessionID)?.delete(picked);
      const pendingSwitch = switchRequest;
      if (err instanceof OperationTimeoutError && picked && pendingSwitch) {
        // Late landing: the timeout cannot cancel the host call. Reconcile
        // if the observed model is still the source or already the target;
        // leave any newer, different selection untouched. The check/write
        // run synchronously. No toast here: the next event's success path
        // notifies; this only repairs state.
        const target = picked;
        void pendingSwitch.then(
          () => {
            const observedModel = this.sessionModel.get(event.sessionID);
            if (
              this.disposed ||
              (observedModel !== from && observedModel !== target)
            )
              return;
            this.commitSwitch(event.sessionID, from, target, event.error);
            log('[foreground-fallback] retry hook reconciled a late switch', {
              sessionID: event.sessionID,
              from,
              to: target,
            });
          },
          () => {},
        );
      }
      log(
        '[foreground-fallback] retry hook switch failed; host decision unchanged',
        { sessionID: event?.sessionID, error: stringifyError(err) },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Retry budget
  // ---------------------------------------------------------------------------

  /** Return true while the host still has retries available. Exhaustion
   *  leaves the counter charged for the remainder of the chain descent.
   *  The counter is shared: host-retry absorbs and same-model replay
   *  charges draw from the same sessionRetries budget. */
  private absorbHostRetry(sessionID: string, delayMs?: number): boolean {
    const hasChain = this.hasFallbackChain(sessionID);
    if (hasChain && (delayMs ?? 0) > MAX_HOST_RETRY_DELAY_MS) return false;
    // No-chain sessions only absorb to fund a same-model replay; once the
    // session is terminal or this failure episode already charged the
    // shared budget, the absorb must not charge again.
    if (!hasChain && this.skipNoChainAbsorbCharge(sessionID)) {
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

  /** No-chain host-retry absorbs must not charge once terminal or when
   *  the same failure's error incident already charged the shared budget. */
  private skipNoChainAbsorbCharge(sessionID: string): boolean {
    return (
      (this.chainExhaustion.get(sessionID) ?? 0) >= 2 ||
      this.deterministicTerminal.has(sessionID) ||
      this.hasSameTurnErrorIncident(sessionID)
    );
  }

  /** Refund one shared-budget charge when a replay never delivered, but
   *  only when the turn is still the charged one: a replay resuming after
   *  a turn advance must not debit the new turn's budget. */
  private refundSessionRetry(sessionID: string, epoch: number): void {
    if ((this.turnEpoch.get(sessionID) ?? 0) !== epoch) return;
    this.sessionRetries.set(
      sessionID,
      Math.max(0, (this.sessionRetries.get(sessionID) ?? 0) - 1),
    );
  }

  /** Restore a lifted deterministic block when nothing delivered, but
   *  never across a turn advance (a new turn starts unblocked). */
  private restoreDeterministicTerminal(
    sessionID: string,
    epoch: number,
    hadTerminal: boolean,
  ): void {
    if (hadTerminal && (this.turnEpoch.get(sessionID) ?? 0) === epoch) {
      this.deterministicTerminal.add(sessionID);
    }
  }

  private cancelInitialDelay(sessionID: string): void {
    const pending = this.pendingInitialDelay.get(sessionID);
    if (!pending) return;
    this.clearTimer(pending.timer);
    this.pendingInitialDelay.delete(sessionID);
  }

  /** A confirmed recovery starts a new descent, including inherit+chain agents. */
  private resetRecoveryState(sessionID: string): void {
    this.sessionRetries.delete(sessionID);
    this.retryAttempt.delete(sessionID);
    this.chainExhaustion.delete(sessionID);
    this.deterministicTerminal.delete(sessionID);
    this.lastFallbackTime.delete(sessionID);
    this.initialDelayUsed.delete(sessionID);
    this.v2RetryNotices.delete(sessionID);
    this.sessionTried.delete(sessionID);
    this.quotaExhaustedProviders.delete(sessionID);
    this.cancelInitialDelay(sessionID);
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

  /** The model a fallback already handled this incident for (this turn),
   *  or undefined when no fallback ran for it yet. */
  private handledIncidentModel(
    sessionID: string,
    incidentID: string,
  ): string | undefined {
    const previous = this.triggerIncidents.get(sessionID)?.get(incidentID);
    if (previous?.turn !== (this.turnEpoch.get(sessionID) ?? 0)) return;
    return previous.model;
  }

  private noteSwitchTrigger(
    sessionID: string,
    model: string | undefined,
    error: unknown,
  ): void {
    if (model === undefined || error === undefined) {
      this.lastSwitchTrigger.delete(sessionID);
      return;
    }
    this.lastSwitchTrigger.set(sessionID, {
      model,
      signature: spentQuotaSignature(error),
      turn: this.turnEpoch.get(sessionID) ?? 0,
      time: this.now(),
    });
  }

  /** The model a spent-quota error without its own model belongs to. An
   *  error tied to a message is that message's incident: surfacesSpentQuota
   *  attributes a handled one to its recorded model, anything else is the
   *  current model's. Any other error (uncorrelated session.error, status
   *  retry) is the last switch trigger's echo only when it
   *  repeats that trigger's signature in the same turn and dedup window,
   *  the trigger's provider is exhausted, and the replacement has emitted
   *  nothing since; otherwise it is the current model's, so a genuine
   *  failure of the replacement still advances the cascade. */
  private triggeringModel(
    sessionID: string,
    error: unknown,
    incidentID?: string,
  ): string | undefined {
    const current = this.sessionModel.get(sessionID);
    if (incidentID?.startsWith('message:')) return current;
    const trigger = this.lastSwitchTrigger.get(sessionID);
    if (
      trigger !== undefined &&
      trigger.model !== current &&
      this.quotaExhaustedProviders
        .get(sessionID)
        ?.has(parseModelReference(trigger.model)?.providerID ?? '') &&
      trigger.signature === spentQuotaSignature(error) &&
      trigger.turn === (this.turnEpoch.get(sessionID) ?? 0) &&
      this.now() - trigger.time < DEDUP_WINDOW_MS
    )
      return trigger.model;
    return current;
  }

  /** Spent allowance (issue #966): mark the failing provider and report
   *  whether the error must surface because no chain entry remains on a
   *  provider with allowance left. Surfacing performs no failover and no
   *  abort, and cancels any queued initial fallback. */
  private surfacesSpentQuota(
    sessionID: string,
    error: unknown,
    failingModel?: string,
    incidentID?: string,
  ): boolean {
    if (!isSpentQuotaError(error)) return false;
    const model = this.sessionModel.get(sessionID);
    // Another observation of an incident a fallback already handled belongs
    // to the model that fallback switched away from, whatever sessionModel
    // names now. It carries no new evidence: record it there, never act.
    const handledModel =
      incidentID === undefined
        ? undefined
        : this.handledIncidentModel(sessionID, incidentID);
    if (handledModel !== undefined) {
      this.markQuotaExhausted(sessionID, handledModel, error);
      return true;
    }
    const { chain } = this.resolveChain(
      this.sessionAgent.get(sessionID),
      model,
      sessionID,
    );
    const failing =
      failingModel ??
      this.triggeringModel(sessionID, error, incidentID) ??
      chain[0];
    const exhausted = this.markQuotaExhausted(sessionID, failing, error);
    // A late error from a model we already switched away from records its
    // provider but must not drive another switch off the replacement.
    if (model !== undefined && failing !== model) return true;
    const viable = chain.some(
      (entry) => !exhausted?.has(parseModelReference(entry)?.providerID ?? ''),
    );
    if (viable) return false;
    this.cancelInitialDelay(sessionID);
    log(
      '[foreground-fallback] spent quota on every chain provider; surfacing',
      {
        sessionID,
        model: failing,
        exhausted: [...(exhausted ?? [])].sort(),
      },
    );
    return true;
  }

  private bypassInitialFallbackDelay(
    sessionID: string,
    error: unknown,
  ): boolean {
    if (!isPermanentQuotaBillingError(error)) return false;
    this.cancelInitialDelay(sessionID);
    this.initialDelayUsed.add(sessionID);
    return true;
  }

  /** Defer an intervention when configured, regardless of its trigger path. */
  private delayInitialFallback(
    sessionID: string,
    needsAbort: boolean,
    retryAttempt?: number,
    error?: unknown,
    incidentID?: string,
  ): boolean {
    if (this.initialRetryDelayMs > 0 && !this.initialDelayUsed.has(sessionID)) {
      log('[foreground-fallback] delaying initial fallback', {
        sessionID,
        delayMs: this.initialRetryDelayMs,
        needsAbort,
      });
      // Keep the first deadline, but follow the latest trigger's abort mode.
      const pending = this.pendingInitialDelay.get(sessionID);
      if (pending) {
        pending.needsAbort = needsAbort;
        pending.retryAttempt = retryAttempt;
        pending.error = error;
        pending.incidentID = incidentID;
        return true;
      }
      const turn = this.turnEpoch.get(sessionID) ?? 0;
      const timer = this.setTimer(() => {
        const latest = this.pendingInitialDelay.get(sessionID);
        if (!latest) return;
        this.pendingInitialDelay.delete(sessionID);
        if (!this.isCurrentTurn(sessionID, latest.turn)) return;
        this.initialDelayUsed.add(sessionID);
        // Background fallback is fail-soft: a failure must be logged
        // and swallowed, never escape as an unhandled rejection.
        // Abort the host loop when the delayed trigger requires it.
        const trigger = latest.needsAbort
          ? this.tryFallbackWithAbort(
              sessionID,
              latest.error,
              latest.retryAttempt,
              latest.incidentID,
            )
          : this.tryFallback(sessionID, latest.error, latest.incidentID);
        void trigger.catch((err) => {
          log('[foreground-fallback] delayed fallback trigger failed', {
            sessionID,
            error: stringifyError(err),
          });
        });
      }, this.initialRetryDelayMs);
      this.pendingInitialDelay.set(sessionID, {
        timer,
        needsAbort,
        turn,
        ...(retryAttempt === undefined ? {} : { retryAttempt }),
        ...(error === undefined ? {} : { error }),
        ...(incidentID === undefined ? {} : { incidentID }),
      });
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Same-model replay (no-chain sessions only; chain replay stays in
  // execFallback)
  // ---------------------------------------------------------------------------

  /** A transcript read failed or timed out before anything was sent:
   *  log, refund the charge, and report the replay as not delivered. */
  private abandonReplayRead(
    sessionID: string,
    opts: { epoch: number; charged: boolean },
    error: unknown,
  ): false {
    log('[foreground-fallback] same-model replay transcript read failed', {
      sessionID,
      error: stringifyError(error),
    });
    if (opts.charged) this.refundSessionRetry(sessionID, opts.epoch);
    return false;
  }

  private async replayWithModel(
    sessionID: string,
    model: { providerID: string; modelID: string },
    opts: {
      agentName: string;
      variant?: string;
      trailerText: string;
      epoch: number;
      charged: boolean;
    },
  ): Promise<boolean> {
    const session = getClient(this.input).session;
    // Tail read mirroring execFallback: the replay needs the last
    // replayable user message plus the trailing message id (handoff
    // baseline), never the full history. A tail without a user message is
    // one long turn: read only the user message its last entry answers
    // (v1 `parentID`); shapes without that id read it all.
    // Both reads are bounded like execFallback's: a hung host call must
    // not pin inProgress forever. A failed read sent nothing, so refund.
    let tailResult: { data?: unknown; error?: unknown };
    try {
      tailResult = await readForReplay<{ data?: unknown; error?: unknown }>(
        sessionID,
        session.messages({
          path: { id: sessionID },
          query: { limit: FALLBACK_REPLAY_TAIL_MESSAGES },
        }),
        'same-model replay transcript read timed out',
        this.timerSeam,
      );
    } catch (err) {
      return this.abandonReplayRead(sessionID, opts, err);
    }
    if (!this.isCurrentTurn(sessionID, opts.epoch)) return false;
    const messages = (tailResult.data ?? []) as unknown[];
    let requestError: unknown = tailResult.error ?? undefined;
    let lastUser = messages.findLast(isReplayableUserMessage);
    if (!lastUser) {
      const parentID = (messages.at(-1) as { info?: { parentID?: unknown } })
        ?.info?.parentID;
      let deepResult: { data?: unknown; error?: unknown };
      try {
        deepResult = await readForReplay<{ data?: unknown; error?: unknown }>(
          sessionID,
          typeof parentID === 'string'
            ? session.message({ path: { id: sessionID, messageID: parentID } })
            : session.messages({ path: { id: sessionID } }),
          'same-model replay transcript read timed out',
        );
      } catch (err) {
        return this.abandonReplayRead(sessionID, opts, err);
      }
      if (!this.isCurrentTurn(sessionID, opts.epoch)) return false;
      lastUser = [deepResult.data ?? []]
        .flat()
        .findLast(isReplayableUserMessage);
      // Preserve BOTH failures: when the tail and the deeper read fail
      // differently, the diagnostic log must surface the first error
      // too instead of letting the deeper-read error overwrite it.
      const deepError = deepResult.error ?? undefined;
      if (deepError !== undefined) {
        requestError =
          requestError === undefined ? deepError : [requestError, deepError];
      }
    }
    if (!lastUser) {
      log('[foreground-fallback] no user message found', {
        sessionID,
        messageCount: messages.length,
        requestError,
      });
      if (opts.charged) this.refundSessionRetry(sessionID, opts.epoch);
      return false;
    }
    if (typeof session.promptAsync !== 'function') {
      log('[foreground-fallback] promptAsync unavailable', { sessionID });
      if (opts.charged) this.refundSessionRetry(sessionID, opts.epoch);
      return false;
    }
    // Bound: the SDK's promptAsync reads `this._client`, so calling the
    // extracted function unbound throws on the real client.
    const promptAsync = session.promptAsync.bind(session) as (
      args: Record<string, unknown>,
    ) => Promise<unknown>;

    // No `modelSwitch: 'required'`: the replay targets the session's
    // CURRENT model, so the v2 shim may skip the switch (preserving the
    // host-side variant) and hosts without session.switchModel can still
    // deliver it. v1 call bytes stay untouched.
    const isV2Host =
      (this.input as PluginInput & { hostFlavor?: string }).hostFlavor === 'v2';
    const promptBody = {
      path: { id: sessionID },
      body: {
        messageID: createReplayMessageID(this.now),
        // Trailer only, as in execFallback.
        parts: [createInternalAgentTextPart(opts.trailerText)],
        model,
        ...(opts.variant ? { variant: opts.variant } : {}),
        agent: opts.agentName,
      },
      ...(isV2Host && opts.variant ? { modelVariant: opts.variant } : {}),
    };
    const sendReplayPrompt = (): Promise<unknown> => {
      this.rememberReplayMessage(sessionID, promptBody.body.messageID);
      return withTimeout(
        promptAsync(promptBody),
        REPLAY_SEND_TIMEOUT_MS,
        'same-model replay prompt timed out',
        this.timerSeam,
      );
    };

    // Bounded admissions (SAME_MODEL_REPLAY_ATTEMPTS): the initial send
    // plus a single busy-path re-send after abort.
    let promptResult: unknown;
    let delivered = false;
    for (
      let sendAttempt = 1;
      sendAttempt <= SAME_MODEL_REPLAY_ATTEMPTS;
      sendAttempt++
    ) {
      try {
        promptResult = await sendReplayPrompt();
        delivered = true;
        break;
      } catch (promptErr) {
        const lastChance = sendAttempt >= SAME_MODEL_REPLAY_ATTEMPTS;
        if (promptErr instanceof OperationTimeoutError) {
          // A send timeout cannot prove busyness: never abort or duplicate
          // the replay (matches the chain replay path).
          // Delivery is unknown (the host may still admit it), so the
          // charge stands; only a confirmed rejection refunds.
          log('[foreground-fallback] same-model replay send timed out', {
            sessionID,
            error: stringifyError(promptErr),
          });
          return false;
        }
        if (lastChance || isV2Host || !isBusyRefusalError(promptErr)) {
          // Exhausted admissions, an unproven-busy rejection, or a v2
          // host: a rejected v2 replay is final, and only a proven busy
          // refusal justifies aborting and re-sending. Log and stop;
          // never let the re-send escape through try/finally-only
          // callers.
          log('[foreground-fallback] same-model re-prompt failed', {
            sessionID,
            error: stringifyError(promptErr),
          });
          if (opts.charged) this.refundSessionRetry(sessionID, opts.epoch);
          return false;
        }
        if (!this.isCurrentTurn(sessionID, opts.epoch)) {
          if (opts.charged) this.refundSessionRetry(sessionID, opts.epoch);
          return false;
        }
        if (this.withholdsAbortForLiveChildren(sessionID)) {
          if (opts.charged) this.refundSessionRetry(sessionID, opts.epoch);
          return false;
        }
        log('[foreground-fallback] promptAsync on busy session, aborting', {
          sessionID,
          error: stringifyError(promptErr),
        });
        await this.promoteForegroundWaiter(sessionID);
        if (!this.isCurrentTurn(sessionID, opts.epoch)) {
          if (opts.charged) this.refundSessionRetry(sessionID, opts.epoch);
          return false;
        }
        if (this.withholdsAbortForLiveChildren(sessionID)) {
          if (opts.charged) this.refundSessionRetry(sessionID, opts.epoch);
          return false;
        }
        try {
          await abortSessionWithTimeout(getClient(this.input), sessionID);
        } catch (err) {
          log('[foreground-fallback] busy re-send abort failed', {
            sessionID,
            error: stringifyError(err),
          });
          if (opts.charged) this.refundSessionRetry(sessionID, opts.epoch);
          return false;
        }
        if (!this.isCurrentTurn(sessionID, opts.epoch)) {
          if (opts.charged) this.refundSessionRetry(sessionID, opts.epoch);
          return false;
        }
        await this.sleep(REPROMPT_DELAY_MS);
        if (!this.isCurrentTurn(sessionID, opts.epoch)) {
          if (opts.charged) this.refundSessionRetry(sessionID, opts.epoch);
          return false;
        }
        promptBody.body.messageID = createReplayMessageID(this.now);
      }
    }
    if (!delivered) return false;

    // SDK envelopes can resolve (not reject) with `{ error }` — an
    // unadmitted replay is a failure, not a silent success.
    if (isRecord(promptResult) && responseError(promptResult) !== undefined) {
      log(
        '[foreground-fallback] same-model re-prompt rejected by host error envelope',
        { sessionID, model: `${model.providerID}/${model.modelID}` },
      );
      if (opts.charged) this.refundSessionRetry(sessionID, opts.epoch);
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Core fallback logic
  // ---------------------------------------------------------------------------

  private async tryFallback(
    sessionID: string,
    error?: unknown,
    incidentID?: string,
  ): Promise<void> {
    if (!sessionID) return;
    // Reload fence at entry, before any state mutation: a trigger racing
    // dispose() must not start a new chain through the dead context.
    if (this.abandonedByDispose(sessionID)) return;
    const epoch = this.turnEpoch.get(sessionID) ?? 0;
    if (this.inProgress.has(sessionID)) return;
    if (
      !this.sessionAgent.has(sessionID) &&
      !(await this.ensureSessionAgent(sessionID))
    )
      return;
    if (!this.isCurrentTurn(sessionID, epoch) || this.inProgress.has(sessionID))
      return;
    // No chain -> same-model retry, owned by trySameModelRetry. Only an
    // explicitly disabled chain returns before dedup stamping; every other
    // no-chain session records the incident.
    if (!this.hasFallbackChain(sessionID)) {
      return this.trySameModelRetry(sessionID, {
        error,
        incidentID,
        epoch,
      });
    }
    // Deduplicate duplicate observations within the same user turn/model
    // episode. A confirmed new turn or model change starts a new incident.
    if (this.isDeduped(sessionID, incidentID, error)) return;

    // Set inProgress before delay to prevent concurrent fallback attempts
    this.inProgress.add(sessionID);
    try {
      // Delay between consecutive fallback attempts (except for the initial trigger
      // which uses initialRetryDelayMs in shouldTriggerFallback).
      const lastFallback = this.lastFallbackTime.get(sessionID);
      if (lastFallback && this.retryDelayMs > 0) {
        const elapsed = this.now() - lastFallback;
        if (elapsed < this.retryDelayMs) {
          const delay = this.retryDelayMs - elapsed;
          log('[foreground-fallback] delaying retry fallback', {
            sessionID,
            delayMs: delay,
            elapsed,
          });
          await this.sleep(delay);
          // The backoff slept through a dispose(): execFallback would
          // read the transcript and re-prompt through the destroyed
          // generation's client. The finally below still releases the
          // process-global inProgress slot.
          if (!this.isCurrentTurn(sessionID, epoch)) return;
        }
      }

      if (!this.isCurrentTurn(sessionID, epoch)) return;
      await this.execFallback(sessionID, error, epoch, true);
      if (this.isCurrentTurn(sessionID, epoch)) {
        this.lastFallbackTime.set(sessionID, this.now());
      }
    } finally {
      this.inProgress.delete(sessionID);
    }
  }

  /**
   * Fallback path for session.status retry events.  Aborts the retry loop
   * before falling back because promptAsync alone is ignored while the
   * session is in retry mode.  inProgress is set first so the
   * task-session-manager sees isFallbackInProgress()=true during the
   * abort idle window and does not cancel the pending task call.
   *
   * When no chain is available, retries the current model (up to maxRetries
   * shared-budget attempts) — transient upstream errors like streaming
   * 5xx/524, queue-full, and worker-limit strains often resolve when the
   * replay lands on a different worker.
   */
  /** Promote a foreground task() waiter through the v1 SDK before abort
   *  settles the child's job as "cancelled". The parent's wait then resolves
   *  via backgroundResult and the fallback replay stays tracked. On v2,
   *  no supported transport exists; never request an unknown loopback URL.
   *  Missing transport or promotion failure degrades to the previous behavior
   *  ("Task cancelled" + untracked replay). Must precede the abort. */
  private async promoteForegroundWaiter(sessionID: string): Promise<void> {
    const parentSessionID = this.sessionParent.get(sessionID);
    if (!parentSessionID) return;
    try {
      const client = getClient(this.input) as unknown as {
        _client?: {
          post?: (args: {
            url: string;
            path: Record<string, string>;
          }) => Promise<unknown>;
        };
      };
      const post = client._client?.post;
      if (typeof post !== 'function') {
        log(
          '[foreground-fallback] foreground waiter promotion unavailable on this host; continuing fallback',
          { sessionID, parentSessionID, transport: 'none' },
        );
        return;
      }
      const result = await withTimeout(
        post.call(client._client, {
          url: '/experimental/session/{sessionID}/background',
          path: { sessionID: parentSessionID },
        }),
        HOST_CALL_TIMEOUT_MS,
        'foreground waiter promotion timed out',
        this.timerSeam,
      );
      const err = responseError(result);
      if (err !== undefined) throw new Error(stringifyError(err));
      log(
        '[foreground-fallback] promoted foreground task waiter to background',
        { sessionID, parentSessionID, transport: 'sdk' },
      );
    } catch (err) {
      log(
        '[foreground-fallback] foreground waiter promotion failed; continuing fallback',
        {
          sessionID,
          parentSessionID,
          transport: 'sdk',
          error: stringifyError(err),
        },
      );
    }
  }

  private async tryFallbackWithAbort(
    sessionID: string,
    error?: unknown,
    retryAttempt?: number,
    incidentID?: string,
  ): Promise<void> {
    if (!sessionID) return;
    // Reload fence at entry (same rationale as tryFallback).
    if (this.abandonedByDispose(sessionID)) return;
    const epoch = this.turnEpoch.get(sessionID) ?? 0;
    if (this.inProgress.has(sessionID)) return;
    if (
      !this.sessionAgent.has(sessionID) &&
      !(await this.ensureSessionAgent(sessionID))
    )
      return;
    if (!this.isCurrentTurn(sessionID, epoch) || this.inProgress.has(sessionID))
      return;
    // No chain -> same-model retry (the status path absorbs into the shared
    // budget, so no abort is needed here).
    if (!this.hasFallbackChain(sessionID)) {
      return this.trySameModelRetry(sessionID, {
        error,
        incidentID,
        epoch,
      });
    }
    // An exhausted chain has no replacement: never abort another host retry.
    if (this.chainExhaustion.get(sessionID) === 2) return;
    if (this.withholdsAbortForLiveChildren(sessionID)) return;

    this.inProgress.add(sessionID);
    try {
      await this.promoteForegroundWaiter(sessionID);
      // Promotion awaited: a reload may have disposed this generation in
      // the meantime — never abort through a stale client.
      if (!this.isCurrentTurn(sessionID, epoch)) return;
      if (this.withholdsAbortForLiveChildren(sessionID)) return;
      if (this.isDeduped(sessionID, incidentID, error)) return;
      if (retryAttempt !== undefined) {
        if (this.retryAlreadyObserved(sessionID, retryAttempt)) return;
        this.recordRetryAttempt(sessionID, retryAttempt);
      }
      try {
        await abortSessionWithTimeout(getClient(this.input), sessionID);
      } catch (err) {
        log('[foreground-fallback] abort failed; skipping fallback', {
          sessionID,
          error: stringifyError(err),
        });
        return;
      }
      // The abort suspended across a dispose(): its outcome no longer
      // matters to the reloaded generation — do not continue into
      // execFallback (transcript read + replay on the dead client).
      // The finally below still releases the process-global slot.
      if (!this.isCurrentTurn(sessionID, epoch)) return;
      await this.execFallback(sessionID, error, epoch);
    } finally {
      this.inProgress.delete(sessionID);
    }
  }

  /**
   * Same-model retry for sessions with no fallback chain (unknown agents,
   * councillor-style self-managed sessions): transient upstream errors
   *  (streaming 5xx/524, queue-full, worker-limit) often resolve when the
   *  replay lands on a different worker. Owns the budget, exhaustion,
   *  disable, dedup, charge, in-progress, parse, log, and replay steps
   *  (the session.status path absorbs into the shared budget and only
   *  arrives once spent, so no abort is needed).
   *
   * Tracked background children stay out: this path performs no
   * backgroundFallbackHandoff prepare/admit/reject, so a replay here would
   * run untracked and its result unobserved. Chain replay (execFallback)
   * arms the handoff; same-model replay does not.
   */
  private async trySameModelRetry(
    sessionID: string,
    opts: {
      error?: unknown;
      incidentID?: string;
      epoch: number;
    },
  ): Promise<void> {
    const currentModel = this.sessionModel.get(sessionID);
    if (!currentModel) return;
    // Deterministic failures never recover on the same model: no retry and
    // no budget charge, but block the promise until a retryable-transient
    // error lifts it. No dedup stamp.
    // Request-scoped rejections (policy/content filter, retired or unknown
    // model) reproduce on the same model, so they are terminal here too.
    if (
      isInlineFailoverError(opts.error) ||
      isPermanentQuotaBillingError(opts.error) ||
      // Spent allowance (issue #966) is not transient either; the trigger
      // paths already surface it, this keeps the replay path closed too.
      isSpentQuotaError(opts.error) ||
      failoverScope(opts.error) === 'request'
    ) {
      this.deterministicTerminal.add(sessionID);
      return;
    }
    const agentName =
      this.sessionAgent.get(sessionID) ??
      (await this.ensureSessionAgent(sessionID));
    if (!agentName || !this.isCurrentTurn(sessionID, opts.epoch)) return;
    // Explicitly disabled chains stay silent (as does their abort: with no
    // replacement model it would only race owners managing their own
    // lifecycle). Unknown agents fail open.
    if (this.isChainExplicitlyDisabled(sessionID, agentName)) return;
    // Never charge the budget for a model reference that cannot replay, but
    // block the promise until a retryable error with a good model arrives.
    const ref = parseModelReference(currentModel);
    if (!ref) {
      this.deterministicTerminal.add(sessionID);
      return;
    }
    // Tracked background children stay out (no handoff on this path — see
    // the docstring above).
    if (
      this.sessionParent.has(sessionID) ||
      this.readBackgroundGeneration?.(sessionID) !== undefined
    ) {
      log(
        '[foreground-fallback] same-model retry skipped for background child',
        { sessionID },
      );
      return;
    }
    const tried = this.sessionRetries.get(sessionID) ?? 0;
    // ID-less arrivals still stamp a namespaced incident so a correlated
    // status does not recharge the same failure.
    const incidentID =
      opts.incidentID ??
      `session-error:anonymous:${opts.epoch}:${++this.incidentSequence}`;
    if (tried >= this.maxRetries) {
      // Budget spent: terminal no-chain exhaustion (parity with
      // chainExhaustion=2). Sticks until a success, a new user turn, or
      // session deletion; the counter stays charged so willAttemptFallback
      // reports no pending retry. Dedup first so one episode logs once.
      if (this.isDeduped(sessionID, incidentID)) return;
      this.chainExhaustion.set(sessionID, 2);
      log('[foreground-fallback] same-model retry exhausted', {
        sessionID,
        model: currentModel,
        tried,
        remaining: 0,
      });
      return;
    }
    // Deduplicate duplicate observations within the same turn/model episode.
    if (this.isDeduped(sessionID, incidentID)) return;
    // Lift a prior deterministic block only for an error that actually
    // proceeds: exiting duplicates must not flip the promise with nothing
    // pending.
    const hadDeterministicTerminal =
      this.deterministicTerminal.delete(sessionID);

    this.inProgress.add(sessionID);
    try {
      // The replay below suspends across awaits: a dispose() or a newer
      // turn in the meantime must abandon it on the dead generation. The
      // finally still releases the process-global inProgress slot.
      if (!this.isCurrentTurn(sessionID, opts.epoch)) {
        this.restoreDeterministicTerminal(
          sessionID,
          opts.epoch,
          hadDeterministicTerminal,
        );
        return;
      }
      // No abort here: the session.status path absorbs host retries into
      // the shared budget and only arrives once spent.
      // Charge once per failure: a same-turn status absorb already charged
      // this failure, so replay without charging again; consume the pairing
      // so later distinct errors charge normally. Only a stale-epoch
      // abandonment above skips the charge otherwise.
      // Residual: an unrelated same-turn/same-model error after an absorb
      // also consumes the pairing — at most one free replay, then re-armed.
      const prior = this.retryAttempt.get(sessionID);
      const absorbCharged =
        prior !== undefined &&
        prior.turn === (this.turnEpoch.get(sessionID) ?? 0) &&
        prior.model === currentModel;
      const charged = !absorbCharged;
      if (charged) {
        this.sessionRetries.set(sessionID, tried + 1);
      } else {
        this.retryAttempt.delete(sessionID);
      }
      const variant = agentName
        ? this.pinnedChains(sessionID)
            [agentName]?.map((entry) =>
              typeof entry === 'string' ? { id: entry } : entry,
            )
            .find((entry) => entry.id === currentModel)?.variant
        : undefined;
      log('[foreground-fallback] same-model retry', {
        sessionID,
        model: currentModel,
        attempt: tried + 1,
        remaining: this.maxRetries - tried - 1,
      });
      const delivered = await this.replayWithModel(sessionID, ref, {
        agentName,
        ...(variant ? { variant } : {}),
        trailerText: SAME_MODEL_RETRY_TRAILER,
        epoch: opts.epoch,
        charged,
      });
      this.restoreDeterministicTerminal(
        sessionID,
        opts.epoch,
        !delivered && hadDeterministicTerminal,
      );
    } finally {
      this.inProgress.delete(sessionID);
    }
  }

  private isDeduped(
    sessionID: string,
    incidentID?: string,
    error?: unknown,
  ): boolean {
    const now = this.now();
    const curModel = this.sessionModel.get(sessionID);
    const turn = this.turnEpoch.get(sessionID) ?? 0;
    if (incidentID !== undefined) {
      let incidents = this.triggerIncidents.get(sessionID);
      if (!incidents) {
        incidents = new Map();
        this.triggerIncidents.set(sessionID, incidents);
      }
      for (const [id, previous] of incidents) {
        if (previous.turn !== turn || now - previous.time >= DEDUP_WINDOW_MS) {
          incidents.delete(id);
        }
      }
      if (incidents.has(incidentID)) return true;
      incidents.set(incidentID, { turn, time: now, model: curModel });
    }
    this.lastTrigger.set(sessionID, now);
    this.lastTriggerTurn.set(sessionID, turn);
    this.noteSwitchTrigger(sessionID, curModel, error);
    if (curModel !== undefined) {
      this.lastTriggerModel.set(sessionID, curModel);
    }
    return false;
  }

  /** A return to the OBSERVED configured primary starts a new descent. An
   *  inferred head, dynamic inherit+chain head, or committed fallback does
   *  not count. */
  private rearmIfFreshDescent(sessionID: string): void {
    const observedModel = this.sessionModel.get(sessionID);
    if (!observedModel) return;
    if (this.activeFallback.get(sessionID)?.model === observedModel) return;
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
    // descent continues, so replays landing on it cannot reopen the chain.
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
    this.retryAttempt.delete(sessionID);
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
    // When the agent is known but no model was captured (common for
    // subagent error events that fire before message.updated), infer
    // the current model as the chain's first entry. Without this, the
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
    // A single-entry chain never has tried.size > 1 and stays terminal after
    // its one abort.
    this.rearmIfFreshDescent(sessionID);
    // biome-ignore lint/style/noNonNullAssertion: We just set this above
    const tried = this.sessionTried.get(sessionID)!;

    // After the chain has been exhausted twice (sticky retry failed and we
    // aborted), do not intervene again for this session: re-entering would
    // keep aborting in a loop. Surface errors to the user instead.
    const exhaustion = this.chainExhaustion.get(sessionID) ?? 0;
    if (exhaustion === 2) return;
    if (currentModel) tried.add(currentModel);
    // Re-mark after a re-arm above: the failing provider stays excluded.
    const quotaExhausted = this.markQuotaExhausted(
      sessionID,
      currentModel,
      error,
    );
    const hasAllowance = (model: string) =>
      !quotaExhausted?.has(parseModelReference(model)?.providerID ?? '');

    const downProviders = this.getActiveFallback(sessionID)?.downProviders;
    const parentID = this.sessionParent.get(sessionID);
    const parentDownProviders = parentID
      ? this.getActiveFallback(parentID)?.downProviders
      : undefined;
    // A failure after the sticky retry ends the descent even if switching to
    // the sticky entry cleared its provider from the exclusions.
    let nextModel = exhaustion
      ? undefined
      : chain.find((model) => {
          const provider = parseModelReference(model)?.providerID ?? '';
          return (
            !tried.has(model) &&
            hasAllowance(model) &&
            !downProviders?.has(provider) &&
            !parentDownProviders?.has(provider)
          );
        });
    if (!nextModel) {
      if (chain.length > 1) {
        // Retry the last chain entry once, ignoring provider exclusions but
        // retaining tried models. If that sticky retry fails, abort once and
        // stop intervening instead of reopening the chain. A spent allowance
        // (issue #966) is never retried: with no entry left on another
        // provider the error surfaces without an abort.
        const stickyFallback = chain.findLast(hasAllowance);
        if (stickyFallback === undefined) {
          this.cancelInitialDelay(sessionID);
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
    this.lastFallbackTime.delete(sessionID);
    // Cancel any pending initial delay on model switch
    this.cancelInitialDelay(sessionID);

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

  private async execFallback(
    sessionID: string,
    error?: unknown,
    expectedEpoch = this.turnEpoch.get(sessionID) ?? 0,
    announce = false,
  ): Promise<void> {
    // Reload fence at entry: execFallback is reached after suspension
    // points in the tryFallback* callers; a disposed generation must not
    // even read the transcript through the old client.
    if (!this.isCurrentTurn(sessionID, expectedEpoch)) return;
    const session = getClient(this.input).session;
    try {
      const selection = this.selectFallbackModel(sessionID, error);
      if (!selection) return;
      if (selection === 'exhausted') {
        // Same withhold as the retry and busy paths: the merged chain
        // selection collapses both exhaustion aborts into this one point.
        if (this.withholdsAbortForLiveChildren(sessionID)) return;
        if (!this.isCurrentTurn(sessionID, expectedEpoch)) return;
        await abortSessionWithTimeout(getClient(this.input), sessionID);
        return;
      }
      const { currentModel, nextModel, ref, variant } = selection;
      const agentName =
        this.sessionAgent.get(sessionID) ??
        (await this.ensureSessionAgent(sessionID));
      if (!agentName || !this.isCurrentTurn(sessionID, expectedEpoch)) return;

      // Confirm there is a user turn before sending the replay reminder.
      // Fence captured BEFORE any await in the preparation: a board
      // relaunch during the transcript read or the admission await must
      // not enroll the new generation under this (stale) attempt's
      // baseline. undefined = not a tracked background child
      // (foreground/untracked) → the handoff is a no-op, never a
      // wildcard.
      const preparedGeneration = this.readBackgroundGeneration?.(sessionID);

      // Read only the transcript tail: the replay needs the last replayable
      // user message and the trailing message id (handoff baseline), not the
      // whole history. Long-lived sessions serve the full listing in the
      // hundreds of megabytes (measured 463 MB / 11.7 s on a live
      // months-old orchestrator session), which delayed every failover by
      // ~20 s. The `limit` query keeps the hot path O(tail). A tail without a
      // user message is one long turn: read only the user message its last
      // entry answers (v1 `parentID`); shapes without that id read it all.
      const tailResult = await readForReplay(
        sessionID,
        session.messages({
          path: { id: sessionID },
          query: { limit: FALLBACK_REPLAY_TAIL_MESSAGES },
        }),
        'fallback replay transcript read timed out',
        this.timerSeam,
      );
      // Transcript read suspended across a dispose(): everything from
      // here on — handoff arming, replay prompt, switch claim — would
      // run through the destroyed generation's client. Abandon before
      // arming anything; the tryFallback* finally releases inProgress.
      if (!this.isCurrentTurn(sessionID, expectedEpoch)) return;
      // result.data may contain partial/streaming messages whose `info` is
      // undefined at runtime (OpenCode violates its own declared type), and
      // v2 messages carry `type`/`text` instead of `info`/`parts`, so guard
      // each entry instead of dereferencing a fixed shape.
      const messages = (tailResult.data ?? []) as unknown[];
      let requestError: unknown = tailResult.error ?? undefined;
      let lastUser = messages.findLast(isReplayableUserMessage);
      if (!lastUser) {
        const parentID = (messages.at(-1) as { info?: { parentID?: unknown } })
          ?.info?.parentID;
        const deepResult = await readForReplay<{
          data?: unknown;
          error?: unknown;
        }>(
          sessionID,
          typeof parentID === 'string'
            ? session.message({ path: { id: sessionID, messageID: parentID } })
            : session.messages({ path: { id: sessionID } }),
          'fallback replay user message read timed out',
        );
        if (!this.isCurrentTurn(sessionID, expectedEpoch)) return;
        lastUser = [deepResult.data ?? []]
          .flat()
          .findLast(isReplayableUserMessage);
        // Preserve BOTH failures: when the tail and the deeper read fail
        // differently, the diagnostic log must surface the first error
        // too instead of letting the deeper-read error overwrite it.
        const deepError = deepResult.error ?? undefined;
        if (deepError !== undefined) {
          requestError =
            requestError === undefined ? deepError : [requestError, deepError];
        }
      }
      if (!lastUser) {
        log('[foreground-fallback] no user message found', {
          sessionID,
          messageCount: messages.length,
          requestError,
        });
        return;
      }

      // promptAsync queues the prompt and returns immediately - this avoids
      // blocking the event handler while waiting for a full LLM response.
      const sessionClient = session;
      if (typeof sessionClient.promptAsync !== 'function') {
        log('[foreground-fallback] promptAsync unavailable', { sessionID });
        return;
      }
      // Loose alias: the v2 client shim accepts extra top-level args
      // (`modelSwitch`) the way orchestrator-wake passes `delivery`.
      // Bound: the SDK's promptAsync reads `this._client`, so calling the
      // extracted function unbound throws `undefined is not an object
      // (evaluating 'this._client')` on the real client (same binding the
      // revived-run tracker already applies).
      const promptAsync = sessionClient.promptAsync.bind(sessionClient) as (
        args: Record<string, unknown> & { modelSwitch?: 'required' },
      ) => Promise<unknown>;

      // v2-only flag (consumed by the client shim): the replay's model is
      // the fallback TARGET, so a v2 host without session.switchModel must
      // reject the replay (typed error) instead of silently replaying on
      // the model that just failed. v1 call bytes stay untouched.
      const isV2Host =
        (this.input as PluginInput & { hostFlavor?: string }).hostFlavor ===
        'v2';
      const promptBody = {
        path: { id: sessionID },
        body: {
          messageID: createReplayMessageID(this.now),
          // Reminder only: the user's request is already in the history the
          // fallback model reads. Copying its stored parts (ids included)
          // would make the host upsert the original rows and re-expand
          // file/agent parts into this message.
          parts: [
            createInternalAgentTextPart(
              "<system-reminder>\nThe previous model request failed and is being retried with a fallback model. Continue processing the user's original request above. Do not respond to this reminder.\n</system-reminder>",
            ),
          ],
          model: ref,
          ...(variant ? { variant } : {}),
          agent: agentName,
        },
        ...(isV2Host ? { modelSwitch: 'required' as const } : {}),
        ...(isV2Host && variant ? { modelVariant: variant } : {}),
      };

      let promptResult: unknown;
      // Arm the observation handoff BEFORE the admission await: while
      // promptAsync is pending the stop gate defers terminal
      // publication — the re-prompted result may already be persisted
      // but has no delivery owner yet. Baseline = trailing message WITH
      // a string id from the transcript read that produced the replay,
      // so the substituted run's answer is always post-baseline.
      const baselineMessageID = [...messages]
        .reverse()
        .find(
          (m) =>
            isRecord(m) &&
            typeof (m as { info?: { id?: unknown } }).info?.id === 'string',
        ) as { info: { id: string } } | undefined;
      const handoffArmed =
        this.backgroundFallbackHandoff?.prepare(
          sessionID,
          preparedGeneration,
          baselineMessageID?.info?.id,
        ) ?? false;
      // Distinguish "not applicable" (foreground or unmanaged session —
      // preparedGeneration undefined, the fallback proceeds) from "was
      // a confirmed background child whose preparation lost validity"
      // (generation changed during the transcript read): the replay
      // prompt and baseline are stale for an execution that no longer
      // exists — do NOT send them.
      if (preparedGeneration !== undefined && !handoffArmed) {
        log(
          '[foreground-fallback] background child superseded during preparation; replay aborted',
          { sessionID, preparedGeneration },
        );
        return;
      }
      const withdrawHandoff = (): void => {
        if (handoffArmed) {
          this.backgroundFallbackHandoff?.reject(sessionID, preparedGeneration);
        }
      };
      const settleUnresolvedHandoff = (): void => {
        if (handoffArmed) {
          this.backgroundFallbackHandoff?.settleUnresolved(
            sessionID,
            preparedGeneration,
          );
        }
      };
      const sendReplayPrompt = (): Promise<unknown> => {
        this.rememberReplayMessage(sessionID, promptBody.body.messageID);
        return withTimeout(
          promptAsync(promptBody),
          REPLAY_SEND_TIMEOUT_MS,
          'fallback replay prompt timed out',
          this.timerSeam,
        );
      };
      try {
        promptResult = await sendReplayPrompt();
      } catch (promptErr) {
        if (promptErr instanceof OperationTimeoutError) {
          // A timeout cannot prove refusal; never abort or duplicate the replay.
          settleUnresolvedHandoff();
          throw promptErr;
        }
        if (!this.isCurrentTurn(sessionID, expectedEpoch)) {
          withdrawHandoff();
          return;
        }
        if (isV2Host) {
          // v2 steer delivery does not reject with BusyError: any rejected
          // replay is final, not a signal to retry. An abort cannot make
          // the admission succeed and may kill a promoted background job.
          // Preserve the cause rather than misreporting it as busy.
          withdrawHandoff();
          throw promptErr;
        }
        if (this.withholdsAbortForLiveChildren(sessionID)) {
          // Explicit busy refusal with no abort attempted: nothing was
          // admitted, so release ownership (reject) like the v2 branch
          // above instead of converting into a tracked run.
          withdrawHandoff();
          throw promptErr;
        }
        log('[foreground-fallback] promptAsync on busy session, aborting', {
          sessionID,
          error: stringifyError(promptErr),
        });
        await this.promoteForegroundWaiter(sessionID);
        if (!this.isCurrentTurn(sessionID, expectedEpoch)) {
          withdrawHandoff();
          return;
        }
        if (this.withholdsAbortForLiveChildren(sessionID)) {
          // Explicit busy refusal with no abort attempted: nothing was
          // admitted, so release ownership (reject) like the v2 branch
          // above instead of converting into a tracked run.
          withdrawHandoff();
          throw promptErr;
        }
        try {
          if (!this.isCurrentTurn(sessionID, expectedEpoch)) {
            withdrawHandoff();
            return;
          }
          await abortSessionWithTimeout(getClient(this.input), sessionID);
        } catch (abortErr) {
          // Unknown outcome: the abort transport failed — the admission
          // state cannot be proven either way, so the prepared ownership
          // CONVERTS into a tracked run instead of being dropped.
          settleUnresolvedHandoff();
          throw abortErr;
        }
        if (!this.isCurrentTurn(sessionID, expectedEpoch)) {
          withdrawHandoff();
          return;
        }
        await this.sleep(REPROMPT_DELAY_MS);
        // Recheck after the abort/backoff: a cancelled or superseded child
        // admits no second replay, so withdraw its prepared handoff.
        if (
          !this.isCurrentTurn(sessionID, expectedEpoch) ||
          (handoffArmed &&
            !this.backgroundFallbackHandoff?.isEligible(
              sessionID,
              preparedGeneration,
            ))
        ) {
          withdrawHandoff();
          return;
        }
        try {
          promptBody.body.messageID = createReplayMessageID(this.now);
          promptResult = await sendReplayPrompt();
        } catch (retryErr) {
          // Transport failed without a response: the host may still
          // have accepted the replay — convert, never drop.
          settleUnresolvedHandoff();
          throw retryErr;
        }
      }

      if (!this.isCurrentTurn(sessionID, expectedEpoch)) {
        // The prompt was accepted, so background ownership still needs to
        // follow it, but its model must not overwrite the newer turn.
        if (handoffArmed) {
          this.backgroundFallbackHandoff?.admit(sessionID, preparedGeneration);
        }
        return;
      }

      // SDK envelopes can resolve (not reject) with `{ error }` — an
      // unresolved admission must not be treated as an accepted switch:
      // state migration and observation transfer only happen after the
      // same error-envelope contract the other SDK call sites apply.
      if (isRecord(promptResult) && responseError(promptResult) !== undefined) {
        log(
          '[foreground-fallback] fallback re-prompt rejected by host error envelope',
          {
            sessionID,
            agentName,
            intended: nextModel,
          },
        );
        withdrawHandoff();
        return;
      }

      // v2 shim: `switched: false` means the replay WAS DELIVERED on
      // the current model — the work is admitted, so the observation
      // handoff is kept (delivery needs an owner); only the model-switch
      // CLAIM is suppressed (sessionModel feeds chain descent and
      // onSessionModelChanged migrates provider accounting; both would
      // lie). Prompt admission and switch confirmation are two
      // different facts.
      const deliveredWithoutSwitch =
        isRecord(promptResult) && promptResult.switched === false;
      if (deliveredWithoutSwitch) {
        log(
          '[foreground-fallback] fallback prompt delivered on the current model (model switch failed)',
          { sessionID, agentName, from: currentModel, intended: nextModel },
        );
      } else {
        this.commitSwitch(sessionID, currentModel, nextModel, error);
      }
      // Admission accepted (with or without the switch): convert the
      // prepared handoff into a tracked run (register + immediate
      // probe) so the substituted run's result is observed and
      // delivered to the parent.
      if (handoffArmed) {
        this.backgroundFallbackHandoff?.admit(
          sessionID,
          preparedGeneration,
          announce
            ? {
                from: currentModel,
                to: deliveredWithoutSwitch ? currentModel : nextModel,
                error: structuredErrorMessage(error) ?? 'Session error',
              }
            : undefined,
        );
      }
      if (deliveredWithoutSwitch) return;
      log('[foreground-fallback] switched to fallback model', {
        sessionID,
        agentName,
        from: currentModel,
        to: nextModel,
      });
      this.showFallbackToast(agentName, nextModel, error);
    } catch (err) {
      log('[foreground-fallback] fallback attempt failed', {
        sessionID,
        error: stringifyError(err),
      });
    }
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

  private async ensureSessionAgent(
    sessionID: string,
  ): Promise<string | undefined> {
    const known = this.sessionAgent.get(sessionID);
    if (known) return known;
    const epoch = this.turnEpoch.get(sessionID) ?? 0;
    const resolved = await resolveSessionAgent(
      getClient(this.input),
      sessionID,
      {
        directory: this.input.directory,
      },
    );
    if (!this.isCurrentTurn(sessionID, epoch)) return undefined;
    if (resolved) this.registerSessionAgent(sessionID, resolved);
    return this.sessionAgent.get(sessionID);
  }

  /** True when resolveChain yields at least one model for this session. */
  private hasFallbackChain(sessionID: string): boolean {
    return (
      this.resolveChain(
        this.sessionAgent.get(sessionID),
        this.sessionModel.get(sessionID),
        sessionID,
      ).chain.length > 0
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
   * 2. Agent name known but NO chain → return [] (no fallback; never
   *    bleed into other agents' chains)
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
      const chain = chains[agentName];
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
            entries: chainEntries[agentName],
            source: agentName,
          };
        }
        return { chain, entries: chainEntries[agentName], source: agentName };
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
