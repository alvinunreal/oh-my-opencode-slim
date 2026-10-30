import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { stripTaggedContent } from '../cache-safe-injection';
import { routerHeadAnnouncement } from '../deepwork';
import { createMessageTransformView } from '../message-transform-view';
import { BACKGROUND_JOB_BOARD_METADATA_KEY } from '../task-session-manager/board-injection';
import type { MessageWithParts } from '../types';
import {
  createDeepworkGoalHook,
  createDeepworkHeadGate,
  GOAL_POINTER_METADATA_KEY,
  isCompletedFlip,
} from './index';

const SESSION = 's1';

function userMessage(text: string, sessionID = SESSION): MessageWithParts {
  return {
    info: { role: 'user', agent: 'orchestrator', sessionID },
    parts: [{ type: 'text', text }],
  };
}

function assistantMessage(text: string, sessionID = SESSION): MessageWithParts {
  return {
    info: { role: 'assistant', sessionID },
    parts: [{ type: 'text', text }],
  };
}

/** Host-shaped turns carrying message IDs (the epoch token's source). */
function userTurn(
  id: string,
  text: string,
  sessionID = SESSION,
): MessageWithParts {
  return {
    info: { role: 'user', agent: 'orchestrator', sessionID, id },
    parts: [{ type: 'text', text }],
  };
}

function assistantTurn(
  id: string,
  text: string,
  sessionID = SESSION,
): MessageWithParts {
  return {
    info: { role: 'assistant', sessionID, id },
    parts: [{ type: 'text', text }],
  };
}

/** An internal wake: synthetic + internal-initiator marked. */
function wakeMessage(sessionID = SESSION): MessageWithParts {
  return {
    info: { role: 'user', agent: 'orchestrator', sessionID },
    parts: [
      {
        type: 'text',
        synthetic: true,
        text: 'wake body\n<!-- SLIM_INTERNAL_INITIATOR -->',
        metadata: { 'oh-my-opencode-slim.internalInitiator': true },
      },
    ],
  };
}

function goalMessages(
  messages: unknown[],
  sessionID = SESSION,
): MessageWithParts[] {
  return messages.filter(
    (message): message is MessageWithParts =>
      (message as MessageWithParts)?.info?.id ===
        `deepwork-goal-${sessionID}` &&
      (message as MessageWithParts).parts?.some(
        (part) =>
          (part as Record<string, unknown>).metadata?.[
            GOAL_POINTER_METADATA_KEY
          ] === true,
      ),
  );
}

function stableFingerprint(messages: unknown[]): string {
  // Everything except the trailing goal message — the model of the cached
  // prefix the pointer must never rewrite.
  return JSON.stringify(
    messages.filter((m) => !goalMessages([m]).length),
    (key, value) =>
      key === 'id' && value === `deepwork-goal-${SESSION}` ? value : value,
  );
}

function createHook(eligible = true) {
  return createDeepworkGoalHook({
    isEligible: () => eligible,
  })['experimental.chat.messages.transform'];
}

