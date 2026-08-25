import { log } from '../../utils/logger';

/**
 * Tool loop guard.
 *
 * Detects a session re-issuing the exact same tool call (same tool, same
 * arguments) consecutively with no change, which is how model-side infinite
 * loops present (see issue #1071: sub-agent repeating identical read/grep
 * calls forever).
 *
 * Behavior:
 * - N consecutive calls with identical arguments AND identical results
 *   (LOOP_GUARD_WARN_AT): append corrective text to the tool output telling
 *   the model to stop and change approach.
 * - For read-only file tools (READONLY_BLOCK_TOOLS), M consecutive calls
 *   with identical arguments AND identical results (LOOP_GUARD_BLOCK_AT):
 *   refuse the next identical call in tool.execute.before by throwing, so
 *   the loop terminates instead of running forever.
 * - The run counter only advances in tool.execute.after, when an identical-
 *   args call produced an output byte-identical to the prior call. A call
 *   that returns NEW information resets the run, so it can never accumulate
 *   toward a block (a legitimate re-read after the file changed).
 * - tool.execute.before never increments the counter, so overlapping
 *   parallel calls cannot inflate the count before their results are known.
 *   A refusal only happens after the run is already confirmed identical.
 *
 * Scope is deliberately narrow to avoid breaking legitimate repeated calls:
 * - All tools warn at N confirmed-identical consecutive calls.
 * - Only the read-only file-analysis tools hard-block: polling tools
 *   (task_*, wait_for_*) legitimately re-issue identical calls waiting on a
 *   long-running background task and must never be refused.
 * - The task tool is exempt entirely for both axes; task-session-manager
 *   owns its own duplicate-spawn guards (#1056/#1070).
 *
 * Precedent: json-error-recovery (output warning) and task-session-manager
 * (before-hook refusal).
 */

const LOOP_GUARD_WARN_AT = 3;
const LOOP_GUARD_BLOCK_AT = 5;

/**
 * Tools exempt from the entire guard: long-lived task supervision/polling
 * tools whose identical repeated invocation is legitimate.
 */
const LOOP_GUARD_EXEMPT: Record<string, true> = {
  task: true,
  task_status: true,
  task_result: true,
  task_cancel: true,
  task_message: true,
  task_revive: true,
  wait_for_user: true,
  wait_for_background_tasks: true,
};

/**
 * Tools that may be hard-blocked when repeated. Read-only file analysis is
 * the reported loop surface (#1071); anything with side effects or that
 * polls external state stays warn-only.
 */
const LOOP_GUARD_BLOCK_TOOLS: Record<string, true> = {
  read: true,
  grep: true,
  glob: true,
};

const LOOP_GUARD_MARKER = '[REPEATED TOOL CALLS - STOP]';

export const LOOP_GUARD_WARNING = `
${LOOP_GUARD_MARKER}

You have issued the exact same tool call with identical arguments ${LOOP_GUARD_WARN_AT} times in a row and received identical results. This is an infinite loop and you are making no progress.

STOP repeating this call. Instead:
1. Reconsider what you are looking for; the result above already contains what this call can tell you.
2. If you need different information, make a DIFFERENT call (different path, pattern, or tool).
3. If the task is actually done, produce your final answer now instead of calling more tools.
`;

/** Max sessions tracked before evicting the least-recently-observed session. */
const MAX_TRACKED_SESSIONS = 512;

/** Deterministic fingerprint of tool + args, insensitive to key order. */
function fingerprint(tool: string, args: unknown): string {
  return `${tool.toLowerCase()}:${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(',')}}`;
}

interface SessionState {
  /** Fingerprint of the most recent completed eligible call (args). */
  last: string;
  /** Consecutive completed calls with identical args AND identical output. */
  runs: number;
  /** Fingerprint of the most recent completed call's output. */
  lastOutput: string;
}

export interface ToolLoopGuardHook {
  'tool.execute.before': (
    input: { tool: string; sessionID?: string; callID?: string },
    output: { args?: unknown },
  ) => Promise<void>;
  'tool.execute.after': (
    input: { tool: string; sessionID?: string; callID?: string },
    output: { output: unknown; metadata?: unknown },
  ) => Promise<void>;
  resetSession(sessionID: string): void;
  resetForTests(): void;
}

export function createToolLoopGuardHook(): ToolLoopGuardHook {
  const sessions = new Map<string, SessionState>();
  /** Fingerprint per callID so `after` can re-check without re-deriving args. */
  const callKeys = new Map<string, string>();

  /** Prune the session map to MAX_TRACKED_SESSIONS (FIFO by insertion). */
  function keepSessionsBounded(): void {
    while (sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  }

  return {
    'tool.execute.before': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args?: unknown },
    ): Promise<void> => {
      const sessionID = input.sessionID;
      if (!sessionID) return;
      const tool = input.tool.toLowerCase();
      if (LOOP_GUARD_EXEMPT[tool]) return;

      const key = fingerprint(tool, output.args);
      const existing = sessions.get(sessionID);

      // Refuse only on a CONFIRMED identical run: the previous BLOCK_AT
      // calls all had identical args AND identical results. The current
      // call's result is not yet known, but the run is already degenerate.
      if (
        existing &&
        existing.last === key &&
        existing.runs >= LOOP_GUARD_BLOCK_AT &&
        LOOP_GUARD_BLOCK_TOOLS[tool]
      ) {
        log('[tool-loop-guard] blocked repeated tool call', {
          sessionID,
          tool,
          runs: existing.runs,
        });
        throw new Error(
          `Refusing to execute "${tool}": this exact call (same tool, same arguments) has returned identical results ${existing.runs} times in a row and constitutes an infinite loop. Stop repeating it. Reassess your goal, make a different call, or produce your final answer.`,
        );
      }

      if (input.callID) callKeys.set(input.callID, key);
    },

    'tool.execute.after': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { output: unknown; metadata?: unknown },
    ): Promise<void> => {
      const sessionID = input.sessionID;
      if (!sessionID) return;
      const tool = input.tool.toLowerCase();
      if (LOOP_GUARD_EXEMPT[tool]) return;

      const key = input.callID ? callKeys.get(input.callID) : undefined;
      if (input.callID) callKeys.delete(input.callID);
      const outputHash = fingerprint(tool, output.output);

      const existing = sessions.get(sessionID);
      let state: SessionState;
      if (existing && key !== undefined && key === existing.last) {
        // Identical args. Advance the run only when the result is also
        // identical; a changed result is progress and restarts the run.
        state = {
          last: key,
          runs: outputHash === existing.lastOutput ? existing.runs + 1 : 1,
          lastOutput: outputHash,
        };
      } else {
        // Different args or untracked call: start a fresh run.
        state = {
          last: key ?? `${tool}:<untracked>`,
          runs: 1,
          lastOutput: outputHash,
        };
      }
      sessions.set(sessionID, state);
      keepSessionsBounded();

      if (state.runs < LOOP_GUARD_WARN_AT) return;
      if (typeof output.output !== 'string') return;
      if (output.output.includes(LOOP_GUARD_MARKER)) return;
      log('[tool-loop-guard] warned repeated tool call', {
        sessionID,
        tool,
        runs: state.runs,
      });
      output.output += `\n${LOOP_GUARD_WARNING}`;
    },

    /** Clear all state for a finished/deleted session. */
    resetSession(sessionID: string): void {
      sessions.delete(sessionID);
    },

    /** Test seam: wipe state between cases. */
    resetForTests(): void {
      sessions.clear();
      callKeys.clear();
    },
  };
}
