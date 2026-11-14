import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import type { BackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import {
  createPendingCallTracker,
  type PendingTaskCall,
} from './pending-call-tracker';
import {
  handleToolExecuteAfter,
  handleToolExecuteBefore,
  type RegisterDelegatedLaunchDeps,
  registerDelegatedLaunchFromStructured,
} from './tool-execute-hooks';

function makePending(
  overrides: Partial<PendingTaskCall> = {},
): PendingTaskCall {
  return {
    callId: 'call_1',
    parentSessionId: 'parent_1',
    agentType: 'explorer',
    label: 'label',
    fullObjective: 'objective',
    background: true,
    lifecycleEpoch: 0,
    ...overrides,
  };
}

function makeHarness(
  options: { pending?: PendingTaskCall; hostFlavor?: string } = {},
) {
  const board = new BackgroundJobBoard();
  const reconciles: Array<{
    kind?: string;
    status?: {
      taskID?: string;
      state?: string;
      timedOut?: boolean;
      result?: string;
    };
  }> = [];
  let releases = 0;
  const deps: RegisterDelegatedLaunchDeps = {
    directory: '/tmp',
    backgroundJobBoard: board,
    terminalGate: {
      reconcile: async (_record: unknown, signal: unknown) => {
        reconciles.push(
          signal as {
            kind?: string;
            status?: { taskID?: string; state?: string; result?: string };
          },
        );
        return undefined;
      },
    } as unknown as BackgroundJobTerminalGate,
    taskContextTracker: {
      pendingManagedTaskIds: new Set<string>(),
      addContext: () => {},
      contextFilesForPrompt: () => [],
    },
    bindConcurrencyTicket: () => {},
    clearRehydrateTombstone: () => {},
  };
  // After-hook shape: the tracker is the only extra dependency, and the
  // release counter proves the pending was consumed exactly once.
  const afterDeps = {
    ...deps,
    taskContextTracker: { ...deps.taskContextTracker, prune: () => {} },
    pendingCallTracker: {
      take: () => options.pending,
      release: () => {
        releases += 1;
      },
    },
    hostFlavor: options.hostFlavor,
  } as unknown as Parameters<typeof handleToolExecuteAfter>[2];
  return { board, deps, reconciles, afterDeps, released: () => releases };
}

describe('registerDelegatedLaunchFromStructured', () => {
  test('registers a running launch and confirms its identity', async () => {
    const { board, deps, reconciles } = makeHarness();
    const pending = makePending();

    const record = await registerDelegatedLaunchFromStructured(
      {
        callID: 'call_1',
        childTaskID: 'ses_child',
        state: 'running',
        background: false,
        exactCallConfirmed: true,
        pending,
      },
      deps,
    );

    expect(record?.taskID).toBe('ses_child');
    expect(board.get('ses_child')?.state).toBe('running');
    expect(deps.taskContextTracker.pendingManagedTaskIds.has('ses_child')).toBe(
      true,
    );
    // Running results never reconcile the terminal gate.
    expect(reconciles).toHaveLength(0);
  });

  test('routes a terminal structured state through the terminal gate', async () => {
    const { deps, reconciles } = makeHarness();
    const pending = makePending();

    const record = await registerDelegatedLaunchFromStructured(
      {
        callID: 'call_1',
        childTaskID: 'ses_done',
        state: 'completed',
        background: false,
        exactCallConfirmed: true,
        pending,
      },
      deps,
    );

    expect(record?.taskID).toBe('ses_done');
    expect(reconciles).toHaveLength(1);
    expect(reconciles[0]?.kind).toBe('output');
    expect(reconciles[0]?.status?.state).toBe('completed');
  });

  test("a completed structured result carries the child's final text (incident 1115 regression)", async () => {
    // The wrapper used to register state 'completed' WITHOUT the child's
    // final text; the gate's textless-completion policy then recorded an
    // error claiming the child produced no public text even though the
    // executor returned a valid answer (the after-hook recovery lane is
    // handled by tool execution). The result text must reach the
    // gate so the policy cannot misfire on the wrapper path.
    const { deps, reconciles } = makeHarness();
    const pending = makePending();
    const result =
      '<subagent sessionID="ses_done" state="completed">\n  <result>ok</result>\n</subagent>';

    await registerDelegatedLaunchFromStructured(
      {
        callID: 'call_1',
        childTaskID: 'ses_done',
        state: 'completed',
        background: false,
        result,
        exactCallConfirmed: true,
        pending,
      },
      deps,
    );

    expect(reconciles).toHaveLength(1);
    expect(reconciles[0]?.status).toEqual({
      taskID: 'ses_done',
      state: 'completed',
      timedOut: false,
      result,
    });
  });

  test('a thrown-error structured result reaches the gate with the host error message', async () => {
    const { deps, reconciles } = makeHarness();
    const pending = makePending();

    await registerDelegatedLaunchFromStructured(
      {
        callID: 'call_1',
        childTaskID: 'ses_fail',
        state: 'error',
        background: false,
        result: 'Subagent failed (sessionID: ses_fail): provider timeout',
        exactCallConfirmed: true,
        pending,
      },
      deps,
    );

    expect(reconciles).toHaveLength(1);
    expect(reconciles[0]?.status).toEqual({
      taskID: 'ses_fail',
      state: 'error',
      timedOut: false,
      result: 'Subagent failed (sessionID: ses_fail): provider timeout',
    });
  });

  test('the terminal status omits the result key when the registration carries no text', async () => {
    const { deps, reconciles } = makeHarness();
    const pending = makePending();

    await registerDelegatedLaunchFromStructured(
      {
        callID: 'call_1',
        childTaskID: 'ses_done',
        state: 'completed',
        background: false,
        exactCallConfirmed: true,
        pending,
      },
      deps,
    );

    expect(reconciles).toHaveLength(1);
    expect(reconciles[0]?.status).toEqual({
      taskID: 'ses_done',
      state: 'completed',
      timedOut: false,
    });
  });

  test('applies host-confirmed background promotion before registration', async () => {
    const { deps } = makeHarness();
    const pending = makePending({ background: false });

    const record = await registerDelegatedLaunchFromStructured(
      {
        callID: 'call_1',
        childTaskID: 'ses_promoted',
        state: 'running',
        background: true,
        exactCallConfirmed: true,
        pending,
      },
      deps,
    );

    expect(pending.background).toBe(true);
    expect(record?.background).toBe(true);
  });

  test('a fence refusal does not register a child', async () => {
    const { board, deps } = makeHarness();
    const pending = makePending({ resumedTaskId: 'ses_other' });

    const record = await registerDelegatedLaunchFromStructured(
      {
        callID: 'call_1',
        childTaskID: 'ses_child',
        state: 'running',
        background: false,
        exactCallConfirmed: true,
        pending,
      },
      deps,
    );

    expect(record).toBeUndefined();
    expect(board.get('ses_child')).toBeUndefined();
  });
});

describe('parent-scoped pending consumption', () => {
  test('the after-hook consumes only its own parent when two parents share a call ID', async () => {
    const tracker = createPendingCallTracker();
    const board = new BackgroundJobBoard();
    const first = makePending({
      callId: 'call_shared',
      parentSessionId: 'parent_1',
    });
    const second = makePending({
      callId: 'call_shared',
      parentSessionId: 'parent_2',
    });
    tracker.add(first);
    tracker.add(second);
    const deps = {
      directory: '/tmp',
      backgroundJobBoard: board,
      terminalGate: {
        reconcile: async () => undefined,
      } as unknown as BackgroundJobTerminalGate,
      taskContextTracker: {
        pendingManagedTaskIds: new Set<string>(),
        addContext: () => {},
        contextFilesForPrompt: () => [],
      },
      pendingCallTracker: tracker,
      hostFlavor: 'v2',
    } as unknown as Parameters<typeof handleToolExecuteAfter>[2];

    await handleToolExecuteAfter(
      { tool: 'task', sessionID: 'parent_2', callID: 'call_shared' },
      { output: '', metadata: {} },
      deps,
    );

    // The after-hook consumes THIS parent's pending; the other parent's
    // identically named call must survive to its own after-hook.
    expect(tracker.peekByCallId('call_shared', 'parent_2')).toBeUndefined();
    expect(tracker.peekByCallId('call_shared', 'parent_1')).toBe(first);
  });

  test('the before-hook error cleanup removes only its own pending', async () => {
    const tracker = createPendingCallTracker();
    const board = new BackgroundJobBoard();
    const other = makePending({
      callId: 'call_shared',
      parentSessionId: 'parent_1',
    });
    tracker.add(other);
    const deps = {
      shouldManageSession: () => true,
      backgroundJobBoard: board,
      pendingCallTracker: tracker,
      taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
      backgroundTaskConcurrency: {
        acquire: () => ({
          ready: Promise.reject(new Error('admission cancelled')),
          releaseIfUnbound: () => {},
        }),
      },
    } as unknown as Parameters<typeof handleToolExecuteBefore>[2];

    await expect(
      handleToolExecuteBefore(
        { tool: 'task', sessionID: 'parent_2', callID: 'call_shared' },
        {
          args: {
            subagent_type: 'explorer',
            prompt: 'work',
            background: true,
          },
        },
        deps,
      ),
    ).rejects.toThrow('admission cancelled');

    expect(tracker.peekByCallId('call_shared', 'parent_2')).toBeUndefined();
    expect(tracker.peekByCallId('call_shared', 'parent_1')).toBe(other);
  });
});

describe('handleToolExecuteAfter launch registration', () => {
  const launchOutput =
    'The subagent is working in the background (sessionID: ses_launch).';

  test('registers a launch from v1 tool output', async () => {
    const { board, afterDeps: deps } = makeHarness({
      pending: makePending(),
      hostFlavor: 'v1',
    });

    await handleToolExecuteAfter(
      { tool: 'task', sessionID: 'parent_1', callID: 'call_1' },
      { output: launchOutput, metadata: {} },
      deps,
    );

    expect(board.get('ses_launch')?.state).toBe('running');
  });

  const statusOutput =
    '<task id="child-1" state="completed">\n<task_result>\nok\n</task_result>\n</task>';

  test.each([
    ['v2', false],
    ['v1', true],
  ] as const)(
    'the %s status branch registers the launch with marker=%s',
    async (hostFlavor, expectedMarker) => {
      const { board, afterDeps: deps } = makeHarness({
        pending: makePending(),
        hostFlavor,
      });
      const output = { output: statusOutput, metadata: {} };

      await handleToolExecuteAfter(
        { tool: 'task', sessionID: 'parent_1', callID: 'call_1' },
        output,
        deps,
      );

      // The alias is allocated and resolvable on both hosts; only the
      // v1-only identity comment is flavor-dependent.
      expect(board.get('child-1')?.state).toBe('running');
      expect(String(output.output).includes('slim-child-ref:v1')).toBe(
        expectedMarker,
      );
      if (!expectedMarker) expect(String(output.output)).toBe(statusOutput);
    },
  );
});
