import type { DiscoveredModel, DynamicModelPlan, InstallConfig } from './types';

const AGENTS = [
  'orchestrator',
  'oracle',
  'designer',
  'explorer',
  'librarian',
  'fixer',
] as const;

type AgentName = (typeof AGENTS)[number];

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

  if (agent === 'orchestrator') {
    return (
      score + reasoning * 40 + toolcall * 25 + deep * 10 + code * 8 + context
    );
  }
  if (agent === 'oracle') {
    return score + reasoning * 55 + deep * 18 + context * 1.2 + toolcall * 10;
  }
  if (agent === 'designer') {
    return (
      score +
      attachment * 25 +
      reasoning * 18 +
      toolcall * 15 +
      context * 0.8 +
      output
    );
  }
  if (agent === 'explorer') {
    return score + fast * 35 + toolcall * 28 + reasoning * 8 + context * 0.7;
  }
  if (agent === 'librarian') {
    return score + context * 30 + toolcall * 22 + reasoning * 15 + output * 10;
  }

  return (
    score + code * 28 + toolcall * 24 + fast * 18 + reasoning * 14 + output * 8
  );
}

function rankModels(
  models: DiscoveredModel[],
  agent: AgentName,
): DiscoveredModel[] {
  return [...models].sort((a, b) => roleScore(agent, b) - roleScore(agent, a));
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
): DynamicModelPlan | null {
  const enabledProviders = new Set(getEnabledProviders(config));
  const providerCandidates = catalog.filter((m) =>
    enabledProviders.has(m.providerID),
  );

  if (providerCandidates.length === 0) {
    return null;
  }

  const agents: Record<string, { model: string; variant?: string }> = {};
  const chains: Record<string, string[]> = {};

  for (const agent of AGENTS) {
    const ranked = rankModels(providerCandidates, agent);
    const primary = ranked[0];
    if (!primary) continue;

    const providerOrder = dedupe(ranked.map((m) => m.providerID));
    const perProviderBest = providerOrder
      .map(
        (providerID) => ranked.find((m) => m.providerID === providerID)?.model,
      )
      .filter((m): m is string => Boolean(m));

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
      ...perProviderBest,
      selectedChutes,
      selectedOpencode,
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
