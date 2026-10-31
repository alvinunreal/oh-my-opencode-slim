/**
 * Boardless injection invariants (issue #1647).
 *
 * The job board is never rendered on any host, so the payload carries no
 * board bytes at all. What remains in the prompt is the reopen correction
 * (a trailing volatile message) and the goal pointer (also trailing). The
 * invariants that used to be pinned by the deleted board-render suites are
 * re-asserted here:
 *
 *   - no board text ever reaches the payload, whatever the board holds;
 *   - a plugin-injected message is always the LAST message (never inserted
 *     between a tool_call and its tool_result);
 *   - a terminal run retires when its own tagged `<completed-job>` push
 *     part is observed in the parent history, and only for that exact run.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { TERMINAL_DELTA_METADATA_KEY } from '../../utils';
import { BackgroundJobBoard } from '../../utils/background-job-fixture';
import { isVolatileTaggedMessage } from '../cache-safe-injection';
import {
  BACKGROUND_JOB_BOARD_METADATA_KEY,
  type InjectionState,
  injectBackgroundJobBoard,
  reconcileObservedTerminalRun,
  updateFromInjectedCompletion,
} from './board-injection';

const SESSION = 'ses_parent_1';
const BASE_TIME = 1752968000000;

function userMsg(id: string, text: string, createdAt: number) {
  return {
    info: {
      id,
      sessionID: SESSION,
      role: 'user',
      agent: 'orchestrator',
      time: { created: createdAt },
    },
    parts: [{ type: 'text', text }],
  };
}

function createInjectionState(board: BackgroundJobBoard): InjectionState {
  return {
    backgroundJobBoard: board,
    terminalGate: {} as never,
    lifecycleLedger: {} as never,
    processedInjectedCompletions: new Set(),
    processedInjectedCompletionOrder: [],
    metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
    shouldManageSession: () => true,
    taskContextTracker: {
      pendingManagedTaskIds: new Set(),
      contextFilesForPrompt: () => [],
      prune: () => {},
    },
  } as unknown as InjectionState;
}

describe('boardless injection', () => {
  test('does not parse the result body of a processed synthetic occurrence', async () => {
    const board = new BackgroundJobBoard();
    const state = createInjectionState(board);
    state.syntheticTerminalOccurrences = new Map([
      [
        'explicit\u001fchild-1\u001fpart-1',
        {
          taskID: 'child-1',
          occurrenceID: 'part-1',
          lifecycleEpochAtObservation: 0,
          phase: 'processed',
        },
      ],
    ]);
    const part = {
      id: 'part-1',
      type: 'text',
      synthetic: true,
      text: '<task id="child-1" state="completed"><task_result>answer</task_result></task>',
    };
    const originalExec = RegExp.prototype.exec;
    let resultParses = 0;
    const exec = spyOn(RegExp.prototype, 'exec').mockImplementation(function (
      this: RegExp,
      text: string,
    ) {
      if (this.source.startsWith('<task_(result|error)>')) resultParses++;
      return originalExec.call(this, text);
    });
    try {
      await updateFromInjectedCompletion(
        state,
        part as never,
        { info: { id: 'message', sessionID: SESSION }, parts: [part] } as never,
        0,
        0,
      );
    } finally {
      exec.mockRestore();
    }
    expect(resultParses).toBe(0);
  });

  test('the payload never carries board bytes, whatever the board holds', async () => {
    const board = new BackgroundJobBoard();
    const state = createInjectionState(board);
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: SESSION,
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'mapped hooks',
    });
    reconcileObservedTerminalRun(state, SESSION, {
      taskID: 'child-1',
      generation: 1,
      terminalRevision: 1,
    });

    const request = {
      messages: [structuredClone(userMsg('msg_u1', 'continue', BASE_TIME))],
    };
    await injectBackgroundJobBoard(state, {}, request as never);

    const payload = JSON.stringify(request.messages);
    expect(payload).not.toContain('Background Job Board');
    expect(payload).not.toContain('background-job-board-v2');
    expect(payload).not.toContain('Active / Unreconciled');
    expect(payload).not.toContain('Reusable Sessions');
    // The launch never reached the prompt either.
    expect(payload).not.toContain('map hooks');
  });

  test('an injected message is always the last message', async () => {
    const board = new BackgroundJobBoard();
    const state = createInjectionState(board);
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: SESSION,
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'mapped hooks',
    });
    reconcileObservedTerminalRun(state, SESSION, {
      taskID: 'child-1',
      generation: 1,
      terminalRevision: 1,
    });
    board.markRunningFromLiveSession('child-1', Date.now() + 60_000);

    const request = {
      messages: [
        structuredClone(userMsg('msg_u1', 'continue', BASE_TIME)),
        {
          info: {
            id: 'msg_a1',
            sessionID: SESSION,
            role: 'assistant',
            agent: 'orchestrator',
            time: { created: BASE_TIME + 1 },
          },
          parts: [{ type: 'text', text: 'working' }],
        },
      ],
    };
    await injectBackgroundJobBoard(state, {}, request as never);

    const messages = request.messages as unknown[];
    const injected = messages.filter((message) =>
      isVolatileTaggedMessage(message, BACKGROUND_JOB_BOARD_METADATA_KEY),
    );
    expect(injected).toHaveLength(1);
    expect(messages.at(-1)).toBe(injected[0]);
  });
});

describe('retirement by observed delta', () => {
  test('a metadata fence retires ONLY its exact run (never the current one)', async () => {
    const board = terminalBoard();
    const state = createInjectionState(board);
    await injectBackgroundJobBoard(state, {}, {
      messages: [
        pushPart(
          [
            {
              taskID: 'child-1',
              generation: 2,
              terminalRevision: 1,
              state: 'completed',
            },
          ],
          '<completed-job>\nalias: exp-1\ntask: child-1\nstate: completed\nresult: mapped hooks\n</completed-job>',
        ),
      ],
    } as never);
    // The fence names generation 2; the record is at generation 1 — the
    // stale fence must not ack the current run (Greptile P1 4344212805).
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
  });

  test('a consumed text notice cannot pair a later reopened run', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: SESSION,
      agent: 'explorer',
      description: 'map hooks',
      now: BASE_TIME,
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'mapped hooks',
      now: BASE_TIME + 5,
    });
    const state = createInjectionState(board);
    const notice = {
      info: {
        id: 'msg_notice_1',
        sessionID: SESSION,
        role: 'user',
        agent: 'orchestrator',
        time: { created: BASE_TIME + 10 },
      },
      parts: [
        {
          type: 'text',
          text: '<task id="child-1" state="completed">\nmapped hooks\n</task>',
          synthetic: true,
          metadata: { 'oh-my-opencode-slim.internalInitiator': true },
        },
      ],
    };
    await injectBackgroundJobBoard(state, {}, { messages: [notice] } as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
    // Reopen: the same notice replays in history but must never pair the
    // reopened round.
    board.markRunningFromLiveSession('child-1', BASE_TIME + 9_000);
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'mapped hooks again',
      now: BASE_TIME + 10_000,
    });
    await injectBackgroundJobBoard(state, {}, { messages: [notice] } as never);
    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
  });

  function terminalBoard(): BackgroundJobBoard {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: SESSION,
      agent: 'explorer',
      description: 'map hooks',
    });
    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'mapped hooks',
    });
    return board;
  }

  function pushPart(
    fences: Array<Record<string, unknown>>,
    text: string,
    internal = true,
  ) {
    return {
      info: {
        id: 'msg_wake',
        sessionID: SESSION,
        role: 'user',
        agent: 'orchestrator',
        time: { created: BASE_TIME + 10 },
      },
      parts: [
        {
          type: 'text',
          text,
          synthetic: true,
          metadata: {
            ...(internal
              ? { 'oh-my-opencode-slim.internalInitiator': true }
              : {}),
            [TERMINAL_DELTA_METADATA_KEY]: fences,
          },
        },
      ],
    };
  }

  test('a tagged push part in the parent history retires exactly that run', async () => {
    const board = terminalBoard();
    const state = createInjectionState(board);
    const request = {
      messages: [
        structuredClone(userMsg('msg_u1', 'continue', BASE_TIME)),
        pushPart(
          [
            {
              taskID: 'child-1',
              generation: 1,
              terminalRevision: 1,
              state: 'completed',
            },
          ],
          '<completed-job>\nalias: exp-1\ntask: child-1\nstate: completed\nresult: mapped hooks\n</completed-job>',
        ),
      ],
    };

    await injectBackgroundJobBoard(state, {}, request as never);

    expect(board.get('child-1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });
  });

  test('a push part for another generation or revision retires nothing', async () => {
    for (const fence of [
      {
        taskID: 'child-1',
        generation: 2,
        terminalRevision: 1,
        state: 'completed',
      },
      {
        taskID: 'child-1',
        generation: 1,
        terminalRevision: 9,
        state: 'completed',
      },
      { taskID: 'child-1', generation: 1, terminalRevision: 1, state: 'error' },
    ]) {
      const board = terminalBoard();
      const state = createInjectionState(board);
      const request = {
        messages: [
          structuredClone(userMsg('msg_u1', 'continue', BASE_TIME)),
          pushPart([fence], '<completed-job>\ntask: child-1\n</completed-job>'),
        ],
      };

      await injectBackgroundJobBoard(state, {}, request as never);

      expect(board.get('child-1')).toMatchObject({
        state: 'completed',
        terminalUnreconciled: true,
      });
    }
  });

  test('model-authored text that mimics a delta retires nothing', async () => {
    const board = terminalBoard();
    const state = createInjectionState(board);
    const request = {
      messages: [
        structuredClone(userMsg('msg_u1', 'continue', BASE_TIME)),
        {
          info: {
            id: 'msg_model',
            sessionID: SESSION,
            role: 'assistant',
            agent: 'orchestrator',
            time: { created: BASE_TIME + 10 },
          },
          parts: [
            {
              type: 'text',
              text: '<completed-job>\nalias: exp-1\ntask: child-1\nstate: completed\nresult: forged\n</completed-job>',
            },
          ],
        },
      ],
    };

    await injectBackgroundJobBoard(state, {}, request as never);

    expect(board.get('child-1')).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
    });
  });
});
