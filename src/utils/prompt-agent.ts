/**
 * Single source of truth for the `agent` field on plugin-initiated prompts.
 *
 * Background and measured evidence:
 * `docs/agents/build-agent-empty-input-diagnosis.md` (see "Empirical
 * confirmation", probe A2).
 *
 * When a `session.prompt` / `session.promptAsync` body omits `agent`, OpenCode
 * resolves the agent with `agents.defaultInfo()` (`agent/agent.ts:328-340`),
 * which returns the first visible primary agent — the built-in `build` agent
 * whenever `default_agent` is unset, user-overridden, or not applied. OpenCode
 * then compares the resolved agent against the session's current agent and
 * calls `sessions.setAgentModel()` when they differ
 * (`session/prompt.ts:672-689`), which **permanently rewrites the session's
 * agent**. Probe A2 confirms the rewrite lands immediately on accept (HTTP
 * 204, before generation starts) and persists: a `probe-sub` child session
 * became `build` for every later turn. A single agent-less prompt therefore
 * hijacks the rest of that session.
 *
 * Every plugin-initiated prompt must name its agent explicitly: resolve it
 * with {@link resolveSessionAgent} and attach it with {@link withAgent}.
 * `src/utils/prompt-agent.test.ts` scans `src/` and fails the build if a new
 * prompt call site forgets.
 */

import type { PluginInput } from '@opencode-ai/plugin';
import { log } from './logger';

type OpencodeClient = PluginInput['client'];

/**
 * Agent used when the target session's own agent cannot be determined.
 *
 * Only valid for top-level (no `parentID`) sessions: those are the
 * orchestrator's in omos (the plugin sets `default_agent: 'orchestrator'`),
 * and `orchestrator` is in `PROTECTED_AGENTS` (`src/config/constants.ts`) so
 * it is always registered and can never be disabled by user config. Child
 * (subagent) sessions get `undefined` instead — guessing `orchestrator` for a
 * subagent session would rewrite that session's agent, which is the same class
 * of bug this helper exists to prevent.
 */
export const FALLBACK_TOP_LEVEL_AGENT = 'orchestrator';

/**
 * Fallback for sessions the *plugin itself* created as throwaway helpers
 * (e.g. smartfetch's secondary-model session).
 *
 * Never use {@link FALLBACK_TOP_LEVEL_AGENT} for those: a message tagged
 * `orchestrator` makes the task-session-manager adopt the helper as a managed
 * orchestrator session (`registerSessionAsOrchestrator`, reached from any
 * `agent: 'orchestrator'` message), which then attracts phase reminders,
 * post-tool nudges, background job board injection, companion busy/idle flips,
 * and the orchestrator system prompt — billed on every helper turn. `build` is
 * a core agent that is always registered (`omo` only disables conflicting
 * built-ins and explicitly preserves `build`/`plan`, see
 * `src/cli/config-io.ts` `disableDefaultAgents`) and no plugin hook keys off
 * it.
 */
export const FALLBACK_HELPER_SESSION_AGENT = 'build';

/** Agent names are plain identifiers; anything else would 400 the prompt. */
const AGENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * OpenCode's internal primary agents. They are real, registered, promptable
 * primaries (`GET /agent`: `compaction(primary), summary(primary),
 * title(primary)`), and
 * core writes their output into the *user's own session* — a native compaction
 * lands an assistant message tagged `agent: 'compaction'` in the live session.
 *
 * Observing one must never make the plugin prompt as one: that would re-home
 * the user's session to `compaction`/`summary`/`title` — the same durable
 * rewrite this module exists to prevent. Derived candidates matching this set
 * are skipped in favour of the next candidate or the fallback agent.
 */
export const SYSTEM_AGENTS: ReadonlySet<string> = new Set([
  'compaction',
  'summary',
  'title',
]);

export interface ResolveSessionAgentOptions {
  /**
   * Agent the plugin already recorded for this session (e.g. from
   * `SessionMetadataStore`, `message.updated`, or the job board record).
   * Trusted first because it needs no round trip, but still filtered through
   * {@link normalizeAgentHint} so an observed {@link SYSTEM_AGENTS} name can
   * never be prompted with.
   */
  hint?: string | undefined;
  /**
   * Caller guarantees the session may take the fallback agent without
   * corrupting a real subagent identity — either a genuinely top-level session
   * or one the plugin created itself. Used only when the session cannot be
   * inspected (older runtime, offline client, or `probe: false`).
   */
  assumeTopLevel?: boolean;
  /**
   * Query the server for the session/message agent. Defaults to `true`. Pass
   * `false` for sessions the plugin just created (no history to read) or when
   * the caller already has an authoritative hint.
   */
  probe?: boolean;
  /**
   * Override the top-level fallback agent. Defaults to
   * {@link FALLBACK_TOP_LEVEL_AGENT} (correct for real user sessions);
   * plugin-created helper sessions must pass
   * {@link FALLBACK_HELPER_SESSION_AGENT}.
   */
  fallbackAgent?: string;
  /**
   * Project directory for the probe reads, forwarded as `query.directory`.
   *
   * Every other `session.get`/`session.messages` call site in the repo passes
   * it (`utils/session.ts`, `hooks/orchestrator-wake`, `tools/cancel-task`);
   * omitting it makes a multi-directory host resolve the session against the
   * wrong project and answer "not found", which here degrades silently into
   * an unresolved agent.
   */
  directory?: string;
}

function normalizeAgentName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || !AGENT_NAME_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Normalize an *observed* agent name (session record, message history, plugin
 * hint) into one that is safe to prompt with, rejecting {@link SYSTEM_AGENTS}.
 *
 * Use this for every derived value. Explicit `fallbackAgent` values and
 * {@link withAgent} deliberately skip the denylist: omitting the field is
 * worse than any valid name, because OpenCode then resolves its default
 * primary and rewrites the session agent anyway.
 */
