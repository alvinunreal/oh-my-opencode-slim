/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import {
  type ModelSelectionCandidate,
  pickBestModel,
  pickPrimaryAndSupport,
  rankModels,
} from './model-selection';

interface Candidate extends ModelSelectionCandidate {
  speed: number;
  quality: number;
}

describe('model-selection', () => {
  test('pickBestModel returns null for empty list', () => {
    const best = pickBestModel([], () => 1);
    expect(best).toBeNull();
  });

  test('rankModels applies deterministic tie-break by model id', () => {
    const models: Candidate[] = [
      { model: 'provider/zeta', speed: 1, quality: 1 },
      { model: 'provider/alpha', speed: 1, quality: 1 },
    ];

    const ranked = rankModels(models, () => 10);
    expect(ranked[0]?.candidate.model).toBe('provider/alpha');
    expect(ranked[1]?.candidate.model).toBe('provider/zeta');
  });

  test('pickPrimaryAndSupport avoids duplicate support when possible', () => {
    const models: Candidate[] = [
      { model: 'provider/main', speed: 20, quality: 90 },
      { model: 'provider/helper', speed: 95, quality: 60 },
    ];

    const picked = pickPrimaryAndSupport(
      models,
      {
        primary: (model) => model.quality,
        support: (model) => model.speed,
      },
      'provider/main',
    );

    expect(picked.primary?.model).toBe('provider/main');
    expect(picked.support?.model).toBe('provider/helper');
  });

  test('pickPrimaryAndSupport falls back to same model when only one exists', () => {
    const models: Candidate[] = [
      { model: 'provider/solo', speed: 10, quality: 10 },
    ];

    const picked = pickPrimaryAndSupport(models, {
      primary: (model) => model.quality,
      support: (model) => model.speed,
    });

    expect(picked.primary?.model).toBe('provider/solo');
    expect(picked.support?.model).toBe('provider/solo');
  });
});
