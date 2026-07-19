export const TASK_REJECTION_INSTRUCTION =
  'If a task is outside your role, do not attempt partial work. Return a brief reason to the orchestrator.';

export function appendTaskRejectionInstruction(prompt: string): string {
  return `${prompt}\n\n${TASK_REJECTION_INSTRUCTION}`;
}
