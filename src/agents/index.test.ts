import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../config';
import { SUBAGENT_NAMES } from '../config';
import { createAgents, getAgentConfigs, isSubagent } from './index';

describe('agent alias backward compatibility', () => {
  test("applies 'explore' config to 'explorer' agent", () => {
    const config: PluginConfig = {
      agents: {
        explore: { model: 'test/old-explore-model' },
      },
    };
    const agents = createAgents(config);
    const explorer = agents.find((a) => a.name === 'explorer');
    expect(explorer).toBeDefined();
    expect(explorer?.config.model).toBe('test/old-explore-model');
  });

  test("applies 'frontend-ui-ux-engineer' config to 'designer' agent", () => {
    const config: PluginConfig = {
      agents: {
        'frontend-ui-ux-engineer': { model: 'test/old-frontend-model' },
      },
    };
    const agents = createAgents(config);
    const designer = agents.find((a) => a.name === 'designer');
    expect(designer).toBeDefined();
    expect(designer?.config.model).toBe('test/old-frontend-model');
  });

  test('new name takes priority over old alias', () => {
    const config: PluginConfig = {
      agents: {
        explore: { model: 'old-model' },
        explorer: { model: 'new-model' },
      },
    };
    const agents = createAgents(config);
    const explorer = agents.find((a) => a.name === 'explorer');
    expect(explorer?.config.model).toBe('new-model');
  });

  test('new agent names work directly', () => {
    const config: PluginConfig = {
      agents: {
        explorer: { model: 'direct-explorer' },
        designer: { model: 'direct-designer' },
      },
    };
    const agents = createAgents(config);
    expect(agents.find((a) => a.name === 'explorer')?.config.model).toBe(
      'direct-explorer',
    );
    expect(agents.find((a) => a.name === 'designer')?.config.model).toBe(
      'direct-designer',
    );
  });

  test('temperature override via old alias', () => {
    const config: PluginConfig = {
      agents: {
        explore: { temperature: 0.5 },
      },
    };
    const agents = createAgents(config);
    const explorer = agents.find((a) => a.name === 'explorer');
    expect(explorer?.config.temperature).toBe(0.5);
  });
});

describe('fixer agent fallback', () => {
  test('fixer inherits librarian model when no fixer config provided', () => {
    const config: PluginConfig = {
      agents: {
        librarian: { model: 'librarian-custom-model' },
      },
    };
    const agents = createAgents(config);
    const fixer = agents.find((a) => a.name === 'fixer');
    const librarian = agents.find((a) => a.name === 'librarian');
    expect(fixer?.config.model).toBe(librarian?.config.model);
  });

  test('fixer uses its own model when explicitly configured', () => {
    const config: PluginConfig = {
      agents: {
        librarian: { model: 'librarian-model' },
        fixer: { model: 'fixer-specific-model' },
      },
    };
    const agents = createAgents(config);
    const fixer = agents.find((a) => a.name === 'fixer');
    expect(fixer?.config.model).toBe('fixer-specific-model');
  });
});

describe('orchestrator agent', () => {
  test('orchestrator is first in agents array', () => {
    const agents = createAgents();
    expect(agents[0].name).toBe('orchestrator');
  });

  test('orchestrator has question permission set to allow', () => {
    const agents = createAgents();
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(orchestrator?.config.permission).toBeDefined();
    expect((orchestrator?.config.permission as any).question).toBe('allow');
  });

  test('orchestrator accepts overrides', () => {
    const config: PluginConfig = {
      agents: {
        orchestrator: { model: 'custom-orchestrator-model', temperature: 0.3 },
      },
    };
    const agents = createAgents(config);
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(orchestrator?.config.model).toBe('custom-orchestrator-model');
    expect(orchestrator?.config.temperature).toBe(0.3);
  });
});

