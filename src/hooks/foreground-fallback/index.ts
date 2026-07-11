/**
 * Runtime model fallback for foreground (interactive) agent sessions.
 *
 * When OpenCode fires a session.error, message.updated, or session.status
 * event containing a rate-limit signal, this manager:
 *   1. Looks up the next untried model in the agent's configured chain
 *   2. Aborts the rate-limited prompt via client.session.abort()
 *   3. Re-queues the last user message via client.session.promptAsync()
 *      with the new model - promptAsync returns immediately so we never
 *      block the event handler waiting for a full LLM response.
 *
 * This mirrors the same fallback loop used for delegated sessions, but operates
 * reactively through the event system instead of wrapping prompt() in a
 * try/catch, which is not possible for interactive (foreground) sessions.
 */

import type { PluginInput } from '@opencode-ai/plugin';
import { log } from '../../utils/logger';
import {
  abortSessionWithTimeout,
  parseModelReference,
} from '../../utils/session';
import type { SessionLifecycle } from '../session-lifecycle';
import { isUserMessageWithParts } from '../types';

type OpencodeClient = PluginInput['client'];

// ---------------------------------------------------------------------------
// Rate-limit detection
// ---------------------------------------------------------------------------

const RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /rate.?limit/i,
  /too many requests/i,
  /quota.?exceeded/i,
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
];

const OUTAGE_STATUS_CODES = new Set([500, 502, 503, 504]);
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
];
const PROVIDER_OUTAGE_PATTERNS = [
  /\binternal server error\b/i,
  /\bbad gateway\b/i,
  /\bgateway timeout\b/i,
  /\bservice unavailable\b/i,
  /\bupstream outage\b/i,
  /\bprovider outage\b/i,
  /\bprovider unavailable\b/i,
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
      RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(error)) ||
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
    RATE_LIMIT_PATTERNS.some((p) => p.test(text)) ||
    PROVIDER_OUTAGE_PATTERNS.some((p) => p.test(text));
  // Providers sometimes return recoverable rate-limit/outage payloads with
  // an HTTP 400 wrapper. Preserve application-level 400 failures, but let a
  // recognizable failover body continue through the fallback path.
  return hasFailoverReason;
}

