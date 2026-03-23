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

/**
 * Tests for the fallback.chains merging logic that runs in the config hook.
 * Mirrors the effectiveArrays construction in src/index.ts.
 */
describe('fallback.chains merging for foreground agents', () => {
  /**
   * Simulates the effectiveArrays construction + resolution from src/index.ts.
   * Returns the resolved model string or null.
   */
  function resolveWithChains(opts: {
    modelArray?: Array<{ id: string; variant?: string }>;
    currentModel?: string;
    chainModels?: string[];
    providerConfig?: Record<string, unknown>;
    fallbackEnabled?: boolean;
  }): string | null {
    const {
      modelArray,
      currentModel,
      chainModels,
      providerConfig,
      fallbackEnabled = true,
    } = opts;

    // Build effectiveArrays (mirrors index.ts logic)
    const effectiveArray: Array<{ id: string; variant?: string }> = modelArray
      ? [...modelArray]
      : [];

    if (fallbackEnabled && chainModels && chainModels.length > 0) {
      if (effectiveArray.length === 0 && currentModel) {
        effectiveArray.push({ id: currentModel });
      }
      const seen = new Set(effectiveArray.map((m) => m.id));
      for (const chainModel of chainModels) {
        if (!seen.has(chainModel)) {
          seen.add(chainModel);
          effectiveArray.push({ id: chainModel });
        }
      }
    }

    if (effectiveArray.length === 0) return null;

    const hasProviderConfig =
      providerConfig && Object.keys(providerConfig).length > 0;

    if (hasProviderConfig) {
      const configuredProviders = Object.keys(providerConfig);
      for (const modelEntry of effectiveArray) {
        const slashIdx = modelEntry.id.indexOf('/');
        if (slashIdx === -1) continue;
        const providerID = modelEntry.id.slice(0, slashIdx);
        if (configuredProviders.includes(providerID)) {
          return modelEntry.id;
        }
      }
    }

    return effectiveArray[0].id;
  }

  test('fallback.chains used when agent has a string model and primary provider is not configured', () => {
    const result = resolveWithChains({
      currentModel: 'anthropic/claude-opus-4-5',
      chainModels: ['openai/gpt-4o', 'google/gemini-pro'],
      providerConfig: { openai: {} }, // only openai configured
    });
    expect(result).toBe('openai/gpt-4o');
  });

  test('primary model wins when its provider IS configured', () => {
    const result = resolveWithChains({
      currentModel: 'anthropic/claude-opus-4-5',
      chainModels: ['openai/gpt-4o'],
      providerConfig: { anthropic: {}, openai: {} },
    });
    expect(result).toBe('anthropic/claude-opus-4-5');
  });

  test('falls through full chain to find a configured provider', () => {
    const result = resolveWithChains({
      currentModel: 'anthropic/claude-opus-4-5',
      chainModels: ['openai/gpt-4o', 'google/gemini-2.5-pro'],
      providerConfig: { google: {} }, // only google configured
    });
    expect(result).toBe('google/gemini-2.5-pro');
  });

  test('falls back to primary (first) when no chain provider is configured', () => {
    const result = resolveWithChains({
      currentModel: 'anthropic/claude-opus-4-5',
      chainModels: ['openai/gpt-4o'],
      providerConfig: {}, // nothing configured
    });
    expect(result).toBe('anthropic/claude-opus-4-5');
  });

  test('chain is ignored when fallback disabled', () => {
    const result = resolveWithChains({
      currentModel: 'anthropic/claude-opus-4-5',
      chainModels: ['openai/gpt-4o'],
      providerConfig: { openai: {} },
      fallbackEnabled: false,
    });
    // chain not applied; no effectiveArray entry → falls through to null (no _modelArray either)
    expect(result).toBeNull();
  });

  test('_modelArray entries take precedence and chain appends after', () => {
    const result = resolveWithChains({
      modelArray: [
        { id: 'anthropic/claude-opus-4-5' },
        { id: 'anthropic/claude-sonnet-4-5' },
      ],
      chainModels: ['openai/gpt-4o'],
      providerConfig: { openai: {} }, // only openai configured
    });
    // anthropic entries in array are skipped; openai/gpt-4o from chain is picked
    expect(result).toBe('openai/gpt-4o');
  });

  test('duplicate model ids across array and chain are deduplicated', () => {
    // openai/gpt-4o appears in both _modelArray and chains — should not duplicate
    const result = resolveWithChains({
      modelArray: [{ id: 'anthropic/claude-opus-4-5' }, { id: 'openai/gpt-4o' }],
      chainModels: ['openai/gpt-4o', 'google/gemini-pro'],
      providerConfig: { openai: {} },
    });
    expect(result).toBe('openai/gpt-4o');
  });

  test('no currentModel and no _modelArray with chain still resolves', () => {
    // Edge case: agent has no model set yet, chain provides candidates
    const result = resolveWithChains({
      chainModels: ['openai/gpt-4o', 'anthropic/claude-sonnet-4-5'],
      providerConfig: { anthropic: {} },
    });
    expect(result).toBe('anthropic/claude-sonnet-4-5');
  });
});
