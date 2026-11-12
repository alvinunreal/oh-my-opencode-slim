import { OperationTimeoutError, withTimeout } from '../../utils/session';
import type { TimerSeam } from '../../utils/timer-seam';

/** In-flight native model switches for one instance. Native switches cannot
 *  be cancelled, so teardown only waits a bounded time; an entry leaves the
 *  set when its switch settles, even after a drain gave up on it. */
export class SwitchTracker {
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly timers: TimerSeam) {}

  get size(): number {
    return this.pending.size;
  }

  track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    const release = () => this.pending.delete(p);
    void p.then(release, release);
    return p;
  }

  /** Resolves once every tracked switch settles, or after `budgetMs`.
   *  Never rejects; returns whether everything settled. */
  async drain(budgetMs: number): Promise<boolean> {
    try {
      await withTimeout(
        Promise.allSettled([...this.pending]),
        budgetMs,
        'native switch drain timed out',
        this.timers,
      );
      return true;
    } catch (error) {
      if (error instanceof OperationTimeoutError) return false;
      throw error;
    }
  }
}
