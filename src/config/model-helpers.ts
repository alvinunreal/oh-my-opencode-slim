import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripJsonComments } from '../cli/config-io';
import { DEFAULT_MODEL_ASSIGNMENTS } from '../token-discipline/config';
import { AGENT_TO_ROLE, MODEL_COSTS } from '../token-discipline/model-config';
import type { AgentName } from './constants';
import {
  type PluginConfig,
  PluginConfigSchema,
  type TokenDisciplineSettings,
} from './schema';

/**
 * Get the user's configuration directory following XDG Base Directory specification.
 */
function getUserConfigDir(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/**
 * Get the path to the omoslim config file.
 */
function getConfigPath(): string {
  const basePath = path.join(getUserConfigDir(), 'opencode', 'omoslim');

  // Prefer .jsonc over .json
  const jsoncPath = `${basePath}.jsonc`;
  const jsonPath = `${basePath}.json`;

  if (fs.existsSync(jsoncPath)) {
    return jsoncPath;
  }
  if (fs.existsSync(jsonPath)) {
    return jsonPath;
  }

  // Default to .json for new files
  return jsonPath;
}

/**
 * Load the current plugin config from disk.
 */
export function loadConfig(): PluginConfig {
  const configPath = getConfigPath();

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const rawConfig = JSON.parse(stripJsonComments(content));
    const result = PluginConfigSchema.safeParse(rawConfig);

    if (!result.success) {
      console.warn('[omoslim] Invalid config:', result.error.format());
      return {};
    }

    return result.data;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      // File doesn't exist - return empty config
      return {};
    }
    throw error;
  }
}

/**
 * Save the plugin config to disk.
 */
export function saveConfig(config: PluginConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Get the model for a specific agent from the config.
 * Returns the model from the active preset or direct agent config.
 */
export function getModelForAgent(
  config: PluginConfig,
  agentName: AgentName,
): string | undefined {
  // Check direct agent config first
  if (config.agents?.[agentName]?.model) {
    return config.agents[agentName].model;
  }

  // Check active preset
  if (config.preset && config.presets?.[config.preset]?.[agentName]?.model) {
    return config.presets[config.preset][agentName].model;
  }

  // Fall back to default
  const role = AGENT_TO_ROLE[agentName];
  if (!role) return undefined;

  return DEFAULT_MODEL_ASSIGNMENTS[
    role as keyof typeof DEFAULT_MODEL_ASSIGNMENTS
  ];
}

/**
 * Set the model for a specific agent in the active preset.
 * If no preset is active, creates or updates the 'manual' preset.
 */
export function setModelForAgent(
  config: PluginConfig,
  agentName: AgentName,
  model: string,
): PluginConfig {
  const presetName = config.preset || 'manual';

  // Ensure presets object exists
  if (!config.presets) {
    config.presets = {};
  }

  // Ensure preset exists
  if (!config.presets[presetName]) {
    config.presets[presetName] = {};
  }

  // Ensure agent config exists in preset
  if (!config.presets[presetName][agentName]) {
    config.presets[presetName][agentName] = {};
  }

  // Set the model
  config.presets[presetName][agentName].model = model;

  // Set active preset if not already set
  if (!config.preset) {
    config.preset = presetName;
  }

  return config;
}

/**
 * Get all agent model assignments from the config.
 */
export function getAllAgentModels(
  config: PluginConfig,
): Record<AgentName, string> {
  const agents: AgentName[] = [
    'orchestrator',
    'explorer',
    'librarian',
    'oracle',
    'designer',
    'fixer',
    'summarizer',
  ];

  const result: Record<string, string> = {};

  for (const agent of agents) {
    const model = getModelForAgent(config, agent);
    if (model) {
      result[agent] = model;
    }
  }

  return result as Record<AgentName, string>;
}

/**
 * Validate the config structure.
 */
export function validatePluginConfig(config: PluginConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  const result = PluginConfigSchema.safeParse(config);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${issue.path.join('.')}: ${issue.message}`);
    }
  }

  // Check that all agents have models if a preset is active
  if (config.preset) {
    const preset = config.presets?.[config.preset];
    if (!preset) {
      errors.push(`Active preset "${config.preset}" not found in presets`);
    } else {
      const requiredAgents: AgentName[] = [
        'orchestrator',
        'explorer',
        'librarian',
        'oracle',
        'designer',
        'fixer',
        'summarizer',
      ];

      for (const agent of requiredAgents) {
        const model = getModelForAgent(config, agent);
        if (!model) {
          errors.push(`Missing model for agent: ${agent}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Get model cost information.
 */
export function getModelCost(model: string): { input: number; output: number } {
  const normalized = model.startsWith('openai/') ? model : `openai/${model}`;

  if (MODEL_COSTS[normalized]) {
    return MODEL_COSTS[normalized];
  }

  for (const [key, costs] of Object.entries(MODEL_COSTS)) {
    if (key.includes(model) || model.includes(key.split('/')[1] ?? '')) {
      return costs;
    }
  }

  return { input: 0, output: 0 };
}

/**
 * Get token discipline settings from config.
 */
export function getTokenDisciplineSettings(
  config: PluginConfig,
): TokenDisciplineSettings {
  return (
    config.tokenDiscipline?.settings ?? {
      enforceIsolation: true,
      maxPacketSize: 2500,
      maxResolutionsPerTask: 3,
      threadArchiveHours: 24,
    }
  );
}

/**
 * Create a default config file.
 */
export function createDefaultConfig(): PluginConfig {
  const defaultConfig: PluginConfig = {
    preset: 'manual',
    presets: {
      manual: {
        orchestrator: { model: 'kimi-for-coding/k2p5' },
        explorer: { model: 'openai/gpt-5.1-codex-mini' },
        librarian: { model: 'openai/gpt-5.1-codex-mini' },
        fixer: { model: 'openai/gpt-5.2-codex' },
        oracle: { model: 'openai/gpt-5.2-codex' },
        designer: { model: 'kimi-for-coding/k2p5' },
        summarizer: { model: 'openai/gpt-5.1-codex-mini' },
      },
    },
    fallback: {
      enabled: true,
      timeoutMs: 15000,
      chains: {
        orchestrator: [
          'kimi-for-coding/k2p5',
          'anthropic/claude-opus-4',
          'openai/o1',
          'openai/gpt-4o',
        ],
        fixer: [
          'openai/gpt-5.2-codex',
          'anthropic/claude-sonnet-4',
          'openai/gpt-4o',
        ],
        explorer: [
          'openai/gpt-5.1-codex-mini',
          'anthropic/claude-haiku-3.5',
          'openai/gpt-4o-mini',
          'google/gemini-2.0-flash',
        ],
      },
    },
    tokenDiscipline: {
      enabled: true,
      settings: {
        enforceIsolation: true,
        maxPacketSize: 2500,
        maxResolutionsPerTask: 3,
        threadArchiveHours: 24,
      },
    },
  };

  saveConfig(defaultConfig);
  return defaultConfig;
}
