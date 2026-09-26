import {
  isProcessRunning,
  type TuiReusableSession,
  updateSnapshot,
} from '../tui-state';
import type { BackgroundJobBoard } from './background-job-board';

/**
 * Board → tui-state projection for sidebar session destinations and live
 * spinners. On every board mutation, publish all canonical terminal sessions
 * and attributed, certain running jobs (running entries contain only stable
 * taskID/alias plus a marker). The TUI is a pure reader of this section.
 *
 * Each parent section carries the publishing PID. Startup sweeps dead,
 * ownerless, and same-PID inherited sections (SIGKILL residue lasts until
 * that sweep). Other live processes survive for different parents;
 * concurrent writers to the same parent are last-writer-wins.
 *
 * Cost: O(all jobs) per mutation. `updateSnapshot` early-outs when stable
 * projection fields do not change, so heartbeats do not write the file.
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
  let ownedParents = new Set<string>();

  // A new board supersedes sections left by an earlier run in this PID.
  // Sections belonging to other live processes survive startup.
  updateSnapshot(projectDir, (snapshot) => {
    for (const parent of Object.keys(snapshot.reusableByAgent)) {
      const owner = snapshot.reusableOwners[parent];
      if (
        owner === undefined ||
        owner === process.pid ||
        !isProcessRunning(owner)
      ) {
        delete snapshot.reusableByAgent[parent];
        delete snapshot.reusableOwners[parent];
      }
    }
  });

  const project = (): void => {
    if (disposed) return;
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
    const previousOwnedParents = ownedParents;
    const nextOwnedParents = new Set(Object.keys(next));
    const applied = updateSnapshot(projectDir, (snapshot) => {
      for (const parent of previousOwnedParents) {
        if (
          next[parent] === undefined &&
          snapshot.reusableOwners[parent] === process.pid
        ) {
          delete snapshot.reusableByAgent[parent];
          delete snapshot.reusableOwners[parent];
        }
      }
      for (const [parent, byAgent] of Object.entries(next)) {
        snapshot.reusableByAgent[parent] = byAgent;
        snapshot.reusableOwners[parent] = process.pid;
      }
      ownedParents = nextOwnedParents;
    });
    // The optimistic no-op probe also invokes the mutator. Retain the old
    // ownership when the subsequent lock or disk write fails.
    if (!applied) ownedParents = previousOwnedParents;
  };

  const listener = (): void => {
    try {
      project();
    } catch {
      // Best-effort: a projection failure must never break the board.
    }
  };

  board.addMutationListener(listener);

  // Publish this board's parents without replacing other live owners.
  listener();

  return {
    dispose() {
      if (!disposed) {
        disposed = true;
        board.removeMutationListener(listener);
      }
      if (ownedParents.size === 0) return;
      if (
        updateSnapshot(projectDir, (snapshot) => {
          for (const parent of ownedParents) {
            if (snapshot.reusableOwners[parent] !== process.pid) continue;
            delete snapshot.reusableByAgent[parent];
            delete snapshot.reusableOwners[parent];
          }
        })
      ) {
        ownedParents.clear();
      }
    },
  };
}
