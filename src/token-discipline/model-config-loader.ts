import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentName } from '../config/constants';
import {
  AGENT_TO_ROLE,
  DEFAULT_MODEL_CONFIG,
  MODEL_COSTS,
  type ModelAssignment,
  type ModelConfig,
  ModelConfigSchema,
  type ModelFallbacks,
  ROLE_TO_AGENT,
  type TokenDisciplineSettings,
  validateModelConfig,
} from './model-config';

const CONFIG_FILENAME = 'omoslim.json';

let configDir: string | null = null;
let cachedConfig: ModelConfig | null = null;

export function setConfigDirectory(dir: string): void {
  configDir = dir;
  cachedConfig = null;
}

function getConfigPath(): string {
  return configDir ? join(configDir, CONFIG_FILENAME) : CONFIG_FILENAME;
}

export async function loadModelConfig(): Promise<ModelConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = getConfigPath();

  try {
    const content = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(content);

    const validation = validateModelConfig(parsed);
    if (!validation.valid) {
      console.error('Model config validation errors:', validation.errors);
      console.warn('Using default configuration');
      cachedConfig = DEFAULT_MODEL_CONFIG;
      return cachedConfig;
    }

    const result = ModelConfigSchema.safeParse(parsed);
    if (result.success) {
      cachedConfig = result.data;
      return cachedConfig;
    }

    cachedConfig = DEFAULT_MODEL_CONFIG;
    return cachedConfig;
  } catch {
    cachedConfig = DEFAULT_MODEL_CONFIG;
    return cachedConfig;
  }
}

export async function saveModelConfig(config: ModelConfig): Promise<void> {
  const configPath = getConfigPath();

  if (configDir) {
    await mkdir(configDir, { recursive: true });
  }

  await writeFile(configPath, JSON.stringify(config, null, 2));
  cachedConfig = config;
}

export async function getModelForRole(role: string): Promise<string> {
  const config = await loadModelConfig();
  const roleLower = role.toLowerCase();

  const assignment = config.model_assignments[roleLower];
  if (assignment) {
    return assignment.model;
  }

  const agentName = ROLE_TO_AGENT[role.toUpperCase()];
  if (agentName) {
    const agentAssignment = config.model_assignments[agentName];
    if (agentAssignment) {
      return agentAssignment.model;
    }
  }

  throw new Error(`Unknown role: ${role}`);
}

export async function getModelForAgent(agent: AgentName): Promise<string> {
  const config = await loadModelConfig();

  const role = AGENT_TO_ROLE[agent];
  const assignment = config.model_assignments[role.toLowerCase()];
  if (assignment) {
    return assignment.model;
  }

  const agentAssignment = config.model_assignments[agent];
  if (agentAssignment) {
    return agentAssignment.model;
  }

  throw new Error(`Unknown agent: ${agent}`);
}

export async function getFallbackModels(tier: string): Promise<string[]> {
  const config = await loadModelConfig();
  return config.model_fallbacks[tier as keyof ModelFallbacks] ?? [];
}

export async function getTokenDisciplineSettings(): Promise<TokenDisciplineSettings> {
  const config = await loadModelConfig();
  return (
    config.token_discipline ?? {
      enforceIsolation: true,
      maxPacketSize: 2500,
      maxResolutionsPerTask: 3,
      threadArchiveHours: 24,
    }
  );
}

export async function getAssignmentForRole(
  role: string,
): Promise<ModelAssignment | null> {
  const config = await loadModelConfig();
  return config.model_assignments[role.toLowerCase()] ?? null;
}

export async function updateModelForRole(
  role: string,
  model: string,
): Promise<void> {
  const config = await loadModelConfig();
  const roleLower = role.toLowerCase();

  if (!config.model_assignments[roleLower]) {
    throw new Error(`Unknown role: ${role}`);
  }

  config.model_assignments[roleLower].model = model;
  await saveModelConfig(config);
}

export async function getAllAssignments(): Promise<
  Record<string, ModelAssignment>
> {
  const config = await loadModelConfig();
  return config.model_assignments;
}

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

export async function validateConfig(): Promise<{
  valid: boolean;
  errors: string[];
}> {
  const config = await loadModelConfig();
  return validateModelConfig(config);
}

export async function createDefaultConfig(
  configPath?: string,
): Promise<ModelConfig> {
  const path = configPath ?? getConfigPath();

  await writeFile(path, JSON.stringify(DEFAULT_MODEL_CONFIG, null, 2));
  cachedConfig = DEFAULT_MODEL_CONFIG;

  return DEFAULT_MODEL_CONFIG;
}

export function clearCache(): void {
  cachedConfig = null;
}
