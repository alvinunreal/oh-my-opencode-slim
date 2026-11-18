export const TASK_REJECTION_INSTRUCTION =
  'If a task is outside your role, do not attempt partial work. Return a brief reason to the orchestrator.';

export function appendTaskRejectionInstruction(prompt: string): string {
  return `${prompt}\n\n${TASK_REJECTION_INSTRUCTION}`;
}

/** Advisory-role line enabling the observer dispatch route. Injected only
 * when the observer agent is enabled; capability-neutral so it stays true
 * for both vision and non-vision models. */
const OBSERVER_DISPATCH_INSTRUCTION =
  "Read visual files directly when you can. If you can't view one or need help, send @observer the path and goal.";

export const OBSERVER_DISPATCH_ROLES = new Set<string>([
  'explorer',
  'oracle',
  'designer',
]);

export function appendObserverDispatchInstruction(
  prompt: string,
  enabled: boolean,
): string {
  return enabled ? `${prompt}\n\n${OBSERVER_DISPATCH_INSTRUCTION}` : prompt;
}
