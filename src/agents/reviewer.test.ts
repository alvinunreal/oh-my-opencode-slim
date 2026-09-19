import { describe, expect, test } from 'bun:test';
import { DEFAULT_MODELS, type PluginConfig } from '../config';
import { RuntimeConfig } from '../config/runtime';
import { createAgents, getAgentConfigs, isSubagent } from './index';
import { createReviewerAgent } from './reviewer';

const TEST_DIRECTORY = 'runtime-test-agents-reviewer';
function runtimeFor(config: PluginConfig | undefined = {}) {
  RuntimeConfig.reset(TEST_DIRECTORY);
  RuntimeConfig.init(TEST_DIRECTORY, config ?? {});
  return RuntimeConfig.get(TEST_DIRECTORY);
}

describe('reviewer agent factory', () => {
  test('builds a read-only reviewer definition with both review modes in the prompt', () => {
    const agent = createReviewerAgent('test/reviewer');
    expect(agent.name).toBe('reviewer');
    expect(agent.config.model).toBe('test/reviewer');
    const prompt = agent.config.prompt ?? '';
    expect(prompt).toContain('review_mode=plan');
    expect(prompt).toContain('review_mode=implementation');
    expect(prompt).toContain('APPROVED');
    expect(prompt).toContain('REVISE');
    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('never edit');
  });

  test('enforces read-only permissions via createReadOnlyAgentPermission', () => {
    const agent = createReviewerAgent('test/reviewer');
    const permission = agent.config.permission as Record<string, string>;
    expect(permission['*']).toBe('deny');
    expect(permission.edit).toBe('deny');
    expect(permission.write).toBe('deny');
    expect(permission.apply_patch).toBe('deny');
    expect(permission.ast_grep_replace).toBe('deny');
    expect(permission.bash).toBe('deny');
    expect(permission.task).toBe('deny');
    expect(permission.read).toBe('allow');
    expect(permission.glob).toBe('allow');
    expect(permission.grep).toBe('allow');
    expect(permission.ast_grep_search).toBe('allow');
  });

  test('customPrompt replaces the base prompt and customAppendPrompt appends', () => {
    const replaced = createReviewerAgent(
      'test/reviewer',
      'Replacement reviewer prompt.',
    );
    expect(replaced.config.prompt).toBe('Replacement reviewer prompt.');

    const appended = createReviewerAgent(
      'test/reviewer',
      undefined,
      'Extra review guidance.',
    );
    expect(appended.config.prompt).toContain('Extra review guidance.');
    expect(appended.config.prompt).toContain('review_mode=plan');
  });
});

describe('reviewer clean-install availability', () => {
  test('is registered as a subagent on a clean install (no config)', () => {
    expect(isSubagent('reviewer')).toBe(true);
    const agents = createAgents(runtimeFor());
    const reviewer = agents.find((a) => a.name === 'reviewer');
    expect(reviewer).toBeDefined();
  });

  test('is enabled by default (not in DEFAULT_DISABLED_AGENTS)', () => {
    const agents = createAgents(runtimeFor());
    const names = agents.map((a) => a.name);
    expect(names).toContain('reviewer');
    // observer is the only default-disabled built-in; reviewer is not.
    expect(DEFAULT_MODELS.reviewer).toBeUndefined();
  });

  test('getAgentConfigs classifies reviewer as subagent mode', () => {
    const configs = getAgentConfigs(runtimeFor());
    expect(configs.reviewer).toBeDefined();
    expect(configs.reviewer.mode).toBe('subagent');
    expect(configs.reviewer.description).toBeDefined();
  });

  test('default SDK config has no model so it follows the session model', () => {
    const configs = getAgentConfigs(runtimeFor());
    expect(configs.reviewer.model).toBeUndefined();
  });
});

describe('reviewer model inheritance, overrides, and disable', () => {
  test('explicit model override applies', () => {
    const config: PluginConfig = {
      agents: {
        reviewer: { model: 'openai/gpt-5.6' },
      },
    };
    const agents = createAgents(runtimeFor(config));
    const reviewer = agents.find((a) => a.name === 'reviewer');
    expect(reviewer?.config.model).toBe('openai/gpt-5.6');
  });

  test('inheritModelFrom session clears the model', () => {
    const config: PluginConfig = {
      agents: {
        reviewer: { inheritModelFrom: 'session' },
      },
    };
    const agents = createAgents(runtimeFor(config));
    const reviewer = agents.find((a) => a.name === 'reviewer');
    expect(reviewer?.config.model).toBeUndefined();
  });

  test('inheritModelFrom orchestrator follows the configured orchestrator model', () => {
    const config: PluginConfig = {
      agents: {
        orchestrator: { model: 'orchestrator-model' },
        reviewer: { inheritModelFrom: 'orchestrator' },
      },
    };
    const agents = createAgents(runtimeFor(config));
    const reviewer = agents.find((a) => a.name === 'reviewer');
    expect(reviewer?.config.model).toBe('orchestrator-model');
  });

  test('disabled_agents removes reviewer', () => {
    const config: PluginConfig = {
      disabled_agents: ['reviewer'],
    };
    const agents = createAgents(runtimeFor(config));
    const names = agents.map((a) => a.name);
    expect(names).not.toContain('reviewer');

    const configs = getAgentConfigs(runtimeFor(config));
    expect(configs.reviewer).toBeUndefined();
  });
});

describe('reviewer explicit config remains an override, not discarded', () => {
  test('a reviewer prompt override replaces the built-in prompt', () => {
    const config: PluginConfig = {
      agents: {
        reviewer: {
          model: 'openai/gpt-5.6',
          prompt: 'You are a custom reviewer.',
        },
      },
    };
    const agents = createAgents(runtimeFor(config));
    const reviewer = agents.find((a) => a.name === 'reviewer');
    expect(reviewer).toBeDefined();
    expect(reviewer?.config.model).toBe('openai/gpt-5.6');
    expect(reviewer?.config.prompt).toBe('You are a custom reviewer.');
  });

  test('a reviewer description override propagates to the SDK config', () => {
    const config: PluginConfig = {
      agents: {
        reviewer: {
          model: 'openai/gpt-5.6',
          description: 'Project-specific review specialist',
        },
      },
    };
    const configs = getAgentConfigs(runtimeFor(config));
    expect(configs.reviewer.description).toBe(
      'Project-specific review specialist',
    );
  });

  test('a reviewer color override flows to the SDK config', () => {
    const config: PluginConfig = {
      agents: {
        reviewer: {
          model: 'openai/gpt-5.6',
          color: 'warning',
        },
      },
    };
    const configs = getAgentConfigs(runtimeFor(config));
    expect(configs.reviewer.color).toBe('warning');
  });
});
