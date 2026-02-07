import type {
  DiscoveredModel,
  DynamicModelPlan,
  ExternalSignalMap,
  InstallConfig,
} from './types';

const AGENTS = [
  'orchestrator',
  'oracle',
  'designer',
  'explorer',
  'librarian',
  'fixer',
] as const;

type AgentName = (typeof AGENTS)[number];

const FREE_BIASED_PROVIDERS = new Set(['opencode']);
const PRIMARY_ASSIGNMENT_ORDER: AgentName[] = [
  'oracle',
  'orchestrator',
  'fixer',
  'designer',
  'librarian',
  'explorer',
];

const ROLE_VARIANT: Record<AgentName, string | undefined> = {
  orchestrator: undefined,
  oracle: 'high',
  designer: 'medium',
  explorer: 'low',
  librarian: 'low',
  fixer: 'low',
};

function getEnabledProviders(config: InstallConfig): string[] {
  const providers: string[] = [];
  if (config.hasOpenAI) providers.push('openai');
  if (config.hasAnthropic) providers.push('anthropic');
  if (config.hasCopilot) providers.push('github-copilot');
  if (config.hasZaiPlan) providers.push('zai-coding-plan');
  if (config.hasKimi) providers.push('kimi-for-coding');
  if (config.hasAntigravity) providers.push('google');
  if (config.hasChutes) providers.push('chutes');
  if (config.useOpenCodeFreeModels) providers.push('opencode');
  return providers;
}

function tokenScore(name: string, re: RegExp, points: number): number {
  return re.test(name) ? points : 0;
}

function statusScore(status: DiscoveredModel['status']): number {
  if (status === 'active') return 20;
  if (status === 'beta') return 8;
  if (status === 'alpha') return -5;
  return -40;
}

function baseScore(model: DiscoveredModel): number {
  const lowered = `${model.model} ${model.name}`.toLowerCase();
  const context = Math.min(model.contextLimit, 1_000_000) / 50_000;
  const output = Math.min(model.outputLimit, 300_000) / 30_000;
  const deep = tokenScore(
    lowered,
    /(opus|pro|thinking|reason|r1|gpt-5|k2\.5)/i,
    12,
  );
  const fast = tokenScore(
    lowered,
    /(nano|flash|mini|lite|fast|turbo|haiku|small)/i,
    4,
  );
  const code = tokenScore(lowered, /(codex|coder|code|dev|program)/i, 12);
  const versionBoost =
    tokenScore(lowered, /gpt-5\.3/i, 12) +
    tokenScore(lowered, /gpt-5\.2/i, 8) +
    tokenScore(lowered, /k2\.5/i, 6);

  return (
    statusScore(model.status) +
    context +
    output +
    deep +
    fast +
    code +
    versionBoost +
    (model.toolcall ? 25 : 0)
  );
}

function hasFlashToken(model: DiscoveredModel): boolean {
  return /flash/i.test(`${model.model} ${model.name}`);
}

function isZai47Model(model: DiscoveredModel): boolean {
  return (
    model.providerID === 'zai-coding-plan' &&
    /glm-4\.7/i.test(`${model.model} ${model.name}`)
  );
}

function isKimiK25Model(model: DiscoveredModel): boolean {
  return /kimi-k2\.?5|k2\.?5/i.test(`${model.model} ${model.name}`);
}

function geminiPreferenceAdjustment(
  agent: AgentName,
  model: DiscoveredModel,
): number {
  const lowered = `${model.model} ${model.name}`.toLowerCase();
  const isGemini3Pro = /gemini-3-pro|gemini-3\.0-pro|gemini-3-pro-preview/.test(
    lowered,
  );
  const isGemini25Pro = /gemini-2\.5-pro/.test(lowered);
  const antigravityNamingBonus =
    model.providerID === 'google' && lowered.includes('antigravity-') ? 4 : 0;

  const deepRoleBoost =
    agent === 'oracle' ||
    agent === 'orchestrator' ||
    agent === 'fixer' ||
    agent === 'librarian' ||
    agent === 'designer'
      ? 24
      : 8;

  const gemini3Boost = isGemini3Pro ? deepRoleBoost : 0;
  const gemini25Penalty = isGemini25Pro && !isGemini3Pro ? -14 : 0;

  return gemini3Boost + gemini25Penalty + antigravityNamingBonus;
}

