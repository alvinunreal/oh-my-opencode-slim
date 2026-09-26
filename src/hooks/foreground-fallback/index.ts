/**
 * Runtime model fallback for foreground (interactive) agent sessions.
 *
 * When OpenCode fires a session.error, message.updated, or session.status
 * event containing a transient error (rate-limit, 403/Forbidden, etc.), this
 * manager:
 *   1. Looks up the next untried model in the agent's configured chain
 *   2. Aborts the rate-limited prompt via client.session.abort() on the
 *      session.status retry path; session.error and message.updated paths
 *      re-prompt directly without abort.
 *   3. Re-queues the last user message via client.session.promptAsync()
 *      with the new model - promptAsync returns immediately so we never
 *      block the event handler waiting for a full LLM response.
 *
 * This mirrors the same fallback loop used for delegated sessions, but operates
 * reactively through the event system instead of wrapping prompt() in a
 * try/catch, which is not possible for interactive (foreground) sessions.
 */

import type { PluginInput } from '@opencode-ai/plugin';
import { responseError, stringifyError } from '../../utils/child-transcript';
import { isRecord } from '../../utils/guards';
import {
  createInternalAgentTextPart,
  INTERNAL_INITIATOR_METADATA_KEY,
  isInternalInitiatorPart,
  SLIM_INTERNAL_INITIATOR_MARKER,
} from '../../utils/internal-initiator';
import { log } from '../../utils/logger';
import { getClient } from '../../utils/opencode-client';
import {
  abortSessionWithTimeout,
  OperationTimeoutError,
  parseModelReference,
  withTimeout,
} from '../../utils/session';
import type { SessionLifecycle } from '../session-lifecycle';
import { isReplayableUserMessage, partsFromReplayMessage } from '../types';

// ---------------------------------------------------------------------------
// Retryable error detection
// ---------------------------------------------------------------------------

const RETRYABLE_ERROR_PATTERNS = [
  /\b429\b/,
  /rate.?limit/i,
  /too many requests/i,
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
  // Content-policy moderation rejections (e.g. OpenAI "cyber_policy",
  // "content_policy_violation") arrive as HTTP 400 invalid_request with a
  // provider-specific policy code in the body. They are deterministic per
  // provider — retrying the same model will fail again, but a different
  // provider in the chain does not share the policy, so the next model
  // should be tried. Match the structured codes and the exact provider
  // wording; do NOT match generic "flagged"/"policy" words that could
  // appear in ordinary error text.
  /\bcyber_policy\b/,
  /\bcontent_policy_violation\b/,
  /flagged for possible cybersecurity risk/i,
  /rejected as a result of our safety system/i,
  // Billing/quota exhaustion (e.g. xAI "personal-team-blocked:spending-limit")
  // arrives as HTTP 400/402 with a provider-specific billing code. It is
  // deterministic for the same account — retrying the same model will fail
  // again, but a different provider in the chain does not share the balance,
  // so the next model should be tried. Match the structured code and the
  // exact provider wording; do NOT match generic "credits"/"billing" words
  // that can appear in ordinary error text.
  /\bpersonal-team-blocked\b/,
  /\bspending.?limit\b/i,
  /\b(?:ran|run) out of credits\b/i,
  // Zhipu GLM quota/billing (docs.z.ai error codes 1113/1308/1309/1310):
  // the English messages already match the quota wording above, so the
  // quoted JSON codes cover the Chinese wire variants and the Anthropic
  // -style {"type":"1113"} envelopes where no English text survives.
  /"1113"/,
  /"1308"/,
  /"1309"/,
  /"1310"/,
  /\bcoding plan package has expired\b/i,
  /\b(?:weekly|monthly) limit exhausted\b/i,
];

const OUTAGE_STATUS_CODES = new Set([500, 502, 503, 504]);
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
  /\bmodel\b.*\bnot available\b/i,
  /\bmodel is not available\b/i,
  /\bunsupported model\b/i,
  /\bunknown model\b/i,
  // OpenCode's ProviderModelNotFoundError uses "Model not found" wording; the
  // model may exist on a later entry in the configured chain, so treat it as a
  // provider outage and advance the fallback chain.
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

// Usage/quota exhaustion that a retry of the same model cannot recover from:
// deterministic for the current provider/account, so the chain should advance
// immediately. Deliberately narrower than the general failover classifier —
// ordinary 429s, short-term "quota threshold" and generic "usage
// limit/exceeded" wording keep using the configured same-model retry budget.
const PERMANENT_USAGE_QUOTA_PATTERNS = [
  // Explicit account / billing limits.
  /\bpersonal-team-blocked\b/i,
  /\bspending.?limit\b/i,
  /\bran\s+out\s+of\s+credits\b/i,
  /\bcoding plan package has expired\b/i,
  // Explicit "limit reached/exhausted" wording for a fixed billing window.
  /\b(?:monthly|weekly)\s+(?:usage\s+)?limit\s+(?:reached|exhausted)\b/i,
  // Explicit exhausted quota/usage (not a threshold).
  /\b(?:usage|quota)\s+(?:has been\s+)?(?:exhausted|depleted)\b/i,
  // Provider-specific permanent billing codes.
  /"1113"/,
  /"1308"/,
  /"1309"/,
  /"1310"/,
];

/** Accept only plausible HTTP status codes so an arbitrary numeric field
 *  (token counts, ports, retry numbers) is never mistaken for one. */
function asHttpStatus(value: unknown): number | undefined {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  ) {
    return value;
  }
  // Some SDKs surface the code as a numeric string ("429").
  if (typeof value === 'string' && /^\d{3}$/.test(value)) {
    const parsed = Number(value);
    if (parsed >= 100 && parsed <= 599) return parsed;
  }
  return undefined;
}

function nestedField(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined;
}

interface StatusCodeProbe {
  selected: number | undefined;
  candidates: Array<{ path: string; value: unknown }>;
}

/**
 * Locate a numeric HTTP status code across the provider/SDK/event shapes we
 * have seen, in priority order:
 *   statusCode → data.statusCode → cause.statusCode → status →
 *   response.status → response.statusCode → data.status →
 *   data.response.status → cause.status → cause.response.status
 * Only finite HTTP codes are accepted; everything else is ignored.
 */
function probeStatusCode(error: {
  statusCode?: unknown;
  status?: unknown;
  data?: unknown;
  cause?: unknown;
  response?: unknown;
}): StatusCodeProbe {
  const { data, cause, response } = error;
  const candidates: Array<{ path: string; value: unknown }> = [
    { path: 'statusCode', value: error.statusCode },
    { path: 'data.statusCode', value: nestedField(data, 'statusCode') },
    { path: 'cause.statusCode', value: nestedField(cause, 'statusCode') },
    { path: 'status', value: error.status },
    { path: 'response.status', value: nestedField(response, 'status') },
    { path: 'response.statusCode', value: nestedField(response, 'statusCode') },
    { path: 'data.status', value: nestedField(data, 'status') },
    {
      path: 'data.response.status',
      value: nestedField(nestedField(data, 'response'), 'status'),
    },
    { path: 'cause.status', value: nestedField(cause, 'status') },
    {
      path: 'cause.response.status',
      value: nestedField(nestedField(cause, 'response'), 'status'),
    },
  ];
  let selected: number | undefined;
  for (const candidate of candidates) {
    const status = asHttpStatus(candidate.value);
    if (status !== undefined) {
      selected = status;
      break;
    }
  }
  return { selected, candidates };
}

function extractStatusCode(error: {
  statusCode?: unknown;
  status?: unknown;
  data?: unknown;
  cause?: unknown;
  response?: unknown;
}): number | undefined {
  return probeStatusCode(error).selected;
}

function eventSessionID(props: {
  sessionID?: string;
  info?: { id?: string };
}): string | undefined {
  return props.sessionID ?? props.info?.id;
}

/**
 * Resolve the model a message was produced with. Assistant messages carry
 * `providerID`/`modelID` at the top level; the SDK's UserMessage nests them
 * under `info.model` (`{ providerID, modelID }`). Both shapes are supported so
 * a genuine user turn is recognised on real hosts.
 */
function messageModel(info: {
  providerID?: unknown;
  modelID?: unknown;
  model?: unknown;
}): string | undefined {
  if (typeof info.providerID === 'string' && typeof info.modelID === 'string') {
    return `${info.providerID}/${info.modelID}`;
  }
  const nested = info.model;
  if (
    isRecord(nested) &&
    typeof nested.providerID === 'string' &&
    typeof nested.modelID === 'string'
  ) {
    return `${nested.providerID}/${nested.modelID}`;
  }
  return undefined;
}

/** Message id for both shapes: v1 nests it under `info.id`; the v2 flat
 *  `session.messages()` shape carries a top-level `id`. */
function messageID(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const info = message.info;
  if (isRecord(info) && typeof info.id === 'string' && info.id) return info.id;
  if (typeof message.id === 'string' && message.id) return message.id;
  return undefined;
}

/** The internal-initiator marker survives the v2 text-only translation as the
 *  trailing comment appended by `createInternalAgentTextPart`. */
function hasInternalMarkerText(value: unknown): boolean {
  return (
    typeof value === 'string' && value.includes(SLIM_INTERNAL_INITIATOR_MARKER)
  );
}

