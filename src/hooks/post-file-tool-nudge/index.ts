/**
 * Post-tool nudge - appends a delegation reminder after file reads/writes.
 * Catches the "inspect/edit files → implement myself" anti-pattern.
 */

import { PHASE_REMINDER_TEXT } from '../../config/constants';

const NUDGE = `\n\n---\n${PHASE_REMINDER_TEXT}`;

interface ToolExecuteAfterInput {
  tool: string;
  sessionID?: string;
  callID?: string;
}

interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
}

export function createPostFileToolNudgeHook() {
  return {
    'tool.execute.after': async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      // Only nudge for Read/Write tools
      if (
        input.tool !== 'Read' &&
        input.tool !== 'read' &&
        input.tool !== 'Write' &&
        input.tool !== 'write'
      ) {
        return;
      }

      // Append the nudge
      output.output = output.output + NUDGE;
    },
  };
}
