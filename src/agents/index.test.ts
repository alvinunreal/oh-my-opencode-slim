import { describe, expect, spyOn, test } from 'bun:test';
import type { PluginConfig } from '../config';
import {
  AgentOverrideConfigSchema,
  DEFAULT_DISABLED_AGENTS,
  DEFAULT_MODELS,
  getCustomAgentNames,
  SUBAGENT_NAMES,
} from '../config';
import * as loader from '../config/loader';
import {
  createAgents,
  getAgentConfigs,
  getDisabledAgents,
  getEnabledAgentNames,
  isSubagent,
} from './index';

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

  test('variant override via old alias', () => {
    const config: PluginConfig = {
      agents: {
        explore: { variant: 'low' },
      },
    };
    const agents = createAgents(config);
    const explorer = agents.find((a) => a.name === 'explorer');
    expect(explorer?.config.variant).toBe('low');
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

  test('orchestrator accepts variant override', () => {
    const config: PluginConfig = {
      agents: {
        orchestrator: { variant: 'high' },
      },
    };
    const agents = createAgents(config);
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(orchestrator?.config.variant).toBe('high');
  });

  test('orchestrator stores model array with per-model variants in _modelArray', () => {
    const config: PluginConfig = {
      agents: {
        orchestrator: {
          model: [
            { id: 'google/gemini-3-pro', variant: 'high' },
            { id: 'github-copilot/claude-3.5-haiku' },
            'openai/gpt-4',
          ],
        },
      },
    };
    const agents = createAgents(config);
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(orchestrator?._modelArray).toEqual([
      { id: 'google/gemini-3-pro', variant: 'high' },
      { id: 'github-copilot/claude-3.5-haiku' },
      { id: 'openai/gpt-4' },
    ]);
    expect(orchestrator?.config.model).toBeUndefined();
  });
});

describe('per-model variant in array config', () => {
  test('subagent stores model array with per-model variants', () => {
    const config: PluginConfig = {
      agents: {
        explorer: {
          model: [
            { id: 'google/gemini-3-flash', variant: 'low' },
            'openai/gpt-4o-mini',
          ],
        },
      },
    };
    const agents = createAgents(config);
    const explorer = agents.find((a) => a.name === 'explorer');
    expect(explorer?._modelArray).toEqual([
      { id: 'google/gemini-3-flash', variant: 'low' },
      { id: 'openai/gpt-4o-mini' },
    ]);
    expect(explorer?.config.model).toBeUndefined();
  });

  test('top-level variant preserved alongside per-model variants', () => {
    const config: PluginConfig = {
      agents: {
        orchestrator: {
          model: [
            { id: 'google/gemini-3-pro', variant: 'high' },
            'openai/gpt-4',
          ],
          variant: 'low',
        },
      },
    };
    const agents = createAgents(config);
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    // top-level variant still set as default
    expect(orchestrator?.config.variant).toBe('low');
    // per-model variants stored in _modelArray
    expect(orchestrator?._modelArray?.[0]?.variant).toBe('high');
    expect(orchestrator?._modelArray?.[1]?.variant).toBeUndefined();
  });
});

describe('skill permissions', () => {
  test('orchestrator gets codemap skill allowed by default', () => {
    const agents = createAgents();
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(orchestrator).toBeDefined();
    const skillPerm = (
      orchestrator?.config.permission as Record<string, unknown>
    )?.skill as Record<string, string>;
    // orchestrator gets wildcard allow (from RECOMMENDED_SKILLS wildcard entry)
    expect(skillPerm?.['*']).toBe('allow');
    // CUSTOM_SKILLS loop must also add a named codemap entry for orchestrator
    expect(skillPerm?.codemap).toBe('allow');
  });

  test('fixer does not get codemap skill allowed by default', () => {
    const agents = createAgents();
    const fixer = agents.find((a) => a.name === 'fixer');
    expect(fixer).toBeDefined();
    const skillPerm = (fixer?.config.permission as Record<string, unknown>)
      ?.skill as Record<string, string>;
    expect(skillPerm?.codemap).not.toBe('allow');
  });

  test('oracle gets requesting-code-review skill allowed by default', () => {
    const agents = createAgents();
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle).toBeDefined();
    const skillPerm = (oracle?.config.permission as Record<string, unknown>)
      ?.skill as Record<string, string>;
    expect(skillPerm?.['requesting-code-review']).toBe('allow');
  });

  test('oracle gets simplify skill allowed by default', () => {
    const agents = createAgents();
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle).toBeDefined();
    const skillPerm = (oracle?.config.permission as Record<string, unknown>)
      ?.skill as Record<string, string>;
    expect(skillPerm?.simplify).toBe('allow');
  });
});

