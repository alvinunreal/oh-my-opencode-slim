/** Platform timer handle; fake harnesses may return bare numeric ids.
 *  (`ReturnType<typeof setTimeout>` is the global `Timer` interface.) */
export type TimerHandle = ReturnType<typeof setTimeout> | number;

/**
 * Scheduling seam (see `src/utils/test-timers.ts`); defaults to the platform
 * timers at the call site. Method syntax keeps test fakes that take plain
 * numeric ids assignable (bivariant parameters).
 */
export type TimerSeam = {
  setTimeout(callback: () => void, delay: number): TimerHandle;
  clearTimeout(timer: TimerHandle): void;
};

/** Option-bag form: every member is optional and resolved by the consumer. */
export type TimerSeamOptions = {
  setTimeout?(callback: () => void, delay: number): TimerHandle;
  clearTimeout?(timer: TimerHandle): void;
};