/** @deprecated Use isFailoverError instead. */
export function isRateLimitError(error: unknown): boolean {
  return isFailoverError(error);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prevent re-triggering within this window for the same session. */
const DEDUP_WINDOW_MS = 5_000;
const REPROMPT_DELAY_MS = 500;

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
  /** Sessions with an active fallback switch in flight */
  private readonly inProgress = new Set<string>();
  /** sessionID → timestamp of last trigger (for deduplication) */
  private readonly lastTrigger = new Map<string, number>();
  /** sessionID → model in use when lastTrigger was set; dedup is bypassed
   *  when the model has changed, allowing the cascade to continue when a
   *  new fallback model also fails within the dedup window. */
  private readonly lastTriggerModel = new Map<string, string>();
  /** sessionID → consecutive 429 count for the current model.
   *  Reset on model swap or session deletion. */
  private readonly sessionRetries = new Map<string, number>();

  /** Exposed for task-session-manager: prevents idle reconciliation
   *  while a fallback abort/re-prompt is in flight for this session. */
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
    private readonly client: OpencodeClient,
    /**
     * Ordered fallback chains per agent.
     * e.g. { orchestrator: ['anthropic/claude-opus-4-5', 'openai/gpt-4o'] }
     * The first model that hasn't been tried yet is selected on each fallback.
     */
    private chains: Record<string, string[]>,
    private readonly enabled: boolean,
    /** Consecutive 429s tolerated on the same model before swap/abort. */
    private readonly maxRetries: number = 3,
    coordinator?: SessionLifecycle,
  ) {
    if (coordinator) {
      coordinator.onSessionDeleted((id) => {
        this.sessionModel.delete(id);
        this.sessionAgent.delete(id);
        this.sessionTried.delete(id);
        this.inProgress.delete(id);
        this.lastTrigger.delete(id);
        this.lastTriggerModel.delete(id);
        this.sessionRetries.delete(id);
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
        // Failover-worthy error on an individual message
        if (info.error && isFailoverError(info.error)) {
          if (this.shouldIntervene(sessionID)) {
            await this.tryFallback(sessionID);
          }
        } else {
          // Successful response: clear retry count so recovery is not forgotten.
          this.sessionRetries.delete(sessionID);
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
          this.shouldIntervene(sessionID)
        ) {
          await this.tryFallback(sessionID);
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
          if (this.checkRetryBudget(sessionID)) {
            await this.tryFallbackWithAbort(sessionID);
          }
          break;
        }

        if (this.isRecoveredStatus(props.status?.type)) {
          // Recovered/terminal status: clear retry count.
          this.sessionRetries.delete(sessionID);
        }
        // Note: do NOT clear sessionRetries here on non-rate-limit statuses.
        // Abort events triggered by our own fallback carry non-rate-limit
        // messages and would reset the counter, creating an infinite loop:
        // abort → fallback → set retries to 1 → abort event clears retries
        // → next retry sees tried=0 → abort+fallback again → repeat.
        // Retries are only cleared on successful response (message.updated
        // without error) or session deletion.
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
   *  Used by the session.status retry path — each retry counts toward the
   *  budget and only triggers fallback after maxRetries - 1 absorptions.
   *  Non-retry paths (session.error / message.updated) use shouldIntervene(),
   *  which bypasses the counter on first occurrence. */
  private checkRetryBudget(sessionID: string): boolean {
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

  /** For non-retry paths (session.error, message.updated): intervene immediately
   *  unless the session is already in a retry window (has prior retries). */
  private shouldIntervene(sessionID: string): boolean {
    const tried = this.sessionRetries.get(sessionID) ?? 0;
    if (tried === 0) return true;
    return this.checkRetryBudget(sessionID);
  }

  private isRecoveredStatus(statusType: string | undefined): boolean {
    return (
      statusType === 'idle' ||
      statusType === 'complete' ||
      statusType === 'completed' ||
      statusType === 'success' ||
      statusType === 'terminal'
    );
  }

  // ---------------------------------------------------------------------------
  // Core fallback logic
  // ---------------------------------------------------------------------------

  private async tryFallback(sessionID: string): Promise<void> {
    if (!sessionID) return;
    if (this.inProgress.has(sessionID)) return;

    // Deduplicate: multiple events can fire for a single rate-limit event.
    // Bypass dedup when the model changed since the last trigger - the new
    // model's failure is a separate incident and the cascade should continue.
    if (this.isDeduped(sessionID)) return;

    this.inProgress.add(sessionID);
    try {
      await this.execFallback(sessionID);
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
   */
  private async tryFallbackWithAbort(sessionID: string): Promise<void> {
    if (!sessionID) return;
    if (this.inProgress.has(sessionID)) return;
    if (this.isDeduped(sessionID)) return;

    this.inProgress.add(sessionID);
    try {
      await abortSessionWithTimeout(this.client, sessionID);
      await this.execFallback(sessionID);
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

  private async execFallback(sessionID: string): Promise<void> {
    try {
      let currentModel = this.sessionModel.get(sessionID);
      const agentName = this.sessionAgent.get(sessionID);
      const chain = this.resolveChain(agentName, currentModel);
      if (!chain.length) {
        log('[foreground-fallback] no chain configured', {
          sessionID,
          agentName,
        });
        return;
      }

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
          // Chain exhausted but we have fallbacks: reset tried set and
          // stick to the deepest fallback model so we stop re-trying the
          // dead primary model on every subsequent message.
          const primary = chain[0];
          const stickyFallback = chain[chain.length - 1];
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
          log('[foreground-fallback] fallback chain exhausted, aborting', {
            sessionID,
            agentName,
            tried: [...tried],
          });
          await abortSessionWithTimeout(this.client, sessionID);
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

      // Retrieve the last user message to re-submit with the fallback model.
      const result = await this.client.session.messages({
        path: { id: sessionID },
      });
      // result.data may contain partial/streaming messages whose `info` is
      // undefined at runtime (OpenCode violates its own declared type), so
      // guard each entry instead of dereferencing `info` directly.
      const messages = (result.data ?? []) as unknown[];
      const lastUser = [...messages].reverse().find(isUserMessageWithParts);
      if (!lastUser) {
        log('[foreground-fallback] no user message found', { sessionID });
        return;
      }

      // promptAsync queues the prompt and returns immediately - this avoids
      // blocking the event handler while waiting for a full LLM response.
      // Cast required: promptAsync is not in the plugin TypeScript types for
      // oh-my-opencode-slim but IS present on the real OpenCode client at
      // runtime (verified by opencode-rate-limit-fallback reference impl).
      const sessionClient = this.client.session as unknown as {
        promptAsync?: (args: {
          path: { id: string };
          body: {
            agent?: string;
            parts: unknown[];
            model: { providerID: string; modelID: string };
          };
        }) => Promise<unknown>;
      };
      if (typeof sessionClient.promptAsync !== 'function') {
        log('[foreground-fallback] promptAsync unavailable', { sessionID });
        return;
      }

      const promptBody = {
        parts: lastUser.parts,
        model: ref,
        ...(agentName ? { agent: agentName } : {}),
      };

      // Try queuing the fallback prompt without aborting first. If OpenCode
      // accepts it (204), the fallback model replaces the retry loop
      // transparently — no dialog, no session error shown to the user.
      // If promptAsync throws (e.g. session busy), fall back to abort+retry.
      try {
        await sessionClient.promptAsync({
          path: { id: sessionID },
          body: promptBody,
        });
      } catch (_promptErr) {
        log('[foreground-fallback] promptAsync on busy session, aborting', {
          sessionID,
        });
        await abortSessionWithTimeout(this.client, sessionID);
        await new Promise((r) => setTimeout(r, REPROMPT_DELAY_MS));
        await sessionClient.promptAsync({
          path: { id: sessionID },
          body: promptBody,
        });
      }

      this.sessionModel.set(sessionID, nextModel);
      log('[foreground-fallback] switched to fallback model', {
        sessionID,
        agentName,
        from: currentModel,
        to: nextModel,
      });
    } catch (err) {
      log('[foreground-fallback] fallback attempt failed', {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Chain resolution
  // ---------------------------------------------------------------------------

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
