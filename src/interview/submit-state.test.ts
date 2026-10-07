import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { InterviewConfigSchema } from '../config/schema';
import { normalizeAssistantState, parseAssistantState } from './parser';
import type { InterviewSessionRuntime } from './runtime';
import { createInterviewService } from './service';
import type { InterviewMessage, InterviewState } from './types';

interface Harness {
  directory: string;
  messages: InterviewMessage[];
  notifyCalls: string[];
  continued: string[];
  failContinue: { value: boolean };
  continueHook: (() => Promise<void>) | undefined;
  service: ReturnType<typeof createInterviewService>;
}

async function createHarness(
  config?: Partial<Parameters<typeof createInterviewService>[1]>,
  continueFailure = false,
): Promise<Harness> {
  const directory = await fs.mkdtemp('/tmp/interview-submit-state-');
  const messages: InterviewMessage[] = [];
  const notifyCalls: string[] = [];
  const continued: string[] = [];
  const failContinue = { value: false };
  let continueHook: (() => Promise<void>) | undefined;
  const runtime: InterviewSessionRuntime = {
    messages: async () => messages,
    notify: async (_sessionID, text) => {
      notifyCalls.push(text);
    },
    continue: async (_sessionID, text) => {
      continued.push(text);
      await continueHook?.();
      if (failContinue.value || continueFailure === true) {
        throw new Error('continuation failed');
      }
    },
    rename: async () => {},
  };
  const resolved = config ? InterviewConfigSchema.parse(config) : undefined;
  const service = createInterviewService({ directory } as never, resolved, {
    runtime,
    openBrowser: () => {},
  });
  service.setBaseUrlResolver(async () => 'http://127.0.0.1:43211');
  return {
    directory,
    messages,
    notifyCalls,
    continued,
    failContinue,
    get continueHook() {
      return continueHook;
    },
    set continueHook(value: (() => Promise<void>) | undefined) {
      continueHook = value;
    },
    service,
  };
}

async function startInterview(
  harness: Harness,
  sessionID = 'ses-submit',
  idea = 'Submit state app',
): Promise<string> {
  await harness.service.handleCommandExecuteBefore(
    { command: 'interview', sessionID, arguments: idea },
    { parts: [] },
  );
  const interviewId = harness.service.getActiveInterviewId(sessionID);
  expect(interviewId).not.toBeNull();
  // A stored assistant message keeps loadMessagesWithRetry from spinning in
  // tests; it carries no <interview_state> block on purpose.
  harness.messages.push({
    info: { role: 'assistant' },
    parts: [{ type: 'text', text: 'Working on it.' }],
  });
  return interviewId as string;
}

function blockText(json: string): string {
  return `Here is the state.\n<interview_state>\n${json}\n</interview_state>`;
}

describe('interview submitState (tool path)', () => {
  test('state captured via the tool equals parser output for the same fixture', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    const raw = {
      summary: 'A specification',
      title: 'spec-title',
      patch: undefined,
      questions: [
        {
          id: 'q-1',
          question: 'Platform?',
          options: ['Web', 'Mobile', 'Desktop', 'Tablet', 'Other'],
          suggested: 'Web',
        },
        { id: '', question: 'Scope?' },
      ],
    };

    const result = await harness.service.submitState(
      'ses-submit',
      raw as never,
    );
    expect(result.ok).toBe(true);

    const parserOutput = parseAssistantState(
      blockText(JSON.stringify(raw)),
      2,
    ).state;
    expect(parserOutput).not.toBeNull();

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.summary).toBe(normalizeAssistantState(raw, 2).summary);
    expect(state.questions).toEqual(parserOutput?.questions);
    expect(state.document).toContain('A specification');
  });

  test('rejects with a short line and no document for no active interview', async () => {
    const harness = await createHarness();
    const result = await harness.service.submitState('ses-none', {
      summary: 'x',
      questions: [],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('⎔ Interview state rejected');
  });

  test('keeps the accepted questions and exposes patch failure as an error', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Accepted specification',
      questions: [{ id: 'q-1', question: 'What is next?', options: [] }],
    });

    const result = await harness.service.submitState('ses-submit', {
      summary: 'Rejected specification',
      patch: '@@ -1,1 +1,1 @@\n-this does not exist\n+replacement',
      questions: [{ id: 'q-2', question: 'Rejected question?', options: [] }],
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('patch failed');
    const state = await harness.service.getInterviewState(interviewId);
    expect(state.mode).toBe('error');
    expect(state.questions.map((question) => question.id)).toEqual(['q-1']);
    expect(state.lastParseError).toBeTruthy();
  });

  test('blocks implement after a failed patch until a corrected complete state', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Accepted specification',
      questions: [],
    });

    await harness.service.submitState('ses-submit', {
      summary: 'Rejected specification',
      patch: '@@ -1,1 +1,1 @@\n-missing line\n+replacement',
      questions: [],
    });
    const failed = await harness.service.getInterviewState(interviewId);
    expect(failed.mode).toBe('error');

    for (const arguments_ of ['', failed.markdownPath]) {
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await harness.service.handleCommandExecuteBefore(
        {
          command: 'implement',
          sessionID: 'ses-submit',
          arguments: arguments_,
        },
        output,
      );
      expect(output.parts[0]?.text).toContain('latest spec update failed');
    }

    await harness.service.submitState('ses-submit', {
      summary: 'Corrected specification',
      patch:
        '@@ -1,1 +1,1 @@\n-Accepted specification\n+Corrected specification',
      questions: [],
    });
    await harness.service.handleNudgeAction(interviewId, 'confirm-complete');
    const output = { parts: [] as Array<{ type: string; text?: string }> };
    await harness.service.handleCommandExecuteBefore(
      { command: 'implement', sessionID: 'ses-submit', arguments: '' },
      output,
    );
    expect(output.parts[0]?.text).toContain('Implement the markdown');
  });

  test('a corrected tool patch wins over an earlier failure in the same turn', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    harness.notifyCalls.length = 0;
    await harness.service.submitState('ses-submit', {
      summary: 'Original',
      questions: [{ id: 'q-1', question: 'Next?' }],
    });
    await harness.service.submitState('ses-submit', {
      summary: 'Broken',
      patch: '@@ -1,1 +1,1 @@\n-missing\n+Broken',
      questions: [{ id: 'q-2', question: 'Wrong?' }],
    });
    const corrected = await harness.service.submitState('ses-submit', {
      summary: 'Corrected',
      patch: '@@ -1,1 +1,1 @@\n-Original\n+Corrected',
      questions: [{ id: 'q-3', question: 'Right?' }],
    });

    expect(corrected.ok).toBe(true);
    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.continued).toHaveLength(0);
    expect(harness.notifyCalls).toHaveLength(1);
    expect(harness.notifyCalls[0]).toContain('Spec updated');
    const state = await harness.service.getInterviewState(interviewId);
    expect(state.mode).toBe('awaiting-user');
    expect(state.questions.map((question) => question.id)).toEqual(['q-3']);
  });
});

