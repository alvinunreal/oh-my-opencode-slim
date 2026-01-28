/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { generateLiteConfig, MODEL_MAPPINGS } from './providers';

describe('providers', () => {
  test('generateLiteConfig generates kimi config when only kimi selected', () => {
    const config = generateLiteConfig({
      hasKimi: true,
      hasOpenAI: false,
      hasOpencodeZen: false,
      hasTmux: false,
      installSkills: false,
      installCustomSkills: false,
    });

    expect(config.preset).toBe('kimi');
    const agents = (config.presets as any).kimi;
    expect(agents).toBeDefined();
    expect(agents.orchestrator.model).toBe('kimi-for-coding/k2p5');
    expect(agents.orchestrator.variant).toBeUndefined();
    expect(agents.fixer.model).toBe('kimi-for-coding/k2p5');
    expect(agents.fixer.variant).toBe('low');
    // Should NOT include other presets
    expect((config.presets as any).openai).toBeUndefined();
    expect((config.presets as any)['zen-free']).toBeUndefined();
  });

  test('generateLiteConfig generates kimi-openai preset when both selected', () => {
    const config = generateLiteConfig({
      hasKimi: true,
      hasOpenAI: true,
      hasOpencodeZen: false,
      hasTmux: false,
      installSkills: false,
      installCustomSkills: false,
    });

    expect(config.preset).toBe('kimi');
    const agents = (config.presets as any).kimi;
    expect(agents).toBeDefined();
    expect(agents.orchestrator.model).toBe('kimi-for-coding/k2p5');
    expect(agents.orchestrator.variant).toBeUndefined();
    // Oracle uses OpenAI when both kimi and openai are enabled
    expect(agents.oracle.model).toBe('openai/gpt-5.2-codex');
    expect(agents.oracle.variant).toBe('high');
    // Should NOT include other presets
    expect((config.presets as any).openai).toBeUndefined();
    expect((config.presets as any)['zen-free']).toBeUndefined();
  });

  test('generateLiteConfig generates openai preset when only openai selected', () => {
    const config = generateLiteConfig({
      hasKimi: false,
      hasOpenAI: true,
      hasOpencodeZen: false,
      hasTmux: false,
      installSkills: false,
      installCustomSkills: false,
    });

    expect(config.preset).toBe('openai');
    const agents = (config.presets as any).openai;
    expect(agents).toBeDefined();
    expect(agents.orchestrator.model).toBe(
      MODEL_MAPPINGS.openai.orchestrator.model,
    );
    expect(agents.orchestrator.variant).toBeUndefined();
    // Should NOT include other presets
    expect((config.presets as any).kimi).toBeUndefined();
    expect((config.presets as any)['zen-free']).toBeUndefined();
  });

  test('generateLiteConfig generates zen-free preset when no providers selected', () => {
    const config = generateLiteConfig({
      hasKimi: false,
      hasOpenAI: false,
      hasOpencodeZen: false,
      hasTmux: false,
      installSkills: false,
      installCustomSkills: false,
    });

    expect(config.preset).toBe('zen-free');
    const agents = (config.presets as any)['zen-free'];
    expect(agents).toBeDefined();
    expect(agents.orchestrator.model).toBe('opencode/big-pickle');
    expect(agents.orchestrator.variant).toBeUndefined();
    // Should NOT include other presets
    expect((config.presets as any).kimi).toBeUndefined();
    expect((config.presets as any).openai).toBeUndefined();
  });

  test('generateLiteConfig uses zen-free big-pickle models', () => {
    const config = generateLiteConfig({
      hasKimi: false,
      hasOpenAI: false,
      hasOpencodeZen: true,
      hasTmux: false,
      installSkills: false,
      installCustomSkills: false,
    });

    expect(config.preset).toBe('zen-free');
    const agents = (config.presets as any)['zen-free'];
    expect(agents.orchestrator.model).toBe('opencode/big-pickle');
    expect(agents.oracle.model).toBe('opencode/big-pickle');
    expect(agents.oracle.variant).toBe('high');
    expect(agents.librarian.model).toBe('opencode/big-pickle');
    expect(agents.librarian.variant).toBe('low');
  });

  test('generateLiteConfig enables tmux when requested', () => {
    const config = generateLiteConfig({
      hasKimi: false,
      hasOpenAI: false,
      hasOpencodeZen: false,
      hasTmux: true,
      installSkills: false,
      installCustomSkills: false,
    });

    expect(config.tmux).toBeDefined();
    expect((config.tmux as any).enabled).toBe(true);
  });

  test('generateLiteConfig includes default skills', () => {
    const config = generateLiteConfig({
      hasKimi: true,
      hasOpenAI: false,
      hasOpencodeZen: false,
      hasTmux: false,
      installSkills: true,
      installCustomSkills: false,
    });

    const agents = (config.presets as any).kimi;
    // Orchestrator should always have '*'
    expect(agents.orchestrator.skills).toEqual(['*']);

    // Designer should have 'agent-browser'
    expect(agents.designer.skills).toContain('agent-browser');

    // Fixer should have no skills by default (empty recommended list)
    expect(agents.fixer.skills).toEqual([]);
  });

  test('generateLiteConfig includes mcps field', () => {
    const config = generateLiteConfig({
      hasKimi: true,
      hasOpenAI: false,
      hasOpencodeZen: false,
      hasTmux: false,
      installSkills: false,
      installCustomSkills: false,
    });

    const agents = (config.presets as any).kimi;
    expect(agents.orchestrator.mcps).toBeDefined();
    expect(Array.isArray(agents.orchestrator.mcps)).toBe(true);
    expect(agents.librarian.mcps).toBeDefined();
    expect(Array.isArray(agents.librarian.mcps)).toBe(true);
  });

  test('generateLiteConfig zen-free includes correct mcps', () => {
    const config = generateLiteConfig({
      hasKimi: false,
      hasOpenAI: false,
      hasOpencodeZen: false,
      hasTmux: false,
      installSkills: false,
      installCustomSkills: false,
    });

    const agents = (config.presets as any)['zen-free'];
    expect(agents.orchestrator.mcps).toContain('websearch');
    expect(agents.librarian.mcps).toContain('websearch');
    expect(agents.librarian.mcps).toContain('context7');
    expect(agents.librarian.mcps).toContain('grep_app');
    expect(agents.designer.mcps).toEqual([]);
  });
});
