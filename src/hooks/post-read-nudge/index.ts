import { POST_READ_NUDGE_TEXT, READ_TOOLS } from "../../config/constants";

/**
 * Post-Read nudge - appends a delegation reminder after file reads.
 * Catches the "read files → implement myself" anti-pattern.
 */

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

export function createPostReadNudgeHook() {
  return {
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput
    ): Promise<void> => {
      // Only nudge for Read tool
      if (!READ_TOOLS.includes(input.tool)) {
        return;
      }

      // Append the nudge
      output.output = output.output + POST_READ_NUDGE_TEXT;
    },
  };
}