describe('interview text.complete fallback', () => {
  test('applies a valid block and removes it from the returned text', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    const text = blockText(
      JSON.stringify({
        summary: 'Fallback draft',
        questions: [{ id: 'q-1', question: 'What?' }],
      }),
    );
    const result = await harness.service.completeInterviewText(
      'ses-submit',
      text,
    );

    expect(result).not.toContain('<interview_state>');
    expect(result).not.toContain('"summary"');

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.document).toContain('Fallback draft');
    expect(state.questions).toHaveLength(1);
    // A stripped block should not create a missing-block error.
    expect(state.lastParseError).toBeUndefined();
    expect(state.mode).toBe('awaiting-user');
  });

  test('leaves malformed text unchanged', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    const text = blockText('{not valid json');
    expect(
      await harness.service.completeInterviewText('ses-submit', text),
    ).toBe(text);
  });

  test('keeps the accepted state and questions after a text patch failure', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Accepted text spec',
      questions: [{ id: 'q-1', question: 'Keep this?' }],
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    const text = blockText(
      JSON.stringify({
        summary: 'Rejected text spec',
        patch: 'not a unified diff',
        questions: [{ id: 'q-2', question: 'Do not keep this?' }],
      }),
    );

    await harness.service.completeInterviewText('ses-submit', text);
    const state = await harness.service.getInterviewState(interviewId);
    expect(state.mode).toBe('error');
    expect(state.document).toContain('Accepted text spec');
    expect(state.questions.map((question) => question.id)).toEqual(['q-1']);
  });

  test('leaves non-interview text unchanged', async () => {
    const harness = await createHarness();
    const text = blockText('{"summary":"x","questions":[]}');
    expect(
      await harness.service.completeInterviewText('other-session', text),
    ).toBe(text);
  });

  test('leaves text unchanged in printState mode', async () => {
    const harness = await createHarness({
      maxQuestions: 2,
      outputFolder: 'interview',
      autoOpenBrowser: false,
      printState: true,
    });
    await startInterview(harness);
    const text = blockText('{"summary":"printState","questions":[]}');
    expect(
      await harness.service.completeInterviewText('ses-submit', text),
    ).toBe(text);
  });
});

