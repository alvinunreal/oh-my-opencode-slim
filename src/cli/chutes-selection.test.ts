/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import {
  pickBestCodingChutesModel,
  pickSupportChutesModel,
} from './chutes-selection';
import type { OpenCodeFreeModel } from './types';

function model(input: Partial<OpenCodeFreeModel>): OpenCodeFreeModel {
  return {
    providerID: 'chutes',
    model: input.model ?? 'chutes/unknown',
    name: input.name ?? input.model ?? 'unknown',
    status: input.status ?? 'active',
    contextLimit: input.contextLimit ?? 128000,
    outputLimit: input.outputLimit ?? 16000,
    reasoning: input.reasoning ?? false,
    toolcall: input.toolcall ?? false,
    attachment: input.attachment ?? false,
    dailyRequestLimit: input.dailyRequestLimit,
  };
}

describe('chutes-selection', () => {
  test('prefers reasoning model for primary role', () => {
    const models = [
      model({
        model: 'chutes/minimax-m2.1',
        reasoning: true,
        toolcall: true,
        contextLimit: 512000,
        outputLimit: 64000,
        dailyRequestLimit: 300,
      }),
      model({
        model: 'chutes/gpt-oss-20b-mini',
        reasoning: false,
        toolcall: true,
        dailyRequestLimit: 5000,
      }),
    ];

    expect(pickBestCodingChutesModel(models)?.model).toBe(
      'chutes/minimax-m2.1',
    );
  });

  test('prefers high-cap fast model for support role', () => {
    const models = [
      model({
        model: 'chutes/kimi-k2.5',
        reasoning: true,
        toolcall: true,
        dailyRequestLimit: 300,
      }),
      model({
        model: 'chutes/qwen3-coder-30b-mini',
        reasoning: true,
        toolcall: true,
        dailyRequestLimit: 5000,
      }),
    ];

    expect(pickSupportChutesModel(models, 'chutes/kimi-k2.5')?.model).toBe(
      'chutes/qwen3-coder-30b-mini',
    );
  });
});
