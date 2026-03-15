import { describe, expect, test } from 'bun:test';
import type { ModelEntry } from '../config/schema';

/**
 * Test the model array resolution logic that runs in the config hook.
 * This logic determines which model to use based on provider configuration.
 */

describe('model array resolution', () => {
  /**
   * Simulates the resolution logic from src/index.ts
   * Returns the resolved model entry or null if no resolution possible
   */
  function resolveModelFromArray(
    modelArray: Array<{ id: string; variant?: string }>,
    providerConfig: Record<string, unknown> | undefined,
  ): { model: string; variant?: string } | null {
    if (!modelArray || modelArray.length === 0) return null;

    const hasProviderConfig =
      providerConfig && Object.keys(providerConfig).length > 0;

    // Case 1: Provider config exists - try to match
    if (hasProviderConfig) {
      const configuredProviders = Object.keys(providerConfig);
      for (const modelEntry of modelArray) {
        const slashIdx = modelEntry.id.indexOf('/');
        if (slashIdx === -1) continue;
        const providerID = modelEntry.id.slice(0, slashIdx);
        if (configuredProviders.includes(providerID)) {
          return {
            model: modelEntry.id,
            variant: modelEntry.variant,
          };
        }
      }
    }

    // Case 2: No provider config or no match - use first model in array
    const firstModel = modelArray[0];
    return {
      model: firstModel.id,
      variant: firstModel.variant,
    };
  }

  test('uses first model when no provider config exists', () => {
    const modelArray: ModelEntry[] = [
      { id: 'opencode/big-pickle', variant: 'high' },
      { id: 'iflowcn/qwen3-235b-a22b-thinking-2507', variant: 'high' },
    ];
    const providerConfig = undefined;

    const result = resolveModelFromArray(modelArray, providerConfig);

    expect(result?.model).toBe('opencode/big-pickle');
    expect(result?.variant).toBe('high');
  });

  test('uses first model when provider config is empty', () => {
    const modelArray: ModelEntry[] = [
      { id: 'opencode/big-pickle', variant: 'high' },
      { id: 'iflowcn/qwen3-235b-a22b-thinking-2507', variant: 'high' },
    ];
    const providerConfig = {};

    const result = resolveModelFromArray(modelArray, providerConfig);

    expect(result?.model).toBe('opencode/big-pickle');
    expect(result?.variant).toBe('high');
  });

  test('uses matching provider model when configured', () => {
    const modelArray: ModelEntry[] = [
      { id: 'opencode/big-pickle', variant: 'high' },
      { id: 'anthropic/claude-3.5-sonnet', variant: 'medium' },
    ];
    const providerConfig = { anthropic: {} };

    const result = resolveModelFromArray(modelArray, providerConfig);

    expect(result?.model).toBe('anthropic/claude-3.5-sonnet');
    expect(result?.variant).toBe('medium');
  });

  test('falls back to first model when providers configured but none match', () => {
    const modelArray: ModelEntry[] = [
      { id: 'opencode/big-pickle', variant: 'high' },
      { id: 'iflowcn/qwen3-235b-a22b-thinking-2507' },
    ];
    // User has anthropic configured, but model array uses opencode/iflowcn
    const providerConfig = { anthropic: {}, openai: {} };

    const result = resolveModelFromArray(modelArray, providerConfig);

    // Should use first model, not UI default
    expect(result?.model).toBe('opencode/big-pickle');
    expect(result?.variant).toBe('high');
  });

  test('skips models without provider prefix', () => {
    const modelArray: ModelEntry[] = [
      { id: 'invalid-model-no-prefix' },
      { id: 'opencode/big-pickle' },
    ];
    const providerConfig = { opencode: {} };

    const result = resolveModelFromArray(modelArray, providerConfig);

    expect(result?.model).toBe('opencode/big-pickle');
  });

  test('returns null for empty model array', () => {
    const modelArray: ModelEntry[] = [];
    const providerConfig = { opencode: {} };

    const result = resolveModelFromArray(modelArray, providerConfig);

    expect(result).toBeNull();
  });
});
