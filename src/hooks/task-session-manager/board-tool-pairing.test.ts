/**
 * Regression coverage for the retained-board replay bug that produced
 * `AI_InvalidPromptError: Invalid prompt: The messages do not match the
 * ModelMessage[] schema.` in a long-running session driving background
 * subagents (commit 208b656, also present in upstream PR #889).
 *
 * ── What went wrong ──────────────────────────────────────────────────────
 *
 * `replayRetainedTailBoards` reproduced a board that had been placed on an
 * ASSISTANT tail by splicing a synthetic message directly after that anchor:
 *
 *     const index = messages.indexOf(anchor);
 *     const boardMessage = { info: { ...anchor.info, id: ... }, parts: [...] };
 *     messages.splice(index + 1, 0, boardMessage);
 *
 * `anchor.info` is an ASSISTANT message info, so the synthetic board message
 * inherited `role: 'assistant'`. The host's conversion pipeline treats the two
 * roles asymmetrically (verified against the shipped opencode binary,
 * `MessageV2.toModelMessagesEffect`):
 *
 *   - the USER branch emits `{ type: 'text', text }` and DISCARDS `metadata`;
 *   - the ASSISTANT branch emits
 *     `{ type: 'text', text, providerMetadata: part.metadata }`, which
 *     `convertToModelMessages` forwards as `providerOptions`.
 *
 * `providerOptions` is validated as `Record<string, Record<string, JSONValue>>`.
 * A board part's metadata is `{ 'oh-my-opencode-slim.backgroundJobBoard': true }`
 * — a boolean where a nested record is required — so the request failed schema
 * validation before the HTTP call. This is why the failure only appeared in
 * sessions with assistant tails (a finishing background `task` turn), only
 * after 208b656 introduced `retainedTailBoards`, and never showed up in
 * storage: the malformed message is produced in-memory by the transform.
 *
 * ── Invariants now enforced ──────────────────────────────────────────────
 *
 *  A1  a synthetic board MESSAGE is only ever appended at the END of the array,
 *      never spliced into the middle.
 *  A2  no injected message separates a tool_call from its matching tool_result.
 *  A3  board text only ever rides on a `user`-role message (the rule that
 *      actually prevents the error above).
 *  A4  a board on a still-present user anchor is replayed byte-identically, so
 *      already-cached bytes never change.
 *  A5  a retained board that cannot be safely replayed is DROPPED from the
 *      retained map rather than reproduced.
 *
 * The reproduction test validates against a transcription of the REAL
 * `ModelMessage[]` zod schema together with a port of the host's conversion
 * pipeline, both extracted from the installed opencode binary. The `ai` package
 * is not a dependency of this repo and none was added, so the schema is
 * reproduced rather than imported; the structural invariant assertions below
 * stand on their own.
 */
import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import {
  FixtureBoard as BackgroundJobBoard,
  createBackgroundJobLifecycle,
} from '../../background-jobs';
import { DEFAULT_MAX_RETAINED_SNAPSHOTS } from '../../config/constants';
import {
  BACKGROUND_JOB_BOARD_METADATA_KEY,
  createTaskSessionManagerHook,
} from './index';

const SESSION = 'ses_orchestrator_invalid_prompt';
const CHILD = 'ses_child_background';
const PROVIDER = 'anthropic';
const MODEL = 'claude-opus-4';

// ── Real ModelMessage[] schema (transcribed from the opencode binary) ──────

const jsonValue: z.ZodType = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.record(z.string(), jsonValue.optional()),
    z.array(jsonValue),
  ]),
);

/** `providerOptions`: Record<string, Record<string, JSONValue>>. */
const providerOptions = z.record(
  z.string(),
  z.record(z.string(), jsonValue.optional()),
);

const textPart = z.object({
  type: z.literal('text'),
  text: z.string(),
  providerOptions: providerOptions.optional(),
});

const filePart = z.object({
  type: z.literal('file'),
  mediaType: z.string(),
  filename: z.string().optional(),
  data: z.unknown(),
  providerOptions: providerOptions.optional(),
});

