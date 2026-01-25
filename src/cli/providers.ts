import { DEFAULT_AGENT_MCPS } from '../config/agent-mcps';
import { RECOMMENDED_SKILLS } from './skills';
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
    orchestrator: { model: 'opencode/big-pickle' },
    oracle: { model: 'opencode/big-pickle', variant: 'high' },
    librarian: { model: 'opencode/big-pickle', variant: 'low' },
    explorer: { model: 'opencode/big-pickle', variant: 'low' },
    designer: { model: 'opencode/big-pickle', variant: 'medium' },
    fixer: { model: 'opencode/big-pickle', variant: 'low' },
  },
} as const;

export function generateLiteConfig(
  installConfig: InstallConfig,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    preset: 'zen-free',
    presets: {},
  };

  // Determine active preset name
  let activePreset: 'cliproxy' | 'openai' | 'zen-free' = 'zen-free';
  if (installConfig.hasAntigravity) activePreset = 'cliproxy';
  else if (installConfig.hasOpenAI) activePreset = 'openai';

  config.preset = activePreset;

  const createAgentConfig = (
    agentName: string,
    modelInfo: { model: string; variant?: string },
  ) => {
    const isOrchestrator = agentName === 'orchestrator';

    // Skills: orchestrator gets "*", others get recommended skills for their role
    const skills = isOrchestrator
      ? ['*']
      : RECOMMENDED_SKILLS.filter(
          (s) =>
            s.allowedAgents.includes('*') ||
            s.allowedAgents.includes(agentName),
        ).map((s) => s.skillName);

    // Special case for designer and agent-browser skill
    if (agentName === 'designer' && !skills.includes('agent-browser')) {
      skills.push('agent-browser');
    }

    return {
      model: modelInfo.model,
      variant: modelInfo.variant,
      skills,
      mcps:
        DEFAULT_AGENT_MCPS[agentName as keyof typeof DEFAULT_AGENT_MCPS] ?? [],
    };
  };

  const buildPreset = (mappingName: keyof typeof MODEL_MAPPINGS) => {
    const mapping = MODEL_MAPPINGS[mappingName];
    return Object.fromEntries(
      Object.entries(mapping).map(([agentName, modelInfo]) => {
        let activeModelInfo = { ...modelInfo };

        // Hybrid case: Antigravity + OpenAI (use OpenAI for Oracle)
        if (
          activePreset === 'cliproxy' &&
          installConfig.hasOpenAI &&
          agentName === 'oracle'
        ) {
          activeModelInfo = { ...MODEL_MAPPINGS.openai.oracle };
        }

        return [agentName, createAgentConfig(agentName, activeModelInfo)];
      }),
    );
  };

  (config.presets as Record<string, unknown>)[activePreset] = buildPreset(
    activePreset === 'cliproxy' ? 'antigravity' : activePreset,
  );

  if (installConfig.hasTmux) {
    config.tmux = {
      enabled: true,
      layout: 'main-vertical',
      main_pane_size: 60,
    };
  }

  return config;
}
