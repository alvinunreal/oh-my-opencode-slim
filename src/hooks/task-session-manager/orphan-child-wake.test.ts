import { afterEach, describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils';
import { recordBackgroundJobSuppression } from '../../utils/background-job-board';
import {
  configureBackgroundJobPersistence,
  recordPersistedBackgroundChild,
} from '../../utils/background-job-persistence';
import { handleEvent } from './event-router';
import { resolveUndeliveredBackgroundChild } from './session-recovery';

const PARENT = 'ses_parent';
const CHILD = 'ses_orphan_child';

function idleEvent(
  sessionID: string,
  info?: { parentID?: string; agent?: string; title?: string },
) {
  return {
    event: {
      type: 'session.idle',
      properties: { info: { id: sessionID, ...info } },
    },
  };
}

function errorEvent(
  sessionID: string,
  info?: { parentID?: string; agent?: string; title?: string },
  error?: { name?: string },
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
  options?: {
    resolve?: typeof resolveUndeliveredBackgroundChild;
    willAttemptFallback?: (sessionID: string) => boolean;
    registerSessionAsOrchestrator?: (sessionID: string) => void;
    isPrimaryAgentName?: (agent: string) => boolean;
    isDisposed?: () => boolean;
    reconcileIdle?: boolean;
  },
) {
  const reconcile = mock(
    async (record: { taskID: string }, outcome?: { kind: string }) => {
      const row = board.get(record.taskID);
      if (row) {
        row.state = outcome?.kind === 'session-error' ? 'error' : 'completed';
      }
      return { kind: 'committed' as const };
    },
  );
  const scheduleChildIdleReconciliation = mock((sessionID: string) => {
    if (!options?.reconcileIdle) return;
    const row = board.get(sessionID);
    if (row) void reconcile(row, { kind: 'inspect' });
  });
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
      registerSessionAsOrchestrator: options?.registerSessionAsOrchestrator,
      isPrimaryAgentName: options?.isPrimaryAgentName,
      isDisposed: options?.isDisposed,
      ...(options?.resolve
        ? { resolveUndeliveredBackgroundChild: options.resolve }
        : {}),
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
  };
  return {
    deps: deps as never,
    scheduleChildIdleReconciliation,
    reconcile,
  };
}

// PARENT is managed; every child id is unmanaged.
const managed = (sessionID: string) => sessionID === PARENT;
const LAUNCHED_AT = 4242;
const proven: typeof resolveUndeliveredBackgroundChild = async () => ({
  parentSessionID: PARENT,
  launchedAt: LAUNCHED_AT,
});

function memoryStorage() {
  const values = new Map<string, unknown>();
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value);
    },
    remove: (key: string) => {
      values.delete(key);
    },
    scan: ({ prefix }: { prefix: string }) => ({
      entries: [...values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    }),
  };
}

afterEach(() => {
  configureBackgroundJobPersistence(undefined);
});

