import { describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../config';
import {
  AgentOverrideConfigSchema,
  CouncilConfigSchema,
  DEFAULT_AGENT_COLORS,
  DEFAULT_DISABLED_AGENTS,
  DEFAULT_MODELS,
  PluginConfigSchema,
  SUBAGENT_NAMES,
} from '../config';
import { RuntimeConfig } from '../config/runtime';
import {
  applyModelInheritanceToConfig,
  createAgents,
  getAgentConfigs,
  getDisabledAgents,
  isSubagent,
} from './index';
import { TASK_REJECTION_INSTRUCTION } from './task-rejection';

const TEST_DIRECTORY = 'runtime-test-agents-index';
function runtimeFor(config: PluginConfig | undefined = {}) {
  RuntimeConfig.reset(TEST_DIRECTORY);
  RuntimeConfig.init(TEST_DIRECTORY, config ?? {});
  return RuntimeConfig.get(TEST_DIRECTORY);
}

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
    const agents = createAgents(runtimeFor(config));
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
    const agents = createAgents(runtimeFor(config));
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
    const agents = createAgents(runtimeFor(config));
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
    const agents = createAgents(runtimeFor(config));
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
    const agents = createAgents(runtimeFor(config));
    const explorer = agents.find((a) => a.name === 'explorer');
    expect(explorer?.config.temperature).toBe(0.5);
  });

  test('variant override via old alias', () => {
    const config: PluginConfig = {
      agents: {
        explore: { variant: 'low' },
      },
    };
    const agents = createAgents(runtimeFor(config));
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

    const agents = createAgents(runtimeFor(config));

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

    const agents = createAgents(runtimeFor(config));
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
    const agents = createAgents(runtimeFor(config));
    const fixer = agents.find((a) => a.name === 'fixer');
    const librarian = agents.find((a) => a.name === 'librarian');
    expect(fixer?.config.model).toBe(librarian?.config.model);
  });

  test('fixer can follow the session model independently of librarian', () => {
    const config: PluginConfig = {
      preset: 'balanced',
      presets: {
        balanced: {
          orchestrator: { model: 'orchestrator-model' },
        },
      },
      agents: {
        librarian: { model: 'librarian-local-model' },
        fixer: { inheritModelFrom: 'session' },
      },
    };
    const agents = createAgents(runtimeFor(config));
    const fixer = agents.find((a) => a.name === 'fixer');
    const librarian = agents.find((a) => a.name === 'librarian');

    expect(librarian?.config.model).toBe('librarian-local-model');
    expect(fixer?.config.model).toBeUndefined();
  });

  test('librarian can follow the orchestrator model independently of fixer', () => {
    const config: PluginConfig = {
      preset: 'balanced',
      presets: {
        balanced: {
          orchestrator: { model: 'orchestrator-model' },
        },
      },
      agents: {
        librarian: { inheritModelFrom: 'orchestrator' },
        fixer: { model: 'fixer-local-model' },
      },
    };
    const agents = createAgents(runtimeFor(config));
    const librarian = agents.find((a) => a.name === 'librarian');
    const fixer = agents.find((a) => a.name === 'fixer');

    expect(librarian?.config.model).toBe('orchestrator-model');
    expect(fixer?.config.model).toBe('fixer-local-model');
  });

  test('model inheritance works when configured inside a preset', () => {
    const config: PluginConfig = {
      preset: 'split',
      presets: {
        split: {
          orchestrator: { model: 'orchestrator-model' },
          librarian: { model: 'librarian-local-model' },
          fixer: { inheritModelFrom: 'session' },
        },
      },
    };
    const agents = createAgents(runtimeFor(config));
    const fixer = agents.find((a) => a.name === 'fixer');
    const librarian = agents.find((a) => a.name === 'librarian');

    expect(librarian?.config.model).toBe('librarian-local-model');
    expect(fixer?.config.model).toBeUndefined();
  });

  test('root inheritance clears a preset model for the same agent', () => {
    const config: PluginConfig = {
      preset: 'split',
      presets: {
        split: {
          orchestrator: { model: 'orchestrator-model' },
          fixer: { model: 'preset-fixer-model' },
        },
      },
      agents: {
        fixer: { inheritModelFrom: 'session' },
      },
    };
    const agents = createAgents(runtimeFor(config));
    const fixer = agents.find((a) => a.name === 'fixer');

    expect(fixer?.config.model).toBeUndefined();
  });

  test('legacy alias inheritance clears a canonical lower-layer model', () => {
    const config: PluginConfig = {
      preset: 'split',
      presets: {
        split: {
          explorer: { model: 'preset/explorer' },
        },
      },
      agents: {
        explore: { inheritModelFrom: 'session' },
      },
    };
    const agents = createAgents(runtimeFor(config));
    const explorer = agents.find((a) => a.name === 'explorer');

    expect(explorer?.config.model).toBeUndefined();
  });

  test('fixer uses its own model when explicitly configured', () => {
    const config: PluginConfig = {
      agents: {
        librarian: { model: 'librarian-model' },
        fixer: { model: 'fixer-specific-model' },
      },
    };
    const agents = createAgents(runtimeFor(config));
    const fixer = agents.find((a) => a.name === 'fixer');
    expect(fixer?.config.model).toBe('fixer-specific-model');
  });

  test('explicit fixer model takes precedence over inheritance policy', () => {
    const config: PluginConfig = {
      agents: {
        librarian: { model: 'librarian-model' },
        fixer: {
          model: 'fixer-specific-model',
          inheritModelFrom: 'session',
        },
      },
    };
    const agents = createAgents(runtimeFor(config));
    const fixer = agents.find((a) => a.name === 'fixer');

    expect(fixer?.config.model).toBe('fixer-specific-model');
  });

  test('custom agents can follow the session model', () => {
    const config: PluginConfig = {
      agents: {
        reviewer: { inheritModelFrom: 'session' },
      },
    };
    const agents = createAgents(runtimeFor(config));
    const reviewer = agents.find((a) => a.name === 'reviewer');

    expect(reviewer).toBeDefined();
    expect(reviewer?.config.model).toBeUndefined();
  });

  test('session inheritance clears a stale host model after config merging', () => {
    const runtime = runtimeFor({
      agents: {
        librarian: { model: 'librarian-local-model' },
        fixer: { inheritModelFrom: 'session' },
      },
    });
    const configAgent: Record<string, unknown> = {
      fixer: { model: 'stale-host-model', temperature: 0.2 },
    };

    applyModelInheritanceToConfig(configAgent, runtime);

    expect(configAgent.fixer).toEqual({ temperature: 0.2 });
  });

  test('orchestrator inheritance replaces a stale host model', () => {
    const runtime = runtimeFor({
      agents: {
        orchestrator: { model: 'orchestrator-model' },
        librarian: { inheritModelFrom: 'orchestrator' },
      },
    });
    const configAgent: Record<string, unknown> = {
      librarian: { model: 'stale-host-model' },
    };

    applyModelInheritanceToConfig(configAgent, runtime);

    expect(configAgent.librarian).toEqual({ model: 'orchestrator-model' });
  });

  test('orchestrator inheritance follows the host orchestrator model', () => {
    const runtime = runtimeFor({
      agents: {
        librarian: { inheritModelFrom: 'orchestrator' },
      },
    });
    runtime.captureHostConfig({
      agent: { orchestrator: { model: 'host-orchestrator-model' } },
    });
    const configAgent: Record<string, unknown> = {
      librarian: { model: 'stale-host-model' },
    };

    applyModelInheritanceToConfig(configAgent, runtime);

    expect(configAgent.librarian).toEqual({ model: 'host-orchestrator-model' });
  });
});

