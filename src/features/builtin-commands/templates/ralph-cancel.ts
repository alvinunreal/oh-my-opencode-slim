import { loadState, saveState, deleteState } from "../../../hooks/ralph-loop/storage";

export async function ralphCancelCommand(ctx: any): Promise<void> {
  const state = await loadState(ctx);

  if (!state || state.status !== "active") {
    console.log("⚠️  No active ralph-loop to cancel.");
    return;
  }

  // Update status to cancelled (for logging purposes)
  await saveState(ctx, { ...state, status: "cancelled" });
  
  console.log(`🛑 Ralph loop cancelled: "${state.task}"`);
  console.log(`   Completed ${state.currentIteration}/${state.maxIterations} iterations.`);
  console.log(`   State preserved in .orchestrator/ralph-loop.local.md`);

  // Delete state file after logging
  await deleteState(ctx);
}