const reasoningPart = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  providerOptions: providerOptions.optional(),
});

const toolCallPart = z.object({
  type: z.literal('tool-call'),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  providerExecuted: z.boolean().optional(),
  providerOptions: providerOptions.optional(),
});

const toolResultOutput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string() }),
  z.object({ type: z.literal('json'), value: jsonValue }),
  z.object({ type: z.literal('error-text'), value: z.string() }),
  z.object({ type: z.literal('error-json'), value: jsonValue }),
  z.object({
    type: z.literal('content'),
    value: z.array(z.unknown()),
  }),
]);

const toolResultPart = z.object({
  type: z.literal('tool-result'),
  toolCallId: z.string(),
  toolName: z.string(),
  output: toolResultOutput,
  providerOptions: providerOptions.optional(),
});

const modelMessage = z.union([
  z.object({
    role: z.literal('system'),
    content: z.string(),
    providerOptions: providerOptions.optional(),
  }),
  z.object({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(z.union([textPart, filePart]))]),
    providerOptions: providerOptions.optional(),
  }),
  z.object({
    role: z.literal('assistant'),
    content: z.union([
      z.string(),
      z.array(
        z.union([
          textPart,
          filePart,
          reasoningPart,
          toolCallPart,
          toolResultPart,
        ]),
      ),
    ]),
    providerOptions: providerOptions.optional(),
  }),
  z.object({
    role: z.literal('tool'),
    content: z.array(toolResultPart),
    providerOptions: providerOptions.optional(),
  }),
]);

const modelMessages = z.array(modelMessage);

// ── Host conversion pipeline (ported from the opencode binary) ────────────

type AnyPart = Record<string, any>;
type AnyMessage = { info: Record<string, any>; parts: AnyPart[] };

/**
 * Port of `MessageV2.toModelMessagesEffect` (user + assistant branches) —
 * the step that turns the transform hook's array into UIMessages. The
 * metadata asymmetry between the two role branches is reproduced verbatim: it
 * is the mechanism behind the failure under test.
 */
function toUIMessages(messages: unknown[]): AnyMessage[] {
  const result: any[] = [];
  for (const message of messages as AnyMessage[]) {
    if (!message?.info || !Array.isArray(message.parts)) continue;
    if (message.parts.length === 0) continue;

    if (message.info.role === 'user') {
      const parts: any[] = [];
      for (const part of message.parts) {
        // NOTE: no metadata is forwarded on the user path.
        if (part.type === 'text' && !part.ignored && part.text !== '') {
          parts.push({ type: 'text', text: part.text });
        }
      }
      if (parts.length > 0) {
        result.push({ id: message.info.id, role: 'user', parts });
      }
    }

    if (message.info.role === 'assistant') {
      if (message.info.error) continue;
      // Model-match gate: when the message's model equals the request model,
      // part metadata IS forwarded as providerMetadata.
      const differentModel =
        `${PROVIDER}/${MODEL}` !==
        `${message.info.providerID}/${message.info.modelID}`;
      const parts: any[] = [];
      for (const part of message.parts) {
        if (part.type === 'text') {
          parts.push({
            type: 'text',
            text: part.text,
            ...(differentModel ? {} : { providerMetadata: part.metadata }),
          });
        }
        if (part.type === 'step-start') parts.push({ type: 'step-start' });
        if (part.type === 'tool' && part.state?.status === 'completed') {
          parts.push({
            type: `tool-${part.tool}`,
            state: 'output-available',
            toolCallId: part.callID,
            input: part.state.input,
            output: part.state.output,
          });
        }
      }
      if (parts.length > 0)
        result.push({ id: message.info.id, role: 'assistant', parts });
    }
  }
  return result.filter((m) =>
    m.parts.some((p: AnyPart) => p.type !== 'step-start'),
  );
}

/**
 * Port of the AI SDK's `convertToModelMessages` for the part kinds this suite
 * produces. Note that a single assistant `tool-*` part expands into an
 * assistant `tool-call` plus an immediately following `role: 'tool'` message —
 * so the pairing is emitted adjacently by construction.
 */
