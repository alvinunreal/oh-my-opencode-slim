/**
 * Regression coverage for the Background Job Board prompt-cache breakpoint bug.
 *
 * Real same-session dumps (2026-07-23, ses_11145863…, dumps 000164–000169)
 * showed the same failure on every consecutive request pair: the board sat at
 * the very tail, but the conversation advanced by ~2 messages per turn, so the
 * first byte divergence landed exactly at the board position and ~243 KB of
 * tail was re-written as cache on every call. The frozen cache-read at the
 * system boundary is the field signature.
 *
 * Root cause: the provider caches only the last TWO messages (Anthropic:
 * `provider/transform.ts applyCaching → final.slice(-2)`), and the provider
 * SDK coalesces adjacent same-role `user` messages. A board injected as its
 * OWN trailing `user` message merges into the preceding user tool_result
 * message and collapses both tail breakpoints onto the single merged block —
 * so the only readable breakpoint sits on the volatile board, which moves to a
 * new tail every request. The deepest reusable breakpoint therefore regresses
 * to the stable system boundary.
 *
 * Fix: inject the board as a trailing PART on the last real message. The
 * message COUNT stays identical to a board-free render, so the provider's
 * second tail breakpoint lands on the previous (byte-stable, real) message,
 * which the next request reproduces exactly and can read from cache.
 *
 * This suite models core's caching + SDK merge to prove the readable
 * breakpoint now falls on stable real content.
 */
import { describe, expect, mock, test } from 'bun:test';
import { DEFAULT_MAX_RETAINED_SNAPSHOTS } from '../../config/constants';
import { BackgroundJobBoard } from '../../utils';
import {
  BACKGROUND_JOB_BOARD_METADATA_KEY,
  createTaskSessionManagerHook,
} from './index';

const SESSION = 'ses_orchestrator_1114';

function createHook(board: BackgroundJobBoard) {
  return createTaskSessionManagerHook(
    {
      client: { session: { status: mock(async () => ({ data: {} })) } },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      maxSessionsPerAgent: 4,
      maxRetainedSnapshots: DEFAULT_MAX_RETAINED_SNAPSHOTS,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    },
  );
}

function userMsg(id: string, text: string) {
  return {
    info: { role: 'user', agent: 'orchestrator', sessionID: SESSION, id },
    parts: [{ type: 'text', text }],
  };
}

/** An assistant turn issuing a tool call, followed by its user tool_result. */
function toolTurn(id: string, output: string) {
  return [
    {
      info: {
        role: 'assistant',
        agent: 'orchestrator',
        sessionID: SESSION,
        id: `${id}-a`,
      },
      parts: [
        { type: 'text', text: ' ' },
        {
          type: 'tool',
          tool: 'read',
          callID: `${id}-call`,
          state: { status: 'completed', input: {}, output: 'x' },
        },
      ],
    },
    {
      info: {
        role: 'user',
        agent: 'orchestrator',
        sessionID: SESSION,
        id: `${id}-r`,
      },
      parts: [
        {
          type: 'tool',
          tool: 'read',
          callID: `${id}-call`,
          state: { status: 'completed', input: {}, output },
        },
      ],
    },
  ];
}

async function inject(
  hook: ReturnType<typeof createTaskSessionManagerHook>,
  history: unknown[],
): Promise<unknown[]> {
  // opencode rebuilds msgs from storage every request; the board is never
  // persisted, so each request starts from real history only.
  const request = { messages: structuredClone(history) };
  await hook['experimental.chat.messages.transform']({}, request as never);
  await hook.injectBackgroundJobBoard({}, request as never);
  return request.messages;
}

type Msg = {
  info: { role: string; id?: string };
  parts: { metadata?: Record<string, unknown> }[];
};

/**
 * Faithful model of the provider cache pipeline that produced the field bug,
 * in the exact order opencode runs it (`provider/transform.ts`):
 *
 *   1. `applyCaching` selects the breakpoint messages as `msgs.slice(-2)` over
 *      the message array BEFORE the SDK coalesces roles. This ordering is why
 *      the bug exists: a separate trailing board `user` message makes the last
 *      two messages [tool_result(user), board(user)], so NEITHER breakpoint
 *      lands on the preceding assistant turn.
 *   2. the provider SDK then coalesces adjacent same-role messages, so the two
 *      selected user messages merge and only the final block (the board) keeps
 *      an effective cache_control.
 *
 * A breakpoint is READABLE next request only if the exact byte prefix ending
 * at that breakpoint message reproduces. Returns the readable byte-prefixes
 * this request establishes (one per breakpoint message, measured over the full
 * ordered block stream).
 */