describe('orphaned-child observation fallback (#1560)', () => {
  test('adopts a proven idle orphan under its parent and restores the wake link', async () => {
    const board = new BackgroundJobBoard();
    const { deps, scheduleChildIdleReconciliation } = createDeps(
      board,
      managed,
      { resolve: proven },
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
      // The run predates this process, so the plugin owns the first
      // publication's wake — without this the wake listener skips it.
      recoveredAtStartup: true,
    });
    // The run fence is the delegation evidence, not process start.
    expect(row?.runStartedAt).toBe(LAUNCHED_AT);
    expect(scheduleChildIdleReconciliation).toHaveBeenCalledWith(
      CHILD,
      1000,
      row?.generation,
    );
  });

  test('adopts a native v1 event that names only the child session', async () => {
    const board = new BackgroundJobBoard();
    const resolve = mock(async () => ({ parentSessionID: PARENT }));
    const { deps, scheduleChildIdleReconciliation } = createDeps(
      board,
      managed,
      { resolve },
    );

    // v1 terminal events carry the session id, not the parent object.
    await handleEvent(
      {
        event: { type: 'session.idle', properties: { sessionID: CHILD } },
      } as never,
      deps,
    );

    expect(resolve).toHaveBeenCalledWith({ taskID: CHILD });
    expect(board.get(CHILD)).toMatchObject({
      parentSessionID: PARENT,
      recoveredAtStartup: true,
    });
    expect(scheduleChildIdleReconciliation).toHaveBeenCalledTimes(1);
  });

  test('does not adopt twice', async () => {
    const board = new BackgroundJobBoard();
    const { deps } = createDeps(board, managed, { resolve: proven });

    await handleEvent(idleEvent(CHILD, { parentID: PARENT }), deps);
    const first = board.get(CHILD);
    await handleEvent(idleEvent(CHILD, { parentID: PARENT }), deps);

    expect(board.get(CHILD)?.generation).toBe(first?.generation);
    expect([...board.taskIDs()]).toEqual([CHILD]);
  });

  test('leaves the orphan alone when the proof fails', async () => {
    const board = new BackgroundJobBoard();
    // A foreground `task` that survived the restart, or a run the parent
    // already saw delivered: adopting would double-deliver it.
    const { deps, scheduleChildIdleReconciliation } = createDeps(
      board,
      managed,
      { resolve: async () => undefined },
    );

    await handleEvent(idleEvent(CHILD, { parentID: PARENT }), deps);

    expect(board.get(CHILD)).toBeUndefined();
    expect(scheduleChildIdleReconciliation).not.toHaveBeenCalled();
  });

  test('treats a failed proof read as no evidence', async () => {
    const board = new BackgroundJobBoard();
    const { deps } = createDeps(board, managed, {
      resolve: async () => {
        throw new Error('transcript read timed out');
      },
    });

    // A throwing resolver is a failed read, not a failed event.
    await handleEvent(idleEvent(CHILD, { parentID: PARENT }), deps);
    expect(board.get(CHILD)).toBeUndefined();
  });

  test('skips when no prover is wired (v2 hosts own delivery)', async () => {
    const board = new BackgroundJobBoard();
    const { deps, scheduleChildIdleReconciliation } = createDeps(
      board,
      managed,
    );

    await handleEvent(idleEvent(CHILD, { parentID: PARENT }), deps);

    expect(board.get(CHILD)).toBeUndefined();
    expect(scheduleChildIdleReconciliation).not.toHaveBeenCalled();
  });

  test('skips a child with a persisted identity — startup recovery judged it', async () => {
    const board = new BackgroundJobBoard();
    configureBackgroundJobPersistence(memoryStorage());
    recordPersistedBackgroundChild({
      taskID: CHILD,
      parentSessionID: PARENT,
      agent: 'explorer',
      description: 'delegated work',
      launchedAt: 5,
      background: true,
    });
    const resolve = mock(proven);
    const { deps } = createDeps(board, managed, { resolve });

    await handleEvent(idleEvent(CHILD, { parentID: PARENT }), deps);

    expect(board.get(CHILD)).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  test('skips when the resolved parent is not managed', async () => {
    const board = new BackgroundJobBoard();
    const resolve = mock(async () => ({ parentSessionID: 'ses_other' }));
    const { deps, scheduleChildIdleReconciliation } = createDeps(
      board,
      managed,
      { resolve },
    );

    await handleEvent(idleEvent(CHILD), deps);

    expect(board.get(CHILD)).toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(scheduleChildIdleReconciliation).not.toHaveBeenCalled();
  });

  test('admits and registers an orchestrator parent whose membership was lost', async () => {
    const board = new BackgroundJobBoard();
    const register = mock(() => {});
    const { deps } = createDeps(board, managed, {
      resolve: async () => ({
        parentSessionID: 'ses_restarted_orchestrator',
        launchedAt: LAUNCHED_AT,
        parentAgent: 'orchestrator',
      }),
      registerSessionAsOrchestrator: register,
    });

    await handleEvent(
      idleEvent(CHILD, { parentID: 'ses_restarted_orchestrator' }),
      deps,
    );

    expect(board.get(CHILD)).toMatchObject({
      parentSessionID: 'ses_restarted_orchestrator',
      recoveredAtStartup: true,
    });
    expect(register).toHaveBeenCalledWith('ses_restarted_orchestrator');
  });

  test('never adopts for an unmanaged parent that is not an orchestrator', async () => {
    const board = new BackgroundJobBoard();
    const register = mock(() => {});
    const { deps } = createDeps(board, managed, {
      resolve: async () => ({
        parentSessionID: 'ses_someone_else',
        launchedAt: LAUNCHED_AT,
        parentAgent: 'fixer',
      }),
      registerSessionAsOrchestrator: register,
    });

    await handleEvent(idleEvent(CHILD, { parentID: 'ses_someone_else' }), deps);

    expect(board.get(CHILD)).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
  });

  test('never registers a row for a disposed instance', async () => {
    const board = new BackgroundJobBoard();
    const { deps, scheduleChildIdleReconciliation } = createDeps(
      board,
      managed,
      { resolve: proven, isDisposed: () => true },
    );

    await handleEvent(idleEvent(CHILD, { parentID: PARENT }), deps);

    // A disposed instance has no live terminal gate to reconcile the row or
    // publish its wake, so registering it would strand the child.
    expect(board.get(CHILD)).toBeUndefined();
    expect(scheduleChildIdleReconciliation).not.toHaveBeenCalled();
  });

  test('never adopts a managed child or a tombstoned one', async () => {
    const board = new BackgroundJobBoard();
    const { deps } = createDeps(board, () => true, { resolve: proven });

    await handleEvent(idleEvent(CHILD, { parentID: PARENT }), deps);
    expect(board.get(CHILD)).toBeUndefined();

    const suppressed = new BackgroundJobBoard();
    recordBackgroundJobSuppression(suppressed, CHILD);
    const { deps: suppressedDeps } = createDeps(suppressed, managed, {
      resolve: proven,
    });
    await handleEvent(idleEvent(CHILD, { parentID: PARENT }), suppressedDeps);
    expect(suppressed.get(CHILD)).toBeUndefined();
  });

  test('never replaces a row the board already tracks', async () => {
    const board = new BackgroundJobBoard();
    const existing = board.registerLaunch({
      taskID: CHILD,
      parentSessionID: PARENT,
      agent: 'explorer',
      background: true,
      now: 1,
    });
    const { deps, scheduleChildIdleReconciliation } = createDeps(
      board,
      managed,
      { resolve: proven },
    );

    await handleEvent(idleEvent(CHILD, { parentID: PARENT }), deps);

    expect(board.get(CHILD)?.generation).toBe(existing.generation);
    // The tracked row keeps its own reconciliation path.
    expect(scheduleChildIdleReconciliation).toHaveBeenCalledTimes(1);
  });

  test('terminal flavor: adopts a proven orphan error and publishes it', async () => {
    const board = new BackgroundJobBoard();
    const { deps, reconcile } = createDeps(board, managed, {
      resolve: proven,
    });

    await handleEvent(
      errorEvent(CHILD, { parentID: PARENT, agent: 'explorer' }),
      deps,
    );

    expect(board.get(CHILD)).toMatchObject({
      taskID: CHILD,
      parentSessionID: PARENT,
      recoveredAtStartup: true,
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[1]).toMatchObject({
      kind: 'session-error',
      message: 'Session error',
    });
  });

  test('terminal flavor: defers a failover error while a fallback is armed', async () => {
    const board = new BackgroundJobBoard();
    const { deps, reconcile } = createDeps(board, managed, {
      resolve: proven,
      willAttemptFallback: () => true,
    });
    const failoverEvent = errorEvent(CHILD, { parentID: PARENT });
    failoverEvent.event.properties.error = {
      name: 'APIError',
      data: { statusCode: 429 },
    } as never;

    await handleEvent(failoverEvent, deps);

    expect(board.get(CHILD)).toBeUndefined();
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe('resolveUndeliveredBackgroundChild (#1560)', () => {
  function launchText(taskID: string): string {
    return (
      `The subagent is working in the background (sessionID: ${taskID}). ` +
      'You will be notified automatically when it finishes.'
    );
  }

  /** A foreground delegation's tool result: no background evidence at all. */
  function foregroundText(taskID: string): string {
    return `task_id: ${taskID}\nstate: running`;
  }

  function delegationMessage(
    taskID: string,
    at: number,
    extra: {
      background?: boolean;
      withTime?: boolean;
      output?: string;
      parentAgent?: string;
    } = {},
  ) {
    const input = {
      agent: 'explorer',
      description: 'delegated',
      prompt: 'find it',
      ...(extra.background === true ? { background: true } : {}),
    };
    return [
      {
        info: {
          id: `call-${taskID}`,
          role: 'assistant',
          agent: extra.parentAgent ?? 'orchestrator',
          ...(extra.withTime === false ? {} : { time: { created: at } }),
        },
        parts: [
          {
            type: 'tool',
            tool: 'task',
            ...(extra.withTime === false
              ? {}
              : { time: { start: at, end: at + 1 } }),
            state: {
              input,
              output: extra.output ?? launchText(taskID),
              status: 'completed',
            },
          },
        ],
      },
    ];
  }

  function deliveryMessage(taskID: string, at: number) {
    return {
      info: {
        id: `delivery-${taskID}`,
        role: 'assistant',
        sessionID: PARENT,
        time: { created: at },
      },
      parts: [
        {
          type: 'text',
          text: `<task id="${taskID}" state="completed">\nDone\n</task>`,
          synthetic: true,
        },
      ],
    };
  }

  function childTranscript(
    prompt = 'find it',
    options: { laterPrompt?: string; error?: boolean } = {},
  ) {
    const data = [
      {
        info: { id: 'child-input-1', role: 'user', time: { created: 20 } },
        parts: [{ type: 'text', text: prompt }],
      },
      {
        info: {
          id: 'child-answer-1',
          role: 'assistant',
          time: { completed: 30 },
          ...(options.error ? { error: { message: 'child failed' } } : {}),
        },
        parts: [{ type: 'text', text: 'Done' }],
      },
    ];
    if (options.laterPrompt !== undefined) {
      data.push(
        {
          info: {
            id: 'child-input-2',
            role: 'user',
            time: { created: 40 },
          },
          parts: [{ type: 'text', text: options.laterPrompt }],
        },
        {
          info: {
            id: 'child-answer-2',
            role: 'assistant',
            time: { completed: 50 },
          },
          parts: [{ type: 'text', text: 'Later answer' }],
        },
      );
    }
    return { data };
  }

  function proverInput(
    transcript: unknown,
    options: {
      fail?: boolean;
      failChild?: boolean;
      childTranscript?: unknown;
      hostParentID?: string | null;
      hostAgent?: string | null;
    } = {},
  ) {
    const reads = { child: 0, parent: 0 };
    return {
      reads,
      input: {
        directory: '/tmp',
        worktree: '/tmp',
        client: {
          session: {
            get: mock(async ({ path }: { path: { id: string } }) => ({
              data:
                path.id === CHILD
                  ? {
                      id: CHILD,
                      ...(options.hostParentID === null
                        ? {}
                        : { parentID: options.hostParentID ?? PARENT }),
                      ...(options.hostAgent === null
                        ? {}
                        : { agent: options.hostAgent ?? 'explorer' }),
                      title: 'delegated work',
                    }
                  : { id: path.id },
            })),
            messages: mock(async ({ path }: { path: { id: string } }) => {
              if (path.id === CHILD) {
                reads.child += 1;
                if (options.failChild) throw new Error('child unavailable');
                return options.childTranscript ?? childTranscript();
              }
              if (path.id === PARENT) {
                reads.parent += 1;
                if (options.fail) throw new Error('host unavailable');
                return transcript;
              }
              return { data: [] };
            }),
          },
        },
      } as never,
      hostFlavor: 'v1',
      parentSessionID: PARENT,
      taskID: CHILD,
    };
  }

  test('proves a background delegation with no native delivery for the run', async () => {
    const transcript = {
      data: delegationMessage(CHILD, 10, { background: true }),
    };

    expect(
      await resolveUndeliveredBackgroundChild(proverInput(transcript)),
    ).toMatchObject({ parentSessionID: PARENT });
  });

  test('requires the terminal child prompt to match the delegation', async () => {
    const proof = proverInput(
      { data: delegationMessage(CHILD, 10, { background: true }) },
      { childTranscript: childTranscript('a different prompt') },
    );

    expect(await resolveUndeliveredBackgroundChild(proof)).toBeUndefined();
    expect(proof.reads).toEqual({ child: 1, parent: 1 });
  });

  test('single-flights concurrent proofs for the same child', async () => {
    const proof = proverInput({
      data: delegationMessage(CHILD, 10, { background: true }),
    });

    const results = await Promise.all([
      resolveUndeliveredBackgroundChild(proof),
      resolveUndeliveredBackgroundChild(proof),
    ]);

    expect(results[0]).toMatchObject({ parentSessionID: PARENT });
    expect(results[1]).toMatchObject({ parentSessionID: PARENT });
    expect(proof.reads).toEqual({ child: 1, parent: 1 });
  });

  test('refuses a launch the parent already saw delivered', async () => {
    const transcript = {
      data: [
        ...delegationMessage(CHILD, 10, { background: true }),
        deliveryMessage(CHILD, 40),
      ],
    };

    expect(
      await resolveUndeliveredBackgroundChild(proverInput(transcript)),
    ).toBeUndefined();
  });

  test('fences native delivery against the classified round completion time', async () => {
    const proof = proverInput({
      data: [
        ...delegationMessage(CHILD, 10, { background: true }),
        deliveryMessage(CHILD, 20),
      ],
    });

    expect(await resolveUndeliveredBackgroundChild(proof)).toMatchObject({
      parentSessionID: PARENT,
    });
  });

  test('refuses a foreground delegation — the parent awaits the tool result', async () => {
    const transcript = {
      data: delegationMessage(CHILD, 10, { output: foregroundText(CHILD) }),
    };

    expect(
      await resolveUndeliveredBackgroundChild(proverInput(transcript)),
    ).toBeUndefined();
  });

  test('refuses a delegation with no launch time — delivery cannot be fenced', async () => {
    const transcript = {
      data: delegationMessage(CHILD, 10, {
        background: true,
        withTime: false,
      }),
    };

    expect(
      await resolveUndeliveredBackgroundChild(proverInput(transcript)),
    ).toBeUndefined();
  });

  test('resolves the parent from the host when the event names none', async () => {
    const transcript = {
      data: delegationMessage(CHILD, 10, { background: true }),
    };
    const { parentSessionID: _named, ...observation } = proverInput(transcript);

    expect(await resolveUndeliveredBackgroundChild(observation)).toMatchObject({
      parentSessionID: PARENT,
      agent: 'explorer',
    });
  });

  test('refuses when the host reports no parent for the child', async () => {
    const transcript = {
      data: delegationMessage(CHILD, 10, { background: true }),
    };
    const { parentSessionID: _named, ...observation } = proverInput(
      transcript,
      { hostParentID: null },
    );

    expect(
      await resolveUndeliveredBackgroundChild(observation),
    ).toBeUndefined();
  });

  test('falls back to the delegation agent when the observation names none', async () => {
    const transcript = {
      data: delegationMessage(CHILD, 10, { background: true }),
    };
    const { parentSessionID: _named, ...observation } = proverInput(
      transcript,
      { hostAgent: null },
    );

    // A later continuation's agent-equality check depends on this value.
    expect(await resolveUndeliveredBackgroundChild(observation)).toMatchObject({
      parentSessionID: PARENT,
      agent: 'explorer',
    });
  });

  test('treats an unreadable transcript as no evidence', async () => {
    expect(
      await resolveUndeliveredBackgroundChild(
        proverInput({ data: [] }, { fail: true }),
      ),
    ).toBeUndefined();
  });

  test('rejects identifiers the host could not have issued', async () => {
    const transcript = {
      data: delegationMessage(CHILD, 10, { background: true }),
    };

    expect(
      await resolveUndeliveredBackgroundChild({
        ...proverInput(transcript),
        taskID: 'not a session id',
      }),
    ).toBeUndefined();
  });

  function resolveForV1Event(
    proof: ReturnType<typeof proverInput>,
  ): typeof resolveUndeliveredBackgroundChild {
    const { parentSessionID: _parentSessionID, ...options } = proof;
    return (observation) =>
      resolveUndeliveredBackgroundChild({ ...options, ...observation });
  }

  function v1ErrorEvent() {
    return {
      event: {
        type: 'session.error',
        properties: {
          sessionID: CHILD,
          error: { name: 'Error', data: { message: 'child failed' } },
        },
      },
    };
  }

  function v1IdleEvent() {
    return {
      event: { type: 'session.idle', properties: { sessionID: CHILD } },
    };
  }

  test('adopts a v1 terminal orphan and publishes its failure once', async () => {
    const board = new BackgroundJobBoard();
    const proof = proverInput(
      { data: delegationMessage(CHILD, 10, { background: true }) },
      { childTranscript: childTranscript('find it', { error: true }) },
    );
    const { deps, reconcile } = createDeps(board, managed, {
      resolve: resolveForV1Event(proof),
    });

    await handleEvent(v1ErrorEvent(), deps);

    expect(board.get(CHILD)).toMatchObject({
      parentSessionID: PARENT,
      state: 'error',
      recoveredAtStartup: true,
    });
    expect(proof.reads).toEqual({ child: 1, parent: 1 });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test('does not adopt after a later foreground child continuation', async () => {
    const board = new BackgroundJobBoard();
    const proof = proverInput(
      { data: delegationMessage(CHILD, 10, { background: true }) },
      {
        childTranscript: childTranscript('find it', {
          laterPrompt: 'continue',
        }),
      },
    );
    const { deps, scheduleChildIdleReconciliation, reconcile } = createDeps(
      board,
      managed,
      { resolve: resolveForV1Event(proof) },
    );

    await handleEvent(v1IdleEvent(), deps);

    expect(board.get(CHILD)).toBeUndefined();
    expect(scheduleChildIdleReconciliation).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test('duplicate v1 idle observations adopt and publish only once', async () => {
    const board = new BackgroundJobBoard();
    const proof = proverInput({
      data: delegationMessage(CHILD, 10, { background: true }),
    });
    const resolve = mock(resolveForV1Event(proof));
    const { deps, reconcile, scheduleChildIdleReconciliation } = createDeps(
      board,
      managed,
      { resolve, reconcileIdle: true },
    );

    await handleEvent(v1IdleEvent(), deps);
    await handleEvent(v1IdleEvent(), deps);

    expect(board.get(CHILD)).toMatchObject({ state: 'completed' });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(scheduleChildIdleReconciliation).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  test('admits a configured non-orchestrator primary and rejects other parents', async () => {
    const primaryBoard = new BackgroundJobBoard();
    const primaryProof = proverInput({
      data: delegationMessage(CHILD, 10, {
        background: true,
        parentAgent: 'planner',
      }),
    });
    const { deps: primaryDeps } = createDeps(primaryBoard, () => false, {
      resolve: resolveForV1Event(primaryProof),
      isPrimaryAgentName: (agent) => agent === 'planner',
    });

    await handleEvent(v1ErrorEvent(), primaryDeps);

    expect(primaryBoard.get(CHILD)).toMatchObject({
      parentSessionID: PARENT,
      recoveredAtStartup: true,
    });

    const otherBoard = new BackgroundJobBoard();
    const otherProof = proverInput({
      data: delegationMessage(CHILD, 10, {
        background: true,
        parentAgent: 'fixer',
      }),
    });
    const { deps: otherDeps, reconcile } = createDeps(otherBoard, () => false, {
      resolve: resolveForV1Event(otherProof),
      isPrimaryAgentName: (agent) => agent === 'planner',
    });

    await handleEvent(v1ErrorEvent(), otherDeps);

    expect(otherBoard.get(CHILD)).toBeUndefined();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test('negative-caches an unchanged terminal proof before rereading parent', async () => {
    const board = new BackgroundJobBoard();
    const proof = proverInput({ data: [] });
    const { deps } = createDeps(board, managed, {
      resolve: resolveForV1Event(proof),
    });

    await handleEvent(v1IdleEvent(), deps);
    await handleEvent(v1IdleEvent(), deps);

    expect(board.get(CHILD)).toBeUndefined();
    expect(proof.reads).toEqual({ child: 2, parent: 1 });
  });

  test('refuses a native v1 delivery at or after the round fence', async () => {
    const board = new BackgroundJobBoard();
    const proof = proverInput({
      data: [
        ...delegationMessage(CHILD, 10, { background: true }),
        deliveryMessage(CHILD, 30),
      ],
    });
    const { deps, reconcile } = createDeps(board, managed, {
      resolve: resolveForV1Event(proof),
    });

    await handleEvent(v1ErrorEvent(), deps);

    expect(board.get(CHILD)).toBeUndefined();
    expect(reconcile).not.toHaveBeenCalled();
    expect(proof.reads).toEqual({ child: 1, parent: 1 });
  });
});