function convertToModelMessages(uiMessages: AnyMessage[]): any[] {
  const out: any[] = [];
  for (const message of uiMessages as any[]) {
    if (message.role === 'user') {
      out.push({
        role: 'user',
        content: message.parts
          .filter((p: AnyPart) => p.type === 'text')
          .map((p: AnyPart) => ({
            type: 'text',
            text: p.text,
            ...(p.providerMetadata != null
              ? { providerOptions: p.providerMetadata }
              : {}),
          })),
      });
      continue;
    }

    if (message.role !== 'assistant') continue;

    const content: any[] = [];
    const toolResults: any[] = [];
    for (const part of message.parts as AnyPart[]) {
      if (part.type === 'text') {
        content.push({
          type: 'text',
          text: part.text,
          // providerMetadata → providerOptions: the exact key whose shape the
          // ModelMessage[] schema validates.
          ...(part.providerMetadata != null
            ? { providerOptions: part.providerMetadata }
            : {}),
        });
        continue;
      }
      if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
        const toolName = part.type.slice('tool-'.length);
        content.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName,
          input: part.input,
        });
        toolResults.push({
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName,
          output: { type: 'text', value: String(part.output) },
        });
      }
    }
    if (content.length > 0) out.push({ role: 'assistant', content });
    if (toolResults.length > 0)
      out.push({ role: 'tool', content: toolResults });
  }
  return out;
}

/** Mirrors the host's validation step; returns the zod error when invalid. */
function validateModelMessages(messages: unknown[]) {
  return modelMessages.safeParse(
    convertToModelMessages(toUIMessages(messages)),
  );
}

// ── Fixtures ──────────────────────────────────────────────────────────────

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
      backgroundJobs: createBackgroundJobLifecycle({
        backgroundJobBoard: board,
      }),
      shouldManageSession: () => true,
    },
  );
}

function userTextTurn(id: string, text: string) {
  return {
    info: { id, role: 'user', agent: 'orchestrator', sessionID: SESSION },
    parts: [{ id: `prt_${id}`, type: 'text', text }],
  };
}

const TASK_OUTPUT = [
  `<task id="${CHILD}" state="completed">`,
  '<summary>Background task completed: research the scheduler</summary>',
  '<task_result>',
  'Findings: the scheduler batches on idle.',
  '</task_result>',
  '</task>',
].join('\n');

/**
 * The assistant turn a FINISHED background subagent produces: a `task` tool
 * part whose terminal result is materialized on the same message. The host
 * converter expands this single part into an assistant tool_call plus its
 * matching tool_result.
 */
function finishedTaskAssistantTurn(id: string, callID: string) {
  return {
    info: {
      id,
      role: 'assistant',
      sessionID: SESSION,
      providerID: PROVIDER,
      modelID: MODEL,
    },
    parts: [
      { id: `prt_${id}_s`, type: 'step-start' },
      {
        id: `prt_${id}_t`,
        type: 'text',
        text: 'The background task finished.',
      },
      {
        id: `prt_${id}_c`,
        type: 'tool',
        tool: 'task',
        callID,
        state: {
          status: 'completed',
          input: { background: true, description: 'research the scheduler' },
          output: TASK_OUTPUT,
          time: { start: 1, end: 2 },
        },
      },
    ],
  };
}

/** A user turn carrying only a tool result (the tool-loop shape). */
function toolResultUserTurn(id: string, callID: string, output: string) {
  return {
    info: { id, role: 'user', agent: 'orchestrator', sessionID: SESSION },
    parts: [
      {
        id: `prt_${id}`,
        type: 'tool',
        tool: 'read',
        callID,
        state: {
          status: 'completed',
          input: {},
          output,
          time: { start: 1, end: 2 },
        },
      },
    ],
  };
}

async function request(
  hook: ReturnType<typeof createTaskSessionManagerHook>,
  history: unknown[],
): Promise<unknown[]> {
  // opencode rebuilds the array from storage every request; synthetic board
  // content is never persisted, so each request starts from real history only.
  const output = { messages: structuredClone(history) };
  await hook['experimental.chat.messages.transform']({}, output as never);
  await hook.injectBackgroundJobBoard({}, output as never);
  return output.messages;
}