describe('isSubagent type guard', () => {
  test('returns true for valid subagent names', () => {
    expect(isSubagent('explorer')).toBe(true);
    expect(isSubagent('librarian')).toBe(true);
    expect(isSubagent('oracle')).toBe(true);
    expect(isSubagent('designer')).toBe(true);
    expect(isSubagent('fixer')).toBe(true);
    expect(isSubagent('long-fixer')).toBe(true);
    expect(isSubagent('quick-fixer')).toBe(true);
  });

  test('returns false for orchestrator', () => {
    expect(isSubagent('orchestrator')).toBe(false);
  });

  test('returns false for invalid agent names', () => {
    expect(isSubagent('invalid-agent')).toBe(false);
    expect(isSubagent('')).toBe(false);
    expect(isSubagent('explore')).toBe(false); // old alias, not actual agent name
  });
});

describe('agent classification', () => {
  test('SUBAGENT_NAMES excludes orchestrator', () => {
    expect(SUBAGENT_NAMES).not.toContain('orchestrator');
    expect(SUBAGENT_NAMES).toContain('explorer');
    expect(SUBAGENT_NAMES).toContain('fixer');
  });

  test('getAgentConfigs applies correct classification visibility and mode', () => {
    const configs = getAgentConfigs();

    // Primary agent
    expect(configs.orchestrator.mode).toBe('primary');

    // Subagents (only standard ones by default, not granular fixers)
    for (const name of [
      'explorer',
      'librarian',
      'oracle',
      'designer',
      'fixer',
    ] as const) {
      expect(configs[name].mode).toBe('subagent');
    }
  });

  test('getAgentConfigs includes granular fixers when experimental flag is enabled', () => {
    const config: PluginConfig = {
      experimental: { granularFixers: true },
    };
    const configs = getAgentConfigs(config);

    // Primary agent
    expect(configs.orchestrator.mode).toBe('primary');

    // All subagents including granular fixers
    for (const name of SUBAGENT_NAMES) {
      expect(configs[name].mode).toBe('subagent');
    }
  });
});

describe('createAgents', () => {
  test('creates all standard agents without config', () => {
    const agents = createAgents();
    const names = agents.map((a) => a.name);
    expect(names).toContain('orchestrator');
    expect(names).toContain('explorer');
    expect(names).toContain('designer');
    expect(names).toContain('oracle');
    expect(names).toContain('librarian');
    expect(names).toContain('fixer');
  });

  test('creates exactly 6 agents (1 primary + 5 subagents) by default', () => {
    const agents = createAgents();
    expect(agents.length).toBe(6);
  });

  test('creates 8 agents when granularFixers experimental flag is enabled', () => {
    const config: PluginConfig = {
      experimental: { granularFixers: true },
    };
    const agents = createAgents(config);
    expect(agents.length).toBe(8);
    const names = agents.map((a) => a.name);
    expect(names).toContain('long-fixer');
    expect(names).toContain('quick-fixer');
  });

  test('does not create long-fixer and quick-fixer when granularFixers is disabled', () => {
    const agents = createAgents();
    const names = agents.map((a) => a.name);
    expect(names).not.toContain('long-fixer');
    expect(names).not.toContain('quick-fixer');
  });

  test('quick-fixer and long-fixer inherit fixer custom model', () => {
    const config: PluginConfig = {
      experimental: { granularFixers: true },
      agents: {
        fixer: { model: 'test/fixer-custom-model' },
      },
    };
    const agents = createAgents(config);
    const quickFixer = agents.find((a) => a.name === 'quick-fixer');
    const longFixer = agents.find((a) => a.name === 'long-fixer');
    expect(quickFixer?.config.model).toBe('test/fixer-custom-model');
    expect(longFixer?.config.model).toBe('test/fixer-custom-model');
  });

  test('quick-fixer and long-fixer inherit librarian model when fixer has no config', () => {
    const config: PluginConfig = {
      experimental: { granularFixers: true },
      agents: {
        librarian: { model: 'test/librarian-custom-model' },
      },
    };
    const agents = createAgents(config);
    const quickFixer = agents.find((a) => a.name === 'quick-fixer');
    const longFixer = agents.find((a) => a.name === 'long-fixer');
    expect(quickFixer?.config.model).toBe('test/librarian-custom-model');
    expect(longFixer?.config.model).toBe('test/librarian-custom-model');
  });

  test('quick-fixer and long-fixer use explicit config over fixer inheritance', () => {
    const config: PluginConfig = {
      experimental: { granularFixers: true },
      agents: {
        fixer: { model: 'test/fixer-model' },
        'quick-fixer': { model: 'test/quick-fixer-model' },
        'long-fixer': { model: 'test/long-fixer-model' },
      },
    };
    const agents = createAgents(config);
    const quickFixer = agents.find((a) => a.name === 'quick-fixer');
    const longFixer = agents.find((a) => a.name === 'long-fixer');
    expect(quickFixer?.config.model).toBe('test/quick-fixer-model');
    expect(longFixer?.config.model).toBe('test/long-fixer-model');
  });

  test('granular fixers have subagent mode in getAgentConfigs', () => {
    const config: PluginConfig = {
      experimental: { granularFixers: true },
    };
    const configs = getAgentConfigs(config);
    expect(configs['quick-fixer'].mode).toBe('subagent');
    expect(configs['long-fixer'].mode).toBe('subagent');
  });
});

