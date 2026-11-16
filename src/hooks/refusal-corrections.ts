import { formatSystemReminder } from '../config/constants';
import {
  appendTrailingVolatileMessage,
  stripTaggedContent,
} from './cache-safe-injection';
import { BACKGROUND_JOB_BOARD_METADATA_KEY } from './volatile-message';

export const REFUSAL_CORRECTION_METADATA_KEY =
  'oh-my-opencode-slim.refusalContinuation';

export function formatRefusalCorrectionText(
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
  sessionID: string,
  agent: string,
  corrections: Array<{ taskID: string; model: string }>,
): void {
  stripTaggedContent(messages, REFUSAL_CORRECTION_METADATA_KEY);
  if (!corrections.length) return;
  appendTrailingVolatileMessage(
    messages,
    { role: 'user', agent, sessionID, id: `refusal-correction-${sessionID}` },
    {
      text: formatRefusalCorrectionText(corrections),
      metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
      extraMetadata: { [REFUSAL_CORRECTION_METADATA_KEY]: true },
    },
  );
}
