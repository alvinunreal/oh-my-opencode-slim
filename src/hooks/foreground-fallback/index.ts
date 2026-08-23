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
import { createInternalAgentTextPart } from '../../utils/internal-initiator';
import { log } from '../../utils/logger';
import { getClient } from '../../utils/opencode-client';
import {
  abortSessionWithTimeout,
  parseModelReference,
} from '../../utils/session';
import type { SessionLifecycle } from '../session-lifecycle';
import {
  isReplayableUserMessage,
  partsFromReplayMessage,
  type ReplayableUserMessage,
} from '../types';

// ---------------------------------------------------------------------------
// Retryable error detection
// ---------------------------------------------------------------------------

const RETRYABLE_ERROR_PATTERNS = [
  /\b429\b/,
  /rate.?limit/i,
  /too many requests/i,
  /quota.?exceeded/i,
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
];

const OUTAGE_STATUS_CODES = new Set([500, 502, 503, 504, 524]);
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
  /\bupstream error\b/i,
  /\bstreaming response failed\b/i,
  /\brequest queue is full\b/i,
  /\bworker local total request limit reached\b/i,
];

function extractStatusCode(error: {
  statusCode?: unknown;
  data?: { statusCode?: unknown };
}): number | undefined {
  const value = error.statusCode ?? error.data?.statusCode;
  return typeof value === 'number' ? value : undefined;
}

function eventSessionID(props: {
  sessionID?: string;
  info?: { id?: string };
}): string | undefined {
  return props.sessionID ?? props.info?.id;
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
    cause?: { code?: unknown };
    message?: string;
    statusCode?: number;
    data?: {
      code?: unknown;
      statusCode?: number;
      message?: string;
      responseBody?: string;
    };
  };
  const statusCode = extractStatusCode(err);
  if (
    statusCode === 429 ||
    statusCode === 401 ||
    statusCode === 403 ||
    statusCode === 410 ||
    (statusCode !== undefined && OUTAGE_STATUS_CODES.has(statusCode))
  ) {
    return true;
  }
  if (
    [err.code, err.cause?.code, err.data?.code].some(
      (code) => typeof code === 'string' && TRANSPORT_CODES.has(code),
    )
  ) {
    return true;
  }

  const messages = [
    err.message ?? '',
    err.data?.message ?? '',
    err.data?.responseBody ?? '',
  ];
  if (
    messages.some((message) =>
      TRANSPORT_MESSAGE_PATTERNS.some((p) => p.test(message)),
    )
  ) {
    return true;
  }

  const text = [
    err.message ?? '',
    err.data?.message ?? '',
    err.data?.responseBody ?? '',
  ].join(' ');
  const hasFailoverReason =
    RETRYABLE_ERROR_PATTERNS.some((p) => p.test(text)) ||
    PROVIDER_OUTAGE_PATTERNS.some((p) => p.test(text));
  // Providers sometimes return recoverable rate-limit/outage payloads with
  // an HTTP 400 wrapper. Preserve application-level 400 failures, but let a
  // recognizable failover body continue through the fallback path.
  return hasFailoverReason;
}

/**
 * Checks whether an error is a transient/retryable error (rate-limit,
 * 403/Forbidden, etc.) that should trigger model fallback.
 */
