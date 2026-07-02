import { DEFAULT_AGENT_MCPS } from '../config/agent-mcps';
import { CUSTOM_SKILLS } from './custom-skills';
import type { InstallConfig } from './types';

const SCHEMA_URL =
  'https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json';

export const GENERATED_PRESETS = [
  'openai',
  'openai-fast',
  'opencode-go',
  'claude',
  'claude-fast',
  'oss-openai',
  'oss-claude',
  'cheap',
] as const;

// Model mappings by provider/preset.
export const MODEL_MAPPINGS = {
  openai: {
    orchestrator: { model: 'openai/gpt-5.5', variant: 'medium' },
    oracle: { model: 'openai/gpt-5.5', variant: 'high' },
    librarian: { model: 'openai/gpt-5.4-mini-fast', variant: 'low' },
    explorer: { model: 'openai/gpt-5.4-mini-fast', variant: 'low' },
    designer: { model: 'openai/gpt-5.4-mini-fast', variant: 'medium' },
    fixer: { model: 'openai/gpt-5.4-mini-fast', variant: 'low' },
  },
  'openai-fast': {
    orchestrator: { model: 'openai/gpt-5.5-fast', variant: 'medium' },
    oracle: { model: 'openai/gpt-5.5-fast', variant: 'high' },
    librarian: { model: 'openai/gpt-5.4-mini-fast', variant: 'low' },
    explorer: { model: 'openai/gpt-5.5-fast', variant: 'low' },
    designer: { model: 'openai/gpt-5.5-fast', variant: 'medium' },
    fixer: { model: 'openai/gpt-5.4-mini-fast', variant: 'low' },
  },
  kimi: {
    orchestrator: { model: 'kimi-for-coding/k2p5' },
    oracle: { model: 'kimi-for-coding/k2p5', variant: 'high' },
    librarian: { model: 'kimi-for-coding/k2p5', variant: 'low' },
    explorer: { model: 'kimi-for-coding/k2p5', variant: 'low' },
    designer: { model: 'kimi-for-coding/k2p5', variant: 'medium' },
    fixer: { model: 'kimi-for-coding/k2p5', variant: 'low' },
  },
  copilot: {
    orchestrator: { model: 'github-copilot/claude-opus-4.6' },
    oracle: { model: 'github-copilot/claude-opus-4.6', variant: 'high' },
    librarian: { model: 'github-copilot/grok-code-fast-1', variant: 'low' },
    explorer: { model: 'github-copilot/grok-code-fast-1', variant: 'low' },
    designer: {
      model: 'github-copilot/gemini-3.1-pro-preview',
      variant: 'medium',
    },
    fixer: { model: 'github-copilot/claude-sonnet-4.6', variant: 'low' },
  },
  'zai-plan': {
    orchestrator: { model: 'zai-coding-plan/glm-5' },
    oracle: { model: 'zai-coding-plan/glm-5', variant: 'high' },
    librarian: { model: 'zai-coding-plan/glm-5', variant: 'low' },
    explorer: { model: 'zai-coding-plan/glm-5', variant: 'low' },
    designer: { model: 'zai-coding-plan/glm-5', variant: 'medium' },
    fixer: { model: 'zai-coding-plan/glm-5', variant: 'low' },
  },
  'opencode-go': {
    orchestrator: { model: 'opencode-go/glm-5.1' },
    oracle: { model: 'opencode-go/deepseek-v4-pro', variant: 'max' },
    council: { model: 'opencode-go/deepseek-v4-pro', variant: 'high' },
    librarian: { model: 'opencode-go/minimax-m2.7' },
    explorer: { model: 'opencode-go/minimax-m2.7' },
    designer: { model: 'opencode-go/kimi-k2.6', variant: 'medium' },
    fixer: { model: 'opencode-go/deepseek-v4-flash', variant: 'high' },
    observer: { model: 'opencode-go/kimi-k2.6' },
  },
  claude: {
    orchestrator: { model: 'anthropic/claude-fable-5', variant: 'medium' },
    oracle: { model: 'anthropic/claude-opus-4-8', variant: 'high' },
    council: { model: 'anthropic/claude-opus-4-8', variant: 'high' },
    librarian: { model: 'anthropic/claude-haiku-4-5', variant: 'low' },
    explorer: { model: 'anthropic/claude-haiku-4-5', variant: 'low' },
    designer: { model: 'anthropic/claude-sonnet-4-6', variant: 'medium' },
    fixer: { model: 'anthropic/claude-sonnet-4-6', variant: 'low' },
    observer: { model: 'anthropic/claude-sonnet-4-6' },
  },
  'claude-fast': {
    orchestrator: { model: 'anthropic/claude-haiku-4-5', variant: 'medium' },
    oracle: { model: 'anthropic/claude-haiku-4-5', variant: 'high' },
    council: { model: 'anthropic/claude-haiku-4-5', variant: 'high' },
    librarian: { model: 'anthropic/claude-haiku-4-5', variant: 'low' },
    explorer: { model: 'anthropic/claude-haiku-4-5', variant: 'low' },
    designer: { model: 'anthropic/claude-haiku-4-5', variant: 'medium' },
    fixer: { model: 'anthropic/claude-haiku-4-5', variant: 'low' },
    observer: { model: 'anthropic/claude-haiku-4-5' },
  },
  'oss-openai': {
    orchestrator: { model: 'openai/gpt-5.5', variant: 'medium' },
    oracle: { model: 'openai/gpt-5.5', variant: 'high' },
    council: { model: 'openai/gpt-5.5', variant: 'high' },
    librarian: { model: 'opencode-go/glm-5.2', variant: 'low' },
    explorer: { model: 'openai/gpt-5.4', variant: 'low' },
    designer: { model: 'openai/gpt-5.4', variant: 'medium' },
    fixer: { model: 'openai/gpt-5.4-mini-fast', variant: 'low' },
    observer: { model: 'opencode-go/glm-5.2' },
  },
  'oss-claude': {
    orchestrator: { model: 'anthropic/claude-fable-5', variant: 'medium' },
    oracle: { model: 'anthropic/claude-opus-4-8', variant: 'high' },
    council: { model: 'anthropic/claude-opus-4-8', variant: 'high' },
    librarian: { model: 'opencode-go/glm-5.2', variant: 'low' },
    explorer: { model: 'opencode-go/glm-5.2', variant: 'low' },
    designer: { model: 'opencode-go/glm-5.2', variant: 'medium' },
    fixer: { model: 'opencode-go/glm-5.2', variant: 'low' },
    observer: { model: 'opencode-go/glm-5.2' },
  },
  cheap: {
    orchestrator: { model: 'openai/gpt-5.4-mini', variant: 'medium' },
    oracle: { model: 'openai/gpt-5.4-mini', variant: 'high' },
    council: { model: 'openai/gpt-5.4-mini', variant: 'high' },
    librarian: { model: 'openai/gpt-5.4-mini', variant: 'low' },
    explorer: { model: 'openai/gpt-5.4-mini', variant: 'low' },
    designer: { model: 'openai/gpt-5.4-mini', variant: 'medium' },
    fixer: { model: 'openai/gpt-5.4-mini', variant: 'low' },
    observer: { model: 'openai/gpt-5.4-mini' },
  },
} as const;