describe('interview turn-end notice', () => {
  test('posts one status notice per successful turn, not on repeated idle', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;

    await harness.service.submitState('ses-submit', {
      summary: 'Updated spec',
      questions: [{ id: 'q-1', question: 'Q?' }],
    });
    await harness.service.notifyTurnStatus('ses-submit');

    expect(harness.notifyCalls).toHaveLength(1);
    expect(harness.notifyCalls[0]).toContain('⎔ Spec updated');
    expect(harness.notifyCalls[0]).toContain(
      'http://127.0.0.1:43211/interview/',
    );
    expect(harness.notifyCalls[0]).toContain('.md');
    expect(harness.notifyCalls[0]).toContain(
      '[system status: continue without acknowledging this notification]',
    );

    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.notifyCalls).toHaveLength(1);
  });

  test('posts exactly one error notice when a turn ends with no new state', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;

    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.notifyCalls).toHaveLength(1);
    expect(harness.notifyCalls[0]).toContain('⎔ Interview update failed');
    expect(harness.notifyCalls[0]).toContain(
      'http://127.0.0.1:43211/interview/',
    );

    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.notifyCalls).toHaveLength(1);
  });

  test('requests one repair when the patch fails to apply', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;

    const result = await harness.service.submitState('ses-submit', {
      summary: 'Broken',
      patch: '@@ -1,1 +1,1 @@\n-not present\n+replacement',
      questions: [],
    });
    expect(result.ok).toBe(false);

    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.continued).toHaveLength(1);
    expect(harness.continued[0]).toContain('patch');
    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.continued).toHaveLength(1);
  });

  test('a user-typed turn remains submittable and includes the patch failure note', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Accepted',
      questions: [{ id: 'q-1', question: 'First?' }],
    });
    await harness.service.submitState('ses-submit', {
      summary: 'Broken',
      patch: '@@ -1,1 +1,1 @@\n-nope\n+broken',
      questions: [],
    });
    await harness.service.submitChat(interviewId, 'Please continue.');
    expect(harness.continued.at(-1)).toContain('The last spec patch failed');
  });

  test('adds the notice as a new tail message without touching the transcript', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;
    const transcriptBefore = structuredClone(harness.messages);

    await harness.service.submitState('ses-submit', {
      summary: 'Tail notice',
      questions: [],
    });
    await harness.service.notifyTurnStatus('ses-submit');

    // Delivered through notify (a fresh trailing message), never through
    // The snapshot must remain unchanged by either operation.
    expect(harness.notifyCalls).toHaveLength(1);
    expect(harness.notifyCalls[0]).toContain('⎔ Spec updated');
    expect(harness.continued.some((t) => t.includes('⎔ Spec updated'))).toBe(
      false,
    );
    expect(harness.messages).toEqual(transcriptBefore);
  });

  test('fires a fresh notice for a later turn after busy resets the dedupe', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;

    await harness.service.submitState('ses-submit', {
      summary: 'First',
      questions: [{ id: 'q-1', question: 'One?' }],
    });
    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.notifyCalls).toHaveLength(1);

    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.submitState('ses-submit', {
      summary: 'Second',
      patch: '@@ -1,1 +1,1 @@\n-First\n+Second',
      questions: [{ id: 'q-2', question: 'Two?' }],
    });
    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.notifyCalls).toHaveLength(2);
    expect(harness.notifyCalls[1]).toContain('⎔ Spec updated');
  });
});

describe('interview getInterviewState without a block', () => {
  test('returns the last applied state instead of a missing-block error', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    await harness.service.submitState('ses-submit', {
      summary: 'Tool applied state',
      questions: [{ id: 'q-1', question: 'Question?' }],
    });

    const state: InterviewState =
      await harness.service.getInterviewState(interviewId);
    expect(state.lastParseError).toBeUndefined();
    expect(state.questions).toEqual([
      { id: 'q-1', question: 'Question?', options: [], suggested: undefined },
    ]);
    expect(state.mode).toBe('awaiting-user');
  });
});

describe('interview printState turn-end behavior', () => {
  test('posts a status notice for a printed block and still updates the document', async () => {
    const harness = await createHarness({
      maxQuestions: 2,
      outputFolder: 'interview',
      autoOpenBrowser: false,
      printState: true,
    });
    const interviewId = await startInterview(harness);
    harness.messages.push({
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: blockText(
            JSON.stringify({
              summary: 'Verbose block spec',
              questions: [{ id: 'q-1', question: 'Verbose question?' }],
            }),
          ),
        },
      ],
    });
    harness.notifyCalls.length = 0;

    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });

    expect(harness.notifyCalls).toHaveLength(1);
    expect(harness.notifyCalls[0]).toContain('⎔ Spec updated');
    const state = await harness.service.getInterviewState(interviewId);
    expect(state.document).toContain('Verbose block spec');
  });

  test('does not fail twice for consecutive identical empty patches', async () => {
    const harness = await createHarness({ printState: true });
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Stable spec',
      questions: [],
    });
    harness.notifyCalls.length = 0;

    for (let turn = 0; turn < 2; turn += 1) {
      await harness.service.handleEvent({
        event: {
          type: 'session.status',
          properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
        },
      });
      harness.messages.push({
        info: { role: 'assistant', id: `same-state-${turn}` },
        parts: [
          {
            type: 'text',
            text: blockText(
              JSON.stringify({
                summary: 'Stable spec',
                patch: '',
                questions: [],
              }),
            ),
          },
        ],
      });
      await harness.service.handleEvent({
        event: {
          type: 'session.status',
          properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
        },
      });
    }

    expect(
      harness.notifyCalls.filter((text) => text.includes('update failed')),
    ).toHaveLength(0);
    expect(
      (await harness.service.getInterviewState(interviewId)).document,
    ).toContain('Stable spec');
  });

  test('clears pending answers when an answer turn prints an empty patch', async () => {
    const harness = await createHarness({ printState: true });
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Answer spec',
      questions: [{ id: 'q-1', question: 'Platform?' }],
    });
    await harness.service.submitAnswers(interviewId, [
      { questionId: 'q-1', answer: 'Web' },
    ]);
    expect((await harness.service.getInterviewState(interviewId)).mode).toBe(
      'awaiting-agent',
    );

    harness.messages.push({
      info: { role: 'assistant', id: 'answer-state' },
      parts: [
        {
          type: 'text',
          text: blockText(
            JSON.stringify({
              summary: 'Answer spec',
              patch: '',
              questions: [],
            }),
          ),
        },
      ],
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });

    expect(
      (await harness.service.getInterviewState(interviewId)).mode,
    ).not.toBe('awaiting-agent');
  });
});

