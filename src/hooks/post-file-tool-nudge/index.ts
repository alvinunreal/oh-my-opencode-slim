/**
 * Post-tool nudge - queues a delegation reminder after file reads/writes.
 * Catches the "inspect/edit files → implement myself" anti-pattern.
 */

import { PHASE_REMINDER } from '../../config/constants';

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

    if (output.output.includes(PHASE_REMINDER)) {
      return;
    }

    output.output = `${output.output}\n\n${PHASE_REMINDER}`;
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
