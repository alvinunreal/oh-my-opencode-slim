import type { BackgroundJobBoard } from '../background-jobs';
import {
  isProcessRunning,
  type TuiReusableSession,
  updateSnapshot,
} from '../tui-state';

/**
 * Board → tui-state projection for sidebar session destinations and live
 * spinners. On every board mutation, publish terminal and stopped sessions
 * and attributed, certain running jobs (running entries contain only stable
 * taskID/alias plus a marker). The TUI is a pure reader of this section.
 *
 * Each parent section carries the publishing PID. Startup sweeps dead and
 * ownerless sections and failed same-process dispose retractions; live
 * same-PID projections survive. Concurrent writers to the same parent
 * are last-writer-wins; SIGKILL residue survives until the next startup.
 *
 * Cost: O(all jobs) per mutation. `updateSnapshot` early-outs when stable
 * projection fields do not change, so heartbeats do not write the file.
 */

// Retry parent sections whose removal failed when a projection was disposed.
const unretractedParents = new Map<string, Set<string>>();

interface ProjectorHandle {
  /** Cancel the projection permanently (host teardown). */
  dispose(): void;
}

export function createTuiReusableProjection(input: {
  board: Pick<
    BackgroundJobBoard,
    | 'list'
    | 'sidebarHistoryByParentAgent'
    | 'addMutationListener'
    | 'removeMutationListener'
  >;
  projectDir: string;
}): ProjectorHandle {
  const { board, projectDir } = input;
  let disposed = false;
  let ownedParents = new Set<string>();

  const unretracted = unretractedParents.get(projectDir);
  updateSnapshot(projectDir, (snapshot) => {
    for (const parent of Object.keys(snapshot.reusableByAgent)) {
      const owner = snapshot.reusableOwners[parent];
      if (
        owner === undefined ||
        (owner === process.pid && unretracted?.has(parent)) ||
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
    else {
      // A successful live publish supersedes a failed dispose retraction.
      const pending = unretractedParents.get(projectDir);
      for (const parent of nextOwnedParents) pending?.delete(parent);
    }
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
      } else {
        const pending = unretractedParents.get(projectDir) ?? new Set<string>();
        for (const parent of ownedParents) pending.add(parent);
        unretractedParents.set(projectDir, pending);
      }
    },
  };
}
