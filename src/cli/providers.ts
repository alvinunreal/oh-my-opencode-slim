import { DEFAULT_AGENT_MCPS } from '../config/agent-mcps';
import { RECOMMENDED_SKILLS } from './skills';
import type { InstallConfig } from './types';

const AGENT_NAMES = [
  'orchestrator',
  'oracle',
  'designer',
  'explorer',
  'librarian',
  'fixer',
] as const;

type AgentName = (typeof AGENT_NAMES)[number];

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
    orchestrator: { model: 'openai/gpt-5.3-codex' },
    oracle: { model: 'openai/gpt-5.3-codex', variant: 'high' },
    librarian: { model: 'openai/gpt-5.1-codex-mini', variant: 'low' },
    explorer: { model: 'openai/gpt-5.1-codex-mini', variant: 'low' },
    designer: { model: 'openai/gpt-5.1-codex-mini', variant: 'medium' },
    fixer: { model: 'openai/gpt-5.1-codex-mini', variant: 'low' },
  },
  anthropic: {
    orchestrator: { model: 'anthropic/claude-opus-4-6' },
    oracle: { model: 'anthropic/claude-opus-4-6', variant: 'high' },
    librarian: { model: 'anthropic/claude-sonnet-4-5', variant: 'low' },
    explorer: { model: 'anthropic/claude-haiku-4-5', variant: 'low' },
    designer: { model: 'anthropic/claude-sonnet-4-5', variant: 'medium' },
    fixer: { model: 'anthropic/claude-sonnet-4-5', variant: 'low' },
  },
  copilot: {
    orchestrator: { model: 'github-copilot/grok-code-fast-1' },
    oracle: { model: 'github-copilot/grok-code-fast-1', variant: 'high' },
    librarian: { model: 'github-copilot/grok-code-fast-1', variant: 'low' },
    explorer: { model: 'github-copilot/grok-code-fast-1', variant: 'low' },
    designer: { model: 'github-copilot/grok-code-fast-1', variant: 'medium' },
    fixer: { model: 'github-copilot/grok-code-fast-1', variant: 'low' },
  },
  'zai-plan': {
    orchestrator: { model: 'zai-coding-plan/glm-4.7' },
    oracle: { model: 'zai-coding-plan/glm-4.7', variant: 'high' },
    librarian: { model: 'zai-coding-plan/glm-4.7', variant: 'low' },
    explorer: { model: 'zai-coding-plan/glm-4.7', variant: 'low' },
    designer: { model: 'zai-coding-plan/glm-4.7', variant: 'medium' },
    fixer: { model: 'zai-coding-plan/glm-4.7', variant: 'low' },
  },
  antigravity: {
    orchestrator: { model: 'google/antigravity-gemini-3-flash' },
    oracle: { model: 'google/antigravity-gemini-3.1-pro' },
    librarian: {
      model: 'google/antigravity-gemini-3-flash',
      variant: 'low',
    },
    explorer: {
      model: 'google/antigravity-gemini-3-flash',
      variant: 'low',
    },
    designer: {
      model: 'google/antigravity-gemini-3-flash',
      variant: 'medium',
    },
    fixer: { model: 'google/antigravity-gemini-3-flash', variant: 'low' },
  },
  chutes: {
    orchestrator: { model: 'chutes/kimi-k2.5' },
    oracle: { model: 'chutes/kimi-k2.5', variant: 'high' },
    librarian: { model: 'chutes/minimax-m2.1', variant: 'low' },
    explorer: { model: 'chutes/minimax-m2.1', variant: 'low' },
    designer: { model: 'chutes/kimi-k2.5', variant: 'medium' },
    fixer: { model: 'chutes/minimax-m2.1', variant: 'low' },
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

export function generateAntigravityMixedPreset(
  config: InstallConfig,
  existingPreset?: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = existingPreset
    ? { ...existingPreset }
    : {};

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

  const antigravityFlash = {
    model: 'google/antigravity-gemini-3-flash',
  };

  const chutesPrimary =
    config.selectedChutesPrimaryModel ??
    MODEL_MAPPINGS.chutes.orchestrator.model;
  const chutesSupport =
    config.selectedChutesSecondaryModel ?? MODEL_MAPPINGS.chutes.explorer.model;

  // Orchestrator: Kimi if hasKimi, else Chutes Kimi if enabled, else antigravity
  if (config.hasKimi) {
    result.orchestrator = createAgentConfig(
      'orchestrator',
      MODEL_MAPPINGS.kimi.orchestrator,
    );
  } else if (config.hasChutes) {
    result.orchestrator = createAgentConfig('orchestrator', {
      model: chutesPrimary,
    });
  } else if (!result.orchestrator) {
    result.orchestrator = createAgentConfig(
      'orchestrator',
      MODEL_MAPPINGS.antigravity.orchestrator,
    );
  }

  // Oracle: GPT if hasOpenAI, else keep existing if exists, else antigravity
  if (config.hasOpenAI) {
    result.oracle = createAgentConfig('oracle', MODEL_MAPPINGS.openai.oracle);
  } else if (!result.oracle) {
    result.oracle = createAgentConfig(
      'oracle',
      MODEL_MAPPINGS.antigravity.oracle,
    );
  }

  // Explorer stays flash-first for speed.
  result.explorer = createAgentConfig('explorer', {
    ...antigravityFlash,
    variant: 'low',
  });

  // Librarian/Designer prefer Kimi-K2.5 via Chutes when available.
  if (config.hasChutes) {
    result.librarian = createAgentConfig('librarian', {
      model: chutesSupport,
      variant: 'low',
    });
    result.designer = createAgentConfig('designer', {
      model: chutesPrimary,
      variant: 'medium',
    });
  } else {
    result.librarian = createAgentConfig('librarian', {
      ...antigravityFlash,
      variant: 'low',
    });
    result.designer = createAgentConfig('designer', {
      ...antigravityFlash,
      variant: 'medium',
    });
  }

  // Fixer prefers OpenAI codex when available.
  if (config.hasOpenAI) {
    result.fixer = createAgentConfig('fixer', {
      ...MODEL_MAPPINGS.openai.oracle,
      variant: 'low',
    });
  } else if (config.hasChutes) {
    result.fixer = createAgentConfig('fixer', {
      model: chutesSupport,
      variant: 'low',
    });
  } else {
    result.fixer = createAgentConfig('fixer', {
      ...antigravityFlash,
      variant: 'low',
    });
  }

  return result;
}

export function generateLiteConfig(
  installConfig: InstallConfig,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    preset: 'zen-free',
    presets: {},
    balanceProviderUsage: installConfig.balanceProviderUsage ?? false,
  };

  // Handle manual configuration mode
  if (
    installConfig.setupMode === 'manual' &&
    installConfig.manualAgentConfigs
  ) {
    config.preset = 'manual';
    const manualPreset: Record<string, unknown> = {};
    const chains: Record<string, string[]> = {};

    for (const agentName of AGENT_NAMES) {
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

  // Determine active preset name
  let activePreset:
    | 'kimi'
    | 'openai'
    | 'anthropic'
    | 'copilot'
    | 'zai-plan'
    | 'antigravity'
    | 'chutes'
    | 'antigravity-mixed-both'
    | 'antigravity-mixed-kimi'
    | 'antigravity-mixed-openai'
    | 'zen-free' = 'zen-free';

  // Antigravity mixed presets have priority
  if (
    installConfig.hasAntigravity &&
    installConfig.hasKimi &&
    installConfig.hasOpenAI
  ) {
    activePreset = 'antigravity-mixed-both';
  } else if (installConfig.hasAntigravity && installConfig.hasKimi) {
    activePreset = 'antigravity-mixed-kimi';
  } else if (installConfig.hasAntigravity && installConfig.hasOpenAI) {
    activePreset = 'antigravity-mixed-openai';
  } else if (installConfig.hasAntigravity) {
    activePreset = 'antigravity';
  } else if (installConfig.hasKimi) {
    activePreset = 'kimi';
  } else if (installConfig.hasOpenAI) {
    activePreset = 'openai';
  } else if (installConfig.hasAnthropic) {
    activePreset = 'anthropic';
  } else if (installConfig.hasCopilot) {
    activePreset = 'copilot';
  } else if (installConfig.hasZaiPlan) {
    activePreset = 'zai-plan';
  } else if (installConfig.hasChutes) {
    activePreset = 'chutes';
  }

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

  if (installConfig.dynamicModelPlan) {
    const dynamicPreset = Object.fromEntries(
      Object.entries(installConfig.dynamicModelPlan.agents).map(
        ([agentName, assignment]) => [
          agentName,
          createAgentConfig(
            agentName,
            assignment as { model: string; variant?: string },
          ),
        ],
      ),
    );

    config.preset = 'dynamic';
    (config.presets as Record<string, unknown>).dynamic = dynamicPreset;
    config.fallback = {
      enabled: true,
      timeoutMs: 15000,
      chains: installConfig.dynamicModelPlan.chains,
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

  const applyOpenCodeFreeAssignments = (
    presetAgents: Record<string, unknown>,
    hasExternalProviders: boolean,
  ) => {
    if (!installConfig.useOpenCodeFreeModels) return;

    const primaryModel = installConfig.selectedOpenCodePrimaryModel;
    const secondaryModel =
      installConfig.selectedOpenCodeSecondaryModel ?? primaryModel;

    if (!primaryModel || !secondaryModel) return;

    const setAgent = (agentName: string, model: string) => {
      presetAgents[agentName] = createAgentConfig(agentName, { model });
    };

    if (!hasExternalProviders) {
      setAgent('orchestrator', primaryModel);
      setAgent('oracle', primaryModel);
      setAgent('designer', primaryModel);
    }

    setAgent('librarian', secondaryModel);
    setAgent('explorer', secondaryModel);
    setAgent('fixer', secondaryModel);
  };

  const applyChutesAssignments = (presetAgents: Record<string, unknown>) => {
    if (!installConfig.hasChutes) return;

    const hasExternalProviders =
      installConfig.hasKimi ||
      installConfig.hasOpenAI ||
      installConfig.hasAnthropic ||
      installConfig.hasCopilot ||
      installConfig.hasZaiPlan ||
      installConfig.hasAntigravity;

    if (hasExternalProviders && activePreset !== 'chutes') return;

    const primaryModel = installConfig.selectedChutesPrimaryModel;
    const secondaryModel =
      installConfig.selectedChutesSecondaryModel ?? primaryModel;

    if (!primaryModel || !secondaryModel) return;

    const setAgent = (agentName: string, model: string) => {
      presetAgents[agentName] = createAgentConfig(agentName, { model });
    };

    setAgent('orchestrator', primaryModel);
    setAgent('oracle', primaryModel);
    setAgent('designer', primaryModel);
    setAgent('librarian', secondaryModel);
    setAgent('explorer', secondaryModel);
    setAgent('fixer', secondaryModel);
  };

  const dedupeModels = (models: Array<string | undefined>) => {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const model of models) {
      if (!model || seen.has(model)) continue;
      seen.add(model);
      result.push(model);
    }

    return result;
  };

  const getOpenCodeFallbackForAgent = (agentName: AgentName) => {
    if (!installConfig.useOpenCodeFreeModels) return undefined;
    const isSupport =
      agentName === 'explorer' ||
      agentName === 'librarian' ||
      agentName === 'fixer';
    if (isSupport) {
      return (
        installConfig.selectedOpenCodeSecondaryModel ??
        installConfig.selectedOpenCodePrimaryModel
      );
    }
    return installConfig.selectedOpenCodePrimaryModel;
  };

  const getChutesFallbackForAgent = (agentName: AgentName) => {
    if (!installConfig.hasChutes) return undefined;
    const isSupport =
      agentName === 'explorer' ||
      agentName === 'librarian' ||
      agentName === 'fixer';
    if (isSupport) {
      return (
        installConfig.selectedChutesSecondaryModel ??
        installConfig.selectedChutesPrimaryModel ??
        MODEL_MAPPINGS.chutes[agentName].model
      );
    }
    return (
      installConfig.selectedChutesPrimaryModel ??
      MODEL_MAPPINGS.chutes[agentName].model
    );
  };

  const attachFallbackConfig = (presetAgents: Record<string, unknown>) => {
    const chains: Partial<Record<AgentName, string[]>> = {};

    for (const agentName of AGENT_NAMES) {
      const currentModel = (
        presetAgents[agentName] as { model?: string } | undefined
      )?.model;

      const chain = dedupeModels([
        currentModel,
        installConfig.hasOpenAI
          ? MODEL_MAPPINGS.openai[agentName].model
          : undefined,
        installConfig.hasAnthropic
          ? MODEL_MAPPINGS.anthropic[agentName].model
          : undefined,
        installConfig.hasCopilot
          ? MODEL_MAPPINGS.copilot[agentName].model
          : undefined,
        installConfig.hasZaiPlan
          ? MODEL_MAPPINGS['zai-plan'][agentName].model
          : undefined,
        installConfig.hasKimi
          ? MODEL_MAPPINGS.kimi[agentName].model
          : undefined,
        installConfig.hasAntigravity
          ? MODEL_MAPPINGS.antigravity[agentName].model
          : undefined,
        getChutesFallbackForAgent(agentName),
        getOpenCodeFallbackForAgent(agentName),
        MODEL_MAPPINGS['zen-free'][agentName].model,
      ]);

      if (chain.length > 0) {
        chains[agentName] = chain;
      }
    }

    config.fallback = {
      enabled: true,
      timeoutMs: 15000,
      chains,
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

  // Build preset based on type
  if (
    activePreset === 'antigravity-mixed-both' ||
    activePreset === 'antigravity-mixed-kimi' ||
    activePreset === 'antigravity-mixed-openai'
  ) {
    // Use dedicated mixed preset generator
    (config.presets as Record<string, unknown>)[activePreset] =
      generateAntigravityMixedPreset(installConfig);

    applyOpenCodeFreeAssignments(
      (config.presets as Record<string, Record<string, unknown>>)[activePreset],
      installConfig.hasKimi ||
        installConfig.hasOpenAI ||
        installConfig.hasAnthropic ||
        installConfig.hasCopilot ||
        installConfig.hasZaiPlan ||
        installConfig.hasAntigravity ||
        installConfig.hasChutes === true,
    );
    applyChutesAssignments(
      (config.presets as Record<string, Record<string, unknown>>)[activePreset],
    );
    attachFallbackConfig(
      (config.presets as Record<string, Record<string, unknown>>)[activePreset],
    );
  } else {
    // Use standard buildPreset for pure presets
    (config.presets as Record<string, unknown>)[activePreset] =
      buildPreset(activePreset);

    applyOpenCodeFreeAssignments(
      (config.presets as Record<string, Record<string, unknown>>)[activePreset],
      installConfig.hasKimi ||
        installConfig.hasOpenAI ||
        installConfig.hasAnthropic ||
        installConfig.hasCopilot ||
        installConfig.hasZaiPlan ||
        installConfig.hasAntigravity ||
        installConfig.hasChutes === true,
    );
    applyChutesAssignments(
      (config.presets as Record<string, Record<string, unknown>>)[activePreset],
    );
    attachFallbackConfig(
      (config.presets as Record<string, Record<string, unknown>>)[activePreset],
    );
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
