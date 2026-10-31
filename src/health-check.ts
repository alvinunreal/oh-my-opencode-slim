/**
 * Plugin init health-check thresholds and helpers.
 *
 * Deliberately NOT re-exported from the package root (`src/index.ts`).
 * OpenCode's legacy plugin loader iterates every named export of the
 * root module and invokes each as a plugin factory with `PluginInput`.
 * A helper like `minimumExpectedToolCount` would then be called with a
 * `PluginInput` object instead of `string[]`, and its numeric return
 * value would be pushed into the hooks array as if it were a `Hooks`
 * object. Keeping this module internal (imported by, but not
 * re-exported from, `src/index.ts`) avoids that class of bug entirely;
 * see https://github.com/alvinunreal/oh-my-opencode-slim/issues/894.
 */

import { ALL_AGENT_NAMES } from './config/constants';
import type { BackgroundJobsMode } from './config/schema';

/**
 * Minimum expected registrations for a healthy plugin load.
 *
 * On v2 hosts `wait_for_user`, `task_revive` and `task_message` are
 * unregistered (the native `question` tool covers the blocking boundary,
 * retained sessions resume through native `subagent(sessionID, prompt)`, and
 * a running child is steered the same way), so the v2 floor drops by three
 * relative to the v1 baseline. When the OMOS managed background-task
 * lifecycle is disabled (`backgroundJobs.enabled = false`), the three
 * background-task tools (`task_cancel`, `task_status`, `task_reply`) plus
 * the v1-only `task_revive`, `task_message` and `wait_for_user` are not
 * registered either, so the floor drops by six on v1 (three on v2, where
 * all three v1-only tools were already gone).
 */
export const HEALTH_CHECK = {
  minAgents: 5,
  // Default v1 tool set when council and ACP agents are not configured:
  // task_cancel, task_revive, task_status, task_message,
  // task_reply, wait_for_user, webfetch, ast_grep_search, ast_grep_replace.
  minTools: 9,
  minMcps: 1,
} as const;

/**
 * Compute the minimum agent count expected from the built-in roster after
 * explicitly disabled agents are removed and after Council Mode's own agents
 * are omitted when no council is configured (createAgents does the same).
 * Malformed config values are treated as no disabled agents; the floor stays
 * positive even if every name is disabled.
 */
export function minimumExpectedAgentCount(
  disabledAgents: readonly string[] = [],
  councilEnabled = true,
): number {
  const safeDisabledAgents = Array.isArray(disabledAgents)
    ? disabledAgents
    : [];
  const disabled = new Set(safeDisabledAgents);
  // createAgents disables the bare councillor whenever the council agent is
  // disabled, even if the councillor itself is protected from user config.
  const councilDisabled = disabled.has('council');
  const enabledCount = ALL_AGENT_NAMES.filter(
    (name) =>
      !disabled.has(name) &&
      (councilEnabled || (name !== 'council' && name !== 'councillor')) &&
      !(councilDisabled && name === 'councillor'),
  ).length;
  return Math.max(1, enabledCount);
}

const BASELINE_TOOL_NAMES = new Set([
  'task_cancel',
  'task_revive',
  'task_status',
  'task_message',
  'task_reply',
  'wait_for_user',
  'webfetch',
  'ast_grep_search',
  'ast_grep_replace',
]);

/** Task tools in the baseline, split by the lifecycle mode that registers them. */
const TASK_TOOL_NAMES = new Set([
  'task_cancel',
  'task_revive',
  'task_status',
  'task_message',
  'task_reply',
  'wait_for_user',
]);

/** Tools that disappear together when the managed lifecycle is off. */
const BACKGROUND_TASK_TOOL_NAMES = new Set([
  'task_cancel',
  'task_status',
  'task_reply',
]);

/** Native mode registers only these two host-read controls. */
const NATIVE_MODE_TASK_TOOL_NAMES = new Set(['task_cancel', 'task_status']);

/** V1-only baseline tools: never registered on v2, nor without the lifecycle. */
const V1_ONLY_BASELINE_TOOL_NAMES = new Set([
  'task_revive',
  'task_message',
  'wait_for_user',
]);

/**
 * Minimum tool count the health check should expect: the baseline floor
 * minus tools this configuration never registers and minus baseline tools
 * the user intentionally disabled.
 *
 * @param disabledTools - User-edited config; a non-array is treated as
 *   "nothing disabled" instead of crashing plugin init.
 * @param backgroundJobsMode - Resolved lifecycle mode. Booleans are accepted
 *   for callers that predate the mode switch (`false` → `off`).
 */
export function minimumExpectedToolCount(
  disabledTools: readonly string[] = [],
  webfetchEnabled = true,
  hostFlavor?: string,
  backgroundJobsMode: BackgroundJobsMode | boolean = 'managed',
): number {
  const mode: BackgroundJobsMode =
    typeof backgroundJobsMode === 'boolean'
      ? backgroundJobsMode
        ? 'managed'
        : 'off'
      : backgroundJobsMode;
  const v2 = hostFlavor === 'v2';
  // Baseline tools this configuration never registers. One set, so the floor
  // is a single subtraction and cannot drift from the registration sites.
  const unregistered = new Set<string>();
  if (v2)
    for (const name of V1_ONLY_BASELINE_TOOL_NAMES) unregistered.add(name);
  if (mode === 'off') {
    for (const name of [
      ...BACKGROUND_TASK_TOOL_NAMES,
      ...V1_ONLY_BASELINE_TOOL_NAMES,
    ])
      unregistered.add(name);
  } else if (mode === 'native') {
    for (const name of TASK_TOOL_NAMES) {
      if (!NATIVE_MODE_TASK_TOOL_NAMES.has(name)) unregistered.add(name);
    }
  }
  // Config values come from user-edited JSON/JSONC (and can be re-derived
  // via runtime preset switches); never trust the declared type at
  // runtime. Fall back to "no disabled tools" instead of crashing plugin
  // init if this isn't actually an array.
  const safeDisabledTools = Array.isArray(disabledTools) ? disabledTools : [];
  // A user listing a tool that is never registered must not mask a genuinely
  // missing one, so only registered baseline tools count as intentionally off.
  const disabledBaselineTools = new Set(
    safeDisabledTools.filter(
      (toolName) =>
        BASELINE_TOOL_NAMES.has(toolName) &&
        !unregistered.has(toolName) &&
        (toolName !== 'webfetch' || webfetchEnabled),
    ),
  );
  return (
    HEALTH_CHECK.minTools -
    (webfetchEnabled ? 0 : 1) -
    unregistered.size -
    disabledBaselineTools.size
  );
}