export function isRetryableError(error: unknown): boolean {
  return isFailoverError(error);
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
  /** sessionID → consecutive 429 count for the current model.
   *  Reset on model swap or session deletion. */
  private readonly sessionRetries = new Map<string, number>();
  /** sessionID → chain-exhaustion stage:
   *   0 = not exhausted; 1 = chain exhausted once, reset to sticky fallback
   *   (one retry chance); 2 = exhausted again, aborted — stop intervening.
   *   Reset to 0 on successful responses or session deletion. */
  private readonly chainExhaustion = new Map<string, number>();

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

  constructor(
    /**
     * Ordered fallback chains per agent.
     * e.g. { orchestrator: ['anthropic/claude-opus-4-5', 'openai/gpt-4o'] }
     * The first model that hasn't been tried yet is selected on each fallback.
     */
    private chains: Record<string, string[]>,
    private readonly enabled: boolean,
    private readonly input: PluginInput,
    /** Consecutive 429s tolerated on the same model before swap/abort. */
    private readonly maxRetries: number = 3,
    coordinator?: SessionLifecycle,
  ) {
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
        this.chainExhaustion.delete(id);
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
        // Track the model currently serving this session
        if (
          typeof info.providerID === 'string' &&
          typeof info.modelID === 'string'
        ) {
          this.sessionModel.set(
            sessionID,
            `${info.providerID}/${info.modelID}`,
          );
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
          if (this.shouldTriggerFallback(sessionID)) {
            await this.tryFallback(sessionID, info.error);
          }
        } else if (isCompletedSuccessfulAssistant) {
          // Only a completed, successful assistant response proves recovery.
          this.sessionRetries.delete(sessionID);
          this.chainExhaustion.delete(sessionID);
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
          sessionID &&
          props.error &&
          isFailoverError(props.error) &&
          this.shouldTriggerFallback(sessionID)
        ) {
          await this.tryFallback(sessionID, props.error);
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
            Date.now() - lastTriggerTime < DEDUP_WINDOW_MS;
          if (modelChanged && withinDedupWindow && attempt > 1) {
            // Model changed since last trigger, within dedup window, and
            // attempt > 1: this is a stale retry from the old model's
            // retry loop (continuation of previous attempts). Skip it.
            break;
          }
          // Otherwise (attempt === 1, or model didn't change, or outside
          // dedup window): process as genuine retry for current model.
          if (this.shouldTriggerFallback(sessionID)) {
            // Failover may have been detected from status.message (e.g.
            // 'AI_APICallError: Gone') with no separate error property;
            // forward that message so 401/410 inline errors suppress the
            // toast on this path too, matching session.error behavior.
            await this.tryFallbackWithAbort(
              sessionID,
              props.error ?? { message: props.status?.message ?? '' },
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
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Retry budget
  // ---------------------------------------------------------------------------

  /** Increment retry counter and return true when the budget is exhausted.
   *  Used by shouldIntervene when tried > 0 — each retry counts toward the
   *  budget and only triggers fallback after maxRetries - 1 absorptions.
   *  First failover retry (tried === 0) bypasses the counter via shouldIntervene. */
  private consumeRetryBudget(sessionID: string): boolean {
    const tried = this.sessionRetries.get(sessionID) ?? 0;
    if (tried < this.maxRetries - 1) {
      this.sessionRetries.set(sessionID, tried + 1);
      log('[foreground-fallback] rate-limit retry', {
        sessionID,
        attempt: tried + 1,
        remaining: this.maxRetries - tried - 1,
      });
      return false;
    }
    this.sessionRetries.delete(sessionID);
    return true;
  }

  /** Intervene immediately on first occurrence (tried === 0), otherwise
   *  delegate to retry budget. Used by all three event paths. */
  private shouldTriggerFallback(sessionID: string): boolean {
    const tried = this.sessionRetries.get(sessionID) ?? 0;
    if (tried === 0) return true;
    return this.consumeRetryBudget(sessionID);
  }

  // ---------------------------------------------------------------------------
  // Re-prompt helper (shared by fallback and same-model retry paths)
  // ---------------------------------------------------------------------------

  private async rePromptWithModel(
    sessionID: string,
    model: { providerID: string; modelID: string },
    agentName?: string,
    label?: string,
  ): Promise<void> {
    let lastUser: ReplayableUserMessage | undefined;
    // ponytail: retry up to 3 times, 500ms apart — the message may still
    // be in-flight when the stream error fires; a short wait usually lands it.
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await getClient(this.input).session.messages({
        path: { id: sessionID },
      });
      const messages = (result.data ?? []) as unknown[];
      lastUser = [...messages].reverse().find(isReplayableUserMessage);
      if (lastUser) break;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, REPROMPT_DELAY_MS));
      }
    }
    if (!lastUser) {
      log('[foreground-fallback] no user message found', { sessionID });
      return;
    }

    const sessionClient = getClient(this.input).session;
    if (typeof sessionClient.promptAsync !== 'function') {
      log('[foreground-fallback] promptAsync unavailable', { sessionID });
      return;
    }

    const replayParts = partsFromReplayMessage(lastUser) as Array<{
      type: 'text';
      text: string;
    }>;

    const promptBody = {
      path: { id: sessionID },
      body: {
        parts: [
          ...replayParts,
          createInternalAgentTextPart(label ?? 'Foreground fallback replay.'),
        ],
        model,
        ...(agentName ? { agent: agentName } : {}),
      },
    };

    try {
      await sessionClient.promptAsync(promptBody);
    } catch (_promptErr) {
      log('[foreground-fallback] promptAsync on busy session, aborting', {
        sessionID,
      });
      await abortSessionWithTimeout(getClient(this.input), sessionID);
      await new Promise((r) => setTimeout(r, REPROMPT_DELAY_MS));
      await sessionClient.promptAsync(promptBody);
    }
  }

  // ---------------------------------------------------------------------------
  // Core fallback logic
  // ---------------------------------------------------------------------------

  private async tryFallback(sessionID: string, error?: unknown): Promise<void> {
    if (!sessionID) return;
    if (this.inProgress.has(sessionID)) return;

    // Has a fallback chain: switch models as before.
    if (this.hasFallbackChain(sessionID)) {
      if (this.isDeduped(sessionID)) return;

      this.inProgress.add(sessionID);
      try {
        await this.execFallback(sessionID, error);
      } finally {
        this.inProgress.delete(sessionID);
      }
      return;
    }

    // No chain — retry with the current model (transient upstream errors
    // like 502/503/504 ResourceExhausted / queue full are often resolved
    // by a simple retry hitting a different worker).
    const currentModel = this.sessionModel.get(sessionID);
    if (!currentModel) return;

    // Agent chain explicitly disabled — skip same-model retry.
    const agentName = this.sessionAgent.get(sessionID);
    if (
      agentName &&
      Array.isArray(this.chains[agentName]) &&
      this.chains[agentName].length === 0
    )
      return;

    const tried = this.sessionRetries.get(sessionID) ?? 0;
    if (tried >= this.maxRetries) {
      log('[foreground-fallback] same-model retries exhausted, giving up', {
        sessionID,
        currentModel,
        tried,
      });
      this.sessionRetries.delete(sessionID);
      return;
    }

    if (this.isDeduped(sessionID)) return;

    this.sessionRetries.set(sessionID, tried + 1);

    this.inProgress.add(sessionID);
    try {
      const ref = parseModelReference(currentModel);
      if (!ref) return;
      log('[foreground-fallback] retrying with current model', {
        sessionID,
        model: currentModel,
        attempt: tried + 1,
        maxRetries: this.maxRetries,
      });
      await this.rePromptWithModel(
        sessionID,
        ref,
        agentName,
        'Same-model retry after transient error.',
      );
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
   * When no chain is available, retries the current model (up to maxRetries)
   * — transient upstream errors like 502/503/504 often resolve with a retry
   * to a different worker.
   */
  private async tryFallbackWithAbort(
    sessionID: string,
    error?: unknown,
  ): Promise<void> {
    if (!sessionID) return;
    if (this.inProgress.has(sessionID)) return;

    if (this.hasFallbackChain(sessionID)) {
      if (this.isDeduped(sessionID)) return;

      this.inProgress.add(sessionID);
      try {
        await abortSessionWithTimeout(getClient(this.input), sessionID);
        await this.execFallback(sessionID, error);
      } finally {
        this.inProgress.delete(sessionID);
      }
      return;
    }

    // No chain — retry with current model after abort.
    const currentModel = this.sessionModel.get(sessionID);
    if (!currentModel) return;

    // Agent chain explicitly disabled — skip same-model retry.
    const agentName = this.sessionAgent.get(sessionID);
    if (
      agentName &&
      Array.isArray(this.chains[agentName]) &&
      this.chains[agentName].length === 0
    )
      return;

    const tried = this.sessionRetries.get(sessionID) ?? 0;
    if (tried >= this.maxRetries) {
      log('[foreground-fallback] same-model retries exhausted, giving up', {
        sessionID,
        currentModel,
        tried,
      });
      this.sessionRetries.delete(sessionID);
      return;
    }

    if (this.isDeduped(sessionID)) return;

    this.sessionRetries.set(sessionID, tried + 1);

    this.inProgress.add(sessionID);
    try {
      const ref = parseModelReference(currentModel);
      if (!ref) return;
      await abortSessionWithTimeout(getClient(this.input), sessionID);
      log('[foreground-fallback] retrying with current model after abort', {
        sessionID,
        model: currentModel,
        attempt: tried + 1,
        maxRetries: this.maxRetries,
      });
      await this.rePromptWithModel(
        sessionID,
        ref,
        agentName,
        'Same-model retry after transient error.',
      );
    } finally {
      this.inProgress.delete(sessionID);
    }
  }

  private isDeduped(sessionID: string): boolean {
    const now = Date.now();
    const curModel = this.sessionModel.get(sessionID);
    const modelChanged =
      this.lastTriggerModel.has(sessionID) &&
      this.lastTriggerModel.get(sessionID) !== curModel;
    if (
      !modelChanged &&
      now - (this.lastTrigger.get(sessionID) ?? 0) < DEDUP_WINDOW_MS
    )
      return true;
    this.lastTrigger.set(sessionID, now);
    if (curModel !== undefined) {
      this.lastTriggerModel.set(sessionID, curModel);
    }
    return false;
  }

  private async execFallback(
    sessionID: string,
    error?: unknown,
  ): Promise<void> {
    try {
      // After the chain has been exhausted twice (reset retry failed and we
      // aborted), do not intervene again for this session: re-entering would
      // keep aborting in a loop. Surface errors to the user instead.
      if (this.chainExhaustion.get(sessionID) === 2) return;
      let currentModel = this.sessionModel.get(sessionID);
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
      if (currentModel) tried.add(currentModel);

      let nextModel = chain.find((m) => !tried.has(m));
      if (!nextModel) {
        if (chain.length > 1) {
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
            log(
              '[foreground-fallback] chain exhausted after re-fallback, aborting',
              {
                sessionID,
                agentName,
                currentModel,
                tried: [...tried],
              },
            );
            await abortSessionWithTimeout(getClient(this.input), sessionID);
            return;
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
          log('[foreground-fallback] fallback chain exhausted, aborting', {
            sessionID,
            agentName,
            tried: [...tried],
          });
          await abortSessionWithTimeout(getClient(this.input), sessionID);
          return;
        }
      }
      tried.add(nextModel);
      // Reset retry count on model switch — the new model starts fresh.
      this.sessionRetries.delete(sessionID);

      const ref = parseModelReference(nextModel);
      if (!ref) {
        log('[foreground-fallback] invalid model format', {
          sessionID,
          nextModel,
        });
        return;
      }

      // Re-prompt with the fallback model.
      await this.rePromptWithModel(sessionID, ref, agentName);

      this.sessionModel.set(sessionID, nextModel);
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
        error: err instanceof Error ? err.message : String(err),
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
   * 1. Agent name known AND has a configured chain → return it directly
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
      if (chain) return chain;
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
