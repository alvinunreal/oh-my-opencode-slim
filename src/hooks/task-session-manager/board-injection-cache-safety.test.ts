/**
 * Regression coverage for checkpoint-compatible board injection and provider
 * prompt-cache prefix safety.
 *
 * Empirical verification of the checkpoint-compatible board strategy's
 * cache behavior (fix/checkpoint-cache-epochs investigation). Simulates a
 * multi-turn orchestrator tool loop with realistic SDK-shaped message
 * fixtures (github-copilot / gpt-5.6-luna) and measures, per turn:
 *
 *  1. transform-level bytes: the exact `messages` array the hook produces
 *  2. provider-level bytes: those messages passed through the same
 *     UIMessage construction as opencode's MessageV2.toModelMessagesEffect
 *     (text path, verbatim from
 *     .slim/clonedeps/repos/opencode/packages/opencode/src/session/message-v2.ts:692-780)
 *     and then through a local provider-message serializer that keeps only
 *     provider-visible role and ordered text content.
 *
 * For each consecutive pair of requests it computes the longest common
 * byte prefix and reports where the divergence falls.
 *
 * Scenarios A and C intentionally fail against the current implementation.
 * They become passing guards when board snapshots are kept in the trailing
 * cache-safe zone and retained snapshots are replayed on every qualifying
 * request.
 */
import { describe, expect, mock, test } from 'bun:test';
import { DEFAULT_MAX_RETAINED_SNAPSHOTS } from '../../config/constants';
import { BackgroundJobBoard, createInternalAgentTextPart } from '../../utils';
import { createTaskSessionManagerHook } from './index';

const SESSION = 'ses_08f6be16dffednbwYD8dNDIfOI';
const BASE_TIME = 1752968000000;

// ── Realistic SDK-shaped fixtures (types.gen.d.ts UserMessage/AssistantMessage) ──

function userMsg(id: string, text: string, createdAt: number) {
  return {
    info: {
      id,
      sessionID: SESSION,
      role: 'user',
      time: { created: createdAt },
      agent: 'orchestrator',
      model: { providerID: 'github-copilot', modelID: 'gpt-5.6-luna' },
    },
    parts: [
      {
        id: `prt_${id}`,
        sessionID: SESSION,
        messageID: id,
        type: 'text',
        text,
        time: { start: createdAt },
      },
    ],
  };
}

function internalInitiatorUserMsg(id: string, text: string, createdAt: number) {
  const msg = userMsg(id, text, createdAt);
  msg.parts = [
    {
      id: `prt_${id}`,
      sessionID: SESSION,
      messageID: id,
      ...createInternalAgentTextPart(text),
    } as never,
  ];
  return msg;
}

function assistantMsg(
  id: string,
  text: string,
  createdAt: number,
  cost: number,
  inputTokens: number,
) {
  return {
    info: {
      id,
      sessionID: SESSION,
      role: 'assistant',
      time: { created: createdAt, completed: createdAt + 4321 },
      parentID: 'msg_u1',
      modelID: 'gpt-5.6-luna',
      providerID: 'github-copilot',
      mode: 'orchestrator',
      path: { cwd: '/work/repo', root: '/work/repo' },
      cost,
      tokens: {
        input: inputTokens,
        output: 350,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [
      {
        id: `prt_${id}`,
        sessionID: SESSION,
        messageID: id,
        type: 'text',
        text,
      },
    ],
  };
}

// ── Serialization / diffing ────────────────────────────────────────────

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => typeof v !== 'function' && v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, sortValue(v)]),
    );
  }
  return value;
}

/** One JSON line per message so "prev is a byte prefix of next" is meaningful. */
function serializeMessages(messages: unknown[]): string {
  return `${messages.map((m) => JSON.stringify(sortValue(m))).join('\n')}\n`;
}

