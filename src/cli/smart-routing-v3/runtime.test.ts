/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import type { DiscoveredModel } from '../types';
import { RoutingAnomalyDetector } from './anomaly';
import { rankProviderRepresentatives } from './beam-search';
import { CostTracker } from './cost';
import { RoutingExperimentManager } from './experiments';
import { FederatedAggregator } from './federated';
import { forecastQuota } from './quota-forecast';
import { RoutingQAgent } from './rl';
import {
  buildSmartRoutingPlanV3,
  createSmartRoutingRuntime,
  evaluateExperimentCanaryTrends,
  evaluateShadowCanary,
  ingestRuntimeMetrics,
} from './runtime';
import { scoreRoutingCandidate } from './scoring';

function model(
  input: Partial<DiscoveredModel> & { model: string },
): DiscoveredModel {
  const [providerID] = input.model.split('/');
  return {
    providerID: providerID ?? 'openai',
    model: input.model,
    name: input.name ?? input.model,
    status: input.status ?? 'active',
    contextLimit: input.contextLimit ?? 200_000,
    outputLimit: input.outputLimit ?? 32_000,
    reasoning: input.reasoning ?? true,
    toolcall: input.toolcall ?? true,
    attachment: input.attachment ?? false,
    dailyRequestLimit: input.dailyRequestLimit,
    costInput: input.costInput,
    costOutput: input.costOutput,
  };
}

const CATALOG: DiscoveredModel[] = [
  model({ model: 'nanogpt/gpt-4o', costInput: 2, costOutput: 8 }),
  model({ model: 'nanogpt/gpt-4o-mini', costInput: 0.4, costOutput: 1.2 }),
  model({ model: 'chutes/kimi-k2.5', costInput: 0.2, costOutput: 0.5 }),
  model({ model: 'chutes/minimax-m2.5', reasoning: false, costInput: 0.1 }),
  model({ model: 'opencode/big-pickle', costInput: 0, costOutput: 0 }),
  model({ model: 'openai/gpt-5.3-codex', costInput: 4, costOutput: 12 }),
];

