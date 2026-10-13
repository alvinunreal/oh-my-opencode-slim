/** v2↔v1 delegation tool normalization. The v2 host's built-in `subagent`
 * tool corresponds to v1's `task`: the v2 setup tool-execute bridge
 * translates names/args so the whole v1 pipeline (task-session-manager,
 * job board, task_* tools) is reused with zero changes. */

import { log } from '../utils/logger';
import { type DelegationVocabulary, delegationVocabulary } from './adapters';

export const DELEGATION_TOOL_V2 = 'subagent';
export const DELEGATION_TOOL_V1 = 'task';

/**
 * task_reply's honest v2 surface: until a host exposes form.reply through
 * the plugin session domain, v2 can only serve permission requests. One
 * shared constant so every branch that narrows the description uses
 * byte-identical wording (#1540 undetected branch = #1541 v2 branch).
 */
export const TASK_REPLY_PERMISSION_ONLY_DESCRIPTION =
  'Reply to a tracked child permission request by task ID/alias and request ID.';

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

/** Host-aware delegation wording for model-visible guidance: the native
 * delegation tool plus its agent-selector and existing-session parameters,
 * derived from `delegationVocabulary` so the v1/v2 mapping has a single
 * source: v2 → `subagent` / `agent` / `sessionID`; v1 and any unknown
 * flavor → `task` / `subagent_type` / `task_id`. The control tools (`task_*`)
 * share the same identifier param (`controlParamName`). The host's model
 * param is vocabulary-internal and never reaches model-visible guidance. */
export type DelegationWording = Omit<DelegationVocabulary, 'modelParam'>;

export function delegationWording(
  hostFlavor: string | undefined,
): DelegationWording {
  const { tool, agentParam, resumeParam } = delegationVocabulary(hostFlavor);
  return { tool, agentParam, resumeParam };
}

/** Rewritten native `subagent` description for the background-default flip
 * (v2 only): the native prose anchors the omitted-parameter default to the
 * foreground ("Foreground (default)…", "Use background only for…") and
 * fights the wake-based orchestration loop this plugin ships. The flipped
 * text states the mechanism the execute.before bridge enforces (omitted
 * `background` launches asynchronously), teaches `background: false` as the
 * dependent-work escape hatch, and is one line shorter than the native
 * text so the swap never grows the tool surface. */
export const SUBAGENT_BACKGROUND_DEFAULT_DESCRIPTION = [
  'Spawns an agent in a child session to work on the specified task.',
  'The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.',
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  'Background (default) launches it asynchronously and returns immediately; you are notified when it finishes.',
  'Foreground (background: false) runs the subagent to completion and returns its final response — use it only when the result is the direct input to your next step.',
].join('\n');

/** Per-instance pairing state for the background-default flip: the
 * mechanism half (the args rewrite in tool-execute-hooks) only runs once
 * the wording half (the description rewrite in v2 setup) verifiably
 * landed. One instance per plugin setup — the host loads one plugin per
 * project, so process-global state would let one location's teardown
 * disarm another's flip. The v1 factory creates it, threads the getter
 * into the task-session-manager deps, and hands the handle to v2 setup
 * through the hooks bag ('v2.backgroundDefaultFlip'). */
export interface BackgroundDefaultFlipState {
  arm(): void;
  disarm(): void;
  isArmed(): boolean;
}

export function createBackgroundDefaultFlipState(): BackgroundDefaultFlipState {
  let armed = false;
  return {
    arm: () => {
      armed = true;
      // Diagnostic lamp: when the flip silently never arms (or arms and
      // never disarms), behavior-side evidence only shows the symptom
      // (omitted background staying foreground); the armed/disarmed trail
      // pinpoints which half diverged.
      log('[v2] background-default flip armed');
    },
    disarm: () => {
      armed = false;
      log('[v2] background-default flip disarmed');
    },
    isArmed: () => armed,
  };
}
