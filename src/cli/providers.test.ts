/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { generateLiteConfig, MODEL_MAPPINGS } from './providers';

describe('providers', () => {
  test('generateLiteConfig generates antigravity config when only antigravity selected', () => {
    const config = generateLiteConfig({
      hasAntigravity: true,
      hasOpenAI: false,
      hasOpencodeZen: false,
      hasTmux: false,
    });

    expect(config.preset).toBe('cliproxy');
    const agents = (config.presets as any).cliproxy;
    expect(agents).toBeDefined();
    expect(agents.orchestrator.model).toBe(
      'cliproxy/gemini-claude-opus-4-5-thinking',
    );
    expect(agents.orchestrator.variant).toBeUndefined();
    expect(agents.fixer.model).toBe('cliproxy/gemini-3-flash-preview');
    expect(agents.fixer.variant).toBe('low');
    // Should NOT include other presets
    expect((config.presets as any).openai).toBeUndefined();
    expect((config.presets as any)['zen-free']).toBeUndefined();
  });

  test('generateLiteConfig generates antigravity-openai preset when both selected', () => {
    const config = generateLiteConfig({
      hasAntigravity: true,
      hasOpenAI: true,
      hasOpencodeZen: false,
      hasTmux: false,
    });

    expect(config.preset).toBe('cliproxy');
    const agents = (config.presets as any).cliproxy;
    expect(agents).toBeDefined();
    expect(agents.orchestrator.model).toBe(
      'cliproxy/gemini-claude-opus-4-5-thinking',
    );
    expect(agents.orchestrator.variant).toBeUndefined();
    expect(agents.oracle.model).toBe('openai/gpt-5.2-codex');
    expect(agents.oracle.variant).toBe('high');
    // Should NOT include other presets
    expect((config.presets as any).openai).toBeUndefined();
    expect((config.presets as any)['zen-free']).toBeUndefined();
  });

  test('generateLiteConfig generates openai preset when only openai selected', () => {
    const config = generateLiteConfig({
      hasAntigravity: false,
      hasOpenAI: true,
      hasOpencodeZen: false,
      hasTmux: false,
    });

    expect(config.preset).toBe('openai');
    const agents = (config.presets as any).openai;
    expect(agents).toBeDefined();
    expect(agents.orchestrator.model).toBe(
      MODEL_MAPPINGS.openai.orchestrator.model,
    );
    expect(agents.orchestrator.variant).toBeUndefined();
    // Should NOT include other presets
    expect((config.presets as any).cliproxy).toBeUndefined();
    expect((config.presets as any)['zen-free']).toBeUndefined();
  });

  test('generateLiteConfig generates zen-free preset when no providers selected', () => {
    const config = generateLiteConfig({
      hasAntigravity: false,
      hasOpenAI: false,
      hasOpencodeZen: false,
      hasTmux: false,
    });

    expect(config.preset).toBe('zen-free');
    const agents = (config.presets as any)['zen-free'];
    expect(agents).toBeDefined();
    expect(agents.orchestrator.model).toBe('opencode/grok-code');
    expect(agents.orchestrator.variant).toBeUndefined();
    // Should NOT include other presets
    expect((config.presets as any).cliproxy).toBeUndefined();
    expect((config.presets as any).openai).toBeUndefined();
  });

  test('generateLiteConfig uses zen-free grok-code models', () => {
    const config = generateLiteConfig({
      hasAntigravity: false,
      hasOpenAI: false,
      hasOpencodeZen: true,
      hasTmux: false,
    });

    expect(config.preset).toBe('zen-free');
    const agents = (config.presets as any)['zen-free'];
    expect(agents.orchestrator.model).toBe('opencode/grok-code');
    expect(agents.oracle.model).toBe('opencode/grok-code');
    expect(agents.oracle.variant).toBe('high');
    expect(agents.librarian.model).toBe('opencode/grok-code');
    expect(agents.librarian.variant).toBe('low');
  });

  test('generateLiteConfig enables tmux when requested', () => {
    const config = generateLiteConfig({
      hasAntigravity: false,
      hasOpenAI: false,
      hasOpencodeZen: false,
      hasTmux: true,
    });

    expect(config.tmux).toBeDefined();
    expect((config.tmux as any).enabled).toBe(true);
  });

  test('generateLiteConfig includes default skills', () => {
    const config = generateLiteConfig({
      hasAntigravity: true,
      hasOpenAI: false,
      hasOpencodeZen: false,
      hasTmux: false,
    });

    const agents = (config.presets as any).cliproxy;
    expect(agents.orchestrator.skills).toContain('*');
    expect(agents.fixer.skills).toBeDefined();
  });

  test('generateLiteConfig includes mcps field', () => {
    const config = generateLiteConfig({
      hasAntigravity: true,
      hasOpenAI: false,
      hasOpencodeZen: false,
      hasTmux: false,
    });

    const agents = (config.presets as any).cliproxy;
    expect(agents.orchestrator.mcps).toBeDefined();
    expect(Array.isArray(agents.orchestrator.mcps)).toBe(true);
    expect(agents.librarian.mcps).toBeDefined();
    expect(Array.isArray(agents.librarian.mcps)).toBe(true);
  });

  test('generateLiteConfig zen-free includes correct mcps', () => {
    const config = generateLiteConfig({
      hasAntigravity: false,
      hasOpenAI: false,
      hasOpencodeZen: false,
      hasTmux: false,
    });

    const agents = (config.presets as any)['zen-free'];
    expect(agents.orchestrator.mcps).toContain('websearch');
    expect(agents.librarian.mcps).toContain('websearch');
    expect(agents.librarian.mcps).toContain('context7');
    expect(agents.librarian.mcps).toContain('grep_app');
    expect(agents.designer.mcps).toEqual([]);
  });
});