// ── Invariant helpers ─────────────────────────────────────────────────────

function isBoardPart(part: AnyPart): boolean {
  return part?.metadata?.[BACKGROUND_JOB_BOARD_METADATA_KEY] === true;
}

function isBoardMessage(message: AnyMessage): boolean {
  return (
    message.parts.length > 0 && message.parts.every((part) => isBoardPart(part))
  );
}

/** A3: board text may only ride on a `user`-role message. */
function assertBoardTextOnlyOnUserMessages(messages: unknown[]): void {
  for (const message of messages as AnyMessage[]) {
    if (!message.parts?.some(isBoardPart)) continue;
    expect(
      message.info.role,
      `board text landed on a ${message.info.role} message; the assistant ` +
        'branch of the host converter would forward its metadata as ' +
        'providerOptions and fail ModelMessage[] validation',
    ).toBe('user');
  }
}

/**
 * A2: every assistant `tool_call` stays immediately followed by its matching
 * `tool_result`, measured on the CONVERTED model messages.
 */
function assertToolPairingIntact(messages: unknown[]): void {
  const converted = convertToModelMessages(toUIMessages(messages));
  for (const [index, message] of converted.entries()) {
    if (message.role !== 'assistant') continue;
    const callIds = (message.content as AnyPart[])
      .filter((part) => part.type === 'tool-call')
      .map((part) => part.toolCallId);
    if (callIds.length === 0) continue;

    const next = converted[index + 1];
    expect(
      next?.role,
      `assistant tool_call(s) ${callIds.join(', ')} are not followed by a ` +
        'tool-role message — the pairing was orphaned',
    ).toBe('tool');
    const resultIds = (next.content as AnyPart[]).map(
      (part) => part.toolCallId,
    );
    for (const callId of callIds) {
      expect(resultIds).toContain(callId);
    }
  }
}

/**
 * A1: no synthetic board message may sit anywhere but the very end of the
 * array — i.e. nothing was spliced into the middle of already-sent history.
 */
function assertNoMidArrayBoardMessage(messages: unknown[]): void {
  const list = messages as AnyMessage[];
  for (const [index, message] of list.entries()) {
    if (!isBoardMessage(message)) continue;
    expect(
      index,
      'a synthetic board message was inserted mid-array instead of appended',
    ).toBe(list.length - 1);
  }
}

/**
 * A1/A2 combined, stated positionally: a synthetic board message may follow an
 * assistant `task` tool_call message ONLY when it is the final element of the
 * array. Appending after the last real message is safe — the host emits the
 * tool_call and its tool_result adjacently from that one message, so nothing
 * comes between them. Splicing the board after a task message that still has
 * successors is the bug: it lands inside already-sent history.
 */
function assertNothingBetweenTaskCallAndResult(messages: unknown[]): void {
  const list = messages as AnyMessage[];
  for (const [index, message] of list.entries()) {
    const hasTaskCall = message.parts?.some(
      (part) => part.type === 'tool' && part.tool === 'task',
    );
    if (!hasTaskCall) continue;
    const next = list[index + 1];
    if (!next || !isBoardMessage(next)) continue;
    expect(
      index + 1,
      'a synthetic board message was spliced in immediately after an ' +
        'assistant task tool_call message that is not the tail — it sits ' +
        'between the call and its tool_result',
    ).toBe(list.length - 1);
  }
}

function assertAllInvariants(messages: unknown[]): void {
  assertNoMidArrayBoardMessage(messages);
  assertNothingBetweenTaskCallAndResult(messages);
  assertToolPairingIntact(messages);
  assertBoardTextOnlyOnUserMessages(messages);
}

function boardTexts(messages: unknown[]): string[] {
  return (messages as AnyMessage[]).flatMap((message) =>
    (message.parts ?? []).filter(isBoardPart).map((part) => String(part.text)),
  );
}

