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

  it('should allow recommended skills for specific agents', () => {
    // Designer should have agent-browser allowed
    const designerPerms = getSkillPermissionsForAgent('designer');
    expect(designerPerms['agent-browser']).toBe('allow');

    // Oracle should have simplify allowed by recommendation
    const oraclePerms = getSkillPermissionsForAgent('oracle');
    expect(oraclePerms.simplify).toBe('allow');
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
