export type ResolutionLayerName =
  | 'opencode-direct-override'
  | 'manual-user-plan'
  | 'pinned-model'
  | 'tier-selection'
  | 'provider-fallback-policy'
  | 'system-default';

export interface AgentResolutionProvenance {
  winnerLayer: ResolutionLayerName;
  winnerModel: string;
}

export interface AgentLayerInput {
  agentName: string;
  openCodeDirectOverride?: string;
  manualUserPlan?: string[];
  pinnedModel?: string;
  dynamicRecommendation?: string[];
  providerFallbackPolicy?: string[];
  systemDefault: string[];
}

export interface ResolvedAgentLayerResult {
  model: string;
  chain: string[];
  provenance: AgentResolutionProvenance;
}

type LayerCandidate = {
  layer: ResolutionLayerName;
  models: string[];
};

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

function buildLayerOrder(input: AgentLayerInput): LayerCandidate[] {
  return [
    {
      layer: 'opencode-direct-override',
      models: input.openCodeDirectOverride
        ? [input.openCodeDirectOverride]
        : [],
    },
    {
      layer: 'manual-user-plan',
      models: input.manualUserPlan ?? [],
    },
    {
      layer: 'pinned-model',
      models: input.pinnedModel ? [input.pinnedModel] : [],
    },
    {
      layer: 'tier-selection',
      models: input.dynamicRecommendation ?? [],
    },
    {
      layer: 'provider-fallback-policy',
      models: input.providerFallbackPolicy ?? [],
    },
    {
      layer: 'system-default',
      models: input.systemDefault,
    },
  ];
}

export function resolveAgentWithPrecedence(
  input: AgentLayerInput,
): ResolvedAgentLayerResult {
  const ordered = buildLayerOrder(input);
  const firstWinningIndex = ordered.findIndex(
    (layer) => layer.models.length > 0,
  );
  const winnerIndex =
    firstWinningIndex >= 0 ? firstWinningIndex : ordered.length - 1;
  const winnerLayer = ordered[winnerIndex];

  const chain = dedupe(
    ordered
      .slice(winnerIndex)
      .flatMap((layer) => layer.models)
      .concat(input.systemDefault),
  );
  const model = chain[0] ?? input.systemDefault[0] ?? 'opencode/big-pickle';

  return {
    model,
    chain,
    provenance: {
      winnerLayer: winnerLayer?.layer ?? 'system-default',
      winnerModel: model,
    },
  };
}
