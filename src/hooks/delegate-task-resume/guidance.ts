/**
 * Builds the recovery note appended to empty/interrupted task results.
 *
 * The note is informational — it tells the orchestrator that the session
 * may contain partial state and how to resume it. The orchestrator decides
 * whether to actually resume.
 */

import type { TrackedTaskSession } from '../../utils/task-session-tracker';

export interface ResumeGuidanceOptions {
  sessionId: string;
  agent?: string;
  status: TrackedTaskSession['status'];
}

/**
 * Build a recovery note for an interrupted/empty task result.
 */
export function buildResumeGuidance(options: ResumeGuidanceOptions): string {
  const { sessionId, agent, status } = options;

  if (status !== 'interrupted' && status !== 'active') {
    return '';
  }

  const agentInfoLine = agent ? [`  agent: @${agent}`] : [];

  return [
    '',
    '[task partial state available]',
    'This task returned no final result, but its subagent session may contain partial state.',
    'If the user asks to continue/recover this work, reuse this task_id to reconnect.',
    `  task_id: ${sessionId}`,
    ...agentInfoLine,
    '',
    'The subagent can see its prior messages, tool calls, reads, patches, and interrupted/error state.',
    'This is recovery context, not an instruction to resume automatically.',
  ].join('\n');
}
