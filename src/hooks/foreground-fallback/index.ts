/**
 * Runtime model fallback for foreground (interactive) agent sessions.
 *
 * When OpenCode fires a session.error, message.updated, or session.status
 * event containing a rate-limit signal, this manager:
 *   1. Looks up the next untried model in the agent's configured chain
 *   2. Aborts the rate-limited prompt via client.session.abort()
 *   3. Re-queues the last user message via client.session.promptAsync()
 *      with the new model — promptAsync returns immediately so we never
 *      block the event handler waiting for a full LLM response.
 *
 * This mirrors the same fallback loop used for delegated sessions, but operates
 * reactively through the event system instead of wrapping prompt() in a
 * try/catch, which is not possible for interactive (foreground) sessions.
 */

import type { PluginInput } from '@opencode-ai/plugin';
import { ALL_AGENT_NAMES } from '../../config/constants';
import { log } from '../../utils/logger';
import {
  abortSessionWithTimeout,
  parseModelReference,
} from '../../utils/session';
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

export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as {
    message?: string;
    data?: { statusCode?: number; message?: string; responseBody?: string };
  };
  const text = [
    err.message ?? '',
    String(err.data?.statusCode ?? ''),
    err.data?.message ?? '',
    err.data?.responseBody ?? '',
  ].join(' ');
  return RATE_LIMIT_PATTERNS.some((p) => p.test(text));
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

  constructor(
    private readonly client: OpencodeClient,
    /**
     * Ordered fallback chains per agent.
     * e.g. { orchestrator: ['anthropic/claude-opus-4-5', 'openai/gpt-4o'] }
     * The first model that hasn't been tried yet is selected on each fallback.
     */
    private readonly chains: Record<string, string[]>,
    private readonly enabled: boolean,
  ) {}

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
          this.sessionAgent.set(sessionID, info.agent);
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
        // Rate-limit on an individual message
        if (info.error && isRateLimitError(info.error)) {
          await this.tryFallback(sessionID);
        }
        break;
      }

      case 'session.error': {
        const props = event.properties as
          | { sessionID?: string; error?: unknown }
          | undefined;
        if (props?.sessionID && props.error && isRateLimitError(props.error)) {
          await this.tryFallback(props.sessionID);
        }
        break;
      }

      case 'session.status': {
        const props = event.properties as
          | {
              sessionID?: string;
              status?: { type?: string; message?: string };
            }
          | undefined;
        if (!props?.sessionID || props.status?.type !== 'retry') break;
        const msg = props.status.message?.toLowerCase() ?? '';
        if (
          msg.includes('rate limit') ||
          msg.includes('usage limit') ||
          msg.includes('usage exceeded') ||
          msg.includes('quota exceeded') ||
          msg.includes('exceededbudget') ||
          msg.includes('over budget') ||
          msg.includes('insufficient') ||
          msg.includes('high concurrency') ||
          msg.includes('reduce concurrency')
        ) {
          await this.tryFallback(props.sessionID);
        }
        break;
      }

      case 'subagent.session.created': {
        // Some builds of OpenCode include the agent name here.
        const props = event.properties as
          | { sessionID?: string; agentName?: unknown }
          | undefined;
        if (props?.sessionID && typeof props.agentName === 'string') {
          this.sessionAgent.set(props.sessionID, props.agentName);
        }
        break;
      }

      case 'session.deleted': {
        // Clean up all per-session state to prevent unbounded memory growth
        // in long-running instances with many subagent sessions.
        // OpenCode emits two shapes depending on context:
        //   { properties: { sessionID } }   — subagent / task sessions
        //   { properties: { info: { id } } } — top-level session deletion
        // Mirror the same dual-shape lookup used elsewhere in the plugin.
        const props = event.properties as
          | { sessionID?: string; info?: { id?: string } }
          | undefined;
        const id = props?.info?.id ?? props?.sessionID;
        if (id) {
          this.sessionModel.delete(id);
          this.sessionAgent.delete(id);
          this.sessionTried.delete(id);
          this.inProgress.delete(id);
          this.lastTrigger.delete(id);
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Core fallback logic
  // ---------------------------------------------------------------------------

  private async tryFallback(sessionID: string): Promise<void> {
    if (!sessionID) return;
    if (this.inProgress.has(sessionID)) return;

    // Deduplicate: multiple events can fire for a single rate-limit event.
    const now = Date.now();
    if (now - (this.lastTrigger.get(sessionID) ?? 0) < DEDUP_WINDOW_MS) return;
    this.lastTrigger.set(sessionID, now);

    this.inProgress.add(sessionID);
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
          log('[foreground-fallback] fallback chain exhausted', {
            sessionID,
            agentName,
            tried: [...tried],
          });
          return;
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

      // promptAsync queues the prompt and returns immediately — this avoids
      // blocking the event handler while waiting for a full LLM response.
      // Cast required: promptAsync is not in the plugin TypeScript types for
      // oh-my-opencode-slim but IS present on the real OpenCode client at
      // runtime (verified by opencode-rate-limit-fallback reference impl).
      const sessionClient = this.client.session as unknown as {
        promptAsync?: (args: {
          path: { id: string };
          body: {
            parts: unknown[];
            model: { providerID: string; modelID: string };
          };
        }) => Promise<unknown>;
      };
      if (typeof sessionClient.promptAsync !== 'function') {
        log('[foreground-fallback] promptAsync unavailable', { sessionID });
        return;
      }

      // Abort the currently rate-limited prompt so the session becomes idle.
      try {
        await abortSessionWithTimeout(this.client, sessionID);
      } catch (error) {
        // Session may already be idle or abort may be slow; keep fallback best-effort.
        log('[foreground-fallback] abort did not complete cleanly', {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Give the server a moment to finalise the abort before re-prompting.
      await new Promise((r) => setTimeout(r, REPROMPT_DELAY_MS));

      await sessionClient.promptAsync({
        path: { id: sessionID },
        body: { parts: lastUser.parts, model: ref },
      });

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
    } finally {
      this.inProgress.delete(sessionID);
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
   * 2. Agent name known but NO chain configured → return [] (no fallback;
   *    do NOT bleed into other agents' chains which would re-prompt the
   *    session with a model belonging to a completely different agent)
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
      // Agent is known: use its chain exactly if configured.
      const chain = this.chains[agentName];
      if (chain) return chain;
      // Known omos built-in agent (oracle, librarian, …) without a
      // configured chain: keep isolation — do NOT bleed into other
      // agents' chains (preserves the cross-agent isolation contract
      // from PR #199).
      if ((ALL_AGENT_NAMES as readonly string[]).includes(agentName)) return [];
      // Unknown agent (e.g. OpenCode built-in "compaction" or "title"
      // that don't appear in the user preset): fall through to
      // model-matching so they can inherit a chain from a configured
      // agent that shares their model.
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
