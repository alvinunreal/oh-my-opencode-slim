import { afterEach, describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils';
import { getBackgroundJobLifecycleLedger } from '../../utils/background-job-board';
import {
  configureBackgroundJobPersistence,
  getPersistedBackgroundChild,
  markPersistedBackgroundChildDelivered,
  recordPersistedBackgroundChild,
} from '../../utils/background-job-persistence';
import { handleEvent } from './event-router';

const PARENT = 'ses_parent';
const CHILD = 'ses_orphan_child';

function idleEvent(
  sessionID: string,
  info?: { parentID?: string; agent?: string; title?: string },
) {
  return {
    event: {
      type: 'session.idle',
      properties: {
        info: { id: sessionID, ...info },
      },
    },
  };
}

function errorEvent(
  sessionID: string,
  info?: { parentID?: string; agent?: string; title?: string },
  error?: { name?: string; message?: string },
) {
  return {
    event: {
      type: 'session.error',
      properties: {
        info: { id: sessionID, ...info },
        error: { name: 'Error', ...error },
      },
    },
  };
}

function createDeps(
  board: BackgroundJobBoard,
  managed: (sessionID: string) => boolean,
  options?: { willAttemptFallback?: (sessionID: string) => boolean },
) {
  const scheduleChildIdleReconciliation = mock(() => {});
  const reconcile = mock(async () => ({ kind: 'committed' as const }));
  const deps = {
    inputWaits: {
      trackInputWait() {},
      clearInputWaits() {},
      waitsByParent: new Map<string, Set<string | symbol>>(),
    },
    idleSessionTokens: {
      clearSession() {},
      invalidate() {},
      disposeLocalState() {},
      sessionTokens: new Map<string, symbol>(),
    },
    options: {
      shouldManageSession: managed,
      now: () => 1000,
      willAttemptFallback: options?.willAttemptFallback,
    },
    idleReconciler: {
      scheduleChildIdleReconciliation,
      scheduleDeferredErrorBackstop() {},
      clearIdleTimers() {},
      clearAllTimers: () => [] as string[],
    },
    deferredInlineErrors: new Map<string, string>(),
    withFallbackReason: (_sessionID: string, text: string) => text,
    backgroundJobBoard: board,
    terminalGate: {
      capture: () => undefined,
      observe: () => ({ kind: 'ok' }),
      reconcile,
    },
    pendingCallTracker: {
      peekByParentAndAgent: () => undefined,
      clearSession() {},
    },
    taskContextTracker: {
      pendingManagedTaskIds: new Set<string>(),
      clearSession() {},
      prune() {},
    },
    now: () => 1000,
  };
  return {
    deps: deps as never,
    scheduleChildIdleReconciliation,
    reconcile,
    deferredInlineErrors: deps.deferredInlineErrors,
  };
}

// PARENT is managed; every child id is unmanaged.
const managed = (sessionID: string) => sessionID === PARENT;

function memoryStorage(): {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  remove(key: string): void;
  scan(options: { prefix: string }): {
    entries: Array<{ key: string; value: unknown }>;
  };
} {
  const values = new Map<string, unknown>();
  return {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
    scan: ({ prefix }) => ({
      entries: [...values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    }),
  };
}

afterEach(() => {
  // configureBackgroundJobPersistence resets the module-global persisted
  // map, so markers from one test cannot leak into the next.
  configureBackgroundJobPersistence(undefined);
});

describe('orphaned-child observation fallback (#1560)', () => {
  test('adopts an idle orphan under its recorded parent and restores the wake link', async () => {
    const board = new BackgroundJobBoard();
    expect(board.hasRunning(PARENT)).toBe(false);
    const { deps, scheduleChildIdleReconciliation } = createDeps(
      board,
      managed,
    );

    await handleEvent(
      idleEvent(CHILD, {
        parentID: PARENT,
        agent: 'explorer',
        title: 'delegated work',
      }),
      deps,
    );

    const row = board.get(CHILD);
    expect(row).toMatchObject({
      parentSessionID: PARENT,
      agent: 'explorer',
      background: true,
      state: 'running',
      externalOrigin: true,
      // The run predates this process, so the plugin owns the first
      // publication's wake — without this the wake listener skips it.
      recoveredAtStartup: true,
    });
    // The parent now has a pending board entry whose completion publication
    // carries the wake.
    expect(board.hasRunning(PARENT)).toBe(true);
    expect(scheduleChildIdleReconciliation).toHaveBeenCalledTimes(1);
    expect(scheduleChildIdleReconciliation).toHaveBeenCalledWith(
      CHILD,
      1000,
      row?.generation,
    );
  });

  test('does not re-adopt an orphan it already adopted', async () => {
    const board = new BackgroundJobBoard();
    const { deps } = createDeps(board, managed);

    await handleEvent(
      idleEvent(CHILD, { parentID: PARENT, agent: 'explorer' }),
      deps,
    );
    const first = board.get(CHILD);
    await handleEvent(
      idleEvent(CHILD, { parentID: PARENT, agent: 'explorer' }),
      deps,
    );

    expect(board.get(CHILD)?.generation).toBe(first?.generation);
  });

  test('adopts even when the parent has a running board entry', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_sibling',
      parentSessionID: PARENT,
      agent: 'fixer',
      background: true,
      now: 1,
    });
    const { deps, scheduleChildIdleReconciliation } = createDeps(
      board,
      managed,
    );

    await handleEvent(
      idleEvent(CHILD, { parentID: PARENT, agent: 'explorer' }),
      deps,
    );

    // Concurrent orphans each get their own row and wake; dropping the
    // observation would lose the second child until the next restart.
    expect(board.get(CHILD)).toMatchObject({
      parentSessionID: PARENT,
      state: 'running',
      recoveredAtStartup: true,
    });
    expect(scheduleChildIdleReconciliation).toHaveBeenCalledTimes(1);
  });

  test('adopts even when the parent has a terminal-unreconciled board entry', async () => {
    const board = new BackgroundJobBoard();
    board.restoreRetainedSession({
      taskID: 'ses_sibling',
      parentSessionID: PARENT,
      agent: 'fixer',
      description: 'finished before restart',
      state: 'completed',
      resultSummary: 'done',
      background: true,
      launchedAt: 1,
    });
    expect(board.hasTerminalUnreconciled(PARENT)).toBe(true);
    const { deps, scheduleChildIdleReconciliation } = createDeps(
      board,
      managed,
    );

    await handleEvent(
      idleEvent(CHILD, { parentID: PARENT, agent: 'explorer' }),
      deps,
    );

    expect(board.get(CHILD)).toMatchObject({
      parentSessionID: PARENT,
      recoveredAtStartup: true,
    });
    expect(scheduleChildIdleReconciliation).toHaveBeenCalledTimes(1);
  });

  test('skips a child with a deletion tombstone', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: CHILD,
      parentSessionID: PARENT,
      agent: 'explorer',
      background: true,
      now: 1,
    });
    board.drop(CHILD);
    expect(getBackgroundJobLifecycleLedger(board).tombstones.has(CHILD)).toBe(
      true,
    );
    const { deps, reconcile, scheduleChildIdleReconciliation } = createDeps(
      board,
      managed,
    );

    await handleEvent(
      idleEvent(CHILD, { parentID: PARENT, agent: 'explorer' }),
      deps,
    );

    // Adoption's registerLaunch clears tombstones, so the guard must run
    // first: a late replay must not resurrect deleted work.
    expect(getBackgroundJobLifecycleLedger(board).tombstones.has(CHILD)).toBe(
      true,
    );
    expect(board.get(CHILD)).toBeUndefined();
    expect(scheduleChildIdleReconciliation).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test('never adopts a managed child session', async () => {
    const board = new BackgroundJobBoard();
    const { deps, scheduleChildIdleReconciliation } = createDeps(
      board,
      managed,
    );

    // A managed child whose registration failed is the manager's to
    // re-register, not the observation fallback's.
    await handleEvent(idleEvent(PARENT, { parentID: 'ses_grandparent' }), deps);

    expect(board.get(PARENT)).toBeUndefined();
    expect(scheduleChildIdleReconciliation).not.toHaveBeenCalled();
  });

  test('skips an already-delivered child', async () => {
    configureBackgroundJobPersistence(memoryStorage());
    recordPersistedBackgroundChild({
      taskID: CHILD,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'finished before restart',
      launchedAt: 6,
      background: true,
    });
    markPersistedBackgroundChildDelivered(CHILD, 20);
    expect(getPersistedBackgroundChild(CHILD)?.deliveredAt).toBe(20);
    const board = new BackgroundJobBoard();
    const { deps } = createDeps(board, managed);

    await handleEvent(
      idleEvent(CHILD, { parentID: PARENT, agent: 'explorer' }),
      deps,
    );

    expect(board.get(CHILD)).toBeUndefined();
  });

  test('adopts from the persisted identity when the event carries no parent info', async () => {
    configureBackgroundJobPersistence(memoryStorage());
    recordPersistedBackgroundChild({
      taskID: CHILD,
      parentSessionID: PARENT,
      agent: 'fixer',
      description: 'from persistence',
      launchedAt: 6,
      background: true,
    });
    const board = new BackgroundJobBoard();
    const { deps } = createDeps(board, managed);

    await handleEvent(idleEvent(CHILD), deps);

    // Restart evidence: everything except the id comes from persistence.
    expect(board.get(CHILD)).toMatchObject({
      parentSessionID: PARENT,
      agent: 'fixer',
      description: 'from persistence',
      runStartedAt: 6,
      state: 'running',
      externalOrigin: true,
      recoveredAtStartup: true,
    });
  });

  test('skips with no recorded parent and with an unmanaged parent', async () => {
    const board = new BackgroundJobBoard();
    const { deps } = createDeps(board, managed);

    await handleEvent(idleEvent(CHILD), deps);
    expect(board.get(CHILD)).toBeUndefined();

    await handleEvent(
      idleEvent('ses_orphan_child_2', { parentID: 'ses_unmanaged' }),
      deps,
    );
    expect(board.get('ses_orphan_child_2')).toBeUndefined();
  });

  test('never touches a child the board already tracks', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: CHILD,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'original',
      background: true,
      now: 5,
    });
    const { deps } = createDeps(board, managed);

    await handleEvent(
      idleEvent(CHILD, { parentID: PARENT, agent: 'fixer' }),
      deps,
    );

    expect(board.get(CHILD)).toMatchObject({
      description: 'original',
      agent: 'explorer',
      generation: 1,
    });
  });

  test('terminal flavor: adopts an orphan error and publishes it', async () => {
    const board = new BackgroundJobBoard();
    const { deps, reconcile } = createDeps(board, managed);

    await handleEvent(
      errorEvent(CHILD, { parentID: PARENT, agent: 'explorer' }),
      deps,
    );

    const row = board.get(CHILD);
    expect(row?.parentSessionID).toBe(PARENT);
    expect(row?.recoveredAtStartup).toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]?.taskID).toBe(CHILD);
    expect(reconcile.mock.calls[0]?.[1]).toEqual({
      kind: 'session-error',
      message: 'Session error',
    });
  });

  test('terminal flavor: adopts even when the parent has pending work', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_sibling',
      parentSessionID: PARENT,
      agent: 'fixer',
      background: true,
      now: 1,
    });
    const { deps, reconcile } = createDeps(board, managed);

    await handleEvent(
      errorEvent(CHILD, { parentID: PARENT, agent: 'explorer' }),
      deps,
    );

    expect(board.get(CHILD)).toMatchObject({
      parentSessionID: PARENT,
      recoveredAtStartup: true,
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test('terminal flavor: defers a failover error while a fallback is armed', async () => {
    const board = new BackgroundJobBoard();
    const { deps, reconcile, deferredInlineErrors } = createDeps(
      board,
      managed,
      {
        willAttemptFallback: () => true,
      },
    );

    await handleEvent(
      errorEvent(
        CHILD,
        { parentID: PARENT, agent: 'explorer' },
        { message: 'quota exceeded' },
      ),
      deps,
    );

    // The re-prompt owns the outcome; the adopted row stays running so the
    // observation handoff can still deliver the retried result.
    expect(board.get(CHILD)?.state).toBe('running');
    expect(deferredInlineErrors.get(CHILD)).toBe('quota exceeded');
    expect(reconcile).not.toHaveBeenCalled();
  });
});
