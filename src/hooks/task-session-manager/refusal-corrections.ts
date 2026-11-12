/**
 * Refusal-correction injection helpers plus the shared board metadata key.
 *
 * Split out of ./board-injection.ts as a dependency-light leaf so callers
 * that must stay out of the board/persistence graph (deepwork-goal,
 * src/v2/setup.ts) can import the key and the corrections without pulling
 * the whole terminal-observation subsystem. Behavior-preserving move: the
 * functions are byte-for-byte identical and re-exported from
 * ./board-injection.ts for existing callers/tests.
 *
 * All injection logic goes through the cache-safe helpers in
 * ../cache-safe-injection.ts so prompt cache safety holds.
 */
import { formatSystemReminder } from '../../config/constants';
import {
  appendTrailingVolatileMessage,
  isTaggedPart,
  stripTaggedContent,
} from '../cache-safe-injection';
import type { MessageWithParts } from '../types';
import { isMessageWithParts, isUserMessageWithParts } from '../types';

export const BACKGROUND_JOB_BOARD_METADATA_KEY =
  'oh-my-opencode-slim.backgroundJobBoard';

const REFUSAL_CORRECTION_METADATA_KEY =
  'oh-my-opencode-slim.refusalContinuation';

function formatRefusalCorrectionText(
  corrections: Array<{ taskID: string; model: string }>,
): string {
  return formatSystemReminder(
    [
      '### Child task — Continuing after fallback',
      ...corrections.map(
        ({ taskID, model }) =>
          `- ${taskID}: the previous error is superseded; the child continues on ${model}.`,
      ),
      'Do not relaunch, cancel, or replace these tasks; their results will arrive.',
    ].join('\n'),
  );
}

export function appendRefusalCorrections(
  messages: unknown[],
  corrections: Array<{ taskID: string; model: string }>,
): void {
  stripTaggedContent(messages, REFUSAL_CORRECTION_METADATA_KEY);
  if (corrections.length === 0) return;
  const anchor = findTriggeringUserMessage(
    messages,
    BACKGROUND_JOB_BOARD_METADATA_KEY,
  );
  if (!anchor) return;
  const unique = new Map(corrections.map((item) => [item.taskID, item]));
  appendTrailingVolatileMessage(
    messages,
    { ...anchor.info, id: `${anchor.info.id ?? 'board'}-refusal-correction` },
    {
      text: formatRefusalCorrectionText([...unique.values()]),
      metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
      extraMetadata: { [REFUSAL_CORRECTION_METADATA_KEY]: true },
    },
  );
}

/**
 * The most recent real (non-board) user message that carries a text part —
 * used only to validate injection eligibility and derive session/text context.
 * Tool-result-only user turns (no text part) are skipped so a long tool loop
 * still resolves the triggering managed turn. Board placement targets the
 * tail (see injectBackgroundJobBoard).
 */
export function findTriggeringUserMessage(
  messages: unknown[],
  metadataKey: string,
): MessageWithParts | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isMessageWithParts(message)) continue;
    if (
      message.parts.length > 0 &&
      message.parts.every((part) => isTaggedPart(part, metadataKey))
    ) {
      continue;
    }
    if (!isUserMessageWithParts(message)) continue;
    const hasText = message.parts.some(
      (part) => part.type === 'text' && typeof part.text === 'string',
    );
    if (!hasText) continue;
    return message;
  }
  return undefined;
}