export function isFailoverError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'string') {
    return (
      RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(error)) ||
      PROVIDER_OUTAGE_PATTERNS.some((pattern) => pattern.test(error)) ||
      TRANSPORT_MESSAGE_PATTERNS.some((pattern) => pattern.test(error))
    );
  }
  if (typeof error !== 'object') return false;
  const err = error as {
    code?: unknown;
    cause?: { code?: unknown; statusCode?: unknown; status?: unknown };
    message?: string;
    type?: unknown;
    statusCode?: unknown;
    status?: unknown;
    response?: { status?: unknown; statusCode?: unknown };
    data?: {
      code?: unknown;
      statusCode?: unknown;
      status?: unknown;
      message?: string;
      responseBody?: string;
      response?: { status?: unknown };
    };
  };

  const probe = probeStatusCode(err);
  const statusCode = probe.selected;

  const statusMatches =
    statusCode === 429 ||
    statusCode === 401 ||
    statusCode === 402 ||
    statusCode === 403 ||
    statusCode === 410 ||
    (statusCode !== undefined && OUTAGE_STATUS_CODES.has(statusCode)) ||
    (typeof err.type === 'string' && FAILOVER_ERROR_TYPES.has(err.type));

  const transportCodeMatches = [err.code, err.cause?.code, err.data?.code].some(
    (code) => typeof code === 'string' && TRANSPORT_CODES.has(code),
  );

  const messages = [
    err.message ?? '',
    err.data?.message ?? '',
    err.data?.responseBody ?? '',
  ];
  const transportMessageMatches = messages.some((message) =>
    TRANSPORT_MESSAGE_PATTERNS.some((p) => p.test(message)),
  );

  const text = messages.join(' ');
  // Providers sometimes return recoverable rate-limit/outage payloads with an
  // HTTP 400 wrapper: let a recognizable failover body continue, but keep
  // application-level 400 failures hard.
  const hasFailoverReason =
    RETRYABLE_ERROR_PATTERNS.some((p) => p.test(text)) ||
    PROVIDER_OUTAGE_PATTERNS.some((p) => p.test(text));

  const verdict =
    statusMatches ||
    transportCodeMatches ||
    transportMessageMatches ||
    hasFailoverReason;

  // Diagnostic: confirm the provider → SDK → event status-code path without
  // ever logging the response body or the user prompt.
  if (probe.selected !== undefined) {
    log('[foreground-fallback] failover status diagnosis', {
      direct: asHttpStatus(err.statusCode) ?? null,
      candidates: probe.candidates
        .filter((candidate) => candidate.value !== undefined)
        .map((candidate) => `${candidate.path}=${String(candidate.value)}`),
      selected: probe.selected,
      failover: verdict,
    });
  }

  return verdict;
}

function failoverErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!isRecord(error)) return '';
  const data = isRecord(error.data) ? error.data : undefined;
  return [
    typeof error.message === 'string' ? error.message : '',
    typeof data?.message === 'string' ? data.message : '',
    typeof data?.responseBody === 'string' ? data.responseBody : '',
  ].join(' ');
}

/**
 * Usage/quota errors should advance the chain immediately. A billing status
 * (402) is permanent even when the provider omits a descriptive message.
 */
function isPermanentUsageQuotaError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object' && error !== null) {
    const statusCode = extractStatusCode(
      error as {
        statusCode?: unknown;
        status?: unknown;
        data?: unknown;
        cause?: unknown;
        response?: unknown;
      },
    );
    if (statusCode === 402) return true;
  }
  const text = failoverErrorText(error);
  return PERMANENT_USAGE_QUOTA_PATTERNS.some((pattern) => pattern.test(text));
}

const INLINE_STATUS_CODES = new Set([401, 410]);

/**
 * True when the error is the kind the runtime surfaces inline (401 auth,
 * 410 model gone) — persistent, user-visible, already in the conversation.
 * These should NOT get a toast; the runtime's inline rendering is enough.
 * Other failover errors (429 rate-limit, outage, etc.) get a toast instead.
 */