describe('isSubagent type guard', () => {
  test('returns true for valid subagent names', () => {
    expect(isSubagent('explorer')).toBe(true);
    expect(isSubagent('librarian')).toBe(true);
    expect(isSubagent('oracle')).toBe(true);
    expect(isSubagent('designer')).toBe(true);
    expect(isSubagent('fixer')).toBe(true);
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
    // Enable all agents (including observer) for classification testing
    const configs = getAgentConfigs({ disabled_agents: [] });

    // Primary agent
    expect(configs.orchestrator.mode).toBe('primary');

    // Subagents
    for (const name of SUBAGENT_NAMES) {
      // Council is a dual-mode agent ("all"), rest are subagents
      if (name === 'council') {
        expect(configs[name].mode).toBe('all');
      } else {
        expect(configs[name].mode).toBe('subagent');
      }
    }
  });
});

describe('createAgents', () => {
  test('creates all agents without config', () => {
    const agents = createAgents();
    const names = agents.map((a) => a.name);
    expect(names).toContain('orchestrator');
    expect(names).toContain('explorer');
    expect(names).toContain('designer');
    expect(names).toContain('oracle');
    expect(names).toContain('librarian');
    expect(names).toContain('fixer');
  });

  test('creates exactly 9 agents by default (1 orchestrator + 8 subagents, observer disabled)', () => {
    const agents = createAgents();
    expect(agents.length).toBe(9);
  });
});

describe('getAgentConfigs', () => {
  test('returns config record keyed by agent name', () => {
    const configs = getAgentConfigs();
    expect(configs.orchestrator).toBeDefined();
    expect(configs.explorer).toBeDefined();
    // orchestrator has no hardcoded default model; resolved at runtime via
    // chat.message hook when _modelArray is configured, or left to the user
    expect(configs.explorer.model).toBeDefined();
  });

  test('includes description in SDK config', () => {
    const configs = getAgentConfigs();
    expect(configs.orchestrator.description).toBeDefined();
    expect(configs.explorer.description).toBeDefined();
  });
});

describe('council agent model resolution', () => {
  test('council agent uses config.council.master.model', () => {
    const config = {
      council: {
        master: { model: 'anthropic/claude-sonnet-4-6' },
        presets: {
          default: {
            councillors: {
              alpha: { model: 'test/alpha-model' },
            },
            master: undefined,
          },
        },
      },
    } as unknown as PluginConfig;
    const agents = createAgents(config);
    const council = agents.find((a) => a.name === 'council');
    expect(council?.config.model).toBe('anthropic/claude-sonnet-4-6');
  });

  test('council agent falls back to default without council config', () => {
    const agents = createAgents();
    const council = agents.find((a) => a.name === 'council');
    expect(council?.config.model).toBe(DEFAULT_MODELS.council);
  });

  test('council-master agent uses config.council.master.model', () => {
    const config = {
      council: {
        master: { model: 'anthropic/claude-sonnet-4-6' },
        presets: {
          default: {
            councillors: {
              alpha: { model: 'test/alpha-model' },
            },
            master: undefined,
          },
        },
      },
    } as unknown as PluginConfig;
    const agents = createAgents(config);
    const councilMaster = agents.find((a) => a.name === 'council-master');
    expect(councilMaster?.config.model).toBe('anthropic/claude-sonnet-4-6');
  });

  test('council-master agent falls back to default without council config', () => {
    const agents = createAgents();
    const councilMaster = agents.find((a) => a.name === 'council-master');
    expect(councilMaster?.config.model).toBe(DEFAULT_MODELS['council-master']);
  });

  test('councillor agent uses config.council.master.model', () => {
    const config = {
      council: {
        master: { model: 'anthropic/claude-sonnet-4-6' },
        presets: {
          default: {
            councillors: {
              alpha: { model: 'test/alpha-model' },
            },
            master: undefined,
          },
        },
      },
    } as unknown as PluginConfig;
    const agents = createAgents(config);
    const councillor = agents.find((a) => a.name === 'councillor');
    expect(councillor?.config.model).toBe('anthropic/claude-sonnet-4-6');
  });

  test('councillor agent falls back to default without council config', () => {
    const agents = createAgents();
    const councillor = agents.find((a) => a.name === 'councillor');
    expect(councillor?.config.model).toBe(DEFAULT_MODELS.councillor);
  });
});

