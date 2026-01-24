import {
  DEFAULT_AGENT_MCPS,
  DEFAULT_AGENT_SKILLS,
} from '../tools/skill/builtin';
import type { InstallConfig } from './types';

/**
 * Provider configurations for Cliproxy (Antigravity via cliproxy)
 */
export const CLIPROXY_PROVIDER_CONFIG = {
  cliproxy: {
    npm: '@ai-sdk/openai-compatible',
    name: 'CliProxy',
    options: {
      baseURL: 'http://127.0.0.1:8317/v1',
      apiKey: 'your-api-key-1',
    },
    models: {
      'gemini-3-pro-high': {
        name: 'Gemini 3 Pro High',
        thinking: true,
        attachment: true,
        limit: { context: 1048576, output: 65535 },
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      },
      'gemini-3-flash-preview': {
        name: 'Gemini 3 Flash',
        attachment: true,
        limit: { context: 1048576, output: 65536 },
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      },
      'gemini-claude-opus-4-5-thinking': {
        name: 'Claude Opus 4.5 Thinking',
        attachment: true,
        limit: { context: 200000, output: 32000 },
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      },
      'gemini-claude-sonnet-4-5-thinking': {
        name: 'Claude Sonnet 4.5 Thinking',
        attachment: true,
        limit: { context: 200000, output: 32000 },
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      },
    },
  },
};

// Model mappings by provider priority
export const MODEL_MAPPINGS = {
  antigravity: {
    orchestrator: { model: 'cliproxy/gemini-claude-opus-4-5-thinking' },
    oracle: { model: 'cliproxy/gemini-3-pro-preview', variant: 'high' },
    librarian: { model: 'cliproxy/gemini-3-flash-preview', variant: 'low' },
    explorer: { model: 'cliproxy/gemini-3-flash-preview', variant: 'low' },
    designer: { model: 'cliproxy/gemini-3-flash-preview', variant: 'medium' },
    fixer: { model: 'cliproxy/gemini-3-flash-preview', variant: 'low' },
  },
  openai: {
    orchestrator: { model: 'openai/gpt-5.2-codex' },
    oracle: { model: 'openai/gpt-5.2-codex', variant: 'high' },
    librarian: { model: 'openai/gpt-5.1-codex-mini', variant: 'low' },
    explorer: { model: 'openai/gpt-5.1-codex-mini', variant: 'low' },
    designer: { model: 'openai/gpt-5.1-codex-mini', variant: 'medium' },
    fixer: { model: 'openai/gpt-5.1-codex-mini', variant: 'low' },
  },
  'zen-free': {
    orchestrator: { model: 'opencode/grok-code' },
    oracle: { model: 'opencode/grok-code', variant: 'high' },
    librarian: { model: 'opencode/grok-code', variant: 'low' },
    explorer: { model: 'opencode/grok-code', variant: 'low' },
    designer: { model: 'opencode/grok-code', variant: 'medium' },
    fixer: { model: 'opencode/grok-code', variant: 'low' },
  },
} as const;

export function generateLiteConfig(
  installConfig: InstallConfig,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    preset: 'zen-free',
    presets: {},
  };

  // Only generate preset based on user selection
  if (installConfig.hasAntigravity && installConfig.hasOpenAI) {
    // Mixed preset: cliproxy base with OpenAI oracle
    (config.presets as Record<string, unknown>).cliproxy = {
      orchestrator: {
        model: 'cliproxy/gemini-claude-opus-4-5-thinking',
        skills: ['*'],
        mcps: ['websearch'],
      },
      oracle: {
        model: 'openai/gpt-5.2-codex',
        variant: 'high',
        skills: [],
        mcps: [],
      },
      librarian: {
        model: 'cliproxy/gemini-3-flash-preview',
        variant: 'low',
        skills: [],
        mcps: ['websearch', 'context7', 'grep_app'],
      },
      explorer: {
        model: 'cliproxy/gemini-3-flash-preview',
        variant: 'low',
        skills: [],
        mcps: [],
      },
      designer: {
        model: 'cliproxy/gemini-3-flash-preview',
        variant: 'medium',
        skills: ['playwright'],
        mcps: [],
      },
      fixer: {
        model: 'cliproxy/gemini-3-flash-preview',
        variant: 'low',
        skills: [],
        mcps: [],
      },
    };
    config.preset = 'cliproxy';
  } else if (installConfig.hasAntigravity) {
    // Cliproxy only
    (config.presets as Record<string, unknown>).cliproxy = {
      orchestrator: {
        model: 'cliproxy/gemini-claude-opus-4-5-thinking',
        skills: ['*'],
        mcps: ['websearch'],
      },
      oracle: {
        model: 'cliproxy/gemini-3-pro-preview',
        variant: 'high',
        skills: [],
        mcps: [],
      },
      librarian: {
        model: 'cliproxy/gemini-3-flash-preview',
        variant: 'low',
        skills: [],
        mcps: ['websearch', 'context7', 'grep_app'],
      },
      explorer: {
        model: 'cliproxy/gemini-3-flash-preview',
        variant: 'low',
        skills: [],
        mcps: [],
      },
      designer: {
        model: 'cliproxy/gemini-3-flash-preview',
        variant: 'medium',
        skills: ['playwright'],
        mcps: [],
      },
      fixer: {
        model: 'cliproxy/gemini-3-flash-preview',
        variant: 'low',
        skills: [],
        mcps: [],
      },
    };
    config.preset = 'cliproxy';
  } else if (installConfig.hasOpenAI) {
    // OpenAI only
    const createAgents = (
      models: Record<string, { model: string; variant?: string }>,
    ): Record<
      string,
      { model: string; variant?: string; skills: string[]; mcps: string[] }
    > =>
      Object.fromEntries(
        Object.entries(models).map(([k, v]) => [
          k,
          {
            model: v.model,
            variant: v.variant,
            skills:
              DEFAULT_AGENT_SKILLS[k as keyof typeof DEFAULT_AGENT_SKILLS] ??
              [],
            mcps:
              DEFAULT_AGENT_MCPS[k as keyof typeof DEFAULT_AGENT_MCPS] ?? [],
          },
        ]),
      );
    (config.presets as Record<string, unknown>).openai = createAgents(
      MODEL_MAPPINGS.openai,
    );
    config.preset = 'openai';
  } else {
    // Zen free only
    const createAgents = (
      models: Record<string, { model: string; variant?: string }>,
    ): Record<
      string,
      { model: string; variant?: string; skills: string[]; mcps: string[] }
    > =>
      Object.fromEntries(
        Object.entries(models).map(([k, v]) => [
          k,
          {
            model: v.model,
            variant: v.variant,
            skills:
              DEFAULT_AGENT_SKILLS[k as keyof typeof DEFAULT_AGENT_SKILLS] ??
              [],
            mcps:
              DEFAULT_AGENT_MCPS[k as keyof typeof DEFAULT_AGENT_MCPS] ?? [],
          },
        ]),
      );
    (config.presets as Record<string, unknown>)['zen-free'] = createAgents(
      MODEL_MAPPINGS['zen-free'],
    );
    config.preset = 'zen-free';
  }

  if (installConfig.hasTmux) {
    config.tmux = {
      enabled: true,
      layout: 'main-vertical',
      main_pane_size: 60,
    };
  }

  return config;
}