export function isInlineFailoverError(error: unknown): boolean {
  if (!error) return false;
  // The AI SDK surfaces 401/410 as bare strings ("Gone",
  // "AI_APICallError: Gone"); match those directly so they stay inline too.
  if (typeof error === 'string') {
    return (
      /(?:^|\s)Gone(?:$|\s)/i.test(error) ||
      /\b401\b/i.test(error) ||
      /\b410\b/i.test(error) ||
      /\bend of life\b/i.test(error) ||
      /\bno longer available\b/i.test(error)
    );
  }
  if (typeof error !== 'object') return false;
  const err = error as {
    statusCode?: unknown;
    data?: { statusCode?: unknown; responseBody?: string; message?: string };
    message?: string;
  };
  const statusCode = extractStatusCode(err);
  if (statusCode !== undefined && INLINE_STATUS_CODES.has(statusCode)) {
    return true;
  }
  const text = [
    err.message ?? '',
    err.data?.message ?? '',
    err.data?.responseBody ?? '',
  ].join(' ');
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

/** Prevent re-triggering within this window for the same session. */
const DEDUP_WINDOW_MS = 5_000;
const REPROMPT_DELAY_MS = 500;
/** Ceiling on host calls: a hung transport must not stall fallback. */
const HOST_CALL_TIMEOUT_MS = 2_000;
/** Late replay user event identity lifetime. */
const REPLAY_IDENTITY_WINDOW_MS = 30_000;
/** Transcript tail size for the fallback replay read: the replay only needs
 *  the last replayable user message plus the trailing message id (handoff
 *  baseline), never the full history. */
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

/**
 * Manages runtime model fallback for foreground agent sessions.
 *
 * Constructed at plugin init with the ordered fallback chains for each agent
 * (built from _modelArray entries in agents.<name>.model).
 */
export class ForegroundFallbackManager {
  /** sessionID → last observed model string ("providerID/modelID") */
  private readonly sessionModel = new Map<string, string>();
  /** sessionID → agent name (populated from message.updated info.agent field) */
  private readonly sessionAgent = new Map<string, string>();
  /** child sessionID → parent sessionID (from session.created info).
   *  Lets the fallback abort path promote a foreground task() waiter to
   *  background first, so the waiting tool resolves via backgroundResult
   *  instead of "Task cancelled" while the child continues on fallback. */
  private readonly sessionParent = new Map<string, string>();
  /** sessionID → set of models already attempted this session */
  private readonly sessionTried = new Map<string, Set<string>>();
  /** Process-local sessions with an active fallback switch in flight. */
  private readonly inProgress = getProcessFallbacksInProgress();
  /** sessionID → timestamp of last trigger (for deduplication) */
  private readonly lastTrigger = new Map<string, number>();
  /** sessionID → model in use when lastTrigger was set; dedup is bypassed
   *  when the model has changed, allowing the cascade to continue when a
   *  new fallback model also fails within the dedup window. */
  private readonly lastTriggerModel = new Map<string, string>();
  /** sessionID -> accumulated retryable-error count for this session's
   *  current fallback descent. The budget is shared ACROSS the whole
   *  fallback chain: it is NOT reset on model swap. Cleared only on a
   *  completed successful assistant response, session deletion, or a
   *  fresh user-turn descent (see execFallback's reset branch). */
  private readonly sessionRetries = new Map<string, number>();
  /** Sessions whose initial-delay fallback trigger has already been
   *  scheduled (initialRetryDelayMs applies to the first trigger only).
   *  Cleared alongside sessionRetries. */
  private readonly initialDelayScheduled = new Set<string>();
  /** sessionID -> pending initial delay timeout handle.
   *  Cleared on recovery or session deletion. */
  private readonly pendingInitialDelay = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** sessionID -> timestamp of last fallback attempt.
   *  Used to enforce retryDelayMs between consecutive attempts. */
  private readonly lastFallbackTime = new Map<string, number>();
  /** sessionID → chain-exhaustion stage:
   *   0 = not exhausted; 1 = chain exhausted once, reset to sticky fallback
   *   (one retry chance); 2 = exhausted again, aborted — stop intervening.
   *   Reset to 0 on successful responses or session deletion. */
  private readonly chainExhaustion = new Map<string, number>();
  /** sessionID → incident-key → timestamp. Dedup is identity-based: only a
   *  stable incident id (message id / request id) or a session.status retry
   *  episode+attempt collapses duplicate notifications. Error text and a raw
   *  time window are deliberately NOT used — identical text on the same model
   *  can be the next real failure. */
  private readonly lastTriggerMap = new Map<string, Map<string, number>>();
  /** sessionID → current session.status retry episode. A higher attempt
   *  advances the same episode; a repeated/out-of-order attempt already seen
   *  in the episode is deduped; a model change starts a new episode. */
  private readonly retryEpisode = new Map<
    string,
    {
      model: string | undefined;
      attempt: number;
      id: number;
      seen: Set<number>;
    }
  >();
  private retryEpisodeSeq = 0;
  /** sessionID → identity of a just-issued internal replay. The host may emit
   *  the replay's own user message after promptAsync returned (inProgress
   *  already cleared); this lets us recognise it and NOT treat it as a real
   *  new user turn. Cleared on success, failure, session deletion, dispose or
   *  message-id confirmation. */
  private readonly pendingReplay = new Map<
    string,
    {
      targetModel: string;
      baselineMessageID: string | undefined;
      startedAt: number;
      admitted: boolean;
    }
  >();
  /** sessionID → user message ids positively confirmed as our own internal
   *  replay. A late or repeated host notification for one of these must never
   *  reset the retry budget, even after `pendingReplay` is cleared and even
   *  across later replays or external turns. Kept for the session's lifetime
   *  (only ids confirmed from the transcript are retained, so the set grows
   *  with the session's replay count) and cleared on session deletion/dispose. */
  private readonly replayMessageIds = new Map<string, Set<string>>();
  /** sessionID → set once the v2 in-place retry hook exhausted a chain on a
   *  permanent quota/billing error. Later retry-hook calls on that terminal
   *  session answer `{ retry: false }` until a genuine new user turn returns
   *  to the configured primary (or the session is deleted/disposed). */
  private readonly v2RetryTerminal = new Set<string>();
  /** sessionID → turn epoch, bumped whenever a confirmed external user turn
   *  resets the session. An in-flight replay captures the epoch and refuses to
   *  write model/switch state (or restore old state) once a newer turn began. */
  private readonly turnEpoch = new Map<string, number>();
  /** Monotonic sequence over all user-turn handling (across sessions). Versions
   *  user-turn handling so an older probe that resolves late cannot roll back a
   *  newer turn that already applied. */
  private userTurnSeq = 0;
  /** sessionID → sequence of the newest confirmed-external user turn whose
   *  handling has been applied. A late handler carrying a smaller sequence is
   *  dropped. Cleared on session deletion/dispose. */
  private readonly userTurnLatest = new Map<string, number>();
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
  private readonly backgroundFallbackHandoff?: {
    prepare: (
      sessionID: string,
      preparedGeneration: number | undefined,
      baselineMessageID: string | undefined,
    ) => boolean;
    admit: (sessionID: string, preparedGeneration: number | undefined) => void;
    reject: (sessionID: string, preparedGeneration: number | undefined) => void;
    settleUnresolved: (
      sessionID: string,
      preparedGeneration: number | undefined,
    ) => void;
  };
  /** Synchronous board read returning the tracked generation for a
   *  confirmed BACKGROUND child only — undefined for foreground or
   *  unmanaged sessions (that undefined means "handoff not
   *  applicable", never a wildcard). Captured before ANY await in the
   *  fallback preparation. */
  private readonly readBackgroundGeneration?: (
    sessionID: string,
  ) => number | undefined;

  /** Exposed for task-session-manager: prevents idle reconciliation
   *  while a fallback abort/re-prompt is in flight for this session. */
  isFallbackInProgress(sessionID: string): boolean {
    return this.inProgress.has(sessionID);
  }

  /**
   * True when this manager could still recover the session via fallback:
   * fallback is enabled, the session has a chain, and the chain is not
   * exhausted (stage < 2). Consumers (task-session-manager event router)
   * defer terminal bookkeeping for persistent 401/410 errors until
   * recovery is actually impossible.
   */
  willAttemptFallback(sessionID: string): boolean {
    if (!this.enabled) return false;
    if (this.inProgress.has(sessionID)) return true;
    return (
      this.hasFallbackChain(sessionID) &&
      (this.chainExhaustion.get(sessionID) ?? 0) < 2
    );
  }

  /**
   * Disable the fallback chain for a specific agent.
   * After calling this, rate-limit errors for that agent surface instead of
   * silently falling back through the chain.
   */
  disableChain(agentName: string): void {
    // Keep the key present (known agent, no chain) rather than deleting it,
    // so resolveChain's "known agent without a chain" path applies and the
    // shared runtimeChains reference retains the agent entry.
    this.chains[agentName] = [];
  }

  registerSessionAgent(sessionID: string, agentName: string): void {
    const normalizedAgentName = agentName.trim();
    if (
      !sessionID ||
      !normalizedAgentName ||
      this.sessionAgent.has(sessionID)
    ) {
      return;
    }
    this.sessionAgent.set(sessionID, normalizedAgentName);
  }

  /** Plugin dispose: cancel scheduled initial-delay timers and fence off
   *  in-flight fallback chains. `opencode reload` destroys this instance
   *  mid-attempt — pending timers are cancelled here, and suspension
   *  points inside tryFallback/tryFallbackWithAbort/execFallback abandon
   *  their continuation (see abandonedByDispose) so no replay, abort, or
   *  transcript read runs through the destroyed generation's client. */
  dispose(): void {
    this.disposed = true;
    for (const handle of this.pendingInitialDelay.values()) {
      clearTimeout(handle);
    }
    this.pendingInitialDelay.clear();
    this.pendingReplay.clear();
    this.replayMessageIds.clear();
    this.v2RetryTerminal.clear();
    this.turnEpoch.clear();
    this.userTurnLatest.clear();
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
     * The first model that hasn't been tried yet is selected on each fallback.
     */
    private chains: Record<string, string[]>,
    private readonly enabled: boolean,
    private readonly input: PluginInput,
    /** Retryable errors absorbed (errors 1..maxRetries) before the fallback
     *  chain advances; the budget accumulates across the whole chain. */
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
    backgroundFallbackHandoff?: {
      prepare: (
        sessionID: string,
        preparedGeneration: number | undefined,
        baselineMessageID: string | undefined,
      ) => boolean;
      admit: (
        sessionID: string,
        preparedGeneration: number | undefined,
      ) => void;
      reject: (
        sessionID: string,
        preparedGeneration: number | undefined,
      ) => void;
      settleUnresolved: (
        sessionID: string,
        preparedGeneration: number | undefined,
      ) => void;
    },
    /** Synchronous board read returning the tracked generation for a
     *  confirmed BACKGROUND child only (undefined = foreground or
     *  unmanaged — the handoff is not applicable, never a wildcard).
     *  Captured before ANY await in the fallback preparation. */
    readBackgroundGeneration?: (sessionID: string) => number | undefined,
    /** Synchronous check for running background children OF this session. */
    private readonly hasRunningChildren?: (sessionID: string) => boolean,
  ) {
    this.onSessionModelChanged = onSessionModelChanged;
    this.backgroundFallbackHandoff = backgroundFallbackHandoff;
    this.readBackgroundGeneration = readBackgroundGeneration;
    if (coordinator) {
      coordinator.onSessionDeleted((id) => {
        this.sessionModel.delete(id);
        this.sessionAgent.delete(id);
        this.sessionTried.delete(id);
        // NOTE: inProgress is intentionally NOT cleared here —
        // the finally blocks in tryFallback() and tryFallbackWithAbort()
        // manage inProgress lifecycle. Clearing it here would make
        // isFallbackInProgress() return false during the abort/re-prompt
        // cycle, letting the task-session-manager treat the abort idle
        // as a real completion and report a background task as cancelled.
        this.lastTrigger.delete(id);
        this.lastTriggerModel.delete(id);
        this.sessionRetries.delete(id);
        this.initialDelayScheduled.delete(id);
        this.chainExhaustion.delete(id);
        this.lastFallbackTime.delete(id);
        // Cancel any pending initial delay
        const pendingDelay = this.pendingInitialDelay.get(id);
        if (pendingDelay) {
          clearTimeout(pendingDelay);
          this.pendingInitialDelay.delete(id);
        }
      });
    }
  }

  /**
   * Process an OpenCode plugin event.
   * Call this from the plugin's `event` hook for every event received.
   */
  async handleEvent(rawEvent: unknown): Promise<void> {
    if (!this.enabled) return;
    const event = rawEvent as { type: string; properties?: unknown };
    if (!event?.type) return;

    switch (event.type) {
      case 'message.updated': {
        const info = (
          event.properties as { info?: Record<string, unknown> } | undefined
        )?.info;
        if (!info) break;
        const sessionID = info.sessionID as string | undefined;
        if (!sessionID) break;
        // Capture agent name when available (OpenCode includes it on subagent messages)
        if (typeof info.agent === 'string') {
          this.registerSessionAgent(sessionID, info.agent);
        }
        // Track the model currently serving this session. Assistant messages
        // carry providerID/modelID at the top level; user messages (the SDK
        // UserMessage shape) nest them under info.model.
        const observedModel = messageModel(info);
        const messageId =
          typeof info.id === 'string' && info.id ? info.id : undefined;
        if (info.role === 'user') {
          // A user message is either our own internal replay or a real new
          // turn. Decide identity BEFORE writing any state: a late replay
          // notification must not overwrite the active model or reset the
          // descent. `handleUserTurn` performs the model write/reset only for a
          // confirmed external turn.
          await this.handleUserTurn(sessionID, messageId, observedModel);
        } else if (observedModel !== undefined) {
          this.sessionModel.set(sessionID, observedModel);
        }
        const messageTime = info.time;
        const isCompletedSuccessfulAssistant =
          info.role === 'assistant' &&
          !info.error &&
          typeof messageTime === 'object' &&
          messageTime !== null &&
          'completed' in messageTime &&
          typeof messageTime.completed === 'number';
        // Failover-worthy error on an individual message
        if (info.error && isFailoverError(info.error)) {
          // Concurrency guard before any budget charge: a second event that
          // arrives while a fallback/retry is already in flight must not
          // consume a budget slot and then be dropped by the in-progress guard.
          if (!this.isExhausted(sessionID) && !this.inProgress.has(sessionID)) {
            // Duplicate `message.updated` notifications for the same message
            // share the message id; a new message is a new incident.
            const incidentId =
              typeof info.id === 'string' && info.id ? info.id : undefined;
            if (!this.isTerminalIncidentDeduped(sessionID, incidentId)) {
              const d = this.decideIntervention(sessionID, false, info.error);
              if (d === 'absorb') {
                await this.retryCurrentModel(sessionID, info.error);
              } else if (d === 'fallback') {
                await this.tryFallback(sessionID, info.error);
              }
              // fallback-delayed → nothing
            }
          }
        } else if (isCompletedSuccessfulAssistant) {
          // Only a completed, successful assistant response proves recovery.
          this.sessionRetries.delete(sessionID);
          this.initialDelayScheduled.delete(sessionID);
          this.chainExhaustion.delete(sessionID);
          // Keep the v2 terminal decision in lock-step with stage 2: a
          // recovered session must not keep answering `{ retry: false }`.
          this.v2RetryTerminal.delete(sessionID);
          this.lastFallbackTime.delete(sessionID);
          // A success also ends any failure streak, so the models the
          // streak marked tried are no longer proven dead. Static-chain
          // agents already get this from the re-arm reset (a new turn
          // re-sends the configured primary); combined inherit+chain
          // agents re-send their live session model, which never equals
          // the configured head, so without this reset their tried set
          // only grows across turns and each new descent starts one link
          // deeper.
          this.sessionTried.delete(sessionID);
          this.retryEpisode.delete(sessionID);
          // Cancel any pending initial delay on recovery
          const pendingDelay = this.pendingInitialDelay.get(sessionID);
          if (pendingDelay) {
            clearTimeout(pendingDelay);
            this.pendingInitialDelay.delete(sessionID);
          }
        }
        break;
      }

      case 'session.error': {
        const props = event.properties as
          | { sessionID?: string; info?: { id?: string }; error?: unknown }
          | undefined;
        if (!props) break;
        const sessionID = eventSessionID(props);
        if (sessionID && props.error && isFailoverError(props.error)) {
          if (!this.isExhausted(sessionID) && !this.inProgress.has(sessionID)) {
            // No correlatable id -> never dedupe (identical text may be the
            // next real failure).
            const incidentId = this.stableEventIncidentId(props);
            if (!this.isTerminalIncidentDeduped(sessionID, incidentId)) {
              const d = this.decideIntervention(sessionID, false, props.error);
              if (d === 'absorb') {
                await this.retryCurrentModel(sessionID, props.error);
              } else if (d === 'fallback') {
                await this.tryFallback(sessionID, props.error);
              }
              // fallback-delayed → nothing
            }
          }
        }
        break;
      }

      case 'session.status': {
        const props = event.properties as
          | {
              sessionID?: string;
              info?: { id?: string };
              status?: { type?: string; message?: string; attempt?: number };
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
        if (isFailoverRetry) {
          const retryError =
            props.error && isFailoverError(props.error)
              ? props.error
              : { message: props.status?.message ?? '' };
          // Guard: stale retry event from a previous model's retry loop.
          // After a fallback, lastTriggerModel holds the OLD model (anchored
          // by isHostRetryDeduped before the fallback), while sessionModel
          // holds the NEW model. A stale retry from the old model arrives with
          // attempt > 1 (continuation of old retry loop). A genuine retry from
          // the new model arrives with attempt === 1 (first retry for new
          // model).
          const prevModel = this.lastTriggerModel.get(sessionID);
          const curModel = this.sessionModel.get(sessionID);
          const lastTriggerTime = this.lastTrigger.get(sessionID) ?? 0;
          const attempt = props.status?.attempt ?? 1;
          const modelChanged =
            prevModel !== undefined &&
            curModel !== undefined &&
            prevModel !== curModel;
          const withinDedupWindow =
            Date.now() - lastTriggerTime < DEDUP_WINDOW_MS;
          if (modelChanged && withinDedupWindow && attempt > 1) {
            // Model changed since last trigger, within dedup window, and
            // attempt > 1: this is a stale retry from the old model's
            // retry loop (continuation of previous attempts). Skip it.
            break;
          }
          // Otherwise (attempt === 1, or model didn't change, or outside
          // dedup window): process as genuine retry for current model.
          if (this.isExhausted(sessionID)) break;
          if (this.inProgress.has(sessionID)) break;
          if (this.isHostRetryDeduped(sessionID, attempt)) break;
          const d = this.decideIntervention(sessionID, true, retryError);
          if (d === 'fallback') {
            // Failover may have been detected from status.message (e.g.
            // 'AI_APICallError: Gone') with no separate error property;
            // forward that message so 401/410 inline errors suppress the
            // toast on this path too, matching session.error behavior.
            await this.tryFallbackWithAbort(sessionID, retryError);
          }
          // absorb/fallback-delayed → no-op
          break;
        }

        // Note: do NOT clear sessionRetries here on non-rate-limit statuses.
        // Abort events triggered by our own fallback carry non-rate-limit
        // messages and would reset the counter, creating an infinite loop:
        // abort → absorbed error → abort event clears retries → the budget
        // refills → repeat. Retries are only cleared on a completed
        // successful assistant response, session deletion, or the explicit
        // fresh-descent reset inside execFallback.
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
          // Clear every session-level map directly too: exhausted state and
          // dedup episodes must never leak into a reused session id.
          this.sessionModel.delete(id);
          this.sessionAgent.delete(id);
          this.sessionTried.delete(id);
          this.lastTrigger.delete(id);
          this.lastTriggerModel.delete(id);
          this.lastTriggerMap.delete(id);
          this.retryEpisode.delete(id);
          this.sessionRetries.delete(id);
          this.initialDelayScheduled.delete(id);
          this.chainExhaustion.delete(id);
          this.lastFallbackTime.delete(id);
          const pendingDelay = this.pendingInitialDelay.get(id);
          if (pendingDelay) {
            clearTimeout(pendingDelay);
            this.pendingInitialDelay.delete(id);
          }
          this.pendingReplay.delete(id);
          this.replayMessageIds.delete(id);
          this.v2RetryTerminal.delete(id);
          this.turnEpoch.delete(id);
          this.userTurnLatest.delete(id);
        }
        break;
      }
    }
  }

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
    let entryEpoch = 0;
    const from = `${event.model.providerID}/${event.model.id}`;
    try {
      const { sessionID } = event;
      if (!this.enabled || this.disposed || this.inProgress.has(sessionID))
        return;
      // Capture the turn epoch of the retry-hook ENTRY, before any await (the
      // model switch below): a genuine new user turn that starts while the
      // switch is in flight must supersede this hook, which then must not write
      // the old target back into the new turn.
      entryEpoch = this.turnEpoch.get(sessionID) ?? 0;
      // Terminal once the chain is spent — ordinary or permanent quota: the
      // host must not keep retrying a session the fallback manager considers
      // exhausted. Cleared by a completed success, a primary-model new turn,
      // session deletion or dispose (kept in lock-step with stage 2).
      if (this.isExhausted(sessionID) || this.v2RetryTerminal.has(sessionID)) {
        event.decision = { retry: false };
        return;
      }
      if (!isFailoverError(event.error)) return;
      if (
        this.initialRetryDelayMs > 0 &&
        !isPermanentUsageQuotaError(event.error)
      ) {
        log('[foreground-fallback] retry hook skipped initial delay', {
          sessionID,
        });
        return;
      }
      if (
        this.sessionTried.get(sessionID)?.has(from) &&
        this.sessionModel.get(sessionID) !== from
      )
        return;
      if (event.agent) this.registerSessionAgent(sessionID, event.agent);
      this.sessionModel.set(sessionID, from);
      if (!this.hasFallbackChain(sessionID)) return;
      if (
        !isPermanentUsageQuotaError(event.error) &&
        !this.consumeRetryBudget(sessionID)
      )
        return;
      const selected = this.selectFallbackModel(sessionID, event.error);
      if (!selected) return;
      if (selected === 'exhausted') {
        // The chain reached stage 2 (ordinary or permanent): terminal for this
        // session — tell the host not to retry and keep answering that way. A
        // first ordinary exhaustion already took the sticky re-fallback via
        // `selectFallbackModel` above; only the second lands here.
        this.v2RetryTerminal.add(sessionID);
        event.decision = { retry: false };
        log(
          '[foreground-fallback] v2 retry hook terminal: retry budget exhausted',
          { sessionID },
        );
        return;
      }
      const { agentName, nextModel, ref } = selected;
      picked = nextModel;
      switchRequest = switchModel(sessionID, {
        providerID: ref.providerID,
        id: ref.modelID,
      });
      await withTimeout(
        switchRequest,
        HOST_CALL_TIMEOUT_MS,
        'foreground retry model switch timed out',
      );
      if (
        this.disposed ||
        (this.turnEpoch.get(sessionID) ?? 0) !== entryEpoch
      ) {
        // A newer turn now owns the session (or this generation was disposed):
        // leave the host decision untouched so it retries the CURRENT turn,
        // and do not write the stale target, notify, toast or log a switch.
        this.logSupersededFallback(sessionID);
        return;
      }
      event.decision = { retry: true, delay: this.retryDelayMs };
      this.sessionModel.set(sessionID, nextModel);
      this.onSessionModelChanged?.(sessionID, nextModel);
      this.showFallbackToast(agentName, nextModel, event.error);
      log('[foreground-fallback] retry hook switched model in place', {
        sessionID,
        from,
        to: nextModel,
      });
    } catch (err) {
      // Unconfirmed switch: keep the target selectable (a timed-out switch
      // may still land; the next event's model is the host truth). Only roll
      // the target back off `sessionTried` while this hook still owns the
      // turn: after a newer turn, the tried state belongs to that turn and
      // must not be mutated.
      if (picked && (this.turnEpoch.get(event.sessionID) ?? 0) === entryEpoch) {
        this.sessionTried.get(event.sessionID)?.delete(picked);
      }
      const pendingSwitch = switchRequest;
      if (err instanceof OperationTimeoutError && picked && pendingSwitch) {
        // Late landing: the timeout cannot cancel the host call. If it
        // settles after we gave up, reconcile only when nothing advanced
        // the model since — the check and the write run synchronously, so
        // a hook that already moved on fails closed instead of being
        // overwritten. A newer turn (even one that returned to the same
        // model) bumps the epoch, so the epoch check also fences it. No
        // toast here: the next event's success path notifies; this only
        // repairs state.
        const target = picked;
        void pendingSwitch.then(
          () => {
            if (
              this.disposed ||
              this.sessionModel.get(event.sessionID) !== from ||
              (this.turnEpoch.get(event.sessionID) ?? 0) !== entryEpoch
            )
              return;
            this.sessionModel.set(event.sessionID, target);
            this.onSessionModelChanged?.(event.sessionID, target);
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

  /** Increment the accumulated retry count and return true once the budget
   *  is spent. Semantics of maxRetries: errors 1..maxRetries are absorbed on
   *  the current model; error maxRetries+1 — and every error after it —
   *  triggers the fallback. On exhaustion the count is deliberately NOT
   *  cleared: the budget stays spent so subsequent errors keep triggering
   *  the chain descent instead of re-absorbing on each new model. */
  private consumeRetryBudget(sessionID: string): boolean {
    const tried = this.sessionRetries.get(sessionID) ?? 0;
    if (tried < this.maxRetries) {
      this.sessionRetries.set(sessionID, tried + 1);
      log('[foreground-fallback] retry budget', {
        sessionID,
        tried: tried + 1,
        maxRetries: this.maxRetries,
        verdict: 'absorbed',
      });
      return false;
    }
    log('[foreground-fallback] retry budget', {
      sessionID,
      tried,
      maxRetries: this.maxRetries,
      verdict: 'fallback-triggered',
    });
    return true;
  }

  /** Intervention decision types for retry budget semantics. */
  private decideIntervention(
    sessionID: string,
    needsAbort = false,
    error?: unknown,
  ): 'absorb' | 'fallback' | 'fallback-delayed' {
    const permanentUsageQuota = isPermanentUsageQuotaError(error);
    if (!permanentUsageQuota && !this.consumeRetryBudget(sessionID)) {
      return 'absorb';
    }
    if (permanentUsageQuota) {
      log('[foreground-fallback] permanent usage/quota failure', {
        sessionID,
        needsAbort,
      });
      // A confirmed permanent quota/billing failure must advance the chain
      // immediately: initialRetryDelayMs exists to give intercepting plugins
      // time to recover a transient fault, never a permanent one.
      return 'fallback';
    }
    if (this.initialRetryDelayMs > 0) {
      if (this.pendingInitialDelay.has(sessionID)) {
        // A delayed trigger is already pending and will fire soon;
        // errors arriving meanwhile must not jump the queue.
        return 'fallback-delayed';
      }
      if (!this.initialDelayScheduled.has(sessionID)) {
        this.initialDelayScheduled.add(sessionID);
        log('[foreground-fallback] delaying initial fallback', {
          sessionID,
          delayMs: this.initialRetryDelayMs,
          needsAbort,
        });
        const handle = setTimeout(() => {
          this.pendingInitialDelay.delete(sessionID);
          // Background fallback is fail-soft: a failure must be logged
          // and swallowed, never escape as an unhandled rejection.
          // Call tryFallbackWithAbort for session.status retry path
          const trigger = needsAbort
            ? this.tryFallbackWithAbort(sessionID, error)
            : this.tryFallback(sessionID, error);
          void trigger.catch((err) => {
            log('[foreground-fallback] delayed fallback trigger failed', {
              sessionID,
              error: stringifyError(err),
            });
          });
        }, this.initialRetryDelayMs);
        this.pendingInitialDelay.set(sessionID, handle);
        return 'fallback-delayed';
      }
    }
    return 'fallback';
  }

  // ---------------------------------------------------------------------------
  // Core fallback logic
  // ---------------------------------------------------------------------------

  /** Deterministic supersession notice for a fallback entry point whose turn
   *  epoch was superseded by a newer user turn: sessionID only (no timestamps
   *  or per-call ids). Shared by the promotion/abort/backoff/replay fences. */
  private logSupersededFallback(sessionID: string): void {
    log(
      '[foreground-fallback] fallback superseded by a newer turn; fallback aborted',
      { sessionID },
    );
  }

  private async tryFallback(sessionID: string, error?: unknown): Promise<void> {
    if (!sessionID) return;
    // Reload fence at entry, before any state mutation: a trigger racing
    // dispose() must not start a new chain through the dead context.
    if (this.abandonedByDispose(sessionID)) return;
    if (this.inProgress.has(sessionID)) return;
    // No chain -> no fallback. Skip before dedup so we don't stamp lastTrigger
    // for sessions we will never re-prompt (e.g. councillor via CouncilManager).
    if (!this.hasFallbackChain(sessionID)) return;
    // Terminal stage-2 exhaustion: never intervene again for this session.
    // Dedup happens upstream; do not rely on it to prevent a repeat abort.
    if (this.isExhausted(sessionID)) return;

    // Capture the turn epoch of the fallback ENTRY: a genuine new user turn
    // that starts during the backoff below must supersede this attempt so we
    // do not switch the new turn's model or replay the stale request.
    const entryEpoch = this.turnEpoch.get(sessionID) ?? 0;

    // Set inProgress before delay to prevent concurrent fallback attempts
    this.inProgress.add(sessionID);
    try {
      // Delay between consecutive fallback attempts (except for the initial trigger
      // which uses initialRetryDelayMs in shouldTriggerFallback).
      const lastFallback = this.lastFallbackTime.get(sessionID);
      if (lastFallback && this.retryDelayMs > 0) {
        const elapsed = Date.now() - lastFallback;
        if (elapsed < this.retryDelayMs) {
          const delay = this.retryDelayMs - elapsed;
          log('[foreground-fallback] delaying retry fallback', {
            sessionID,
            delayMs: delay,
            elapsed,
          });
          await new Promise((r) => setTimeout(r, delay));
          // The backoff slept through a dispose(): execFallback would
          // read the transcript and re-prompt through the destroyed
          // generation's client. The finally below still releases the
          // process-global inProgress slot.
          if (this.abandonedByDispose(sessionID)) return;
        }
      }
      // The backoff may also have slept through a genuine new user turn: its
      // epoch bump fences this attempt's continuation.
      if ((this.turnEpoch.get(sessionID) ?? 0) !== entryEpoch) {
        this.logSupersededFallback(sessionID);
        return;
      }

      await this.execFallback(sessionID, error, entryEpoch);
      // Record the backoff anchor only when this attempt still belongs to the
      // current turn. A superseded attempt (new user turn started while
      // execFallback was suspended) sends no request and must not delay the
      // new turn's next fallback with an inherited retryDelayMs sleep.
      if (
        !this.abandonedByDispose(sessionID) &&
        (this.turnEpoch.get(sessionID) ?? 0) === entryEpoch
      ) {
        this.lastFallbackTime.set(sessionID, Date.now());
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
   * When no chain is available, do nothing (no abort, no log). Aborting
   * without a replacement model only races owners that manage their own
   * lifecycle (e.g. CouncilManager for councillor) and produces noise.
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
  ): Promise<void> {
    if (!sessionID) return;
    // Reload fence at entry (same rationale as tryFallback).
    if (this.abandonedByDispose(sessionID)) return;
    if (this.inProgress.has(sessionID)) return;
    if (!this.hasFallbackChain(sessionID)) return;
    if (this.withholdsAbortForLiveChildren(sessionID)) return;
    if (this.isExhausted(sessionID)) return;

    // Capture the turn epoch of the fallback ENTRY: a genuine new user turn
    // that starts during the promotion or abort below must supersede this
    // attempt so we never abort the new turn or replay the stale request.
    const entryEpoch = this.turnEpoch.get(sessionID) ?? 0;

    this.inProgress.add(sessionID);
    try {
      await this.promoteForegroundWaiter(sessionID);
      // Promotion awaited: a reload may have disposed this generation in
      // the meantime — never abort through a stale client.
      if (this.abandonedByDispose(sessionID)) return;
      if (this.withholdsAbortForLiveChildren(sessionID)) return;
      if ((this.turnEpoch.get(sessionID) ?? 0) !== entryEpoch) {
        this.logSupersededFallback(sessionID);
        return;
      }
      await abortSessionWithTimeout(getClient(this.input), sessionID);
      // The abort suspended across a dispose(): its outcome no longer
      // matters to the reloaded generation — do not continue into
      // execFallback (transcript read + replay on the dead client).
      // The finally below still releases the process-global slot.
      if (this.abandonedByDispose(sessionID)) return;
      // The abort also suspended across a genuine new user turn: do not run
      // execFallback against the turn that now owns the session.
      if ((this.turnEpoch.get(sessionID) ?? 0) !== entryEpoch) {
        this.logSupersededFallback(sessionID);
        return;
      }
      await this.execFallback(sessionID, error, entryEpoch);
    } finally {
      this.inProgress.delete(sessionID);
    }
  }

  /** True once the chain has been finally exhausted and aborted. */
  private isExhausted(sessionID: string): boolean {
    return (this.chainExhaustion.get(sessionID) ?? 0) >= 2;
  }

  /** Decide whether a user message is a real external turn. Our own fallback
   *  replay re-sends the user parts with an internal-initiator marker and the
   *  host may emit that message after promptAsync returned; such an event must
   *  not reset the descent. */
  private async handleUserTurn(
    sessionID: string,
    messageId: string | undefined,
    model: string | undefined,
  ): Promise<void> {
    // Nothing is written until the message is confirmed to be a real external
    // turn: a late internal replay notification must not overwrite the active
    // model or reset the descent.
    //
    // Sequence the handling so an older probe that resolves late cannot roll
    // back a newer turn that already applied (e.g. A's probe hangs, C's
    // completes and resets, then A returns). Internal replays never claim the
    // slot. Newest confirmed-external handling wins regardless of order.
    const seq = ++this.userTurnSeq;
    if (await this.isInternalReplayUserMessage(sessionID, messageId)) return;
    if ((this.userTurnLatest.get(sessionID) ?? 0) > seq) return;
    this.userTurnLatest.set(sessionID, seq);
    if (model !== undefined) {
      this.sessionModel.set(sessionID, model);
    }
    this.freshTurnResetHandler(sessionID, model);
  }

  /** Whether a user message is our own internal replay rather than a real new
   *  turn. Retention/identity is checked before anything else so a late replay
   *  event cannot clobber the current model or reset the budget. */
  private async isInternalReplayUserMessage(
    sessionID: string,
    messageId: string | undefined,
  ): Promise<boolean> {
    // A message id already confirmed as our own replay stays internal for the
    // session: late or repeated notifications must not reset the budget.
    if (
      messageId !== undefined &&
      this.replayMessageIds.get(sessionID)?.has(messageId)
    ) {
      return true;
    }

    const inFlight = this.inProgress.has(sessionID);
    if (messageId === undefined) {
      // No identity to check: only an in-flight replay can explain it.
      return inFlight;
    }

    const pending = this.pendingReplay.get(sessionID);
    const pendingUsable =
      pending !== undefined &&
      Date.now() - pending.startedAt <= REPLAY_IDENTITY_WINDOW_MS;

    if (pendingUsable && pending && messageId === pending.baselineMessageID) {
      // Re-emission of a message we already knew about — not a new turn.
      return true;
    }

    // ALWAYS probe the transcript: a late replay notification can arrive after
    // its pending record was superseded by a new turn, and with nothing in
    // flight there is no other signal that would keep it from being misread as
    // an external turn (which would overwrite the model and reset the budget).
    const identity = await this.probeReplayMessageIdentity(
      sessionID,
      messageId,
    );

    if (identity === 'internal') {
      this.rememberReplayMessageId(sessionID, messageId);
      // The confirmed id now carries the internal identity; release the
      // unconfirmed pending record (only when a newer replay has not already
      // replaced it). Later still-unpersisted notifications are covered by
      // the retained-record branch below.
      if (
        pendingUsable &&
        pending &&
        this.pendingReplay.get(sessionID) === pending
      ) {
        this.pendingReplay.delete(sessionID);
      }
      return true;
    }
    if (identity === 'external') {
      // Present in the transcript without the marker: a real new turn, even
      // while our own replay is still in flight. The pending record is
      // deliberately retained so a late replay notification stays
      // recognisable (freshTurnResetHandler also retains it).
      return false;
    }
    // Unknown (not persisted yet): we cannot exclude our own replay, so treat
    // it as internal while a replay is in flight OR an unconfirmed record is
    // still retained. Only then is it safe to call the message a real turn.
    return inFlight || pendingUsable;
  }

  /** Retain a user message id confirmed as our own internal replay. */
  private rememberReplayMessageId(sessionID: string, messageId: string): void {
    let ids = this.replayMessageIds.get(sessionID);
    if (!ids) {
      ids = new Set<string>();
      this.replayMessageIds.set(sessionID, ids);
    }
    ids.add(messageId);
  }

  /** Classify a user message by its transcript identity:
   *   - `'internal'`  — carries the internal-initiator marker we attach to
   *     fallback replays;
   *   - `'external'`  — present in the transcript without the marker;
   *   - `'unknown'`   — not found yet (the host may not have persisted it).
   *  Reads only the transcript tail. */
  private async probeReplayMessageIdentity(
    sessionID: string,
    messageId: string,
  ): Promise<'internal' | 'external' | 'unknown'> {
    try {
      const session = getClient(this.input).session;
      const result = await session.messages({
        path: { id: sessionID },
        query: { limit: FALLBACK_REPLAY_TAIL_MESSAGES },
      });
      const messages = (result.data ?? []) as unknown[];
      const target = [...messages]
        .reverse()
        .find((m) => messageID(m) === messageId);
      if (!isRecord(target)) return 'unknown';

      // v1: part-level synthetic metadata (or a text part carrying the marker).
      if (Array.isArray(target.parts)) {
        const parts = target.parts;
        if (
          parts.some(
            (part) =>
              isInternalInitiatorPart(part) ||
              (isRecord(part) && hasInternalMarkerText(part.text)),
          )
        ) {
          return 'internal';
        }
      }
      // v2 flat shape: the marker survives as joined text (the shim appends
      // the marker comment to the part text) and/or message-level metadata.
      if (hasInternalMarkerText(target.text)) return 'internal';
      if (
        isRecord(target.metadata) &&
        target.metadata[INTERNAL_INITIATOR_METADATA_KEY] === true
      ) {
        return 'internal';
      }
      return 'external';
    } catch {
      return 'unknown';
    }
  }

  /** A confirmed new user turn always starts a fresh retry budget/episode and
   *  cancels any pending initial-delay trigger. Stage-2 terminal recovery
   *  additionally requires the turn to return to the configured primary. */
  private freshTurnResetHandler(
    sessionID: string,
    newModel: string | undefined,
  ): void {
    // Budget / episode / delay reset applies to ANY confirmed user turn: the
    // previous descent's spent budget must not carry into the new request.
    const pendingDelay = this.pendingInitialDelay.get(sessionID);
    if (pendingDelay) {
      clearTimeout(pendingDelay);
      this.pendingInitialDelay.delete(sessionID);
    }
    this.sessionTried.delete(sessionID);
    this.sessionRetries.delete(sessionID);
    this.initialDelayScheduled.delete(sessionID);
    this.retryEpisode.delete(sessionID);
    this.lastTrigger.delete(sessionID);
    this.lastTriggerModel.delete(sessionID);
    this.lastTriggerMap.delete(sessionID);
    this.lastFallbackTime.delete(sessionID);
    // A new turn invalidates any in-flight replay's async completion: the
    // epoch bump fences the old replay's own writes. The pending identity
    // record is deliberately RETAINED (not deleted) so a late notification for
    // the old replay's user message can still be recognised as internal
    // instead of being misread as another real turn.
    this.turnEpoch.set(sessionID, (this.turnEpoch.get(sessionID) ?? 0) + 1);

    // Un-sealing a stage-2 abort is stricter: only a turn that returns to the
    // configured primary model re-opens the chain. A fallback-model turn (or a
    // user event without model info) resets the budget but not the terminal
    // guard.
    if ((this.chainExhaustion.get(sessionID) ?? 0) !== 2) return;
    if (newModel === undefined) return;
    const agentName = this.sessionAgent.get(sessionID);
    const primary = agentName ? this.chains[agentName]?.[0] : undefined;
    if (primary === undefined || newModel !== primary) return;
    this.chainExhaustion.delete(sessionID);
    this.v2RetryTerminal.delete(sessionID);
    log('[foreground-fallback] fresh turn reset from stage-2', {
      sessionID,
      agentName,
      model: newModel,
    });
  }

  /** Stable identity for a terminal incident, or undefined when the event
   *  carries nothing correlatable. Without an id we must NOT dedupe: identical
   *  error text on the same model can be the next real failure. */
  private stableEventIncidentId(props: {
    messageID?: unknown;
    messageId?: unknown;
    requestID?: unknown;
    requestId?: unknown;
    info?: { messageID?: unknown; id?: unknown } | undefined;
    error?: unknown;
  }): string | undefined {
    const direct = [
      props.messageID,
      props.messageId,
      props.requestID,
      props.requestId,
      props.info?.messageID,
    ];
    for (const candidate of direct) {
      if (typeof candidate === 'string' && candidate) return candidate;
    }
    if (isRecord(props.error)) {
      const err = props.error as {
        requestID?: unknown;
        requestId?: unknown;
        data?: { requestID?: unknown; requestId?: unknown };
      };
      const nested = [
        err.requestID,
        err.requestId,
        err.data?.requestID,
        err.data?.requestId,
      ];
      for (const candidate of nested) {
        if (typeof candidate === 'string' && candidate) return candidate;
      }
    }
    return undefined;
  }

  /** Dedup a terminal incident by stable id only. No id -> never dedupe. */
  private isTerminalIncidentDeduped(
    sessionID: string,
    incidentId: string | undefined,
  ): boolean {
    if (!incidentId) return false;
    const model = this.sessionModel.get(sessionID) ?? 'none';
    return this.recordIncident(sessionID, `terminal|${model}|${incidentId}`);
  }

  /** Dedup `session.status` retry events by retry episode + attempt. A higher
   *  attempt advances the same episode; a repeated or out-of-order attempt
   *  already seen in the episode is deduped (hosts may re-send or reorder). A
   *  model change starts a new episode (and therefore a new incident key). */
  private isHostRetryDeduped(sessionID: string, attempt: number): boolean {
    const model = this.sessionModel.get(sessionID);
    const episode = this.retryEpisode.get(sessionID);

    if (episode !== undefined && episode.model === model) {
      if (episode.seen.has(attempt)) {
        // Re-sent or out-of-order duplicate of an attempt already handled.
        return true;
      }
      episode.seen.add(attempt);
      episode.attempt = Math.max(episode.attempt, attempt);
      const key = `host-retry|${model ?? 'none'}|${episode.id}|${attempt}`;
      if (this.recordIncident(sessionID, key)) return true;
      this.lastTrigger.set(sessionID, Date.now());
      if (model !== undefined) this.lastTriggerModel.set(sessionID, model);
      return false;
    }

    const active = {
      model,
      attempt,
      id: ++this.retryEpisodeSeq,
      seen: new Set<number>([attempt]),
    };
    this.retryEpisode.set(sessionID, active);
    const key = `host-retry|${model ?? 'none'}|${active.id}|${attempt}`;
    if (this.recordIncident(sessionID, key)) return true;
    // Anchor the legacy stale-retry guard on the recorded (non-duplicate)
    // retry notification: model change + attempt > 1 upstream means stale.
    this.lastTrigger.set(sessionID, Date.now());
    if (model !== undefined) this.lastTriggerModel.set(sessionID, model);
    return false;
  }

  /** Record an incident key; true when it is a duplicate inside the window. */
  private recordIncident(sessionID: string, key: string): boolean {
    const now = Date.now();
    let map = this.lastTriggerMap.get(sessionID);
    if (!map) {
      map = new Map<string, number>();
      this.lastTriggerMap.set(sessionID, map);
    }
    const last = map.get(key);
    if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
      return true;
    }
    for (const [existingKey, timestamp] of map) {
      if (now - timestamp >= DEDUP_WINDOW_MS) map.delete(existingKey);
    }
    map.set(key, now);
    return false;
  }

  private selectFallbackModel(sessionID: string, error?: unknown) {
    const observedModel = this.sessionModel.get(sessionID);
    let currentModel = observedModel;
    const agentName = this.sessionAgent.get(sessionID);
    const chain = this.resolveChain(agentName, currentModel);
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
    // biome-ignore lint/style/noNonNullAssertion: We just set this above
    let tried = this.sessionTried.get(sessionID)!;

    // After the chain has been exhausted twice (reset retry failed and we
    // aborted), do not intervene again for this session: re-entering would
    // keep aborting in a loop. Surface errors to the user instead.
    if (this.chainExhaustion.get(sessionID) === 2) return;
    if (currentModel) tried.add(currentModel);
    // ponytail: seed chain entries at or before the current model's index
    // to prevent backward fallback onto models the session already left.
    if (currentModel) {
      const idx = chain.indexOf(currentModel);
      for (let i = 0; i < idx; i++) tried.add(chain[i]);
    }

    let nextModel = chain.find((m) => !tried.has(m));
    if (!nextModel) {
      if (chain.length > 1 && !isPermanentUsageQuotaError(error)) {
        // Chain exhausted but we have fallbacks: on the first exhaustion
        // reset the tried set and stick to the deepest fallback model so
        // we stop re-trying the dead primary model on every subsequent
        // message. If the sticky fallback itself fails afterwards (second
        // exhaustion), abort once and stop intervening — otherwise the
        // reset re-prompt would loop forever on a fully dead chain.
        const primary = chain[0];
        const stickyFallback = chain[chain.length - 1];
        if ((this.chainExhaustion.get(sessionID) ?? 0) >= 1) {
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
        log('[foreground-fallback] resetting tried set for re-fallback', {
          sessionID,
          agentName,
          currentModel,
          prevTried: [...tried],
          nextModel: stickyFallback,
        });
        tried = new Set();
        if (primary) tried.add(primary);
        if (currentModel && currentModel !== primary) tried.add(currentModel);
        this.sessionTried.set(sessionID, tried);
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
    // Retry budget is shared across the entire fallback chain.
    this.lastFallbackTime.delete(sessionID);
    // Cancel any pending initial delay on model switch
    const pendingDelay = this.pendingInitialDelay.get(sessionID);
    if (pendingDelay) {
      clearTimeout(pendingDelay);
      this.pendingInitialDelay.delete(sessionID);
    }

    const ref = parseModelReference(nextModel);
    if (!ref) {
      log('[foreground-fallback] invalid model format', {
        sessionID,
        nextModel,
      });
      return;
    }
    return { agentName, currentModel, nextModel, ref };
  }

  private async execFallback(
    sessionID: string,
    error?: unknown,
    entryEpoch?: number,
  ): Promise<void> {
    // Reload fence at entry: execFallback is reached after suspension
    // points in the tryFallback* callers; a disposed generation must not
    // even read the transcript through the old client.
    if (this.abandonedByDispose(sessionID)) return;
    // Supersession fence at entry: the caller may have suspended (backoff,
    // promotion, abort) while a genuine new user turn started. A threaded
    // entryEpoch that no longer matches means this attempt belongs to the old
    // turn — never switch the new turn's model or replay its request.
    if (
      entryEpoch !== undefined &&
      (this.turnEpoch.get(sessionID) ?? 0) !== entryEpoch
    ) {
      this.logSupersededFallback(sessionID);
      return;
    }
    try {
      const selection = this.selectFallbackModel(sessionID, error);
      if (!selection) return;
      if (selection === 'exhausted') {
        // Same withhold as the retry and busy paths: the merged chain
        // selection collapses both exhaustion aborts into this one point.
        if (this.withholdsAbortForLiveChildren(sessionID)) return;
        await abortSessionWithTimeout(getClient(this.input), sessionID);
        return;
      }
      const { currentModel, nextModel } = selection;

      // Execute the extracted replay logic for model-switch fallback.
      await this.replayFallbackPrompt(
        sessionID,
        nextModel,
        currentModel,
        true,
        error,
        entryEpoch,
      );
    } catch (err) {
      this.pendingReplay.delete(sessionID);
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

  /**
   * Replay a user prompt via promptAsync with model switch support and
   * background-handoff transfer. This is the extracted core from execFallback:
   * tail read + full fallback + preserved dual errors, last-user lookup,
   * promptAsync binding, promptBody, background handoff prepare/withdraw/settle/
   * admit, the prompt+busy-abort loop, envelope handling, deliveredWithoutSwitch,
   * switch claim, and toast. Parameterized by reminder text and switch claim.
   */
  private async replayFallbackPrompt(
    sessionID: string,
    targetModel: string,
    fromModel: string | undefined,
    isModelSwitch: boolean,
    error?: unknown,
    expectedEpoch?: number,
  ): Promise<void> {
    const session = getClient(this.input).session;
    const agentName = this.sessionAgent.get(sessionID);
    const chain = this.resolveChain(agentName, targetModel);
    if (!chain.length) return;

    // The replay's turn epoch. When the fallback entry threaded its epoch
    // through (promotion/abort/backoff already awaited), honour it so a turn
    // that started during those suspensions still supersedes this replay.
    // Otherwise capture it now, BEFORE the first await (the transcript read
    // below): a genuine new user turn that resets the session during the read
    // bumps turnEpoch and must supersede this replay. Reading the epoch after
    // the await would miss the reset and let a stale replay send its request
    // and claim the switch inside the new turn.
    const replayEpoch = expectedEpoch ?? this.turnEpoch.get(sessionID) ?? 0;

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
    // ~20 s. The `limit` query keeps the hot path O(tail); the full read
    // remains as a fallback for hosts that ignore it or transcripts whose
    // tail carries no replayable user message.
    const tailResult = await session.messages({
      path: { id: sessionID },
      query: { limit: FALLBACK_REPLAY_TAIL_MESSAGES },
    });
    // Transcript read suspended across a dispose(): everything from
    // here on — handoff arming, replay prompt, switch claim — would
    // run through the destroyed generation's client. Abandon before
    // arming anything; the tryFallback* finally releases inProgress.
    if (this.abandonedByDispose(sessionID)) return;
    // result.data may contain partial/streaming messages whose `info` is
    // undefined at runtime (OpenCode violates its own declared type), and
    // v2 messages carry `type`/`text` instead of `info`/`parts`, so guard
    // each entry instead of dereferencing a fixed shape.
    let messages = (tailResult.data ?? []) as unknown[];
    let requestError: unknown = tailResult.error ?? undefined;
    if (!messages.some((message) => isReplayableUserMessage(message))) {
      const fullResult = await session.messages({
        path: { id: sessionID },
      });
      if (this.abandonedByDispose(sessionID)) return;
      messages = (fullResult.data ?? []) as unknown[];
      // Preserve BOTH failures: when the tail and the full read fail
      // differently, the diagnostic log must surface the first error
      // too instead of letting the full-read error overwrite it.
      const fullError = fullResult.error ?? undefined;
      if (fullError !== undefined) {
        requestError =
          requestError === undefined ? fullError : [requestError, fullError];
      }
    }
    const lastUser = [...messages].reverse().find(isReplayableUserMessage);
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

    const replayParts = partsFromReplayMessage(lastUser) as Array<{
      type: 'text';
      text: string;
    }>;

    // v2-only flag (consumed by the client shim): the replay's model is
    // the fallback TARGET, so a v2 host without session.switchModel must
    // reject the replay (typed error) instead of silently replaying on
    // the model that just failed. v1 call bytes stay untouched.
    const isV2Host =
      (this.input as PluginInput & { hostFlavor?: string }).hostFlavor === 'v2';

    // Reminder text parameterization: isModelSwitch keeps the existing wording;
    // same-model retry uses a system-reminder noting the retry with same model.
    const reminderText = isModelSwitch
      ? "<system-reminder>\nThe previous model request failed and is being retried with a fallback model. Continue processing the user's original request above. Do not respond to this reminder.\n</system-reminder>"
      : "<system-reminder>\nThe previous model request failed and is being retried with the same model. Continue processing the user's original request above. Do not respond to this reminder.\n</system-reminder>";

    const ref = parseModelReference(targetModel);
    if (!ref) {
      log('[foreground-fallback] invalid model format', {
        sessionID,
        targetModel,
      });
      return;
    }

    const promptBody = {
      path: { id: sessionID },
      body: {
        parts: [...replayParts, createInternalAgentTextPart(reminderText)],
        model: ref,
        ...(agentName ? { agent: agentName } : {}),
      },
      ...(isV2Host && isModelSwitch
        ? { modelSwitch: 'required' as const }
        : {}),
    };

    // Arm the observation handoff BEFORE the admission await: while
    // promptAsync is pending the stop gate defers terminal
    // publication — the re-prompted result may already be persisted
    // but has no delivery owner yet. Baseline = trailing message WITH
    // a string id from the transcript read that produced the replay,
    // so the substituted run's answer is always post-baseline.
    // Baseline = trailing message with a string id (v1 `info.id` or the v2
    // flat top-level `id`) from the read that produced the replay.
    const baselineMessageID = [...messages]
      .reverse()
      .map((m) => messageID(m))
      .find((id) => id !== undefined);
    const handoffArmed =
      this.backgroundFallbackHandoff?.prepare(
        sessionID,
        preparedGeneration,
        baselineMessageID,
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
    // Register this replay's identity BEFORE the prompt: the host may emit the
    // replay's own user message even after promptAsync returns (inProgress
    // already cleared), and that event must not be mistaken for a real turn.
    // `replayEpoch` (captured before the transcript read) fences the async
    // completion: if a genuine new turn resets the session while this replay
    // is in flight, the replay must not send or write model/switch state back
    // into it.
    const replaySuperseded = (): boolean =>
      (this.turnEpoch.get(sessionID) ?? 0) !== replayEpoch;
    const logReplaySuperseded = (): void => {
      // Deterministic message: sessionID only (no timestamps/randomness).
      this.logSupersededFallback(sessionID);
    };
    // Do not enroll a pending record for a replay already superseded during
    // the transcript read, and never send its request.
    if (replaySuperseded()) {
      logReplaySuperseded();
      withdrawHandoff();
      return;
    }
    this.pendingReplay.set(sessionID, {
      targetModel,
      baselineMessageID,
      startedAt: Date.now(),
      admitted: false,
    });
    let promptResult: unknown;
    try {
      promptResult = await promptAsync(promptBody);
    } catch (promptErr) {
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
        this.pendingReplay.delete(sessionID);
        throw promptErr;
      }
      log('[foreground-fallback] promptAsync on busy session, aborting', {
        sessionID,
        error: stringifyError(promptErr),
      });
      await this.promoteForegroundWaiter(sessionID);
      // Same stale-generation fence as the failover abort above.
      if (this.abandonedByDispose(sessionID)) {
        this.pendingReplay.delete(sessionID);
        return;
      }
      if (this.withholdsAbortForLiveChildren(sessionID)) {
        // Explicit busy refusal with no abort attempted: nothing was
        // admitted, so release ownership (reject) like the v2 branch
        // above instead of converting into a tracked run.
        withdrawHandoff();
        throw promptErr;
      }
      if (replaySuperseded()) {
        // A genuine new turn arrived while the busy admission was failing: do
        // not abort (the session now belongs to the new turn) and do not
        // retry the stale replay.
        logReplaySuperseded();
        withdrawHandoff();
        this.pendingReplay.delete(sessionID);
        return;
      }
      try {
        await abortSessionWithTimeout(getClient(this.input), sessionID);
      } catch (abortErr) {
        // Distinct from a retry-prompt failure: the abort transport failed.
        // Unknown outcome — the admission state cannot be proven either way,
        // so the prepared ownership CONVERTS into a tracked run instead of
        // being dropped. Bounded: no further retry.
        log('[foreground-fallback] fallback abort failed', {
          sessionID,
          targetModel,
          error:
            abortErr instanceof Error ? abortErr.message : String(abortErr),
        });
        settleUnresolvedHandoff();
        this.pendingReplay.delete(sessionID);
        return;
      }
      await new Promise((r) => setTimeout(r, REPROMPT_DELAY_MS));
      // The abort/re-prompt-delay suspended across a dispose(): the
      // second replay must not go through the old client.
      if (this.abandonedByDispose(sessionID)) {
        settleUnresolvedHandoff();
        this.pendingReplay.delete(sessionID);
        return;
      }
      if (replaySuperseded()) {
        // A genuine new turn reset the session during the abort/delay: the
        // abort already happened, so settle the armed handoff as unresolved
        // and do not send the stale replay.
        logReplaySuperseded();
        settleUnresolvedHandoff();
        this.pendingReplay.delete(sessionID);
        return;
      }
      try {
        promptResult = await promptAsync(promptBody);
      } catch (retryErr) {
        // Distinct from an abort failure: the SECOND prompt was rejected.
        // This is not a provider failure and must not trigger another retry;
        // convert (never drop) the armed handoff and end the attempt so the
        // caller's finally clears inProgress.
        log('[foreground-fallback] retry prompt failed', {
          sessionID,
          targetModel,
          error:
            retryErr instanceof Error ? retryErr.message : String(retryErr),
        });
        settleUnresolvedHandoff();
        this.pendingReplay.delete(sessionID);
        return;
      }
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
          intended: targetModel,
        },
      );
      withdrawHandoff();
      this.pendingReplay.delete(sessionID);
      return;
    }

    // Admission accepted (real switch or same-model replay): keep the replay
    // identity available so a late user message event can still be matched.
    const replayState = this.pendingReplay.get(sessionID);
    if (replayState) {
      replayState.admitted = true;
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
        { sessionID, agentName, from: fromModel, intended: targetModel },
      );
    } else if (isModelSwitch) {
      if ((this.turnEpoch.get(sessionID) ?? 0) === replayEpoch) {
        this.sessionModel.set(sessionID, targetModel);
        this.onSessionModelChanged?.(sessionID, targetModel);
      } else {
        log(
          '[foreground-fallback] fallback switch superseded by a newer turn; model claim skipped',
          { sessionID, intended: targetModel },
        );
      }
    }
    // Admission accepted (with or without the switch): convert the
    // prepared handoff into a tracked run (register + immediate probe)
    // so the substituted run's result is observed and delivered to the
    // parent. Same-model retries are admissions too, and each admitted
    // prompt must be transferred exactly once.
    if (handoffArmed) {
      this.backgroundFallbackHandoff?.admit(sessionID, preparedGeneration);
    }
    if (
      isModelSwitch &&
      !deliveredWithoutSwitch &&
      (this.turnEpoch.get(sessionID) ?? 0) === replayEpoch
    ) {
      log('[foreground-fallback] switched to fallback model', {
        sessionID,
        agentName,
        from: fromModel,
        to: targetModel,
      });
      this.showFallbackToast(agentName, targetModel, error);
    }
  }

  /**
   * Retry the current model on terminal absorb: replay the last user message
   * on the SAME model (no switch claim, no toast). Used by decideIntervention's
   * 'absorb' branch for message.updated and session.error. Budget-exhausted
   * retries consume one absorbed budget slot and replay via promptAsync.
   * Failures are logged, bounded, and do not affect subsequent budget state.
   */
  private async retryCurrentModel(
    sessionID: string,
    error?: unknown,
  ): Promise<void> {
    if (!sessionID) return;
    // Fences/guards identical to tryFallback.
    if (this.abandonedByDispose(sessionID)) return;
    if (this.inProgress.has(sessionID)) return;
    if (!this.hasFallbackChain(sessionID)) return;

    // Capture the turn epoch at entry: the replay below (and any suspension it
    // awaits) must not apply to a newer turn that started meanwhile. Internal
    // replays still run inside replayFallbackPrompt's own epoch fences.
    const entryEpoch = this.turnEpoch.get(sessionID) ?? 0;

    this.inProgress.add(sessionID);
    try {
      const agentName = this.sessionAgent.get(sessionID);
      const chain = this.resolveChain(agentName, undefined);
      // Resolve target model: from sessionModel first, then chain[0].
      const targetModel = this.sessionModel.get(sessionID);
      if (!targetModel && agentName && chain.length > 0) {
        // Inferred primary when no model observed.
      }
      const effectiveTarget = targetModel ?? chain[0] ?? chain[0];
      if (!effectiveTarget) return;
      // Same-model retry calls replay with isModelSwitch=false (no switch/toast).
      await this.replayFallbackPrompt(
        sessionID,
        effectiveTarget,
        effectiveTarget,
        false,
        error,
        entryEpoch,
      );
    } catch (err) {
      this.pendingReplay.delete(sessionID);
      log('[foreground-fallback] retry prompt failed', {
        sessionID,
        targetModel: this.sessionModel.get(sessionID) ?? 'unknown',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.inProgress.delete(sessionID);
    }
  }

  // ---------------------------------------------------------------------------
  // Chain resolution
  // ---------------------------------------------------------------------------

  /** True when resolveChain yields at least one model for this session. */
  private hasFallbackChain(sessionID: string): boolean {
    return (
      this.resolveChain(
        this.sessionAgent.get(sessionID),
        this.sessionModel.get(sessionID),
      ).length > 0
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
  ): string[] {
    if (agentName) {
      const chain = this.chains[agentName];
      if (chain) {
        // Dynamic head: when the session runs a model outside the
        // configured chain (session-inherited or /model-picked), that model
        // leads the descent and the configured entries back it. The head is
        // never re-picked — selectFallbackModel marks the current model
        // tried before scanning, so the first untried entry is the
        // configured head.
        // Empty chains (disableChain) must stay empty: prepending onto []
        // would resurrect fallback for an agent whose chain was disabled.
        if (currentModel && chain.length > 0 && !chain.includes(currentModel)) {
          return [currentModel, ...chain];
        }
        return chain;
      }
      // Any known agent without a configured chain: no fallback.
      // Don't bleed into other agents' chains via model-matching —
      // that switches the session to the wrong agent (e.g. Build
      // inherits Orchestrator's chain and becomes Orchestrator).
      return [];
    }

    // Agent unknown: try to infer from the current model.
    if (currentModel) {
      for (const chain of Object.values(this.chains)) {
        if (chain.includes(currentModel)) return chain;
      }
    }

    // Last resort: merged list across all agents preserving insertion order.
    // Only reached when both agent name and current model are unavailable.
    const all: string[] = [];
    const seen = new Set<string>();
    for (const chain of Object.values(this.chains)) {
      for (const m of chain) {
        if (!seen.has(m)) {
          seen.add(m);
          all.push(m);
        }
      }
    }
    return all;
  }
}