describe('options passthrough', () => {
  test('options are applied to agent config via overrides', () => {
    const config: PluginConfig = {
      agents: {
        oracle: {
          model: 'openai/gpt-5.4',
          options: { textVerbosity: 'low' },
        },
      },
    };
    const agents = createAgents(config);
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle?.config.options).toEqual({ textVerbosity: 'low' });
  });

  test('options with nested objects are passed through', () => {
    const config: PluginConfig = {
      agents: {
        oracle: {
          model: 'anthropic/claude-sonnet-4-6',
          options: {
            thinking: { type: 'enabled', budgetTokens: 16000 },
          },
        },
      },
    };
    const agents = createAgents(config);
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle?.config.options).toEqual({
      thinking: { type: 'enabled', budgetTokens: 16000 },
    });
  });

  test('options work with other overrides', () => {
    const config: PluginConfig = {
      agents: {
        oracle: {
          model: 'openai/gpt-5.4',
          variant: 'high',
          temperature: 0.7,
          options: { textVerbosity: 'low', reasoningEffort: 'medium' },
        },
      },
    };
    const agents = createAgents(config);
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle?.config.model).toBe('openai/gpt-5.4');
    expect(oracle?.config.variant).toBe('high');
    expect(oracle?.config.temperature).toBe(0.7);
    expect(oracle?.config.options).toEqual({
      textVerbosity: 'low',
      reasoningEffort: 'medium',
    });
  });

  test('options are absent when not configured', () => {
    const config: PluginConfig = {
      agents: {
        oracle: { model: 'openai/gpt-5.4' },
      },
    };
    const agents = createAgents(config);
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle?.config.options).toBeUndefined();
  });

  test('options flow through getAgentConfigs to SDK output', () => {
    const config: PluginConfig = {
      agents: {
        oracle: {
          model: 'openai/gpt-5.4',
          options: { textVerbosity: 'low' },
        },
      },
    };
    const configs = getAgentConfigs(config);
    expect(configs.oracle.options).toEqual({ textVerbosity: 'low' });
  });

  test('options are shallow-merged with existing agent config options', () => {
    // Simulate an agent factory setting default options
    const config: PluginConfig = {
      agents: {
        oracle: {
          model: 'openai/gpt-5.4',
          options: { reasoningEffort: 'medium' },
        },
      },
    };
    const agents = createAgents(config);
    const oracle = agents.find((a) => a.name === 'oracle');
    // Override options should merge with (not replace) any factory defaults
    expect(oracle?.config.options).toEqual({ reasoningEffort: 'medium' });
  });
});

describe('AgentOverrideConfigSchema options validation', () => {
  test('accepts valid options object', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      options: { textVerbosity: 'low' },
    });
    expect(result.success).toBe(true);
  });

  test('accepts empty options object', () => {
    const result = AgentOverrideConfigSchema.safeParse({ options: {} });
    expect(result.success).toBe(true);
  });

  test('accepts nested values in options', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      options: {
        thinking: { type: 'enabled', budgetTokens: 16000 },
      },
    });
    expect(result.success).toBe(true);
  });

  test('accepts options alongside other fields', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.4',
      variant: 'high',
      temperature: 0.7,
      options: { textVerbosity: 'low' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.options).toEqual({ textVerbosity: 'low' });
    }
  });

  test('config without options is valid', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.4',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.options).toBeUndefined();
    }
  });

  test('rejects non-object options', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      options: 'not-an-object',
    });
    expect(result.success).toBe(false);
  });
});

