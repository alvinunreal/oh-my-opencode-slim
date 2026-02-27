import { resolvePreferredModelForAgent } from '../model-preferences';
import type {
  AgentModelAssignment,
  AgentName,
  DiscoveredModel,
  DynamicModelPlan,
  ModelPreferencesByAgent,
  ResolutionLayerName,
} from '../types';
import { RoutingAnomalyDetector } from './anomaly';
import { buildRankedAlternatives, selectWithBeamSearch } from './beam-search';
import { type CostBudget, CostTracker } from './cost';
import { RoutingExperimentManager } from './experiments';
import { forecastQuota, type UsageSnapshot } from './quota-forecast';
import { scoreRoutingCandidate } from './scoring';
import {
  type ShadowEvaluationConfig,
  ShadowEvaluationEngine,
  type ShadowEvaluationResult,
  type ShadowModelPerformanceMetrics,
} from './shadow-evaluation';
import type {
  ChutesMonthlyPacing,
  NanoGptRoutingPolicy,
  RoutingDecisionExplanation,
  RoutingQuotaStatus,
  RoutingRuntimeMetrics,
  RoutingScoringContext,
  SelectionConfig,
} from './types';
import { explainRoutingDecision } from './xai';

const AGENTS: AgentName[] = [
  'orchestrator',
  'oracle',
  'designer',
  'explorer',
  'librarian',
  'fixer',
];

const DEFAULT_SELECTION: SelectionConfig = {
  beamWidth: 5,
  diversityWeight: 10,
  maxAlternativesPerAgent: 5,
  maxPerProviderPerAgent: 2,
  maxProvidersPerAgent: 6,
};

function assignmentConfidence(assignment: AgentModelAssignment): number {
  return assignment.confidence ?? 0.7;
}

function providerDistribution(
  assignments: Record<AgentName, AgentModelAssignment>,
): Record<string, number> {
  const output: Record<string, number> = {};
  for (const assignment of Object.values(assignments)) {
    const provider = assignment.model.split('/')[0] ?? 'unknown';
    output[provider] = (output[provider] ?? 0) + 1;
  }
  return output;
}

function prioritizeRollbackFailoverChains(
  chains: Record<string, string[]>,
): string[] {
  const safeFallback = 'opencode/big-pickle';
  const updatedAgents: string[] = [];

  for (const [agent, chain] of Object.entries(chains)) {
    if (chain.length === 0) continue;
    const primary = chain[0];
    if (!primary) continue;

    const preferredFallback = chain.includes(safeFallback)
      ? safeFallback
      : chain[1];
    if (!preferredFallback || preferredFallback === primary) continue;

    const tail = chain.filter(
      (model, index) => index > 0 && model !== preferredFallback,
    );
    chains[agent] = [primary, preferredFallback, ...tail].filter(
      (model, index, array) => array.indexOf(model) === index,
    );
    updatedAgents.push(agent);
  }

  return updatedAgents;
}

export interface SmartRoutingRuntime {
  anomalyDetector: RoutingAnomalyDetector;
  costTracker: CostTracker;
  experiments: RoutingExperimentManager;
  shadowEvaluation: ShadowEvaluationEngine;
}

export interface RuntimeMetricIngestInput {
  model: string;
  agent: AgentName;
  billingMode?: ShadowModelPerformanceMetrics['billingMode'];
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgCostUsd: number;
  fallbackRate: number;
  sampleCount: number;
  qualityScore: number;
  experiment?: {
    experimentId: string;
    variantId?: string;
    subjectId?: string;
  };
}

export interface RuntimeMetricIngestResult {
  variantId?: string;
}

export interface ShadowCanaryDecisionInput {
  candidateModel: string;
  baselineModel: string;
  agent: AgentName;
  circuitBreakerTtlMs?: number;
}

export interface ExperimentCanaryTrendInput {
  experimentId: string;
  baselineVariantId?: string;
  minSamples?: number;
  promoteThreshold?: number;
  rollbackThreshold?: number;
  maxLatencyRegressionPct?: number;
  maxCostIncreasePct?: number;
  minSuccessDropPct?: number;
}

export interface ExperimentCanaryVariantDecision {
  variantId: string;
  recommendation: 'promote' | 'hold' | 'rollback';
  sampleCount: number;
  compositeScore: number;
  reasons: string[];
}