export type PresetName = keyof typeof MODEL_MAPPINGS;
export type GeneratedPresetName = (typeof GENERATED_PRESETS)[number];

export function isPresetName(value: string): value is PresetName {
  return Object.hasOwn(MODEL_MAPPINGS, value);
}

export function getPresetNames(): PresetName[] {
  return Object.keys(MODEL_MAPPINGS) as PresetName[];
}

export function isGeneratedPresetName(
  value: string,
): value is GeneratedPresetName {
  return GENERATED_PRESETS.includes(value as GeneratedPresetName);
}

export function getGeneratedPresetNames(): GeneratedPresetName[] {
  return [...GENERATED_PRESETS];
}

export function generateLiteConfig(
  installConfig: InstallConfig,
): Record<string, unknown> {
  const preset = installConfig.preset ?? 'openai';
  if (!isGeneratedPresetName(preset)) {
    throw new Error(
      `Unsupported preset "${preset}". Available generated presets: ${getGeneratedPresetNames().join(', ')}`,
    );
  }

  const config: Record<string, unknown> = {
    $schema: SCHEMA_URL,
    preset,
    presets: {},
  };

  if (Object.hasOwn(MODEL_MAPPINGS[preset as PresetName], 'observer')) {
    config.disabled_agents = [];
  }

  const createAgentConfig = (
    agentName: string,
    modelInfo: { model: string; variant?: string },
  ) => {
    const isOrchestrator = agentName === 'orchestrator';

    const skills = isOrchestrator
      ? ['*']
      : [
          ...CUSTOM_SKILLS.filter(
            (s) =>
              s.allowedAgents.includes('*') ||
              s.allowedAgents.includes(agentName),
          ).map((s) => s.name),
        ];

    return {
      model: modelInfo.model,
      variant: modelInfo.variant,
      skills,
      mcps:
        DEFAULT_AGENT_MCPS[agentName as keyof typeof DEFAULT_AGENT_MCPS] ?? [],
    };
  };

  const buildPreset = (mappingName: PresetName) => {
    const mapping = MODEL_MAPPINGS[mappingName];
    return Object.fromEntries(
      Object.entries(mapping).map(([agentName, modelInfo]) => [
        agentName,
        createAgentConfig(agentName, modelInfo),
      ]),
    );
  };

  const presets = config.presets as Record<string, unknown>;
  for (const presetName of GENERATED_PRESETS) {
    presets[presetName] = buildPreset(presetName);
  }

  if (installConfig.hasTmux) {
    config.tmux = {
      enabled: true,
      layout: 'main-vertical',
      main_pane_size: 60,
    };
  }

  if (installConfig.companion === 'yes') {
    config.companion = {
      enabled: true,
      position: 'bottom-right',
      size: 'medium',
      gifPack: 'default',
      loopStyle: 'classic',
      speed: 1,
      debug: false,
    };
  }

  return config;
}
