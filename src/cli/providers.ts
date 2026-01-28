import { DEFAULT_AGENT_MCPS } from '../config/agent-mcps';
import { RECOMMENDED_SKILLS } from './skills';
import type { InstallConfig } from './types';

// Model mappings by provider priority
export const MODEL_MAPPINGS = {
  kimi: {
    orchestrator: { model: 'kimi-for-coding/k2p5' },
    oracle: { model: 'kimi-for-coding/k2p5', variant: 'high' },
    librarian: { model: 'kimi-for-coding/k2p5', variant: 'low' },
    explorer: { model: 'kimi-for-coding/k2p5', variant: 'low' },
    designer: { model: 'kimi-for-coding/k2p5', variant: 'medium' },
    fixer: { model: 'kimi-for-coding/k2p5', variant: 'low' },
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
  let activePreset: 'kimi' | 'openai' | 'zen-free' = 'zen-free';
  if (installConfig.hasKimi) activePreset = 'kimi';
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

        // Hybrid case: Kimi + OpenAI (use OpenAI for Oracle, Kimi for orchestrator/designer)
        if (
          activePreset === 'kimi' &&
          installConfig.hasOpenAI &&
          agentName === 'oracle'
        ) {
          activeModelInfo = { ...MODEL_MAPPINGS.openai.oracle };
        }

        return [agentName, createAgentConfig(agentName, activeModelInfo)];
      }),
    );
  };

  (config.presets as Record<string, unknown>)[activePreset] =
    buildPreset(activePreset);

  if (installConfig.hasTmux) {
    config.tmux = {
      enabled: true,
      layout: 'main-vertical',
      main_pane_size: 60,
    };
  }

  return config;
}
