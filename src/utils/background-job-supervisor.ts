import type {
  BackgroundJobBoard,
  BackgroundJobLease,
  BackgroundJobRecord,
} from './background-job-board';
import { log } from './logger';

/** Platform timer handle; fake harnesses may return bare numeric ids. */
type TimerHandle = Timer;

export interface BackgroundJobSupervisorOptions {
  backgroundJobBoard: BackgroundJobBoard;
  wallClockTimeoutMs: number;
  /**
   * The host primitive `task_cancel` sends: `client.session.abort({ path: { id } })`.
   * The watchdog only triggers it; the host's own terminal evidence publishes the row.
   */
  abort: (taskID: string) => Promise<unknown>;
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
}

interface RunTimer {
  generation: number;
  runStartedAt: number;
  parentSessionID: string;
  /** Held only across the abort request, so a racing cancel cannot double-abort. */
  abortLease?: BackgroundJobLease;
  deadlineTimer?: TimerHandle;
}

/**
 * One-shot wall-clock watchdog for native background task sessions.
 *
 * The host offers no live-hang timeout, so this is the only thing that
 * eventually stops a hung background child. It owns timer/generation/abort
 * mechanics ONLY: on expiry it asks the host to stop the child through the
 * same lease-guarded abort `task_cancel` uses, then drops the timer. It never
 * writes terminal state — the host's real aborted terminal flows through the
 * terminal gate's evidence path like any other outcome.
 */
export class BackgroundJobSupervisor {
  private readonly now: () => number;
  private readonly setTimer: (
    callback: () => void,
    delay: number,
  ) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly runs = new Map<string, RunTimer>();
  private disposed = false;

  constructor(private readonly options: BackgroundJobSupervisorOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
  }

  /** Register the first observation of a launch or an explicit new run. */
  onLaunch(record: BackgroundJobRecord): void {
    if (this.disposed || record.background !== true) {
      this.clear(record.taskID);
      return;
    }
    if (this.options.wallClockTimeoutMs <= 0 || record.state !== 'running') {
      this.clear(record.taskID);
      return;
    }

    const current = this.runs.get(record.taskID);
    if (
      current?.generation === record.generation &&
      current.runStartedAt === record.runStartedAt
    )
      return;
    this.clear(record.taskID);

    const run: RunTimer = {
      generation: record.generation,
      runStartedAt: record.runStartedAt,
      parentSessionID: record.parentSessionID,
    };
    run.deadlineTimer = this.setTimer(
      () => this.onDeadline(record.taskID, record.generation),
      Math.max(
        0,
        record.runStartedAt + this.options.wallClockTimeoutMs - this.now(),
      ),
    );
    this.runs.set(record.taskID, run);
  }

  /** Clear one-shot timers after any canonical terminal publication. */
  onTerminal(record: BackgroundJobRecord): void {
    if (
      record.state === 'completed' ||
      record.state === 'error' ||
      record.state === 'cancelled' ||
      record.state === 'stopped' ||
      record.state === 'reconciled'
    ) {
      const run = this.runs.get(record.taskID);
      if (run?.generation === record.generation) this.clear(record.taskID);
    }
  }

  /** A child deletion invalidates the run; no terminal is invented. */
  onSessionDeleted(taskID: string): void {
    this.clear(taskID);
  }

  drop(taskID: string): void {
    this.clear(taskID);
  }

  clearParent(parentSessionID: string): void {
    for (const [taskID] of this.runs) {
      if (this.runs.get(taskID)?.parentSessionID === parentSessionID) {
        this.clear(taskID);
      }
    }
  }

  /** Idempotent local cleanup. It never aborts or writes terminal state. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const taskID of this.runs.keys()) this.clear(taskID);
    this.runs.clear();
  }

  private onDeadline(taskID: string, generation: number): void {
    const run = this.runs.get(taskID);
    if (this.disposed || !run || run.generation !== generation) return;
    run.deadlineTimer = undefined;

    // The same ownership primitive task_cancel acquires: while it is held no
    // other operation can abort, message, or relaunch this child. An occupied
    // lease means that operation owns the child and will produce its own
    // terminal, so the watchdog stands down.
    const lease = this.options.backgroundJobBoard.acquireLease(
      taskID,
      generation,
      'cancellation',
    );
    if (!lease) {
      this.clear(taskID);
      return;
    }
    run.abortLease = lease;

    // A rejected or hanging SDK promise must never escape the watchdog. The
    // lease is held only for the abort's duration: releasing it afterwards
    // keeps cancel/relaunch ownership available while the host's terminal
    // evidence is still in flight.
    Promise.resolve()
      .then(() => this.options.abort(taskID))
      .catch((error) => {
        log(
          '[background-job-supervisor] wall-clock abort failed',
          String(error),
        );
      })
      .finally(() => {
        const active = this.runs.get(taskID);
        if (active === run) active.abortLease = undefined;
        // Harmless when clear() already released it: token mismatch refuses.
        this.options.backgroundJobBoard.releaseLease(lease);
      });
  }

  private clear(taskID: string): void {
    const run = this.runs.get(taskID);
    if (!run) return;
    if (run.deadlineTimer !== undefined) this.clearTimer(run.deadlineTimer);
    if (run.abortLease !== undefined)
      this.options.backgroundJobBoard.releaseLease(run.abortLease);
    this.runs.delete(taskID);
  }
}
