/** Opt-in native v2 delegation guidance. It is appended to the host
 * `subagent` tool description so the policy has one model-facing owner; the
 * plugin never inspects or rewrites delegation arguments. */
export const FRESH_DELEGATION_POLICY =
  'For a new deliverable, investigation, or verification scope, omit sessionID so the specialist starts a fresh child. Reuse sessionID for follow-ups or corrections on the same deliverable and when the user explicitly asks to resume a child.';

export function appendFreshDelegationPolicy(description: string): string {
  if (description.includes(FRESH_DELEGATION_POLICY)) return description;
  return `${description}\n\n${FRESH_DELEGATION_POLICY}`;
}
