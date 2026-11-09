import { expect, mock, test } from 'bun:test';
import { autoAnswerText } from '../hooks/question-timeout/core';
import { PANE_VIEWER_ENV } from '../multiplexer/shared';
import { createTimerHarness } from '../utils/test-timers';
import { registerQuestionTimeout } from './question-timeout-tui';

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
  const text = autoAnswerText(60_000);
  expect(h.reply).toHaveBeenCalledWith({
    sessionID: 'ses_1',
    formID: 'frm_1',
    answer: { q0: text.full, q1: [text.short] },
  });
  h.dispose?.();
});

test('v2 leaves unrelated, global and closed forms unanswered', async () => {
  // Mutation: remove a form eligibility guard.
  const h = setup();
  h.emit('form.created', { form: { ...form, metadata: undefined } });
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

test('v2 replies, cancellations and session deletion cancel their timers', async () => {
  // Mutation: omit any host resolution subscription.
  const h = setup();
  h.emit('form.created', { form });
  h.emit('form.created', { form: { ...form, id: 'frm_2' } });
  h.emit('form.created', { form: { ...form, id: 'frm_3' } });
  h.emit('form.replied', { id: 'frm_1', sessionID: 'ses_1' });
  h.emit('form.cancelled', { id: 'frm_2', sessionID: 'ses_1' });
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