describe('interview turn lifecycle', () => {
  test('reopens a completed interview before every UI-started turn', async () => {
    for (const startTurn of [
      (service: Harness['service'], id: string) =>
        service.handleNudgeAction(id, 'more-questions'),
      (service: Harness['service'], id: string) =>
        service.submitChat(id, 'Continue the interview.'),
      (service: Harness['service'], id: string) =>
        service.submitBlockComment(id, 'Current spec', 'Clarify this.'),
    ]) {
      const harness = await createHarness();
      const interviewId = await startInterview(harness);
      await harness.service.submitState('ses-submit', {
        summary: 'Completed spec',
        questions: [],
      });
      await harness.service.handleNudgeAction(interviewId, 'confirm-complete');

      await startTurn(harness.service, interviewId);

      const state = await harness.service.getInterviewState(interviewId);
      expect(state.interview.completed).toBe(false);
      expect(state.document).not.toContain('status: complete');
      expect(state.isBusy).toBe(true);
      expect(state.mode).toBe('awaiting-agent');
    }
  });

  test('a mid-turn busy does not wipe a tool submit for the same turn', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;

    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.submitState('ses-submit', {
      summary: 'Mid-turn',
      questions: [{ id: 'q-1', question: 'Q?' }],
    });
    // v1 can emit `busy` once per loop step; the second must not reset the
    // turn and lose the tool state.
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });

    expect(harness.notifyCalls).toHaveLength(1);
    expect(harness.notifyCalls[0]).toContain('⎔ Spec updated');
  });

  test('concurrent double idle posts exactly one notice', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;

    await harness.service.submitState('ses-submit', {
      summary: 'Concurrent',
      questions: [{ id: 'q-1', question: 'Q?' }],
    });

    await Promise.all([
      harness.service.handleEvent({
        event: {
          type: 'session.status',
          properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
        },
      }),
      harness.service.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'ses-submit' },
        },
      }),
    ]);

    expect(harness.notifyCalls).toHaveLength(1);
    expect(harness.notifyCalls[0]).toContain('⎔ Spec updated');
  });

  test('a completed interview posts no error notice on a later turn', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.handleNudgeAction(interviewId, 'confirm-complete');
    harness.notifyCalls.length = 0;

    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });

    expect(harness.notifyCalls).toHaveLength(0);
  });

  test('a text-ended event does not make a turn available while it is busy', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.next.text.ended',
        properties: { sessionID: 'ses-submit' },
      },
    });

    await expect(
      harness.service.submitChat(interviewId, 'Do not start yet.'),
    ).rejects.toThrow('Interview session is busy');
    expect((await harness.service.getInterviewState(interviewId)).isBusy).toBe(
      true,
    );
  });

  test('a later user turn does not post a spurious interview error', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;
    // The kickoff turn is service-initiated and posts its error notice.
    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.notifyCalls).toHaveLength(1);
    harness.notifyCalls.length = 0;

    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.notifyTurnStatus('ses-submit');

    expect(harness.notifyCalls).toHaveLength(0);
  });
});

describe('interview remembered/tool state scoping', () => {
  test('an earlier applied state does not mask a malformed latest block', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    await harness.service.submitState(
      'ses-submit',
      {
        summary: 'Applied earlier',
        questions: [{ id: 'q-old', question: 'Old?' }],
      },
      'msg-tool',
    );
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-latest' },
      parts: [{ type: 'text', text: blockText('{not valid json') }],
    });

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.mode).toBe('error');
    expect(state.lastParseError).toBe('Failed to parse interview state');
    expect(state.questions.map((question) => question.id)).not.toContain(
      'q-old',
    );
  });

  test('a later poll does not re-apply a block printed over the tool state', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-1' },
      parts: [
        {
          type: 'text',
          text: blockText(
            JSON.stringify({
              summary: 'From text',
              questions: [{ id: 'q-text', question: 'Text?' }],
            }),
          ),
        },
      ],
    });

    const result = await harness.service.submitState(
      'ses-submit',
      {
        summary: 'From tool',
        questions: [{ id: 'q-tool', question: 'Tool?' }],
      },
      'msg-1',
    );
    expect(result.ok).toBe(true);

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.document).toContain('From tool');
    expect(state.document).not.toContain('From text');
    expect(state.questions.map((question) => question.id)).toEqual(['q-tool']);
  });

  test('text.complete skips a block printed in the tool-applied message', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    await harness.service.submitState(
      'ses-submit',
      {
        summary: 'Tool state',
        questions: [{ id: 'q-tool', question: 'Tool?' }],
      },
      'msg-1',
    );

    const text = blockText(
      JSON.stringify({
        summary: 'Printed block',
        questions: [{ id: 'q-text', question: 'Text?' }],
      }),
    );
    const stripped = await harness.service.completeInterviewText(
      'ses-submit',
      text,
      'msg-1',
    );
    expect(stripped).not.toContain('<interview_state>');

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.document).toContain('Tool state');
    expect(state.document).not.toContain('Printed block');
  });
});

