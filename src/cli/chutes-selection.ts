import {
  pickBestModel,
  pickPrimaryAndSupport,
  type ScoreFunction,
} from './model-selection';
import type { OpenCodeFreeModel } from './types';

function normalizeDailyLimit(
  limit: number | undefined,
): 300 | 2000 | 5000 | null {
  if (limit === 300 || limit === 2000 || limit === 5000) return limit;
  return null;
}

function supportTierBonus(model: OpenCodeFreeModel): number {
  const tier = normalizeDailyLimit(model.dailyRequestLimit);
  if (tier === 5000) return 40;
  if (tier === 2000) return 18;
  if (tier === 300) return -25;
  return 8;
}

function primaryTierBonus(model: OpenCodeFreeModel): number {
  const tier = normalizeDailyLimit(model.dailyRequestLimit);
  if (tier === 300) return 25;
  if (tier === 2000) return 15;
  if (tier === 5000) return 4;
  return 10;
}

function speedBonus(modelName: string): number {
  const lower = modelName.toLowerCase();
  let score = 0;
  if (lower.includes('nano')) score += 60;
  if (lower.includes('flash')) score += 45;
  if (lower.includes('mini')) score += 30;
  if (lower.includes('lite')) score += 20;
  if (lower.includes('small')) score += 15;
  return score;
}

const scoreChutesPrimaryForCoding: ScoreFunction<OpenCodeFreeModel> = (
  model,
) => {
  return (
    (model.reasoning ? 120 : 0) +
    (model.toolcall ? 80 : 0) +
    (model.attachment ? 20 : 0) +
    Math.min(model.contextLimit, 1_000_000) / 9_000 +
    Math.min(model.outputLimit, 300_000) / 10_000 +
    (model.status === 'active' ? 10 : 0) +
    primaryTierBonus(model)
  );
};

const scoreChutesSupportForCoding: ScoreFunction<OpenCodeFreeModel> = (
  model,
) => {
  return (
    (model.toolcall ? 90 : 0) +
    (model.reasoning ? 35 : 0) +
    speedBonus(model.model) +
    Math.min(model.contextLimit, 400_000) / 20_000 +
    (model.status === 'active' ? 8 : 0) +
    supportTierBonus(model)
  );
};

export function pickBestCodingChutesModel(
  models: OpenCodeFreeModel[],
): OpenCodeFreeModel | null {
  return pickBestModel(models, scoreChutesPrimaryForCoding);
}

export function pickSupportChutesModel(
  models: OpenCodeFreeModel[],
  primaryModel?: string,
): OpenCodeFreeModel | null {
  const { support } = pickPrimaryAndSupport(
    models,
    {
      primary: scoreChutesPrimaryForCoding,
      support: scoreChutesSupportForCoding,
    },
    primaryModel,
  );

  return support;
}
