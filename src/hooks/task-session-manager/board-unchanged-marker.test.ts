import { describe, expect, test } from 'bun:test';
import {
  FixtureBoard as BackgroundJobBoard,
  createBackgroundJobLifecycle,
} from '../../background-jobs';
import {
  BACKGROUND_JOB_BOARD_METADATA_KEY,
  type InjectionState,
  injectBackgroundJobBoard,
} from './board-injection';

const SESSION = 'ses_board_unchanged';

type Message = {
  info: { role: string; id?: string };
  parts: Array<{
    type: string;
    text?: string;
    metadata?: Record<string, unknown>;
  }>;
};

function user(id: string) {
  return {
    info: { role: 'user', agent: 'orchestrator', sessionID: SESSION, id },
    parts: [{ type: 'text', text: `Continue ${id}` }],
  };
}

function stateFor(
  board: BackgroundJobBoard,
  boardInjection?: boolean,
): InjectionState {
  return {
    backgroundJobs: createBackgroundJobLifecycle({
      backgroundJobBoard: board,
    }),
    lifecycleLedger: {} as never,
    maxRetainedSnapshots: 20,
    strategy: 'latest',
    boardInjection,
    processedInjectedCompletions: new Set(),
    processedInjectedCompletionOrder: [],
    terminalJobsInjectedByParent: new Map(),
    pendingInjectedTerminalJobsByParent: new Map(),
    metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
    shouldManageSession: () => true,
    taskContextTracker: {
      pendingManagedTaskIds: new Set(),
      contextFilesForPrompt: () => [],
      prune: () => {},
    },
    retainedBoardSnapshots: new Map(),
    retainedTailBoards: new Map(),
  } as unknown as InjectionState;
}

function setup(boardInjection?: boolean) {
  const board = new BackgroundJobBoard();
  board.registerLaunch({
    taskID: 'child-1',
    parentSessionID: SESSION,
    agent: 'explorer',
    description: 'map hooks',
  });
  return { board, state: stateFor(board, boardInjection) };
}

async function inject(
  state: InjectionState,
  history: unknown[],
): Promise<Message[]> {
  // Host requests start from real history, not earlier injected parts.
  const output = { messages: structuredClone(history) };
  await injectBackgroundJobBoard(state, {}, output as never);
  return output.messages as Message[];
}

function boardParts(messages: Message[]) {
  return messages.flatMap((message) =>
    message.parts.filter(
      (part) => part.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY] === true,
    ),
  );
}

function isMarker(text: string | undefined): boolean {
  return text?.includes('unchanged since the last full') ?? false;
}