function runningBoard(): BackgroundJobBoard {
  const board = new BackgroundJobBoard();
  board.registerLaunch({
    taskID: CHILD,
    parentSessionID: SESSION,
    agent: 'librarian',
    description: 'research the scheduler',
  });
  return board;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('board injection keeps the ModelMessage[] array valid', () => {
  test('reproduction: a board retained on an assistant anchor never corrupts the prompt when the background task finishes', async () => {
    const board = runningBoard();
    const hook = createHook(board);

    // Request 1 — the tail is the ASSISTANT turn of a just-finished background
    // task. This is the request that makes the buggy build retain a board
    // against an ASSISTANT anchor.
    const historyA = [
      userTextTurn('u1', 'Coordinate the background research'),
      finishedTaskAssistantTurn('a1', 'call-task-1'),
    ];
    const outA = await request(hook, historyA);

    const validA = validateModelMessages(outA);
    expect(
      validA.success,
      `request A failed ModelMessage[] validation: ${JSON.stringify(
        validA.error?.issues?.slice(0, 3),
        null,
        2,
      )}`,
    ).toBe(true);
    assertAllInvariants(outA);

    // Request 2 — the loop advanced: the assistant task turn is now
    // mid-history, followed by the user tool_result turn. The buggy build
    // replayed the retained board by splicing an ASSISTANT-role synthetic
    // message directly after the anchor, which both landed mid-array and
    // carried board metadata on an assistant message.
    board.updateStatus({
      taskID: CHILD,
      state: 'completed',
      resultSummary: 'scheduler batches on idle',
    });
    const historyB = [
      userTextTurn('u1', 'Coordinate the background research'),
      finishedTaskAssistantTurn('a1', 'call-task-1'),
      toolResultUserTurn('r1', 'call-read-1', 'file contents'),
    ];
    const outB = await request(hook, historyB);

    const validB = validateModelMessages(outB);
    expect(
      validB.success,
      `request B failed ModelMessage[] validation (AI_InvalidPromptError): ` +
        `${JSON.stringify(validB.error?.issues?.slice(0, 3), null, 2)}`,
    ).toBe(true);
    assertAllInvariants(outB);

    // Request 3 — a consecutive request over the same history must stay valid
    // and must not accumulate boards.
    const outC = await request(hook, historyB);
    expect(validateModelMessages(outC).success).toBe(true);
    assertAllInvariants(outC);
    expect(boardTexts(outC)).toHaveLength(1);
  });

  test('A1/A2: no synthetic message is ever placed between a tool_call and its tool_result across a growing tool loop', async () => {
    const board = runningBoard();
    const hook = createHook(board);

    const history: unknown[] = [
      userTextTurn('u1', 'Coordinate the background research'),
    ];

    // Grow the conversation the way the agent loop does: alternating assistant
    // task turns and user tool_result turns, re-rendering every step.
    for (let turn = 0; turn < 4; turn += 1) {
      history.push(finishedTaskAssistantTurn(`a${turn}`, `call-task-${turn}`));
      const mid = await request(hook, history);
      assertAllInvariants(mid);
      expect(validateModelMessages(mid).success).toBe(true);

      history.push(
        toolResultUserTurn(`r${turn}`, `call-read-${turn}`, `result-${turn}`),
      );
      const after = await request(hook, history);
      assertAllInvariants(after);
      expect(validateModelMessages(after).success).toBe(true);
    }
  });

  test('A3: board text never rides on an assistant message even when the tail is an assistant turn', async () => {
    const board = runningBoard();
    const hook = createHook(board);

    const out = await request(hook, [
      userTextTurn('u1', 'Coordinate the background research'),
      finishedTaskAssistantTurn('a1', 'call-task-1'),
    ]);

    // The board is present…
    expect(boardTexts(out)).toHaveLength(1);
    // …and it is carried by a user-role message appended at the very end.
    assertBoardTextOnlyOnUserMessages(out);
    const tail = (out as AnyMessage[]).at(-1);
    expect(tail?.info.role).toBe('user');
    expect(tail?.parts.every(isBoardPart)).toBe(true);
    // The assistant anchor itself is untouched by the board.
    const assistant = (out as AnyMessage[]).find(
      (message) => message.info.role === 'assistant',
    );
    expect(assistant?.parts.some(isBoardPart)).toBe(false);
  });

  test('A4: a board on a still-present text-only user anchor is replayed byte-identically', async () => {
    const board = runningBoard();
    const hook = createHook(board);

    // Request A: the tail is a plain user turn, so the board rides on it as a
    // trailing PART and is recorded for replay.
    const historyA = [
      userTextTurn('u1', 'Coordinate the background research'),
      toolResultUserTurn('r0', 'call-read-0', 'first read'),
      userTextTurn('u2', 'Now summarize the findings'),
    ];
    const outA = await request(hook, historyA);
    const anchorA = (outA as AnyMessage[]).find(
      (message) => message.info.id === 'u2',
    );
    const retainedBoard = anchorA?.parts.at(-1);
    expect(isBoardPart(retainedBoard as AnyPart)).toBe(true);
    const retainedBytes = JSON.stringify(retainedBoard);

    // Request B: the tail advanced past that anchor. The already-sent board
    // bytes on `u2` must be reproduced exactly — that is the cache guarantee
    // 208b656 introduced and this fix preserves.
    board.updateStatus({
      taskID: CHILD,
      state: 'completed',
      resultSummary: 'scheduler batches on idle',
    });
    const historyB = [
      ...historyA,
      finishedTaskAssistantTurn('a1', 'call-task-1'),
      toolResultUserTurn('r1', 'call-read-1', 'second read'),
    ];
    const outB = await request(hook, historyB);

    const anchorB = (outB as AnyMessage[]).find(
      (message) => message.info.id === 'u2',
    );
    const replayed = anchorB?.parts.at(-1);
    expect(isBoardPart(replayed as AnyPart)).toBe(true);
    // Byte-identical replay: the provider's cached prefix stays valid.
    expect(JSON.stringify(replayed)).toBe(retainedBytes);

    // And the array is still valid and invariant-clean.
    expect(validateModelMessages(outB).success).toBe(true);
    assertAllInvariants(outB);
  });

  test('A5: an unreplayable retained board is dropped instead of retried every request', async () => {
    const board = runningBoard();
    const hook = createHook(board);

    // Request A: assistant tail → the board is appended as a trailing message.
    // That placement is deliberately NOT retained, because reproducing it later
    // would require a mid-array insertion.
    await request(hook, [
      userTextTurn('u1', 'Coordinate the background research'),
      finishedTaskAssistantTurn('a1', 'call-task-1'),
    ]);

    const historyB = [
      userTextTurn('u1', 'Coordinate the background research'),
      finishedTaskAssistantTurn('a1', 'call-task-1'),
      toolResultUserTurn('r1', 'call-read-1', 'file contents'),
    ];

    // Repeated consecutive requests must each carry exactly ONE board: no
    // resurrection of the dropped placement, no unbounded accumulation, and no
    // repeated attempt at the unsafe replay.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const out = await request(hook, historyB);
      expect(boardTexts(out)).toHaveLength(1);
      // The dropped board is not reproduced on the assistant anchor.
      const assistant = (out as AnyMessage[]).find(
        (message) => message.info.role === 'assistant',
      );
      expect(assistant?.parts.some(isBoardPart)).toBe(false);
      assertAllInvariants(out);
      expect(validateModelMessages(out).success).toBe(true);
    }
  });

  test('a board part on an assistant message is exactly what the real schema rejects', async () => {
    // Guards the schema port itself: if this stopped failing, the reproduction
    // test above would pass for the wrong reason.
    const corrupted = [
      userTextTurn('u1', 'Coordinate the background research'),
      {
        info: {
          id: 'a1',
          role: 'assistant',
          sessionID: SESSION,
          providerID: PROVIDER,
          modelID: MODEL,
        },
        parts: [
          {
            type: 'text',
            synthetic: true,
            text: '<system-reminder>board</system-reminder>',
            metadata: { [BACKGROUND_JOB_BOARD_METADATA_KEY]: true },
          },
        ],
      },
    ];

    const result = validateModelMessages(corrupted);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('providerOptions');
  });
});
