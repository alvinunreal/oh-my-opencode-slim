import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUSTOM_SKILLS } from './custom-skills';
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
    expect(orchestratorPerms['loop-engineering']).toBe('allow');
    expect(orchestratorPerms['verification-planning']).toBe('allow');
    expect(orchestratorPerms.reflect).toBe('allow');
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

describe('getSkillPermissionsForAgent with malformed disabledSkillNames', () => {
  it('does not throw when disabledSkillNames is not an array', () => {
    expect(() =>
      getSkillPermissionsForAgent(
        'orchestrator',
        undefined,
        'not-an-array' as any,
      ),
    ).not.toThrow();
  });

  it('treats non-array disabledSkillNames as empty array', () => {
    const permsWithDisabled = getSkillPermissionsForAgent(
      'orchestrator',
      undefined,
      ['simplify'],
    );
    const permsWithMalformed = getSkillPermissionsForAgent(
      'orchestrator',
      undefined,
      'not-an-array' as any,
    );
    // When simplify is disabled, it should be explicitly denied
    expect(permsWithDisabled.simplify).toBe('deny');
    // When disabledSkillNames is malformed (treated as empty), simplify should be allowed
    expect(permsWithMalformed['*']).toBe('allow');
  });

  it('handles object as disabledSkillNames gracefully', () => {
    const perms = getSkillPermissionsForAgent('orchestrator', undefined, {
      invalid: 'object',
    } as any);
    expect(perms['*']).toBe('allow');
  });
});

describe('bundled SKILL.md JSON-embeddability regression', () => {
  // `opencode debug skill` serialises each skill's frontmatter description
  // and body content as fields in a JSON array. A SKILL.md containing raw
  // control characters (other than \n, \r, \t) or malformed UTF-8 produces
  // invalid JSON that breaks `opencode debug skill | jq`.
  const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

  it('every registered bundled skill has a SKILL.md that is valid for JSON embedding', () => {
    const failures: string[] = [];

    for (const skill of CUSTOM_SKILLS) {
      const skillPath = join(packageRoot, skill.sourcePath, 'SKILL.md');
      let content: string;
      try {
        content = readFileSync(skillPath, 'utf8');
      } catch {
        failures.push(`${skill.name}: SKILL.md not found at ${skillPath}`);
        continue;
      }

      // Check for control characters that would break JSON embedding.
      for (let i = 0; i < content.length; i++) {
        const code = content.charCodeAt(i);
        if (code < 32 && code !== 10 && code !== 13 && code !== 9) {
          failures.push(
            `${skill.name}: control char (U+${code.toString(16).padStart(4, '0')}) at offset ${i}`,
          );
          break;
        }
      }

      // Simulate what `opencode debug skill` does: embed the description
      // and content as JSON string values.
      const description = parseFrontmatterDescription(content);
      const body = stripFrontmatter(content);
      const probe = JSON.stringify({
        name: skill.name,
        description,
        content: body,
      });
      try {
        JSON.parse(probe);
      } catch {
        failures.push(
          `${skill.name}: JSON parse failed for embedded skill object`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it('loop-engineering is registered and its SKILL.md is present', () => {
    const skill = CUSTOM_SKILLS.find((s) => s.name === 'loop-engineering');
    expect(skill).toBeDefined();
    if (!skill) return;
    const skillPath = join(packageRoot, skill.sourcePath, 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain('name: loop-engineering');
  });
});

/**
 * Extract the `description` value from a YAML frontmatter block.
 * Returns an empty string if the frontmatter or description is absent.
 */
function parseFrontmatterDescription(content: string): string {
  if (!content.startsWith('---')) return '';
  const end = content.indexOf('---', 3);
  if (end < 0) return '';
  const fm = content.slice(3, end);
  for (const line of fm.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('description:')) {
      return trimmed.slice('description:'.length).trim();
    }
  }
  return '';
}

/**
 * Strip the YAML frontmatter block and return the body content.
 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('---', 3);
  if (end < 0) return content;
  return content.slice(end + 3);
}
