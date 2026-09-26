import { type TuiReusableSession, updateSnapshot } from '../tui-state';
import type { BackgroundJobBoard } from './background-job-board';

/**
 * Board → tui-state projection for the sidebar's reusable dot (#1197
 * follow-up). On every board mutation (set/delete/trim/drop — the
 * listener is intentionally payload-less), re-derive the latest
 * reconciled session per agent for every parent the board knows and
 * persist it into the snapshot's `reusableByAgent` section. The TUI is a
 * pure reader of this section; it never writes it.
 *
 * The board is the parent index (each record carries parentSessionID);
 * parents whose records are all gone drop out of the derivation. The
 * board is process-local, so this section must never be restored from a
 * stale file — the creation sweep clears it and the projection
 * repopulates from the live board.
 *
 * Cost: O(all jobs) per mutation. `updateSnapshot` early-outs when the
 * derived section is unchanged, so no-op mutations (e.g. heartbeat
 * status updates) never touch the filesystem.
 */

interface ProjectorHandle {
  /** Cancel the projection permanently (host teardown). */
  dispose(): void;
}

export function createTuiReusableProjection(input: {
  board: BackgroundJobBoard;
  projectDir: string;
}): ProjectorHandle {
  const { board, projectDir } = input;
  let disposed = false;

  const project = (): void => {
    if (disposed) return;
    updateSnapshot(projectDir, (snapshot) => {
      const next: Record<string, Record<string, TuiReusableSession[]>> = {};
      for (const [parent, byAgent] of board.sidebarHistoryByParentAgent()) {
        next[parent] = Object.fromEntries(byAgent);
      }
      for (const job of board.list()) {
        if (job.state !== 'running' || job.provisional || job.statusUncertain) {
          continue;
        }
        const byAgent = next[job.parentSessionID] ?? {};
        const sessions = byAgent[job.agent] ?? [];
        sessions.unshift({
          taskID: job.taskID,
          alias: job.alias,
          running: true,
        });
        byAgent[job.agent] = sessions;
        next[job.parentSessionID] = byAgent;
      }
      snapshot.reusableByAgent = next;
    });
  };

  const listener = (): void => {
    try {
      project();
    } catch {
      // Best-effort: a projection failure must never break the board.
    }
  };

  board.addMutationListener(listener);

  // The board is process-local (board = store): any section persisted
  // by a previous host process is stale by construction. Clear it once
  // at creation so dead dots can never survive a host restart, even if
  // no board mutation ever follows.
  listener();

  return {
    dispose() {
      disposed = true;
      board.removeMutationListener(listener);
    },
  };
}