export interface PlanCanaryTrendSummary {
  experimentId?: string;
  promoteCount: number;
  holdCount: number;
  rollbackCount: number;
  recommendedAction: 'promote' | 'hold' | 'rollback';
}

export function createSmartRoutingRuntime(input?: {
  budget?: CostBudget;
  shadowEvaluation?: Partial<ShadowEvaluationConfig>;
}): SmartRoutingRuntime {
  return {
    anomalyDetector: new RoutingAnomalyDetector(),
    costTracker: new CostTracker(
      input?.budget ?? {
        enforcement: 'warn',
      },
    ),
    experiments: new RoutingExperimentManager(),
    shadowEvaluation: new ShadowEvaluationEngine(input?.shadowEvaluation),
  };
}

export function ingestRuntimeMetrics(
  runtime: SmartRoutingRuntime,
  input: RuntimeMetricIngestInput,
): RuntimeMetricIngestResult {
  const runtimeMetrics: RoutingRuntimeMetrics = {
    successRate: input.successRate,
    avgLatencyMs: input.avgLatencyMs,
    p95LatencyMs: input.p95LatencyMs,
    avgCostUsd: input.avgCostUsd,
    fallbackRate: input.fallbackRate,
    sampleCount: input.sampleCount,
  };

  runtime.anomalyDetector.record(input.agent, input.model, runtimeMetrics);
  runtime.shadowEvaluation.recordMetrics({
    model: input.model,
    agent: input.agent,
    billingMode: input.billingMode,
    samples: input.sampleCount,
    successRate: input.successRate,
    avgLatencyMs: input.avgLatencyMs,
    p95LatencyMs: input.p95LatencyMs,
    avgCostUsd: input.avgCostUsd,
    qualityScore: input.qualityScore,
    fallbackRate: input.fallbackRate,
  });

  const experimentId = input.experiment?.experimentId;
  if (!experimentId) return {};

  let variantId = input.experiment?.variantId;
  if (!variantId) {
    const subjectId = input.experiment?.subjectId;
    if (!subjectId) {
      throw new Error(
        'subjectId or variantId is required for experiment ingest',
      );
    }
    variantId = runtime.experiments.pickVariant(experimentId, subjectId).id;
  }

  runtime.experiments.recordVariantMetrics(
    experimentId,
    variantId,
    runtimeMetrics,
  );
  return { variantId };
}

export function evaluateShadowCanary(
  runtime: SmartRoutingRuntime,
  input: ShadowCanaryDecisionInput,
): ShadowEvaluationResult {
  const evaluation = runtime.shadowEvaluation.evaluateCandidate(
    input.candidateModel,
    input.baselineModel,
    input.agent,
  );

  if (evaluation.recommendation === 'rollback') {
    runtime.anomalyDetector.openCircuit(
      input.agent,
      input.candidateModel,
      evaluation.reasons[0] ?? 'shadow regression detected',
      input.circuitBreakerTtlMs ?? 15 * 60 * 1000,
    );
  }

  return evaluation;
}

