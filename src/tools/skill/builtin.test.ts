import { describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../../config/schema';
import {
  canAgentUseMcp,
  canAgentUseSkill,
  DEFAULT_AGENT_MCPS,
  DEFAULT_AGENT_SKILLS,
  getAgentMcpList,
  getBuiltinSkills,
  getSkillByName,
  getSkillsForAgent,
  parseList,
} from './builtin';

describe('getBuiltinSkills', () => {
  test('returns all builtin skills', () => {
    const skills = getBuiltinSkills();
    expect(skills.length).toBeGreaterThan(0);

    const names = skills.map((s) => s.name);
    expect(names).toContain('simplify');
    expect(names).toContain('playwright');
  });
});

describe('getSkillByName', () => {
  test('returns skill by exact name', () => {
    const skill = getSkillByName('simplify');
    expect(skill).toBeDefined();
    expect(skill?.name).toBe('simplify');
  });

  test('returns undefined for unknown skill', () => {
    const skill = getSkillByName('nonexistent-skill');
    expect(skill).toBeUndefined();
  });

  test('returns playwright skill with mcpConfig', () => {
    const skill = getSkillByName('playwright');
    expect(skill).toBeDefined();
    expect(skill?.mcpConfig).toBeDefined();
    expect(skill?.mcpConfig?.playwright).toBeDefined();
  });
});

describe('DEFAULT_AGENT_SKILLS', () => {
  test('orchestrator has wildcard access', () => {
    expect(DEFAULT_AGENT_SKILLS.orchestrator).toContain('*');
  });

  test('designer has playwright skill', () => {
    expect(DEFAULT_AGENT_SKILLS.designer).toContain('playwright');
  });

  test('oracle has no skills by default', () => {
    expect(DEFAULT_AGENT_SKILLS.oracle).toEqual([]);
  });

  test('librarian has no skills by default', () => {
    expect(DEFAULT_AGENT_SKILLS.librarian).toEqual([]);
  });

  test('explorer has no skills by default', () => {
    expect(DEFAULT_AGENT_SKILLS.explorer).toEqual([]);
  });

  test('fixer has no skills by default', () => {
    expect(DEFAULT_AGENT_SKILLS.fixer).toEqual([]);
  });
});

describe('getSkillsForAgent', () => {
  test('returns all skills for orchestrator (wildcard)', () => {
    const skills = getSkillsForAgent('orchestrator');
    const allSkills = getBuiltinSkills();
    expect(skills.length).toBe(allSkills.length);
  });

  test('returns playwright for designer', () => {
    const skills = getSkillsForAgent('designer');
    const names = skills.map((s) => s.name);
    expect(names).toContain('playwright');
  });

  test('returns empty for oracle', () => {
    const skills = getSkillsForAgent('oracle');
    expect(skills).toEqual([]);
  });

  test('respects config override for agent skills', () => {
    const config: PluginConfig = {
      agents: {
        oracle: { skills: ['simplify'] },
      },
    };
    const skills = getSkillsForAgent('oracle', config);
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe('simplify');
  });

  test('config wildcard overrides default', () => {
    const config: PluginConfig = {
      agents: {
        explorer: { skills: ['*'] },
      },
    };
    const skills = getSkillsForAgent('explorer', config);
    const allSkills = getBuiltinSkills();
    expect(skills.length).toBe(allSkills.length);
  });

  test('config empty array removes default skills', () => {
    const config: PluginConfig = {
      agents: {
        designer: { skills: [] },
      },
    };
    const skills = getSkillsForAgent('designer', config);
    expect(skills).toEqual([]);
  });

  test("backward compat: 'explore' alias config applies to explorer", () => {
    const config: PluginConfig = {
      agents: {
        explore: { skills: ['playwright'] },
      },
    };
    const skills = getSkillsForAgent('explorer', config);
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe('playwright');
  });

  test("backward compat: 'frontend-ui-ux-engineer' alias applies to designer", () => {
    const config: PluginConfig = {
      agents: {
        'frontend-ui-ux-engineer': { skills: ['simplify'] },
      },
    };
    const skills = getSkillsForAgent('designer', config);
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe('simplify');
  });

  test('returns empty for unknown agent without config', () => {
    const skills = getSkillsForAgent('unknown-agent');
    expect(skills).toEqual([]);
  });
});

describe('canAgentUseSkill', () => {
  test('orchestrator can use any skill (wildcard)', () => {
    expect(canAgentUseSkill('orchestrator', 'simplify')).toBe(true);
    expect(canAgentUseSkill('orchestrator', 'playwright')).toBe(true);
    // Note: parseList doesn't filter non-existent items when using explicit allowlist
    // but canAgentUseSkill checks against actual skill names
  });

  test('designer can use playwright', () => {
    expect(canAgentUseSkill('designer', 'playwright')).toBe(true);
  });

  test('designer cannot use simplify by default', () => {
    expect(canAgentUseSkill('designer', 'simplify')).toBe(false);
  });

  test('oracle cannot use any skill by default', () => {
    expect(canAgentUseSkill('oracle', 'simplify')).toBe(false);
    expect(canAgentUseSkill('oracle', 'playwright')).toBe(false);
  });

  test('respects config override', () => {
    const config: PluginConfig = {
      agents: {
        oracle: { skills: ['simplify'] },
      },
    };
    expect(canAgentUseSkill('oracle', 'simplify', config)).toBe(true);
    expect(canAgentUseSkill('oracle', 'playwright', config)).toBe(false);
  });

  test('config wildcard grants all permissions', () => {
    const config: PluginConfig = {
      agents: {
        librarian: { skills: ['*'] },
      },
    };
    expect(canAgentUseSkill('librarian', 'simplify', config)).toBe(true);
    expect(canAgentUseSkill('librarian', 'playwright', config)).toBe(true);
    // Note: parseList expands wildcard to all available skills
  });

  test('config empty array denies all', () => {
    const config: PluginConfig = {
      agents: {
        designer: { skills: [] },
      },
    };
    expect(canAgentUseSkill('designer', 'playwright', config)).toBe(false);
  });

  test('backward compat: alias config affects agent permissions', () => {
    const config: PluginConfig = {
      agents: {
        explore: { skills: ['playwright'] },
      },
    };
    expect(canAgentUseSkill('explorer', 'playwright', config)).toBe(true);
    expect(canAgentUseSkill('explorer', 'simplify', config)).toBe(false);
  });

  test('unknown agent returns false without config', () => {
    expect(canAgentUseSkill('unknown-agent', 'playwright')).toBe(false);
  });
});

describe('parseList', () => {
  test('returns empty array for empty input', () => {
    expect(parseList([], ['a', 'b', 'c'])).toEqual([]);
  });

  test('returns empty array for undefined input', () => {
    expect(parseList(undefined as any, ['a', 'b', 'c'])).toEqual([]);
  });

  test('returns explicit items when no wildcard', () => {
    expect(parseList(['a', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });

  test('expands wildcard to all available items', () => {
    expect(parseList(['*'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  test('excludes items with ! prefix', () => {
    expect(parseList(['*', '!b'], ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });

  test('excludes multiple items with ! prefix', () => {
    expect(parseList(['*', '!b', '!c'], ['a', 'b', 'c', 'd'])).toEqual([
      'a',
      'd',
    ]);
  });

  test('deny wins in case of conflict', () => {
    expect(parseList(['a', '!a'], ['a', 'b'])).toEqual([]);
  });

  test('!* denies all items', () => {
    expect(parseList(['!*'], ['a', 'b', 'c'])).toEqual([]);
  });

  test('!* overrides wildcard', () => {
    expect(parseList(['*', '!*'], ['a', 'b', 'c'])).toEqual([]);
  });

  test('handles mixed allow and deny without wildcard', () => {
    expect(parseList(['a', 'b', '!b'], ['a', 'b', 'c'])).toEqual(['a']);
  });

  test('excludes non-existent items gracefully', () => {
    expect(parseList(['*', '!nonexistent'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  test('returns explicit allowlist minus denials', () => {
    expect(parseList(['a', 'd'], ['a', 'b', 'c'])).toEqual(['a', 'd']);
  });
});

describe('DEFAULT_AGENT_MCPS', () => {
  test('orchestrator has websearch MCP', () => {
    expect(DEFAULT_AGENT_MCPS.orchestrator).toContain('websearch');
  });

  test('designer has no MCPs by default', () => {
    expect(DEFAULT_AGENT_MCPS.designer).toEqual([]);
  });

  test('oracle has no MCPs by default', () => {
    expect(DEFAULT_AGENT_MCPS.oracle).toEqual([]);
  });

  test('librarian has websearch, context7, and grep_app MCPs', () => {
    expect(DEFAULT_AGENT_MCPS.librarian).toContain('websearch');
    expect(DEFAULT_AGENT_MCPS.librarian).toContain('context7');
    expect(DEFAULT_AGENT_MCPS.librarian).toContain('grep_app');
  });

  test('explorer has no MCPs by default', () => {
    expect(DEFAULT_AGENT_MCPS.explorer).toEqual([]);
  });

  test('fixer has no MCPs by default', () => {
    expect(DEFAULT_AGENT_MCPS.fixer).toEqual([]);
  });
});

describe('getAgentMcpList', () => {
  test('returns default MCPs for orchestrator', () => {
    const mcps = getAgentMcpList('orchestrator');
    expect(mcps).toEqual(DEFAULT_AGENT_MCPS.orchestrator);
  });

  test('returns default MCPs for librarian', () => {
    const mcps = getAgentMcpList('librarian');
    expect(mcps).toEqual(DEFAULT_AGENT_MCPS.librarian);
  });

  test('returns empty for designer', () => {
    const mcps = getAgentMcpList('designer');
    expect(mcps).toEqual([]);
  });

  test('respects config override for agent MCPs', () => {
    const config: PluginConfig = {
      agents: {
        oracle: { mcps: ['websearch'] },
      },
    };
    const mcps = getAgentMcpList('oracle', config);
    expect(mcps).toEqual(['websearch']);
  });

  test('config wildcard overrides default', () => {
    const config: PluginConfig = {
      agents: {
        designer: { mcps: ['*'] },
      },
    };
    const mcps = getAgentMcpList('designer', config);
    expect(mcps).toEqual(['*']);
  });

  test('config empty array removes default MCPs', () => {
    const config: PluginConfig = {
      agents: {
        librarian: { mcps: [] },
      },
    };
    const mcps = getAgentMcpList('librarian', config);
    expect(mcps).toEqual([]);
  });

  test('backward compat: alias config applies to agent', () => {
    const config: PluginConfig = {
      agents: {
        explore: { mcps: ['websearch'] },
      },
    };
    const mcps = getAgentMcpList('explorer', config);
    expect(mcps).toEqual(['websearch']);
  });

  test('returns empty for unknown agent without config', () => {
    const mcps = getAgentMcpList('unknown-agent');
    expect(mcps).toEqual([]);
  });
});

describe('canAgentUseMcp', () => {
  test('orchestrator can use websearch by default', () => {
    expect(canAgentUseMcp('orchestrator', 'websearch')).toBe(true);
  });

  test('librarian can use websearch, context7, and grep_app by default', () => {
    expect(canAgentUseMcp('librarian', 'websearch')).toBe(true);
    expect(canAgentUseMcp('librarian', 'context7')).toBe(true);
    expect(canAgentUseMcp('librarian', 'grep_app')).toBe(true);
  });

  test('designer cannot use any MCP by default', () => {
    expect(canAgentUseMcp('designer', 'websearch')).toBe(false);
    expect(canAgentUseMcp('designer', 'context7')).toBe(false);
  });

  test('respects config override', () => {
    const config: PluginConfig = {
      agents: {
        oracle: { mcps: ['websearch'] },
      },
    };
    expect(canAgentUseMcp('oracle', 'websearch', config)).toBe(true);
    expect(canAgentUseMcp('oracle', 'context7', config)).toBe(false);
  });

  test('config wildcard grants all MCP permissions', () => {
    const config: PluginConfig = {
      agents: {
        designer: { mcps: ['*'] },
      },
    };
    expect(canAgentUseMcp('designer', 'websearch', config)).toBe(true);
  });

  test('config wildcard grants skill MCP permissions', () => {
    const config: PluginConfig = {
      agents: {
        designer: { mcps: ['*'] },
      },
    };
    expect(canAgentUseMcp('designer', 'playwright', config)).toBe(true);
  });

  test('config empty array denies all MCPs', () => {
    const config: PluginConfig = {
      agents: {
        librarian: { mcps: [] },
      },
    };
    expect(canAgentUseMcp('librarian', 'websearch', config)).toBe(false);
  });

  test('respects exclusion syntax', () => {
    const config: PluginConfig = {
      agents: {
        orchestrator: { mcps: ['*', '!websearch'] },
      },
    };
    // canAgentUseMcp uses DEFAULT_AGENT_MCPS.orchestrator keys as allAvailable
    // which is ['websearch'], so excluding websearch leaves empty
    expect(canAgentUseMcp('orchestrator', 'websearch', config)).toBe(false);
  });

  test('backward compat: alias config affects agent permissions', () => {
    const config: PluginConfig = {
      agents: {
        explore: { mcps: ['websearch'] },
      },
    };
    expect(canAgentUseMcp('explorer', 'websearch', config)).toBe(true);
    expect(canAgentUseMcp('explorer', 'context7', config)).toBe(false);
  });

  test('unknown agent returns false without config', () => {
    expect(canAgentUseMcp('unknown-agent', 'websearch')).toBe(false);
  });
});

describe('parseList', () => {
  test('returns empty array for empty input', () => {
    expect(parseList([], ['a', 'b', 'c'])).toEqual([]);
  });

  test('returns empty array for undefined input', () => {
    expect(parseList(undefined as any, ['a', 'b', 'c'])).toEqual([]);
  });

  test('returns explicit items when no wildcard', () => {
    expect(parseList(['a', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });

  test('expands wildcard to all available items', () => {
    expect(parseList(['*'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  test('excludes items with ! prefix', () => {
    expect(parseList(['*', '!b'], ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });

  test('excludes multiple items with ! prefix', () => {
    expect(parseList(['*', '!b', '!c'], ['a', 'b', 'c', 'd'])).toEqual([
      'a',
      'd',
    ]);
  });

  test('deny wins in case of conflict', () => {
    expect(parseList(['a', '!a'], ['a', 'b'])).toEqual([]);
  });

  test('!* denies all items', () => {
    expect(parseList(['!*'], ['a', 'b', 'c'])).toEqual([]);
  });
});

describe('DEFAULT_AGENT_MCPS', () => {
  test('orchestrator has websearch MCP', () => {
    expect(DEFAULT_AGENT_MCPS.orchestrator).toContain('websearch');
  });

  test('designer has no MCPs by default', () => {
    expect(DEFAULT_AGENT_MCPS.designer).toEqual([]);
  });

  test('oracle has no MCPs by default', () => {
    expect(DEFAULT_AGENT_MCPS.oracle).toEqual([]);
  });

  test('librarian has websearch, context7, and grep_app MCPs', () => {
    expect(DEFAULT_AGENT_MCPS.librarian).toContain('websearch');
    expect(DEFAULT_AGENT_MCPS.librarian).toContain('context7');
    expect(DEFAULT_AGENT_MCPS.librarian).toContain('grep_app');
  });

  test('explorer has no MCPs by default', () => {
    expect(DEFAULT_AGENT_MCPS.explorer).toEqual([]);
  });

  test('fixer has no MCPs by default', () => {
    expect(DEFAULT_AGENT_MCPS.fixer).toEqual([]);
  });
});

describe('getAgentMcpList', () => {
  test('returns default MCPs for orchestrator', () => {
    const mcps = getAgentMcpList('orchestrator');
    expect(mcps).toEqual(DEFAULT_AGENT_MCPS.orchestrator);
  });

  test('returns default MCPs for librarian', () => {
    const mcps = getAgentMcpList('librarian');
    expect(mcps).toEqual(DEFAULT_AGENT_MCPS.librarian);
  });

  test('returns empty for designer', () => {
    const mcps = getAgentMcpList('designer');
    expect(mcps).toEqual([]);
  });

  test('respects config override for agent MCPs', () => {
    const config: PluginConfig = {
      agents: {
        oracle: { mcps: ['websearch'] },
      },
    };
    const mcps = getAgentMcpList('oracle', config);
    expect(mcps).toEqual(['websearch']);
  });

  test('config wildcard overrides default', () => {
    const config: PluginConfig = {
      agents: {
        designer: { mcps: ['*'] },
      },
    };
    const mcps = getAgentMcpList('designer', config);
    expect(mcps).toEqual(['*']);
  });

  test('config empty array removes default MCPs', () => {
    const config: PluginConfig = {
      agents: {
        librarian: { mcps: [] },
      },
    };
    const mcps = getAgentMcpList('librarian', config);
    expect(mcps).toEqual([]);
  });

  test('backward compat: alias config applies to agent', () => {
    const config: PluginConfig = {
      agents: {
        explore: { mcps: ['websearch'] },
      },
    };
    const mcps = getAgentMcpList('explorer', config);
    expect(mcps).toEqual(['websearch']);
  });

  test('returns empty for unknown agent without config', () => {
    const mcps = getAgentMcpList('unknown-agent');
    expect(mcps).toEqual([]);
  });
});

describe('canAgentUseMcp', () => {
  test('orchestrator can use websearch by default', () => {
    expect(canAgentUseMcp('orchestrator', 'websearch')).toBe(true);
  });

  test('librarian can use websearch, context7, and grep_app by default', () => {
    expect(canAgentUseMcp('librarian', 'websearch')).toBe(true);
    expect(canAgentUseMcp('librarian', 'context7')).toBe(true);
    expect(canAgentUseMcp('librarian', 'grep_app')).toBe(true);
  });

  test('designer cannot use any MCP by default', () => {
    expect(canAgentUseMcp('designer', 'websearch')).toBe(false);
    expect(canAgentUseMcp('designer', 'context7')).toBe(false);
  });

  test('respects config override', () => {
    const config: PluginConfig = {
      agents: {
        oracle: { mcps: ['websearch'] },
      },
    };
    expect(canAgentUseMcp('oracle', 'websearch', config)).toBe(true);
    expect(canAgentUseMcp('oracle', 'context7', config)).toBe(false);
  });

  test('config wildcard grants all MCP permissions', () => {
    const config: PluginConfig = {
      agents: {
        designer: { mcps: ['*'] },
      },
    };
    expect(canAgentUseMcp('designer', 'websearch', config)).toBe(true);
  });

  test('config wildcard grants skill MCP permissions', () => {
    const config: PluginConfig = {
      agents: {
        designer: { mcps: ['*'] },
      },
    };
    expect(canAgentUseMcp('designer', 'playwright', config)).toBe(true);
  });

  test('config empty array denies all MCPs', () => {
    const config: PluginConfig = {
      agents: {
        librarian: { mcps: [] },
      },
    };
    expect(canAgentUseMcp('librarian', 'websearch', config)).toBe(false);
  });

  test('respects exclusion syntax', () => {
    const config: PluginConfig = {
      agents: {
        orchestrator: { mcps: ['*', '!websearch'] },
      },
    };
    // canAgentUseMcp uses DEFAULT_AGENT_MCPS.orchestrator keys as allAvailable
    // which is ['websearch'], so excluding websearch leaves empty
    expect(canAgentUseMcp('orchestrator', 'websearch', config)).toBe(false);
  });

  test('backward compat: alias config affects agent permissions', () => {
    const config: PluginConfig = {
      agents: {
        explore: { mcps: ['websearch'] },
      },
    };
    expect(canAgentUseMcp('explorer', 'websearch', config)).toBe(true);
    expect(canAgentUseMcp('explorer', 'context7', config)).toBe(false);
  });

  test('unknown agent returns false without config', () => {
    expect(canAgentUseMcp('unknown-agent', 'websearch')).toBe(false);
  });
});