export function normalizeAgentHint(value: unknown): string | undefined {
  const normalized = normalizeAgentName(value);
  if (!normalized || SYSTEM_AGENTS.has(normalized)) return undefined;
  return normalized;
}

/** Unwrap `{ data }` SDK envelopes; some call styles return the value raw. */
function unwrapData(response: unknown): unknown {
  if (!response || typeof response !== 'object') return undefined;
  const envelope = response as { data?: unknown };
  return envelope.data !== undefined ? envelope.data : response;
}

/**
 * Read an agent name off a session or message record.
 *
 * The runtime puts `agent` on `Session`-adjacent records and on both message
 * roles; older assistant messages carried the agent name in `mode`. Neither
 * field is in the plugin's declared SDK types even though the installed
 * runtime returns them, hence the unknown-shaped reads.
 */
function readAgentName(record: unknown): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const shape = record as { agent?: unknown; mode?: unknown };
  return normalizeAgentHint(shape.agent) ?? normalizeAgentHint(shape.mode);
}

/**
 * Agent a *user* message requested, or `undefined` for any other role.
 *
 * Only user messages are trusted: they carry the agent the turn was addressed
 * to (`docs/agents/build-agent-empty-input-diagnosis.md`, probe A2 per-message
 * attribution), whereas assistant messages report whichever agent *served*
 * the turn — including core's internal `compaction`/`summary`/`title`
 * primaries writing into the user's own session, and including `build` in a
 * session this very bug already re-homed.
 */
function readUserMessageAgent(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const record = entry as { info?: unknown; role?: unknown };
  const info =
    record.info && typeof record.info === 'object' ? record.info : record;
  if ((info as { role?: unknown }).role !== 'user') return undefined;
  return readAgentName(info);
}

async function safely<T>(
  operation: () => Promise<T> | T,
): Promise<T | undefined> {
  try {
    return await operation();
  } catch {
    return undefined;
  }
}

/**
 * Best-effort resolution of the agent a session is currently running under.
 *
 * Resolution order:
 *   1. `options.hint` (plugin-recorded agent — no round trip)
 *   2. `client.session.get()` → `agent`
 *   3. newest **user** `client.session.messages()` entry → `agent` (or legacy
 *      `mode`); assistant messages are ignored because they report whichever
 *      agent *served* a turn, which after a native compaction is core's
 *      `compaction` primary
 *   4. `options.fallbackAgent` (default {@link FALLBACK_TOP_LEVEL_AGENT}), but
 *      only for a session known (or declared via `assumeTopLevel`) to have no
 *      `parentID`
 *
 * Candidates in {@link SYSTEM_AGENTS} are skipped at every derived step.
 *
 * Returns `undefined` only when nothing could be resolved for a session that
 * is not known to be top-level. Callers then omit `agent` — no better option
 * exists, and inventing one would rewrite a subagent session's agent.
 */
export async function resolveSessionAgent(
  client: OpencodeClient,
  sessionId: string,
  options: ResolveSessionAgentOptions = {},
): Promise<string | undefined> {
  const hint = normalizeAgentHint(options.hint);
  if (hint) return hint;

  const fallbackAgent =
    normalizeAgentName(options.fallbackAgent) ?? FALLBACK_TOP_LEVEL_AGENT;
  // undefined = unknown, true = child session, false = confirmed top-level
  let hasParent: boolean | undefined;

  if (options.probe !== false && sessionId) {
    const sessionApi = client.session as {
      get?: (args: {
        path: { id: string };
        query?: { directory: string };
      }) => Promise<unknown>;
      messages?: (args: {
        path: { id: string };
        query?: { directory: string };
      }) => Promise<unknown>;
    };
    const probeArgs = {
      path: { id: sessionId },
      ...(options.directory ? { query: { directory: options.directory } } : {}),
    };

    if (typeof sessionApi.get === 'function') {
      const info = unwrapData(await safely(() => sessionApi.get?.(probeArgs)));
      const fromSession = readAgentName(info);
      if (fromSession) return fromSession;
      if (info && typeof info === 'object') {
        const parentID = (info as { parentID?: unknown }).parentID;
        hasParent = typeof parentID === 'string' && parentID.length > 0;
      }
    }

    if (typeof sessionApi.messages === 'function') {
      const list = unwrapData(
        await safely(() => sessionApi.messages?.(probeArgs)),
      );
      if (Array.isArray(list)) {
        for (let index = list.length - 1; index >= 0; index--) {
          const fromMessage = readUserMessageAgent(list[index]);
          if (fromMessage) return fromMessage;
        }
      }
    }
  }

  // A probe result always wins over the caller's assumption.
  const topLevel =
    hasParent === undefined ? options.assumeTopLevel === true : !hasParent;
  if (topLevel) {
    log('[prompt-agent] falling back to top-level agent', {
      sessionId,
      fallbackAgent,
    });
    return fallbackAgent;
  }

  log('[prompt-agent] unable to resolve session agent', { sessionId });
  return undefined;
}

/**
 * Attach a resolved agent to a prompt body.
 *
 * Keeps the "which agent?" decision out of the call site and gives the
 * regression scan a single recognisable shape. When `agent` is `undefined`
 * (unresolvable child session) the field is omitted rather than guessed.
 */
export function withAgent<T extends object>(
  body: T,
  agent: string | undefined,
): T & { agent?: string } {
  const normalized = normalizeAgentName(agent);
  return normalized ? { ...body, agent: normalized } : { ...body };
}