function modelLookupKeys(model: DiscoveredModel): string[] {
  const fullKey = model.model.toLowerCase();
  const idKey = model.model.split('/')[1]?.toLowerCase();
  const keys = new Set<string>();

  keys.add(fullKey);
  if (idKey) keys.add(idKey);

  if (model.providerID === 'chutes' && idKey) {
    keys.add(`chutes/${idKey}`);
    keys.add(idKey.replace(/-(free|flash)$/i, ''));
  }

  return [...keys];
}

function roleScore(agent: AgentName, model: DiscoveredModel): number {
  const lowered = `${model.model} ${model.name}`.toLowerCase();
  const reasoning = model.reasoning ? 1 : 0;
  const toolcall = model.toolcall ? 1 : 0;
  const attachment = model.attachment ? 1 : 0;
  const context = Math.min(model.contextLimit, 1_000_000) / 60_000;
  const output = Math.min(model.outputLimit, 300_000) / 40_000;
  const deep = tokenScore(
    lowered,
    /(opus|pro|thinking|reason|r1|gpt-5|k2\.5)/i,
    1,
  );
  const fast = tokenScore(
    lowered,
    /(nano|flash|mini|lite|fast|turbo|haiku|small)/i,
    1,
  );
  const code = tokenScore(lowered, /(codex|coder|code|dev|program)/i, 1);

  if (
    (agent === 'orchestrator' ||
      agent === 'explorer' ||
      agent === 'librarian' ||
      agent === 'fixer') &&
    !model.toolcall
  ) {
    return -10_000;
  }

  if (model.status === 'deprecated') {
    return -5_000;
  }

  const score = baseScore(model);
  const flash = hasFlashToken(model);
  const isZai47 = isZai47Model(model);
  const zai47Flash = isZai47 && flash;
  const zai47NonFlash = isZai47 && !flash;
  const providerBias =
    model.providerID === 'openai'
      ? 3
      : model.providerID === 'anthropic'
        ? 3
        : model.providerID === 'kimi-for-coding'
          ? 2
          : model.providerID === 'google'
            ? 2
            : model.providerID === 'github-copilot'
              ? 1
              : model.providerID === 'zai-coding-plan'
                ? 0
                : model.providerID === 'chutes'
                  ? 2
                  : model.providerID === 'opencode'
                    ? -2
                    : 0;
  const geminiAdjustment = geminiPreferenceAdjustment(agent, model);

  if (agent === 'orchestrator') {
    const flashAdjustment = flash ? -22 : 0;
    const zaiAdjustment = zai47NonFlash ? 16 : zai47Flash ? -18 : 0;
    const nonReasoningFlashPenalty = flash && !model.reasoning ? -16 : 0;
    return (
      score +
      reasoning * 40 +
      toolcall * 25 +
      deep * 10 +
      code * 8 +
      context +
      flashAdjustment +
      zaiAdjustment +
      nonReasoningFlashPenalty +
      geminiAdjustment +
      providerBias
    );
  }
  if (agent === 'oracle') {
    const flashAdjustment = flash ? -34 : 0;
    const zaiAdjustment = zai47NonFlash ? 16 : zai47Flash ? -18 : 0;
    const nonReasoningFlashPenalty = flash && !model.reasoning ? -16 : 0;
    return (
      score +
      reasoning * 55 +
      deep * 18 +
      context * 1.2 +
      toolcall * 10 +
      flashAdjustment +
      zaiAdjustment +
      nonReasoningFlashPenalty +
      geminiAdjustment +
      providerBias
    );
  }
  if (agent === 'designer') {
    const flashAdjustment = flash ? -8 : 0;
    const zaiAdjustment = zai47NonFlash ? 10 : zai47Flash ? -8 : 0;
    return (
      score +
      attachment * 25 +
      reasoning * 18 +
      toolcall * 15 +
      context * 0.8 +
      output +
      flashAdjustment +
      zaiAdjustment +
      geminiAdjustment +
      providerBias
    );
  }
  if (agent === 'explorer') {
    const flashAdjustment = flash ? 26 : -10;
    const zaiAdjustment = zai47NonFlash ? 2 : zai47Flash ? 6 : 0;
    const deepPenalty = deep * -18;
    return (
      score +
      fast * 68 +
      toolcall * 28 +
      reasoning * 2 +
      context * 0.2 +
      flashAdjustment +
      zaiAdjustment +
      deepPenalty +
      geminiAdjustment +
      providerBias
    );
  }
  if (agent === 'librarian') {
    const flashAdjustment = flash ? -12 : 0;
    const zaiAdjustment = zai47NonFlash ? 16 : zai47Flash ? -18 : 0;
    return (
      score +
      context * 30 +
      toolcall * 22 +
      reasoning * 15 +
      output * 10 +
      flashAdjustment +
      zaiAdjustment +
      geminiAdjustment +
      providerBias
    );
  }

  const flashAdjustment = flash ? -18 : 0;
  const zaiAdjustment = zai47NonFlash ? 16 : zai47Flash ? -18 : 0;
  const nonReasoningFlashPenalty = flash && !model.reasoning ? -16 : 0;
  return (
    score +
    code * 28 +
    toolcall * 24 +
    fast * 18 +
    reasoning * 14 +
    output * 8 +
    flashAdjustment +
    zaiAdjustment +
    nonReasoningFlashPenalty +
    geminiAdjustment +
    providerBias
  );
}

