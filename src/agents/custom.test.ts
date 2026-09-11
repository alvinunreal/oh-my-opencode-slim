import { describe, expect, spyOn, test } from 'bun:test';
import { DEFAULT_MODELS, type PluginConfig } from '../config';
import { RuntimeConfig } from '../config/runtime';
import {
  buildResolvedAgentRegistry,
  createAgents,
  getAgentConfigs,
} from './index';

const TEST_DIRECTORY = 'runtime-test-agents-custom';
function runtimeFor(config: PluginConfig | undefined = {}) {
  RuntimeConfig.reset(TEST_DIRECTORY);
  RuntimeConfig.init(TEST_DIRECTORY, config ?? {});
  return RuntimeConfig.get(TEST_DIRECTORY);
}

describe('custom-agent creation', () => {
  test('infers custom agents from unknown keys', () => {
    const config: PluginConfig = {
      agents: {
        explorer: { model: 'openai/gpt-5.6-luna' },
        reviewer: {
          model: 'openai/gpt-5.6',
          prompt: 'You are the custom reviewer agent.',
        },
      },
    };

    const agents = createAgents(runtimeFor(config));
    const names = agents.map((agent) => agent.name);

    expect(names).toContain('reviewer');

    const customAgent = agents.find((agent) => agent.name === 'reviewer');
    expect(customAgent).toBeDefined();
    expect(customAgent?.config.model).toBe('openai/gpt-5.6');
    expect(customAgent?.config.prompt).toBe(
      'You are the custom reviewer agent.\n\nIf a task is outside your role, do not attempt partial work. Return a brief reason to the orchestrator.',
    );
  });

  test('supports prompt and orchestratorPrompt for custom agents', () => {
    const config: PluginConfig = {
      agents: {
        'test-auditor': {
          model: 'openai/gpt-5.6-luna',
          prompt: 'You are a custom subagent for auditing.',
          orchestratorPrompt:
            '@test-auditor\n- Role: Compliance audit specialist',
        },
      },
    };

    const agents = createAgents(runtimeFor(config));
    const customAgent = agents.find((agent) => agent.name === 'test-auditor');

    expect(customAgent).toBeDefined();
    expect(customAgent?.config.prompt).toBe(
      'You are a custom subagent for auditing.\n\nIf a task is outside your role, do not attempt partial work. Return a brief reason to the orchestrator.',
    );

    const orchestrator = agents.find((agent) => agent.name === 'orchestrator');
    expect(orchestrator?.config.prompt).toContain(
      '@test-auditor\n- Role: Compliance audit specialist',
    );
  });

  test('skips custom agents without a model', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const config: PluginConfig = {
        agents: {
          janitor: {
            prompt: 'You are Janitor.',
            orchestratorPrompt: '@janitor\n- Role: Cleanup specialist',
          },
        },
      };

      const agentDefs = createAgents(runtimeFor(config));
      expect(
        agentDefs.find((agent) => agent.name === 'janitor'),
      ).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        "[oh-my-opencode] Custom agent 'janitor' skipped: 'model' is required",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('does not create or inject disabled custom agents', () => {
    const config: PluginConfig = {
      disabled_agents: ['test-auditor', 'designer'],
      agents: {
        'test-auditor': {
          model: 'openai/gpt-5.6-luna',
          prompt: 'You are a disabled custom agent.',
        },
      },
    };

    const agentDefs = createAgents(runtimeFor(config));
    const names = agentDefs.map((agent) => agent.name);
    expect(names).not.toContain('test-auditor');

    const sdkConfigs = getAgentConfigs(runtimeFor(config));
    expect(sdkConfigs['test-auditor']).toBeUndefined();
  });

  test('rejects unsafe custom agent names', () => {
    const config: PluginConfig = {
      agents: {
        'unsafe/name': {
          model: 'openai/gpt-5.6-luna',
        },
      },
    };

    expect(() => createAgents(runtimeFor(config))).toThrow();
  });

  test('accepts arbitrary orchestratorPrompt text for custom agents', () => {
    const config: PluginConfig = {
      agents: {
        janitor: {
          model: 'openai/gpt-5.6-luna',
          orchestratorPrompt: '@cleanup\n- Role: Cleanup specialist',
        },
      },
    };

    const agents = createAgents(runtimeFor(config));
    const orchestrator = agents.find((agent) => agent.name === 'orchestrator');
    expect(orchestrator?.config.prompt).toContain(
      '@cleanup\n- Role: Cleanup specialist',
    );
  });

  test('role-derived custom agents inherit the canonical role policy', () => {
    const config: PluginConfig = {
      agents: {
        'oracle-derived': {
          baseRole: 'oracle',
          model: 'provider/oracle-derived',
        },
        'librarian-derived': {
          baseRole: 'librarian',
          model: 'provider/librarian-derived',
        },
      },
    };
    const agents = createAgents(runtimeFor(config));
    const derived = agents.find((agent) => agent.name === 'oracle-derived');

    expect(derived?.baseRole).toBe('oracle');
    expect(derived?.config.prompt).toContain('You are Oracle');
    expect(derived?.description).toContain('Strategic technical advisor');
    const registry = buildResolvedAgentRegistry(runtimeFor(config));
    expect(registry.mcpLists['oracle-derived']).toEqual([]);
    expect(registry.skillPermissions['oracle-derived']?.simplify).toBe('allow');
    expect(registry.mcpLists['librarian-derived']).toEqual([
      'context7',
      'gh_grep',
    ]);
  });

  test('creates wrapper agents from acpAgents config', () => {
    const config: PluginConfig = {
      acpAgents: {
        'claude-research': {
          command: 'claude-code-acp',
          args: [],
          env: {},
          timeoutMs: 0,
          permissionMode: 'ask',
          description: 'Claude Code research via ACP',
          wrapperModel: 'openai/gpt-5.6-luna',
        },
      },
    };

    const agents = createAgents(runtimeFor(config));
    const wrapper = agents.find((agent) => agent.name === 'claude-research');
    const orchestrator = agents.find((agent) => agent.name === 'orchestrator');

    expect(wrapper).toBeDefined();
    expect(wrapper?.description).toBe('Claude Code research via ACP');
    expect(wrapper?.config.model).toBe('openai/gpt-5.6-luna');
    expect(wrapper?.config.prompt).toContain('acp_run');
    expect(orchestrator?.config.prompt).toContain('@claude-research');
  });

  test('falls back to active preset primary model for ACP wrappers', () => {
    const config: PluginConfig = {
      preset: 'opencode-go',
      presets: {
        'opencode-go': {
          agents: {
            orchestrator: { model: 'opencode-go/glm-5.2' },
          },
        },
      },
      agents: {
        orchestrator: { model: 'opencode-go/glm-5.2' },
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
    };

    const agents = createAgents(runtimeFor(config));
    const wrapper = agents.find((agent) => agent.name === 'bridge');

    expect(wrapper?.config.model).toBe('opencode-go/glm-5.2');
  });

  test('falls back to oracle model for ACP wrappers', () => {
    const defaults = {
      fixer: DEFAULT_MODELS.fixer,
      librarian: DEFAULT_MODELS.librarian,
      orchestrator: DEFAULT_MODELS.orchestrator,
    };
    DEFAULT_MODELS.fixer = undefined;
    DEFAULT_MODELS.librarian = undefined;
    DEFAULT_MODELS.orchestrator = undefined;

    try {
      const config: PluginConfig = {
        acpAgents: {
          bridge: {
            command: 'bridge-acp',
            args: [],
            env: {},
            timeoutMs: 0,
            permissionMode: 'ask',
          },
        },
      };

      const agents = createAgents(runtimeFor(config));
      const wrapper = agents.find((agent) => agent.name === 'bridge');

      expect(wrapper?.config.model).toBe(DEFAULT_MODELS.oracle);
    } finally {
      DEFAULT_MODELS.fixer = defaults.fixer;
      DEFAULT_MODELS.librarian = defaults.librarian;
      DEFAULT_MODELS.orchestrator = defaults.orchestrator;
    }
  });

  test('rejects acpAgents that conflict with custom agents', () => {
    const config: PluginConfig = {
      agents: {
        bridge: { model: 'openai/gpt-5.6-luna' },
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
    };

    expect(() => createAgents(runtimeFor(config))).toThrow(
      "ACP agent 'bridge' conflicts with a custom agent of the same name",
    );
  });

  test('rejects acpAgents that conflict with built-in agents', () => {
    const config: PluginConfig = {
      acpAgents: {
        fixer: {
          command: 'fixer-acp',
          args: [],
          env: {},
          timeoutMs: 0,
          permissionMode: 'ask',
        },
      },
    };

    expect(() => createAgents(runtimeFor(config))).toThrow(
      "ACP agent 'fixer' conflicts with a built-in agent name or alias",
    );
  });

  test('folds custom and ACP routing prompts into their route entries', () => {
    const config: PluginConfig = {
      agents: {
        explorer: {
          model: 'openai/gpt-5.6-luna',
          displayName: 'fancy-explorer',
        },
        janitor: {
          model: 'openai/gpt-5.6',
          orchestratorPrompt:
            'Please use @janitor to clean up after @explorer has completed.',
        },
      },
      acpAgents: {
        'claude-research': {
          command: 'claude-code-acp',
          args: [],
          env: {},
          timeoutMs: 0,
          permissionMode: 'ask',
          orchestratorPrompt:
            'Please delegate research tasks to @claude-research or @explorer.',
        },
      },
    };

    const agents = createAgents(runtimeFor(config));
    const orchestrator = agents.find((agent) => agent.name === 'orchestrator');
    const prompt = orchestrator?.config.prompt ?? '';

    // Both guidance blocks are part of their agent's single route entry.
    expect(prompt).not.toContain('# Project-specific routing guidance');
    expect(prompt).toContain(
      'Please use @janitor to clean up after @fancy-explorer has completed.',
    );

    // Verify ACP routing guidance is embedded in its route entry.
    // (i.e. it comes after or is separate, let's verify exact substring sequence or that the ACP test isn't inside the heading section)
    expect(prompt.match(/Please use @janitor/g)?.length).toBe(1);
    // Both guidance snippets should be present exactly once in the prompt.
    // Wait, in our implementation, order of appending is:
    // 1) overridden/custom prompts under # Project-specific routing guidance.
    // 2) ACP routing prompts (without the header).
    // So headingContent (everything after the header) will contain the custom prompt, and then at the very end (or separated), the ACP prompt.
    // But the ACP prompt is not under that header's specific block if it's appended separately.
    // Wait, is there a way to verify they are separated? Yes, we can verify that the custom prompt block and ACP prompt block are two separate parts,
    // and that ACP prompt is appended at the very end of the string, outside of the heading's contiguous text block or that if only ACP is present, the heading doesn't show up.
    expect(prompt).toContain(
      'Please delegate research tasks to @claude-research or @fancy-explorer.',
    );
    expect(
      prompt.match(
        /Please delegate research tasks to @claude-research or @fancy-explorer\./g,
      )?.length,
    ).toBe(1);

    // Let's also check a scenario where only ACP routing prompt is present. There should be NO heading at all!
    const configOnlyAcp: PluginConfig = {
      agents: {
        explorer: {
          model: 'openai/gpt-5.6-luna',
          displayName: 'fancy-explorer',
        },
      },
      acpAgents: {
        'claude-research': {
          command: 'claude-code-acp',
          args: [],
          env: {},
          timeoutMs: 0,
          permissionMode: 'ask',
          orchestratorPrompt:
            'Please delegate research tasks to @claude-research or @explorer.',
        },
      },
    };

    const agentsOnlyAcp = createAgents(runtimeFor(configOnlyAcp));
    const orchestratorOnlyAcp = agentsOnlyAcp.find(
      (agent) => agent.name === 'orchestrator',
    );
    const promptOnlyAcp = orchestratorOnlyAcp?.config.prompt ?? '';

    expect(promptOnlyAcp).not.toContain('# Project-specific routing guidance');
    expect(promptOnlyAcp).toContain(
      'Please delegate research tasks to @claude-research or @fancy-explorer.',
    );
  });
});

describe('custom-agent permission passthrough', () => {
  test('passes user permission through to agent config', () => {
    const config: PluginConfig = {
      agents: {
        planner: {
          model: 'openai/gpt-5.5',
          permission: { edit: 'deny', bash: 'ask' },
        },
      },
    };

    const agents = createAgents(runtimeFor(config));
    const planner = agents.find((a) => a.name === 'planner');

    expect(planner).toBeDefined();
    expect(planner?.config.permission).toMatchObject({
      edit: 'deny',
      bash: 'ask',
    });
  });

  test('applies permission to built-in agent overrides', () => {
    const config: PluginConfig = {
      agents: {
        explorer: {
          model: 'openai/gpt-5.5',
          permission: { edit: 'deny' },
        },
      },
    };

    const agents = createAgents(runtimeFor(config));
    const explorer = agents.find((a) => a.name === 'explorer');

    expect(explorer).toBeDefined();
    expect(explorer?.config.permission).toMatchObject({
      edit: 'deny',
    });
  });

  test('user edit/bash survive merge with skills config', () => {
    const config: PluginConfig = {
      agents: {
        planner: {
          model: 'openai/gpt-5.5',
          skills: ['my-skill'],
          permission: { edit: 'deny', bash: 'ask' },
        },
      },
    };

    const agents = createAgents(runtimeFor(config));
    const planner = agents.find((a) => a.name === 'planner');

    expect(planner).toBeDefined();
    // User-supplied keys survive
    expect(planner?.config.permission).toMatchObject({
      edit: 'deny',
      bash: 'ask',
    });
    // Plugin generates skill rule (overrides any user skill key)
    expect(
      (planner?.config.permission as Record<string, unknown>)?.skill,
    ).toBeDefined();
  });

  test('passes permission through unchanged without skills or mcps', () => {
    const config: PluginConfig = {
      agents: {
        researcher: {
          model: 'openai/gpt-5.5',
          permission: { edit: 'deny', webfetch: 'allow' },
        },
      },
    };

    const agents = createAgents(runtimeFor(config));
    const researcher = agents.find((a) => a.name === 'researcher');

    expect(researcher).toBeDefined();
    expect(researcher?.config.permission).toMatchObject({
      edit: 'deny',
      webfetch: 'allow',
    });
  });

  test('no permission field means no regression', () => {
    const config: PluginConfig = {
      agents: {
        reviewer: {
          model: 'openai/gpt-5.5',
          prompt: 'You are a reviewer.',
        },
      },
    };

    const agents = createAgents(runtimeFor(config));
    const reviewer = agents.find((a) => a.name === 'reviewer');

    expect(reviewer).toBeDefined();
    // Plugin still generates its own permission keys (question, etc.)
    expect(reviewer?.config.permission).toBeDefined();
    // But no edit/bash keys since user didn't set them
    expect(
      (reviewer?.config.permission as Record<string, unknown>)?.edit,
    ).toBeUndefined();
  });
});

describe('permission edge cases', () => {
  test('shorthand string permission is not corrupted by applyDefaultPermissions', () => {
    const config: PluginConfig = {
      agents: {
        planner: {
          model: 'openai/gpt-5.5',
          permission: 'ask',
        },
      },
    };

    const agents = createAgents(runtimeFor(config));
    const planner = agents.find((a) => a.name === 'planner');

    expect(planner).toBeDefined();
    // Shorthand permissions are normalized before defaults and gates apply.
    expect(planner?.config.permission).toMatchObject({ '*': 'ask' });
  });

  test('orchestrator permission override does not replace plugin gates', () => {
    const config: PluginConfig = {
      agents: {
        orchestrator: {
          model: 'openai/gpt-5.5',
          permission: { edit: 'deny' },
        },
      },
    };

    const agents = createAgents(runtimeFor(config));
    const orchestrator = agents.find((a) => a.name === 'orchestrator');

    expect(orchestrator).toBeDefined();
    // User-supplied key survives
    expect(orchestrator?.config.permission).toMatchObject({
      edit: 'deny',
    });
    // Plugin-generated gates are NOT dropped by the override
    expect(
      (orchestrator?.config.permission as Record<string, unknown>)?.question,
    ).toBeDefined();
    expect(
      (orchestrator?.config.permission as Record<string, unknown>)?.task_cancel,
    ).toBeDefined();
  });
});
