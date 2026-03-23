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
 * This mirrors the BackgroundTaskManager's fallback loop but operates
 * reactively through the event system instead of wrapping prompt() in a
 * try/catch, which is not possible for interactive (foreground) sessions.
 */

import type { PluginInput } from '@opencode-ai/plugin';
import { log } from '../../utils/logger';

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
  /usage limit/i,
  /overloaded/i,
  /resource.?exhausted/i,
  /insufficient.?quota/i,
  /high concurrency/i,
  /reduce concurrency/i,
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

function parseModel(
  model: string,
): { providerID: string; modelID: string } | null {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash >= model.length - 1) return null;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/** Prevent re-triggering within this window for the same session. */
const DEDUP_WINDOW_MS = 5_000;

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * Manages runtime model fallback for foreground agent sessions.
 *
 * Constructed at plugin init with the ordered fallback chains for each agent
 * (built from _modelArray entries merged with fallback.chains config).
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
          this.sessionModel.set(sessionID, `${info.providerID}/${info.modelID}`);
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
      const currentModel = this.sessionModel.get(sessionID);
      const agentName = this.sessionAgent.get(sessionID);
      const chain = this.resolveChain(agentName, currentModel);
      if (!chain.length) {
        log('[foreground-fallback] no chain configured', { sessionID, agentName });
        return;
      }

      if (!this.sessionTried.has(sessionID)) {
        this.sessionTried.set(sessionID, new Set());
      }
      const tried = this.sessionTried.get(sessionID)!;
      if (currentModel) tried.add(currentModel);

      const nextModel = chain.find((m) => !tried.has(m));
      if (!nextModel) {
        log('[foreground-fallback] fallback chain exhausted', {
          sessionID,
          agentName,
          tried: [...tried],
        });
        return;
      }
      tried.add(nextModel);

      const ref = parseModel(nextModel);
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
      const messages = (result.data ?? []) as Array<{
        info: { role: string };
        parts: unknown[];
      }>;
      const lastUser = [...messages]
        .reverse()
        .find((m) => m.info.role === 'user');
      if (!lastUser) {
        log('[foreground-fallback] no user message found', { sessionID });
        return;
      }

      // Abort the currently rate-limited prompt so the session becomes idle.
      try {
        await this.client.session.abort({ path: { id: sessionID } });
      } catch {
        // Session may already be idle; safe to ignore.
      }

      // Give the server a moment to finalise the abort before re-prompting.
      await new Promise((r) => setTimeout(r, 500));

      // promptAsync queues the prompt and returns immediately — this avoids
      // blocking the event handler while waiting for a full LLM response.
      // Cast required: promptAsync is not in the plugin TypeScript types for
      // oh-my-opencode-slim but IS present on the real OpenCode client at
      // runtime (verified by opencode-rate-limit-fallback reference impl).
      const sessionClient = this.client.session as unknown as {
        promptAsync: (args: {
          path: { id: string };
          body: {
            parts: unknown[];
            model: { providerID: string; modelID: string };
          };
        }) => Promise<unknown>;
      };
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
   * 1. Agent name known → return that agent's chain directly
   * 2. Agent name unknown → search all chains for the current model
   * 3. Nothing matches → flatten all chains as a last resort
   */
  private resolveChain(
    agentName: string | undefined,
    currentModel: string | undefined,
  ): string[] {
    if (agentName) {
      const chain = this.chains[agentName];
      if (chain?.length) return chain;
    }

    if (currentModel) {
      for (const chain of Object.values(this.chains)) {
        if (chain.includes(currentModel)) return chain;
      }
    }

    // Last resort: merged list across all agents preserving insertion order.
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
