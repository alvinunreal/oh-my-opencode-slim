import { expect, mock, test } from 'bun:test';
import { createIdleReconciler } from './idle-reconciliation';

function fakeGate() {
  const reconciles: Array<{ run: unknown; signal: unknown }> = [];
  const gate = {
    capture: () => ({ taskID: 'child', generation: 1, readStartedAt: 1 }),
    observe: () => ({ kind: 'deferred', record: {} }),
    reconcile: mock(async (run: unknown, signal: unknown) => {
      reconciles.push({ run, signal });
      return { kind: 'stale' };
    }),
    dispose() {},
  };
  return { gate, reconciles };
}

test('child idle preserves event provenance and requests runtime inspection', () => {
  const calls: string[] = [];
  const token = { taskID: 'child', generation: 1, readStartedAt: 1 };
  const reconciler = createIdleReconciler({
    terminalGate: {
      capture: () => token,
      observe: (_token: unknown, runtime: unknown) => {
        calls.push('observe');
        expect(runtime).toEqual({
          kind: 'quiescent',
          origin: 'session.idle',
          readStartedAt: 1,
          observedAt: 1,
        });
        return { kind: 'deferred', record: {} };
      },
      reconcile: async () => {
        calls.push('inspect');
        return { kind: 'stale' };
      },
      dispose() {},
    } as never,
    reconcileInjectedTerminalJobs: () => {},
    idleReconcileDelayMs: 1,
    hasInputWait: () => false,
    getIdleSessionToken: () => Symbol(),
    isCurrentIdleSessionToken: () => true,
  });
  reconciler.scheduleChildIdleReconciliation('child', 1, 1);
  expect(calls).toEqual(['observe', 'inspect']);
  expect(reconciler.clearAllTimers()).toEqual([]);
});
test('parent reconciliation retains its independent delay and invalidation', async () => {
  const acknowledge = mock(() => {});
  const reconciler = createIdleReconciler({
    terminalGate: {} as never,
    reconcileInjectedTerminalJobs: acknowledge,
    idleReconcileDelayMs: 1,
    hasInputWait: () => false,
    getIdleSessionToken: () => Symbol(),
    isCurrentIdleSessionToken: () => true,
  });
  reconciler.scheduleIdleReconciliation('cancelled');
  reconciler.onInvalidateIdle('cancelled');
  reconciler.scheduleIdleReconciliation('parent');
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(acknowledge).toHaveBeenCalledTimes(1);
  expect(acknowledge).toHaveBeenCalledWith('parent');
  reconciler.clearAllTimers();
});

test('deferred-error backstop renews while the fallback is in flight, then consumes and terminalizes', async () => {
  const { gate, reconciles } = fakeGate();
  let fallbackInFlight = true;
  let deferred = 'rate limit exceeded';
  const consumed: string[] = [];
  const reconciler = createIdleReconciler({
    terminalGate: gate as never,
    reconcileInjectedTerminalJobs: () => {},
    idleReconcileDelayMs: 5,
    isFallbackInProgress: () => fallbackInFlight,
    hasInputWait: () => false,
    getIdleSessionToken: () => Symbol(),
    isCurrentIdleSessionToken: () => true,
    consumeDeferredError: (sessionID) => {
      expect(sessionID).toBe('child');
      const message = deferred;
      deferred = '';
      consumed.push(message);
      return message || undefined;
    },
  });

  reconciler.scheduleDeferredErrorBackstop('child', 1, 1);
  // While the fallback is in flight the backstop only renews: nothing is
  // consumed, nothing is reconciled.
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(consumed).toEqual([]);
  expect(reconciles).toHaveLength(0);

  // The fallback leaves the window: the next fire consumes the deferred
  // error and terminalizes it through the gate.
  fallbackInFlight = false;
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(consumed).toEqual(['rate limit exceeded']);
  expect(reconciles).toHaveLength(1);
  expect(reconciles[0]?.signal).toEqual({
    kind: 'session-error',
    message: 'rate limit exceeded',
  });
  reconciler.clearAllTimers();
});

test('deferred-error backstop renewal is bounded when the fallback never leaves the window', async () => {
  const { gate, reconciles } = fakeGate();
  const deferred = 'rate limit exceeded';
  const reconciler = createIdleReconciler({
    terminalGate: gate as never,
    reconcileInjectedTerminalJobs: () => {},
    idleReconcileDelayMs: 2,
    // Stuck fallback: always claims to be in flight.
    isFallbackInProgress: () => true,
    hasInputWait: () => false,
    getIdleSessionToken: () => Symbol(),
    isCurrentIdleSessionToken: () => true,
    consumeDeferredError: () => deferred,
  });

  reconciler.scheduleDeferredErrorBackstop('child', 1, 1);
  // Past the renewal cap (5 renewals × 2ms) the deferred error must
  // terminalize even though the fallback still claims to be in flight.
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(reconciles).toHaveLength(1);
  expect(reconciles[0]?.signal).toEqual({
    kind: 'session-error',
    message: 'rate limit exceeded',
  });
  reconciler.clearAllTimers();
});

test('deferred-error backstop skips the publish when nothing is deferred at fire time', async () => {
  const { gate, reconciles } = fakeGate();
  const reconciler = createIdleReconciler({
    terminalGate: gate as never,
    reconcileInjectedTerminalJobs: () => {},
    idleReconcileDelayMs: 2,
    isFallbackInProgress: () => false,
    hasInputWait: () => false,
    getIdleSessionToken: () => Symbol(),
    isCurrentIdleSessionToken: () => true,
    // Busy already cleared the deferral (the timer was cancelled too
    // late); nothing to publish.
    consumeDeferredError: () => undefined,
  });

  reconciler.scheduleDeferredErrorBackstop('child', 1, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(reconciles).toHaveLength(0);
  reconciler.clearAllTimers();
});

test('busy cancels a pending deferred-error backstop', async () => {
  const { gate, reconciles } = fakeGate();
  const reconciler = createIdleReconciler({
    terminalGate: gate as never,
    reconcileInjectedTerminalJobs: () => {},
    idleReconcileDelayMs: 10,
    isFallbackInProgress: () => false,
    hasInputWait: () => false,
    getIdleSessionToken: () => Symbol(),
    isCurrentIdleSessionToken: () => true,
    consumeDeferredError: () => 'rate limit exceeded',
  });

  reconciler.scheduleDeferredErrorBackstop('child', 1, 1);
  // The re-prompt landed before the backstop fired.
  reconciler.clearIdleTimers('child');
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(reconciles).toHaveLength(0);
  reconciler.clearAllTimers();
});