function readableCachePrefixes(messages: unknown[]): string[] {
  const msgs = messages as Msg[];

  // Assign each message to its post-merge coalesced-turn index.
  const turnOfMessage: number[] = [];
  const turnEndPrefix: string[] = [];
  let acc = '';
  let turnIndex = -1;
  let prevRole: string | undefined;
  for (const message of msgs) {
    if (message.info.role !== prevRole) {
      turnIndex += 1;
      prevRole = message.info.role;
    }
    for (const part of message.parts) acc += JSON.stringify(part);
    turnOfMessage.push(turnIndex);
    turnEndPrefix[turnIndex] = acc; // running end-of-turn prefix
  }

  // applyCaching selects the last two MESSAGES (pre-merge). Each realizes its
  // cache_control on the LAST block of the coalesced turn it merges into, so
  // the readable prefix ends at that turn's end — not the message's own end.
  const breakpointMessages = [msgs.length - 2, msgs.length - 1].filter(
    (i) => i >= 0,
  );
  const prefixes = new Set<string>();
  for (const mi of breakpointMessages) {
    prefixes.add(turnEndPrefix[turnOfMessage[mi]]);
  }
  return [...prefixes];
}

/** Simulate the OLD placement: board as its own trailing user message. */
function withSeparateBoardMessage(
  messages: unknown[],
  reminderText: string,
): unknown[] {
  return [
    ...(messages as unknown[]),
    {
      info: {
        role: 'user',
        agent: 'orchestrator',
        sessionID: SESSION,
        id: 'board-msg',
      },
      parts: [
        {
          type: 'text',
          synthetic: true,
          text: reminderText,
          metadata: { [BACKGROUND_JOB_BOARD_METADATA_KEY]: true },
        },
      ],
    },
  ];
}

