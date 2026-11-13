import { expect, mock, test } from 'bun:test';
import { createTimerHarness } from '../../utils/test-timers';
import { autoAnswerText, createQuestionTimeout } from './core';

test('replies once at the deadline with the configured minutes', async () => {
  // Mutation: change the delay or hardcode the minutes.
  const timers = createTimerHarness();
  const reply = mock(async () => {});
  const core = createQuestionTimeout({
    timeoutMs: 1_200_000,
    reply,
    ...timers,
  });
  core.asked('q1', 's1', 'payload');
  await timers.advance(1_199_999);
  expect(reply).not.toHaveBeenCalled();
  await timers.advance(1);
  expect(reply).toHaveBeenCalledTimes(1);
  expect(autoAnswerText(1_200_000)).toBe(
    'No user response within 20 minutes; decide yourself and continue.',
  );
});

test('settlement cancels the timer', async () => {
  // Mutation: omit clearTimeout or keep the settled request ID in the map.
  const timers = createTimerHarness();
  const reply = mock(async () => {});
  const core = createQuestionTimeout({ timeoutMs: 60_000, reply, ...timers });
  core.asked('q1', 's1', 'payload');
  core.settled('q1');
  await timers.advance(60_000);
  expect(reply).not.toHaveBeenCalled();
  expect(timers.pending()).toBe(0);
  core.asked('q1', 's1', 'replacement');
  await timers.advance(60_000);
  expect(reply).toHaveBeenCalledTimes(1);
});

test('duplicate asks do not reset the deadline or send twice', async () => {
  // Mutation: remove the idempotency guard.
  const timers = createTimerHarness();
  const reply = mock(async () => {});
  const core = createQuestionTimeout({ timeoutMs: 60_000, reply, ...timers });
  core.asked('q1', 's1', 'payload');
  await timers.advance(30_000);
  core.asked('q1', 's1', 'payload');
  await timers.advance(30_000);
  expect(reply).toHaveBeenCalledTimes(1);
  await timers.advance(60_000);
  expect(reply).toHaveBeenCalledTimes(1);
});

test('deleting a session cancels only its questions', async () => {
  // Mutation: clear all sessions or compare the wrong key.
  const timers = createTimerHarness();
  const reply = mock(
    async (_id: string, _session: string, _payload: string) => {},
  );
  const core = createQuestionTimeout({ timeoutMs: 60_000, reply, ...timers });
  core.asked('q1', 's1', 'a');
  core.asked('q2', 's2', 'b');
  core.sessionGone('s1');
  await timers.advance(60_000);
  expect(reply).toHaveBeenCalledTimes(1);
  expect(reply).toHaveBeenCalledWith('q2', 's2', 'b');
});

test('disposal cancels every timer', async () => {
  // Mutation: make dispose a no-op.
  const timers = createTimerHarness();
  const reply = mock(async () => {});
  const core = createQuestionTimeout({ timeoutMs: 60_000, reply, ...timers });
  core.asked('q1', 's1', 'a');
  core.asked('q2', 's2', 'b');
  core.dispose();
  await timers.advance(60_000);
  expect(reply).not.toHaveBeenCalled();
  expect(timers.pending()).toBe(0);
});

test('questions asked after disposal do not arm a timer', async () => {
  // Mutation: remove the disposed guard in asked.
  const timers = createTimerHarness();
  const reply = mock(async () => {});
  const core = createQuestionTimeout({ timeoutMs: 60_000, reply, ...timers });
  core.dispose();
  core.asked('q1', 's1', 'a');
  expect(timers.pending()).toBe(0);
  await timers.advance(60_000);
  expect(reply).not.toHaveBeenCalled();
});

test('a failed reply is benign and never retried', async () => {
  // Mutation: rearm after reply failure.
  const timers = createTimerHarness();
  const reply = mock(async () => {
    throw new Error('already settled');
  });
  const log = mock(() => {});
  const core = createQuestionTimeout({
    timeoutMs: 60_000,
    reply,
    log,
    ...timers,
  });
  core.asked('q1', 's1', 'a');
  await timers.advance(60_000);
  await timers.advance(60_000);
  expect(reply).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalled();
  expect(timers.pending()).toBe(0);
});

test('a successful reply is logged as sent rather than answered', async () => {
  // Mutation: report the request as auto-answered when the host may have ignored it.
  const timers = createTimerHarness();
  const log = mock(() => {});
  const core = createQuestionTimeout({
    timeoutMs: 60_000,
    reply: async () => {},
    log,
    ...timers,
  });
  core.asked('q1', 's1', 'a');
  await timers.advance(60_000);
  expect(log).toHaveBeenCalledWith('[question-timeout] reply sent', {
    requestID: 'q1',
    sessionID: 's1',
  });
});
