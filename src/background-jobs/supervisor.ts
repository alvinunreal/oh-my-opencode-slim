import { log } from '../utils/logger';
import type { BackgroundJobBoardApi } from './board';
import type { BackgroundJobTerminalGate } from './terminal-gate';
import type { BackgroundJobRecord } from './types';

type TimerHandle = ReturnType<typeof setTimeout>;

/** Public supervision surface consumed through the lifecycle facade. */
export interface BackgroundJobSupervisor {
  /** Register the first observation of a launch or an explicit new run. */
  onLaunch(record: BackgroundJobRecord): void;
  /** Clear one-shot timers after any canonical terminal publication. */
  onTerminal(record: BackgroundJobRecord): void;
  /** Deletion fencing before the normal board drop callback. */
  onSessionDeleted(taskID: string): boolean;
  drop(taskID: string): void;
  clearParent(parentSessionID: string): void;
  /** Idempotent local cleanup. It never aborts or writes terminal state. */
  dispose(): void;
}

export interface BackgroundJobSupervisorOptions {
  backgroundJobStore: BackgroundJobBoardApi;
  terminalGate: BackgroundJobTerminalGate;
  wallClockTimeoutMs: number;
  abortGraceMs: number;
  abort: (taskID: string) => Promise<unknown>;
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
}

interface RunTimers {
  generation: number;
  parentSessionID: string;
  deadlineTimer?: TimerHandle;
  graceTimer?: TimerHandle;
}

/** Default one-shot wall-clock supervision for native background task
 * sessions. Internal implementation behind the BackgroundJobSupervisor
 * interface; in-package tests may construct it directly.
 *
 * This class owns only timer/generation/abort mechanics. The board/lifecycle
 * remains the atomic state and terminal-publication boundary.
 */
export class DefaultBackgroundJobSupervisor implements BackgroundJobSupervisor {
  private readonly now: () => number;
  private readonly setTimer: (
    callback: () => void,
    delay: number,
  ) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly runs = new Map<string, RunTimers>();
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
    if (current?.generation === record.generation) return;
    this.clear(record.taskID);

    const run: RunTimers = {
      generation: record.generation,
      parentSessionID: record.parentSessionID,
    };
    if (record.deadlineExceededAt !== undefined) {
      this.runs.set(record.taskID, run);
      return;
    }
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

  /**
   * Handle a child deletion before the normal board drop callback. A deletion
   * during grace confirms the timed-out terminal; an ordinary deletion simply
   * invalidates the run without inventing a terminal result.
   */
  onSessionDeleted(taskID: string): boolean {
    if (this.disposed) {
      this.clear(taskID);
      return false;
    }
    const record = this.options.backgroundJobStore.get(taskID);
    if (!record) {
      this.clear(taskID);
      return false;
    }
    if (record.deadlineExceededAt !== undefined && record.state === 'running') {
      const token = this.options.terminalGate.capture(record);
      if (token)
        this.options.terminalGate.observe(token, {
          kind: 'deleted',
          origin: 'session.deleted',
          readStartedAt: token.readStartedAt,
        });
      this.clear(taskID);
      return true;
    }
    this.clear(taskID);
    return false;
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

    const claimed = this.options.backgroundJobStore.claimWallClockDeadline({
      taskID,
      generation,
      now: this.now(),
    });
    if (!claimed) {
      this.clear(taskID);
      return;
    }

    // The grace timer is armed before abort is invoked. A rejected or hanging
    // SDK promise must never prevent the bounded terminal transition.
    run.graceTimer = this.setTimer(
      () => this.onGraceExpired(taskID, generation),
      this.options.abortGraceMs,
    );
    Promise.resolve()
      .then(() => this.options.abort(taskID))
      .catch(() => undefined);
  }

  private onGraceExpired(taskID: string, generation: number): void {
    const run = this.runs.get(taskID);
    if (this.disposed || !run || run.generation !== generation) return;
    run.graceTimer = undefined;
    this.options.backgroundJobStore.markStatusUncertain(
      taskID,
      'Background task exceeded its wall-clock deadline; abort was not confirmed before the grace period expired.',
      generation,
      this.now(),
    );
    // Background reconciliation is fail-soft: a failure must be logged
    // and swallowed, never escape as an unhandled rejection.
    void this.options.terminalGate
      .reconcile({ taskID, generation }, { kind: 'deadline' })
      .catch((err) => {
        log(
          '[background-job-supervisor] deadline reconcile failed',
          String(err),
        );
      });
  }

  private clear(taskID: string): void {
    const run = this.runs.get(taskID);
    if (!run) return;
    if (run.deadlineTimer !== undefined) this.clearTimer(run.deadlineTimer);
    if (run.graceTimer !== undefined) this.clearTimer(run.graceTimer);
    this.runs.delete(taskID);
  }
}
