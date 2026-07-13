import { describe, expect, it } from 'bun:test';
import { getSkillPermissionsForAgent } from './skills';

describe('skills permissions', () => {
  it('should allow all skills for orchestrator by default', () => {
    const permissions = getSkillPermissionsForAgent('orchestrator');
    expect(permissions['*']).toBe('allow');
  });

  it('should deny all skills for other agents by default', () => {
    const permissions = getSkillPermissionsForAgent('designer');
    expect(permissions['*']).toBe('deny');
  });

  it('should allow bundled skills for specific agents', () => {
    // Designer should only inherit the default non-orchestrator deny rule
    const designerPerms = getSkillPermissionsForAgent('designer');
    expect(Object.keys(designerPerms)).toEqual(['*']);

    // Oracle should have simplify allowed by default
    const oraclePerms = getSkillPermissionsForAgent('oracle');
    expect(oraclePerms.simplify).toBe('allow');

    const orchestratorPerms = getSkillPermissionsForAgent('orchestrator');
    expect(orchestratorPerms.clonedeps).toBe('allow');
    expect(orchestratorPerms.deepwork).toBe('allow');
    expect(orchestratorPerms['verification-planning']).toBe('allow');
    expect(orchestratorPerms.reflect).toBe('allow');
    expect(orchestratorPerms['release-smoke-test']).toBe('allow');
    expect(orchestratorPerms.worktrees).toBe('allow');
    expect(orchestratorPerms['oh-my-opencode-slim']).toBe('allow');
  });

  it('should honor explicit skill list overrides', () => {
    // Override with empty list
    const emptyPerms = getSkillPermissionsForAgent('orchestrator', []);
    expect(emptyPerms['*']).toBe('deny');
    expect(Object.keys(emptyPerms).length).toBe(1);

    // Override with specific list
    const specificPerms = getSkillPermissionsForAgent('designer', [
      'my-skill',
      '!bad-skill',
    ]);
    expect(specificPerms['*']).toBe('deny');
    expect(specificPerms['my-skill']).toBe('allow');
    expect(specificPerms['bad-skill']).toBe('deny');
  });

  it('should honor wildcard in explicit list', () => {
    const wildcardPerms = getSkillPermissionsForAgent('designer', ['*']);
    expect(wildcardPerms['*']).toBe('allow');
  });
});