describe('orchestrator agent', () => {
  test('orchestrator is first in agents array', () => {
    const agents = createAgents(runtimeFor());
    expect(agents[0].name).toBe('orchestrator');
  });

  test('orchestrator has question permission set to allow', () => {
    const agents = createAgents(runtimeFor());
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(orchestrator?.config.permission).toBeDefined();
    expect(
      (orchestrator as { config: { permission: Record<string, unknown> } })
        .config.permission.question,
    ).toBe('allow');
  });

  test('orchestrator is allowed to invoke task-control tools', () => {
    const agents = createAgents(runtimeFor());
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    const permission = (
      orchestrator as { config: { permission: Record<string, unknown> } }
    ).config.permission;

    for (const toolName of [
      'task_cancel',
      'task_message',
      'task_revive',
      'task_status',
      'task_result',
    ]) {
      expect(permission[toolName]).toBe('allow');
    }
  });

  test('orchestrator is allowed to invoke wait_for_user', () => {
    const agents = createAgents(runtimeFor());
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
    const agents = createAgents(runtimeFor(config));
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
    const agents = createAgents(runtimeFor(config));
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
    const agents = createAgents(runtimeFor(config));
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
  test('generic subagents propagate primary inline variants to SDK configs', () => {
    const config: PluginConfig = {
      agents: {
        explorer: {
          model: [
            { id: 'google/gemini-3-flash', variant: 'low' },
            'openai/gpt-4o-mini',
          ],
        },
        librarian: {
          model: [
            { id: 'anthropic/claude-haiku-4-5', variant: 'fast' },
            'openai/gpt-4o-mini',
          ],
        },
      },
    };
    const configs = getAgentConfigs(runtimeFor(config));

    expect(configs.explorer.model).toBe('google/gemini-3-flash');
    expect(configs.explorer.variant).toBe('low');
    expect(configs.librarian.model).toBe('anthropic/claude-haiku-4-5');
    expect(configs.librarian.variant).toBe('fast');
  });

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
    const agents = createAgents(runtimeFor(config));
    const explorer = agents.find((a) => a.name === 'explorer');
    expect(explorer?._modelArray).toEqual([
      { id: 'google/gemini-3-flash', variant: 'low' },
      { id: 'openai/gpt-4o-mini' },
    ]);
    expect(explorer?.config.model).toBe('google/gemini-3-flash');
  });

  test('explicit agent-level variant overrides the primary inline variant', () => {
    const configs = getAgentConfigs(
      runtimeFor({
        agents: {
          librarian: {
            model: [
              { id: 'anthropic/claude-haiku-4-5', variant: 'fast' },
              'openai/gpt-4o-mini',
            ],
            variant: 'high',
          },
        },
      }),
    );

    expect(configs.librarian.variant).toBe('high');
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
    const agents = createAgents(runtimeFor(config));
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
    const agents = createAgents(runtimeFor());
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
    const agents = createAgents(runtimeFor());
    const fixer = agents.find((a) => a.name === 'fixer');
    expect(fixer).toBeDefined();
    const skillPerm = (fixer?.config.permission as Record<string, unknown>)
      ?.skill as Record<string, string>;
    expect(skillPerm?.codemap).not.toBe('allow');
    expect(skillPerm?.clonedeps).not.toBe('allow');
  });

  test('oracle gets requesting-code-review skill allowed by default', () => {
    const agents = createAgents(runtimeFor());
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle).toBeDefined();
    const skillPerm = (oracle?.config.permission as Record<string, unknown>)
      ?.skill as Record<string, string>;
    expect(skillPerm?.['requesting-code-review']).toBe('allow');
  });

  test('oracle gets simplify skill allowed by default', () => {
    const agents = createAgents(runtimeFor());
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(oracle).toBeDefined();
    const skillPerm = (oracle?.config.permission as Record<string, unknown>)
      ?.skill as Record<string, string>;
    expect(skillPerm?.simplify).toBe('allow');
  });
});

