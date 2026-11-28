import { describe, expect, test } from 'bun:test';
import {
  appendFreshDelegationPolicy,
  FRESH_DELEGATION_POLICY,
} from './fresh-delegation';

const NATIVE = 'Native subagent description';

describe('fresh delegation policy', () => {
  test('asks for a fresh child on new scope and keeps same-deliverable resume', () => {
    const rendered = appendFreshDelegationPolicy(NATIVE);
    expect(rendered).toBe(`${NATIVE}\n\n${FRESH_DELEGATION_POLICY}`);
    expect(rendered).toContain('omit sessionID');
    expect(rendered).toContain(
      'new deliverable, investigation, or verification scope',
    );
    expect(rendered).toContain('fresh child');
    expect(rendered).toContain('same deliverable');
    expect(rendered).toContain('explicitly asks to resume');
  });

  test('uses only the native v2 argument vocabulary', () => {
    expect(FRESH_DELEGATION_POLICY).not.toContain('task_id');
    expect(FRESH_DELEGATION_POLICY).not.toContain('subagent_type');
  });

  test('does not duplicate the policy when applied twice', () => {
    const once = appendFreshDelegationPolicy(NATIVE);
    expect(appendFreshDelegationPolicy(once)).toBe(once);
  });
});