describe('createDeepworkGoalHook', () => {
  test('appends one trailing volatile pointer message on eligible sessions', async () => {
    const transform = createHook();
    const output = {
      messages: [userMessage('start the work'), assistantMessage('working')],
    };

    await transform({}, output);

    const [goal] = goalMessages(output.messages);
    expect(goal).toBeDefined();
    // Trailing: the last message in the payload.
    expect(output.messages[output.messages.length - 1]).toBe(goal);
    const part = goal.parts[0] as Record<string, unknown>;
    expect(part.synthetic).toBe(true);
    expect(part.text).toStartWith('<system-reminder>');
    expect(part.text).toEndWith('</system-reminder>');
    expect(part.text).toContain('`.slim/deepwork/s1.md`');
    // State-neutral: no run status in the text, the file is authoritative.
    expect(part.text).not.toContain('active');
    // Dual-tagged: a first-class resident of the board's volatile zone.
    expect(
      (part.metadata as Record<string, unknown>)[
        BACKGROUND_JOB_BOARD_METADATA_KEY
      ],
    ).toBe(true);
    expect(goal.info).toMatchObject({
      role: 'user',
      agent: 'orchestrator',
      sessionID: SESSION,
    });
  });

  test('is idempotent: a repeated transform leaves exactly one pointer', async () => {
    const transform = createHook();
    const output = { messages: [userMessage('start')] };

    await transform({}, output);
    await transform({}, output);

    expect(goalMessages(output.messages)).toHaveLength(1);
  });

  test('never rewrites the stable prefix when eligibility flips', async () => {
    // Session starts as normal chat: no head on disk yet → gate closed.
    const closedGate = createHook(false);
    const before = {
      messages: [userMessage('hello'), assistantMessage('hi')],
    };
    await closedGate({}, before);
    expect(goalMessages(before.messages)).toHaveLength(0);

    // /deepwork ran mid-session: the head exists on the next request. The
    // pointer appears in the volatile tail; earlier messages are
    // byte-identical to what was already sent (review point 1).
    const transform = createHook();
    const activated = {
      messages: [
        ...before.messages,
        userMessage('run the big task'),
        assistantMessage('on it'),
      ],
    };
    await transform({}, activated);
    expect(goalMessages(activated.messages)).toHaveLength(1);
    expect(JSON.stringify((activated.messages as unknown[]).slice(0, 2))).toBe(
      JSON.stringify(before.messages),
    );

    // Head deleted (or run completed): the pointer disappears from the
    // volatile tail only — the stable prefix, now including the deepwork
    // turns, is untouched (review point 1, second bust).
    const stripped = activated.messages.filter(
      (m) => !goalMessages([m]).length,
    );
    const afterClose = {
      messages: [...structuredClone(stripped), userMessage('next')],
    };
    await closedGate({}, afterClose);
    expect(goalMessages(afterClose.messages)).toHaveLength(0);
    expect(JSON.stringify(afterClose.messages.slice(0, -1))).toBe(
      JSON.stringify(stripped),
    );
  });

  test('wake-only window: pointer appended even with no genuine user message', async () => {
    const transform = createHook();
    // Post-auto-compaction unattended continuation: the retained tail is a
    // synthetic summary plus an internal wake. No human message anywhere —
    // the exact case review point 2 says the feature exists for.
    const summary: MessageWithParts = {
      info: { role: 'user', agent: 'orchestrator', sessionID: SESSION },
      parts: [
        {
          type: 'text',
          synthetic: true,
          text: 'compaction summary: the deepwork task continues',
        },
      ],
    };
    const output = { messages: [summary, wakeMessage()] };

    await transform({}, output);

    expect(goalMessages(output.messages)).toHaveLength(1);
    // Byte-stable on the next resumed request.
    const next = {
      messages: [
        summary,
        wakeMessage(),
        assistantMessage('re-reading the head, then continuing'),
        wakeMessage(),
      ],
    };
    await transform({}, next);
    const [goal] = goalMessages(next.messages);
    expect(next.messages[next.messages.length - 1]).toBe(goal);
    expect(JSON.stringify(goalMessages(output.messages)[0])).toBe(
      JSON.stringify(goal),
    );
  });

  test('skips at zero cost while the head announcement is visible', async () => {
    const transform = createHook();
    const output = {
      messages: [
        userMessage(routerHeadAnnouncement(SESSION)),
        userMessage('continue'),
      ],
    };

    await transform({}, output);

    expect(goalMessages(output.messages)).toHaveLength(0);
  });

  test('a later announcement quote removes the pointer without a prefix rewrite', async () => {
    const transform = createHook();
    const turnN = {
      messages: [userMessage('first'), assistantMessage('work')],
    };
    await transform({}, turnN);
    const stablePrefixN = stableFingerprint(turnN.messages);

    // The model quotes the activation sentence in a newer message: the
    // path is in front of the model again, so the pointer drops — and the
    // drop only ever costs the volatile tail, never the prefix.
    const turnNPlusOne = {
      messages: [
        userMessage('first'),
        assistantMessage('work'),
        assistantMessage(
          `to recap: ${routerHeadAnnouncement(SESSION)} — proceeding accordingly`,
        ),
        userMessage('next'),
      ],
    };
    await transform({}, turnNPlusOne);

    expect(goalMessages(turnNPlusOne.messages)).toHaveLength(0);
    expect(
      stableFingerprint(turnNPlusOne.messages).startsWith(
        stablePrefixN.slice(0, -1),
      ),
    ).toBe(true);
  });

  test('does not match another session’s announcement', async () => {
    const transform = createHook();
    const output = {
      messages: [
        userMessage(routerHeadAnnouncement('s-other'), SESSION),
        userMessage('continue'),
      ],
    };

    await transform({}, output);

    expect(goalMessages(output.messages)).toHaveLength(1);
  });

  test('fail closed: no user message in the window', async () => {
    const transform = createHook();
    const output = { messages: [assistantMessage('only assistant')] };

    await transform({}, output);

    expect(output.messages).toHaveLength(1);
    expect(goalMessages(output.messages)).toHaveLength(0);
  });

  test('injects once per compaction epoch, not per request', async () => {
    const transform = createHook();
    const turn1 = {
      messages: [
        userTurn('u1', 'start the work'),
        assistantTurn('a1', 'working'),
      ],
    };
    await transform({}, turn1);
    expect(goalMessages(turn1.messages)).toHaveLength(1);

    // Same epoch (first message ID unchanged): the pointer was delivered;
    // a per-request pointer reads as a per-turn directive.
    const turn2 = {
      messages: [
        userTurn('u1', 'start the work'),
        assistantTurn('a1', 'working'),
        userTurn('u2', 'continue'),
      ],
    };
    await transform({}, turn2);
    expect(goalMessages(turn2.messages)).toHaveLength(0);

    // Compaction rebuilds the window (new first message ID): re-armed.
    const compacted = {
      messages: [
        userTurn('c1', 'compaction summary: the task continues'),
        assistantTurn('c2', 'resuming'),
      ],
    };
    await transform({}, compacted);
    expect(goalMessages(compacted.messages)).toHaveLength(1);
  });

  test('head rewrite mid-epoch does not re-inject (state-neutral pointer)', async () => {
    const transform = createHook();
    const turn1 = { messages: [userTurn('u1', 'start')] };
    await transform({}, turn1);
    expect(goalMessages(turn1.messages)).toHaveLength(1);

    // The pointer names the path only; a head rewrite never re-points.
    const turn2 = {
      messages: [userTurn('u1', 'start'), userTurn('u2', 'synced the head')],
    };
    await transform({}, turn2);
    expect(goalMessages(turn2.messages)).toHaveLength(0);
  });

  test('re-entered transform on a shared array keeps exactly one pointer', async () => {
    const transform = createHook();
    const output = {
      messages: [userTurn('u1', 'start'), assistantTurn('a1', 'working')],
    };

    await transform({}, output);
    await transform({}, output);

    expect(goalMessages(output.messages)).toHaveLength(1);
    expect(output.messages[output.messages.length - 1]).toBe(
      goalMessages(output.messages)[0],
    );
  });

  test('full-chain re-entry: the board strip removes the pointer, the goal pass restores it', async () => {
    const transform = createHook();
    const output = {
      messages: [userTurn('u1', 'start'), assistantTurn('a1', 'working')],
    };

    await transform({}, output);
    expect(goalMessages(output.messages)).toHaveLength(1);

    // Second pass of the composed chain on the same array: the board's
    // trailing-zone strip removes the dual-tagged pointer.
    stripTaggedContent(output.messages, BACKGROUND_JOB_BOARD_METADATA_KEY);
    expect(goalMessages(output.messages)).toHaveLength(0);

    // The goal pass restores it for this payload instead of treating the
    // request as already served — otherwise the pointer would be lost for
    // the rest of the epoch.
    await transform({}, output);
    expect(goalMessages(output.messages)).toHaveLength(1);
    expect(output.messages[output.messages.length - 1]).toBe(
      goalMessages(output.messages)[0],
    );
  });

  test('the same epoch on a fresh array stays suppressed after a chain re-entry', async () => {
    const transform = createHook();
    const chain = {
      messages: [userTurn('u1', 'start'), assistantTurn('a1', 'working')],
    };
    await transform({}, chain);
    stripTaggedContent(chain.messages, BACKGROUND_JOB_BOARD_METADATA_KEY);
    await transform({}, chain);
    expect(goalMessages(chain.messages)).toHaveLength(1);

    // A different array is a new request the epoch already served.
    const nextRequest = {
      messages: [
        ...chain.messages.filter((m) => !goalMessages([m]).length),
        userTurn('u2', 'continue'),
      ],
    };
    await transform({}, nextRequest);
    expect(goalMessages(nextRequest.messages)).toHaveLength(0);
  });

  test('multi-session claims stay isolated', async () => {
    const transform = createHook();
    const s1Turns = [
      userTurn('u1', 'start', 's1'),
      assistantTurn('a1', 'work', 's1'),
    ];
    const s2Turns = [
      userTurn('v1', 'start', 's2'),
      assistantTurn('b1', 'work', 's2'),
    ];
    const s1 = { messages: [...s1Turns] };
    const s2 = { messages: [...s2Turns] };
    await transform({}, s1);
    await transform({}, s2);
    expect(goalMessages(s1.messages, 's1')).toHaveLength(1);
    expect(goalMessages(s2.messages, 's2')).toHaveLength(1);

    // Interleaved same-epoch requests (fresh arrays, as the host renders
    // them): each claim only suppresses its own session's pointer.
    const s1Next = { messages: [...s1Turns, userTurn('u2', 'continue', 's1')] };
    const s2Next = { messages: [...s2Turns, userTurn('v2', 'continue', 's2')] };
    await transform({}, s1Next);
    await transform({}, s2Next);
    expect(goalMessages(s1Next.messages, 's1')).toHaveLength(0);
    expect(goalMessages(s2Next.messages, 's2')).toHaveLength(0);
  });

  test('FIFO eviction re-arms the pointer', async () => {
    // One shared transform: the 256-cap eviction must happen inside the
    // claim map this instance owns.
    const transform = createHook();
    const first = { messages: [userTurn('u1', 'start')] };
    await transform({}, first);
    expect(goalMessages(first.messages)).toHaveLength(1);

    // 256 other sessions claim and evict SESSION's claim (same epoch).
    for (let i = 0; i < 256; i += 1) {
      const sid = `filler-${i}`;
      const filler = {
        messages: [
          userTurn(`f${i}`, 'filler', sid),
          userTurn(`g${i}`, 'go', sid),
        ],
      };
      await transform({}, filler);
    }

    // Same epoch, evicted claim: re-injects once (bounded harm).
    const again = {
      messages: [userTurn('u1', 'start'), userTurn('u2', 'next')],
    };
    await transform({}, again);
    expect(goalMessages(again.messages)).toHaveLength(1);
  });

  test('fail-open: an ID-less window injects every request', async () => {
    const transform = createHook();
    const first = { messages: [userMessage('no ids here')] };
    await transform({}, first);
    expect(goalMessages(first.messages)).toHaveLength(1);

    const second = {
      messages: [userMessage('no ids here'), userMessage('again')],
    };
    await transform({}, second);
    expect(goalMessages(second.messages)).toHaveLength(1);
  });

  test('a leading ID-less message does not poison the epoch token', async () => {
    const transform = createHook();
    const first = {
      messages: [userMessage('id-less lead'), userTurn('u1', 'start')],
    };
    await transform({}, first);
    expect(goalMessages(first.messages)).toHaveLength(1);

    // Same epoch despite the leading ID-less entry: suppressed.
    const second = {
      messages: [
        userMessage('id-less lead'),
        userTurn('u1', 'start'),
        userTurn('u2', 'next'),
      ],
    };
    await transform({}, second);
    expect(goalMessages(second.messages)).toHaveLength(0);
  });

  test('same-epoch eligibility flip still injects on the first eligible request', async () => {
    const closed = createHook(false);
    const open = createHook(true);
    const messages = [userTurn('u1', 'start'), userTurn('u2', 'deepwork now')];

    const before = { messages: [...messages] };
    await closed({}, before);
    expect(goalMessages(before.messages)).toHaveLength(0);

    // The head appears mid-epoch (/deepwork ran): the pointer still lands.
    const after = { messages: [...messages, userTurn('u3', 'continue')] };
    await open({}, after);
    expect(goalMessages(after.messages)).toHaveLength(1);
  });

  test('revert into a claimed epoch stays suppressed', async () => {
    const transform = createHook();
    const epochTurns = [userTurn('u1', 'start'), assistantTurn('a1', 'work')];
    const turn1 = { messages: [...epochTurns] };
    await transform({}, turn1);
    expect(goalMessages(turn1.messages)).toHaveLength(1);

    const turn2 = { messages: [...epochTurns, userTurn('u2', 'continue')] };
    await transform({}, turn2);
    expect(goalMessages(turn2.messages)).toHaveLength(0);

    // Undo rewinds into the claimed epoch: no re-inject. Either the rewind
    // stays inside the active run (the /deepwork announcement is still in
    // the window, so the path is visible) or it rewinds past activation —
    // and re-adding a pointer there would contradict the user's unwind.
    const reverted = { messages: [...epochTurns] };
    await transform({}, reverted);
    expect(goalMessages(reverted.messages)).toHaveLength(0);
  });

  test('synthetic-only leading summary does not flip the epoch every request', async () => {
    const transform = createHook();
    const summary: MessageWithParts = {
      info: {
        role: 'user',
        agent: 'orchestrator',
        sessionID: SESSION,
        id: 'sum-1',
      },
      parts: [{ type: 'text', synthetic: true, text: 'compaction summary' }],
    };
    const compacted = {
      messages: [summary, userTurn('u1', 'continue the deepwork task')],
    };
    await transform({}, compacted);
    expect(goalMessages(compacted.messages)).toHaveLength(1);

    const next = {
      messages: [summary, userTurn('u1', 'continue'), userTurn('u2', 'more')],
    };
    await transform({}, next);
    expect(goalMessages(next.messages)).toHaveLength(0);
  });

  test('ineligible flip strips the pointer from the shared array', async () => {
    const eligibleTransform = createHook(true);
    const closedTransform = createHook(false);
    const output = {
      messages: [userTurn('u1', 'start'), assistantTurn('a1', 'working')],
    };

    await eligibleTransform({}, output);
    expect(goalMessages(output.messages)).toHaveLength(1);

    // Head tombstoned mid-epoch: the stale pointer leaves via the volatile
    // tail only.
    await closedTransform({}, output);
    expect(goalMessages(output.messages)).toHaveLength(0);
  });
});

