import { loadState, saveState } from "../../../hooks/ralph-loop/storage";
import { DEFAULT_MAX_ITERATIONS, DEFAULT_COMPLETION_PROMISE } from "../../../hooks/ralph-loop/constants";
import type { RalphLoopState } from "../../../hooks/ralph-loop/types";

export interface RalphLoopArgs {
  task: string;
  "completion-promise"?: string;
  "max-iterations"?: number;
}

export async function ralphLoopCommand(ctx: any, args: RalphLoopArgs): Promise<void> {
  // Check if config is enabled
  if (ctx.config?.ralph_loop?.enabled === false) {
    console.log("⚠️  Ralph loop is disabled in config.");
    return;
  }

  // Check if loop already active
  const existingState = await loadState(ctx);
  if (existingState && existingState.status === "active") {
    console.log("⚠️  A ralph-loop is already active. Use /ralph-cancel to stop it first.");
    return;
  }

  const completionPromise = args["completion-promise"] || DEFAULT_COMPLETION_PROMISE;
  const maxIterations = args["max-iterations"] || ctx.config?.ralph_loop?.default_max_iterations || DEFAULT_MAX_ITERATIONS;

  const state: RalphLoopState = {
    task: args.task,
    completionPromise,
    maxIterations,
    currentIteration: 0,
    status: "active",
    startedAt: new Date().toISOString(),
    lastIterationAt: new Date().toISOString(),
  };

  await saveState(ctx, state);

  console.log(`🚀 Ralph loop started: "${args.task}"`);
  console.log(`   Max iterations: ${maxIterations}`);
  console.log(`   Completion promise: <promise>${completionPromise}</promise>`);

  // Inject initial prompt
  const prompt = `You are working on: "${args.task}"

Your task is to work autonomously until this goal is achieved.
When you have fully completed the task, output: <promise>${completionPromise}</promise>

If you get stuck or need clarification, ask the user instead of continuing blindly.
Do NOT output the promise tag unless you are 100% certain the task is complete.

Current iteration: 1/${maxIterations}`;

  // Note: This will be integrated with the OpenCode SDK's prompt injection mechanism
  // For now, we'll just log it - the actual integration happens in the plugin's event handler
  console.log("\n[Ralph Loop] Initial prompt ready for injection");
}
