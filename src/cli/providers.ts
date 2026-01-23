import {
  DEFAULT_AGENT_MCPS,
  DEFAULT_AGENT_SKILLS,
} from '../tools/skill/builtin';
import type { InstallConfig } from './types';

/**
 * Provider configurations for Google models (via Antigravity auth plugin)
 */
export const GOOGLE_PROVIDER_CONFIG = {
  google: {
    name: 'Google',
    models: {
      'gemini-3-pro-high': {
        name: 'Gemini 3 Pro High',
        thinking: true,
        attachment: true,
        limit: { context: 1048576, output: 65535 },
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      },
      'gemini-3-flash': {
        name: 'Gemini 3 Flash',
        attachment: true,
        limit: { context: 1048576, output: 65536 },
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      },
      'claude-opus-4-5-thinking': {
        name: 'Claude Opus 4.5 Thinking',
        attachment: true,
        limit: { context: 200000, output: 32000 },
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      },
      'claude-sonnet-4-5-thinking': {
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
    orchestrator: { model: 'google/claude-opus-4-5-thinking' },
    oracle: { model: 'google/claude-opus-4-5-thinking', variant: 'high' },
    librarian: { model: 'google/gemini-3-flash', variant: 'low' },
    explorer: { model: 'google/gemini-3-flash', variant: 'low' },
    designer: { model: 'google/gemini-3-flash', variant: 'medium' },
    fixer: { model: 'google/gemini-3-flash', variant: 'low' },
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
            DEFAULT_AGENT_SKILLS[k as keyof typeof DEFAULT_AGENT_SKILLS] ?? [],
          mcps: DEFAULT_AGENT_MCPS[k as keyof typeof DEFAULT_AGENT_MCPS] ?? [],
        },
      ]),
    );

  // Only generate preset based on user selection
  if (installConfig.hasAntigravity && installConfig.hasOpenAI) {
    // Mixed preset: antigravity base with OpenAI oracle
    const mixedAgents: Record<string, { model: string; variant?: string }> = {
      ...MODEL_MAPPINGS.antigravity,
    };
    mixedAgents.oracle = { model: 'openai/gpt-5.2-codex', variant: 'high' };
    (config.presets as Record<string, unknown>)['antigravity-openai'] =
      createAgents(mixedAgents);

    config.preset = 'antigravity-openai';
  } else if (installConfig.hasAntigravity) {
    // Antigravity only
    (config.presets as Record<string, unknown>).antigravity = createAgents(
      MODEL_MAPPINGS.antigravity,
    );
    config.preset = 'antigravity';
  } else if (installConfig.hasOpenAI) {
    // OpenAI only
    (config.presets as Record<string, unknown>).openai = createAgents(
      MODEL_MAPPINGS.openai,
    );
    config.preset = 'openai';
  } else {
    // Zen free only
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
