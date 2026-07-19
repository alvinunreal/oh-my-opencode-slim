/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { generateLiteConfig, MODEL_MAPPINGS } from './providers';

describe('providers', () => {
  test('MODEL_MAPPINGS includes supported providers', () => {
    const keys = Object.keys(MODEL_MAPPINGS);
    expect(keys.sort()).toEqual([
      'copilot',
      'kimi',
      'openai',
      'opencode-go',
      'zai-plan',
    ]);
  });

  test('generateLiteConfig defaults to openai and includes generated presets', () => {
    const config = generateLiteConfig({
      installCustomSkills: false,
      backgroundSubagents: 'no',
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
    expect(agents.orchestrator.model).toBe('openai/gpt-5.6-terra');
    expect(agents.orchestrator.variant).toBe('medium');
    expect(agents.fixer.model).toBe('openai/gpt-5.6-luna');
    expect(agents.fixer.variant).toBe('medium');
  });

  test('generateLiteConfig uses correct OpenAI models', () => {
    const config = generateLiteConfig({
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
    });

    const agents = (config.presets as any).openai;
    expect(agents.orchestrator.model).toBe(
      MODEL_MAPPINGS.openai.orchestrator.model,
    );
    expect(agents.oracle.model).toBe('openai/gpt-5.6-sol');
    expect(agents.oracle.variant).toBe('high');
    expect(agents.librarian.model).toBe('openai/gpt-5.6-luna');
    expect(agents.librarian.variant).toBe('low');
    expect(agents.explorer.model).toBe('openai/gpt-5.6-luna');
    expect(agents.explorer.variant).toBe('low');
    expect(agents.designer.model).toBe('openai/gpt-5.6-luna');
    expect(agents.designer.variant).toBe('medium');
  });

  test('generateLiteConfig can set opencode-go as active preset', () => {
    const config = generateLiteConfig({
      installCustomSkills: false,
      preset: 'opencode-go',
      backgroundSubagents: 'no',
      reset: false,
    });

    expect(config.preset).toBe('opencode-go');
    expect(config.disabled_agents).toEqual([]);
    expect((config.presets as any).openai).toBeDefined();
    const agents = (config.presets as any)['opencode-go'];
    expect(agents).toBeDefined();
    expect(agents.orchestrator.model).toBe('opencode-go/minimax-m3');
    expect(agents.orchestrator.variant).toBe('max');
    expect(agents.oracle.model).toBe('opencode-go/qwen3.7-max');
    expect(agents.oracle.variant).toBe('max');
    expect(agents.council).toBeUndefined();
    expect(agents.librarian.model).toBe('opencode-go/deepseek-v4-flash');
    expect(agents.librarian.variant).toBe('high');
    expect(agents.librarian.mcps).toEqual(['websearch', 'context7', 'gh_grep']);
    expect(agents.explorer.model).toBe('opencode-go/deepseek-v4-flash');
    expect(agents.designer.model).toBe('opencode-go/kimi-k2.7-code');
    expect(agents.fixer.model).toBe('opencode-go/deepseek-v4-flash');
    expect(agents.fixer.variant).toBe('high');
    expect(agents.observer.model).toBe('opencode-go/mimo-v2.5');
    expect(agents.observer.variant).toBe('max');
  });

  test('generateLiteConfig rejects unsupported preset', () => {
    expect(() =>
      generateLiteConfig({
        installCustomSkills: false,
        preset: 'not-real',
        backgroundSubagents: 'no',
        reset: false,
      }),
    ).toThrow('Unsupported preset "not-real"');
  });

  test('generateLiteConfig rejects non-generated model mappings as active presets', () => {
    expect(() =>
      generateLiteConfig({
        installCustomSkills: false,
        preset: 'kimi',
        backgroundSubagents: 'no',
        reset: false,
      }),
    ).toThrow('Unsupported preset "kimi"');
  });

  test('generateLiteConfig rejects inherited property names as presets', () => {
    expect(() =>
      generateLiteConfig({
        installCustomSkills: false,
        preset: 'toString',
        backgroundSubagents: 'no',
        reset: false,
      }),
    ).toThrow('Unsupported preset "toString"');
  });

  test('generateLiteConfig companion: yes', () => {
    const config = generateLiteConfig({
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
      companion: 'yes',
    });

    expect(config.companion).toBeDefined();
    expect((config.companion as any).enabled).toBe(true);
    expect((config.companion as any).position).toBe('bottom-right');
    expect((config.companion as any).size).toBe('medium');
  });

  test('generateLiteConfig companion: no or omitted', () => {
    const configYes = generateLiteConfig({
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
      companion: 'no',
    });
    expect(configYes.companion).toBeUndefined();

    const configOmitted = generateLiteConfig({
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
    });
    expect(configOmitted.companion).toBeUndefined();
  });

  test('generateLiteConfig includes default skills', () => {
    const config = generateLiteConfig({
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
    });

    const agents = (config.presets as any).openai;
    // Orchestrator should always have '*'
    expect(agents.orchestrator.skills).toEqual(['*']);

    // Oracle should have bundled simplify
    expect(agents.oracle.skills).toContain('simplify');

    // Orchestrator should implicitly cover bundled codemap via '*'
    expect(agents.orchestrator.skills).toContain('*');

    // Designer should have no bundled skills by default
    expect(agents.designer.skills).toEqual([]);

    // Explorer should have no bundled skills by default
    expect(agents.explorer.skills).toEqual([]);

    // Fixer should have no bundled skills by default
    expect(agents.fixer.skills).toEqual([]);
  });

  test('generateLiteConfig includes mcps field', () => {
    const config = generateLiteConfig({
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
    });

    const agents = (config.presets as any).openai;
    expect(agents.orchestrator.mcps).toBeDefined();
    expect(Array.isArray(agents.orchestrator.mcps)).toBe(true);
    expect(agents.librarian.mcps).toBeDefined();
    expect(Array.isArray(agents.librarian.mcps)).toBe(true);
  });

  test('generateLiteConfig openai includes correct mcps', () => {
    const config = generateLiteConfig({
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
    });

    const agents = (config.presets as any).openai;
    expect(agents.orchestrator.mcps).toEqual(['*', '!context7']);
    expect(agents.librarian.mcps).toContain('websearch');
    expect(agents.librarian.mcps).toContain('context7');
    expect(agents.librarian.mcps).toContain('gh_grep');
    expect(agents.designer.mcps).toEqual([]);
  });
});