describe('tool permissions', () => {
  test('dynamic councillor agents are prefixed to avoid reserved agent type names', () => {
    const agents = createAgents(runtimeFor({ council: councilConfig() }));
    expect(agents.some((a) => a.name === 'councillor-alpha')).toBe(true);
    expect(agents.some((a) => a.name === 'alpha')).toBe(false);
  });

  test('oracle is denied access to task-control tools by default', () => {
    const agents = createAgents(runtimeFor());
    const oracle = agents.find((a) => a.name === 'oracle');
    const permission = (
      oracle as { config: { permission: Record<string, unknown> } }
    ).config.permission;

    for (const toolName of [
      'task_cancel',
      'task_message',
      'task_revive',
      'task_status',
      'task_result',
    ]) {
      expect(permission[toolName]).toBe('deny');
    }
  });

  test('explicit task_cancel permission overrides the default gate', () => {
    const agents = createAgents(
      runtimeFor({
        agents: {
          oracle: {
            permission: { task_cancel: 'allow' },
          },
        },
      }),
    );
    const oracle = agents.find((a) => a.name === 'oracle');
    expect(
      (oracle as { config: { permission: Record<string, unknown> } }).config
        .permission.task_cancel,
    ).toBe('allow');
  });

  test('subagents are denied access to wait_for_user', () => {
    const agents = createAgents(runtimeFor());

    for (const name of ['oracle', 'explorer', 'fixer']) {
      const agent = agents.find((candidate) => candidate.name === name);
      expect(
        (agent as { config: { permission: Record<string, unknown> } }).config
          .permission.wait_for_user,
      ).toBe('deny');
    }
  });

  test('council agent has synthesis-only (deny-all) permissions', () => {
    const agents = createAgents(
      runtimeFor({
        council: councilConfig(),
      }),
    );
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
    const agents = createAgents(
      runtimeFor({
        council: councilConfig(),
      }),
    );
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
  const agents = createAgents(runtimeFor({ council: councilConfig() }));
  const orchestrator = agents.find((a) => a.name === 'orchestrator');
  const prompt = orchestrator?.config.prompt as string;
  expect(prompt).toContain('## Council Mode');
  expect(prompt).toContain("task(subagent_type='councillor-alpha'");
  expect(prompt).toContain('proceed without it');
});

test('orchestrator prompt excludes Council Mode when no councillors', () => {
  const agents = createAgents(runtimeFor());
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
    const configs = getAgentConfigs(runtimeFor({ disabled_agents: [] }));

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
    const agents = createAgents(
      runtimeFor({
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
      }),
    );

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
    const agents = createAgents(runtimeFor());
    const names = agents.map((a) => a.name);
    expect(names).toContain('orchestrator');
    expect(names).toContain('explorer');
    expect(names).toContain('designer');
    expect(names).toContain('oracle');
    expect(names).toContain('librarian');
    expect(names).toContain('fixer');
  });

  test('creates exactly 7 agents by default (observer disabled, council unconfigured)', () => {
    const agents = createAgents(runtimeFor());
    expect(agents.length).toBe(7);
  });

  test('does not create council when council is not configured', () => {
    const agents = createAgents(runtimeFor());
    const names = agents.map((a) => a.name);
    const orchestrator = agents.find((a) => a.name === 'orchestrator');

    expect(names).not.toContain('council');
    expect(orchestrator?.config.prompt).not.toContain('@council');
  });

  test('creates council when council is configured', () => {
    const agents = createAgents(
      runtimeFor({
        council: councilConfig(),
      }),
    );
    const names = agents.map((a) => a.name);
    const orchestrator = agents.find((a) => a.name === 'orchestrator');

    expect(names).toContain('council');
    expect(orchestrator?.config.prompt).toContain('@council');
  });
});

