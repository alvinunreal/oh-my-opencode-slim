import { describe, expect, test } from 'bun:test';
import type { ModelEntry } from '../config/schema';

/**
 * Test the model array resolution logic that runs in the config hook.
 * This logic determines which model to use from an effective model array.
 *
 * The resolver always picks the first model in the effective array,
 * regardless of provider configuration. This is correct because:
 * - Not all providers require entries in opencodeConfig.provider - some are
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
