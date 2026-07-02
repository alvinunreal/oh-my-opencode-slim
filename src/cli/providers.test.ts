/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { GENERATED_PRESETS, generateLiteConfig, MODEL_MAPPINGS } from './providers';

describe('providers', () => {
  test('MODEL_MAPPINGS includes supported providers', () => {
    const keys = Object.keys(MODEL_MAPPINGS);
    expect(keys.sort()).toEqual([
      'cheap',
      'claude',
      'claude-fast',
      'copilot',
      'kimi',
      'openai',
      'openai-fast',
      'opencode-go',
      'oss-claude',
      'oss-openai',
      'zai-plan',
    ]);
  });

  test('GENERATED_PRESETS includes bundled generated configs', () => {
    expect(GENERATED_PRESETS).toEqual([
      'openai',
      'openai-fast',
      'opencode-go',
      'claude',
      'claude-fast',
      'oss-openai',
      'oss-claude',
      'cheap',
    ]);
  });

  test('generateLiteConfig defaults to openai and includes generated presets', () => {
    const config = generateLiteConfig({
      hasTmux: false,
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
      'opencode-go/kimi-k2.6',
    );
    expect((config.presets as any).claude).toBeDefined();
    expect((config.presets as any)['openai-fast']).toBeDefined();
    expect((config.presets as any)['claude-fast']).toBeDefined();
    expect((config.presets as any)['oss-openai']).toBeDefined();
    expect((config.presets as any)['oss-claude']).toBeDefined();
    const agents = (config.presets as any).openai;
    expect(agents).toBeDefined();
    expect(agents.orchestrator.model).toBe('openai/gpt-5.5');
    expect(agents.orchestrator.variant).toBe('medium');
    expect(agents.fixer.model).toBe('openai/gpt-5.4-mini-fast');
    expect(agents.fixer.variant).toBe('low');
  });

  test('generateLiteConfig uses correct OpenAI models', () => {
    const config = generateLiteConfig({
      hasTmux: false,
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
    });

    const agents = (config.presets as any).openai;
    expect(agents.orchestrator.model).toBe(
      MODEL_MAPPINGS.openai.orchestrator.model,
    );
    expect(agents.oracle.model).toBe('openai/gpt-5.5');
    expect(agents.oracle.variant).toBe('high');
    expect(agents.librarian.model).toBe('openai/gpt-5.4-mini-fast');
    expect(agents.librarian.variant).toBe('low');
    expect(agents.explorer.model).toBe('openai/gpt-5.4-mini-fast');
    expect(agents.explorer.variant).toBe('low');
    expect(agents.designer.model).toBe('openai/gpt-5.4-mini-fast');
    expect(agents.designer.variant).toBe('medium');
  });

  test('generateLiteConfig can set opencode-go as active preset', () => {
    const config = generateLiteConfig({
      hasTmux: false,
      installCustomSkills: false,
      preset: 'opencode-go',
      reset: false,
    });

    expect(config.preset).toBe('opencode-go');
    expect(config.disabled_agents).toEqual([]);
    expect((config.presets as any).openai).toBeDefined();
    const agents = (config.presets as any)['opencode-go'];
    expect(agents).toBeDefined();
    expect(agents.orchestrator.model).toBe('opencode-go/glm-5.1');
    expect(agents.oracle.model).toBe('opencode-go/deepseek-v4-pro');
    expect(agents.oracle.variant).toBe('max');
    expect(agents.council.model).toBe('opencode-go/deepseek-v4-pro');
    expect(agents.council.variant).toBe('high');
    expect(agents.librarian.model).toBe('opencode-go/minimax-m2.7');
    expect(agents.explorer.model).toBe('opencode-go/minimax-m2.7');
    expect(agents.designer.model).toBe('opencode-go/kimi-k2.6');
    expect(agents.fixer.model).toBe('opencode-go/deepseek-v4-flash');
    expect(agents.fixer.variant).toBe('high');
    expect(agents.observer.model).toBe('opencode-go/kimi-k2.6');
  });

  test('generateLiteConfig can set claude as active preset', () => {
    const config = generateLiteConfig({
      hasTmux: false,
      installCustomSkills: false,
      preset: 'claude',
      reset: false,
    });

    expect(config.preset).toBe('claude');
    expect(config.disabled_agents).toEqual([]);
    const agents = (config.presets as any).claude;
    expect(agents.orchestrator.model).toBe('anthropic/claude-fable-5');
    expect(agents.orchestrator.variant).toBe('medium');
    expect(agents.oracle.model).toBe('anthropic/claude-opus-4-8');
    expect(agents.oracle.variant).toBe('high');
    expect(agents.council.model).toBe('anthropic/claude-opus-4-8');
    expect(agents.council.variant).toBe('high');
    expect(agents.librarian.model).toBe('anthropic/claude-haiku-4-5');
    expect(agents.librarian.variant).toBe('low');
    expect(agents.explorer.model).toBe('anthropic/claude-haiku-4-5');
    expect(agents.designer.model).toBe('anthropic/claude-sonnet-4-6');
    expect(agents.designer.variant).toBe('medium');
    expect(agents.fixer.model).toBe('anthropic/claude-sonnet-4-6');
    expect(agents.fixer.variant).toBe('low');
    expect(agents.observer.model).toBe('anthropic/claude-sonnet-4-6');
  });

  test('generateLiteConfig can set openai-fast as active preset', () => {
    const config = generateLiteConfig({
      hasTmux: false,
      installCustomSkills: false,
      preset: 'openai-fast',
      reset: false,
    });

    expect(config.preset).toBe('openai-fast');
    expect(config.disabled_agents).toBeUndefined();
    const agents = (config.presets as any)['openai-fast'];
    expect(agents.orchestrator.model).toBe('openai/gpt-5.5-fast');
    expect(agents.orchestrator.variant).toBe('medium');
    expect(agents.oracle.model).toBe('openai/gpt-5.5-fast');
    expect(agents.oracle.variant).toBe('high');
    expect(agents.librarian.model).toBe('openai/gpt-5.4-mini-fast');
    expect(agents.librarian.variant).toBe('low');
    expect(agents.explorer.model).toBe('openai/gpt-5.5-fast');
    expect(agents.explorer.variant).toBe('low');
    expect(agents.designer.model).toBe('openai/gpt-5.5-fast');
    expect(agents.designer.variant).toBe('medium');
    expect(agents.fixer.model).toBe('openai/gpt-5.4-mini-fast');
    expect(agents.fixer.variant).toBe('low');
    expect(JSON.stringify(agents)).not.toContain('openai/gpt-5.4"');
    expect(JSON.stringify(agents)).toContain('openai/gpt-5.5-fast');
  });

  test('generateLiteConfig can set claude-fast as active preset', () => {
    const config = generateLiteConfig({
      hasTmux: false,
      installCustomSkills: false,
      preset: 'claude-fast',
      reset: false,
    });

    expect(config.preset).toBe('claude-fast');
    expect(config.disabled_agents).toEqual([]);
    const agents = (config.presets as any)['claude-fast'];
    expect(agents.orchestrator.model).toBe('anthropic/claude-haiku-4-5');
    expect(agents.orchestrator.variant).toBe('medium');
    expect(agents.oracle.model).toBe('anthropic/claude-haiku-4-5');
    expect(agents.oracle.variant).toBe('high');
    expect(agents.council.model).toBe('anthropic/claude-haiku-4-5');
    expect(agents.council.variant).toBe('high');
    expect(agents.librarian.model).toBe('anthropic/claude-haiku-4-5');
    expect(agents.librarian.variant).toBe('low');
    expect(agents.explorer.model).toBe('anthropic/claude-haiku-4-5');
    expect(agents.explorer.variant).toBe('low');
    expect(agents.designer.model).toBe('anthropic/claude-haiku-4-5');
    expect(agents.designer.variant).toBe('medium');
    expect(agents.fixer.model).toBe('anthropic/claude-haiku-4-5');
    expect(agents.fixer.variant).toBe('low');
    expect(agents.observer.model).toBe('anthropic/claude-haiku-4-5');
    expect(JSON.stringify(agents)).not.toContain('sonnet-4-6');
    expect(JSON.stringify(agents)).not.toContain('opus-4-8');
    expect(JSON.stringify(agents)).not.toContain('fable-5');
  });

  test('generateLiteConfig can set oss-openai as active preset', () => {
    const config = generateLiteConfig({
      hasTmux: false,
      installCustomSkills: false,
      preset: 'oss-openai',
      reset: false,
    });

    expect(config.preset).toBe('oss-openai');
    expect(config.disabled_agents).toEqual([]);
    const agents = (config.presets as any)['oss-openai'];
    expect(agents.orchestrator.model).toBe('openai/gpt-5.5');
    expect(agents.orchestrator.variant).toBe('medium');
    expect(agents.oracle.model).toBe('openai/gpt-5.5');
    expect(agents.oracle.variant).toBe('high');
    expect(agents.council.model).toBe('openai/gpt-5.5');
    expect(agents.council.variant).toBe('high');
    expect(agents.librarian.model).toBe('opencode-go/glm-5.2');
    expect(agents.librarian.variant).toBe('low');
    expect(agents.explorer.model).toBe('openai/gpt-5.4');
    expect(agents.designer.model).toBe('openai/gpt-5.4');
    expect(agents.designer.variant).toBe('medium');
    expect(agents.fixer.model).toBe('openai/gpt-5.4-mini-fast');
    expect(agents.fixer.variant).toBe('low');
    expect(agents.observer.model).toBe('opencode-go/glm-5.2');
  });

  test('generateLiteConfig can set oss-claude as active preset', () => {
    const config = generateLiteConfig({
      hasTmux: false,
      installCustomSkills: false,
      preset: 'oss-claude',
      reset: false,
    });

    expect(config.preset).toBe('oss-claude');
    expect(config.disabled_agents).toEqual([]);
    const agents = (config.presets as any)['oss-claude'];
    expect(agents.orchestrator.model).toBe('anthropic/claude-fable-5');
    expect(agents.orchestrator.variant).toBe('medium');
    expect(agents.oracle.model).toBe('anthropic/claude-opus-4-8');
    expect(agents.oracle.variant).toBe('high');
    expect(agents.council.model).toBe('anthropic/claude-opus-4-8');
    expect(agents.council.variant).toBe('high');
    expect(agents.librarian.model).toBe('opencode-go/glm-5.2');
    expect(agents.librarian.variant).toBe('low');
    expect(agents.explorer.model).toBe('opencode-go/glm-5.2');
    expect(agents.designer.model).toBe('opencode-go/glm-5.2');
    expect(agents.designer.variant).toBe('medium');
    expect(agents.fixer.model).toBe('opencode-go/glm-5.2');
    expect(agents.fixer.variant).toBe('low');
    expect(agents.observer.model).toBe('opencode-go/glm-5.2');
  });

  test('generateLiteConfig can set cheap as active preset', () => {
    const config = generateLiteConfig({
      hasTmux: false,
      installCustomSkills: false,
      preset: 'cheap',
      reset: false,
    });

    expect(config.preset).toBe('cheap');
    expect(config.disabled_agents).toEqual([]);
    const agents = (config.presets as any)['cheap'];
    expect(agents.orchestrator.model).toBe('openai/gpt-5.4-mini');
    expect(agents.orchestrator.variant).toBe('medium');
    expect(agents.oracle.model).toBe('openai/gpt-5.4-mini');
    expect(agents.oracle.variant).toBe('high');
    expect(agents.council.model).toBe('openai/gpt-5.4-mini');
    expect(agents.council.variant).toBe('high');
    expect(agents.librarian.model).toBe('openai/gpt-5.4-mini');
    expect(agents.librarian.variant).toBe('low');
    expect(agents.explorer.model).toBe('openai/gpt-5.4-mini');
    expect(agents.fixer.model).toBe('openai/gpt-5.4-mini');
    expect(agents.fixer.variant).toBe('low');
    expect(agents.observer.model).toBe('openai/gpt-5.4-mini');
    expect(JSON.stringify(agents)).not.toContain('gpt-5.5');
    expect(JSON.stringify(agents)).not.toContain('claude');
  });

  test('generateLiteConfig rejects unsupported preset', () => {
    expect(() =>
      generateLiteConfig({
        hasTmux: false,
        installCustomSkills: false,
        preset: 'not-real',
        reset: false,
      }),
    ).toThrow('Unsupported preset "not-real"');
  });

  test('generateLiteConfig rejects non-generated model mappings as active presets', () => {
    expect(() =>
      generateLiteConfig({
        hasTmux: false,
        installCustomSkills: false,
        preset: 'kimi',
        reset: false,
      }),
    ).toThrow('Unsupported preset "kimi"');
  });

  test('generateLiteConfig rejects inherited property names as presets', () => {
    expect(() =>
      generateLiteConfig({
        hasTmux: false,
        installCustomSkills: false,
        preset: 'toString',
        reset: false,
      }),
    ).toThrow('Unsupported preset "toString"');
  });

  test('generateLiteConfig enables tmux when requested', () => {
    const config = generateLiteConfig({
      hasTmux: true,
      installCustomSkills: false,
      reset: false,
    });

    expect(config.tmux).toBeDefined();
    expect((config.tmux as any).enabled).toBe(true);
    expect((config.tmux as any).layout).toBe('main-vertical');
  });

  test('generateLiteConfig companion: yes', () => {
    const config = generateLiteConfig({
      hasTmux: false,
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
      hasTmux: false,
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
      companion: 'no',
    });
    expect(configYes.companion).toBeUndefined();

    const configOmitted = generateLiteConfig({
      hasTmux: false,
      installCustomSkills: false,
      backgroundSubagents: 'no',
      reset: false,
    });
    expect(configOmitted.companion).toBeUndefined();
  });

  test('generateLiteConfig includes default skills', () => {
    const config = generateLiteConfig({
      hasTmux: false,
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
      hasTmux: false,
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
      hasTmux: false,
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
