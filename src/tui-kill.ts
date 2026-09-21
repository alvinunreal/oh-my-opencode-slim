/**
 * Emergency kill-all for the running subagents of the visible conversation.
 *
 * Pure helper shared by the v1 (`api.command`, src/tui.ts) and v2
 * (keymap layer, src/v2/tui.ts) TUI surfaces: it only resolves targets and
 * issues aborts. Post-kill reconciliation is entirely the existing event
 * pipeline's job (event-router → idle-reconciler → board → tui-state.json);
 * this file never writes state, polls, or invents a 'cancelled' status.
 */
import type { OpencodeClient } from '@opencode-ai/sdk';
import { getSidebarAgentTargets } from './tui';
import type { TuiSnapshot } from './tui-state';
import { log } from './utils/logger';
import {
  abortSessionWithTimeout,
  SESSION_ABORT_TIMEOUT_MS,
  sessionAbortFailure,
  withTimeout,
} from './utils/session';

export const KILL_ALL_COMMAND_ID = 'omo.kill_all';

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
  visibleRootID?: string,
): string[] {
  return getSidebarAgentTargets(snapshot, visibleRootID).flatMap((group) =>
    group.sessions
      .filter(
        (session) =>
          // The conversation root itself is never a target: real
          // tui-state data has carried self-referencing parent entries,
          // and killing the main session would abort the orchestrator,
          // not a subagent.
          (session.status === 'busy' || session.status === 'retry') &&
          session.sessionID !== visibleRootID,
      )
      .map((session) => session.sessionID),
  );
}

/**
 * Abort every running subagent of the visible conversation. Fail-soft:
 * one failing abort never stops the others (each gets its own
 * abortSessionWithTimeout with the standard 1s cap). Returns the counts
 * the caller toasts; never throws.
 */
export async function killAllRunningSubagents(
  client: unknown,
  snapshot: TuiSnapshot,
  visibleRootID?: string,
  directory?: string,
): Promise<KillAllResult> {
  const targets = getKillAllTargets(snapshot, visibleRootID);
  if (targets.length === 0) return { killed: 0, failed: 0, total: 0 };
  const rec = client as
    | {
        app?: { agents?: unknown };
        session?: {
          abort?: (args: Record<string, unknown>) => Promise<unknown>;
        };
      }
    | undefined;
  const outcomes = await Promise.all(
    targets.map(async (sessionID) => {
      try {
        // Dual client shape: both SDK v1 and v2 expose app.agents and
        // session.abort as members, so neither discriminates. The only
        // exclusive signal is the `v2` accessor, which exists on the v2
        // SDK root and not on v1. v2 takes flat { sessionID, directory }
        // params; v1 takes nested { path } through
        // abortSessionWithTimeout. Both share the same timeout cap and
        // the same envelope validation: the SDKs resolve (rather than
        // reject) rejected aborts, so the response must be inspected
        // before counting the kill.
        if (rec && 'v2' in rec && typeof rec.session?.abort === 'function') {
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
          throw new Error('client does not expose session.abort');
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
