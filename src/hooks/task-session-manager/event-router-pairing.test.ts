import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { handleEvent } from './event-router';
import { createPendingCallTracker } from './pending-call-tracker';

const PARENT = 'parent-1';

function createDeps(board: BackgroundJobBoard) {
  return {
    inputWaits: {
      trackInputWait: mock(() => {}),
      clearInputWaits: mock(() => {}),
      waitsByParent: new Map<string, Set<string | symbol>>(),
    },
    idleSessionTokens: {
      clearSession: mock(() => {}),
      invalidate: mock(() => {}),
      disposeLocalState: mock(() => {}),
      sessionTokens: new Map<string, symbol>(),
    },
    options: {
      shouldManageSession: () => true,
      now: () => 1_000,
    },
    idleReconciler: {
      scheduleIdleReconciliation: mock(() => {}),
      scheduleChildIdleReconciliation: mock(() => {}),
      scheduleErrorTerminalize: mock(() => {}),
      clearIdleTimers: mock(() => {}),
      clearAllTimers: mock(() => []),
    },
    deferredFallbackErrors: new Set<string>(),
    backgroundJobBoard: board,
    pendingCallTracker: createPendingCallTracker(),
    taskContextTracker: {
      pendingManagedTaskIds: new Set<string>(),
      clearSession: mock(() => {}),
      prune: mock(() => {}),
    },
    terminalJobsInjectedByParent: new Map(),
    pendingInjectedTerminalJobsByParent: new Map(),
    retainedBoardSnapshots: new Map(),
  };
}

function route(
  deps: ReturnType<typeof createDeps>,
  info: Record<string, unknown>,
): Promise<void> {
  return handleEvent(
    { event: { type: 'session.created', properties: { info } } },
    deps as never,
  );
}

function addPending(
  deps: ReturnType<typeof createDeps>,
  callId: string,
  label: string,
): void {
  deps.pendingCallTracker.add({
    callId,
    parentSessionId: PARENT,
    agentType: 'oracle',
    label,
    background: true,
    lifecycleEpoch: 0,
  });
}

describe('session.created pairing', () => {
  test('title match claims the right pending among same-agent parallel calls', async () => {
    const board = new BackgroundJobBoard();
    const deps = createDeps(board);
    addPending(deps, 'a', 'L1');
    addPending(deps, 'b', 'L2');

    await route(deps, {
      id: 'child-2',
      parentID: PARENT,
      agent: 'oracle',
      title: 'L2',
    });

    expect(board.get('child-2')?.description).toBe('L2');
    expect(deps.pendingCallTracker.take('b')?.earlyRegisteredTaskID).toBe(
      'child-2',
    );
  });

  test('already-registered child does not fence an unrelated pending', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: PARENT,
      agent: 'oracle',
      description: 'L1',
      background: false,
    });
    const deps = createDeps(board);
    addPending(deps, 'b', 'L2');

    await route(deps, {
      id: 'child-1',
      parentID: PARENT,
      agent: 'oracle',
      title: 'L1',
    });

    expect(
      deps.pendingCallTracker.take('b')?.earlyRegistrationRejected,
    ).toBeUndefined();
  });

  test('ambiguous same-agent child gets a placeholder registration', async () => {
    const board = new BackgroundJobBoard();
    const deps = createDeps(board);
    addPending(deps, 'a', 'L1');
    addPending(deps, 'b', 'L2');

    await route(deps, { id: 'child-9', parentID: PARENT, agent: 'oracle' });

    const record = board.get('child-9');
    expect(record?.description).toBe('unattributed oracle task');
    expect(record?.state).toBe('running');
    expect(record?.background).toBe(false);
  });

  test('child with no pendings at all gets a placeholder registration', async () => {
    const board = new BackgroundJobBoard();
    const deps = createDeps(board);

    await route(deps, { id: 'child-9', parentID: PARENT, agent: 'fixer' });

    expect(board.get('child-9')?.description).toBe('unattributed fixer task');
  });

  test('title that matches no pending yields placeholder, pending untouched', async () => {
    const board = new BackgroundJobBoard();
    const deps = createDeps(board);
    addPending(deps, 'a', 'L1');

    await route(deps, {
      id: 'child-9',
      parentID: PARENT,
      agent: 'oracle',
      title: 'L9',
    });

    expect(board.get('child-9')?.description).toBe('unattributed oracle task');
    expect(
      deps.pendingCallTracker.take('a')?.earlyRegisteredTaskID,
    ).toBeUndefined();
  });
});
