export interface RalphLoopState {
  task: string;
  completionPromise: string;
  maxIterations: number;
  currentIteration: number;
  status: "active" | "completed" | "cancelled" | "error" | "max_iterations_reached";
  startedAt: string;  // ISO 8601 timestamp
  lastIterationAt: string;  // ISO 8601 timestamp
}
