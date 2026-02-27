import { describe, expect, test } from 'bun:test';
import {
  normalizeModelPreferences,
  resolvePreferredModelForAgent,
} from './model-preferences';

describe('model preferences', () => {
  test('normalizes and validates per-agent model lists', () => {
    const normalized = normalizeModelPreferences({
      oracle: [
        'openai/gpt-5.1-codex-mini',
        'invalid',
        'openai/gpt-5.1-codex-mini',
      ],
      fixer: ['nanogpt/qwen/qwen3-coder'],
      unknown: ['openai/gpt-5.1-codex-mini'],
    });

    expect(normalized).toEqual({
      oracle: ['openai/gpt-5.1-codex-mini'],
      fixer: ['nanogpt/qwen/qwen3-coder'],
    });
  });

  test('resolves first matching preferred model for agent', () => {
    const selected = resolvePreferredModelForAgent({
      agent: 'oracle',
      preferences: {
        oracle: ['openai/gpt-5.3-codex', 'openai/gpt-5.1-codex-mini'],
      },
      candidates: ['openai/gpt-5.1-codex-mini', 'nanogpt/qwen/qwen3-coder'],
    });

    expect(selected).toBe('openai/gpt-5.1-codex-mini');
  });
});
