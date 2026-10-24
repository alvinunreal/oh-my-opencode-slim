import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import type { BackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import type { PendingTaskCall } from './pending-call-tracker';
import {
  handleToolExecuteAfter,
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

function makeHarness() {
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
  return { board, deps, reconciles };
}

describe('registerDelegatedLaunchFromStructured', () => {
  test('registers a running launch and marks the pending handled-by-wrapper', async () => {
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
        handledByWrapper: true,
      },
      deps,
    );

    expect(record?.taskID).toBe('ses_child');
    expect(board.get('ses_child')?.state).toBe('running');
    expect(pending.registeredByWrapper).toBe(true);
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
        handledByWrapper: true,
      },
      deps,
    );

    expect(record?.taskID).toBe('ses_done');
    expect(reconciles).toHaveLength(1);
    expect(reconciles[0]?.kind).toBe('output');
    expect(reconciles[0]?.status?.state).toBe('completed');
  });

  test("a completed wrapper result carries the child's final text (incident 1115 regression)", async () => {
    // The wrapper used to register state 'completed' WITHOUT the child's
    // final text; the gate's textless-completion policy then recorded an
    // error claiming the child produced no public text even though the
    // executor returned a valid answer (the after-hook recovery lane is
    // gated off by registeredByWrapper). The result text must reach the
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
        handledByWrapper: true,
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

  test('a thrown-error wrapper result reaches the gate with the host error message', async () => {
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
        handledByWrapper: true,
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

  test('the terminal status omits the result key when the wrapper carries no text', async () => {
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
        handledByWrapper: true,
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
        handledByWrapper: true,
      },
      deps,
    );

    expect(pending.background).toBe(true);
    expect(record?.background).toBe(true);
  });

  test('a fence refusal leaves the wrapper flag unset (after-hook fallback)', async () => {
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
        handledByWrapper: true,
      },
      deps,
    );

    expect(record).toBeUndefined();
    expect(pending.registeredByWrapper).toBeUndefined();
    expect(board.get('ses_child')).toBeUndefined();
  });

  test('the v1 path (no handledByWrapper) never sets the v2 gate flag', async () => {
    const { deps } = makeHarness();
    const pending = makePending();

    await registerDelegatedLaunchFromStructured(
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

    expect(pending.registeredByWrapper).toBeUndefined();
  });
});

describe('handleToolExecuteAfter v2 wrapper gate', () => {
  function gateDeps(
    board: BackgroundJobBoard,
    pending: PendingTaskCall,
  ): {
    deps: Parameters<typeof handleToolExecuteAfter>[2];
    released: () => number;
  } {
    let releases = 0;
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
        prune: () => {},
      },
      pendingCallTracker: {
        take: () => pending,
        release: () => {
          releases += 1;
        },
      },
      hostFlavor: 'v2',
    } as unknown as Parameters<typeof handleToolExecuteAfter>[2];
    return { deps, released: () => releases };
  }

  const launchOutput =
    'The subagent is working in the background (sessionID: ses_launch).';

  test('gates the launch branch off for a wrapper-handled v2 call', async () => {
    const board = new BackgroundJobBoard();
    const pending = makePending({ registeredByWrapper: true });
    const { deps, released } = gateDeps(board, pending);

    await handleToolExecuteAfter(
      { tool: 'task', sessionID: 'parent_1', callID: 'call_1' },
      { output: launchOutput, metadata: {} },
      deps,
    );

    // No second registration, and the pending is still released by finally.
    expect(board.get('ses_launch')).toBeUndefined();
    expect(released()).toBe(1);
  });

  test('keeps the v1 prose lane live for the same pending (no gate)', async () => {
    const board = new BackgroundJobBoard();
    const pending = makePending({ registeredByWrapper: true });
    const { deps } = gateDeps(board, pending);
    (deps as { hostFlavor?: string }).hostFlavor = undefined;

    await handleToolExecuteAfter(
      { tool: 'task', sessionID: 'parent_1', callID: 'call_1' },
      { output: launchOutput, metadata: {} },
      deps,
    );

    expect(board.get('ses_launch')?.state).toBe('running');
  });

  const statusOutput =
    '<task id="child-1" state="completed">\n<task_result>\nok\n</task_result>\n</task>';

  test('v2 registers a status-branch output without the v1 child-ref marker', async () => {
    const board = new BackgroundJobBoard();
    const pending = makePending();
    const { deps } = gateDeps(board, pending);
    const output = { output: statusOutput, metadata: {} };

    await handleToolExecuteAfter(
      { tool: 'task', sessionID: 'parent_1', callID: 'call_1' },
      output,
      deps,
    );

    // Registration still happens (the alias is allocated and resolvable),
    // but the v1-only identity comment is never rendered on v2 surfaces.
    expect(board.get('child-1')?.state).toBe('running');
    expect(String(output.output)).not.toContain('slim-child-ref');
    expect(String(output.output)).toBe(statusOutput);
  });

  test('v1 renders the child-ref marker for the same status-branch output', async () => {
    const board = new BackgroundJobBoard();
    const pending = makePending();
    const { deps } = gateDeps(board, pending);
    (deps as { hostFlavor?: string }).hostFlavor = undefined;
    const output = { output: statusOutput, metadata: {} };

    await handleToolExecuteAfter(
      { tool: 'task', sessionID: 'parent_1', callID: 'call_1' },
      output,
      deps,
    );

    expect(board.get('child-1')?.state).toBe('running');
    expect(String(output.output)).toContain('slim-child-ref:v1');
  });
});