describe('getAgentConfigs', () => {
  test('returns config record keyed by agent name', () => {
    const configs = getAgentConfigs(runtimeFor());
    expect(configs.orchestrator).toBeDefined();
    expect(configs.explorer).toBeDefined();
    // Agents have no hardcoded default model; OpenCode resolves them from the
    // global/session model unless users override per-agent models.
    expect(configs.explorer.model).toBeUndefined();
  });

  test('includes description in SDK config', () => {
    const configs = getAgentConfigs(runtimeFor());
    expect(configs.orchestrator.description).toBeDefined();
    expect(configs.explorer.description).toBeDefined();
  });

  test('omits temperature from default SDK agent configs', () => {
    const configs = getAgentConfigs(
      runtimeFor({
        disabled_agents: [],
        council: councilConfig(),
        agents: {
          reviewer: { model: 'test/reviewer' },
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
      }),
    );

    for (const name of [
      'orchestrator',
      'explorer',
      'librarian',
      'oracle',
      'designer',
      'fixer',
      'observer',
      'council',
      'councillor',
      'councillor-alpha',
      'reviewer',
      'bridge',
    ]) {
      expect(Object.hasOwn(configs[name], 'temperature')).toBe(false);
    }
  });

  test('passes explicit temperature overrides to the SDK config', () => {
    const configs = getAgentConfigs(
      runtimeFor({
        agents: {
          explorer: { temperature: 0.5 },
          fixer: { temperature: 0 },
        },
      }),
    );

    expect(configs.explorer.temperature).toBe(0.5);
    expect(configs.fixer.temperature).toBe(0);
  });

  test('applies default colors to every built-in agent', () => {
    const configs = getAgentConfigs(
      runtimeFor({ disabled_agents: [], council: councilConfig() }),
    );

    for (const [name, color] of Object.entries(DEFAULT_AGENT_COLORS)) {
      expect(configs[name]?.color).toBe(color);
    }
    expect(configs['councillor-alpha']?.color).toBe(
      DEFAULT_AGENT_COLORS.councillor,
    );
  });

  test('configured colors override defaults and flow to custom agents', () => {
    const configs = getAgentConfigs(
      runtimeFor({
        agents: {
          oracle: { color: '#A1b2C3' },
          reviewer: {
            model: 'openai/gpt-5.6',
            color: 'warning',
          },
        },
      }),
    );

    expect(configs.oracle.color).toBe('#A1b2C3');
    expect(configs.reviewer.color).toBe('warning');
  });

  test('dynamic councillors inherit configured council color', () => {
    const configs = getAgentConfigs(
      runtimeFor({
        council: councilConfig(),
        agents: { council: { color: '#123ABC' } },
      }),
    );

    expect(configs.council.color).toBe('#123ABC');
    expect(configs['councillor-alpha']?.color).toBe('#123ABC');
  });
});

describe('AgentOverrideConfigSchema color validation', () => {
  test('accepts OpenCode theme colors and six-digit hex colors', () => {
    for (const color of [
      'primary',
      'secondary',
      'accent',
      'success',
      'warning',
      'error',
      'info',
      '#FF5733',
      '#a1B2c3',
    ]) {
      expect(AgentOverrideConfigSchema.safeParse({ color }).success).toBe(true);
    }
  });

  test('rejects unsupported color formats', () => {
    for (const color of ['red', '#FFF', '#GG5733', 'FF5733']) {
      expect(AgentOverrideConfigSchema.safeParse({ color }).success).toBe(
        false,
      );
    }
  });
});

describe('council agent model resolution', () => {
  test('council agent uses default model', () => {
    const agents = createAgents(
      runtimeFor({
        council: councilConfig(),
      }),
    );
    const council = agents.find((a) => a.name === 'council');
    expect(council?.config.model).toBe(DEFAULT_MODELS.council);
  });

  test('councillor agent uses default model', () => {
    const agents = createAgents(runtimeFor());
    const councillor = agents.find((a) => a.name === 'councillor');
    expect(councillor?.config.model).toBe(DEFAULT_MODELS.councillor);
  });

  test('council uses default when no preset override', () => {
    const config: PluginConfig = {
      council: councilConfig(),
    };
    const agents = createAgents(runtimeFor(config));
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
      const agents = createAgents(runtimeFor(config));
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
    const agents = createAgents(runtimeFor(config));
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
    const agents = createAgents(runtimeFor(config));
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
    const agents = createAgents(runtimeFor(config));
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
    const agents = createAgents(runtimeFor(config));
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
    const configs = getAgentConfigs(runtimeFor(config));
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
    const agents = createAgents(runtimeFor(config));
    const oracle = agents.find((a) => a.name === 'oracle');
    // Override options should merge with (not replace) any factory defaults
    expect(oracle?.config.options).toEqual({ reasoningEffort: 'medium' });
  });
});

describe('AgentOverrideConfigSchema options validation', () => {
  test('accepts supported model inheritance sources', () => {
    expect(
      AgentOverrideConfigSchema.safeParse({
        inheritModelFrom: 'session',
      }).success,
    ).toBe(true);
    expect(
      AgentOverrideConfigSchema.safeParse({
        inheritModelFrom: 'orchestrator',
      }).success,
    ).toBe(true);
  });

  test('rejects unsupported model inheritance sources', () => {
    expect(
      AgentOverrideConfigSchema.safeParse({
        inheritModelFrom: 'librarian',
      }).success,
    ).toBe(false);
  });

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
    const agents = createAgents(runtimeFor(config));
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
    const agents = createAgents(runtimeFor(config));
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
    const configs = getAgentConfigs(runtimeFor(config));
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
    const configs = getAgentConfigs(runtimeFor(config));
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
    const agents = createAgents(runtimeFor(config));
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
    const agents = createAgents(runtimeFor(config));
    const names = agents.map((a) => a.name);
    expect(names).toContain('orchestrator');
    expect(names).toContain('councillor');
  });

  test('disabling council disables council agent', () => {
    const config: PluginConfig = {
      disabled_agents: ['council'],
    };
    const agents = createAgents(runtimeFor(config));
    const names = agents.map((a) => a.name);
    expect(names).not.toContain('council');
    // councillor is protected, it stays
    expect(names).toContain('councillor');
  });

  test('agent count decreases when agents are disabled', () => {
    const agents = createAgents(runtimeFor());
    expect(agents.length).toBe(7); // observer disabled, council unconfigured

    const disabledConfig: PluginConfig = {
      disabled_agents: ['observer', 'designer'],
    };
    const disabledAgents = createAgents(runtimeFor(disabledConfig));
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
    const agents = createAgents(runtimeFor(config));
    const names = agents.map((a) => a.name);
    expect(agents.length).toBe(8);
    expect(names).toContain('observer');
    expect(names).not.toContain('council');
  });
});

