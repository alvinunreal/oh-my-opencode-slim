/** v2↔v1 delegation tool normalization. The v2 host's built-in `subagent`
 * tool corresponds to v1's `task`: the v2 setup tool-execute bridge
 * translates names/args so the whole v1 pipeline (task-session-manager,
 * job board, task_* tools) is reused with zero changes. */

export const DELEGATION_TOOL_V2 = 'subagent';
export const DELEGATION_TOOL_V1 = 'task';

/** v2 `subagent` tool name → the `task` name the v1 pipeline expects;
 * every other name is returned unchanged. */
export function toolNameToV1(tool: string): string {
  return tool.toLowerCase() === DELEGATION_TOOL_V2 ? DELEGATION_TOOL_V1 : tool;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object'
    ? { ...(input as Record<string, unknown>) }
    : {};
}

/** v2 subagent args → v1 task args view (shallow copy):
 * agent→subagent_type, sessionID→task_id, rest unchanged. */
export function subagentArgsToV1(input: unknown): Record<string, unknown> {
  const args = asRecord(input);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'agent') out.subagent_type = value;
    else if (key === 'sessionID') out.task_id = value;
    else out[key] = value;
  }
  return out;
}

/** v1 task args → v2 subagent args (shallow copy, reverse mapping).
 * A hook deleting task_id → result has no sessionID; a hook writing
 * task_id → sessionID stays in sync. */
export function v1ArgsToSubagent(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'subagent_type') out.agent = value;
    else if (key === 'task_id') out.sessionID = value;
    else out[key] = value;
  }
  return out;
}