describe('answers awaiting agent incorporation', () => {
  test('accepted answers clear pending state when the agent submits inline', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Before answers',
      questions: [{ id: 'q-1', question: 'Platform?' }],
    });
    harness.continueHook = async () => {
      harness.messages.push({
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'Accepted.' }],
      });
      await harness.service.submitState('ses-submit', {
        summary: 'After answers',
        patch: '@@ -1,1 +1,1 @@\n-Before answers\n+After answers',
        questions: [],
      });
    };

    await harness.service.submitAnswers(interviewId, [
      { questionId: 'q-1', answer: 'Web' },
    ]);
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.pendingAnswers ?? false).toBe(false);
    expect(state.mode).not.toBe('awaiting-agent');
    expect(state.document).toContain('After answers');
  });

  test('keeps answers pending and blocks both implement forms until accepted state', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Answers pending spec',
      questions: [{ id: 'q-1', question: 'Platform?' }],
    });
    await harness.service.submitAnswers(interviewId, [
      { questionId: 'q-1', answer: 'Web' },
    ]);

    const pending = await harness.service.getInterviewState(interviewId);
    expect(pending.mode).toBe('awaiting-agent');
    expect(pending.mode).not.toBe('completed');

    for (const arguments_ of ['', pending.markdownPath]) {
      const output = { parts: [] as Array<{ type: string; text?: string }> };
      await harness.service.handleCommandExecuteBefore(
        {
          command: 'implement',
          sessionID: 'ses-submit',
          arguments: arguments_,
        },
        output,
      );
      expect(output.parts[0]?.text).toContain('awaiting incorporation');
    }

    await harness.service.submitState('ses-submit', {
      summary: 'Answers incorporated',
      patch: '@@ -1,1 +1,1 @@\n-Answers pending spec\n+Answers incorporated',
      questions: [],
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });
    const accepted = await harness.service.getInterviewState(interviewId);
    expect(accepted.mode).toBe('completed');
    const output = { parts: [] as Array<{ type: string; text?: string }> };
    await harness.service.handleCommandExecuteBefore(
      { command: 'implement', sessionID: 'ses-submit', arguments: '' },
      output,
    );
    expect(output.parts[0]?.text).toContain('Implement the markdown');
  });

  test('refuses completion while answers await incorporation', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Needs answer',
      questions: [{ id: 'q-1', question: 'Platform?' }],
    });
    await harness.service.submitAnswers(interviewId, [
      { questionId: 'q-1', answer: 'Web' },
    ]);
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });
    await expect(
      harness.service.handleNudgeAction(interviewId, 'confirm-complete'),
    ).rejects.toThrow('answers are awaiting incorporation');
    expect(
      (await harness.service.getInterviewState(interviewId)).document,
    ).not.toContain('status: complete');
  });

  test('clears pending answers when the answer continuation throws', async () => {
    const harness = await createHarness(undefined, true);
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Continuation failure',
      questions: [{ id: 'q-1', question: 'Platform?' }],
    });
    await expect(
      harness.service.submitAnswers(interviewId, [
        { questionId: 'q-1', answer: 'Web' },
      ]),
    ).rejects.toThrow('continuation failed');
    expect(
      (await harness.service.getInterviewState(interviewId)).mode,
    ).not.toBe('awaiting-agent');
  });

  test('does not persist answers until continuation succeeds, then retries once', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Retry answers',
      questions: [{ id: 'q-1', question: 'Platform?' }],
    });

    harness.failContinue.value = true;
    await expect(
      harness.service.submitAnswers(interviewId, [
        { questionId: 'q-1', answer: 'Web' },
      ]),
    ).rejects.toThrow('continuation failed');
    let document = (await harness.service.getInterviewState(interviewId))
      .document;
    expect(document).not.toContain('Q: Platform?');

    harness.failContinue.value = false;
    await harness.service.submitAnswers(interviewId, [
      { questionId: 'q-1', answer: 'Web' },
    ]);
    document = (await harness.service.getInterviewState(interviewId)).document;
    expect(document.match(/Q: Platform\?/g)).toHaveLength(1);
    expect(document.match(/A: Web/g)).toHaveLength(1);
  });

  test('filters answered questions from remembered error state', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Remembered questions',
      questions: [{ id: 'q-1', question: 'Platform?' }],
    });
    await harness.service.submitAnswers(interviewId, [
      { questionId: 'q-1', answer: 'Web' },
    ]);
    await harness.service.submitState('ses-submit', {
      summary: 'Broken follow-up',
      patch: '@@ -1,1 +1,1 @@\n-missing\n+bad',
      questions: [],
    });
    const state = await harness.service.getInterviewState(interviewId);
    expect(state.mode).toBe('error');
    expect(state.questions).toHaveLength(0);
  });

  test('a failed chat turn does not clear pending answers', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Pending chat',
      questions: [{ id: 'q-1', question: 'Platform?' }],
    });
    await harness.service.submitAnswers(interviewId, [
      { questionId: 'q-1', answer: 'Web' },
    ]);
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });
    harness.failContinue.value = true;
    await expect(
      harness.service.submitChat(interviewId, 'Follow up'),
    ).rejects.toThrow('continuation failed');
    expect((await harness.service.getInterviewState(interviewId)).mode).toBe(
      'awaiting-agent',
    );
  });
});

