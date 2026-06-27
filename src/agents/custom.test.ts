import { describe, expect, spyOn, test } from 'bun:test';
import { DEFAULT_MODELS, type PluginConfig } from '../config';
import { createAgents, getAgentConfigs } from './index';

describe('custom-agent creation', () => {
  test('infers custom agents from unknown keys', () => {
    const config: PluginConfig = {
      agents: {
        explorer: { model: 'openai/gpt-5.4-mini' },
        reviewer: {
          model: 'openai/gpt-5.5',
          prompt: 'You are the custom reviewer agent.',
        },
      },
    };

    const agents = createAgents(config);
    const names = agents.map((agent) => agent.name);

    expect(names).toContain('reviewer');

    const customAgent = agents.find((agent) => agent.name === 'reviewer');
    expect(customAgent).toBeDefined();
    expect(customAgent?.config.model).toBe('openai/gpt-5.5');
    expect(customAgent?.config.prompt).toBe(
      'You are the custom reviewer agent.',
    );
  });

  test('supports prompt and orchestratorPrompt for custom agents', () => {
    const config: PluginConfig = {
      agents: {
        'test-auditor': {
          model: 'openai/gpt-5.4-mini',
          prompt: 'You are a custom subagent for auditing.',
          orchestratorPrompt:
            '@test-auditor\n- Role: Compliance audit specialist',
        },
      },
    };

    const agents = createAgents(config);
    const customAgent = agents.find((agent) => agent.name === 'test-auditor');

    expect(customAgent).toBeDefined();
    expect(customAgent?.config.prompt).toBe(
      'You are a custom subagent for auditing.',
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

      const agentDefs = createAgents(config);
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
          model: 'openai/gpt-5.4-mini',
          prompt: 'You are a disabled custom agent.',
        },
      },
    };

    const agentDefs = createAgents(config);
    const names = agentDefs.map((agent) => agent.name);
    expect(names).not.toContain('test-auditor');

    const sdkConfigs = getAgentConfigs(config);
    expect(sdkConfigs['test-auditor']).toBeUndefined();
  });

  test('rejects unsafe custom agent names', () => {
    const config: PluginConfig = {
      agents: {
        'unsafe/name': {
          model: 'openai/gpt-5.4-mini',
        },
      },
    };

    expect(() => createAgents(config)).toThrow();
  });

  test('accepts arbitrary orchestratorPrompt text for custom agents', () => {
    const config: PluginConfig = {
      agents: {
        janitor: {
          model: 'openai/gpt-5.4-mini',
          orchestratorPrompt: '@cleanup\n- Role: Cleanup specialist',
        },
      },
    };

    const agents = createAgents(config);
    const orchestrator = agents.find((agent) => agent.name === 'orchestrator');
    expect(orchestrator?.config.prompt).toContain(
      '@cleanup\n- Role: Cleanup specialist',
    );
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
          wrapperModel: 'openai/gpt-5.4-mini',
        },
      },
    };

    const agents = createAgents(config);
    const wrapper = agents.find((agent) => agent.name === 'claude-research');
    const orchestrator = agents.find((agent) => agent.name === 'orchestrator');

    expect(wrapper).toBeDefined();
    expect(wrapper?.description).toBe('Claude Code research via ACP');
    expect(wrapper?.config.model).toBe('openai/gpt-5.4-mini');
    expect(wrapper?.config.prompt).toContain('acp_run');
    expect(orchestrator?.config.prompt).toContain('@claude-research');
  });

  test('falls back to active preset primary model for ACP wrappers', () => {
    const config: PluginConfig = {
      preset: 'opencode-go',
      presets: {
        'opencode-go': {
          orchestrator: { model: 'opencode-go/glm-5.1' },
        },
      },
      agents: {
        orchestrator: { model: 'opencode-go/glm-5.1' },
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

    const agents = createAgents(config);
    const wrapper = agents.find((agent) => agent.name === 'bridge');

    expect(wrapper?.config.model).toBe('opencode-go/glm-5.1');
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

      const agents = createAgents(config);
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
        bridge: { model: 'openai/gpt-5.4-mini' },
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

    expect(() => createAgents(config)).toThrow(
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

    expect(() => createAgents(config)).toThrow(
      "ACP agent 'fixer' conflicts with a built-in agent name or alias",
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

    const agents = createAgents(config);
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

    const agents = createAgents(config);
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

    const agents = createAgents(config);
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

    const agents = createAgents(config);
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

    const agents = createAgents(config);
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

    const agents = createAgents(config);
    const planner = agents.find((a) => a.name === 'planner');

    expect(planner).toBeDefined();
    // The shorthand string should be preserved as-is, not spread into
    // character keys like { "0": "a", "1": "s", "2": "k" }
    expect(planner?.config.permission).toBe('ask');
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

    const agents = createAgents(config);
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
      (orchestrator?.config.permission as Record<string, unknown>)
        ?.council_session,
    ).toBeDefined();
    expect(
      (orchestrator?.config.permission as Record<string, unknown>)?.cancel_task,
    ).toBeDefined();
  });
});