describe('observer agent', () => {
  test('observer is disabled by default', () => {
    const agents = createAgents(runtimeFor());
    const names = agents.map((a) => a.name);
    expect(names).not.toContain('observer');
  });

  test('observer is enabled when removed from disabled_agents', () => {
    const config: PluginConfig = {
      disabled_agents: [],
    };
    const agents = createAgents(runtimeFor(config));
    const names = agents.map((a) => a.name);
    expect(names).toContain('observer');
  });

  test('observer is disabled when explicitly listed', () => {
    const config: PluginConfig = {
      disabled_agents: ['observer'],
    };
    const agents = createAgents(runtimeFor(config));
    const names = agents.map((a) => a.name);
    expect(names).not.toContain('observer');
  });

  test('observer can be enabled alongside other disabled agents', () => {
    const config: PluginConfig = {
      disabled_agents: ['designer'],
    };
    const agents = createAgents(runtimeFor(config));
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

describe('getDisabledAgents with malformed config', () => {
  test('falls back to DEFAULT_DISABLED_AGENTS when disabled_agents is not an array', () => {
    const config: PluginConfig = {
      disabled_agents: 'not-an-array' as any,
    };
    const disabled = getDisabledAgents(config);
    const expected = getDisabledAgents(undefined);
    expect(disabled).toEqual(expected);
  });

  test('falls back to DEFAULT_DISABLED_AGENTS when disabled_agents is an object', () => {
    const config: PluginConfig = {
      disabled_agents: { invalid: 'object' } as any,
    };
    const disabled = getDisabledAgents(config);
    const expected = getDisabledAgents(undefined);
    expect(disabled).toEqual(expected);
  });

  test('handles valid array normally', () => {
    const config: PluginConfig = {
      disabled_agents: ['explorer'],
    };
    const disabled = getDisabledAgents(config);
    expect(disabled.has('explorer')).toBe(true);
  });
});

describe('createAgents with malformed disabled_tools', () => {
  test('does not throw when disabled_tools is not an array', () => {
    const config: PluginConfig = {
      disabled_tools: 'not-an-array' as any,
    };
    expect(() => createAgents(runtimeFor(config))).not.toThrow();
  });

  test('does not throw when disabled_tools is an object', () => {
    const config: PluginConfig = {
      disabled_tools: {} as any,
    };
    expect(() => createAgents(runtimeFor(config))).not.toThrow();
  });

  test('orchestrator is created with wait_for_user enabled when disabled_tools is malformed', () => {
    const config: PluginConfig = {
      disabled_tools: 'not-an-array' as any,
    };
    const agents = createAgents(runtimeFor(config));
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    expect(orchestrator).toBeDefined();
    // When disabled_tools is malformed (treated as empty array), wait_for_user
    // should be enabled, which is reflected in the prompt text
    expect(orchestrator?.config.prompt).toContain(
      'call `wait_for_user` as your final tool action',
    );
    expect(orchestrator?.config.prompt).not.toContain(
      '`wait_for_user` is disabled',
    );
  });
});
