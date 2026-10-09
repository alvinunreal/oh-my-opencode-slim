export type AgentPermission = Record<
  string,
  'allow' | 'ask' | 'deny' | Record<string, 'allow' | 'ask' | 'deny'>
>;

/**
 * Nested-dispatch stance for the `task` permission key.
 *
 * The v2 host merges session rules after the agent's static permissions and
 * evaluates with last-match-wins, and the compiled v2 permission base allows
 * every unmatched action — so an agent whose map carries no `task` entry can
 * spawn ANY subagent once the host depth limit is raised. Every shipped
 * agent therefore needs an explicit stance.
 *
 * Pattern order is load-bearing: key insertion order survives
 * `fromConfig`/`adaptPermissions` and the evaluators use `findLast`, so the
 * `'*'` deny must come FIRST and the specific allow LAST — the reverse order
 * would make the wildcard deny swallow the observer allow.
 */
export const TASK_NO_NESTED_DISPATCH: Record<string, 'allow' | 'ask' | 'deny'> =
  { '*': 'deny' };

/** Observer-only nested dispatch: advisory agents may spawn @observer. */
export const TASK_OBSERVER_DISPATCH_ONLY: Record<
  string,
  'allow' | 'ask' | 'deny'
> = { '*': 'deny', observer: 'allow' };

/**
 * A permission override replaces the whole map; keep the agent's
 * nested-dispatch stance when the override doesn't address `task`.
 * String shorthands stay untouched — an explicit take-over of every tool.
 * Pure: returns the override, or a shallow copy carrying the stance.
 * Shared by every permission-replacement site (plugin-config overrides,
 * host agent entries, marketplace owner overrides).
 */
export function mergeTaskStance<T>(override: T, factoryPermission: unknown): T {
  if (
    override === null ||
    typeof override !== 'object' ||
    Array.isArray(override) ||
    (override as Record<string, unknown>).task !== undefined
  ) {
    return override;
  }
  const stance = (factoryPermission as Record<string, unknown> | undefined)
    ?.task;
  if (stance === undefined) return override;
  return { ...override, task: structuredClone(stance) };
}

/**
 * Strict read-only tool permissions for advisory agents.
 *
 * Start with wildcard deny so newly-added tools are unavailable by default,
 * then allow only inspection/search tools. Explicitly deny known mutating and
 * delegation tools to make the read-only boundary obvious in generated config.
 */
export function createReadOnlyAgentPermission(): AgentPermission {
  return {
    '*': 'deny',
    bash: 'deny',
    edit: 'deny',
    write: 'deny',
    apply_patch: 'deny',
    ast_grep_replace: 'deny',
    task: 'deny',
    question: 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    lsp: 'allow',
    list: 'allow',
    codesearch: 'allow',
    ast_grep_search: 'allow',
  } as AgentPermission;
}

/**
 * Strict deny-all permissions for the council synthesis agent.
 *
 * The council agent is text-in/text-out only — it must NOT use any
 * file-inspection tools. Councillors already perform codebase exploration;
 * the council only reconciles their text output.
 */
export function createSynthesisOnlyPermission(): AgentPermission {
  return {
    '*': 'deny',
    bash: 'deny',
    edit: 'deny',
    write: 'deny',
    apply_patch: 'deny',
    ast_grep_replace: 'deny',
    task: 'deny',
    question: 'deny',
    read: 'deny',
    glob: 'deny',
    grep: 'deny',
    lsp: 'deny',
    list: 'deny',
    codesearch: 'deny',
    ast_grep_search: 'deny',
  } as AgentPermission;
}
