import { describe, expect, test } from 'bun:test';
import type { ModelEntry } from '../config/schema';

/**
 * Test the model array resolution logic that runs in the config hook.
 * This logic determines which model to use from an effective model array.
 *
 * The resolver always picks the first model in the effective array,
 * regardless of provider configuration. This is correct because:
 * - Not all providers require entries in opencodeConfig.provider — some are
 *   loaded automatically by opencode (e.g. github-copilot, openrouter).
 * - We cannot distinguish "auto-loaded provider" from "provider not configured"
 *   without calling the API, which isn't available at config-hook time.
 * - Runtime failover (rate-limit handling) is handled separately by
 *   ForegroundFallbackManager.
 */

describe('model array resolution', () => {
  /**
   * Simulates the resolution logic from src/index.ts.
   * Always returns the first model in the array.
   */
  function resolveModelFromArray(
    modelArray: Array<{ id: string; variant?: string }>,
  ): { model: string; variant?: string } | null {
    if (!modelArray || modelArray.length === 0) return null;

    const chosen = modelArray[0];
    return {
      model: chosen.id,
      variant: chosen.variant,
    };
  }

  test('uses first model when no provider config exists', () => {
    const modelArray: ModelEntry[] = [
      { id: 'opencode/big-pickle', variant: 'high' },
      { id: 'iflowcn/qwen3-235b-a22b-thinking-2507', variant: 'high' },
    ];

    const result = resolveModelFromArray(modelArray);

    expect(result?.model).toBe('opencode/big-pickle');
    expect(result?.variant).toBe('high');
  });

  test('uses first model even when other providers are configured', () => {
    const modelArray: ModelEntry[] = [
      { id: 'github-copilot/claude-opus-4.6', variant: 'high' },
      { id: 'zai-coding-plan/glm-5' },
    ];

    const result = resolveModelFromArray(modelArray);

    // Auto-loaded provider should not be skipped in favor of configured one
    expect(result?.model).toBe('github-copilot/claude-opus-4.6');
    expect(result?.variant).toBe('high');
  });

  test('returns null for empty model array', () => {
    const modelArray: ModelEntry[] = [];

    const result = resolveModelFromArray(modelArray);

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
    fallbackEnabled?: boolean;
  }): string | null {
    const {
      modelArray,
      currentModel,
      chainModels,
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

    // Resolution: always use first model in effective array
    return effectiveArray[0].id;
  }

  test('primary model wins regardless of provider config', () => {
    const result = resolveWithChains({
      currentModel: 'anthropic/claude-opus-4-5',
      chainModels: ['openai/gpt-4o'],
    });
    expect(result).toBe('anthropic/claude-opus-4-5');
  });

  test('chain is ignored when fallback disabled', () => {
    const result = resolveWithChains({
      currentModel: 'anthropic/claude-opus-4-5',
      chainModels: ['openai/gpt-4o'],
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
    });
    // First entry in _modelArray wins; chain only used for runtime failover
    expect(result).toBe('anthropic/claude-opus-4-5');
  });

  test('duplicate model ids across array and chain are deduplicated', () => {
    const result = resolveWithChains({
      modelArray: [
        { id: 'anthropic/claude-opus-4-5' },
        { id: 'openai/gpt-4o' },
      ],
      chainModels: ['openai/gpt-4o', 'google/gemini-pro'],
    });
    expect(result).toBe('anthropic/claude-opus-4-5');
  });

  test('no currentModel and no _modelArray with chain still resolves', () => {
    const result = resolveWithChains({
      chainModels: ['openai/gpt-4o', 'anthropic/claude-sonnet-4-5'],
    });
    expect(result).toBe('openai/gpt-4o');
  });

  test('built-in provider not skipped when other providers are configured', () => {
    // Regression test: github-copilot is auto-loaded by opencode and doesn't
    // need an entry in opencodeConfig.provider. The resolver must not skip
    // it in favor of a configured provider later in the chain.
    const result = resolveWithChains({
      currentModel: 'github-copilot/claude-opus-4.6',
      chainModels: [
        'github-copilot/gemini-3.1-pro-preview',
        'zai-coding-plan/glm-5',
      ],
    });
    expect(result).toBe('github-copilot/claude-opus-4.6');
  });
});
