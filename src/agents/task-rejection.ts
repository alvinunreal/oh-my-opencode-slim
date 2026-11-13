export const TASK_REJECTION_INSTRUCTION =
  'If a task is outside your role, do not attempt partial work. Return a brief reason to the orchestrator.';

export function appendTaskRejectionInstruction(prompt: string): string {
  return `${prompt}\n\n${TASK_REJECTION_INSTRUCTION}`;
}

/** Legacy advisory routing, used only when the v2 execution guard is off.
 * With the guard on, native tools own usage guidance instead of a standing
 * instruction that primes even vision-capable agents to delegate. */
const OBSERVER_DISPATCH_INSTRUCTION =
  'When you cannot view an image or visual file directly, dispatch @observer with the file path and a precise goal, then work from its reported observations.';

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