describe('background job board cache breakpoint stability', () => {
  test('a readable cache breakpoint falls on byte-stable real content across turns', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: SESSION,
      agent: 'librarian',
      description: 'research',
    });
    const hook = createHook(board);

    // Request N: history ends with a tool_result turn; board injected at tail.
    const historyN = [
      userMsg('u1', 'Coordinate'),
      ...toolTurn('t1', 'result-1'),
    ];
    const outN = await inject(hook, historyN);

    // Request N+1: the agent loop advanced by another tool turn.
    const historyN1 = [
      userMsg('u1', 'Coordinate'),
      ...toolTurn('t1', 'result-1'),
      ...toolTurn('t2', 'result-2'),
    ];
    const outN1 = await inject(hook, historyN1);

    // NEW placement: at least one readable byte-prefix from request N is a
    // prefix of request N+1's full byte stream — the provider can resume the
    // cache there instead of re-writing the whole tail.
    const prefixesN = readableCachePrefixes(outN);
    const streamN1 = readableCachePrefixes(outN1).at(-1) ?? '';
    const readable = prefixesN.filter((p) => streamN1.startsWith(p));
    expect(readable.length).toBeGreaterThan(0);

    // CONTRAST: the OLD separate-message placement establishes no readable
    // prefix — its only breakpoints sit on the merged tool_result+board turn
    // and the board turn, both of which N+1 does not reproduce at that offset.
    const oldReminder = board.formatForPrompt(SESSION) ?? '';
    const oldN = withSeparateBoardMessage(
      [userMsg('u1', 'Coordinate'), ...toolTurn('t1', 'result-1')],
      oldReminder,
    );
    const oldN1 = withSeparateBoardMessage(
      [
        userMsg('u1', 'Coordinate'),
        ...toolTurn('t1', 'result-1'),
        ...toolTurn('t2', 'result-2'),
      ],
      oldReminder,
    );
    const oldPrefixesN = readableCachePrefixes(oldN);
    const oldStreamN1 = readableCachePrefixes(oldN1).at(-1) ?? '';
    const oldReadable = oldPrefixesN.filter((p) => oldStreamN1.startsWith(p));
    expect(oldReadable.length).toBe(0);
  });

  test('board is a trailing part on the last message, keeping message count board-free-equal', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: SESSION,
      agent: 'librarian',
      description: 'research',
    });
    const hook = createHook(board);

    const history = [
      userMsg('u1', 'Coordinate'),
      ...toolTurn('t1', 'result-1'),
    ];

    const emptyHook = createHook(new BackgroundJobBoard());
    const boardFree = await inject(emptyHook, history);
    const withBoard = await inject(hook, history);

    // No new message is created for the board.
    expect((withBoard as unknown[]).length).toBe(
      (boardFree as unknown[]).length,
    );

    // The single board part is the last part of the last message.
    const boardParts = (withBoard as Msg[]).flatMap((m, i) =>
      m.parts
        .map((p, pi) => ({ i, pi, p }))
        .filter(
          ({ p }) => p.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY] === true,
        ),
    );
    expect(boardParts).toHaveLength(1);
    const last = withBoard.at(-1) as Msg;
    expect(boardParts[0].i).toBe(withBoard.length - 1);
    expect(boardParts[0].pi).toBe(last.parts.length - 1);
  });

  test('previously-sent history bytes never change across a growing conversation', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: SESSION,
      agent: 'librarian',
      description: 'research',
    });
    const hook = createHook(board);

    // Fingerprint of the stable (non-board) content of every message.
    const stableSerialize = (messages: unknown[]): string[] =>
      (messages as Msg[]).map((m) =>
        JSON.stringify({
          info: m.info,
          parts: m.parts.filter(
            (p) => p.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY] !== true,
          ),
        }),
      );

    const historyN = [userMsg('u1', 'Coordinate'), ...toolTurn('t1', 'r1')];
    const outN = stableSerialize(await inject(hook, historyN));

    board.updateStatus({
      taskID: 'child-1',
      state: 'completed',
      resultSummary: 'done',
    });
    const historyN1 = [
      userMsg('u1', 'Coordinate'),
      ...toolTurn('t1', 'r1'),
      ...toolTurn('t2', 'r2'),
    ];
    const outN1 = stableSerialize(await inject(hook, historyN1));

    // Every message present in request N must be byte-identical in N+1: the
    // board (excluded here) is the only thing that ever changes, and it rides
    // on the last message's trailing part, so real history is untouched.
    expect(outN1.slice(0, outN.length)).toEqual(outN);
  });

  test('field-dump scenario: tail is a tool_result user turn preceded by an assistant turn', async () => {
    // Reconstructs the real bust (2026-07-23 dumps 000166→000167): the tail was
    // a user tool_result message preceded by an assistant tool-call message,
    // and the conversation advanced by one more tool turn between requests. The
    // board must attach to the tool_result tail so the preceding assistant turn
    // keeps a readable breakpoint that the next request reproduces.
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child',
      parentSessionID: SESSION,
      agent: 'librarian',
      description: 'grok research',
    });
    const hook = createHook(board);

    const base = [
      userMsg('u1', 'Coordinate the work'),
      ...toolTurn('t1', 'r1'),
    ];
    const outN = await inject(hook, base);

    // The board rode on the tail user (tool_result) message, not a new message.
    expect((outN as unknown[]).length).toBe(base.length);
    const tail = outN.at(-1) as Msg;
    expect(tail.info.role).toBe('user');
    expect(
      tail.parts.at(-1)?.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY],
    ).toBe(true);

    // Advance by one more tool turn (as the loop did between dumps).
    const advanced = [
      userMsg('u1', 'Coordinate the work'),
      ...toolTurn('t1', 'r1'),
      ...toolTurn('t2', 'r2'),
    ];
    const outN1 = await inject(hook, advanced);

    // The assistant turn that preceded the board tail in request N is present
    // and byte-identical in request N+1 — the readable cache boundary.
    const prefixesN = readableCachePrefixes(outN);
    const fullN1 = readableCachePrefixes(outN1).at(-1) ?? '';
    expect(prefixesN.some((p) => fullN1.startsWith(p))).toBe(true);
  });
});
