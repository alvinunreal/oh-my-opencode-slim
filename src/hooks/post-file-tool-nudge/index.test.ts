import { describe, expect, test } from 'bun:test';

import {
  IMPLEMENTATION_DRIFT_NUDGE,
  PHASE_REMINDER,
} from '../../config/constants';
import { createInternalAgentTextPart } from '../../utils';
import { isVolatileTaggedMessage } from '../cache-safe-injection';
import { createPhaseReminderHook } from '../phase-reminder';
import { SessionLifecycle } from '../session-lifecycle';
import { BACKGROUND_JOB_BOARD_METADATA_KEY } from '../task-session-manager/board-injection';
import {
  createPostFileToolNudgeHook,
  IMPLEMENTATION_DRIFT_NUDGE_METADATA_KEY,
} from './index';

const orchestratorMessage = (sessionID = 's1') => ({
  info: { role: 'user', agent: 'orchestrator', sessionID },
  parts: [{ type: 'text', text: 'hello' }],
});

const assistantToolBlock = (tools: string[], sessionID = 's1') => ({
  info: { role: 'assistant', agent: 'orchestrator', sessionID },
  parts: tools.map((tool) => ({
    type: 'tool',
    tool,
    callID: `${tool}-call`,
    state: { status: 'completed' },
  })),
});

/** Stable, history-derived drift parts carried inside a message. */
const reminderParts = (message: ReturnType<typeof orchestratorMessage>) =>
  message.parts.filter((part) => part.text === IMPLEMENTATION_DRIFT_NUDGE);

/** Volatile trailing drift messages at the payload tail. */
const trailingNudges = (messages: unknown[]) =>
  messages.filter((message) =>
    isVolatileTaggedMessage(message, IMPLEMENTATION_DRIFT_NUDGE_METADATA_KEY),
  );

/** Full pipeline delivery: early transform, then late trailing
 * publication (mirrors src/index.ts ordering: the trailing message is
 * published only after phase-reminder and the job board ran). */
const deliver = async (
  hook: ReturnType<typeof createPostFileToolNudgeHook>,
  messages: unknown[],
) => {
  await hook['experimental.chat.messages.transform']({}, { messages });
  await hook.deliverTrailingNudge({}, { messages });
};

