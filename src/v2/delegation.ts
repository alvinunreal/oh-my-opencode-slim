/** Normalize native v2 delegation for shared tool guards and inference policy.
 * The host remains the sole owner of child jobs and completion delivery. */

export const DELEGATION_TOOL_V2 = 'subagent';
const DELEGATION_TOOL_V1 = 'task';

/** v2 `subagent` tool name → the `task` name the v1 pipeline expects;
 * every other name is returned unchanged. */
export function toolNameToV1(tool: string): string {
  return tool.toLowerCase() === DELEGATION_TOOL_V2 ? DELEGATION_TOOL_V1 : tool;
}

/** Shallow-copy record view with an `{}` fallback for non-objects.
 * Deliberately NOT `isRecord` from `utils/guards` (a pure type guard):
 * both subagentArgsToV1 copies rely on the copy + fallback semantics. */
function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object'
    ? { ...(input as Record<string, unknown>) }
    : {};
}

/** v2 subagent args → v1 task args view (shallow copy):
 * agent→subagent_type, sessionID→task_id, rest unchanged.
 *
 * Accepts a legacy `task_id` as the resume id too (a v2 model may still
 * emit the v1 parameter name): canonical `sessionID` wins when both are
 * present, otherwise `task_id` is surfaced as-is. */
export function subagentArgsToV1(input: unknown): Record<string, unknown> {
  const args = asRecord(input);
  const resume = args.sessionID !== undefined ? args.sessionID : args.task_id;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'agent') out.subagent_type = value;
    else if (key !== 'sessionID' && key !== 'task_id') out[key] = value;
  }
  if (resume !== undefined) out.task_id = resume;
  return out;
}

/** v1 task args → v2 subagent args (shallow copy, reverse mapping).
 * A hook deleting task_id → result has no sessionID; a hook writing
 * task_id → sessionID stays in sync. `task_id` is never emitted: the
 * host only understands the canonical `sessionID`. */
export function v1ArgsToSubagent(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const resume = args.task_id !== undefined ? args.task_id : args.sessionID;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'subagent_type') out.agent = value;
    else if (key !== 'task_id' && key !== 'sessionID') out[key] = value;
  }
  if (resume !== undefined) out.sessionID = resume;
  return out;
}

/** Host delegation tool and its agent-selector and session parameters. */
export function delegationWording() {
  return { tool: 'subagent', agentParam: 'agent', resumeParam: 'sessionID' };
}
