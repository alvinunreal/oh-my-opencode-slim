import {
  pickBestModel,
  pickPrimaryAndSupport,
  type ScoreFunction,
} from './model-selection';
import type { OpenCodeFreeModel } from './types';

export interface OpenCodeModelRuntimeHealth {
  successRate?: number;
  fallbackRate?: number;
  timeoutRate?: number;
  avgLatencyMs?: number;
}

export interface OpenCodeSelectionOptions {
  runtimeHealthByModel?: Record<string, OpenCodeModelRuntimeHealth>;
}

function statusScore(status: OpenCodeFreeModel['status']): number {
  if (status === 'active') return 16;
  if (status === 'beta') return 6;
  if (status === 'alpha') return -6;
  return -30;
}

function dailyQuotaScore(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 4;
  if (limit <= 300) return -20;
  if (limit <= 2000) return -8;
  if (limit <= 5000) return 6;
  return 10;
}

function runtimeHealthScore(
  model: OpenCodeFreeModel,
  options?: OpenCodeSelectionOptions,
): number {
  const health = options?.runtimeHealthByModel?.[model.model];
  if (!health) return 0;

  let score = 0;
  const successRate = health.successRate;
  const fallbackRate = health.fallbackRate;
  const timeoutRate = health.timeoutRate;
  const avgLatencyMs = health.avgLatencyMs;

  if (typeof successRate === 'number') {
    if (successRate < 0.85) score -= 35;
    else if (successRate < 0.92) score -= 15;
    else if (successRate > 0.97) score += 8;
  }

  if (typeof fallbackRate === 'number') {
    if (fallbackRate > 0.2) score -= 30;
    else if (fallbackRate > 0.1) score -= 15;
    else if (fallbackRate < 0.03) score += 6;
  }

  if (typeof timeoutRate === 'number') {
    if (timeoutRate > 0.1) score -= 30;
    else if (timeoutRate > 0.03) score -= 12;
    else if (timeoutRate === 0) score += 4;
  }

  if (typeof avgLatencyMs === 'number') {
    if (avgLatencyMs > 2000) score -= 12;
    else if (avgLatencyMs > 1200) score -= 6;
    else if (avgLatencyMs < 700) score += 3;
  }

  return score;
}

const scoreOpenCodePrimaryForCoding =
  (options?: OpenCodeSelectionOptions): ScoreFunction<OpenCodeFreeModel> =>
  (model) => {
    return (
      (model.reasoning ? 100 : 0) +
      (model.toolcall ? 80 : 0) +
      (model.attachment ? 20 : 0) +
      Math.min(model.contextLimit, 1_000_000) / 10_000 +
      Math.min(model.outputLimit, 300_000) / 10_000 +
      statusScore(model.status) +
      dailyQuotaScore(model.dailyRequestLimit) +
      runtimeHealthScore(model, options)
    );
  };

function speedBonus(modelName: string): number {
  const lower = modelName.toLowerCase();
  let score = 0;
  if (lower.includes('nano')) score += 60;
  if (lower.includes('flash')) score += 45;
  if (lower.includes('mini')) score += 25;
  if (lower.includes('preview')) score += 10;
  return score;
}

const scoreOpenCodeSupportForCoding =
  (options?: OpenCodeSelectionOptions): ScoreFunction<OpenCodeFreeModel> =>
  (model) => {
    return (
      (model.toolcall ? 90 : 0) +
      (model.reasoning ? 50 : 0) +
      speedBonus(model.model) +
      Math.min(model.contextLimit, 400_000) / 20_000 +
      statusScore(model.status) +
      dailyQuotaScore(model.dailyRequestLimit) +
      runtimeHealthScore(model, options)
    );
  };

export function pickBestCodingOpenCodeModel(
  models: OpenCodeFreeModel[],
  options?: OpenCodeSelectionOptions,
): OpenCodeFreeModel | null {
  return pickBestModel(models, scoreOpenCodePrimaryForCoding(options));
}

export function pickSupportOpenCodeModel(
  models: OpenCodeFreeModel[],
  primaryModel?: string,
  options?: OpenCodeSelectionOptions,
): OpenCodeFreeModel | null {
  const { support } = pickPrimaryAndSupport(
    models,
    {
      primary: scoreOpenCodePrimaryForCoding(options),
      support: scoreOpenCodeSupportForCoding(options),
    },
    primaryModel,
  );

  return support;
}