describe('post-file-tool-nudge hook', () => {
  test('trailing nudge rides behind a user message ended in a tool loop, without touching its bytes', async () => {
    const hook = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
    });
    const message = orchestratorMessage();
    const messages: unknown[] = [message, assistantToolBlock(['edit'])];

    await deliver(hook, messages);

    expect(message.parts).toHaveLength(1); // user bytes untouched
    expect(message.parts[0].text).toBe('hello');
    expect(trailingNudges(messages)).toHaveLength(1);
    expect(messages[messages.length - 1]).toMatchObject({
      info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
    });
  });

  test('no trailing nudge when the payload ends in a plain user message', async () => {
    const hook = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
    });
    const messages: unknown[] = [orchestratorMessage()];

    await hook['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, {});
    await deliver(hook, messages);

    expect(trailingNudges(messages)).toHaveLength(0);
  });

  test('no trailing nudge when the final block only searched', async () => {
    const hook = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
    });
    const messages: unknown[] = [
      orchestratorMessage(),
      assistantToolBlock(['grep']),
    ];

    await deliver(hook, messages);

    expect(trailingNudges(messages)).toHaveLength(0);
  });

  test('composes with phase reminder without duplication', async () => {
    const nudge = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
    });
    const phaseReminder = createPhaseReminderHook();
    const afterFileMessage = orchestratorMessage();
    const messages: unknown[] = [
      afterFileMessage,
      assistantToolBlock(['Write']),
    ];

    await phaseReminder['experimental.chat.messages.transform'](
      {},
      { messages },
    );
    await deliver(nudge, messages);

    expect(trailingNudges(messages)).toHaveLength(1);
    expect(
      afterFileMessage.parts.filter((p) => p.text === PHASE_REMINDER),
    ).toHaveLength(1);

    const freshMessages: unknown[] = [orchestratorMessage()];
    await phaseReminder['experimental.chat.messages.transform'](
      {},
      { messages: freshMessages },
    );
    expect(trailingNudges(freshMessages)).toHaveLength(0);
    expect(
      (freshMessages[0] as ReturnType<typeof orchestratorMessage>).parts.filter(
        (p) => p.text === PHASE_REMINDER,
      ),
    ).toHaveLength(1);
  });

  test('session eligibility gates both stable and trailing delivery', async () => {
    let isOrchestratorSession = false;
    const shouldInject = () => isOrchestratorSession;
    const nudge = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
      shouldInject,
    });
    const rejectedMessages: unknown[] = [
      orchestratorMessage(),
      assistantToolBlock(['Read']),
    ];

    await deliver(nudge, rejectedMessages);
    expect(trailingNudges(rejectedMessages)).toHaveLength(0);

    isOrchestratorSession = true;
    const eligibleMessages: unknown[] = [
      orchestratorMessage(),
      assistantToolBlock(['Read']),
    ];
    await deliver(nudge, eligibleMessages);
    expect(trailingNudges(eligibleMessages)).toHaveLength(1);
  });

  test('re-renders reproduce the trailing nudge idempotently', async () => {
    const hook = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
    });
    const messages: unknown[] = [
      orchestratorMessage(),
      assistantToolBlock(['bash']),
    ];

    await deliver(hook, messages);
    await deliver(hook, messages);

    expect(trailingNudges(messages)).toHaveLength(1);
  });

  test('reproduces the nudge as stable bytes on the next user message', async () => {
    // History-derived rule: a user message whose preceding assistant
    // block used implementation tools carries the drift part in every
    // render (byte-stable across turns).
    const hook = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
    });
    const nextUser = orchestratorMessage();
    const messages: unknown[] = [
      orchestratorMessage(),
      assistantToolBlock(['edit', 'bash']),
      nextUser,
    ];

    await hook['experimental.chat.messages.transform']({}, { messages });

    expect(reminderParts(nextUser)).toHaveLength(1);
    expect(trailingNudges(messages)).toHaveLength(0); // loop ended
  });

  test('skips the stable part when the preceding block only searched', async () => {
    const hook = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
    });
    const nextUser = orchestratorMessage();
    const messages: unknown[] = [
      orchestratorMessage(),
      assistantToolBlock(['grep']),
      nextUser,
    ];

    await hook['experimental.chat.messages.transform']({}, { messages });

    expect(reminderParts(nextUser)).toHaveLength(0);
  });

  test.each([
    ['empty messages', []],
    [
      'non-orchestrator session',
      [
        orchestratorMessage('s2'),
        {
          info: { role: 'assistant', agent: 'explorer', sessionID: 's2' },
          parts: [{ type: 'tool', tool: 'edit', state: {} }],
        },
      ],
    ],
    [
      'assistant block without a session',
      [
        orchestratorMessage(),
        {
          info: { role: 'assistant', agent: 'orchestrator' },
          parts: [{ type: 'tool', tool: 'edit', state: {} }],
        },
      ],
    ],
  ])('no delivery for %s', async (_name: string, messages: unknown[]) => {
    const hook = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
    });

    await deliver(hook, messages);

    expect(trailingNudges(messages)).toHaveLength(0);
  });

  test('trusted drift-nudge metadata does not duplicate the stable part', async () => {
    const hook = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
    });
    const message = orchestratorMessage();
    (message.parts as unknown[]).push({
      type: 'text',
      synthetic: true,
      text: IMPLEMENTATION_DRIFT_NUDGE,
      metadata: { [IMPLEMENTATION_DRIFT_NUDGE_METADATA_KEY]: true },
    });
    const messages: unknown[] = [
      orchestratorMessage(),
      assistantToolBlock(['write']),
      message,
    ];

    await hook['experimental.chat.messages.transform']({}, { messages });

    expect(reminderParts(message)).toHaveLength(1);
  });

  test('passes the derived session ID to shouldInject', async () => {
    const seenSessionIDs: string[] = [];
    const hook = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
      shouldInject: (sessionID) => {
        seenSessionIDs.push(sessionID);
        return false;
      },
    });
    const messages: unknown[] = [
      orchestratorMessage(),
      assistantToolBlock(['Read']),
    ];

    // The gate is lazy by design (P2 fix): the stable path only consults
    // it when history qualifies, so the trailing path exercises it here.
    await deliver(hook, messages);
    expect(trailingNudges(messages)).toHaveLength(0);
    expect(seenSessionIDs).toEqual(['s1']);
  });

  test('a gate flip to false never removes an already-rendered stable part', async () => {
    // Greptile P2: shouldInject reads mutable agent metadata. A part
    // injected while the gate was true must survive a later render with
    // the gate false — removing it would rewrite the cached prefix.
    let eligible = true;
    const hook = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
      shouldInject: () => eligible,
    });
    const nextUser = orchestratorMessage();
    const messages: unknown[] = [
      orchestratorMessage(),
      assistantToolBlock(['edit']),
      nextUser,
    ];

    await deliver(hook, messages);
    expect(reminderParts(nextUser)).toHaveLength(1);
    const rendered = JSON.stringify(nextUser.parts);

    eligible = false;
    await deliver(hook, messages);

    expect(reminderParts(nextUser)).toHaveLength(1);
    expect(JSON.stringify(nextUser.parts)).toBe(rendered);
  });

  test('keeps sessions isolated', async () => {
    const hook = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
    });
    const s1Messages: unknown[] = [
      orchestratorMessage('s1'),
      assistantToolBlock(['Read'], 's1'),
    ];
    const s2Messages: unknown[] = [
      orchestratorMessage('s2'),
      assistantToolBlock(['grep'], 's2'),
    ];

    await deliver(hook, s1Messages);
    await deliver(hook, s2Messages);

    expect(trailingNudges(s1Messages)).toHaveLength(1);
    expect(trailingNudges(s2Messages)).toHaveLength(0);
  });

  test('composed with phase-reminder: drift nudge adds real signal', async () => {
    // Regression for the #1012 oracle finding: both hooks in pipeline
    // order. A turn whose tool loop used implementation tools carries
    // BOTH the trailing drift nudge and the base phase reminder; a
    // grep-only loop carries only the base reminder — proving the
    // widened tool set changes the delivered payload.
    const nudge = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
    });
    const phaseReminder = createPhaseReminderHook();

    const afterBashMessages: unknown[] = [
      orchestratorMessage('s-bash'),
      assistantToolBlock(['bash'], 's-bash'),
    ];
    await phaseReminder['experimental.chat.messages.transform'](
      {},
      { messages: afterBashMessages },
    );
    await deliver(nudge, afterBashMessages);
    expect(trailingNudges(afterBashMessages)).toHaveLength(1);
    expect(
      (
        afterBashMessages[0] as ReturnType<typeof orchestratorMessage>
      ).parts.filter((p) => p.text === PHASE_REMINDER),
    ).toHaveLength(1);

    const afterGrepMessages: unknown[] = [
      orchestratorMessage('s-grep'),
      assistantToolBlock(['grep'], 's-grep'),
    ];
    await phaseReminder['experimental.chat.messages.transform'](
      {},
      { messages: afterGrepMessages },
    );
    await deliver(nudge, afterGrepMessages);
    expect(trailingNudges(afterGrepMessages)).toHaveLength(0);
    expect(
      (
        afterGrepMessages[0] as ReturnType<typeof orchestratorMessage>
      ).parts.filter((p) => p.text === PHASE_REMINDER),
    ).toHaveLength(1);
  });

  test('trailing cleanup happens before gates: residue never survives an ineligible render', async () => {
    // Oracle r3 blocker 2: a trailing nudge from a previous render must
    // be removed even when the current render is ineligible (gate
    // flipped, session changed). The early transform strips it before
    // any gate can return.
    let eligible = true;
    const hook = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
      shouldInject: () => eligible,
    });
    const messages: unknown[] = [
      orchestratorMessage('s1'),
      assistantToolBlock(['bash'], 's1'),
    ];

    await deliver(hook, messages);
    expect(trailingNudges(messages)).toHaveLength(1);

    // Next render flips the gate off and drops the tool loop: the
    // residue must disappear even though no delivery would occur.
    eligible = false;
    messages.push(orchestratorMessage('s1'));
    await deliver(hook, messages);
    expect(trailingNudges(messages)).toHaveLength(0);
  });

  test('a specialist assistant block never nudges the orchestrator user message', async () => {
    // Oracle r3 blocker 3: implementation work done by a CHILD agent
    // (different agent and/or session) must not attribute drift to the
    // orchestrator. U(orch) -> A(fixer, edit) -> U(orch): no stable part.
    const hook = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
    });
    const nextUser = orchestratorMessage('s-orch');
    const messages: unknown[] = [
      orchestratorMessage('s-orch'),
      {
        info: { role: 'assistant', agent: 'fixer', sessionID: 's-child' },
        parts: [{ type: 'tool', tool: 'edit', state: {} }],
      },
      nextUser,
    ];

    await deliver(hook, messages);

    expect(reminderParts(nextUser)).toHaveLength(0);
    expect(trailingNudges(messages)).toHaveLength(0);
  });

  test('stable part keeps its position across renders when other hooks append after it', async () => {
    // Oracle r4 blocker 1: strip-then-reappend reordered the stable
    // drift part behind parts added by later hooks. The selective
    // reconciliation must KEEP the existing tagged part at its position
    // (byte-stable), not remove and re-append it.
    const nudge = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
    });
    const phaseReminder = createPhaseReminderHook();
    const nextUser = orchestratorMessage();
    const messages: unknown[] = [
      orchestratorMessage(),
      assistantToolBlock(['edit']),
      nextUser,
    ];

    // Real pipeline order for the message transforms: nudge runs BEFORE
    // phase-reminder (src/index.ts), so phase's part lands after the
    // drift part on the first render.
    await nudge['experimental.chat.messages.transform']({}, { messages });
    await phaseReminder['experimental.chat.messages.transform'](
      {},
      { messages },
    );
    await nudge.deliverTrailingNudge({}, { messages });

    const partIndex = (text: string) =>
      nextUser.parts.findIndex((part) => part.text === text);
    expect(partIndex(IMPLEMENTATION_DRIFT_NUDGE)).toBeLessThan(
      partIndex(PHASE_REMINDER),
    );
    const firstRender = JSON.stringify(nextUser.parts);

    // Second render over the same array: the drift part must still sit
    // before the phase part (same bytes), not be re-appended at the end.
    await nudge['experimental.chat.messages.transform']({}, { messages });
    await phaseReminder['experimental.chat.messages.transform'](
      {},
      { messages },
    );
    await nudge.deliverTrailingNudge({}, { messages });

    expect(partIndex(IMPLEMENTATION_DRIFT_NUDGE)).toBeLessThan(
      partIndex(PHASE_REMINDER),
    );
    expect(JSON.stringify(nextUser.parts)).toBe(firstRender);
  });

  test('an internal-initiator user turn is a real tail: no trailing nudge over it', async () => {
    // Oracle r4 blocker 2: the tail scan must skip ONLY tagged
    // infrastructure trailing messages (the job board's). A synthetic
    // internal-initiator user turn is persisted history and counts as
    // the real tail — no trailing nudge may ride over it.
    const hook = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
    });
    const internalTurn = {
      info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
      parts: [createInternalAgentTextPart('continue')],
    };
    const messages: unknown[] = [
      orchestratorMessage(),
      assistantToolBlock(['edit']),
      internalTurn,
    ];

    await deliver(hook, messages);

    expect(trailingNudges(messages)).toHaveLength(0);
  });

  test('board checkpoint snapshots are transparent: never a recipient, scan reaches through', async () => {
    // Oracle r5 blocker: a replayed board snapshot (user-shaped, board
    // tagged) between the assistant block and the real user message
    // must neither receive a drift part nor cut the backward scan. U2
    // keeps its nudge, the snapshot keeps exactly its own bytes, and a
    // re-render over the same array is byte-stable.
    const hook = createPostFileToolNudgeHook({
      coordinator: new SessionLifecycle(() => {}),
    });
    const boardSnapshot = {
      info: {
        role: 'user',
        agent: 'orchestrator',
        sessionID: 's1',
        id: 'oh-my-opencode-slim:background-job-board:s1:0',
      },
      parts: [
        {
          type: 'text',
          synthetic: true,
          text: 'board snapshot',
          metadata: { [BACKGROUND_JOB_BOARD_METADATA_KEY]: true },
        },
      ],
    };
    const u2 = orchestratorMessage();
    const messages: unknown[] = [
      orchestratorMessage(),
      assistantToolBlock(['read']),
      boardSnapshot,
      u2,
    ];

    await deliver(hook, messages);

    expect(reminderParts(u2)).toHaveLength(1); // scan saw through the snapshot
    expect(boardSnapshot.parts).toHaveLength(1); // infra untouched
    const firstRender = JSON.stringify(u2.parts);

    await deliver(hook, messages); // re-render over the same array

    expect(JSON.stringify(u2.parts)).toBe(firstRender);
    expect(boardSnapshot.parts).toHaveLength(1);
  });
});
