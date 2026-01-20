import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { ralphLoopCommand } from "./templates/ralph-loop";
import { ralphCancelCommand } from "./templates/ralph-cancel";

export function createRalphLoopTools(ctx: any): Record<string, ToolDefinition> {
  return {
    ralph_loop: tool({
      description: "Start autonomous iteration loop until task completion",
      args: {
        task: tool.schema.string().describe("Task description in natural language"),
        completion_promise: tool.schema.string().optional().describe("Custom completion tag (default: DONE)"),
        max_iterations: tool.schema.number().optional().describe("Maximum iterations before auto-stop (default: 100)"),
      },
      async execute(args, _context) {
        await ralphLoopCommand(ctx, {
          task: args.task as string,
          "completion-promise": args.completion_promise as string | undefined,
          "max-iterations": args.max_iterations as number | undefined,
        });
        return "Ralph loop started successfully";
      },
    }),
    ralph_cancel: tool({
      description: "Cancel the currently active ralph-loop",
      args: {},
      async execute(_args, _context) {
        await ralphCancelCommand(ctx);
        return "Ralph loop cancelled successfully";
      },
    }),
  };
}
