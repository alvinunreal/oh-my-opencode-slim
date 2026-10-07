import { describe, expect, test } from 'bun:test';
import type { InterviewAssistantState } from '../interview/types';
import {
  createInterviewSubmitStateTool,
  type InterviewSubmitStateService,
} from './interview-submit-state';

function createService(overrides?: {
  activeInterviewId?: string | null;
  result?: { ok: boolean; message: string };
}): {
  service: InterviewSubmitStateService;
  submissions: Array<{ sessionID: string; state: InterviewAssistantState }>;
} {
  const submissions: Array<{
    sessionID: string;
    state: InterviewAssistantState;
  }> = [];
  const service: InterviewSubmitStateService = {
    getActiveInterviewId: () =>
      'activeInterviewId' in (overrides ?? {})
        ? (overrides?.activeInterviewId ?? null)
        : 'interview-1',
    submitState: async (sessionID, state) => {
      submissions.push({ sessionID, state });
      return (
        overrides?.result ?? {
          ok: true,
          message: 'Interview state applied (1 question).',
        }
      );
    },
  };
  return { service, submissions };
}

describe('interview_submit_state tool', () => {
  test('submits a kickoff state and returns the service acknowledgement', async () => {
    const { service, submissions } = createService();
    const submit = createInterviewSubmitStateTool({
      service: () => service,
    }).interview_submit_state;

    const output = await submit.execute(
      {
        state: {
          title: 'my-app',
          summary: '# My app\n\n## Current spec\n\nDraft.',
          questions: [
            {
              id: 'q-1',
              question: 'Platform?',
              options: ['Web'],
              suggested: 'Web',
            },
          ],
        },
      },
      { sessionID: 'ses-1' } as never,
    );

    expect(output).toBe('Interview state applied (1 question).');
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.sessionID).toBe('ses-1');
    expect(submissions[0]?.state.summary).toContain('# My app');
    expect(submissions[0]?.state.title).toBe('my-app');
    // SEC-001: no path is ever taken from tool args.
    expect(JSON.stringify(submissions[0]?.state)).not.toContain('path');
  });

  test('submits a patch turn', async () => {
    const { service, submissions } = createService();
    const submit = createInterviewSubmitStateTool({
      service: () => service,
    }).interview_submit_state;

    const patch = [
      '--- a/spec',
      '+++ b/spec',
      '@@ -1,1 +1,1 @@',
      '-old line',
      '+new line',
    ].join('\n');

    await submit.execute(
      {
        state: {
          summary: 'Updated section 1',
          patch,
          questions: [],
        },
      },
      { sessionID: 'ses-2' } as never,
    );

    expect(submissions[0]?.state.patch).toBe(patch);
    expect(submissions[0]?.state.questions).toEqual([]);
  });

  test('returns the service rejection line when the patch fails', async () => {
    const { service } = createService({
      result: {
        ok: false,
        message:
          '⎔ Interview state rejected: Interview spec patch did not apply',
      },
    });
    const submit = createInterviewSubmitStateTool({
      service: () => service,
    }).interview_submit_state;

    const output = await submit.execute(
      { state: { summary: 'Broken', patch: '@@ bad', questions: [] } },
      { sessionID: 'ses-3' } as never,
    );

    expect(String(output)).toBe(
      '⎔ Interview state rejected: Interview spec patch did not apply',
    );
  });

  test('rejects calls from a session with no active interview', async () => {
    const { service, submissions } = createService({
      activeInterviewId: null,
    });
    const submit = createInterviewSubmitStateTool({
      service: () => service,
    }).interview_submit_state;

    const output = await submit.execute(
      { state: { summary: 'Nothing', questions: [] } },
      { sessionID: 'ses-4' } as never,
    );

    expect(String(output)).toContain('⎔ Interview state rejected');
    expect(String(output)).toContain('no active interview');
    expect(submissions).toHaveLength(0);
  });

  test('caps questions at the configured maxQuestions', () => {
    const { service } = createService();
    const submit = createInterviewSubmitStateTool({
      service: () => service,
      maxQuestions: 2,
    }).interview_submit_state;

    const questions = submit.args.state.safeParse({
      summary: 'x',
      questions: [
        { id: 'q-1', question: 'a' },
        { id: 'q-2', question: 'b' },
        { id: 'q-3', question: 'c' },
      ],
    });
    expect(questions.success).toBe(false);
  });
});
