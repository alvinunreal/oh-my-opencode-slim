/**
 * Post-tool nudge - queues a delegation reminder after file reads/writes.
 * Catches the "inspect/edit files → implement myself" anti-pattern.
 */

import { PHASE_REMINDER_TEXT } from '../../config/constants';

interface ToolExecuteAfterInput {
  tool: string;
  sessionID?: string;
  callID?: string;
}

interface ToolExecuteAfterOutput {
  output?: unknown;
}

interface PostFileToolNudgeOptions {
  shouldInject?: (sessionID: string) => boolean;
}

const FILE_TOOLS = new Set(['Read', 'read', 'Write', 'write']);

export function createPostFileToolNudgeHook(
  options: PostFileToolNudgeOptions = {},
) {
  function appendReminder(output: ToolExecuteAfterOutput): void {
    if (typeof output.output !== 'string') {
      return;
    }

    if (output.output.includes(PHASE_REMINDER_TEXT)) {
      return;
    }

    output.output = [
      output.output,
      '',
      '<internal_reminder>',
      PHASE_REMINDER_TEXT,
      '</internal_reminder>',
    ].join('\n');
  }

  return {
    'tool.execute.after': async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      if (!FILE_TOOLS.has(input.tool) || !input.sessionID) {
        return;
      }

      if (options.shouldInject && !options.shouldInject(input.sessionID)) {
        return;
      }

      appendReminder(output);
    },
  };
}