/**
 * Verbatim port of the text-message path of MessageV2.toModelMessagesEffect
 * (message-v2.ts:692-780, same-model branch). This is the code that turns the
 * transform hook's output into UI messages before provider serialization.
 */
function toUIMessages(messages: any[]): any[] {
  const result: any[] = [];
  for (const msg of messages) {
    if (!msg?.info || !Array.isArray(msg.parts) || msg.parts.length === 0) {
      continue;
    }
    if (msg.info.role === 'user') {
      const parts: any[] = [];
      for (const part of msg.parts) {
        if (part.type === 'text' && !part.ignored && part.text !== '') {
          parts.push({ type: 'text', text: part.text });
        }
      }
      if (parts.length > 0) {
        result.push({ id: msg.info.id, role: 'user', parts });
      }
    }
    if (msg.info.role === 'assistant') {
      if (msg.info.error) continue;
      const parts: any[] = [];
      for (const part of msg.parts) {
        if (part.type === 'text') {
          parts.push({
            type: 'text',
            text: part.text,
            providerMetadata: part.metadata,
          });
        }
      }
      if (parts.length > 0) {
        result.push({ id: msg.info.id, role: 'assistant', parts });
      }
    }
  }
  return result;
}

function toProviderBytes(messages: unknown[]): string {
  const modelMessages = toUIMessages(messages as never).map(
    ({ role, parts }: any) => ({
      role,
      content: parts.map(({ type, text }: any) => ({ type, text })),
    }),
  );
  return serializeMessages(modelMessages);
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

function describeTransition(label: string, prev: string, next: string) {
  const lcp = commonPrefixLength(prev, next);
  const safe = lcp === prev.length && next.length > prev.length;
  const divergingLine = prev.slice(0, lcp).split('\n').length - 1;
  return {
    label,
    safe,
    lcp,
    prevLength: prev.length,
    divergingMessageIndex: safe ? undefined : divergingLine,
    prevAtDivergence: safe
      ? undefined
      : prev.slice(Math.max(0, lcp - 60), lcp + 160),
    nextAtDivergence: safe
      ? undefined
      : next.slice(Math.max(0, lcp - 60), lcp + 160),
  };
}

// ── Hook + turn runner ────────────────────────────────────────────────

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
      strategy: 'checkpoint-compatible',
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    },
  );
}

type TurnResult = {
  injected: unknown[];
  transformBytes: string;
  providerBytes: string;
};

async function runTurn(
  hook: ReturnType<typeof createTaskSessionManagerHook>,
  history: unknown[],
): Promise<TurnResult> {
  // prompt.ts rebuilds msgs from storage every request; injected synthetic
  // board messages are never persisted, so each request starts from the
  // real history only.
  const request = { messages: structuredClone(history) };
  await hook.injectBackgroundJobBoard({}, request as never);
  return {
    injected: request.messages,
    transformBytes: serializeMessages(request.messages),
    providerBytes: toProviderBytes(request.messages),
  };
}

function summarizeInjected(messages: any[]): string[] {
  return messages.map((m) => {
    const meta = m.parts?.[0]?.metadata;
    if (meta?.['oh-my-opencode-slim.backgroundJobBoard'] === true) {
      return `BOARD(${meta.snapshotID ?? m.info.id})`;
    }
    return `${m.info.role.toUpperCase()}(${m.info.id})`;
  });
}

// ── Scenario A: tool loop, board state changes across turns ──────────

