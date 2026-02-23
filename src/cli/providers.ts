import { DEFAULT_AGENT_MCPS } from '../config/agent-mcps';
import type { AgentName } from '../config/constants';
import { ALL_AGENT_NAMES } from '../config/constants';
import { RECOMMENDED_SKILLS } from './skills';
import {
  buildAgentAssignments,
  buildAllFallbackChains,
  getAvailableProviders,
  type ModelAssignment,
} from './tier-selection';
import type { InstallConfig } from './types';

// Create agent config with skills and MCPs
function createAgentConfig(
  agentName: AgentName,
  assignment: ModelAssignment,
): Record<string, unknown> {
  const isOrchestrator = agentName === 'orchestrator';

  // Skills: orchestrator gets "*", others get recommended skills for their role
  const skills = isOrchestrator
    ? ['*']
    : RECOMMENDED_SKILLS.filter(
        (s) =>
          s.allowedAgents.includes('*') || s.allowedAgents.includes(agentName),
      ).map((s) => s.skillName);

  // Special case for designer and agent-browser skill
  if (agentName === 'designer' && !skills.includes('agent-browser')) {
    skills.push('agent-browser');
  }

  return {
    model: assignment.model,
    variant: assignment.variant,
    skills,
    mcps:
      DEFAULT_AGENT_MCPS[agentName as keyof typeof DEFAULT_AGENT_MCPS] ?? [],
  };
}

// Generate config from tier-based selection
export function generateLiteConfig(
  installConfig: InstallConfig,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    presets: {},
  };

  // Handle manual configuration mode
  if (
    installConfig.setupMode === 'manual' &&
    installConfig.manualAgentConfigs
  ) {
    config.preset = 'manual';
    const manualPreset: Record<string, unknown> = {};
    const chains: Record<string, string[]> = {};

    for (const agentName of ALL_AGENT_NAMES) {
      const manualConfig = installConfig.manualAgentConfigs[agentName];
      if (manualConfig) {
        manualPreset[agentName] = {
          model: manualConfig.primary,
          skills:
            agentName === 'orchestrator'
              ? ['*']
              : RECOMMENDED_SKILLS.filter(
                  (s) =>
                    s.allowedAgents.includes('*') ||
                    s.allowedAgents.includes(agentName),
                ).map((s) => s.skillName),
          mcps:
            DEFAULT_AGENT_MCPS[agentName as keyof typeof DEFAULT_AGENT_MCPS] ??
            [],
        };

        // Build fallback chain from manual config
        const fallbackChain = [
          manualConfig.primary,
          manualConfig.fallback1,
          manualConfig.fallback2,
          manualConfig.fallback3,
        ].filter((m, i, arr) => m && arr.indexOf(m) === i); // dedupe
        chains[agentName] = fallbackChain;
      }
    }

    (config.presets as Record<string, unknown>).manual = manualPreset;
    config.fallback = {
      enabled: true,
      timeoutMs: 15000,
      chains,
    };

    if (installConfig.hasTmux) {
      config.tmux = {
        enabled: true,
        layout: 'main-vertical',
        main_pane_size: 60,
      };
    }

    return config;
  }

  // Get available providers from install config
  const availableProviders = getAvailableProviders(installConfig);

  // Use tier-based selection to get model assignments
  const assignments = buildAgentAssignments(availableProviders);

  // Build the preset from assignments
  const preset: Record<string, unknown> = {};
  for (const agentName of ALL_AGENT_NAMES) {
    const assignment = assignments[agentName];
    if (assignment) {
      preset[agentName] = createAgentConfig(agentName, assignment);
    }
  }

  // Build fallback chains from tiers
  const chains = buildAllFallbackChains(availableProviders);

  // Determine preset name based on available providers
  const presetName = determinePresetName(installConfig);
  config.preset = presetName;
  (config.presets as Record<string, unknown>)[presetName] = preset;

  // Add fallback configuration
  config.fallback = {
    enabled: true,
    timeoutMs: 15000,
    chains,
  };

  // Add tmux config if enabled
  if (installConfig.hasTmux) {
    config.tmux = {
      enabled: true,
      layout: 'main-vertical',
      main_pane_size: 60,
    };
  }

  return config;
}

// Determine a descriptive preset name based on available providers
function determinePresetName(installConfig: InstallConfig): string {
  const providers: string[] = [];

  if (installConfig.hasAnthropic) providers.push('anthropic');
  if (installConfig.hasOpenAI) providers.push('openai');
  if (installConfig.hasAntigravity) providers.push('google');
  if (installConfig.hasCopilot) providers.push('copilot');
  if (installConfig.hasKimi) providers.push('kimi');
  if (installConfig.hasZaiPlan) providers.push('zai');
  if (installConfig.hasChutes) providers.push('chutes');

  if (providers.length === 0) {
    return installConfig.useOpenCodeFreeModels ? 'free' : 'default';
  }

  if (providers.length === 1) {
    return providers[0];
  }

  // Multiple providers - create a combined name
  return providers.slice(0, 3).join('-');
}

// Re-export for backwards compatibility during migration
export { buildAgentAssignments, getAvailableProviders } from './tier-selection';