export function evaluateExperimentCanaryTrends(
  runtime: SmartRoutingRuntime,
  input: ExperimentCanaryTrendInput,
): ExperimentCanaryVariantDecision[] {
  const summary = runtime.experiments.summarize(input.experimentId);
  if (summary.length === 0) return [];

  const minSamples = input.minSamples ?? 30;
  const promoteThreshold = input.promoteThreshold ?? 0.05;
  const rollbackThreshold = input.rollbackThreshold ?? -0.08;
  const maxLatencyRegressionPct = input.maxLatencyRegressionPct ?? 0.2;
  const maxCostIncreasePct = input.maxCostIncreasePct ?? 0.2;
  const minSuccessDropPct = input.minSuccessDropPct ?? 0.05;

  const baseline =
    summary.find((row) => row.variantId === input.baselineVariantId) ??
    summary[0];
  if (!baseline) return [];

  return summary.map((row) => {
    if (row.variantId === baseline.variantId) {
      return {
        variantId: row.variantId,
        recommendation: 'hold',
        sampleCount: row.sampleCount,
        compositeScore: 0,
        reasons: ['Baseline variant.'],
      };
    }

    if (row.sampleCount < minSamples || baseline.sampleCount < minSamples) {
      return {
        variantId: row.variantId,
        recommendation: 'hold',
        sampleCount: row.sampleCount,
        compositeScore: 0,
        reasons: [`Insufficient samples: ${row.sampleCount}/${minSamples}`],
      };
    }

    const successDelta = row.avgSuccessRate - baseline.avgSuccessRate;
    const latencyRegressionPct =
      baseline.avgLatencyMs > 0
        ? (row.avgLatencyMs - baseline.avgLatencyMs) / baseline.avgLatencyMs
        : 0;
    const costIncreasePct =
      baseline.avgCostUsd > 0
        ? (row.avgCostUsd - baseline.avgCostUsd) / baseline.avgCostUsd
        : 0;

    const compositeScore =
      successDelta * 0.6 - latencyRegressionPct * 0.25 - costIncreasePct * 0.15;

    if (
      successDelta <= -minSuccessDropPct ||
      latencyRegressionPct >= maxLatencyRegressionPct ||
      costIncreasePct >= maxCostIncreasePct ||
      compositeScore <= rollbackThreshold
    ) {
      return {
        variantId: row.variantId,
        recommendation: 'rollback',
        sampleCount: row.sampleCount,
        compositeScore,
        reasons: ['Candidate regressed versus baseline.'],
      };
    }

    if (compositeScore >= promoteThreshold && successDelta >= 0) {
      return {
        variantId: row.variantId,
        recommendation: 'promote',
        sampleCount: row.sampleCount,
        compositeScore,
        reasons: ['Candidate improved versus baseline.'],
      };
    }

    return {
      variantId: row.variantId,
      recommendation: 'hold',
      sampleCount: row.sampleCount,
      compositeScore,
      reasons: ['Trend is neutral.'],
    };
  });
}

export function summarizeExperimentCanaryTrends(input: {
  decisions: ExperimentCanaryVariantDecision[];
  experimentId?: string;
}): PlanCanaryTrendSummary | undefined {
  if (input.decisions.length === 0) return undefined;

  const promoteCount = input.decisions.filter(
    (decision) => decision.recommendation === 'promote',
  ).length;
  const holdCount = input.decisions.filter(
    (decision) => decision.recommendation === 'hold',
  ).length;
  const rollbackCount = input.decisions.filter(
    (decision) => decision.recommendation === 'rollback',
  ).length;

  const recommendedAction =
    rollbackCount > 0
      ? 'rollback'
      : promoteCount > 0 && holdCount === 0
        ? 'promote'
        : 'hold';

  return {
    experimentId: input.experimentId,
    promoteCount,
    holdCount,
    rollbackCount,
    recommendedAction,
  };
}

