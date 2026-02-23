import type { AgentName } from '../config/constants';
import { ALL_AGENT_NAMES } from '../config/constants';
import defaultModelsConfig from '../config/models.default.json';

// Types
export type ModelTier = 'premium' | 'high' | 'medium' | 'low' | 'free';

export type ModelCapability =
  | 'reasoning'
  | 'toolcall'
  | 'code'
  | 'fast'
  | 'vision'
  | 'large-context';

export interface ModelDefinition {
  tier: ModelTier;
  capabilities: ModelCapability[];
  context?: number;
  output?: number;
  variants?: string[];
}

export interface ProviderModels {
  models: Record<string, ModelDefinition>;
}

export interface AgentRequirements {
  preferredTier: ModelTier;
  fallbackTiers: ModelTier[];
  requiredCapabilities: ModelCapability[];
  preferredCapabilities: ModelCapability[];
  defaultVariant: string | null;
}

export interface ModelsConfig {
  providers: Record<string, ProviderModels>;
  agentRequirements: Record<AgentName, AgentRequirements>;
}

export interface ModelAssignment {
  model: string;
  variant?: string;
}

export interface ModelCandidate extends ModelDefinition {
  model: string; // Full model ID: provider/model-name
}

// Load and merge configs
export function loadModelsConfig(
  userConfig?: Partial<ModelsConfig>,
): ModelsConfig {
  // Deep clone the default config to prevent mutation
  const base = JSON.parse(JSON.stringify(defaultModelsConfig)) as ModelsConfig;

  if (!userConfig) {
    return base;
  }

  // Deep merge providers
  const mergedProviders = { ...base.providers };
  if (userConfig.providers) {
    for (const [provider, providerConfig] of Object.entries(
      userConfig.providers,
    )) {
      if (mergedProviders[provider]) {
        mergedProviders[provider] = {
          models: {
            ...mergedProviders[provider].models,
            ...providerConfig.models,
          },
        };
      } else {
        mergedProviders[provider] = providerConfig;
      }
    }
  }

  // Deep merge agent requirements
  const mergedRequirements = { ...base.agentRequirements };
  if (userConfig.agentRequirements) {
    for (const [agent, requirements] of Object.entries(
      userConfig.agentRequirements,
    )) {
      if (mergedRequirements[agent as AgentName]) {
        mergedRequirements[agent as AgentName] = {
          ...mergedRequirements[agent as AgentName],
          ...requirements,
        };
      }
    }
  }

  return {
    providers: mergedProviders,
    agentRequirements: mergedRequirements,
  };
}

// Get all models from available providers
function collectCandidates(
  availableProviders: string[],
  config: ModelsConfig,
): ModelCandidate[] {
  const candidates: ModelCandidate[] = [];

  for (const provider of availableProviders) {
    const providerConfig = config.providers[provider];
    if (!providerConfig) continue;

    for (const [name, meta] of Object.entries(providerConfig.models)) {
      candidates.push({
        model: `${provider}/${name}`,
        ...meta,
      });
    }
  }

  return candidates;
}

// Check if model meets required capabilities
function meetsRequirements(
  model: ModelCandidate,
  requirements: AgentRequirements,
): boolean {
  return requirements.requiredCapabilities.every((cap) =>
    model.capabilities.includes(cap),
  );
}

// Count how many preferred capabilities a model has
function countPreferredCapabilities(
  model: ModelCandidate,
  requirements: AgentRequirements,
): number {
  return requirements.preferredCapabilities.filter((cap) =>
    model.capabilities.includes(cap),
  ).length;
}

