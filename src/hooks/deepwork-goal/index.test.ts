import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { routerHeadAnnouncement } from '../deepwork';
import { BACKGROUND_JOB_BOARD_METADATA_KEY } from '../task-session-manager/board-injection';
import type { MessageWithParts } from '../types';
import {
  createDeepworkGoalHook,
  createDeepworkHeadGate,
  GOAL_POINTER_METADATA_KEY,
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

function goalMessages(messages: unknown[]): MessageWithParts[] {
  return messages.filter(
    (message): message is MessageWithParts =>
      (message as MessageWithParts)?.info?.id === `deepwork-goal-${SESSION}` &&
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
