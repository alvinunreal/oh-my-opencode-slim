/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import {
  ShadowEvaluationEngine,
  type ShadowModelPerformanceMetrics,
} from './shadow-evaluation';

function metric(
  input: Partial<ShadowModelPerformanceMetrics> & { model: string },
): ShadowModelPerformanceMetrics {
  return {
    model: input.model,
    agent: input.agent ?? 'oracle',
    billingMode: input.billingMode,
    samples: input.samples ?? 60,
    successRate: input.successRate ?? 0.95,
    avgLatencyMs: input.avgLatencyMs ?? 900,
    p95LatencyMs: input.p95LatencyMs ?? 1800,
    avgCostUsd: input.avgCostUsd ?? 0.02,
    qualityScore: input.qualityScore ?? 80,
    fallbackRate: input.fallbackRate ?? 0.05,
  };
}

describe('shadow-evaluation', () => {
  test('holds candidate when samples are below minimum threshold', () => {
    const engine = new ShadowEvaluationEngine({ minSamples: 50 });

    engine.recordMetrics(
      metric({
        model: 'openai/gpt-5.1-codex-mini',
        samples: 30,
      }),
    );
    engine.recordMetrics(
      metric({ model: 'openai/gpt-5.3-codex', samples: 80 }),
    );

    const result = engine.evaluateCandidate(
      'openai/gpt-5.1-codex-mini',
      'openai/gpt-5.3-codex',
      'oracle',
    );

    expect(result.recommendation).toBe('hold');
    expect(result.reasons[0]).toContain('Insufficient samples');
  });

  test('promotes candidate when composite score is clearly better', () => {
    const engine = new ShadowEvaluationEngine({ minSamples: 20 });

    engine.recordMetrics(
      metric({
        model: 'nanogpt/gpt-4o-mini',
        samples: 80,
        successRate: 0.98,
        avgLatencyMs: 700,
        avgCostUsd: 0.012,
        qualityScore: 86,
        fallbackRate: 0.03,
      }),
    );
    engine.recordMetrics(
      metric({
        model: 'nanogpt/gpt-4o',
        samples: 80,
        successRate: 0.93,
        avgLatencyMs: 1000,
        avgCostUsd: 0.03,
        qualityScore: 78,
        fallbackRate: 0.07,
      }),
    );

    const result = engine.evaluateCandidate(
      'nanogpt/gpt-4o-mini',
      'nanogpt/gpt-4o',
      'oracle',
    );

    expect(result.recommendation).toBe('promote');
    expect(result.confidence).toBeGreaterThan(0);
  });

  test('rolls back candidate on hard regression signals', () => {
    const engine = new ShadowEvaluationEngine({ minSamples: 20 });

    engine.recordMetrics(
      metric({
        model: 'chutes/minimax-m2.5',
        samples: 90,
        successRate: 0.78,
        avgLatencyMs: 1700,
        avgCostUsd: 0.05,
        qualityScore: 70,
        fallbackRate: 0.32,
      }),
    );
    engine.recordMetrics(
      metric({
        model: 'chutes/kimi-k2.5',
        samples: 90,
        successRate: 0.94,
        avgLatencyMs: 900,
        avgCostUsd: 0.03,
        qualityScore: 82,
        fallbackRate: 0.06,
      }),
    );

    const result = engine.evaluateCandidate(
      'chutes/minimax-m2.5',
      'chutes/kimi-k2.5',
      'oracle',
    );

    expect(result.recommendation).toBe('rollback');
    expect(result.reasons.some((reason) => reason.includes('Regression'))).toBe(
      true,
    );
  });
});
