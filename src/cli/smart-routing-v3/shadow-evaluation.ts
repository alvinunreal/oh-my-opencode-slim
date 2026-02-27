import type { AgentName, BillingMode } from '../types';

export interface ShadowEvaluationConfig {
  enabled: boolean;
  canaryPercentage: number;
  evaluationPeriodMs: number;
  minSamples: number;
  regressionThreshold: number;
}

export interface ShadowModelPerformanceMetrics {
  model: string;
  agent: AgentName;
  billingMode?: BillingMode;
  samples: number;
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgCostUsd: number;
  qualityScore: number;
  fallbackRate: number;
}

export interface ShadowEvaluationResult {
  candidateModel: string;
  baselineModel: string;
  agent: AgentName;
  metrics: {
    candidate: ShadowModelPerformanceMetrics;
    baseline: ShadowModelPerformanceMetrics;
  };
  recommendation: 'promote' | 'hold' | 'rollback';
  confidence: number;
  reasons: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function keyFor(agent: AgentName, model: string): string {
  return `${agent}|${model}`;
}

export class ShadowEvaluationEngine {
  private readonly metricsStore = new Map<
    string,
    ShadowModelPerformanceMetrics
  >();
  private readonly config: ShadowEvaluationConfig;

  constructor(config?: Partial<ShadowEvaluationConfig>) {
    this.config = {
      enabled: config?.enabled ?? true,
      canaryPercentage: config?.canaryPercentage ?? 5,
      evaluationPeriodMs: config?.evaluationPeriodMs ?? 60 * 60 * 1000,
      minSamples: config?.minSamples ?? 30,
      regressionThreshold: config?.regressionThreshold ?? 0.08,
    };
  }

  recordMetrics(metrics: ShadowModelPerformanceMetrics): void {
    this.metricsStore.set(keyFor(metrics.agent, metrics.model), metrics);
  }

  evaluateCandidate(
    candidateModel: string,
    baselineModel: string,
    agent: AgentName,
  ): ShadowEvaluationResult {
    const candidate = this.metricsStore.get(keyFor(agent, candidateModel));
    const baseline = this.metricsStore.get(keyFor(agent, baselineModel));

    if (!candidate || !baseline) {
      throw new Error('Insufficient metrics for evaluation');
    }

    if (!this.config.enabled) {
      return {
        candidateModel,
        baselineModel,
        agent,
        metrics: { candidate, baseline },
        recommendation: 'hold',
        confidence: 0,
        reasons: ['Shadow evaluation disabled.'],
      };
    }

    if (candidate.samples < this.config.minSamples) {
      return {
        candidateModel,
        baselineModel,
        agent,
        metrics: { candidate, baseline },
        recommendation: 'hold',
        confidence: 0,
        reasons: [
          `Insufficient samples: ${candidate.samples}/${this.config.minSamples}`,
        ],
      };
    }

    const successDelta = candidate.successRate - baseline.successRate;
    const latencyDelta =
      baseline.avgLatencyMs > 0
        ? (baseline.avgLatencyMs - candidate.avgLatencyMs) /
          baseline.avgLatencyMs
        : 0;
    const costDelta =
      baseline.avgCostUsd > 0
        ? (baseline.avgCostUsd - candidate.avgCostUsd) / baseline.avgCostUsd
        : 0;
    const fallbackDelta = baseline.fallbackRate - candidate.fallbackRate;
    const qualityDelta = (candidate.qualityScore - baseline.qualityScore) / 100;

    const overallScore =
      successDelta * 0.4 +
      latencyDelta * 0.2 +
      costDelta * 0.15 +
      fallbackDelta * 0.15 +
      qualityDelta * 0.1;

    const hardRegression =
      candidate.successRate < baseline.successRate - 0.08 ||
      candidate.fallbackRate > Math.max(0.2, baseline.fallbackRate * 1.6) ||
      candidate.avgLatencyMs > baseline.avgLatencyMs * 1.35;

    const reasons: string[] = [];
    let recommendation: ShadowEvaluationResult['recommendation'] = 'hold';

    if (hardRegression || overallScore < -this.config.regressionThreshold) {
      recommendation = 'rollback';
      reasons.push(
        `Regression detected: ${(overallScore * 100).toFixed(1)}% composite drop`,
      );
    } else if (overallScore > 0.06) {
      recommendation = 'promote';
      reasons.push(
        `Candidate outperforms baseline by ${(overallScore * 100).toFixed(1)}%`,
      );
    } else {
      reasons.push(
        `Performance change is neutral: ${(overallScore * 100).toFixed(1)}%`,
      );
    }

    if (latencyDelta < -0.1) {
      reasons.push('Latency regressed materially.');
    }
    if (costDelta < -0.1) {
      reasons.push('Cost increased materially.');
    }
    if (fallbackDelta < -0.05) {
      reasons.push('Fallback rate increased materially.');
    }

    const confidence = clamp(
      Math.min(candidate.samples, baseline.samples) /
        (this.config.minSamples * 2),
      0,
      1,
    );

    return {
      candidateModel,
      baselineModel,
      agent,
      metrics: { candidate, baseline },
      recommendation,
      confidence,
      reasons,
    };
  }
}
