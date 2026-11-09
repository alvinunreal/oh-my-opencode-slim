import type { PluginInput } from '@opencode-ai/plugin';
import { log } from '../../utils/logger';
import { getClient } from '../../utils/opencode-client';
import {
  assertHostReplyResult,
  replyV1Question,
} from '../../utils/question-reply';
import { withTimeout } from '../../utils/session';
import type { TimerSeamOptions } from '../../utils/timer-seam';
import { autoAnswerText, createQuestionTimeout } from './core';

export function createQuestionTimeoutHook(options: {
  ctx: PluginInput;
  timeoutMs?: number;
  hostFlavor?: string;
  isDisposed?: () => boolean;
  timers?: TimerSeamOptions;
}) {
  const timeoutMs = options.timeoutMs ?? 0;
  if (options.hostFlavor === 'v2' || timeoutMs <= 0) return undefined;
  const core = createQuestionTimeout<number>({
    timeoutMs,
    ...options.timers,
    log,
    reply: async (requestID, _sessionID, count) => {
      if (options.isDisposed?.()) return;
      const text = autoAnswerText(timeoutMs);
      const answers = Array.from({ length: count }, () => [text]);
      const client = getClient(options.ctx) as unknown as Parameters<
        typeof replyV1Question
      >[0];
      const result = await withTimeout(
        replyV1Question(client, {
          requestID,
          directory: options.ctx.directory,
          answers,
        }),
        10_000,
        'Question timeout reply timed out',
      );
      assertHostReplyResult(result, `Question reply ${requestID}`);
    },
  });

  function event(event: {
    type: string;
    properties?: {
      id?: string;
      requestID?: string;
      sessionID?: string;
      questions?: unknown;
      info?: { id?: string };
    };
  }): void {
    const props = event.properties;
    if (event.type === 'question.asked' || event.type === 'question.v2.asked') {
      const questions = props?.questions;
      if (
        !props?.id ||
        !props.sessionID ||
        !Array.isArray(questions) ||
        questions.length === 0 ||
        !questions.every(
          (question) =>
            question &&
            typeof question === 'object' &&
            question.custom !== false,
        )
      )
        return;
      core.asked(props.id, props.sessionID, questions.length);
    } else if (
      [
        'question.replied',
        'question.rejected',
        'question.v2.replied',
        'question.v2.rejected',
      ].includes(event.type)
    ) {
      if (props?.requestID) core.settled(props.requestID);
    } else if (event.type === 'session.deleted') {
      const sessionID = props?.info?.id ?? props?.sessionID;
      if (sessionID) core.sessionGone(sessionID);
    } else if (event.type === 'server.instance.disposed') {
      core.dispose();
    }
  }
  return { event, dispose: core.dispose };
}