describe('disabled_agents', () => {
  test('disabled agents are not created', () => {
    const config: PluginConfig = {
      disabled_agents: ['designer', 'fixer'],
    };
    const agents = createAgents(config);
    const names = agents.map((a) => a.name);
    expect(names).not.toContain('designer');
    expect(names).not.toContain('fixer');
    expect(names).toContain('orchestrator');
    expect(names).toContain('explorer');
    expect(names).toContain('oracle');
    expect(names).toContain('librarian');
  });

  test('protected agents cannot be disabled', () => {
    const config: PluginConfig = {
      disabled_agents: ['orchestrator', 'councillor', 'council-master'],
    };
    const agents = createAgents(config);
    const names = agents.map((a) => a.name);
    expect(names).toContain('orchestrator');
    expect(names).toContain('councillor');
    expect(names).toContain('council-master');
  });

  test('disabling council disables all council agents', () => {
    const config: PluginConfig = {
      disabled_agents: ['council'],
    };
    const agents = createAgents(config);
    const names = agents.map((a) => a.name);
    expect(names).not.toContain('council');
    // councillor and council-master are protected, they stay
    expect(names).toContain('councillor');
    expect(names).toContain('council-master');
  });

  test('agent count decreases when agents are disabled', () => {
    const agents = createAgents();
    expect(agents.length).toBe(9); // 1 + 8 (observer disabled by default)

    const disabledConfig: PluginConfig = {
      disabled_agents: ['observer', 'designer'],
    };
    const disabledAgents = createAgents(disabledConfig);
    expect(disabledAgents.length).toBe(8);
  });

  test('getDisabledAgents respects protection rules', () => {
    const config: PluginConfig = {
      disabled_agents: ['orchestrator', 'designer', 'councillor'],
    };
    const disabled = getDisabledAgents(config);
    expect(disabled.has('designer')).toBe(true);
    expect(disabled.has('orchestrator')).toBe(false);
    expect(disabled.has('councillor')).toBe(false);
  });

  test('getEnabledAgentNames filters correctly', () => {
    const config: PluginConfig = {
      disabled_agents: ['designer', 'fixer'],
    };
    const enabled = getEnabledAgentNames(config);
    expect(enabled).not.toContain('designer');
    expect(enabled).not.toContain('fixer');
    expect(enabled).toContain('orchestrator');
    expect(enabled).toContain('explorer');
  });

  test('empty disabled_agents creates all agents including observer', () => {
    const config: PluginConfig = {
      disabled_agents: [],
    };
    const agents = createAgents(config);
    expect(agents.length).toBe(10);
    expect(agents.map((a) => a.name)).toContain('observer');
  });
});

describe('observer agent', () => {
  test('observer is disabled by default', () => {
    const agents = createAgents();
    const names = agents.map((a) => a.name);
    expect(names).not.toContain('observer');
  });

  test('observer is enabled when removed from disabled_agents', () => {
    const config: PluginConfig = {
      disabled_agents: [],
    };
    const agents = createAgents(config);
    const names = agents.map((a) => a.name);
    expect(names).toContain('observer');
  });

  test('observer is disabled when explicitly listed', () => {
    const config: PluginConfig = {
      disabled_agents: ['observer'],
    };
    const agents = createAgents(config);
    const names = agents.map((a) => a.name);
    expect(names).not.toContain('observer');
  });

  test('observer can be enabled alongside other disabled agents', () => {
    const config: PluginConfig = {
      disabled_agents: ['designer'],
    };
    const agents = createAgents(config);
    const names = agents.map((a) => a.name);
    expect(names).toContain('observer');
    expect(names).not.toContain('designer');
  });

  test('DEFAULT_DISABLED_AGENTS contains observer', () => {
    expect(DEFAULT_DISABLED_AGENTS).toContain('observer');
  });
});

