import {
  pickBestModel,
  pickPrimaryAndSupport,
  type ScoreFunction,
} from './model-selection';
import type { OpenCodeFreeModel } from './types';

const scoreOpenCodePrimaryForCoding: ScoreFunction<OpenCodeFreeModel> = (
  model,
) => {
  return (
    (model.reasoning ? 100 : 0) +
    (model.toolcall ? 80 : 0) +
    (model.attachment ? 20 : 0) +
    Math.min(model.contextLimit, 1_000_000) / 10_000 +
    Math.min(model.outputLimit, 300_000) / 10_000 +
    (model.status === 'active' ? 10 : 0)
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

const scoreOpenCodeSupportForCoding: ScoreFunction<OpenCodeFreeModel> = (
  model,
) => {
  return (
    (model.toolcall ? 90 : 0) +
    (model.reasoning ? 50 : 0) +
    speedBonus(model.model) +
    Math.min(model.contextLimit, 400_000) / 20_000 +
    (model.status === 'active' ? 5 : 0)
  );
};

export function pickBestCodingOpenCodeModel(
  models: OpenCodeFreeModel[],
): OpenCodeFreeModel | null {
  return pickBestModel(models, scoreOpenCodePrimaryForCoding);
}

export function pickSupportOpenCodeModel(
  models: OpenCodeFreeModel[],
  primaryModel?: string,
): OpenCodeFreeModel | null {
  const { support } = pickPrimaryAndSupport(
    models,
    {
      primary: scoreOpenCodePrimaryForCoding,
      support: scoreOpenCodeSupportForCoding,
    },
    primaryModel,
  );

  return support;
}