describe('getAgentConfigs', () => {
  test('returns config record keyed by agent name', () => {
    const configs = getAgentConfigs();
    expect(configs.orchestrator).toBeDefined();
    expect(configs.explorer).toBeDefined();
    expect(configs.orchestrator.model).toBeDefined();
  });

  test('includes description in SDK config', () => {
    const configs = getAgentConfigs();
    expect(configs.orchestrator.description).toBeDefined();
    expect(configs.explorer.description).toBeDefined();
  });
});

describe('granular fixer custom prompts', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-prompt-test-'));
    originalEnv = { ...process.env };
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('long-fixer uses custom prompt file when present', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'long-fixer.md'),
      'Custom long-fixer prompt',
    );

    const config: PluginConfig = {
      experimental: { granularFixers: true },
    };
    const agents = createAgents(config);
    const longFixer = agents.find((a) => a.name === 'long-fixer');
    expect(longFixer?.config.prompt).toBe('Custom long-fixer prompt');
  });

  test('quick-fixer uses custom prompt file when present', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'quick-fixer.md'),
      'Custom quick-fixer prompt',
    );

    const config: PluginConfig = {
      experimental: { granularFixers: true },
    };
    const agents = createAgents(config);
    const quickFixer = agents.find((a) => a.name === 'quick-fixer');
    expect(quickFixer?.config.prompt).toBe('Custom quick-fixer prompt');
  });

  test('long-fixer appends custom prompt when append file present', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'long-fixer_append.md'),
      'Additional instructions for long-fixer',
    );

    const config: PluginConfig = {
      experimental: { granularFixers: true },
    };
    const agents = createAgents(config);
    const longFixer = agents.find((a) => a.name === 'long-fixer');
    expect(longFixer?.config.prompt).toContain(
      'Additional instructions for long-fixer',
    );
    // Verify it still has the base prompt
    expect(longFixer?.config.prompt).toContain('Long-Fixer');
  });

  test('quick-fixer appends custom prompt when append file present', () => {
    const promptsDir = path.join(tempDir, 'opencode', 'oh-my-opencode-slim');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'quick-fixer_append.md'),
      'Additional instructions for quick-fixer',
    );

    const config: PluginConfig = {
      experimental: { granularFixers: true },
    };
    const agents = createAgents(config);
    const quickFixer = agents.find((a) => a.name === 'quick-fixer');
    expect(quickFixer?.config.prompt).toContain(
      'Additional instructions for quick-fixer',
    );
    // Verify it still has the base prompt
    expect(quickFixer?.config.prompt).toContain('Quick-Fixer');
  });

  test('granular fixers use default prompts when no custom files exist', () => {
    const config: PluginConfig = {
      experimental: { granularFixers: true },
    };
    const agents = createAgents(config);
    const longFixer = agents.find((a) => a.name === 'long-fixer');
    const quickFixer = agents.find((a) => a.name === 'quick-fixer');

    // Verify default prompts are used
    expect(longFixer?.config.prompt).toContain('Long-Fixer');
    expect(longFixer?.config.prompt).toContain(
      'thorough implementation specialist',
    );
    expect(quickFixer?.config.prompt).toContain('Quick-Fixer');
    expect(quickFixer?.config.prompt).toContain(
      'ultra-fast implementation specialist',
    );
  });
});
