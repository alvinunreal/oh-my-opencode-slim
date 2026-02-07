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
    12,
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
                ? 1
                : model.providerID === 'chutes'
                  ? -1
                  : model.providerID === 'opencode'
                    ? -2
                    : 0;

  if (agent === 'orchestrator') {
    return (
      score +
      reasoning * 40 +
      toolcall * 25 +
      deep * 10 +
      code * 8 +
      context +
      providerBias
    );
  }
  if (agent === 'oracle') {
    return (
      score +
      reasoning * 55 +
      deep * 18 +
      context * 1.2 +
      toolcall * 10 +
      providerBias
    );
  }
  if (agent === 'designer') {
    return (
      score +
      attachment * 25 +
      reasoning * 18 +
      toolcall * 15 +
      context * 0.8 +
      output +
      providerBias
    );
  }
  if (agent === 'explorer') {
    return (
      score +
      fast * 35 +
      toolcall * 28 +
      reasoning * 8 +
      context * 0.7 +
      providerBias
    );
  }
  if (agent === 'librarian') {
    return (
      score +
      context * 30 +
      toolcall * 22 +
      reasoning * 15 +
      output * 10 +
      providerBias
    );
  }

  return (
    score +
    code * 28 +
    toolcall * 24 +
    fast * 18 +
    reasoning * 14 +
    output * 8 +
    providerBias
  );
}

function getExternalSignalBoost(
  model: DiscoveredModel,
  externalSignals: ExternalSignalMap | undefined,
): number {
  if (!externalSignals) return 0;

  const fullKey = model.model.toLowerCase();
  const idKey = model.model.split('/')[1]?.toLowerCase();
  const signal =
    externalSignals[fullKey] ?? (idKey ? externalSignals[idKey] : undefined);
  if (!signal) return 0;

  const qualityBoost = (signal.qualityScore ?? 0) * 0.12;
  const codingBoost = (signal.codingScore ?? 0) * 0.18;
  const latencyPenalty = Math.min(signal.latencySeconds ?? 0, 25) * 0.7;

  const blendedPrice =
    signal.inputPricePer1M !== undefined &&
    signal.outputPricePer1M !== undefined
      ? signal.inputPricePer1M * 0.75 + signal.outputPricePer1M * 0.25
      : (signal.inputPricePer1M ?? signal.outputPricePer1M ?? 0);
  const pricePenalty = Math.min(blendedPrice, 30) * 0.08;

  return qualityBoost + codingBoost - latencyPenalty - pricePenalty;
}

function rankModels(
  models: DiscoveredModel[],
  agent: AgentName,
  externalSignals?: ExternalSignalMap,
): DiscoveredModel[] {
  return [...models].sort((a, b) => {
    const scoreA =
      roleScore(agent, a) + getExternalSignalBoost(a, externalSignals);
    const scoreB =
      roleScore(agent, b) + getExternalSignalBoost(b, externalSignals);
    const scoreDelta = scoreB - scoreA;
    if (scoreDelta !== 0) return scoreDelta;

    const providerTieBreak = a.providerID.localeCompare(b.providerID);
    if (providerTieBreak !== 0) return providerTieBreak;

    return a.model.localeCompare(b.model);
  });
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

export function buildDynamicModelPlan(
  catalog: DiscoveredModel[],
  config: InstallConfig,
  externalSignals?: ExternalSignalMap,
): DynamicModelPlan | null {
  const enabledProviders = new Set(getEnabledProviders(config));
  const providerCandidates = catalog.filter((m) =>
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

  const agents: Record<string, { model: string; variant?: string }> = {};
  const chains: Record<string, string[]> = {};

  for (const agent of AGENTS) {
    const ranked = rankModels(providerCandidates, agent, externalSignals);
    const primaryPool = hasPaidProviderEnabled
      ? ranked.filter((model) => !FREE_BIASED_PROVIDERS.has(model.providerID))
      : ranked;
    const primary = primaryPool[0] ?? ranked[0];
    if (!primary) continue;

    const providerOrder = dedupe(ranked.map((m) => m.providerID));
    const perProviderBest = providerOrder
      .map(
        (providerID) => ranked.find((m) => m.providerID === providerID)?.model,
      )
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

  if (Object.keys(agents).length === 0) {
    return null;
  }

  return { agents, chains };
}
