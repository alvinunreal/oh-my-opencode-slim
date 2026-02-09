import { buildModelKeyAliases } from './model-key-normalization';
import { resolveAgentWithPrecedence } from './precedence-resolver';
import { rankModelsV2, scoreCandidateV2 } from './scoring-v2';
import type {
  DiscoveredModel,
  DynamicModelPlan,
  ExternalSignalMap,
  InstallConfig,
  ScoringEngineVersion,
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

export type V1RankedScore = {
  model: string;
  totalScore: number;
  baseScore: number;
  externalSignalBoost: number;
};

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

type VersionFamilyInfo = {
  family: string;
  version: [number, number, number];
  confidence: number;
  prereleasePenalty: number;
};

function toVersionTuple(
  major: string,
  minor?: string,
  patch?: string,
): [number, number, number] {
  return [
    Number.parseInt(major, 10) || 0,
    Number.parseInt(minor ?? '0', 10) || 0,
    Number.parseInt(patch ?? '0', 10) || 0,
  ];
}

function compareVersionTuple(
  a: [number, number, number],
  b: [number, number, number],
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function extractVersionFamily(
  model: DiscoveredModel,
): VersionFamilyInfo | null {
  const text = `${model.model} ${model.name}`.toLowerCase();

  const gpt = text.match(/\bgpt[-_ ]?(\d+)(?:[.-](\d+))?(?:[.-](\d+))?\b/);
  if (gpt) {
    return {
      family: 'gpt',
      version: toVersionTuple(gpt[1] ?? '0', gpt[2], gpt[3]),
      confidence: 1,
      prereleasePenalty: /preview|experimental|exp|\brc\b/.test(text) ? -2 : 0,
    };
  }

  const gemini = text.match(
    /\bgemini[-_ ]?(\d+)(?:[.-](\d+))?(?:[.-](\d+))?\b/,
  );
  if (gemini) {
    return {
      family: 'gemini',
      version: toVersionTuple(gemini[1] ?? '0', gemini[2], gemini[3]),
      confidence: 1,
      prereleasePenalty: /preview|experimental|exp|\brc\b/.test(text) ? -2 : 0,
    };
  }

  const kimi = text.match(/\bkimi[-_ ]?k(\d+)(?:[.-]?(\d+))?(?:[.-](\d+))?\b/);
  if (kimi) {
    return {
      family: 'kimi-k',
      version: toVersionTuple(kimi[1] ?? '0', kimi[2], kimi[3]),
      confidence: 1,
      prereleasePenalty: /preview|experimental|exp|\brc\b/.test(text) ? -2 : 0,
    };
  }

  const generic = text.match(
    /\b([a-z][a-z0-9-]{1,20})[-_ ](\d+)(?:[.-](\d+))?(?:[.-](\d+))?\b/,
  );
  if (generic) {
    return {
      family: generic[1] ?? 'generic',
      version: toVersionTuple(generic[2] ?? '0', generic[3], generic[4]),
      confidence: 0.7,
      prereleasePenalty: /preview|experimental|exp|\brc\b/.test(text) ? -2 : 0,
    };
  }

  return null;
}

function getVersionRecencyMap(
  models: DiscoveredModel[],
): Record<string, number> {
  const familyVersions = new Map<string, Array<[number, number, number]>>();
  const modelInfo = new Map<string, VersionFamilyInfo>();

  for (const model of models) {
    const info = extractVersionFamily(model);
    if (!info) continue;

    modelInfo.set(model.model, info);
    const current = familyVersions.get(info.family) ?? [];
    current.push(info.version);
    familyVersions.set(info.family, current);
  }

  const recencyMap: Record<string, number> = {};

  for (const model of models) {
    const info = modelInfo.get(model.model);
    if (!info) {
      recencyMap[model.model] = 0;
      continue;
    }

    const versions = familyVersions.get(info.family) ?? [];
    const unique = versions
      .map((tuple) => `${tuple[0]}.${tuple[1]}.${tuple[2]}`)
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .map((value) => {
        const [major, minor, patch] = value
          .split('.')
          .map((v) => Number.parseInt(v, 10) || 0);
        return [major, minor, patch] as [number, number, number];
      })
      .sort(compareVersionTuple);

    if (unique.length === 0) {
      recencyMap[model.model] = 0;
      continue;
    }

    const index = unique.findIndex(
      (tuple) => compareVersionTuple(tuple, info.version) === 0,
    );
    const percentile = unique.length === 1 ? 0.5 : index / (unique.length - 1);
    const raw = -3 + percentile * (12 - -3);
    const final = Math.max(
      -3,
      Math.min(12, raw * info.confidence + info.prereleasePenalty),
    );
    recencyMap[model.model] = final;
  }

  return recencyMap;
}

function baseScore(model: DiscoveredModel, versionRecencyBoost = 0): number {
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
  return (
    statusScore(model.status) +
    context +
    output +
    deep +
    fast +
    code +
    versionRecencyBoost +
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
  _agent: AgentName,
  model: DiscoveredModel,
): number {
  const lowered = `${model.model} ${model.name}`.toLowerCase();
  const isGemini25Pro = /gemini-2\.5-pro/.test(lowered);

  return isGemini25Pro ? -14 : 0;
}

function chutesPreferenceAdjustment(
  agent: AgentName,
  model: DiscoveredModel,
): number {
  if (model.providerID !== 'chutes') return 0;

  const lowered = `${model.model} ${model.name}`.toLowerCase();
  const isQwen3 = /qwen3/.test(lowered);
  const isKimiK25 = /kimi-k2\.5|k2\.5/.test(lowered);
  const isMinimaxM21 = /minimax[-_ ]?m2\.1/.test(lowered);

  const qwenPenalty: Record<AgentName, number> = {
    oracle: -12,
    orchestrator: -10,
    fixer: -22,
    designer: -14,
    librarian: -18,
    explorer: -10,
  };
  const kimiBonus: Record<AgentName, number> = {
    oracle: 0,
    orchestrator: 0,
    fixer: 8,
    designer: 6,
    librarian: 5,
    explorer: 4,
  };
  const minimaxBonus: Record<AgentName, number> = {
    oracle: 0,
    orchestrator: 0,
    fixer: 10,
    designer: 3,
    librarian: 9,
    explorer: 12,
  };

  return (
    (isQwen3 ? qwenPenalty[agent] : 0) +
    (isKimiK25 ? kimiBonus[agent] : 0) +
    (isMinimaxM21 ? minimaxBonus[agent] : 0)
  );
}

function modelLookupKeys(model: DiscoveredModel): string[] {
  return buildModelKeyAliases(model.model);
}

function roleScore(
  agent: AgentName,
  model: DiscoveredModel,
  versionRecencyBoost = 0,
): number {
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

  const score = baseScore(model, versionRecencyBoost);
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
  const chutesAdjustment = chutesPreferenceAdjustment(agent, model);

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
      chutesAdjustment +
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
      chutesAdjustment +
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
      chutesAdjustment +
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
      chutesAdjustment +
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
      chutesAdjustment +
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
    chutesAdjustment +
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
  const versionRecencyMap = getVersionRecencyMap(models);

  return [...models].sort((a, b) => {
    const scoreA =
      roleScore(agent, a, versionRecencyMap[a.model] ?? 0) +
      getExternalSignalBoost(agent, a, externalSignals);
    const scoreB =
      roleScore(agent, b, versionRecencyMap[b.model] ?? 0) +
      getExternalSignalBoost(agent, b, externalSignals);
    const scoreDelta = scoreB - scoreA;
    if (scoreDelta !== 0) return scoreDelta;

    const providerTieBreak = a.providerID.localeCompare(b.providerID);
    if (providerTieBreak !== 0) return providerTieBreak;

    return a.model.localeCompare(b.model);
  });
}

export function rankModelsV1WithBreakdown(
  models: DiscoveredModel[],
  agent: AgentName,
  externalSignals?: ExternalSignalMap,
): V1RankedScore[] {
  const versionRecencyMap = getVersionRecencyMap(models);
  return [...models]
    .map((model) => {
      const base = roleScore(agent, model, versionRecencyMap[model.model] ?? 0);
      const boost = getExternalSignalBoost(agent, model, externalSignals);
      return {
        model: model.model,
        baseScore: Math.round(base * 1000) / 1000,
        externalSignalBoost: Math.round(boost * 1000) / 1000,
        totalScore: Math.round((base + boost) * 1000) / 1000,
      };
    })
    .sort((a, b) => {
      if (a.totalScore !== b.totalScore) return b.totalScore - a.totalScore;
      return a.model.localeCompare(b.model);
    });
}

function combinedScore(
  agent: AgentName,
  model: DiscoveredModel,
  externalSignals?: ExternalSignalMap,
  versionRecencyMap?: Record<string, number>,
): number {
  return (
    roleScore(agent, model, versionRecencyMap?.[model.model] ?? 0) +
    getExternalSignalBoost(agent, model, externalSignals)
  );
}

function effectiveEngine(engineVersion: ScoringEngineVersion): 'v1' | 'v2' {
  return engineVersion === 'v2' ? 'v2' : 'v1';
}

function scoreForEngine(
  engineVersion: ScoringEngineVersion,
  agent: AgentName,
  model: DiscoveredModel,
  externalSignals: ExternalSignalMap | undefined,
  versionRecencyMap: Record<string, number>,
): number {
  if (effectiveEngine(engineVersion) === 'v2') {
    return scoreCandidateV2(model, agent, externalSignals).totalScore;
  }

  return combinedScore(agent, model, externalSignals, versionRecencyMap);
}

function selectTopModelsPerProvider(
  models: DiscoveredModel[],
  engineVersion: ScoringEngineVersion,
  externalSignals: ExternalSignalMap | undefined,
  versionRecencyMap: Record<string, number>,
): DiscoveredModel[] {
  const byProvider = new Map<string, DiscoveredModel[]>();

  for (const model of models) {
    const current = byProvider.get(model.providerID) ?? [];
    current.push(model);
    byProvider.set(model.providerID, current);
  }

  const selected: DiscoveredModel[] = [];

  for (const providerModels of byProvider.values()) {
    if (providerModels.length <= 2) {
      selected.push(...providerModels);
      continue;
    }

    const ranked = [...providerModels]
      .map((model) => {
        const total = AGENTS.reduce((sum, agent) => {
          return (
            sum +
            scoreForEngine(
              engineVersion,
              agent,
              model,
              externalSignals,
              versionRecencyMap,
            )
          );
        }, 0);

        return {
          model,
          score: total / AGENTS.length,
        };
      })
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.model.model.localeCompare(b.model.model);
      })
      .slice(0, 2)
      .map((entry) => entry.model);

    selected.push(...ranked);
  }

  return selected;
}

function countProviderUsage(
  agents: Record<string, { model: string; variant?: string }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const assignment of Object.values(agents)) {
    const provider = assignment.model.split('/')[0];
    if (!provider) continue;
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  return counts;
}

function rebalanceForSubscriptionMode(
  agents: Record<string, { model: string; variant?: string }>,
  chains: Record<string, string[]>,
  provenance: Record<string, { winnerLayer: string; winnerModel: string }>,
  paidProviders: string[],
  getRankedModels: (agent: AgentName) => DiscoveredModel[],
  getPinnedModelForProvider: (
    agent: AgentName,
    providerID: string,
  ) => string | undefined,
  targetByProvider: Record<string, number>,
  externalSignals: ExternalSignalMap | undefined,
  versionRecencyMap: Record<string, number>,
  engineVersion: ScoringEngineVersion,
): void {
  if (paidProviders.length <= 1) return;

  const MAX_ALLOWED_SCORE_LOSS = 20;

  while (true) {
    const providerUsage = countProviderUsage(agents);
    const underProviders = paidProviders.filter(
      (providerID) =>
        (providerUsage.get(providerID) ?? 0) <
        (targetByProvider[providerID] ?? 0),
    );
    const overProviders = paidProviders.filter(
      (providerID) =>
        (providerUsage.get(providerID) ?? 0) >
        (targetByProvider[providerID] ?? 0),
    );

    if (underProviders.length === 0 || overProviders.length === 0) break;

    let bestSwap:
      | {
          agent: AgentName;
          candidate: DiscoveredModel;
          loss: number;
        }
      | undefined;

    for (const agent of PRIMARY_ASSIGNMENT_ORDER) {
      const currentModelID = agents[agent]?.model;
      if (!currentModelID) continue;

      const currentProvider = currentModelID.split('/')[0];
      if (!currentProvider || !overProviders.includes(currentProvider))
        continue;

      const ranked = getRankedModels(agent);
      const currentModel =
        ranked.find((model) => model.model === currentModelID) ??
        ranked.find((model) => model.providerID === currentProvider);
      if (!currentModel) continue;

      const currentScore = scoreForEngine(
        engineVersion,
        agent,
        currentModel,
        externalSignals,
        versionRecencyMap,
      );

      for (const underProvider of underProviders) {
        const pinned = getPinnedModelForProvider(agent, underProvider);
        const candidate =
          ranked.find((model) => model.model === pinned) ??
          ranked.find((model) => model.providerID === underProvider);
        if (!candidate) continue;

        const candidateScore = scoreForEngine(
          engineVersion,
          agent,
          candidate,
          externalSignals,
          versionRecencyMap,
        );
        const loss = currentScore - candidateScore;

        if (loss > MAX_ALLOWED_SCORE_LOSS) continue;
        if (!bestSwap || loss < bestSwap.loss) {
          bestSwap = { agent, candidate, loss };
        }
      }
    }

    if (!bestSwap) break;

    agents[bestSwap.agent].model = bestSwap.candidate.model;
    chains[bestSwap.agent] = dedupe([
      bestSwap.candidate.model,
      ...(chains[bestSwap.agent] ?? []),
    ]).slice(0, 10);
    provenance[bestSwap.agent] = {
      winnerLayer: 'provider-fallback-policy',
      winnerModel: bestSwap.candidate.model,
    };
  }
}

function chooseProviderRepresentative(
  providerModels: DiscoveredModel[],
  agent: AgentName,
  externalSignals?: ExternalSignalMap,
  versionRecencyMap?: Record<string, number>,
): DiscoveredModel | null {
  if (providerModels.length === 0) return null;

  const flashBest = providerModels.find((model) => hasFlashToken(model));
  const nonFlashBest = providerModels.find((model) => !hasFlashToken(model));

  if (!nonFlashBest) return providerModels[0] ?? null;
  if (!flashBest) return nonFlashBest;

  const flashScore = combinedScore(
    agent,
    flashBest,
    externalSignals,
    versionRecencyMap,
  );
  const nonFlashScore = combinedScore(
    agent,
    nonFlashBest,
    externalSignals,
    versionRecencyMap,
  );
  const threshold = agent === 'explorer' ? -6 : 12;
  return flashScore >= nonFlashScore + threshold ? flashBest : nonFlashBest;
}

function getQualityWindow(agent: AgentName): number {
  if (agent === 'oracle' || agent === 'orchestrator') return 12;
  if (agent === 'fixer') return 15;
  if (agent === 'designer') return 16;
  if (agent === 'librarian') return 18;
  return 22;
}

function getProviderBundle(
  providerModels: DiscoveredModel[],
  agent: AgentName,
  externalSignals?: ExternalSignalMap,
  versionRecencyMap?: Record<string, number>,
): string[] {
  if (providerModels.length === 0) return [];

  const representative = chooseProviderRepresentative(
    providerModels,
    agent,
    externalSignals,
    versionRecencyMap,
  );
  if (!representative) return [];

  const second = providerModels.find((m) => m.model !== representative.model);
  if (!second) return [representative.model];

  const score1 = combinedScore(
    agent,
    representative,
    externalSignals,
    versionRecencyMap,
  );
  const score2 = combinedScore(
    agent,
    second,
    externalSignals,
    versionRecencyMap,
  );
  const gap = Math.abs(score1 - score2);
  const includeSecond =
    representative.providerID === 'chutes' ||
    gap <=
      (agent === 'oracle' || agent === 'orchestrator'
        ? 8
        : agent === 'designer' || agent === 'librarian'
          ? 12
          : agent === 'fixer'
            ? 15
            : 18);

  return includeSecond
    ? [representative.model, second.model]
    : [representative.model];
}

function selectPrimaryWithDiversity(
  candidates: DiscoveredModel[],
  agent: AgentName,
  providerUsage: Map<string, number>,
  targetByProvider: Record<string, number>,
  remainingSlots: number,
  externalSignals?: ExternalSignalMap,
  versionRecencyMap?: Record<string, number>,
): DiscoveredModel | null {
  if (candidates.length === 0) return null;

  const candidateScores = candidates.map((model) => {
    const usage = providerUsage.get(model.providerID) ?? 0;
    const target = targetByProvider[model.providerID] ?? 1;
    const softCap = target;
    const hardCap = Math.min(target + 1, 4);
    const deficit = Math.max(0, target - usage);
    const softOverflow = Math.max(0, usage + 1 - softCap);
    const hardOverflow = Math.max(0, usage + 1 - hardCap);
    const rawScore = combinedScore(
      agent,
      model,
      externalSignals,
      versionRecencyMap,
    );
    const adjustedScore =
      rawScore + deficit * 14 - softOverflow * 18 - hardOverflow * 100;

    return {
      model,
      usage,
      target,
      rawScore,
      adjustedScore: Math.round(adjustedScore * 1000) / 1000,
    };
  });

  const bestRaw = Math.max(...candidateScores.map((item) => item.rawScore));
  const window = getQualityWindow(agent);
  let eligible = candidateScores.filter(
    (item) => item.rawScore >= bestRaw - window,
  );

  const mustFillProviders = Object.entries(targetByProvider)
    .filter(([providerID, target]) => {
      const usage = providerUsage.get(providerID) ?? 0;
      return Math.max(0, target - usage) >= remainingSlots;
    })
    .map(([providerID]) => providerID);

  if (mustFillProviders.length > 0) {
    const forced = eligible.filter((item) =>
      mustFillProviders.includes(item.model.providerID),
    );
    if (forced.length > 0) eligible = forced;
  }

  eligible.sort((a, b) => {
    const delta = b.adjustedScore - a.adjustedScore;
    if (delta !== 0) return delta;

    const ratioA = a.target > 0 ? a.usage / a.target : a.usage;
    const ratioB = b.target > 0 ? b.usage / b.target : b.usage;
    if (ratioA !== ratioB) return ratioA - ratioB;

    if (a.rawScore !== b.rawScore) return b.rawScore - a.rawScore;

    const providerTie = a.model.providerID.localeCompare(b.model.providerID);
    if (providerTie !== 0) return providerTie;
    return a.model.model.localeCompare(b.model.model);
  });

  let chosen = eligible[0] ?? candidateScores[0];
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

function finalizeChainWithTail(
  prefix: string[],
  preferredTail: string | undefined,
): string[] {
  if (!preferredTail) {
    return dedupe([...prefix, 'opencode/big-pickle']).slice(0, 10);
  }

  const withoutTail = prefix
    .filter((model) => model !== preferredTail)
    .slice(0, 9);
  return [...withoutTail, preferredTail];
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
  options?: {
    scoringEngineVersion?: ScoringEngineVersion;
  },
): DynamicModelPlan | null {
  const catalogWithSelectedModels = [
    config.selectedChutesPrimaryModel,
    config.selectedChutesSecondaryModel,
    config.selectedOpenCodePrimaryModel,
    config.selectedOpenCodeSecondaryModel,
  ].reduce((acc, modelID) => ensureSyntheticModel(acc, modelID), catalog);

  const enabledProviders = new Set(getEnabledProviders(config));
  const providerUniverse = catalogWithSelectedModels.filter((m) => {
    if (!enabledProviders.has(m.providerID)) return false;

    if (m.providerID === 'chutes' && /qwen/i.test(m.model)) {
      return false;
    }

    return true;
  });
  const engineVersion =
    options?.scoringEngineVersion ?? config.scoringEngineVersion ?? 'v1';
  const versionRecencyMap = getVersionRecencyMap(providerUniverse);

  const providerCandidates = selectTopModelsPerProvider(
    providerUniverse,
    engineVersion,
    externalSignals,
    versionRecencyMap,
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

  const paidProviders = dedupe(
    providerCandidates
      .map((model) => model.providerID)
      .filter((providerID) => providerID !== 'opencode'),
  ).sort((a, b) => a.localeCompare(b));

  const targetByProvider: Record<string, number> = {};
  if (paidProviders.length > 0) {
    const baseTarget = Math.floor(AGENTS.length / paidProviders.length);
    const extra = AGENTS.length % paidProviders.length;
    for (const [index, providerID] of paidProviders.entries()) {
      targetByProvider[providerID] = baseTarget + (index < extra ? 1 : 0);
    }
  }
  const providerUsage = new Map<string, number>();
  const rankCache = new Map<AgentName, DiscoveredModel[]>();
  const shadowDiffs: Record<
    string,
    { v1TopModel?: string; v2TopModel?: string }
  > = {};

  const agents: Record<string, { model: string; variant?: string }> = {};
  const chains: Record<string, string[]> = {};
  const provenance: DynamicModelPlan['provenance'] = {};

  const getSelectedChutesForAgent = (agent: AgentName): string | undefined => {
    if (!config.hasChutes) return undefined;
    return agent === 'explorer' || agent === 'librarian' || agent === 'fixer'
      ? (config.selectedChutesSecondaryModel ??
          config.selectedChutesPrimaryModel)
      : config.selectedChutesPrimaryModel;
  };

  const getSelectedOpenCodeForAgent = (
    agent: AgentName,
  ): string | undefined => {
    if (!config.useOpenCodeFreeModels) return undefined;
    return agent === 'explorer' || agent === 'librarian' || agent === 'fixer'
      ? (config.selectedOpenCodeSecondaryModel ??
          config.selectedOpenCodePrimaryModel)
      : config.selectedOpenCodePrimaryModel;
  };

  const getPinnedModelForProvider = (
    agent: AgentName,
    providerID: string,
  ): string | undefined => {
    if (providerID === 'chutes') return getSelectedChutesForAgent(agent);
    if (providerID === 'opencode') return getSelectedOpenCodeForAgent(agent);
    return undefined;
  };

  const getRankedModels = (agent: AgentName): DiscoveredModel[] => {
    const cached = rankCache.get(agent);
    if (cached) return cached;

    const rankedV1 = rankModels(providerCandidates, agent, externalSignals);

    if (engineVersion === 'v1') {
      rankCache.set(agent, rankedV1);
      return rankedV1;
    }

    const rankedV2 = rankModelsV2(
      providerCandidates,
      agent,
      externalSignals,
    ).map((candidate) => candidate.model);

    if (engineVersion === 'v2-shadow') {
      shadowDiffs[agent] = {
        v1TopModel: rankedV1[0]?.model,
        v2TopModel: rankedV2[0]?.model,
      };
      rankCache.set(agent, rankedV1);
      return rankedV1;
    }

    rankCache.set(agent, rankedV2);
    return rankedV2;
  };

  for (const [agentIndex, agent] of PRIMARY_ASSIGNMENT_ORDER.entries()) {
    const ranked = getRankedModels(agent);
    const primaryPool = hasPaidProviderEnabled
      ? ranked.filter((model) => !FREE_BIASED_PROVIDERS.has(model.providerID))
      : ranked;
    const remainingSlots = PRIMARY_ASSIGNMENT_ORDER.length - agentIndex;
    const primary =
      selectPrimaryWithDiversity(
        primaryPool.length > 0 ? primaryPool : ranked,
        agent,
        providerUsage,
        targetByProvider,
        remainingSlots,
        externalSignals,
        versionRecencyMap,
      ) ?? ranked[0];
    if (!primary) continue;

    providerUsage.set(
      primary.providerID,
      (providerUsage.get(primary.providerID) ?? 0) + 1,
    );

    const providerOrder = dedupe(ranked.map((m) => m.providerID));
    const perProviderBest = providerOrder.flatMap((providerID) => {
      const providerModels = ranked.filter((m) => m.providerID === providerID);
      const pinned = getPinnedModelForProvider(agent, providerID);
      if (pinned && providerModels.some((m) => m.model === pinned)) {
        return [pinned];
      }
      return getProviderBundle(
        providerModels,
        agent,
        externalSignals,
        versionRecencyMap,
      );
    });
    const nonFreePerProviderBest = perProviderBest.filter(
      (model) => !model.startsWith('opencode/'),
    );
    const freePerProviderBest = perProviderBest.filter((model) =>
      model.startsWith('opencode/'),
    );

    const selectedOpencode = getSelectedOpenCodeForAgent(agent);
    const selectedChutes = getSelectedChutesForAgent(agent);

    const chain = dedupe([
      primary.model,
      ...nonFreePerProviderBest,
      selectedChutes,
      selectedOpencode,
      ...freePerProviderBest,
    ]);

    const deterministicFreeTail =
      selectedOpencode ??
      freePerProviderBest[0] ??
      ranked.find((model) => model.model.startsWith('opencode/'))?.model;

    const finalizedChain = finalizeChainWithTail(chain, deterministicFreeTail);

    const providerPolicyChain = dedupe([selectedChutes, selectedOpencode]);
    const systemDefaultModel = selectedOpencode ?? 'opencode/big-pickle';
    const resolved = resolveAgentWithPrecedence({
      agentName: agent,
      dynamicRecommendation: finalizedChain,
      providerFallbackPolicy: providerPolicyChain,
      systemDefault: [systemDefaultModel],
    });

    let finalModel = resolved.model;
    let finalChain = resolved.chain;

    const selectedChutesForAgent = getSelectedChutesForAgent(agent);
    const selectedOpenCodeForAgent = getSelectedOpenCodeForAgent(agent);

    const forceChutes =
      finalModel.startsWith('chutes/') && Boolean(selectedChutesForAgent);
    const forceOpenCode =
      finalModel.startsWith('opencode/') && Boolean(selectedOpenCodeForAgent);

    if (forceOpenCode && selectedOpenCodeForAgent) {
      finalModel = selectedOpenCodeForAgent;
      finalChain = dedupe([selectedOpenCodeForAgent, ...finalChain]);
    }

    if (forceChutes && selectedChutesForAgent) {
      finalModel = selectedChutesForAgent;
      finalChain = dedupe([selectedChutesForAgent, ...finalChain]);
    }

    const wasForced = forceChutes || forceOpenCode;

    agents[agent] = {
      model: finalModel,
      variant: ROLE_VARIANT[agent],
    };
    chains[agent] = finalChain;
    provenance[agent] = {
      winnerLayer: wasForced
        ? 'manual-user-plan'
        : resolved.provenance.winnerLayer,
      winnerModel: finalModel,
    };
  }

  if (hasPaidProviderEnabled) {
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

        const ranked = getRankedModels(agent);
        const pinned = getPinnedModelForProvider(agent, providerID);
        const candidate =
          ranked.find((model) => model.model === pinned) ??
          ranked.find((model) => model.providerID === providerID);
        const current = ranked.find((model) => model.model === currentModel);
        if (!candidate || !current) continue;

        const currentScore = combinedScore(
          agent,
          current,
          externalSignals,
          versionRecencyMap,
        );
        const candidateScore = combinedScore(
          agent,
          candidate,
          externalSignals,
          versionRecencyMap,
        );
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
      ]).slice(0, 10);
      provenance[bestSwap.agent] = {
        winnerLayer: 'provider-fallback-policy',
        winnerModel: bestSwap.candidateModel,
      };

      providerUsage.set(providerID, (providerUsage.get(providerID) ?? 0) + 1);
      providerUsage.set(
        existingProvider,
        Math.max(0, (providerUsage.get(existingProvider) ?? 1) - 1),
      );
    }
  }

  if (config.balanceProviderUsage && hasPaidProviderEnabled) {
    rebalanceForSubscriptionMode(
      agents,
      chains,
      provenance,
      paidProviders,
      getRankedModels,
      getPinnedModelForProvider,
      targetByProvider,
      externalSignals,
      versionRecencyMap,
      engineVersion,
    );
  }

  if (Object.keys(agents).length === 0) {
    return null;
  }

  return {
    agents,
    chains,
    provenance,
    scoring: {
      engineVersionApplied: engineVersion === 'v2' ? 'v2' : 'v1',
      shadowCompared: engineVersion === 'v2-shadow',
      diffs: engineVersion === 'v2-shadow' ? shadowDiffs : undefined,
    },
  };
}