describe('completed interview service turns', () => {
  test('keeps pending answers when history append fails after sending', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Append failure spec',
      questions: [{ id: 'q-1', question: 'Platform?' }],
    });
    const documentPath = (await harness.service.getInterviewState(interviewId))
      .interview.markdownPath;
    await fs.chmod(documentPath, 0o444);
    try {
      await expect(
        harness.service.submitAnswers(interviewId, [
          { questionId: 'q-1', answer: 'Web' },
        ]),
      ).rejects.toThrow('saving them to the interview document failed');
    } finally {
      await fs.chmod(documentPath, 0o644);
    }

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.mode).toBe('awaiting-agent');
  });

  test('busy rejection preserves completion and implementation access', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Complete spec',
      questions: [],
    });
    await harness.service.handleNudgeAction(interviewId, 'confirm-complete');
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });

    await expect(
      harness.service.submitChat(interviewId, 'Too soon.'),
    ).rejects.toThrow('Interview session is busy');
    const state = await harness.service.getInterviewState(interviewId);
    expect(state.interview.completed).toBe(true);
    expect(state.document).toContain('status: complete');
    const output = { parts: [] as Array<{ type: string; text?: string }> };
    await harness.service.handleCommandExecuteBefore(
      { command: 'implement', sessionID: 'ses-submit', arguments: '' },
      output,
    );
    expect(output.parts[0]?.text).toContain('Implement the markdown');
  });

  test('a failed continuation restores completion', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Complete spec',
      questions: [],
    });
    await harness.service.handleNudgeAction(interviewId, 'confirm-complete');
    harness.failContinue.value = true;

    await expect(
      harness.service.submitChat(interviewId, 'Please revise.'),
    ).rejects.toThrow('continuation failed');
    const state = await harness.service.getInterviewState(interviewId);
    expect(state.interview.completed).toBe(true);
    expect(state.document).toContain('status: complete');
  });

  test('restore failure resets busy state and preserves the send error', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Restore failure spec',
      questions: [],
    });
    await harness.service.handleNudgeAction(interviewId, 'confirm-complete');
    const documentPath = (await harness.service.getInterviewState(interviewId))
      .interview.markdownPath;
    harness.failContinue.value = true;
    harness.continueHook = async () => {
      await fs.chmod(documentPath, 0o444);
    };

    try {
      await expect(
        harness.service.submitChat(interviewId, 'Trigger failure.'),
      ).rejects.toThrow('continuation failed');
    } finally {
      await fs.chmod(documentPath, 0o644);
    }
    expect((await harness.service.getInterviewState(interviewId)).isBusy).toBe(
      false,
    );
  });

  test('does not restore completion after an accepted state lands mid-send', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Mid-send spec',
      questions: [],
    });
    await harness.service.handleNudgeAction(interviewId, 'confirm-complete');
    harness.continueHook = async () => {
      await harness.service.submitState('ses-submit', {
        summary: 'Accepted mid-send',
        patch: '@@ -1,1 +1,1 @@\n-Mid-send spec\n+Accepted mid-send',
        questions: [],
      });
      throw new Error('transport failed');
    };

    await expect(
      harness.service.submitChat(interviewId, 'Race the send.'),
    ).rejects.toThrow('transport failed');
    const state = await harness.service.getInterviewState(interviewId);
    expect(state.interview.completed).toBe(false);
    expect(state.document).not.toContain('status: complete');
  });
});

