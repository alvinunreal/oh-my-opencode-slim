import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PANE_VIEWER_ENV } from '../multiplexer/shared';
import { flushLoggerForTesting, resetLogger } from '../utils/logger';
import { createTimerHarness } from '../utils/test-timers';
import { registerQuestionTimeout } from './question-timeout-tui';

let logDirectory: string;
let previousLogDirectory: string | undefined;
beforeEach(() => {
  logDirectory = mkdtempSync(join(tmpdir(), 'question-timeout-log-'));
  previousLogDirectory = process.env.OPENCODE_LOG_DIR;
  resetLogger();
  process.env.OPENCODE_LOG_DIR = logDirectory;
});
afterEach(async () => {
  await flushLoggerForTesting();
  resetLogger();
  if (previousLogDirectory === undefined) delete process.env.OPENCODE_LOG_DIR;
  else process.env.OPENCODE_LOG_DIR = previousLogDirectory;
  rmSync(logDirectory, { recursive: true, force: true });
});

function setup(env: Record<string, string | undefined> = {}) {
  const timers = createTimerHarness();
  const listeners = new Map<string, (event: { data: unknown }) => void>();
  const reply = mock(async (_args: unknown) => {});
  const ctx = {
    data: {
      on: (type: string, listener: (event: { data: unknown }) => void) => {
        listeners.set(type, listener);
        return () => {
          listeners.delete(type);
        };
      },
      session: { form: { reply } },
    },
  };
  const dispose = registerQuestionTimeout(ctx, {
    timeoutMs: 60_000,
    timers,
    env,
  });
  const emit = (type: string, data: unknown) => listeners.get(type)?.({ data });
  return { timers, listeners, reply, dispose, emit };
}

const form = {
  id: 'frm_1',
  sessionID: 'ses_1',
  metadata: { kind: 'question' },
  fields: [
    { key: 'q0', type: 'string', custom: true },
    { key: 'q1', type: 'multiselect', custom: true },
  ],
};

test('v2 replies using exact field keys and multiselect arrays', async () => {
  // Mutation: use field titles or flatten multiselects.
  const h = setup();
  h.emit('form.created', { form });
  await h.timers.advance(60_000);
  const text =
    'No user response within 1 minute; decide yourself and continue.';
  expect(h.reply).toHaveBeenCalledWith({
    sessionID: 'ses_1',
    formID: 'frm_1',
    answer: { q0: text, q1: [text] },
  });
  h.dispose?.();
});

test('v2 leaves unrelated, global and closed forms unanswered', async () => {
  // Mutation: remove the metadata kind, global session, or custom field guard.
  const h = setup();
  h.emit('form.created', {
    form: { ...form, metadata: { kind: 'websearch.provider' } },
  });
  h.emit('form.created', {
    form: { ...form, id: 'frm_2', sessionID: 'global' },
  });
  h.emit('form.created', {
    form: {
      ...form,
      id: 'frm_3',
      fields: [{ key: 'q0', type: 'string', custom: false }],
    },
  });
  await h.timers.advance(60_000);
  expect(h.reply).not.toHaveBeenCalled();
  h.dispose?.();
});

test('v2 does not auto-answer non-text question fields', async () => {
  // Mutation: allow unsupported field types.
  const h = setup();
  h.emit('form.created', {
    form: { ...form, fields: [{ key: 'q0', type: 'number', custom: true }] },
  });
  await h.timers.advance(60_000);
  expect(h.reply).not.toHaveBeenCalled();
  h.dispose?.();
});

test('v2 replies cancel the timer', async () => {
  // Mutation: omit the form.replied subscription.
  const h = setup();
  h.emit('form.created', { form });
  h.emit('form.replied', { id: 'frm_1', sessionID: 'ses_1' });
  await h.timers.advance(60_000);
  expect(h.reply).not.toHaveBeenCalled();
  expect(h.timers.pending()).toBe(0);
  h.dispose?.();
});

test('v2 cancellations cancel the timer', async () => {
  // Mutation: omit the form.cancelled subscription.
  const h = setup();
  h.emit('form.created', { form });
  h.emit('form.cancelled', { id: 'frm_1', sessionID: 'ses_1' });
  await h.timers.advance(60_000);
  expect(h.reply).not.toHaveBeenCalled();
  expect(h.timers.pending()).toBe(0);
  h.dispose?.();
});

test('v2 session deletion cancels the timer', async () => {
  // Mutation: omit the session.deleted subscription.
  const h = setup();
  h.emit('form.created', { form });
  h.emit('session.deleted', { sessionID: 'ses_1' });
  await h.timers.advance(60_000);
  expect(h.reply).not.toHaveBeenCalled();
  expect(h.timers.pending()).toBe(0);
  h.dispose?.();
});

test('v2 disposal removes listeners and cancels timers', async () => {
  // Mutation: leak subscriptions or timer on dispose.
  const h = setup();
  h.emit('form.created', { form });
  h.dispose?.();
  expect(h.listeners.size).toBe(0);
  await h.timers.advance(60_000);
  expect(h.reply).not.toHaveBeenCalled();
  expect(h.timers.pending()).toBe(0);
});

test('pane viewers never subscribe', () => {
  // Mutation: remove the pane-viewer guard.
  const h = setup({ [PANE_VIEWER_ENV]: '1' });
  expect(h.listeners.size).toBe(0);
  expect(h.dispose).toBeUndefined();
});

test('v2 logs benign reply failures without multiplexer initialization', async () => {
  // Mutation: never initialize the TUI logger for question timeouts.
  const h = setup();
  h.reply.mockImplementation(async () => {
    throw new Error('already settled');
  });
  h.emit('form.created', { form });
  await h.timers.advance(60_000);
  await flushLoggerForTesting();
  const logs = readdirSync(logDirectory)
    .map((name) => readFileSync(join(logDirectory, name), 'utf8'))
    .join('\n');
  expect(logs).toContain(
    '[question-timeout] reply failed (possibly already settled)',
  );
  h.dispose?.();
});