describe('isCompletedFlip', () => {
  test('completion format is pinned to the SKILL.md contract', () => {
    // SSoT: the flip detection parses the contract's stated tombstone
    // format; a contract format change must update both together.
    const skill = readFileSync(
      path.join(import.meta.dir, '../../skills/deepwork/SKILL.md'),
      'utf-8',
    );
    expect(skill).toContain('`status: completed`');
    // The shared predicate matches the first line only: a completed
    // status below the first line is not a flip.
    expect(isCompletedFlip('status: completed')).toBe(true);
    expect(isCompletedFlip('notes:\nstatus: completed')).toBe(false);
    expect(isCompletedFlip('status: completed_x')).toBe(false);
  });
});

describe('createDeepworkHeadGate', () => {
  let dir: string;

  test('gate follows the head file lifecycle (fail open on doubt)', () => {
    dir = mkdtempSync('deepwork-goal-gate-');
    try {
      const gate = createDeepworkHeadGate(dir);
      const head = `${dir}/.slim/deepwork/${SESSION}.md`;
      mkdirSync(`${dir}/.slim/deepwork`, { recursive: true });
      // Force distinct mtimes: the gate caches by mtimeMs, and consecutive
      // writes inside one timestamp granularity would read as unchanged.
      let mtime = 1_700_000_000_000;
      const write = (content: string) => {
        writeFileSync(head, content);
        mtime += 5000;
        utimesSync(head, new Date(mtime), new Date(mtime));
      };

      // No head → closed.
      expect(gate(SESSION)).toBe(false);

      // Active head → open.
      write('status: active\nslug: demo\ntask: demo\n');
      expect(gate(SESSION)).toBe(true);

      // Completed head → closed (mtime moved, re-read).
      write('status: completed\nfinal conclusion\n');
      expect(gate(SESSION)).toBe(false);

      // Reused head flips back to active → open (new run, same session).
      write('status: active\nslug: demo-2\ntask: demo-2\n');
      expect(gate(SESSION)).toBe(true);

      // Drifted status line → fail open (over-inject, never drop).
      write('status active (typo)\n');
      expect(gate(SESSION)).toBe(true);

      // Deleted → closed.
      rmSync(head);
      expect(gate(SESSION)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