describe('failed printState repairs', () => {
  test('queues repair for a tool patch with a cut-off trailing hunk', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Cutoff base',
      questions: [],
    });
    const result = await harness.service.submitState('ses-submit', {
      summary: 'Cutoff update',
      patch: '@@ -1,1 +1,1 @@\n-Cutoff base\n+Changed\n@@ -3,1 +3,1 @@',
      questions: [],
    });
    expect(result.ok).toBe(false);
    expect((await harness.service.getInterviewState(interviewId)).mode).toBe(
      'error',
    );
    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.continued).toHaveLength(1);
  });

  test('reports a failed printed patch on a user turn without repairing', async () => {
    const harness = await createHarness({ printState: true });
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'User patch base',
      questions: [],
    });
    await harness.service.notifyTurnStatus('ses-submit');
    harness.notifyCalls.length = 0;
    const continuedBefore = harness.continued.length;
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    harness.messages.push({
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: blockText(
            JSON.stringify({
              summary: 'User broken patch',
              patch: '@@ -1,1 +1,1 @@\n-missing\n+bad',
              questions: [],
            }),
          ),
        },
      ],
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });
    expect(
      harness.notifyCalls.filter((text) => text.includes('update failed')),
    ).toHaveLength(1);
    expect(harness.continued).toHaveLength(continuedBefore);
    expect(
      (await harness.service.getInterviewState(interviewId)).document,
    ).toContain('User patch base');
  });

  test('does not repeat a printed patch failure on an empty user turn', async () => {
    const harness = await createHarness({ printState: true });
    await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'User patch base',
      questions: [],
    });
    await harness.service.notifyTurnStatus('ses-submit');
    harness.notifyCalls.length = 0;
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    harness.messages.push({
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: blockText(
            JSON.stringify({
              summary: 'User broken patch',
              patch: '@@ -1,1 +1,1 @@\n-missing\n+bad',
              questions: [],
            }),
          ),
        },
      ],
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });
    expect(
      harness.notifyCalls.filter((text) => text.includes('update failed')),
    ).toHaveLength(1);
  });

  test('does not repeat a failed tool patch on an empty user turn', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Tool patch base',
      questions: [],
    });
    await harness.service.notifyTurnStatus('ses-submit');
    harness.notifyCalls.length = 0;
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    const failed = await harness.service.submitState('ses-submit', {
      summary: 'Tool broken patch',
      patch: '@@ -1,1 +1,1 @@\n-missing\n+bad',
      questions: [],
    });
    expect(failed.ok).toBe(false);
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });
    expect(
      harness.notifyCalls.filter((text) => text.includes('update failed')),
    ).toHaveLength(1);
  });

  test('reports a different failed patch on a later user turn', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Tool patch base',
      questions: [],
    });
    await harness.service.notifyTurnStatus('ses-submit');
    harness.notifyCalls.length = 0;
    for (const replacement of ['bad-one', 'bad-two']) {
      await harness.service.handleEvent({
        event: {
          type: 'session.status',
          properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
        },
      });
      await harness.service.submitState('ses-submit', {
        summary: `Tool broken ${replacement}`,
        patch: `@@ -1,1 +1,1 @@\n-missing\n+${replacement}`,
        questions: [],
      });
      await harness.service.handleEvent({
        event: {
          type: 'session.status',
          properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
        },
      });
    }
    expect(
      harness.notifyCalls.filter((text) => text.includes('update failed')),
    ).toHaveLength(2);
  });

  test('keeps a user turn without state silent', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    await harness.service.notifyTurnStatus('ses-submit');
    harness.notifyCalls.length = 0;
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });
    expect(harness.notifyCalls).toHaveLength(0);
  });

  test('stores printState patch failure and sends recovery chat prompt', async () => {
    const harness = await createHarness({ printState: true });
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Printed base',
      questions: [],
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    harness.messages.push({
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: blockText(
            JSON.stringify({
              summary: 'Broken printed patch',
              patch: '@@ -1,1 +1,1 @@\n-missing\n+broken',
              questions: [],
            }),
          ),
        },
      ],
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });
    const failed = await harness.service.getInterviewState(interviewId);
    expect(failed.lastParseError).toBe('The spec patch did not apply.');
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });
    await harness.service.submitChat(interviewId, 'Please recover.');
    expect(harness.continued.at(-1)).toContain('last spec patch failed');
  });

  test('keeps remembered questions after a printed patch failure', async () => {
    const harness = await createHarness({ printState: true });
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Question base',
      questions: [{ id: 'q-1', question: 'Platform?' }],
    });
    harness.messages.push({
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: blockText(
            JSON.stringify({
              summary: 'Broken printed state',
              patch: '@@ -1,1 +1,1 @@\n-missing\n+bad',
              questions: [{ id: 'q-1', question: 'Platform?' }],
            }),
          ),
        },
      ],
    });
    const state = await harness.service.getInterviewState(interviewId);
    expect(state.mode).toBe('error');
    expect(state.questions.map((question) => question.id)).toEqual(['q-1']);
  });

  test('posts a final failure notice when automatic repair cannot be sent', async () => {
    const harness = await createHarness(undefined, true);
    await startInterview(harness);
    harness.notifyCalls.length = 0;
    await harness.service.submitState('ses-submit', {
      summary: 'Broken',
      patch: '@@ -1,1 +1,1 @@\n-missing\n+broken',
      questions: [],
    });
    await harness.service.notifyTurnStatus('ses-submit');
    expect(
      harness.notifyCalls.some((text) =>
        text.includes('Interview update failed'),
      ),
    ).toBe(true);
  });

  test('applies a valid printed repair reply without a failure notice', async () => {
    const harness = await createHarness({ printState: true });
    const interviewId = await startInterview(harness);
    await harness.service.submitState('ses-submit', {
      summary: 'Repair base',
      questions: [],
    });
    await harness.service.submitState('ses-submit', {
      summary: 'Broken repair base',
      patch: '@@ -1,1 +1,1 @@\n-missing\n+bad',
      questions: [],
    });
    await harness.service.notifyTurnStatus('ses-submit');
    harness.messages.push({
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: blockText(
            JSON.stringify({
              summary: 'Repaired',
              patch: '@@ -1,1 +1,1 @@\n-Repair base\n+Repaired',
              questions: [],
            }),
          ),
        },
      ],
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });
    expect(
      harness.notifyCalls.some((text) => text.includes('update failed')),
    ).toBe(false);
    expect(
      (await harness.service.getInterviewState(interviewId)).document,
    ).toContain('Repaired');
  });

  test('does not report a repair failure on an idle duplicate before repair busy', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;
    await harness.service.submitState('ses-submit', {
      summary: 'Broken duplicate',
      patch: '@@ -1,1 +1,1 @@\n-missing\n+bad',
      questions: [],
    });
    await harness.service.notifyTurnStatus('ses-submit');
    await harness.service.handleEvent({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses-submit' },
      },
    });
    expect(
      harness.notifyCalls.some((text) => text.includes('update failed')),
    ).toBe(false);
  });

  test('does not start a second repair after a repair patch fails', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;
    await harness.service.submitState('ses-submit', {
      summary: 'Broken once',
      patch: '@@ -1,1 +1,1 @@\n-missing\n+bad',
      questions: [],
    });
    await harness.service.notifyTurnStatus('ses-submit');
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.submitState('ses-submit', {
      summary: 'Broken twice',
      patch: '@@ -1,1 +1,1 @@\n-missing-again\n+bad-again',
      questions: [],
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });
    expect(harness.continued).toHaveLength(1);
    expect(
      harness.notifyCalls.filter((text) => text.includes('update failed')),
    ).toHaveLength(1);
  });

  test('repair send failure does not notify again on a later empty user turn', async () => {
    const harness = await createHarness(undefined, true);
    await startInterview(harness);
    harness.notifyCalls.length = 0;
    await harness.service.submitState('ses-submit', {
      summary: 'Broken send',
      patch: '@@ -1,1 +1,1 @@\n-missing\n+bad',
      questions: [],
    });
    await harness.service.notifyTurnStatus('ses-submit');
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });
    expect(
      harness.notifyCalls.filter((text) => text.includes('update failed')),
    ).toHaveLength(1);
  });
});