describe('latest board unchanged marker', () => {
  test('T1: three unchanged user turns freeze one full board and two markers', async () => {
    const { state } = setup();
    const history: unknown[] = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      history.push(user(`u${turn}`));
      const texts = boardParts(await inject(state, history)).map((p) => p.text);
      expect(texts).toHaveLength(turn);
      expect(texts.map(isMarker)).toEqual(
        Array.from({ length: turn }, (_, index) => index > 0),
      );
    }
  });

  test('T2: complete provider-visible messages remain an append-only prefix', async () => {
    const { state } = setup();
    const history: unknown[] = [user('u1')];
    let previous = (await inject(state, history)).map((message) =>
      JSON.stringify(message),
    );
    for (const id of ['u2', 'u3']) {
      history.push(user(id));
      const current = (await inject(state, history)).map((message) =>
        JSON.stringify(message),
      );
      expect(current.slice(0, previous.length)).toEqual(previous);
      previous = current;
    }
  });

  test('T3: a Result always gets a full board and registers its execution', async () => {
    const { board, state } = setup();
    await inject(state, [user('u1')]);
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'mapped hooks',
    });
    const history = [user('u1'), user('u2')];
    const first = boardParts(await inject(state, history)).at(-1)?.text;
    expect(first).toContain('Result: mapped hooks');
    expect(isMarker(first)).toBe(false);
    expect(
      [
        ...(state.terminalJobsInjectedByParent
          .get(SESSION)
          ?.executions.values() ?? []),
      ].some((execution) => execution.taskID === 'child-1'),
    ).toBe(true);
    const retry = boardParts(await inject(state, history)).at(-1)?.text;
    expect(retry).toBe(first);
  });

  test('T4: a changed board starts a new complete snapshot', async () => {
    const { board, state } = setup();
    await inject(state, [user('u1')]);
    board.registerLaunch({
      taskID: 'child-2',
      parentSessionID: SESSION,
      agent: 'oracle',
      description: 'review changes',
    });
    const parts = boardParts(await inject(state, [user('u1'), user('u2')]));
    expect(isMarker(parts[1]?.text)).toBe(false);
    expect(parts[1]?.text).toContain('child-2');
  });

  test('T5: after nine markers the eleventh turn refreshes the full board', async () => {
    const { state } = setup();
    const history: unknown[] = [];
    for (let turn = 1; turn <= 11; turn += 1) {
      history.push(user(`u${turn}`));
      const parts = boardParts(await inject(state, history));
      expect(isMarker(parts.at(-1)?.text)).toBe(turn > 1 && turn < 11);
    }
  });

  test('T6: a missing full-board anchor cannot leave orphan markers', async () => {
    const { state } = setup();
    await inject(state, [user('u1')]);
    const previous = await inject(state, [user('u1'), user('u2')]);
    expect(isMarker(boardParts(previous).at(-1)?.text)).toBe(true);
    const afterRevert = await inject(state, [user('u2'), user('u3')]);
    const parts = boardParts(afterRevert);
    expect(parts).toHaveLength(1);
    expect(isMarker(parts.at(-1)?.text)).toBe(false);
    expect(parts.at(-1)?.text).toContain('### Background Job Board');
  });

  test('T6b: retrying the same tail after pruning its full reference restores a full board', async () => {
    const { state } = setup();
    await inject(state, [user('u1')]);
    const second = await inject(state, [user('u1'), user('u2')]);
    expect(isMarker(boardParts(second).at(-1)?.text)).toBe(true);

    const retried = await inject(state, [user('u2')]);
    const parts = boardParts(retried);
    expect(parts).toHaveLength(1);
    expect(isMarker(parts[0]?.text)).toBe(false);
  });

  test('T3b: an unchanged unreconciled Result board remains complete', async () => {
    const { board, state } = setup();
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'mapped hooks',
    });
    const first = boardParts(await inject(state, [user('u1')])).at(-1)?.text;
    expect(first).toContain('Result: mapped hooks');

    state.terminalJobsInjectedByParent.clear();
    state.pendingInjectedTerminalJobsByParent.clear();
    const next = boardParts(await inject(state, [user('u1'), user('u2')])).at(
      -1,
    )?.text;
    expect(next).toContain('Result: mapped hooks');
    expect(isMarker(next)).toBe(false);
  });

  test('T6c: pruning a newer full board also drops its marker despite an older complete board', async () => {
    const { board, state } = setup();
    await inject(state, [user('u1')]);
    board.registerLaunch({
      taskID: 'child-2',
      parentSessionID: SESSION,
      agent: 'oracle',
      description: 'review',
    });
    await inject(state, [user('u1'), user('u2')]);
    const third = await inject(state, [user('u1'), user('u2'), user('u3')]);
    expect(isMarker(boardParts(third).at(-1)?.text)).toBe(true);

    const out = await inject(state, [user('u1'), user('u3'), user('u4')]);
    const u3 = out.find((message) => message.info.id === 'u3');
    const u3Board = u3?.parts.filter(
      (part) => part.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY] === true,
    );
    expect(u3Board).toHaveLength(0);
  });

  test('T7: retrying the same tail preserves its previously recorded bytes', async () => {
    const { state } = setup();
    await inject(state, [user('u1')]);
    const history = [user('u1'), user('u2')];
    const first = await inject(state, history);
    const second = await inject(state, history);
    expect(isMarker(boardParts(first).at(-1)?.text)).toBe(true);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test('T8: after a marker, an assistant-tail tool loop gets the full volatile board', async () => {
    const { state } = setup();
    const history: unknown[] = [user('u1'), user('u2')];
    await inject(state, [user('u1')]);
    await inject(state, history);
    history.push({
      info: {
        role: 'assistant',
        agent: 'orchestrator',
        sessionID: SESSION,
        id: 'a3',
      },
      parts: [
        {
          type: 'tool',
          tool: 'read',
          callID: 'read-1',
          state: { status: 'completed', input: {}, output: 'ok' },
        },
      ],
    });
    history.push({
      info: {
        role: 'user',
        agent: 'orchestrator',
        sessionID: SESSION,
        id: 'r3',
      },
      parts: [
        {
          type: 'tool',
          tool: 'read',
          callID: 'read-1',
          state: { status: 'completed', input: {}, output: 'ok' },
        },
      ],
    });
    history.push({
      info: {
        role: 'assistant',
        agent: 'orchestrator',
        sessionID: SESSION,
        id: 'a4',
      },
      parts: [{ type: 'text', text: 'Next tool step' }],
    });
    const output = await inject(state, history);
    expect(output.at(-1)?.info.role).toBe('user');
    expect(output.at(-1)?.parts[0]?.text).toContain('### Background Job Board');
    expect(isMarker(output.at(-1)?.parts[0]?.text)).toBe(false);
    expect(isMarker(boardParts(output)[1]?.text)).toBe(true);
  });

  test('T9: an assistant-tail board message id follows its text, not the turn', async () => {
    const { board, state } = setup();
    const history = [
      user('u1'),
      {
        info: { role: 'assistant', sessionID: SESSION, id: 'a1' },
        parts: [{ type: 'text', text: 'Tool step' }],
      },
    ];
    const first = (await inject(state, history)).at(-1);
    expect((await inject(state, history)).at(-1)?.info.id).toBe(first?.info.id);
    board.registerLaunch({
      taskID: 'child-2',
      parentSessionID: SESSION,
      agent: 'oracle',
      description: 'review changes',
    });
    const changed = (await inject(state, history)).at(-1);
    expect(changed?.parts[0]?.text).toContain('child-2');
    // Plugins that keep a message part's first-seen text by message id
    // (magic-context) would otherwise replay the stale board all turn.
    expect(changed?.info.id).not.toBe(first?.info.id);
  });
});

describe('backgroundJobs.boardInjection switch (#1314 thread)', () => {
  test('off: no board part is injected even with active jobs', async () => {
    const { state } = setup(false);
    const output = await inject(state, [user('switch-off')]);
    expect(boardParts(output)).toHaveLength(0);
  });

  test('default (undefined) and explicit true keep injecting the board', async () => {
    for (const flag of [undefined, true] as const) {
      const { state } = setup(flag);
      const output = await inject(state, [user('switch-on')]);
      expect(
        boardParts(output).some((p) =>
          p.text?.includes('Background Job Board'),
        ),
      ).toBe(true);
    }
  });
});
