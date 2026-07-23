import { describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../config';
import {
  AgentOverrideConfigSchema,
  CouncilConfigSchema,
  DEFAULT_DISABLED_AGENTS,
  DEFAULT_MODELS,
  PluginConfigSchema,
  SUBAGENT_NAMES,
} from '../config';
import {
  createAgents,
  getAgentConfigs,
  getDisabledAgents,
  isSubagent,
} from './index';
import { TASK_REJECTION_INSTRUCTION } from './task-rejection';

function councilConfig() {
  const parsed = CouncilConfigSchema.parse({
    presets: { default: { alpha: { model: 'test/councillor' } } },
  });
  return parsed;
}

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

describe('built-in subagent preset fallback', () => {
  test('subagents missing from the active preset inherit the preset orchestrator model', () => {
    const config: PluginConfig = {
      preset: 'opencode-go',
      presets: {
        'opencode-go': {
          orchestrator: { model: 'opencode-go/glm-5.2' },
        },
      },
      council: councilConfig(),
      disabled_agents: [],
    };

    const agents = createAgents(config);

    for (const name of ['observer', 'council', 'councillor'] as const) {
      expect(agents.find((a) => a.name === name)?.config.model).toBe(
        'opencode-go/glm-5.2',
      );
    }
  });

  test('subagents missing from the active preset inherit the first subagent preset model when orchestrator is absent', () => {
    const config: PluginConfig = {
      preset: 'minimal',
      presets: {
        minimal: {
          oracle: { model: 'anthropic/claude-sonnet-4-6' },
        },
      },
      agents: {
        orchestrator: { model: 'root-orchestrator-model' },
      },
      disabled_agents: [],
    };

    const agents = createAgents(config);
    const observer = agents.find((a) => a.name === 'observer');

    expect(observer?.config.model).toBe('anthropic/claude-sonnet-4-6');
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
    expect(
      (orchestrator as { config: { permission: Record<string, unknown> } })
        .config.permission.question,
    ).toBe('allow');
  });

  test('orchestrator is allowed to invoke cancel_task', () => {
    const agents = createAgents();
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(
      (orchestrator as { config: { permission: Record<string, unknown> } })
        .config.permission.cancel_task,
    ).toBe('allow');
  });

  test('orchestrator is allowed to invoke wait_for_user', () => {
    const agents = createAgents();
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(
      (orchestrator as { config: { permission: Record<string, unknown> } })
        .config.permission.wait_for_user,
    ).toBe('allow');
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
    // orchestrator is the long-lived foreground agent: config.model must
    // stay undefined so a user's runtime /model selection (tracked via
    // opencodeConfig.agent.orchestrator.model) is never overwritten by
    // the config's static array default. See src/agents/index.ts:166.
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
    expect(explorer?.config.model).toBe('google/gemini-3-flash');
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
  test('orchestrator gets command-style bundled skills allowed by default', () => {
    const agents = createAgents();
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(orchestrator).toBeDefined();
    const skillPerm = (
      orchestrator?.config.permission as Record<string, unknown>
    )?.skill as Record<string, string>;
    // orchestrator gets wildcard allow by default
    expect(skillPerm?.['*']).toBe('allow');
    // CUSTOM_SKILLS loop must also add a named codemap entry for orchestrator
    expect(skillPerm?.codemap).toBe('allow');
    expect(skillPerm?.clonedeps).toBe('allow');
  });

  test('fixer does not get codemap skill allowed by default', () => {
    const agents = createAgents();
    const fixer = agents.find((a) => a.name === 'fixer');
    expect(fixer).toBeDefined();
    const skillPerm = (fixer?.config.permission as Record<string, unknown>)
      ?.skill as Record<string, string>;
    expect(skillPerm?.codemap).not.toBe('allow');
    expect(skillPerm?.clonedeps).not.toBe('allow');
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

describe('tool permissions', () => {
  test('dynamic councillor agents are prefixed to avoid reserved agent type names', () => {
    const agents = createAgents({ council: councilConfig() });
    expect(agents.some((a) => a.name === 'councillor-alpha')).toBe(true);
    expect(agents.some((a) => a.name === 'alpha')).toBe(false);
  });

  test('oracle is denied access to cancel_task', () => {
    const agents = createAgents();
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(
      (oracle as { config: { permission: Record<string, unknown> } }).config
        .permission.cancel_task,
    ).toBe('deny');
  });

  test('explorer is denied access to cancel_task', () => {
    const agents = createAgents();
    const explorer = agents.find((a) => a.name === 'explorer');
    expect(
      (explorer as { config: { permission: Record<string, unknown> } }).config
        .permission.cancel_task,
    ).toBe('deny');
  });

  test('fixer is denied access to cancel_task', () => {
    const agents = createAgents();
    const fixer = agents.find((a) => a.name === 'fixer');
    expect(
      (fixer as { config: { permission: Record<string, unknown> } }).config
        .permission.cancel_task,
    ).toBe('deny');
  });

  test('subagents are denied access to wait_for_user', () => {
    const agents = createAgents();

    for (const name of ['oracle', 'explorer', 'fixer']) {
      const agent = agents.find((candidate) => candidate.name === name);
      expect(
        (agent as { config: { permission: Record<string, unknown> } }).config
          .permission.wait_for_user,
      ).toBe('deny');
    }
  });

  test('council agent has synthesis-only (deny-all) permissions', () => {
    const agents = createAgents({
      council: councilConfig(),
    });
    const council = agents.find((a) => a.name === 'council');
    const permission = council?.config.permission as Record<string, string>;
    expect(permission['*']).toBe('deny');
    expect(permission.read).toBe('deny');
    expect(permission.glob).toBe('deny');
    expect(permission.grep).toBe('deny');
    expect(permission.ast_grep_search).toBe('deny');
    expect(permission.codesearch).toBe('deny');
    expect(permission.lsp).toBe('deny');
    expect(permission.list).toBe('deny');
    expect(permission.bash).toBe('deny');
    expect(permission.edit).toBe('deny');
    expect(permission.write).toBe('deny');
    expect(permission.apply_patch).toBe('deny');
    expect(permission.ast_grep_replace).toBe('deny');
    expect(permission.task).toBe('deny');
    expect(permission.question).toBe('deny');
  });

  test('councillor remains read-only after default permissions are applied', () => {
    const agents = createAgents({
      council: councilConfig(),
    });
    const councillor = agents.find((a) => a.name === 'councillor');
    const permission = councillor?.config.permission as Record<string, string>;
    expect(permission['*']).toBe('deny');
    expect(permission.read).toBe('allow');
    expect(permission.glob).toBe('allow');
    expect(permission.grep).toBe('allow');
    expect(permission.bash).toBe('deny');
    expect(permission.edit).toBe('deny');
    expect(permission.write).toBe('deny');
    expect(permission.apply_patch).toBe('deny');
    expect(permission.ast_grep_replace).toBe('deny');
    expect(permission.task).toBe('deny');
  });
});

test('orchestrator prompt includes Council Mode block when councillors exist', () => {
  const agents = createAgents({ council: councilConfig() });
  const orchestrator = agents.find((a) => a.name === 'orchestrator');
  const prompt = orchestrator?.config.prompt as string;
  expect(prompt).toContain('## Council Mode');
  expect(prompt).toContain("task(subagent_type='councillor-alpha'");
  expect(prompt).toContain('proceed without it');
});

test('orchestrator prompt excludes Council Mode when no councillors', () => {
  const agents = createAgents();
  const orchestrator = agents.find((a) => a.name === 'orchestrator');
  const prompt = orchestrator?.config.prompt as string;
  expect(prompt).not.toContain('## Council Mode');
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
        expect(configs[name]).toBeUndefined();
      } else {
        expect(configs[name].mode).toBe('subagent');
      }
    }
  });
});

describe('createAgents', () => {
  test('keeps task-rejection instructions in default subagent prompts without modifying replacements', () => {
    const agents = createAgents({
      disabled_agents: [],
      council: councilConfig(),
      agents: {
        explorer: {
          model: 'test/explorer',
          prompt: 'Replacement explorer prompt.',
        },
        reviewer: {
          model: 'test/reviewer',
          prompt: 'Custom reviewer prompt.',
        },
      },
      acpAgents: {
        bridge: {
          command: 'bridge-acp',
          args: [],
          env: {},
          timeoutMs: 0,
          permissionMode: 'ask',
        },
      },
    });

    const orchestrator = agents.find((agent) => agent.name === 'orchestrator');
    const explorer = agents.find((agent) => agent.name === 'explorer');

    expect(explorer?.config.prompt).toBe('Replacement explorer prompt.');
    expect(orchestrator?.config.prompt).not.toContain(
      TASK_REJECTION_INSTRUCTION,
    );
    expect(agents.map((agent) => agent.name)).toEqual(
      expect.arrayContaining([
        'observer',
        'council',
        'councillor',
        'councillor-alpha',
        'reviewer',
        'bridge',
      ]),
    );

    for (const agent of agents.filter((agent) =>
      [
        'observer',
        'council',
        'councillor',
        'councillor-alpha',
        'bridge',
      ].includes(agent.name),
    )) {
      expect(agent.config.prompt).toContain(TASK_REJECTION_INSTRUCTION);
    }
  });

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

  test('creates exactly 7 agents by default (observer disabled, council unconfigured)', () => {
    const agents = createAgents();
    expect(agents.length).toBe(7);
  });

  test('does not create council when council is not configured', () => {
    const agents = createAgents();
    const names = agents.map((a) => a.name);
    const orchestrator = agents.find((a) => a.name === 'orchestrator');

    expect(names).not.toContain('council');
    expect(orchestrator?.config.prompt).not.toContain('@council');
  });

  test('creates council when council is configured', () => {
    const agents = createAgents({
      council: councilConfig(),
    });
    const names = agents.map((a) => a.name);
    const orchestrator = agents.find((a) => a.name === 'orchestrator');

    expect(names).toContain('council');
    expect(orchestrator?.config.prompt).toContain('@council');
  });
});

describe('getAgentConfigs', () => {
  test('returns config record keyed by agent name', () => {
    const configs = getAgentConfigs();
    expect(configs.orchestrator).toBeDefined();
    expect(configs.explorer).toBeDefined();
    // Agents have no hardcoded default model; OpenCode resolves them from the
    // global/session model unless users override per-agent models.
    expect(configs.explorer.model).toBeUndefined();
  });

  test('includes description in SDK config', () => {
    const configs = getAgentConfigs();
    expect(configs.orchestrator.description).toBeDefined();
    expect(configs.explorer.description).toBeDefined();
  });
});

describe('council agent model resolution', () => {
  test('council agent uses default model', () => {
    const agents = createAgents({
      council: councilConfig(),
    });
    const council = agents.find((a) => a.name === 'council');
    expect(council?.config.model).toBe(DEFAULT_MODELS.council);
  });

  test('councillor agent uses default model', () => {
    const agents = createAgents();
    const councillor = agents.find((a) => a.name === 'councillor');
    expect(councillor?.config.model).toBe(DEFAULT_MODELS.councillor);
  });

  test('council uses default when no preset override', () => {
    const config: PluginConfig = {
      council: councilConfig(),
    };
    const agents = createAgents(config);
    const council = agents.find((a) => a.name === 'council');
    expect(council?.config.model).toBe(DEFAULT_MODELS.council);
  });

  test('deprecated council.master field is ignored', () => {
    // Verify that the deprecated master field is reported but not applied.
    const rawCouncilConfig = {
      master: { model: 'anthropic/claude-opus-4-6' },
      presets: {
        default: {
          alpha: { model: 'openai/gpt-5.6-luna' },
        },
      },
    };

    const parsed = CouncilConfigSchema.safeParse(rawCouncilConfig);
    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data._deprecated).toEqual(['master']);
      const config: PluginConfig = {
        council: parsed.data,
      };
      const agents = createAgents(config);
      const council = agents.find((a) => a.name === 'council');
      // Master is deprecated and no longer used for model fallback
      expect(council?.config.model).toBe(DEFAULT_MODELS.council);
    }
  });
});

describe('options passthrough', () => {
  test('options are applied to agent config via overrides', () => {
    const config: PluginConfig = {
      agents: {
        oracle: {
          model: 'openai/gpt-5.6',
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
          model: 'openai/gpt-5.6',
          variant: 'high',
          temperature: 0.7,
          options: { textVerbosity: 'low', reasoningEffort: 'medium' },
        },
      },
    };
    const agents = createAgents(config);
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle?.config.model).toBe('openai/gpt-5.6');
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
        oracle: { model: 'openai/gpt-5.6' },
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
          model: 'openai/gpt-5.6',
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
          model: 'openai/gpt-5.6',
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
      model: 'openai/gpt-5.6',
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
      model: 'openai/gpt-5.6',
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

  test('rejects empty model arrays', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: [],
    });
    expect(result.success).toBe(false);
  });

  test('accepts prompt and orchestratorPrompt override fields', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.6',
      prompt: 'You are a specialized reviewer.',
      orchestratorPrompt: '@reviewer\n- Role: Specialized reviewer',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prompt).toBe('You are a specialized reviewer.');
      expect(result.data.orchestratorPrompt).toBe(
        '@reviewer\n- Role: Specialized reviewer',
      );
    }
  });

  test('rejects empty prompt fields', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.6',
      prompt: '',
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty orchestratorPrompt fields', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.6',
      orchestratorPrompt: '',
    });
    expect(result.success).toBe(false);
  });

  test('accepts description field on overrides', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.6',
      description: 'A custom reviewer agent',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe('A custom reviewer agent');
    }
  });

  test('rejects empty description field', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.6',
      description: '',
    });
    expect(result.success).toBe(false);
  });

  test('description propagates through buildCustomAgentDefinition', () => {
    const config: PluginConfig = {
      agents: {
        reviewer: {
          model: 'openai/gpt-5.6',
          description: 'Code review specialist',
        },
      },
    };
    const agents = createAgents(config);
    const reviewer = agents.find((a) => a.name === 'reviewer');
    expect(reviewer).toBeDefined();
    expect(reviewer?.description).toBe('Code review specialist');
  });

  test('description defaults to generated string when not provided', () => {
    const config: PluginConfig = {
      agents: {
        reviewer: {
          model: 'openai/gpt-5.6',
        },
      },
    };
    const agents = createAgents(config);
    const reviewer = agents.find((a) => a.name === 'reviewer');
    expect(reviewer).toBeDefined();
    expect(reviewer?.description).toBe("Custom subagent 'reviewer'");
  });

  test('description propagates through getAgentConfigs to SDK output', () => {
    const config: PluginConfig = {
      agents: {
        reviewer: {
          model: 'openai/gpt-5.6',
          description: 'SDK reviewer agent',
        },
      },
    };
    const configs = getAgentConfigs(config);
    expect(configs.reviewer.description).toBe('SDK reviewer agent');
  });

  test('description override applies to built-in agents', () => {
    const config: PluginConfig = {
      agents: {
        oracle: {
          model: 'openai/gpt-5.6',
          description: 'Custom oracle description',
        },
      },
    };
    const configs = getAgentConfigs(config);
    expect(configs.oracle.description).toBe('Custom oracle description');
  });
});

