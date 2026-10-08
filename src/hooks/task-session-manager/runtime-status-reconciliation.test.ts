import { afterEach, expect, mock, test } from 'bun:test';
import {
  FixtureBoard as BackgroundJobBoard,
  createBackgroundJobLifecycle,
  createBackgroundJobTerminalGate,
} from '../../background-jobs';
import { createRuntimeStatusReconciler } from './runtime-status-reconciliation';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function harness(status?: () => Promise<unknown>) {
  const board = new BackgroundJobBoard();
  const run = board.registerLaunch({
    taskID: 'child',
    parentSessionID: 'parent',
    agent: 'fixer',
    now: 0,
  });
  const input = { directory: '/tmp', client: { session: { status } } } as never;
  const gate = createBackgroundJobTerminalGate({
    input,
    backgroundJobBoard: board,
  });
  const reconciler = createRuntimeStatusReconciler({
    input,
    backgroundJobs: createBackgroundJobLifecycle({
      backgroundJobBoard: board,
      gate,
    }),
    delayMs: 10,
    statusTimeoutMs: 5,
  });
  cleanup.push(() => {
    reconciler.dispose();
    gate.dispose();
  });
  return { board, run, gate, reconciler };
}

test('batches all retained records, including consumed terminals, in one lookup', async () => {
  const status = mock(async () => ({
    data: { child: { type: 'busy' }, other: { type: 'retry' } },
  }));
  const h = harness(status);
  h.board.updateStatus({
    taskID: 'child',
    state: 'completed',
    resultSummary: 'A',
    now: 1,
  });
  h.board.markReconciled('child', 2);
  h.board.registerLaunch({
    taskID: 'other',
    parentSessionID: 'parent',
    agent: 'fixer',
    now: 0,
  });
  await h.reconciler.reconcile();
  expect(status).toHaveBeenCalledTimes(1);
  expect(h.board.list().map((run) => run.state)).toEqual([
    'running',
    'running',
  ]);
  expect(h.board.get('child')?.terminalRevision).toBe(2);
});
test.each([{ data: {} }, { data: { child: { type: 'idle' } } }])(
  'valid quiescence is only supplied to the gate: %j',
  async (response) => {
    const h = harness(async () => response);
    await h.reconciler.reconcile();
    expect(h.board.get('child')?.state).toBe('running');
  },
);
test.each([
  {},
  { data: {}, error: 'failed' },
  { data: { child: { type: 'malformed' } } },
])('malformed status stays unknown: %j', async (response) => {
  const h = harness(async () => response);
  const observe = mock(h.gate.observe);
  h.gate.observe = observe;
  await h.reconciler.reconcile();
  expect(observe.mock.calls[0]?.[1].kind).toBe('unknown');
  expect(h.board.get('child')).toMatchObject({
    state: 'running',
    statusUncertain: true,
  });
});
test('busy received during an older asynchronous read invalidates that read', async () => {
  let resolve!: (response: unknown) => void;
  const h = harness(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = h.reconciler.reconcile();
  const token = h.gate.capture(h.run);
  if (!token) throw new Error('missing observation');
  h.gate.observe(token, {
    kind: 'busy',
    origin: 'event',
    readStartedAt: token.readStartedAt,
  });
  resolve({ data: {} });
  await pending;
  expect(h.board.get('child')).toMatchObject({
    state: 'running',
    statusUncertain: false,
  });
});
test('a response from the previous generation cannot change the current run', async () => {
  let resolve!: (response: unknown) => void;
  const h = harness(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = h.reconciler.reconcile();
  const newer = h.board.registerLaunch({ ...h.run, now: 100 });
  resolve({ data: {} });
  await pending;
  expect(h.board.get('child')).toMatchObject({
    generation: newer.generation,
    statusUncertain: false,
  });
});
test('direct requests serialize and include jobs registered during a read', async () => {
  let resolve!: (response: unknown) => void;
  const status = mock(() =>
    status.mock.calls.length === 1
      ? new Promise((done) => {
          resolve = done;
        })
      : Promise.resolve({ data: {} }),
  );
  const h = harness(status);
  const first = h.reconciler.reconcile();
  h.board.registerLaunch({
    taskID: 'new',
    parentSessionID: 'parent',
    agent: 'fixer',
  });
  const second = h.reconciler.reconcile();
  expect(status).toHaveBeenCalledTimes(1);
  resolve({ data: {} });
  await Promise.all([first, second]);
  expect(status).toHaveBeenCalledTimes(2);
});
test('missing session.status disables both direct and scheduled polling', async () => {
  const h = harness();
  h.reconciler.schedule();
  await h.reconciler.reconcile();
  await tick();
  expect(h.board.get('child')?.statusUncertain).toBe(false);
});
test('inactive terminal history does not arm perpetual polling', async () => {
  const status = mock(async () => ({ data: {} }));
  const h = harness(status);
  h.board.updateStatus({
    taskID: 'child',
    state: 'completed',
    resultSummary: 'answer',
  });
  h.reconciler.schedule();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(status).not.toHaveBeenCalled();
});
test('dispose fences a pending batch', async () => {
  let resolve!: (response: unknown) => void;
  const h = harness(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = h.reconciler.reconcile();
  h.reconciler.dispose();
  resolve({ data: {} });
  await pending;
  expect(h.board.get('child')?.statusUncertain).toBe(false);
});
