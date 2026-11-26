/**
 * Emergency kill-all for the running subagents of the visible conversation.
 * OpenCode publishes resulting child status through its normal event stream.
 */
import type { OpencodeClient } from '@opencode-ai/sdk';
import { getSidebarAgentTargets } from './tui';
import { resolveTuiSnapshotRoot, type TuiSnapshot } from './tui-state';
import { log } from './utils/logger';
import {
  abortSessionWithTimeout,
  SESSION_ABORT_TIMEOUT_MS,
  sessionAbortFailure,
  withTimeout,
} from './utils/session';
import type { TimerSeam } from './utils/timer-seam';

export const KILL_ALL_COMMAND_ID = 'omo.kill_all';
const KILL_ALL_STOP_NOTICE =
  "User stopped all running subagents (emergency stop). Don't relaunch or retry them; ask how to proceed.";

/**
 * Verified free against the host defaults (packages/tui/src/config/keybind.ts
 * binds only plain `escape`; no shift-modified binding exists) and it is not
 * plain escape, so it never shadows session interrupt. Deliberately not
 * configurable for now: emergency feature kept minimal per maintainer
 * decision.
 */
export const KILL_ALL_KEYBIND = 'alt+w';

/** One kill attempt outcome; feeds the summary toast. */
export interface KillAllResult {
  killed: number;
  failed: number;
  total: number;
}

/** Sessions the kill-all targets: subagents of the visible conversation
 *  with an active status (busy/retry — the only statuses TuiSnapshot keeps). */
export function getKillAllTargets(
  snapshot: TuiSnapshot,
  visibleSessionID?: string,
): string[] {
  const root =
    visibleSessionID === undefined
      ? undefined
      : resolveTuiSnapshotRoot(snapshot, visibleSessionID);
  return getSidebarAgentTargets(snapshot, visibleSessionID).flatMap((group) =>
    group.sessions
      .filter(
        (session) =>
          // The conversation root itself is never a target: real
          // tui-state data has carried self-referencing parent entries,
          // and killing the main session would abort the orchestrator,
          // not a subagent.
          (session.status === 'busy' || session.status === 'retry') &&
          session.sessionID !== root,
      )
      .map((session) => session.sessionID),
  );
}

/**
 * Abort every running subagent of the visible conversation. The stop notice
 * to each direct parent is admitted (or times out) before any interrupt,
 * because the host wakes a parent as soon as a child's cancellation lands.
 * Fail-soft:
 * one failing abort never stops the others (each gets its own
 * abortSessionWithTimeout with the standard 1s cap). Returns the counts
 * the caller toasts; never throws.
 */
export async function killAllRunningSubagents(
  client: unknown,
  snapshot: TuiSnapshot,
  visibleSessionID?: string,
  directory?: string,
  timers?: TimerSeam,
): Promise<KillAllResult> {
  const targets = getKillAllTargets(snapshot, visibleSessionID);
  if (targets.length === 0) return { killed: 0, failed: 0, total: 0 };
  const rec = client as
    | {
        app?: { agents?: unknown };
        session?: {
          abort?: (args: Record<string, unknown>) => Promise<unknown>;
          interrupt?: (args: Record<string, unknown>) => Promise<unknown>;
          synthetic?: (args: Record<string, unknown>) => Promise<unknown>;
        };
      }
    | undefined;
  const session = rec?.session;
  if (
    typeof session?.interrupt === 'function' &&
    typeof session.synthetic === 'function'
  ) {
    const synthetic = session.synthetic.bind(session);
    const parents = new Set(targets.map((id) => snapshot.sessionParents[id]));
    await Promise.all(
      [...parents].map(async (sessionID) => {
        try {
          await withTimeout(
            synthetic({
              sessionID,
              text: KILL_ALL_STOP_NOTICE,
              delivery: 'steer',
              resume: false,
            }),
            SESSION_ABORT_TIMEOUT_MS,
            `Stop notice timed out after ${SESSION_ABORT_TIMEOUT_MS}ms`,
            timers,
          );
        } catch (error) {
          log(
            `[tui-kill] stop notice failed for ${sessionID}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );
  }
  const outcomes = await Promise.all(
    targets.map(async (sessionID) => {
      try {
        // The host interrupt and both SDK abort shapes share timeout and failure handling.
        if (typeof rec?.session?.interrupt === 'function') {
          const result = await withTimeout(
            rec.session.interrupt({ sessionID, resume: false }),
            SESSION_ABORT_TIMEOUT_MS,
            `Session interrupt timed out after ${SESSION_ABORT_TIMEOUT_MS}ms`,
            timers,
          );
          const failure = sessionAbortFailure(result);
          if (failure) throw new Error(failure);
        } else if (
          rec &&
          'v2' in rec &&
          typeof rec.session?.abort === 'function'
        ) {
          const result = await withTimeout(
            rec.session.abort({
              sessionID,
              ...(directory ? { directory } : {}),
            }),
            SESSION_ABORT_TIMEOUT_MS,
            `Session abort timed out after ${SESSION_ABORT_TIMEOUT_MS}ms`,
          );
          const failure = sessionAbortFailure(result);
          if (failure) throw new Error(failure);
        } else if (typeof rec?.session?.abort === 'function') {
          await abortSessionWithTimeout(
            rec as unknown as OpencodeClient,
            sessionID,
          );
        } else {
          throw new Error('client does not expose session interrupt or abort');
        }
        return true;
      } catch (error) {
        // The toast points at the plugin log, so every per-session
        // failure lands here with the session id and the cause.
        log(
          `[tui-kill] abort failed for ${sessionID}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      }
    }),
  );
  const killed = outcomes.filter(Boolean).length;
  return { killed, failed: outcomes.length - killed, total: targets.length };
}

/** Toast text for a kill-all result (also the empty case). */
export function killAllSummaryMessage(result: KillAllResult): string {
  if (result.total === 0) {
    return 'No running subagents in this conversation.';
  }
  const base = `Kill-all sent to ${result.total} running subagent${result.total === 1 ? '' : 's'}`;
  return result.failed > 0
    ? `${base} (${result.failed} failed — see plugin log).`
    : `${base}.`;
}