describe('interview trailing assistant messages after a tool submit', () => {
  test('uses the remembered tool state when every later message has no block', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    // Turn 1: the model calls the tool from message M1 ...
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-tool' },
      parts: [{ type: 'text', text: '' }],
    });
    const result = await harness.service.submitState(
      'ses-submit',
      {
        summary: 'Tool spec',
        questions: [{ id: 'q-1', question: 'Platform?' }],
      },
      'msg-tool',
    );
    expect(result.ok).toBe(true);
    // ... then emits trailing prose M2 with no state block.
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-prose' },
      parts: [{ type: 'text', text: 'All set, please answer in the UI.' }],
    });
    // Turn end clears the same-turn tool precedence; the fallback must hold.
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.mode).toBe('awaiting-user');
    expect(state.lastParseError).toBeUndefined();
    expect(state.questions).toEqual([
      { id: 'q-1', question: 'Platform?', options: [], suggested: undefined },
    ]);

    await harness.service.submitAnswers(interviewId, [
      { questionId: 'q-1', answer: 'Web' },
    ]);
    expect(harness.continued).toHaveLength(1);
  });

  test('a prose mention of the opening tag does not mask the remembered state', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    harness.messages.push({
      info: { role: 'assistant', id: 'msg-tool' },
      parts: [{ type: 'text', text: '' }],
    });
    await harness.service.submitState(
      'ses-submit',
      {
        summary: 'Tool spec',
        questions: [{ id: 'q-1', question: 'Platform?' }],
      },
      'msg-tool',
    );
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-prose' },
      parts: [
        {
          type: 'text',
          text: 'I will not print an <interview_state> block this time.',
        },
      ],
    });

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.mode).toBe('awaiting-user');
    expect(state.lastParseError).toBeUndefined();
    expect(state.questions.map((question) => question.id)).toEqual(['q-1']);
  });

  test('reports a malformed trailing block instead of the remembered state', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    harness.messages.push({
      info: { role: 'assistant', id: 'msg-tool' },
      parts: [{ type: 'text', text: '' }],
    });
    await harness.service.submitState(
      'ses-submit',
      {
        summary: 'Tool spec',
        questions: [{ id: 'q-1', question: 'Platform?' }],
      },
      'msg-tool',
    );
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-prose' },
      parts: [{ type: 'text', text: blockText('{not valid json') }],
    });

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.mode).toBe('error');
    expect(state.lastParseError).toBe('Failed to parse interview state');
  });

  test('applies a valid newer block from a later turn', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    harness.messages.push({
      info: { role: 'assistant', id: 'msg-tool' },
      parts: [{ type: 'text', text: '' }],
    });
    await harness.service.submitState(
      'ses-submit',
      {
        summary: 'Tool spec',
        questions: [{ id: 'q-tool', question: 'Tool?' }],
      },
      'msg-tool',
    );

    // A later turn resets the same-turn tool precedence and prints a valid
    // block instead of calling the tool.
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-later' },
      parts: [
        {
          type: 'text',
          text: blockText(
            JSON.stringify({
              summary: 'Later text spec',
              patch: '@@ -1,1 +1,1 @@\n-Tool spec\n+Later text spec',
              questions: [{ id: 'q-later', question: 'Later?' }],
            }),
          ),
        },
      ],
    });

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.document).toContain('Later text spec');
    expect(state.questions.map((question) => question.id)).toEqual(['q-later']);
  });

  test('does not re-offer questions answered before a stateless follow-up turn', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    harness.messages.push({
      info: { role: 'assistant', id: 'msg-tool' },
      parts: [{ type: 'text', text: '' }],
    });
    await harness.service.submitState(
      'ses-submit',
      {
        summary: 'Tool spec',
        questions: [{ id: 'q-1', question: 'Platform?' }],
      },
      'msg-tool',
    );
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-prose' },
      parts: [{ type: 'text', text: 'Answer in the UI.' }],
    });
    await harness.service.submitAnswers(interviewId, [
      { questionId: 'q-1', answer: 'Web' },
    ]);

    // The follow-up turn produces only prose, no new state.
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-followup' },
      parts: [{ type: 'text', text: 'No further questions.' }],
    });

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.questions).toHaveLength(0);
    expect(state.lastParseError).toBeUndefined();
  });
});
