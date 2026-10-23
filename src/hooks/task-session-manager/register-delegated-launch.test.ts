import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import type { BackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import {
  handleToolExecuteAfter,
  type RegisterDelegatedLaunchDeps,
  registerDelegatedLaunchFromStructured,
} from './tool-execute-hooks';
import type { PendingTaskCall } from './pending-call-tracker';

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
  const reconciles: Array<{ kind?: string; status?: { state?: string } }> = [];
  const deps: RegisterDelegatedLaunchDeps = {
    directory: '/tmp',
    backgroundJobBoard: board,
    terminalGate: {
      reconcile: async (_record: unknown, signal: unknown) => {
        reconciles.push(
          signal as { kind?: string; status?: { state?: string } },
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
});