export function buildSmartRoutingPlanV3(input: {
  catalog: DiscoveredModel[];
  policy: NanoGptRoutingPolicy;
  quotaStatus: RoutingQuotaStatus;
  chutesPacing?: ChutesMonthlyPacing;
  modelPreferences?: ModelPreferencesByAgent;
  usageHistory?: UsageSnapshot[];
  selectionConfig?: Partial<SelectionConfig>;
  experimentTrendDecisions?: ExperimentCanaryVariantDecision[];
  experimentId?: string;
}): {
  plan: DynamicModelPlan;
  explanations: Record<AgentName, RoutingDecisionExplanation | null>;
} {
  const selectionConfig: SelectionConfig = {
    ...DEFAULT_SELECTION,
    ...input.selectionConfig,
  };
  const baseContext: RoutingScoringContext = {
    policy: input.policy,
    quotaStatus: input.quotaStatus,
    providerUsage: new Map<string, number>(),
    chutesPacing: input.chutesPacing,
    modelPreferences: input.modelPreferences,
  };

  const assignments = selectWithBeamSearch({
    agents: AGENTS,
    models: input.catalog,
    config: selectionConfig,
    context: baseContext,
  });

  const chains: Record<string, string[]> = {};
  const agents: Record<string, AgentModelAssignment> = {};
  const provenance: DynamicModelPlan['provenance'] = {};
  const includeZenFallback = input.catalog.some(
    (model) => model.providerID === 'opencode',
  );
  const explanations: Record<AgentName, RoutingDecisionExplanation | null> = {
    orchestrator: null,
    oracle: null,
    designer: null,
    explorer: null,
    librarian: null,
    fixer: null,
  };

  for (const agent of AGENTS) {
    const assignment = assignments[agent];
    if (!assignment) continue;

    const ranked = buildRankedAlternatives({
      agent,
      models: input.catalog,
      context: baseContext,
      max: selectionConfig.maxAlternativesPerAgent,
      maxPerProvider: selectionConfig.maxPerProviderPerAgent,
      maxProviders: selectionConfig.maxProvidersPerAgent,
    });

    let selected = assignment;
    let winnerLayer: ResolutionLayerName = 'dynamic-recommendation';

    const preferredModel = resolvePreferredModelForAgent({
      agent,
      preferences: input.modelPreferences,
      candidates: input.catalog.map((model) => model.model),
    });

    if (preferredModel && preferredModel !== assignment.model) {
      const preferredCatalogModel = input.catalog.find(
        (model) => model.model === preferredModel,
      );
      if (preferredCatalogModel) {
        const preferredScore = scoreRoutingCandidate(
          preferredCatalogModel,
          agent,
          baseContext,
        );
        selected = {
          model: preferredCatalogModel.model,
          billingMode: preferredScore.billingMode,
          confidence: Math.max(0, Math.min(1, preferredScore.totalScore / 120)),
          reasoning: preferredScore.components
            .slice(0, 3)
            .map(
              (component) =>
                `${component.name}:${component.normalizedScore.toFixed(1)}`,
            )
            .join(', '),
        };
        winnerLayer = 'pinned-model';
      }
    }

    agents[agent] = selected;

    chains[agent] = [
      selected.model,
      ...ranked
        .map((candidate) => candidate.model.model)
        .filter((model) => model !== selected.model),
      ...(includeZenFallback ? ['opencode/big-pickle'] : []),
    ].filter((value, index, array) => array.indexOf(value) === index);

    explanations[agent] = explainRoutingDecision({
      agent,
      ranked,
      alternatives: 3,
    });

    provenance[agent] = {
      winnerLayer,
      winnerModel: selected.model,
    };
  }

  const confidence =
    Object.values(agents).reduce(
      (sum, assignment) => sum + assignmentConfidence(assignment),
      0,
    ) / Math.max(1, Object.keys(agents).length);
  const quotaForecast = forecastQuota({
    quota: input.quotaStatus,
    history: input.usageHistory ?? [],
    horizonDays: 14,
  });

  const plan: DynamicModelPlan = {
    agents,
    chains,
    provenance,
    scoring: {
      engineVersionApplied: 'v3',
      shadowCompared: false,
    },
    explanations: Object.fromEntries(
      Object.entries(explanations)
        .filter(([, value]) => value !== null)
        .map(([agent, value]) => [agent, value?.summary ?? '']),
    ),
    metadata: {
      policy: input.policy.mode,
      providerDistribution: providerDistribution(assignments),
      estimatedDailyCostUsd: 0,
      quotaPressure: quotaForecast.predictedExhaustionDateIso
        ? 'critical'
        : input.quotaStatus.dailyRemaining < 50
          ? 'warning'
          : 'healthy',
    },
  };

  if (input.chutesPacing) {
    plan.metadata = {
      ...plan.metadata,
      policy: `${input.policy.mode};chutes:${input.chutesPacing.mode}`,
    };
  }

  const canaryTrend = summarizeExperimentCanaryTrends({
    decisions: input.experimentTrendDecisions ?? [],
    experimentId: input.experimentId,
  });
  if (canaryTrend) {
    plan.metadata = {
      ...plan.metadata,
      canaryTrend,
    };
    if (canaryTrend.recommendedAction === 'rollback') {
      const updatedAgents = prioritizeRollbackFailoverChains(chains);
      for (const agent of updatedAgents) {
        const assignment = agents[agent as AgentName];
        if (!assignment) continue;
        provenance[agent] = {
          winnerLayer: 'provider-fallback-policy',
          winnerModel: assignment.model,
        };
      }
    }
  }

  if (Number.isFinite(confidence)) {
    for (const assignment of Object.values(plan.agents)) {
      if (typeof assignment.confidence !== 'number') {
        assignment.confidence = confidence;
      }
    }
  }

  return {
    plan,
    explanations,
  };
}
