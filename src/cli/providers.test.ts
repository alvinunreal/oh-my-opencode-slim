/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { generateLiteConfig } from './providers';

describe('providers', () => {
  test('generateLiteConfig generates config with single provider', () => {
    const config = generateLiteConfig({
      hasAntigravity: false,
      hasKimi: true,
      hasOpenAI: false,
      hasOpencodeZen: false,
      hasTmux: false,
      installSkills: false,
      installCustomSkills: false,
      setupMode: 'quick',
    });

    expect(config.preset).toBe('kimi');
    const agents = (config.presets as Record<string, unknown>).kimi as Record<
      string,
      { model: string }
    >;
    expect(agents).toBeDefined();
    // Kimi k2p5 is high tier, should be used for orchestrator
    expect(agents.orchestrator.model).toBe('kimi-for-coding/k2p5');
  });

  test('generateLiteConfig generates config with multiple providers', () => {
    const config = generateLiteConfig({
      hasAntigravity: false,
      hasKimi: true,
      hasOpenAI: true,
      hasOpencodeZen: false,
      hasTmux: false,
      installSkills: false,
      installCustomSkills: false,
      setupMode: 'quick',
    });

    // Should create a combined preset name
    expect(config.preset).toMatch(/openai|kimi/);
    const presets = config.presets as Record<string, unknown>;
    const presetName = config.preset as string;
    const agents = presets[presetName] as Record<string, { model: string }>;
    expect(agents).toBeDefined();
    expect(agents.orchestrator).toBeDefined();
  });

  test('generateLiteConfig includes fallback chains', () => {
    const config = generateLiteConfig({
      hasAntigravity: true,
      hasKimi: false,
      hasOpenAI: false,
      hasOpencodeZen: false,
      hasTmux: false,
      installSkills: false,
      installCustomSkills: false,
      setupMode: 'quick',
    });

    expect(config.fallback).toBeDefined();
    const fallback = config.fallback as { enabled: boolean; chains: unknown };
    expect(fallback.enabled).toBe(true);
    expect(fallback.chains).toBeDefined();
  });

  test('generateLiteConfig includes tmux config when enabled', () => {
    const config = generateLiteConfig({
      hasAntigravity: false,
      hasKimi: false,
      hasOpenAI: false,
      hasOpencodeZen: false,
      hasTmux: true,
      installSkills: false,
      installCustomSkills: false,
      setupMode: 'quick',
    });

    expect(config.tmux).toBeDefined();
    const tmux = config.tmux as { enabled: boolean };
    expect(tmux.enabled).toBe(true);
  });

  test('generateLiteConfig handles manual setup mode', () => {
    const config = generateLiteConfig({
      hasAntigravity: false,
      hasKimi: false,
      hasOpenAI: false,
      hasOpencodeZen: false,
      hasTmux: false,
      installSkills: false,
      installCustomSkills: false,
      setupMode: 'manual',
      manualAgentConfigs: {
        orchestrator: {
          primary: 'anthropic/claude-opus-4',
          fallback1: 'openai/gpt-4o',
          fallback2: 'google/gemini-2.5-pro',
          fallback3: 'opencode/big-pickle',
        },
        oracle: {
          primary: 'anthropic/claude-sonnet-4',
          fallback1: 'openai/gpt-4o',
          fallback2: 'google/gemini-2.5-pro',
          fallback3: 'opencode/big-pickle',
        },
        explorer: {
          primary: 'anthropic/claude-haiku-3.5',
          fallback1: 'openai/gpt-4o-mini',
          fallback2: 'google/gemini-2.0-flash',
          fallback3: 'opencode/big-pickle',
        },
        librarian: {
          primary: 'anthropic/claude-haiku-3.5',
          fallback1: 'openai/gpt-4o-mini',
          fallback2: 'google/gemini-2.0-flash',
          fallback3: 'opencode/big-pickle',
        },
        designer: {
          primary: 'anthropic/claude-sonnet-4',
          fallback1: 'openai/gpt-4o',
          fallback2: 'google/gemini-2.5-pro',
          fallback3: 'opencode/big-pickle',
        },
        fixer: {
          primary: 'anthropic/claude-sonnet-4',
          fallback1: 'openai/gpt-4o',
          fallback2: 'google/gemini-2.5-pro',
          fallback3: 'opencode/big-pickle',
        },
        summarizer: {
          primary: 'anthropic/claude-haiku-3.5',
          fallback1: 'openai/gpt-4o-mini',
          fallback2: 'google/gemini-2.0-flash',
          fallback3: 'opencode/big-pickle',
        },
      },
    });

    expect(config.preset).toBe('manual');
    const presets = config.presets as Record<string, unknown>;
    expect(presets.manual).toBeDefined();
  });

  test('generateLiteConfig uses free tier when only free models available', () => {
    const config = generateLiteConfig({
      hasAntigravity: false,
      hasKimi: false,
      hasOpenAI: false,
      hasOpencodeZen: false,
      useOpenCodeFreeModels: true,
      hasTmux: false,
      installSkills: false,
      installCustomSkills: false,
      setupMode: 'quick',
    });

    expect(config.preset).toBe('free');
    const presets = config.presets as Record<string, unknown>;
    // Free models may not meet all agent requirements (e.g., orchestrator needs reasoning)
    // So some agents may not have assignments
    expect(presets.free).toBeDefined();
  });
});
