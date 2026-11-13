import {
  autoAnswerText,
  createQuestionTimeout,
} from '../hooks/question-timeout/core';
import { PANE_VIEWER_ENV } from '../multiplexer/shared';
import { isRecord } from '../utils/guards';
import { initLogger, log } from '../utils/logger';
import { assertHostReplyResult, toFormAnswer } from '../utils/question-reply';
import type { TimerSeamOptions } from '../utils/timer-seam';

type Form = {
  id: string;
  sessionID: string;
  fields: Array<{ key: string; type: 'string' | 'multiselect' }>;
};
type Context = {
  data?: {
    on?: (
      type: string,
      handler: (event: { data: unknown }) => void,
    ) => () => void;
    session?: {
      form?: {
        reply?: (input: {
          sessionID: string;
          formID: string;
          answer: Record<string, string | number | boolean | string[]>;
        }) => Promise<unknown>;
      };
    };
  };
};

export function registerQuestionTimeout(
  ctx: Context,
  options: {
    timeoutMs: number;
    timers?: TimerSeamOptions;
    env?: Record<string, string | undefined>;
  },
): (() => void) | undefined {
  if (
    options.timeoutMs <= 0 ||
    (options.env ?? process.env)[PANE_VIEWER_ENV] === '1'
  )
    return;
  initLogger('tui');
  const data = ctx.data;
  if (
    typeof data?.on !== 'function' ||
    typeof data.session?.form?.reply !== 'function'
  ) {
    log('[question-timeout] v2 form API unavailable');
    return;
  }
  const on = data.on.bind(data);
  const reply = data.session.form.reply.bind(data.session.form);
  const core = createQuestionTimeout<Form>({
    timeoutMs: options.timeoutMs,
    ...options.timers,
    log,
    reply: async (formID, sessionID, form) => {
      const text = autoAnswerText(options.timeoutMs);
      const answers = form.fields.map(() => [text]);
      const answer = toFormAnswer(
        answers,
        form.fields.map((field) => ({
          key: field.key,
          multiple: field.type === 'multiselect',
        })),
      );
      const result = await reply({
        sessionID,
        formID,
        answer,
      });
      assertHostReplyResult(result, `Form reply ${formID}`);
    },
  });
  const disposers = [
    on('form.created', ({ data: payload }) => {
      const form = isRecord(payload) ? payload.form : undefined;
      if (
        !isRecord(form) ||
        typeof form.id !== 'string' ||
        typeof form.sessionID !== 'string' ||
        form.sessionID === 'global' ||
        !isRecord(form.metadata) ||
        form.metadata.kind !== 'question' ||
        !Array.isArray(form.fields) ||
        form.fields.length === 0 ||
        !form.fields.every(
          (field) =>
            isRecord(field) &&
            typeof field.key === 'string' &&
            (field.type === 'string' || field.type === 'multiselect') &&
            field.custom === true,
        )
      )
        return;
      core.asked(form.id, form.sessionID, form as Form);
    }),
    ...['form.replied', 'form.cancelled'].map((type) =>
      on(type, ({ data: payload }) => {
        if (isRecord(payload) && typeof payload.id === 'string')
          core.settled(payload.id);
      }),
    ),
    on('session.deleted', ({ data: payload }) => {
      if (isRecord(payload) && typeof payload.sessionID === 'string')
        core.sessionGone(payload.sessionID);
    }),
  ];
  return () => {
    core.dispose();
    for (const dispose of disposers) dispose();
  };
}