describe('smart-routing-v3', () => {
  test('builds a full 6-agent v3 plan with chains', () => {
    const output = buildSmartRoutingPlanV3({
      catalog: CATALOG,
      policy: {
        mode: 'hybrid',
        subscriptionBudget: {
          dailyRequests: 120,
          monthlyRequests: 3_000,
          enforcement: 'soft',
        },
      },
      quotaStatus: {
        dailyRemaining: 90,
        monthlyRemaining: 2_400,
        lastCheckedAt: new Date(),
      },
      usageHistory: [
        { dateIso: new Date().toISOString(), calls: 20 },
        { dateIso: new Date().toISOString(), calls: 25 },
      ],
    });

    expect(Object.keys(output.plan.agents)).toHaveLength(6);
    expect(Object.keys(output.plan.chains)).toHaveLength(6);
    expect(output.plan.scoring?.engineVersionApplied).toBe('v3');
    expect(output.explanations.oracle?.summary.length).toBeGreaterThan(0);
  });

  test('forecasts quota exhaustion and returns recommendations', () => {
    const forecast = forecastQuota({
      quota: {
        dailyRemaining: 10,
        monthlyRemaining: 50,
        lastCheckedAt: new Date(),
      },
      history: [
        { dateIso: new Date().toISOString(), calls: 14 },
        { dateIso: new Date().toISOString(), calls: 16 },
        { dateIso: new Date().toISOString(), calls: 13 },
      ],
      horizonDays: 7,
    });

    expect(forecast.points.length).toBe(7);
    expect(forecast.recommendations.length).toBeGreaterThan(0);
    expect(forecast.predictedExhaustionDateIso).toBeDefined();
  });

  test('updates Q-table with reward signal', () => {
    const agent = new RoutingQAgent(0.5, 0.9, 0);
    const state = {
      agent: 'oracle' as const,
      quotaBucket: 'healthy' as const,
      taskBucket: 'reasoning' as const,
    };
    const action = { model: 'nanogpt/gpt-4o', billingMode: 'paygo' as const };

    agent.update({
      state,
      action,
      reward: {
        success: 1,
        qualityBonus: 1,
        latencyPenalty: 0.2,
        costPenalty: 0.1,
      },
      nextState: state,
      availableNextActions: [action],
    });

    const snapshot = agent.snapshot();
    const keys = Object.keys(snapshot);
    expect(keys.length).toBeGreaterThan(0);
  });

  test('supports anomaly detection, cost tracking, experiments, federation', () => {
    const anomaly = new RoutingAnomalyDetector();
    for (let index = 0; index < 9; index++) {
      anomaly.record('fixer', 'nanogpt/gpt-4o-mini', {
        successRate: index === 8 ? 0.7 : 0.96,
        avgLatencyMs: index === 8 ? 3_000 : 900,
        p95LatencyMs: 4_000,
        avgCostUsd: index === 8 ? 0.04 : 0.01,
        fallbackRate: index === 8 ? 0.5 : 0.05,
        sampleCount: 30,
      });
    }
    const anomalies = anomaly.detect('fixer', 'nanogpt/gpt-4o-mini');
    expect(anomalies.length).toBeGreaterThan(0);

    const costs = new CostTracker({ enforcement: 'warn', dailyUsdLimit: 1 });
    costs.recordUsage({
      agent: 'oracle',
      model: 'nanogpt/gpt-4o',
      billingMode: 'paygo',
      inputTokens: 200_000,
      outputTokens: 100_000,
      discoveredModel: CATALOG[0],
    });
    expect(costs.getUsage().dailyUsd).toBeGreaterThan(0);

    const experiments = new RoutingExperimentManager();
    experiments.register({
      id: 'exp-routing',
      name: 'routing experiment',
      variants: [
        { id: 'control', description: 'control' },
        {
          id: 'variant-a',
          description: 'variant',
          assignmentOverrides: {
            oracle: { model: 'openai/gpt-5.3-codex' },
          },
        },
      ],
      allocation: {
        control: 50,
        'variant-a': 50,
      },
      startedAtIso: new Date().toISOString(),
    });
    const variant = experiments.pickVariant('exp-routing', 'user-123');
    expect(variant.id.length).toBeGreaterThan(0);

    const fed = new FederatedAggregator();
    const agg = fed.aggregate([
      {
        modelRewards: { 'nanogpt/gpt-4o': 0.8 },
        featureAdjustments: { roleFit: 0.2 },
        sampleCount: 100,
      },
      {
        modelRewards: { 'nanogpt/gpt-4o': 0.6 },
        featureAdjustments: { roleFit: 0.4 },
        sampleCount: 50,
      },
    ]);
    expect(agg.participants).toBe(2);
    expect(agg.modelRewards['nanogpt/gpt-4o']).toBeGreaterThan(0.6);
  });

  test('keeps provider-representative candidates bounded per agent', () => {
    const ranked = rankProviderRepresentatives({
      models: CATALOG,
      agent: 'oracle',
      context: {
        policy: {
          mode: 'hybrid',
          subscriptionBudget: { enforcement: 'soft' },
        },
        quotaStatus: {
          dailyRemaining: 5000,
          monthlyRemaining: 60000,
          lastCheckedAt: new Date(),
        },
        providerUsage: new Map(),
      },
      maxPerProvider: 1,
      maxProviders: 2,
    });

    const providers = new Set(
      ranked.map((candidate) => candidate.model.providerID),
    );
    expect(ranked.length).toBeLessThanOrEqual(2);
    expect(providers.size).toBeLessThanOrEqual(2);
  });

  test('adds Chutes pacing policy marker into v3 metadata', () => {
    const output = buildSmartRoutingPlanV3({
      catalog: CATALOG,
      policy: {
        mode: 'hybrid',
        subscriptionBudget: {
          enforcement: 'soft',
        },
      },
      quotaStatus: {
        dailyRemaining: 90,
        monthlyRemaining: 2_400,
        lastCheckedAt: new Date(),
      },
      chutesPacing: {
        mode: 'economy',
        monthlyBudget: 3_000,
        monthlyUsed: 2_700,
      },
    });

    expect(output.plan.metadata?.policy).toBe('hybrid;chutes:economy');
  });

  test('scores Chutes models differently per pacing mode', () => {
    const candidate = model({
      model: 'chutes/minimax-m2.5',
      reasoning: false,
      toolcall: true,
      costInput: 0.01,
      costOutput: 0.02,
    });

    const qualityFirst = scoreRoutingCandidate(candidate, 'fixer', {
      policy: {
        mode: 'hybrid',
        subscriptionBudget: {
          enforcement: 'soft',
        },
      },
      quotaStatus: {
        dailyRemaining: 100,
        monthlyRemaining: 1000,
        lastCheckedAt: new Date(),
      },
      providerUsage: new Map(),
      chutesPacing: {
        mode: 'quality-first',
        monthlyBudget: 1000,
        monthlyUsed: 980,
      },
    });

    const economy = scoreRoutingCandidate(candidate, 'fixer', {
      policy: {
        mode: 'hybrid',
        subscriptionBudget: {
          enforcement: 'soft',
        },
      },
      quotaStatus: {
        dailyRemaining: 100,
        monthlyRemaining: 1000,
        lastCheckedAt: new Date(),
      },
      providerUsage: new Map(),
      chutesPacing: {
        mode: 'economy',
        monthlyBudget: 1000,
        monthlyUsed: 980,
      },
    });

    expect(economy.totalScore).toBeGreaterThan(qualityFirst.totalScore);
  });

  test('penalizes NanoGPT premium models when monthly quota is tight', () => {
    const premium = model({
      model: 'nanogpt/gpt-5-pro',
      name: 'GPT-5 Pro',
      reasoning: true,
      toolcall: true,
      costInput: 2,
      costOutput: 8,
    });
    const mini = model({
      model: 'nanogpt/gpt-4o-mini',
      name: 'GPT-4o Mini',
      reasoning: true,
      toolcall: true,
      costInput: 0.4,
      costOutput: 1.2,
    });

    const context = {
      policy: {
        mode: 'hybrid' as const,
        subscriptionBudget: {
          monthlyRequests: 1000,
          enforcement: 'soft' as const,
        },
      },
      quotaStatus: {
        dailyRemaining: 100,
        monthlyRemaining: 80,
        lastCheckedAt: new Date(),
      },
      providerUsage: new Map<string, number>(),
    };

    const premiumScore = scoreRoutingCandidate(premium, 'oracle', context);
    const miniScore = scoreRoutingCandidate(mini, 'oracle', context);

    expect(miniScore.totalScore).toBeGreaterThan(premiumScore.totalScore);
  });

  test('creates runtime with shadow evaluation engine', () => {
    const runtime = createSmartRoutingRuntime({
      shadowEvaluation: {
        minSamples: 20,
      },
    });

    runtime.shadowEvaluation.recordMetrics({
      model: 'nanogpt/gpt-4o-mini',
      agent: 'oracle',
      samples: 40,
      successRate: 0.98,
      avgLatencyMs: 650,
      p95LatencyMs: 1200,
      avgCostUsd: 0.01,
      qualityScore: 86,
      fallbackRate: 0.03,
    });
    runtime.shadowEvaluation.recordMetrics({
      model: 'nanogpt/gpt-4o',
      agent: 'oracle',
      samples: 40,
      successRate: 0.93,
      avgLatencyMs: 1000,
      p95LatencyMs: 2000,
      avgCostUsd: 0.03,
      qualityScore: 80,
      fallbackRate: 0.06,
    });

    const evaluation = runtime.shadowEvaluation.evaluateCandidate(
      'nanogpt/gpt-4o-mini',
      'nanogpt/gpt-4o',
      'oracle',
    );

    expect(evaluation.recommendation).toBe('promote');
  });

  test('ingests runtime metrics and opens circuit on rollback recommendation', () => {
    const runtime = createSmartRoutingRuntime({
      shadowEvaluation: {
        minSamples: 20,
      },
    });

    ingestRuntimeMetrics(runtime, {
      model: 'chutes/minimax-m2.5',
      agent: 'fixer',
      successRate: 0.72,
      avgLatencyMs: 1700,
      p95LatencyMs: 2900,
      avgCostUsd: 0.07,
      fallbackRate: 0.34,
      sampleCount: 40,
      qualityScore: 65,
    });
    ingestRuntimeMetrics(runtime, {
      model: 'chutes/kimi-k2.5',
      agent: 'fixer',
      successRate: 0.95,
      avgLatencyMs: 900,
      p95LatencyMs: 1600,
      avgCostUsd: 0.03,
      fallbackRate: 0.06,
      sampleCount: 40,
      qualityScore: 82,
    });

    const decision = evaluateShadowCanary(runtime, {
      candidateModel: 'chutes/minimax-m2.5',
      baselineModel: 'chutes/kimi-k2.5',
      agent: 'fixer',
      circuitBreakerTtlMs: 30_000,
    });

    expect(decision.recommendation).toBe('rollback');
    expect(
      runtime.anomalyDetector.isCircuitOpen('fixer', 'chutes/minimax-m2.5'),
    ).toBe(true);
  });

  test('writes experiment metrics via ingest and evaluates per-variant canary trends', () => {
    const runtime = createSmartRoutingRuntime();

    runtime.experiments.register({
      id: 'canary-exp',
      name: 'canary experiment',
      variants: [
        { id: 'control', description: 'control' },
        { id: 'fast', description: 'fast candidate' },
        { id: 'bad', description: 'bad candidate' },
      ],
      allocation: {
        control: 34,
        fast: 33,
        bad: 33,
      },
      startedAtIso: new Date().toISOString(),
    });

    for (let index = 0; index < 3; index++) {
      ingestRuntimeMetrics(runtime, {
        model: 'nanogpt/gpt-4o',
        agent: 'oracle',
        successRate: 0.94,
        avgLatencyMs: 1000,
        p95LatencyMs: 1800,
        avgCostUsd: 0.03,
        fallbackRate: 0.05,
        sampleCount: 50,
        qualityScore: 82,
        experiment: {
          experimentId: 'canary-exp',
          variantId: 'control',
        },
      });

      ingestRuntimeMetrics(runtime, {
        model: 'nanogpt/gpt-4o-mini',
        agent: 'oracle',
        successRate: 0.97,
        avgLatencyMs: 760,
        p95LatencyMs: 1300,
        avgCostUsd: 0.015,
        fallbackRate: 0.03,
        sampleCount: 50,
        qualityScore: 86,
        experiment: {
          experimentId: 'canary-exp',
          variantId: 'fast',
        },
      });

      ingestRuntimeMetrics(runtime, {
        model: 'chutes/minimax-m2.5',
        agent: 'oracle',
        successRate: 0.78,
        avgLatencyMs: 1700,
        p95LatencyMs: 2900,
        avgCostUsd: 0.06,
        fallbackRate: 0.3,
        sampleCount: 50,
        qualityScore: 68,
        experiment: {
          experimentId: 'canary-exp',
          variantId: 'bad',
        },
      });
    }

    const decisions = evaluateExperimentCanaryTrends(runtime, {
      experimentId: 'canary-exp',
      baselineVariantId: 'control',
      minSamples: 3,
    });

    const byVariant = new Map(
      decisions.map((decision) => [decision.variantId, decision]),
    );
    expect(byVariant.get('control')?.recommendation).toBe('hold');
    expect(byVariant.get('fast')?.recommendation).toBe('promote');
    expect(byVariant.get('bad')?.recommendation).toBe('rollback');
  });

  test('attaches canary trend summary to plan metadata', () => {
    const output = buildSmartRoutingPlanV3({
      catalog: CATALOG,
      policy: {
        mode: 'hybrid',
        subscriptionBudget: {
          dailyRequests: 120,
          monthlyRequests: 3_000,
          enforcement: 'soft',
        },
      },
      quotaStatus: {
        dailyRemaining: 90,
        monthlyRemaining: 2_400,
        lastCheckedAt: new Date(),
      },
      experimentId: 'canary-exp',
      experimentTrendDecisions: [
        {
          variantId: 'control',
          recommendation: 'hold',
          sampleCount: 200,
          compositeScore: 0,
          reasons: ['Baseline variant.'],
        },
        {
          variantId: 'fast',
          recommendation: 'promote',
          sampleCount: 200,
          compositeScore: 0.08,
          reasons: ['Candidate improved versus baseline.'],
        },
      ],
    });

    expect(output.plan.metadata?.canaryTrend?.experimentId).toBe('canary-exp');
    expect(output.plan.metadata?.canaryTrend?.promoteCount).toBe(1);
    expect(output.plan.metadata?.canaryTrend?.holdCount).toBe(1);
    expect(output.plan.metadata?.canaryTrend?.rollbackCount).toBe(0);
    expect(output.plan.metadata?.canaryTrend?.recommendedAction).toBe('hold');
  });

  test('prioritizes failover chain when canary trend recommends rollback', () => {
    const output = buildSmartRoutingPlanV3({
      catalog: CATALOG,
      policy: {
        mode: 'hybrid',
        subscriptionBudget: {
          dailyRequests: 120,
          monthlyRequests: 3_000,
          enforcement: 'soft',
        },
      },
      quotaStatus: {
        dailyRemaining: 90,
        monthlyRemaining: 2_400,
        lastCheckedAt: new Date(),
      },
      experimentId: 'canary-exp',
      experimentTrendDecisions: [
        {
          variantId: 'control',
          recommendation: 'hold',
          sampleCount: 200,
          compositeScore: 0,
          reasons: ['Baseline variant.'],
        },
        {
          variantId: 'bad',
          recommendation: 'rollback',
          sampleCount: 200,
          compositeScore: -0.2,
          reasons: ['Candidate regressed versus baseline.'],
        },
      ],
    });

    expect(output.plan.metadata?.canaryTrend?.recommendedAction).toBe(
      'rollback',
    );

    for (const [agent, chain] of Object.entries(output.plan.chains)) {
      const primary = chain[0];
      if (primary === 'opencode/big-pickle') continue;
      expect(chain[1]).toBe('opencode/big-pickle');
      expect(output.plan.provenance?.[agent]?.winnerLayer).toBe(
        'provider-fallback-policy',
      );
    }
  });

  test('does not inject opencode fallback when opencode provider is unavailable', () => {
    const catalogWithoutOpenCode: DiscoveredModel[] = [
      model({ model: 'nanogpt/gpt-4o', costInput: 2, costOutput: 8 }),
      model({ model: 'nanogpt/gpt-4o-mini', costInput: 0.4, costOutput: 1.2 }),
      model({ model: 'chutes/kimi-k2.5', costInput: 0.2, costOutput: 0.5 }),
      model({ model: 'openai/gpt-5.3-codex', costInput: 4, costOutput: 12 }),
    ];

    const output = buildSmartRoutingPlanV3({
      catalog: catalogWithoutOpenCode,
      policy: {
        mode: 'hybrid',
        subscriptionBudget: {
          dailyRequests: 120,
          monthlyRequests: 3_000,
          enforcement: 'soft',
        },
      },
      quotaStatus: {
        dailyRemaining: 90,
        monthlyRemaining: 2_400,
        lastCheckedAt: new Date(),
      },
      experimentTrendDecisions: [
        {
          variantId: 'rollback-case',
          recommendation: 'rollback',
          sampleCount: 200,
          compositeScore: -0.2,
          reasons: ['Candidate regressed versus baseline.'],
        },
      ],
    });

    for (const chain of Object.values(output.plan.chains)) {
      expect(chain.includes('opencode/big-pickle')).toBe(false);
    }
  });

  test('applies preferred model override per agent when available', () => {
    const output = buildSmartRoutingPlanV3({
      catalog: CATALOG,
      policy: {
        mode: 'hybrid',
        subscriptionBudget: {
          dailyRequests: 120,
          monthlyRequests: 3_000,
          enforcement: 'soft',
        },
      },
      quotaStatus: {
        dailyRemaining: 90,
        monthlyRemaining: 2_400,
        lastCheckedAt: new Date(),
      },
      modelPreferences: {
        fixer: ['chutes/kimi-k2.5'],
      },
    });

    expect(output.plan.agents.fixer?.model).toBe('chutes/kimi-k2.5');
    expect(output.plan.provenance?.fixer?.winnerLayer).toBe('pinned-model');
  });
});