function getExternalSignalBoost(
  agent: AgentName,
  model: DiscoveredModel,
  externalSignals: ExternalSignalMap | undefined,
): number {
  if (!externalSignals) return 0;

  const signal = modelLookupKeys(model)
    .map((key) => externalSignals[key])
    .find((item) => item !== undefined);

  if (!signal) return 0;

  const qualityScore = signal.qualityScore ?? 0;
  const codingScore = signal.codingScore ?? 0;
  const latencySeconds = signal.latencySeconds;

  const blendedPrice =
    signal.inputPricePer1M !== undefined &&
    signal.outputPricePer1M !== undefined
      ? signal.inputPricePer1M * 0.75 + signal.outputPricePer1M * 0.25
      : (signal.inputPricePer1M ?? signal.outputPricePer1M ?? 0);
  if (agent === 'explorer') {
    const qualityBoost = qualityScore * 0.05;
    const codingBoost = codingScore * 0.08;
    const latencyPenalty =
      typeof latencySeconds === 'number' && Number.isFinite(latencySeconds)
        ? Math.min(latencySeconds, 12) * 3.2 +
          (latencySeconds > 7 ? 16 : latencySeconds > 4 ? 10 : 0)
        : 0;
    const pricePenalty = Math.min(blendedPrice, 30) * 0.03;
    const qualityFloorPenalty =
      qualityScore > 0 && qualityScore < 35 ? (35 - qualityScore) * 0.8 : 0;
    const boost =
      qualityBoost +
      codingBoost -
      latencyPenalty -
      pricePenalty -
      qualityFloorPenalty;
    return Math.max(-90, Math.min(25, boost));
  }

  const qualityBoost = qualityScore * 0.16;
  const codingBoost = codingScore * 0.24;
  const latencyPenalty =
    typeof latencySeconds === 'number' && Number.isFinite(latencySeconds)
      ? Math.min(latencySeconds, 25) * 0.22
      : 0;
  const pricePenalty = Math.min(blendedPrice, 30) * 0.08;
  const boost = qualityBoost + codingBoost - latencyPenalty - pricePenalty;
  return Math.max(-30, Math.min(45, boost));
}

function rankModels(
  models: DiscoveredModel[],
  agent: AgentName,
  externalSignals?: ExternalSignalMap,
): DiscoveredModel[] {
  return [...models].sort((a, b) => {
    const scoreA =
      roleScore(agent, a) + getExternalSignalBoost(agent, a, externalSignals);
    const scoreB =
      roleScore(agent, b) + getExternalSignalBoost(agent, b, externalSignals);
    const scoreDelta = scoreB - scoreA;
    if (scoreDelta !== 0) return scoreDelta;

    const providerTieBreak = a.providerID.localeCompare(b.providerID);
    if (providerTieBreak !== 0) return providerTieBreak;

    return a.model.localeCompare(b.model);
  });
}

function combinedScore(
  agent: AgentName,
  model: DiscoveredModel,
  externalSignals?: ExternalSignalMap,
): number {
  return (
    roleScore(agent, model) +
    getExternalSignalBoost(agent, model, externalSignals)
  );
}

function chooseProviderRepresentative(
  providerModels: DiscoveredModel[],
  agent: AgentName,
  externalSignals?: ExternalSignalMap,
): DiscoveredModel | null {
  if (providerModels.length === 0) return null;

  const flashBest = providerModels.find((model) => hasFlashToken(model));
  const nonFlashBest = providerModels.find((model) => !hasFlashToken(model));

  if (!nonFlashBest) return providerModels[0] ?? null;
  if (!flashBest) return nonFlashBest;

  const flashScore = combinedScore(agent, flashBest, externalSignals);
  const nonFlashScore = combinedScore(agent, nonFlashBest, externalSignals);
  const threshold = agent === 'explorer' ? -6 : 12;
  return flashScore >= nonFlashScore + threshold ? flashBest : nonFlashBest;
}

