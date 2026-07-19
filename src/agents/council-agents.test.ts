import { describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../config';
import { buildCouncillorAgents } from './council-agents';

/**
 * Build a minimal CouncilConfig for use in tests.
 * We cast through `unknown` to avoid repeating the full post-transform shape
 * which includes `_deprecated` and optional fields.
 */
function makeConfig(overrides: Record<string, unknown>): PluginConfig {
  return {
    council: {
      presets: {},
      default_preset: 'default',
      _deprecated: undefined,
      ...overrides,
    },
  } as unknown as PluginConfig;
}

describe('buildCouncillorAgents', () => {
  test('returns empty array when config is undefined', () => {
    const agents = buildCouncillorAgents(undefined, new Set());
    expect(agents).toEqual([]);
  });

  test('returns empty array when no council config', () => {
    const agents = buildCouncillorAgents({} as PluginConfig, new Set());
    expect(agents).toEqual([]);
  });

  test('returns empty array when preset does not exist', () => {
    const agents = buildCouncillorAgents(
      makeConfig({ presets: {} }),
      new Set(),
    );
    expect(agents).toEqual([]);
  });

  test('single-model councillor has config.model set and no _modelArray', () => {
    const config = makeConfig({
      presets: {
        default: {
          beta: {
            model: 'google/gemini-3-pro',
            variant: undefined,
            prompt: undefined,
            models: [{ id: 'google/gemini-3-pro' }],
          },
        },
      },
    });

    const agents = buildCouncillorAgents(config, new Set());
    expect(agents).toHaveLength(1);

    const [agent] = agents;
    expect(agent.name).toBe('councillor-beta');
    expect(agent.config.model).toBe('google/gemini-3-pro');
    expect(agent._modelArray).toBeUndefined();
  });

  test('single-model councillor with variant propagates variant to agent config', () => {
    const config = makeConfig({
      presets: {
        default: {
          beta: {
            model: 'google/gemini-3-pro',
            variant: 'high',
            prompt: undefined,
            models: [{ id: 'google/gemini-3-pro' }],
          },
        },
      },
    });

    const agents = buildCouncillorAgents(config, new Set());
    expect(agents).toHaveLength(1);

    const [agent] = agents;
    expect(agent.name).toBe('councillor-beta');
    expect(agent.config.model).toBe('google/gemini-3-pro');
    expect(agent.config.variant).toBe('high');
    expect(agent._modelArray).toBeUndefined();
  });

  test('multi-model councillor has _modelArray and config.model undefined', () => {
    const config = makeConfig({
      presets: {
        default: {
          alpha: {
            model: 'openai/gpt-5.6',
            variant: undefined,
            prompt: undefined,
            models: [{ id: 'openai/gpt-5.6' }, { id: 'anthropic/claude-opus' }],
          },
        },
      },
    });

    const agents = buildCouncillorAgents(config, new Set());
    expect(agents).toHaveLength(1);

    const [agent] = agents;
    expect(agent.name).toBe('councillor-alpha');
    expect(agent.config.model).toBeUndefined();
    expect(agent._modelArray).toEqual([
      { id: 'openai/gpt-5.6' },
      { id: 'anthropic/claude-opus' },
    ]);
  });

  test('disabled councillor is excluded', () => {
    const config = makeConfig({
      presets: {
        default: {
          alpha: {
            model: 'openai/gpt-5.6',
            variant: undefined,
            prompt: undefined,
            models: [{ id: 'openai/gpt-5.6' }],
          },
          beta: {
            model: 'google/gemini-3-pro',
            variant: undefined,
            prompt: undefined,
            models: [{ id: 'google/gemini-3-pro' }],
          },
        },
      },
    });

    const agents = buildCouncillorAgents(config, new Set(['councillor-alpha']));
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('councillor-beta');
  });

  test('uses default_preset when specified', () => {
    const config = makeConfig({
      presets: {
        default: {
          alpha: {
            model: 'openai/gpt-5.6',
            variant: undefined,
            prompt: undefined,
            models: [{ id: 'openai/gpt-5.6' }],
          },
        },
        custom: {
          gamma: {
            model: 'google/gemini-3-pro',
            variant: undefined,
            prompt: undefined,
            models: [{ id: 'google/gemini-3-pro' }],
          },
        },
      },
      default_preset: 'custom',
    });

    const agents = buildCouncillorAgents(config, new Set());
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('councillor-gamma');
  });
});
