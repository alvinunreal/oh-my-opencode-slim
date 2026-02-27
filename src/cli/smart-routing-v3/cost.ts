import type { AgentName, BillingMode, DiscoveredModel } from '../types';

export interface CostBudget {
  dailyUsdLimit?: number;
  monthlyUsdLimit?: number;
  enforcement: 'hard' | 'soft' | 'warn';
}

export interface CostUsageSnapshot {
  dailyUsd: number;
  monthlyUsd: number;
  byAgent: Partial<Record<AgentName, number>>;
  byModel: Record<string, number>;
  byBillingMode: Partial<Record<BillingMode, number>>;
}

export interface CostOptimizationSuggestion {
  agent: AgentName;
  fromModel: string;
  toModel: string;
  estimatedDailySavingsUsd: number;
  reason: string;
}

function blendedModelCost(model: DiscoveredModel): number {
  return (model.costInput ?? 0) * 0.7 + (model.costOutput ?? 0) * 0.3;
}

export class CostTracker {
  private usage: CostUsageSnapshot = {
    dailyUsd: 0,
    monthlyUsd: 0,
    byAgent: {},
    byModel: {},
    byBillingMode: {},
  };

  constructor(private readonly budget: CostBudget) {}

  recordUsage(input: {
    agent: AgentName;
    model: string;
    billingMode: BillingMode;
    inputTokens: number;
    outputTokens: number;
    discoveredModel?: DiscoveredModel;
  }): void {
    const modelCost =
      input.billingMode === 'subscription'
        ? 0
        : input.discoveredModel
          ? blendedModelCost(input.discoveredModel)
          : 0;

    const usd =
      input.billingMode === 'subscription'
        ? 0
        : ((input.inputTokens + input.outputTokens) / 1_000_000) * modelCost;

    this.usage.dailyUsd += usd;
    this.usage.monthlyUsd += usd;
    this.usage.byAgent[input.agent] =
      (this.usage.byAgent[input.agent] ?? 0) + usd;
    this.usage.byModel[input.model] =
      (this.usage.byModel[input.model] ?? 0) + usd;
    this.usage.byBillingMode[input.billingMode] =
      (this.usage.byBillingMode[input.billingMode] ?? 0) + usd;
  }

  getUsage(): CostUsageSnapshot {
    return JSON.parse(JSON.stringify(this.usage)) as CostUsageSnapshot;
  }

  checkBudget(): { ok: boolean; messages: string[] } {
    const messages: string[] = [];
    let ok = true;
    if (
      typeof this.budget.dailyUsdLimit === 'number' &&
      this.usage.dailyUsd > this.budget.dailyUsdLimit
    ) {
      messages.push(
        `Daily budget exceeded: ${this.usage.dailyUsd.toFixed(3)} > ${this.budget.dailyUsdLimit.toFixed(3)}`,
      );
      ok = this.budget.enforcement !== 'hard' ? ok : false;
    }
    if (
      typeof this.budget.monthlyUsdLimit === 'number' &&
      this.usage.monthlyUsd > this.budget.monthlyUsdLimit
    ) {
      messages.push(
        `Monthly budget exceeded: ${this.usage.monthlyUsd.toFixed(3)} > ${this.budget.monthlyUsdLimit.toFixed(3)}`,
      );
      ok = this.budget.enforcement !== 'hard' ? ok : false;
    }
    return { ok, messages };
  }

  suggestOptimizations(input: {
    assignments: Partial<Record<AgentName, string>>;
    catalog: DiscoveredModel[];
  }): CostOptimizationSuggestion[] {
    const suggestions: CostOptimizationSuggestion[] = [];
    for (const [agent, modelID] of Object.entries(input.assignments)) {
      if (!modelID) continue;
      const current = input.catalog.find((model) => model.model === modelID);
      if (!current) continue;
      const providerMatches = input.catalog
        .filter((model) => model.providerID === current.providerID)
        .sort(
          (left, right) => blendedModelCost(left) - blendedModelCost(right),
        );
      const cheaper = providerMatches.find(
        (candidate) => blendedModelCost(candidate) < blendedModelCost(current),
      );
      if (!cheaper) continue;
      const savings = Math.max(
        0,
        blendedModelCost(current) - blendedModelCost(cheaper),
      );
      if (savings <= 0) continue;
      suggestions.push({
        agent: agent as AgentName,
        fromModel: current.model,
        toModel: cheaper.model,
        estimatedDailySavingsUsd: Math.round(savings * 1000) / 1000,
        reason: 'Cheaper same-provider model detected for cost pressure mode',
      });
    }
    return suggestions;
  }
}
