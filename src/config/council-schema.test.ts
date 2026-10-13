import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  CouncilConfigSchema,
  type CouncillorConfig,
  CouncillorConfigSchema,
  CouncilPresetSchema,
} from './council-schema';

describe('CouncillorConfigSchema', () => {
  test('accepts and preserves a scalar model ID with spaces', () => {
    const result = CouncillorConfigSchema.safeParse({
      model: 'of/MiniMax M3',
      variant: 'low',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe('of/MiniMax M3');
      expect(result.data.variant).toBe('low');
      // A single-model config normalizes to a one-entry chain.
      expect(result.data.models).toEqual([
        { id: 'of/MiniMax M3', variant: 'low' },
      ]);
    }
  });

  test('preserves ordered mixed fallback entries with spaced model IDs', () => {
    const result = CouncillorConfigSchema.safeParse({
      model: [
        'of/Kimi K2.6',
        {
          id: 'opencode-omniroute-live/of/Qwen3.8 27b',
          variant: 'high',
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Primary model stays on `model` for backward compatibility.
      expect(result.data.model).toBe('of/Kimi K2.6');
      expect(result.data.models).toEqual([
        { id: 'of/Kimi K2.6', variant: undefined },
        {
          id: 'opencode-omniroute-live/of/Qwen3.8 27b',
          variant: 'high',
        },
      ]);
    }
  });
});

test('preset with legacy "master" key is rejected', () => {
  const config = {
    presets: {
      'master-only': {
        master: { model: 'anthropic/claude-opus-4-6' },
      },
    },
  };

  const result = CouncilConfigSchema.safeParse(config);
  expect(result.success).toBe(false);
});

test('published schema rejects the legacy "master" preset key (propertyNames)', () => {
  // Greptile P2: the rejection must be visible to editors, not just the
  // loader — the key-level regex renders as propertyNames.pattern.
  const generated = z.toJSONSchema(CouncilPresetSchema, { io: 'input' }) as {
    propertyNames: { pattern?: string };
  };
  expect(generated.propertyNames.pattern).toBe('^(?!master$)');
});

test('rejects empty model string', () => {
  const config = {
    model: '',
  };

  const result = CouncillorConfigSchema.safeParse(config);
  expect(result.success).toBe(false);
});

test('accepts optional prompt field', () => {
  const config: CouncillorConfig = {
    model: 'openai/gpt-6-luna',
    prompt: 'Focus on security implications and edge cases.',
  };

  const result = CouncillorConfigSchema.safeParse(config);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.prompt).toBe(
      'Focus on security implications and edge cases.',
    );
  }
});

test('prompt is optional and defaults to undefined', () => {
  const config: CouncillorConfig = {
    model: 'openai/gpt-6-luna',
  };

  const result = CouncillorConfigSchema.safeParse(config);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.prompt).toBeUndefined();
  }
});

describe('CouncilPresetSchema', () => {
  test('validates a named preset with multiple councillors', () => {
    const raw = {
      alpha: {
        model: 'openai/gpt-6-luna',
      },
      beta: {
        model: 'openai/gpt-5.3-codex',
        variant: 'low',
      },
      gamma: {
        model: 'google/gemini-3-pro',
      },
    };

    const result = CouncilPresetSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data)).toEqual(['alpha', 'beta', 'gamma']);
    }
  });

  test('accepts preset with single councillor', () => {
    const raw = {
      solo: {
        model: 'openai/gpt-6-luna',
      },
    };

    const result = CouncilPresetSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data)).toEqual(['solo']);
    }
  });

  test('accepts empty preset (no councillors)', () => {
    const raw = {};

    const result = CouncilPresetSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({});
    }
  });
});

describe('CouncilConfigSchema', () => {
  test('validates complete config with defaults', () => {
    const config = {
      presets: {
        default: {
          alpha: { model: 'openai/gpt-6-luna' },
          beta: { model: 'openai/gpt-5.3-codex' },
          gamma: { model: 'google/gemini-3-pro' },
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.default_preset).toBe('default');
    }
  });

  test('fills in defaults for optional fields', () => {
    const config = {
      presets: {
        custom: {
          alpha: { model: 'openai/gpt-6-luna' },
        },
      },
      default_preset: 'custom',
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.default_preset).toBe('custom');
    }
  });

  test('rejects missing presets', () => {
    const badConfig = {};

    const result = CouncilConfigSchema.safeParse(badConfig);
    expect(result.success).toBe(false);
  });

  test('rejects missing presets', () => {
    const badConfig = {
      master: {
        model: 'anthropic/claude-opus-4-6',
      },
    };

    const result = CouncilConfigSchema.safeParse(badConfig);
    expect(result.success).toBe(false);
  });

  test('accepts multiple presets', () => {
    const config = {
      presets: {
        default: {
          alpha: { model: 'openai/gpt-6-luna' },
          beta: { model: 'openai/gpt-5.3-codex' },
        },
        fast: {
          quick: { model: 'openai/gpt-6-luna', variant: 'low' },
        },
        thorough: {
          detailed1: {
            model: 'anthropic/claude-opus-4-6',
            prompt: 'Provide detailed analysis with citations.',
          },
          detailed2: { model: 'openai/gpt-6' },
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);

    if (result.success) {
      // Verify prompt is preserved (not silently stripped)
      const thoroughPreset = result.data.presets.thorough;
      expect(thoroughPreset.detailed1.prompt).toBe(
        'Provide detailed analysis with citations.',
      );
      // Verify prompt is undefined when not set
      expect(thoroughPreset.detailed2.prompt).toBeUndefined();
    }
  });
});

test('rejects removed council.master* keys', () => {
  for (const key of ['master', 'master_timeout', 'master_fallback']) {
    const result = CouncilConfigSchema.safeParse({
      presets: {},
      [key]: {},
    });
    expect(result.success).toBe(false);
  }
});