function selectPrimaryWithDiversity(
  candidates: DiscoveredModel[],
  agent: AgentName,
  providerUsage: Map<string, number>,
  maxShare: number,
  externalSignals?: ExternalSignalMap,
): DiscoveredModel | null {
  if (candidates.length === 0) return null;

  const candidateScores = candidates.map((model) => {
    const usage = providerUsage.get(model.providerID) ?? 0;
    const diversityPenalty =
      usage === 0 ? 0 : usage === 1 ? 12 : usage === 2 ? 26 : 42;
    const unusedBonus = usage === 0 ? 8 : 0;
    const overCapPenalty = usage >= maxShare ? 25 : 0;
    const rawScore = combinedScore(agent, model, externalSignals);
    const adjustedScore =
      rawScore - diversityPenalty + unusedBonus - overCapPenalty;

    return {
      model,
      usage,
      rawScore,
      adjustedScore: Math.round(adjustedScore * 1000) / 1000,
    };
  });

  candidateScores.sort((a, b) => {
    const delta = b.adjustedScore - a.adjustedScore;
    if (delta !== 0) return delta;
    const providerTie = a.model.providerID.localeCompare(b.model.providerID);
    if (providerTie !== 0) return providerTie;
    return a.model.model.localeCompare(b.model.model);
  });

  let chosen = candidateScores[0];
  if (!chosen) return null;

  if (chosen.usage >= 2) {
    const bestUnused = candidateScores.find((item) => item.usage === 0);
    if (bestUnused && bestUnused.adjustedScore >= chosen.adjustedScore - 9) {
      chosen = bestUnused;
    }
  }

  if (
    agent !== 'explorer' &&
    isZai47Model(chosen.model) &&
    hasFlashToken(chosen.model)
  ) {
    const kimiCandidate = candidateScores.find((item) =>
      isKimiK25Model(item.model),
    );
    if (kimiCandidate && kimiCandidate.rawScore >= chosen.rawScore - 2) {
      chosen = kimiCandidate;
    }
  }

  return chosen.model;
}

function dedupe(models: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const model of models) {
    if (!model || seen.has(model)) continue;
    seen.add(model);
    result.push(model);
  }
  return result;
}

function ensureSyntheticModel(
  models: DiscoveredModel[],
  fullModelID: string | undefined,
): DiscoveredModel[] {
  if (!fullModelID) return models;
  if (models.some((model) => model.model === fullModelID)) return models;

  const [providerID, modelID] = fullModelID.split('/');
  if (!providerID || !modelID) return models;

  return [
    ...models,
    {
      providerID,
      model: fullModelID,
      name: modelID,
      status: 'active',
      contextLimit: 200_000,
      outputLimit: 32_000,
      reasoning: true,
      toolcall: true,
      attachment: false,
    },
  ];
}

