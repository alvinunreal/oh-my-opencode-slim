/**
 * Single source of truth for the `agent` field on plugin-initiated prompts.
 *
 * Resolve and name the session's owning agent with {@link resolveSessionAgent}
 * and {@link withAgent}. An agent-less prompt in the shared factory convention
 * may select the host default instead. The V2 adapter treats a name as an
 * identity assertion, never a selection override (see src/v2/codemap.md).
 * prompt-agent.test.ts guards the prompt call sites.
 */

import type { PluginInput } from '@opencode-ai/plugin';
import { log } from './logger';
import { withTimeout } from './session';

export type OpencodeClient = PluginInput['client'];

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
 * are never eligible for helper sessions.
 */
export const SYSTEM_AGENTS: ReadonlySet<string> = new Set([
  'compaction',
  'summary',
  'title',
]);

export interface ResolveSessionAgentOptions {
  /**
   * Agent the plugin already recorded for this session (e.g. from
   * `SessionMetadataStore` or `message.updated`).
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
   * {@link FALLBACK_TOP_LEVEL_AGENT} (correct for real user sessions).
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

/**
 * Unwrap SDK envelopes; some call styles return the value raw.
 *
 * An error envelope is not a raw session record. Treating
 * `{ data: undefined, error: ... }` as the record itself makes the caller see
 * an object with no parent and incorrectly establish parentlessness.
 */
function unwrapData(response: unknown): unknown {
  if (!response || typeof response !== 'object') return undefined;
  const envelope = response as { data?: unknown; error?: unknown };
  if (
    'error' in envelope &&
    envelope.error !== undefined &&
    envelope.error !== null
  ) {
    return undefined;
  }
  if ('data' in envelope) return envelope.data;
  return response;
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
 * User messages carry the addressed agent. Assistant messages name the agent
 * that served the turn, which may be an auxiliary compaction, summary or
 * title agent rather than the session's owner.
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
    return await withTimeout(
      Promise.resolve(operation()),
      5_000,
      'Agent probe timed out',
    );
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
 * Returns `undefined` when the session is not positively known to be
 * parentless. Callers then suppress the prompt — no better option exists, and
 * inventing one would rewrite a subagent session's agent.
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
        query: { directory?: string; limit: number };
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
        const id = (info as { id?: unknown }).id;
        if (typeof parentID === 'string' && parentID.length > 0) {
          hasParent = true;
        } else if (typeof id === 'string' && id.length > 0) {
          // A usable session record without a parent is positive evidence of
          // a top-level session. Do not infer this from an error envelope or
          // an arbitrary object with no session identity.
          hasParent = false;
        }
      }
    }

    if (typeof sessionApi.messages === 'function') {
      const list = unwrapData(
        await safely(() =>
          sessionApi.messages?.({
            path: probeArgs.path,
            query: { ...probeArgs.query, limit: 50 },
          }),
        ),
      );
      if (Array.isArray(list)) {
        for (let index = list.length - 1; index >= 0; index--) {
          const fromMessage = readUserMessageAgent(list[index]);
          if (fromMessage) return fromMessage;
        }
      }
    }
  }

  // An attempted probe must positively establish parentlessness before the
  // fallback may be used. `assumeTopLevel` is only valid when probing is
  // explicitly disabled (for plugin-created sessions or an authoritative
  // caller guarantee); a failed or malformed probe must never guess.
  const topLevel =
    hasParent === false ||
    (options.probe === false && options.assumeTopLevel === true);
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
 * regression scan a single recognisable shape. Callers must suppress their
 * prompt when identity cannot be established; this boundary never emits an
 * agent-less body.
 */
export function withAgent<T extends object>(
  body: T,
  agent: string,
): T & { agent: string } {
  const normalized = normalizeAgentName(agent);
  if (!normalized) {
    throw new Error('Cannot create a prompt without a valid agent');
  }
  return { ...body, agent: normalized };
}