// Select best model for an agent
export function selectModelForAgent(
  agent: AgentName,
  availableProviders: string[],
  config: ModelsConfig,
): ModelAssignment | null {
  const requirements = config.agentRequirements[agent];
  if (!requirements) return null;

  // Collect all candidates from available providers
  const allCandidates = collectCandidates(availableProviders, config);

  // Filter by required capabilities
  const qualified = allCandidates.filter((m) =>
    meetsRequirements(m, requirements),
  );

  if (qualified.length === 0) return null;

  // Try tiers in preference order
  const tierOrder = [requirements.preferredTier, ...requirements.fallbackTiers];

  for (const tier of tierOrder) {
    const tierMatches = qualified.filter((m) => m.tier === tier);
    if (tierMatches.length === 0) continue;

    // Sort by preferred capabilities (more = better)
    const sorted = tierMatches.sort((a, b) => {
      const aScore = countPreferredCapabilities(a, requirements);
      const bScore = countPreferredCapabilities(b, requirements);
      return bScore - aScore;
    });

    const selected = sorted[0];
    return {
      model: selected.model,
      variant: requirements.defaultVariant ?? undefined,
    };
  }

  // Last resort: any qualified model
  return {
    model: qualified[0].model,
    variant: requirements.defaultVariant ?? undefined,
  };
}

// Build assignments for all agents
export function buildAgentAssignments(
  availableProviders: string[],
  config?: ModelsConfig,
): Record<AgentName, ModelAssignment> {
  const resolvedConfig = config ?? loadModelsConfig();
  const assignments: Partial<Record<AgentName, ModelAssignment>> = {};

  for (const agent of ALL_AGENT_NAMES) {
    const result = selectModelForAgent(
      agent,
      availableProviders,
      resolvedConfig,
    );
    if (result) {
      assignments[agent] = result;
    }
  }

  return assignments as Record<AgentName, ModelAssignment>;
}

// Build fallback chain for an agent (derived from tiers)
export function buildFallbackChain(
  agent: AgentName,
  availableProviders: string[],
  config?: ModelsConfig,
): string[] {
  const resolvedConfig = config ?? loadModelsConfig();
  const requirements = resolvedConfig.agentRequirements[agent];
  if (!requirements) return [];

  const tierOrder = [requirements.preferredTier, ...requirements.fallbackTiers];
  const chain: string[] = [];
  const seen = new Set<string>();

  for (const tier of tierOrder) {
    for (const provider of availableProviders) {
      const providerConfig = resolvedConfig.providers[provider];
      if (!providerConfig) continue;

      for (const [name, meta] of Object.entries(providerConfig.models)) {
        const modelId = `${provider}/${name}`;
        if (meta.tier === tier && !seen.has(modelId)) {
          if (meetsRequirements({ model: modelId, ...meta }, requirements)) {
            chain.push(modelId);
            seen.add(modelId);
          }
        }
      }
    }
  }

  return chain;
}

// Build fallback chains for all agents
export function buildAllFallbackChains(
  availableProviders: string[],
  config?: ModelsConfig,
): Record<AgentName, string[]> {
  const chains: Partial<Record<AgentName, string[]>> = {};

  for (const agent of ALL_AGENT_NAMES) {
    chains[agent] = buildFallbackChain(agent, availableProviders, config);
  }

  return chains as Record<AgentName, string[]>;
}

// Get list of available providers from config flags
export function getAvailableProviders(config: {
  hasAnthropic?: boolean;
  hasOpenAI?: boolean;
  hasAntigravity?: boolean;
  hasCopilot?: boolean;
  hasKimi?: boolean;
  hasZaiPlan?: boolean;
  hasChutes?: boolean;
  useOpenCodeFreeModels?: boolean;
}): string[] {
  const providers: string[] = [];

  if (config.hasAnthropic) providers.push('anthropic');
  if (config.hasOpenAI) providers.push('openai');
  if (config.hasAntigravity) providers.push('google');
  if (config.hasCopilot) providers.push('github-copilot');
  if (config.hasKimi) providers.push('kimi-for-coding');
  if (config.hasZaiPlan) providers.push('zai-coding-plan');
  if (config.hasChutes) providers.push('chutes');
  if (config.useOpenCodeFreeModels) providers.push('opencode');

  return providers;
}

// Convenience function: get assignments from install config
export function getAssignmentsFromInstallConfig(installConfig: {
  hasAnthropic?: boolean;
  hasOpenAI?: boolean;
  hasAntigravity?: boolean;
  hasCopilot?: boolean;
  hasKimi?: boolean;
  hasZaiPlan?: boolean;
  hasChutes?: boolean;
  useOpenCodeFreeModels?: boolean;
}): Record<AgentName, ModelAssignment> {
  const providers = getAvailableProviders(installConfig);
  return buildAgentAssignments(providers);
}
