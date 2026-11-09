import { expect, mock, test } from 'bun:test';
import { createTimerHarness } from '../../utils/test-timers';
import { createQuestionTimeoutHook } from './index';

function setup(hostFlavor?: string, timeoutMs = 60_000) {
  const timers = createTimerHarness();
  const reply = mock(async (_args: unknown) => ({ data: true }));
  const hook = createQuestionTimeoutHook({
    ctx: { directory: '/test', client: { question: { reply } } } as never,
    timeoutMs,
    hostFlavor,
    timers,
  });
  return { hook, timers, reply };
}

test('v1 answers every free-text question in native two-dimensional shape', async () => {
  // Mutation: send a wrong request ID or flatten the native answer.
  const { hook, timers, reply } = setup();
  hook?.event({
    type: 'question.asked',
    properties: { id: 'q1', sessionID: 's1', questions: [{}, {}] },
  });
  await timers.advance(60_000);
  const text =
    'No user response within 1 minute; decide yourself and continue.';
  expect(reply).toHaveBeenCalledWith({
    requestID: 'q1',
    directory: '/test',
    answers: [[text], [text]],
  });
});

test('v1 never auto-answers a question with custom false', async () => {
  // Mutation: remove the plan_exit eligibility filter.
  const { hook, timers, reply } = setup();
  hook?.event({
    type: 'question.asked',
    properties: {
      id: 'q1',
      sessionID: 's1',
      questions: [{}, { custom: false }],
    },
  });
  await timers.advance(60_000);
  expect(reply).not.toHaveBeenCalled();
});

test('v1 resolution events cancel by requestID', async () => {
  // Mutation: read properties.id rather than properties.requestID.
  const { hook, timers, reply } = setup();
  hook?.event({
    type: 'question.asked',
    properties: { id: 'q1', sessionID: 's1', questions: [{}] },
  });
  hook?.event({
    type: 'question.asked',
    properties: { id: 'q2', sessionID: 's1', questions: [{}] },
  });
  hook?.event({
    type: 'question.replied',
    properties: { requestID: 'q1', sessionID: 's1' },
  });
  hook?.event({
    type: 'question.rejected',
    properties: { requestID: 'q2', sessionID: 's1' },
  });
  await timers.advance(60_000);
  expect(reply).not.toHaveBeenCalled();
  expect(timers.pending()).toBe(0);
});

test('v1 session deletion cancels timers using info.id', async () => {
  // Mutation: ignore the host's session.deleted info.id shape.
  const { hook, timers, reply } = setup();
  hook?.event({
    type: 'question.asked',
    properties: { id: 'q1', sessionID: 's1', questions: [{}] },
  });
  hook?.event({ type: 'session.deleted', properties: { info: { id: 's1' } } });
  await timers.advance(60_000);
  expect(reply).not.toHaveBeenCalled();
  expect(timers.pending()).toBe(0);
});

test('disabled or v2 hosts do not create a v1 owner', () => {
  // Mutation: enable by default or create two owners on v2.
  expect(createQuestionTimeoutHook({ ctx: {} as never })).toBeUndefined();
  expect(setup(undefined, 0).hook).toBeUndefined();
  expect(setup('v2').hook).toBeUndefined();
});

test('aborted v1 turns retain the question timer until it replies', async () => {
  // Mutation: cancel the session timer on MessageAbortedError.
  const { hook, timers, reply } = setup();
  hook?.event({
    type: 'question.asked',
    properties: { id: 'q1', sessionID: 's1', questions: [{}] },
  });
  const abortEvent = {
    type: 'session.error',
    properties: { sessionID: 's1', error: { name: 'MessageAbortedError' } },
  };
  hook?.event(abortEvent);
  await timers.advance(60_000);
  expect(reply).toHaveBeenCalledTimes(1);
  expect(reply).toHaveBeenCalledWith({
    requestID: 'q1',
    directory: '/test',
    answers: [
      ['No user response within 1 minute; decide yourself and continue.'],
    ],
  });
});
