import { describe, expect, test } from 'bun:test';
import {
  CouncilConfigSchema,
  type CouncillorConfig,
  CouncillorConfigSchema,
  CouncilPresetSchema,
} from './council-schema';

describe('CouncillorConfigSchema', () => {
  test('validates config with model and optional variant', () => {
    const result = CouncillorConfigSchema.safeParse({
      model: 'openai/gpt-5.6-luna',
      variant: 'low',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe('openai/gpt-5.6-luna');
      expect(result.data.variant).toBe('low');
      // A single-model config normalizes to a one-entry chain.
      expect(result.data.models).toEqual([
        { id: 'openai/gpt-5.6-luna', variant: 'low' },
      ]);
    }
  });

  test('accepts an ordered model fallback chain', () => {
    const result = CouncillorConfigSchema.safeParse({
      model: [
        'openai/gpt-5.6-luna',
        { id: 'google/gemini-3-pro', variant: 'high' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Primary model stays on `model` for backward compatibility.
      expect(result.data.model).toBe('openai/gpt-5.6-luna');
      expect(result.data.models).toEqual([
        { id: 'openai/gpt-5.6-luna', variant: undefined },
        { id: 'google/gemini-3-pro', variant: 'high' },
      ]);
    }
  });
});

test('master preset key is now treated as a councillor name', () => {
  const result = CouncilPresetSchema.safeParse({
    master: { model: 'anthropic/claude-opus-4-6' },
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(Object.keys(result.data)).toEqual(['master']);
    expect(result.data.master.model).toBe('anthropic/claude-opus-4-6');
  }
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
    model: 'openai/gpt-5.6-luna',
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
    model: 'openai/gpt-5.6-luna',
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
        model: 'openai/gpt-5.6-luna',
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
        model: 'openai/gpt-5.6-luna',
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
          alpha: { model: 'openai/gpt-5.6-luna' },
          beta: { model: 'openai/gpt-5.3-codex' },
          gamma: { model: 'google/gemini-3-pro' },
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);

    if (result.success) {
      // Check defaults are filled in
      expect(result.data.timeout).toBe(180000);
      expect(result.data.default_preset).toBe('default');
    }
  });

  test('fills in defaults for optional fields', () => {
    const config = {
      presets: {
        custom: {
          alpha: { model: 'openai/gpt-5.6-luna' },
        },
      },
      default_preset: 'custom',
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.timeout).toBe(180000);
      expect(result.data.default_preset).toBe('custom');
    }
  });

  test('rejects missing presets', () => {
    const badConfig = {};

    const result = CouncilConfigSchema.safeParse(badConfig);
    expect(result.success).toBe(false);
  });

  test('rejects invalid timeout (negative)', () => {
    const badConfig = {
      presets: {
        default: {
          alpha: { model: 'openai/gpt-5.6-luna' },
        },
      },
      timeout: -1000,
    };

    const result = CouncilConfigSchema.safeParse(badConfig);
    expect(result.success).toBe(false);
  });

  test('accepts zero timeout values (no timeout)', () => {
    const config = {
      presets: {
        default: {
          alpha: { model: 'openai/gpt-5.6-luna' },
        },
      },
      timeout: 0,
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.timeout).toBe(0);
    }
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
          alpha: { model: 'openai/gpt-5.6-luna' },
          beta: { model: 'openai/gpt-5.3-codex' },
        },
        fast: {
          quick: { model: 'openai/gpt-5.6-luna', variant: 'low' },
        },
        thorough: {
          detailed1: {
            model: 'anthropic/claude-opus-4-6',
            prompt: 'Provide detailed analysis with citations.',
          },
          detailed2: { model: 'openai/gpt-5.6' },
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