export function buildDynamicModelPlan(
  catalog: DiscoveredModel[],
  config: InstallConfig,
  externalSignals?: ExternalSignalMap,
): DynamicModelPlan | null {
  const catalogWithSelectedModels = [
    config.selectedChutesPrimaryModel,
    config.selectedChutesSecondaryModel,
    config.selectedOpenCodePrimaryModel,
    config.selectedOpenCodeSecondaryModel,
  ].reduce((acc, modelID) => ensureSyntheticModel(acc, modelID), catalog);

  const enabledProviders = new Set(getEnabledProviders(config));
  const providerCandidates = catalogWithSelectedModels.filter((m) =>
    enabledProviders.has(m.providerID),
  );

  if (providerCandidates.length === 0) {
    return null;
  }

  const hasPaidProviderEnabled =
    config.hasOpenAI ||
    config.hasAnthropic ||
    config.hasCopilot ||
    config.hasZaiPlan ||
    config.hasKimi ||
    config.hasAntigravity;

  const enabledPaidProviderCount = [
    config.hasOpenAI,
    config.hasAnthropic,
    config.hasCopilot,
    config.hasZaiPlan,
    config.hasKimi,
    config.hasAntigravity,
  ].filter(Boolean).length;
  const maxShare =
    enabledPaidProviderCount > 0
      ? Math.ceil(AGENTS.length / enabledPaidProviderCount) + 1
      : AGENTS.length;
  const providerUsage = new Map<string, number>();

  const agents: Record<string, { model: string; variant?: string }> = {};
  const chains: Record<string, string[]> = {};

  for (const agent of PRIMARY_ASSIGNMENT_ORDER) {
    const ranked = rankModels(providerCandidates, agent, externalSignals);
    const primaryPool = hasPaidProviderEnabled
      ? ranked.filter((model) => !FREE_BIASED_PROVIDERS.has(model.providerID))
      : ranked;
    const primary =
      selectPrimaryWithDiversity(
        primaryPool.length > 0 ? primaryPool : ranked,
        agent,
        providerUsage,
        maxShare,
        externalSignals,
      ) ?? ranked[0];
    if (!primary) continue;

    providerUsage.set(
      primary.providerID,
      (providerUsage.get(primary.providerID) ?? 0) + 1,
    );

    const providerOrder = dedupe(ranked.map((m) => m.providerID));
    const perProviderBest = providerOrder
      .map((providerID) => {
        const providerModels = ranked.filter(
          (m) => m.providerID === providerID,
        );
        return chooseProviderRepresentative(
          providerModels,
          agent,
          externalSignals,
        )?.model;
      })
      .filter((m): m is string => Boolean(m));
    const nonFreePerProviderBest = perProviderBest.filter(
      (model) => !model.startsWith('opencode/'),
    );
    const freePerProviderBest = perProviderBest.filter((model) =>
      model.startsWith('opencode/'),
    );

    const selectedOpencode =
      agent === 'explorer' || agent === 'librarian' || agent === 'fixer'
        ? (config.selectedOpenCodeSecondaryModel ??
          config.selectedOpenCodePrimaryModel)
        : config.selectedOpenCodePrimaryModel;

    const selectedChutes =
      agent === 'explorer' || agent === 'librarian' || agent === 'fixer'
        ? (config.selectedChutesSecondaryModel ??
          config.selectedChutesPrimaryModel)
        : config.selectedChutesPrimaryModel;

    const chain = dedupe([
      primary.model,
      ...nonFreePerProviderBest,
      selectedChutes,
      selectedOpencode,
      ...freePerProviderBest,
      'opencode/big-pickle',
    ]).slice(0, 7);

    agents[agent] = {
      model: chain[0] ?? primary.model,
      variant: ROLE_VARIANT[agent],
    };
    chains[agent] = chain;
  }

  if (hasPaidProviderEnabled) {
    const paidProviders = dedupe(
      providerCandidates
        .map((model) => model.providerID)
        .filter((providerID) => providerID !== 'opencode'),
    );

    for (const providerID of paidProviders) {
      if ((providerUsage.get(providerID) ?? 0) > 0) continue;

      let bestSwap:
        | {
            agent: AgentName;
            candidateModel: string;
            loss: number;
          }
        | undefined;

      for (const agent of PRIMARY_ASSIGNMENT_ORDER) {
        const currentModel = agents[agent]?.model;
        if (!currentModel) continue;

        const ranked = rankModels(providerCandidates, agent, externalSignals);
        const candidate = ranked.find(
          (model) => model.providerID === providerID,
        );
        const current = ranked.find((model) => model.model === currentModel);
        if (!candidate || !current) continue;

        const currentScore = combinedScore(agent, current, externalSignals);
        const candidateScore = combinedScore(agent, candidate, externalSignals);
        const loss = currentScore - candidateScore;

        if (!bestSwap || loss < bestSwap.loss) {
          bestSwap = {
            agent,
            candidateModel: candidate.model,
            loss,
          };
        }
      }

      if (!bestSwap) continue;

      const existingProvider =
        agents[bestSwap.agent]?.model.split('/')[0] ?? providerID;
      agents[bestSwap.agent].model = bestSwap.candidateModel;
      chains[bestSwap.agent] = dedupe([
        bestSwap.candidateModel,
        ...(chains[bestSwap.agent] ?? []),
      ]).slice(0, 7);

      providerUsage.set(providerID, (providerUsage.get(providerID) ?? 0) + 1);
      providerUsage.set(
        existingProvider,
        Math.max(0, (providerUsage.get(existingProvider) ?? 1) - 1),
      );
    }
  }

  if (Object.keys(agents).length === 0) {
    return null;
  }

  return { agents, chains };
}
