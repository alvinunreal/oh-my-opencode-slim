export interface ModelSelectionCandidate {
  model: string;
  status?: 'alpha' | 'beta' | 'deprecated' | 'active';
  contextLimit?: number;
  outputLimit?: number;
  reasoning?: boolean;
  toolcall?: boolean;
  attachment?: boolean;
  tags?: string[];
  meta?: Record<string, unknown>;
}

export interface RankedModel<T extends ModelSelectionCandidate> {
  candidate: T;
  score: number;
}

export interface SelectionOptions<T extends ModelSelectionCandidate> {
  excludeModels?: string[];
  tieBreaker?: (left: T, right: T) => number;
}

export type ScoreFunction<T extends ModelSelectionCandidate> = (
  candidate: T,
) => number;

export interface RoleScoring<T extends ModelSelectionCandidate> {
  primary: ScoreFunction<T>;
  support: ScoreFunction<T>;
}

function defaultTieBreaker<T extends ModelSelectionCandidate>(
  left: T,
  right: T,
): number {
  return left.model.localeCompare(right.model);
}

export function rankModels<T extends ModelSelectionCandidate>(
  models: T[],
  scoreFn: ScoreFunction<T>,
  options: SelectionOptions<T> = {},
): RankedModel<T>[] {
  const excluded = new Set(options.excludeModels ?? []);
  const tieBreaker = options.tieBreaker ?? defaultTieBreaker;

  return models
    .filter((model) => !excluded.has(model.model))
    .map((candidate) => ({
      candidate,
      score: scoreFn(candidate),
    }))
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return tieBreaker(left.candidate, right.candidate);
    });
}

export function pickBestModel<T extends ModelSelectionCandidate>(
  models: T[],
  scoreFn: ScoreFunction<T>,
  options: SelectionOptions<T> = {},
): T | null {
  return rankModels(models, scoreFn, options)[0]?.candidate ?? null;
}

export function pickPrimaryAndSupport<T extends ModelSelectionCandidate>(
  models: T[],
  scoring: RoleScoring<T>,
  preferredPrimaryModel?: string,
): { primary: T | null; support: T | null } {
  if (models.length === 0) return { primary: null, support: null };

  const preferredPrimary = preferredPrimaryModel
    ? models.find((candidate) => candidate.model === preferredPrimaryModel)
    : undefined;
  const primary = preferredPrimary ?? pickBestModel(models, scoring.primary);

  if (!primary) return { primary: null, support: null };

  const support =
    pickBestModel(models, scoring.support, {
      excludeModels: [primary.model],
    }) ?? pickBestModel(models, scoring.support);

  return { primary, support };
}