describe('checkpoint-compatible board cache safety', () => {
  test('keeps provider bytes prefix-safe while a tool loop changes the board', async () => {
    const board = new BackgroundJobBoard();
    const hook = createHook(board);

    const u1 = userMsg('msg_u1', 'Coordinate the refactor work', BASE_TIME);
    const history: unknown[] = [u1];

    const boardMutations: Array<() => void> = [
      () =>
        board.registerLaunch({
          taskID: 'child-1',
          parentSessionID: SESSION,
          agent: 'explorer',
          description: 'map scheduler hooks',
        }),
      () =>
        board.registerLaunch({
          taskID: 'child-2',
          parentSessionID: SESSION,
          agent: 'oracle',
          description: 'review plan',
        }),
      () =>
        void board.updateStatus({
          taskID: 'child-1',
          state: 'completed',
          resultSummary: 'mapped hooks',
        }),
      () =>
        board.registerLaunch({
          taskID: 'child-3',
          parentSessionID: SESSION,
          agent: 'librarian',
          description: 'find docs',
        }),
      () =>
        void board.updateStatus({
          taskID: 'child-2',
          state: 'completed',
          resultSummary: 'plan ok',
        }),
    ];

    const turns: TurnResult[] = [];
    for (let turn = 0; turn < boardMutations.length; turn += 1) {
      boardMutations[turn]();
      if (turn > 0) {
        history.push(
          assistantMsg(
            `msg_a${turn}`,
            `tool step ${turn} output`,
            BASE_TIME + turn * 30_000,
            0.0123 * turn,
            5000 + turn * 800,
          ),
        );
      }
      turns.push(await runTurn(hook, history));
    }

    console.log('\n=== SCENARIO A: injected message layout per turn ===');
    turns.forEach((t, i) => {
      console.log(
        `turn ${i + 1}: [${summarizeInjected(t.injected as never).join(', ')}]`,
      );
    });

    console.log('\n=== SCENARIO A: provider-byte transitions ===');
    const transitions = [];
    for (let i = 1; i < turns.length; i += 1) {
      const t = describeTransition(
        `turn ${i} -> turn ${i + 1}`,
        turns[i - 1].providerBytes,
        turns[i].providerBytes,
      );
      transitions.push(t);
      console.log(JSON.stringify(t, null, 2));
    }

    const broken = transitions.filter((t) => !t.safe);
    console.log(
      `\nSCENARIO A RESULT: ${broken.length}/${transitions.length} transitions break the provider byte prefix`,
    );

    // Every request must preserve the complete prior provider payload as a
    // byte prefix. The current placement bug makes the later transitions
    // fail here when a snapshot is inserted before prior assistant messages.
    for (const transition of transitions) {
      expect(transition.safe, `${transition.label} rewrote cached bytes`).toBe(
        true,
      );
    }
  }, 20_000);

  // ── Scenario B: board stable, new real user turn (metadata stamping) ──

  test('keeps metadata stamping isolated from provider bytes', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: SESSION,
      agent: 'explorer',
      description: 'map scheduler hooks',
    });
    const hook = createHook(board);

    const u1 = userMsg('msg_u1', 'Coordinate the refactor work', BASE_TIME);
    const turn1 = await runTurn(hook, [u1]);

    // New real user turn: same board state, different triggering message
    // with different volatile info (time.created).
    const a1 = assistantMsg(
      'msg_a1',
      'done thinking',
      BASE_TIME + 30_000,
      0.02,
      6000,
    );
    const u2 = userMsg('msg_u2', 'Now do the next piece', BASE_TIME + 120_000);
    const turn2 = await runTurn(hook, [u1, a1, u2]);

    const boardMessageOf = (t: TurnResult): any =>
      (t.injected as never[]).find(
        (m: any) =>
          m.parts?.[0]?.metadata?.['oh-my-opencode-slim.backgroundJobBoard'] ===
          true,
      );

    const s1turn1 = JSON.stringify(sortValue(boardMessageOf(turn1)));
    const s1turn2 = JSON.stringify(sortValue(boardMessageOf(turn2)));
    const lcp = commonPrefixLength(s1turn1, s1turn2);

    console.log('\n=== SCENARIO B: same snapshot S1 across turns ===');
    console.log('turn1 S1 message:', s1turn1.slice(0, 400));
    console.log('turn2 S1 message:', s1turn2.slice(0, 400));
    if (s1turn1 !== s1turn2) {
      console.log(
        `transform-level divergence at byte ${lcp}:\n  turn1: ...${s1turn1.slice(Math.max(0, lcp - 40), lcp + 60)}\n  turn2: ...${s1turn2.slice(Math.max(0, lcp - 40), lcp + 60)}`,
      );
    }

    const transition = describeTransition(
      'turn1 -> turn2 (provider bytes)',
      turn1.providerBytes,
      turn2.providerBytes,
    );
    console.log('provider transition:', JSON.stringify(transition, null, 2));
    console.log(
      'provider bytes mention time.created value?',
      turn2.providerBytes.includes(String(BASE_TIME + 120_000)),
    );
    console.log(
      'provider bytes mention snapshotID/metadata/cost?',
      turn2.providerBytes.includes('snapshotID'),
      turn2.providerBytes.includes('backgroundJobBoard'),
      turn2.providerBytes.includes('"cost"'),
    );

    // Transform-level: replayed historical snapshot bytes DO change
    // (baseMessage.info spread stamps the new turn's volatile info).
    expect(s1turn1).not.toBe(s1turn2);
    // Provider-level: none of that reaches the request body; transition is
    // a pure prefix extension.
    expect(transition.safe).toBe(true);
    expect(turn2.providerBytes).not.toContain('snapshotID');
    expect(turn2.providerBytes).not.toContain(String(BASE_TIME + 120_000));
  }, 20_000);

  // ── Scenario C: retained snapshots vanish and reappear ────────────────

  test('keeps retained snapshots across internal and empty-board turns', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: SESSION,
      agent: 'explorer',
      description: 'map scheduler hooks',
    });
    const hook = createHook(board);

    const u1 = userMsg('msg_u1', 'Coordinate the refactor work', BASE_TIME);
    const history: unknown[] = [u1];
    const turn1 = await runTurn(hook, history);

    // Turn 2: internal continuation prompt (background completion nudge).
    history.push(
      assistantMsg('msg_a1', 'step output', BASE_TIME + 30_000, 0.01, 5000),
    );
    history.push(
      internalInitiatorUserMsg(
        'msg_u2',
        'Background task completed, continue.',
        BASE_TIME + 60_000,
      ),
    );
    const turn2 = await runTurn(hook, history);

    // Turn 3: board becomes empty -> formatForPrompt returns undefined.
    board.drop('child-1');
    history.push(
      userMsg('msg_u3', 'Carry on with the plan', BASE_TIME + 90_000),
    );
    const turn3 = await runTurn(hook, history);

    // Turn 4: a new job appears -> retained snapshots come back.
    board.registerLaunch({
      taskID: 'child-2',
      parentSessionID: SESSION,
      agent: 'oracle',
      description: 'review plan',
    });
    history.push(
      assistantMsg('msg_a2', 'more output', BASE_TIME + 100_000, 0.02, 7000),
    );
    const turn4 = await runTurn(hook, history);

    console.log('\n=== SCENARIO C: injected layout per turn ===');
    for (const [i, t] of [turn1, turn2, turn3, turn4].entries()) {
      console.log(
        `turn ${i + 1}: [${summarizeInjected(t.injected as never).join(', ')}]`,
      );
    }
    const transitions = [
      describeTransition(
        'turn1 -> turn2',
        turn1.providerBytes,
        turn2.providerBytes,
      ),
      describeTransition(
        'turn2 -> turn3',
        turn2.providerBytes,
        turn3.providerBytes,
      ),
      describeTransition(
        'turn3 -> turn4',
        turn3.providerBytes,
        turn4.providerBytes,
      ),
    ];
    for (const t of transitions) console.log(JSON.stringify(t, null, 2));

    // The current implementation drops this snapshot on the internal turn;
    // the prefix assertion below is the regression guard for that transition.
    for (const transition of transitions) {
      expect(transition.safe, `${transition.label} rewrote cached bytes`).toBe(
        true,
      );
    }
  }, 20_000);
});
