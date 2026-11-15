/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { CUSTOM_SKILLS } from './custom-skills-registry';
import { generateLiteConfig, MODEL_MAPPINGS } from './providers';

describe('providers', () => {
  test('MODEL_MAPPINGS includes supported providers', () => {
    const keys = Object.keys(MODEL_MAPPINGS);
    expect(keys.sort()).toEqual(['openai', 'opencode-go']);
  });

  test('generateLiteConfig defaults to openai and includes generated presets', () => {
    const config = generateLiteConfig({
      reset: false,
    });

    expect(config.$schema).toBe(
      'https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json',
    );
    expect(config.preset).toBe('openai');
    expect(config.disabled_agents).toBeUndefined();
    expect((config.presets as any)['opencode-go']).toBeDefined();
    expect((config.presets as any)['opencode-go'].observer.model).toBe(
      'opencode-go/mimo-v2.5',
    );
    const agents = (config.presets as any).openai;
    expect(agents).toBeDefined();
    expect(agents.orchestrator.model).toBe('openai/gpt-6.1-sol');
    expect(agents.orchestrator.variant).toBe('medium');
    expect(agents.fixer.model).toBe('openai/gpt-6.1-sol');
    expect(agents.fixer.variant).toBe('low');
  });

  test('preserves exact OpenAI model and variant mappings', () => {
    const config = generateLiteConfig({
      reset: false,
    });

    const agents = (config.presets as any).openai;
    const expected = {
      orchestrator: { model: 'openai/gpt-6.1-sol', variant: 'medium' },
      oracle: { model: 'openai/gpt-6.1-sol', variant: 'high' },
      explorer: { model: 'openai/gpt-6-luna', variant: 'low' },
      designer: { model: 'openai/gpt-6-luna', variant: 'medium' },
      fixer: { model: 'openai/gpt-6.1-sol', variant: 'low' },
    } as const;

    expect(MODEL_MAPPINGS.openai).toEqual(expected);
    expect(agents).toMatchObject(expected);
  });

  test('generateLiteConfig can set opencode-go as active preset', () => {
    const config = generateLiteConfig({
      preset: 'opencode-go',
      reset: false,
    });

    expect(config.preset).toBe('opencode-go');
    expect(config.disabled_agents).toEqual([]);
    expect((config.presets as any).openai).toBeDefined();
    const agents = (config.presets as any)['opencode-go'];
    expect(agents).toBeDefined();
    expect(agents).toMatchObject({
      orchestrator: { model: 'opencode-go/minimax-m3', variant: 'thinking' },
      oracle: { model: 'opencode-go/qwen3.8-max', variant: 'xhigh' },
      explorer: {
        model: 'opencode-go/deepseek-v4.1-flash',
        variant: 'high',
      },
      designer: { model: 'opencode-go/kimi-k2.7-code' },
      fixer: { model: 'opencode-go/deepseek-v4.1-flash', variant: 'high' },
      observer: { model: 'opencode-go/mimo-v2.5' },
    });
    expect(agents.council).toBeUndefined();
    expect(agents.designer.variant).toBeUndefined();
    expect(agents.observer.variant).toBeUndefined();
  });

  test('generateLiteConfig rejects unsupported preset', () => {
    expect(() =>
      generateLiteConfig({
        preset: 'not-real',
        reset: false,
      }),
    ).toThrow('Unsupported preset "not-real"');
  });

  test('generateLiteConfig rejects non-generated model mappings as active presets', () => {
    expect(() =>
      generateLiteConfig({
        preset: 'kimi',
        reset: false,
      }),
    ).toThrow('Unsupported preset "kimi"');
  });

  test('generateLiteConfig rejects inherited property names as presets', () => {
    expect(() =>
      generateLiteConfig({
        preset: 'toString',
        reset: false,
      }),
    ).toThrow('Unsupported preset "toString"');
  });

  test('generateLiteConfig omits companion config', () => {
    const config = generateLiteConfig({
      reset: false,
    });
    expect(config.companion).toBeUndefined();
  });

  test('generateLiteConfig includes default skills', () => {
    const config = generateLiteConfig({
      reset: false,
    });

    const agents = (config.presets as any).openai;
    // Orchestrator should always have '*'
    expect(agents.orchestrator.skills).toEqual(['*']);

    // Oracle should only have bundled simplify
    expect(agents.oracle.skills).toEqual(['simplify']);

    // Orchestrator should implicitly cover bundled codemap via '*'
    expect(agents.orchestrator.skills).toContain('*');

    // Designer should have no bundled skills by default
    expect(agents.designer.skills).toEqual([]);

    // Explorer should have no bundled skills by default
    expect(agents.explorer.skills).toEqual([]);

    // Fixer should have no bundled skills by default
    expect(agents.fixer.skills).toEqual([]);
  });

  test('generateLiteConfig only grants skills the plugin bundles', () => {
    const config = generateLiteConfig({
      reset: false,
    });

    // The install provides only bundled skills, so any other name in a
    // generated preset can point at a skill that does not exist (#1867).
    const bundled = new Set(CUSTOM_SKILLS.map((skill) => skill.name));
    const granted = Object.values(config.presets as any).flatMap(
      (preset: any) =>
        Object.values(preset).flatMap((agent: any) => agent.skills),
    );
    expect(
      granted.filter((name) => name !== '*' && !bundled.has(name)),
    ).toEqual([]);
  });

  test('generateLiteConfig omits mcps (runtime defaults apply)', () => {
    const config = generateLiteConfig({
      reset: false,
    });

    const agents = (config.presets as any).openai;
    expect(agents.orchestrator.mcps).toBeUndefined();
    expect(agents.explorer.mcps).toBeUndefined();
    expect(agents.designer.mcps).toBeUndefined();
  });
});