describe('PluginConfigSchema custom-agent-only prompt fields', () => {
  test('allows prompt on built-in top-level agent overrides', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        oracle: {
          model: 'openai/gpt-5.6',
          prompt: 'ignored built-in prompt override',
        },
      },
    });

    expect(result.success).toBe(true);
  });

  test('allows orchestratorPrompt on built-in top-level agent overrides', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        explorer: {
          model: 'openai/gpt-5.6-luna',
          orchestratorPrompt: '@explorer\n- Role: should be invalid here',
        },
      },
    });

    expect(result.success).toBe(true);
  });

  test('allows custom-only prompt fields on built-in preset agents', () => {
    const result = PluginConfigSchema.safeParse({
      presets: {
        openai: {
          oracle: {
            model: 'openai/gpt-5.6',
            prompt: 'ignored preset built-in prompt override',
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  test('rejects orchestratorPrompt on orchestrator agent overrides', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        orchestrator: {
          model: 'openai/gpt-5.6-luna',
          orchestratorPrompt: '@orchestrator\n- Role: should be invalid here',
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test('allows prompt fields on custom agents', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        janitor: {
          model: 'openai/gpt-5.6-luna',
          prompt: 'You are Janitor.',
          orchestratorPrompt: '@janitor\n- Role: Cleanup specialist',
        },
      },
    });

    expect(result.success).toBe(true);
  });

  test('accepts backgroundJobs config', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: {
        maxSessionsPerAgent: 2,
        readContextMinLines: 10,
        readContextMaxFiles: 8,
      },
    });

    expect(result.success).toBe(true);
  });

  test('defaults ACP agent timeout to disabled', () => {
    const result = PluginConfigSchema.safeParse({
      acpAgents: {
        research: {
          command: 'research-acp',
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.acpAgents?.research.timeoutMs).toBe(0);
  });

  test('accepts long ACP agent timeouts', () => {
    const result = PluginConfigSchema.safeParse({
      acpAgents: {
        research: {
          command: 'research-acp',
          timeoutMs: 3_600_000,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  test('rejects ACP agent timeouts above timer-safe range', () => {
    const result = PluginConfigSchema.safeParse({
      acpAgents: {
        research: {
          command: 'research-acp',
          timeoutMs: 2_147_483_648,
        },
      },
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
      disabled_agents: ['orchestrator', 'councillor'],
    };
    const agents = createAgents(config);
    const names = agents.map((a) => a.name);
    expect(names).toContain('orchestrator');
    expect(names).toContain('councillor');
  });

  test('disabling council disables council agent', () => {
    const config: PluginConfig = {
      disabled_agents: ['council'],
    };
    const agents = createAgents(config);
    const names = agents.map((a) => a.name);
    expect(names).not.toContain('council');
    // councillor is protected, it stays
    expect(names).toContain('councillor');
  });

  test('agent count decreases when agents are disabled', () => {
    const agents = createAgents();
    expect(agents.length).toBe(7); // observer disabled, council unconfigured

    const disabledConfig: PluginConfig = {
      disabled_agents: ['observer', 'designer'],
    };
    const disabledAgents = createAgents(disabledConfig);
    expect(disabledAgents.length).toBe(6);
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

  test('empty disabled_agents creates observer but not unconfigured council', () => {
    const config: PluginConfig = {
      disabled_agents: [],
    };
    const agents = createAgents(config);
    const names = agents.map((a) => a.name);
    expect(agents.length).toBe(8);
    expect(names).toContain('observer');
    expect(names).not.toContain('council');
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

describe('AgentOverrideConfigSchema permission validation', () => {
  test('accepts object-form permission', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.5',
      permission: { edit: 'deny', bash: 'ask' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permission).toEqual({
        edit: 'deny',
        bash: 'ask',
      });
    }
  });

  test('accepts shorthand string permission', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.5',
      permission: 'ask',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permission).toBe('ask');
    }
  });

  test('rejects invalid action value', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.5',
      permission: { edit: 'alow' },
    });
    expect(result.success).toBe(false);
  });

  test('rejects object value on action-only key', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.5',
      permission: { webfetch: { '*': 'allow' } },
    });
    expect(result.success).toBe(false);
  });

  test('accepts unknown permission key (passthrough)', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.5',
      permission: { custom_tool_name: 'ask' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        (result.data.permission as Record<string, unknown>).custom_tool_name,
      ).toBe('ask');
    }
  });

  test('accepts pattern-based bash rule', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.5',
      permission: {
        bash: { 'git status*': 'allow', '*': 'ask' },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permission).toEqual({
        bash: { 'git status*': 'allow', '*': 'ask' },
      });
    }
  });

  test('rejects invalid action in pattern map', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.5',
      permission: {
        bash: { 'git status*': 'alow' },
      },
    });
    expect(result.success).toBe(false);
  });

  test('rejects array value for unknown permission key', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      model: 'openai/gpt-5.5',
      permission: {
        custom_tool: ['foo', 'bar'],
      },
    });
    expect(result.success).toBe(false);
  });
});
