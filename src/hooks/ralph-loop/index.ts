import { COMPLETION_TAG_PATTERN } from "./constants";
import { loadState, saveState, deleteState } from "./storage";
import type { RalphLoopState } from "./types";

export async function ralphLoopHook(ctx: any, event: any): Promise<void> {
  // Only process chat.message events
  if (event.type !== "chat.message") return;

  // Load current state
  const state = await loadState(ctx);
  
  // If no active loop, do nothing
  if (!state || state.status !== "active") return;

  const response = event.message?.content || "";

  // Check for completion promise (case-insensitive)
  const match = response.match(COMPLETION_TAG_PATTERN);
  if (match && match[1]?.toUpperCase() === state.completionPromise.toUpperCase()) {
    await handleCompletion(ctx, state);
    return;
  }

  // Check for error indicators
  if (detectError(response)) {
    await handleError(ctx, state, response);
    return;
  }

  // Increment iteration counter
  state.currentIteration++;
  state.lastIterationAt = new Date().toISOString();

  // Check if max iterations reached
  if (state.currentIteration >= state.maxIterations) {
    await handleMaxIterations(ctx, state);
    return;
  }

  // Save updated state
  await saveState(ctx, state);

  // Log continuation
  console.log(`[Ralph Loop] Iteration ${state.currentIteration}/${state.maxIterations} - continuing...`);
  
  // Note: Continuation prompt injection would happen here via SDK
  // For now, we just update the state and log the status
}

async function handleCompletion(ctx: any, state: RalphLoopState): Promise<void> {
  await saveState(ctx, { ...state, status: "completed" });
  console.log(`✅ Ralph loop completed successfully!`);
  console.log(`   Task: "${state.task}"`);
  console.log(`   Iterations: ${state.currentIteration}/${state.maxIterations}`);
  await deleteState(ctx);
}

async function handleError(ctx: any, state: RalphLoopState, response: string): Promise<void> {
  await saveState(ctx, { ...state, status: "error" });
  console.log(`❌ Ralph loop aborted due to error at iteration ${state.currentIteration}.`);
  console.log(`   Review error details in .orchestrator/ralph-loop.local.md`);
  // Keep state file for debugging (don't delete)
}

async function handleMaxIterations(ctx: any, state: RalphLoopState): Promise<void> {
  await saveState(ctx, { ...state, status: "max_iterations_reached" });
  console.log(`⚠️  Max iterations (${state.maxIterations}) reached.`);
  console.log(`   Task: "${state.task}"`);
  console.log(`   Task may be incomplete. Review progress in .orchestrator/ralph-loop.local.md`);
  await deleteState(ctx);
}

function detectError(response: string): boolean {
  // Simple error detection patterns
  const errorPatterns = [
    /error:/i,
    /exception:/i,
    /failed:/i,
    /cannot/i,
    /permission denied/i,
  ];
  
  return errorPatterns.some(pattern => pattern.test(response));
}