describe('custom agents', () => {
  test('custom agent is created when config defines non-built-in name with model', () => {
    const config: PluginConfig = {
      agents: {
        janitor: {
          model: 'anthropic/claude-sonnet-4-20250514',
          prompt: 'You clean up code.',
          description: 'Code cleanup specialist',
        },
      },
    };
    const agents = createAgents(config);
    const janitor = agents.find((a) => a.name === 'janitor');
    expect(janitor).toBeDefined();
  });

  test('custom agent is skipped with console.warn when no model provided', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const config: PluginConfig = {
      agents: {
        janitor: {
          prompt: 'You clean up code.',
        },
      },
    };
    const agents = createAgents(config);
    const janitor = agents.find((a) => a.name === 'janitor');
    expect(janitor).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Custom agent 'janitor' skipped"),
    );
    warnSpy.mockRestore();
  });

  test('custom agent appears in agents array after built-in subagents', () => {
    const config: PluginConfig = {
      agents: {
        janitor: { model: 'test/janitor-model' },
      },
    };
    const agents = createAgents(config);
    const janitorIndex = agents.findIndex((a) => a.name === 'janitor');
    const orchestratorIndex = agents.findIndex(
      (a) => a.name === 'orchestrator',
    );
    // Orchestrator is first; custom agents come after built-ins
    expect(janitorIndex).toBeGreaterThan(orchestratorIndex);
    expect(janitorIndex).toBeGreaterThan(0);
  });

  test('custom agent gets inline prompt from config', () => {
    const spy = spyOn(loader, 'loadAgentPrompt').mockReturnValue({});
    try {
      const config: PluginConfig = {
        agents: {
          janitor: {
            model: 'test/janitor-model',
            prompt: 'You clean up code.',
          },
        },
      };
      const agents = createAgents(config);
      const janitor = agents.find((a) => a.name === 'janitor');
      expect(janitor?.config.prompt).toBe('You clean up code.');
    } finally {
      spy.mockRestore();
    }
  });

  test('custom agent gets description from config', () => {
    const config: PluginConfig = {
      agents: {
        janitor: {
          model: 'test/janitor-model',
          description: 'Code cleanup specialist',
        },
      },
    };
    const agents = createAgents(config);
    const janitor = agents.find((a) => a.name === 'janitor');
    expect(janitor?.description).toBe('Code cleanup specialist');
  });

  test('custom agent uses default description when not provided', () => {
    const config: PluginConfig = {
      agents: {
        janitor: { model: 'test/janitor-model' },
      },
    };
    const agents = createAgents(config);
    const janitor = agents.find((a) => a.name === 'janitor');
    expect(janitor?.description).toBe('Custom agent: janitor');
  });

  test('custom agent is classified as mode subagent in getAgentConfigs', () => {
    const config: PluginConfig = {
      agents: {
        janitor: {
          model: 'test/janitor-model',
          description: 'Code cleanup specialist',
        },
      },
    };
    const configs = getAgentConfigs(config);
    expect(configs.janitor).toBeDefined();
    expect(configs.janitor.mode).toBe('subagent');
  });

  test('custom agent description appears in orchestrator prompt', () => {
    const config: PluginConfig = {
      agents: {
        janitor: {
          model: 'test/janitor-model',
          description: 'Code cleanup specialist',
        },
      },
    };
    const agents = createAgents(config);
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(orchestrator?.config.prompt).toContain('Code cleanup specialist');
  });

  test('multiple custom agents can be created', () => {
    const config: PluginConfig = {
      agents: {
        janitor: { model: 'test/janitor-model' },
        reviewer: {
          model: 'test/reviewer-model',
          description: 'Code reviewer',
        },
      },
    };
    const agents = createAgents(config);
    expect(agents.find((a) => a.name === 'janitor')).toBeDefined();
    expect(agents.find((a) => a.name === 'reviewer')).toBeDefined();
  });

  test('custom agents do not interfere with built-in agents', () => {
    const config: PluginConfig = {
      agents: {
        janitor: { model: 'test/janitor-model' },
        reviewer: { model: 'test/reviewer-model' },
      },
    };
    const agents = createAgents(config);
    // 9 default (observer disabled) + 2 custom
    expect(agents.length).toBe(11);
    expect(agents.find((a) => a.name === 'explorer')).toBeDefined();
    expect(agents.find((a) => a.name === 'fixer')).toBeDefined();
  });

  test('legacy aliases are NOT treated as custom agents', () => {
    const config: PluginConfig = {
      agents: {
        explore: { model: 'test/model' },
      },
    };
    const customNames = getCustomAgentNames(config);
    expect(customNames).not.toContain('explore');
    // Should map to explorer, not create a new custom agent
    const agents = createAgents(config);
    expect(agents.find((a) => a.name === 'explore')).toBeUndefined();
    expect(agents.find((a) => a.name === 'explorer')).toBeDefined();
  });

  test('built-in agent names in config are NOT treated as custom agents', () => {
    const config: PluginConfig = {
      agents: {
        explorer: { model: 'test/model' },
      },
    };
    const customNames = getCustomAgentNames(config);
    expect(customNames).not.toContain('explorer');
    const agents = createAgents(config);
    // Count should still be 9 (no extra custom agents)
    expect(agents.length).toBe(9);
  });

  test('displayName conflict throws when conflicting with built-in agent name', () => {
    const config: PluginConfig = {
      agents: {
        janitor: {
          model: 'test/janitor-model',
          displayName: 'explorer',
        },
      },
    };
    expect(() => createAgents(config)).toThrow(/conflicts with an agent name/);
  });

  test('displayName conflict throws when conflicting with another custom agent name', () => {
    const config: PluginConfig = {
      agents: {
        janitor: {
          model: 'test/janitor-model',
          displayName: 'reviewer',
        },
        reviewer: {
          model: 'test/reviewer-model',
        },
      },
    };
    expect(() => createAgents(config)).toThrow(/conflicts with an agent name/);
  });

  test('custom agent displayName works and appears in getAgentConfigs', () => {
    const config: PluginConfig = {
      agents: {
        janitor: {
          model: 'test/janitor-model',
          displayName: 'cleaner',
        },
      },
    };
    const configs = getAgentConfigs(config);
    // When displayName is set, agent is keyed by displayName
    expect(configs.cleaner).toBeDefined();
    expect(configs.cleaner.mode).toBe('subagent');
    // Original name still exists but is hidden
    expect(configs.janitor).toBeDefined();
    expect(configs.janitor.hidden).toBe(true);
  });
});
