import { describe, expect, test } from 'bun:test';
import {
  CouncilConfigSchema,
  type CouncillorConfig,
  CouncillorConfigSchema,
  type CouncilMasterConfig,
  CouncilMasterConfigSchema,
  CouncilPresetSchema,
  PresetMasterOverrideSchema,
} from './council-schema';

describe('CouncillorConfigSchema', () => {
  test('validates config with model and optional variant', () => {
    const goodConfig: CouncillorConfig = {
      model: 'openai/gpt-5.4-mini',
      variant: 'low',
    };

    const result = CouncillorConfigSchema.safeParse(goodConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(goodConfig);
    }
  });

  test('validates config with only required model field', () => {
    const minimalConfig: CouncillorConfig = {
      model: 'openai/gpt-5.4-mini',
    };

    const result = CouncillorConfigSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
  });

  test('rejects missing model', () => {
    const badConfig = {
      variant: 'low',
    };

    const result = CouncillorConfigSchema.safeParse(badConfig);
    expect(result.success).toBe(false);
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
      model: 'openai/gpt-5.4-mini',
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
      model: 'openai/gpt-5.4-mini',
    };

    const result = CouncillorConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prompt).toBeUndefined();
    }
  });
});

describe('CouncilMasterConfigSchema', () => {
  test('validates good config', () => {
    const goodConfig: CouncilMasterConfig = {
      model: 'anthropic/claude-opus-4-6',
      variant: 'high',
    };

    const result = CouncilMasterConfigSchema.safeParse(goodConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(goodConfig);
    }
  });

  test('validates config with only required model field', () => {
    const minimalConfig: CouncilMasterConfig = {
      model: 'anthropic/claude-opus-4-6',
    };

    const result = CouncilMasterConfigSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
  });

  test('rejects missing model', () => {
    const badConfig = {
      variant: 'high',
    };

    const result = CouncilMasterConfigSchema.safeParse(badConfig);
    expect(result.success).toBe(false);
  });

  test('accepts optional prompt field', () => {
    const config: CouncilMasterConfig = {
      model: 'anthropic/claude-opus-4-6',
      prompt: 'Prioritize correctness over creativity. When in doubt, flag it.',
    };

    const result = CouncilMasterConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prompt).toBe(
        'Prioritize correctness over creativity. When in doubt, flag it.',
      );
    }
  });

  test('prompt defaults to undefined when not provided', () => {
    const config: CouncilMasterConfig = {
      model: 'anthropic/claude-opus-4-6',
    };

    const result = CouncilMasterConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prompt).toBeUndefined();
    }
  });
});

describe('CouncilPresetSchema', () => {
  test('validates a named preset with multiple councillors', () => {
    const raw = {
      alpha: {
        model: 'openai/gpt-5.4-mini',
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
      expect(Object.keys(result.data.councillors)).toEqual([
        'alpha',
        'beta',
        'gamma',
      ]);
    }
  });

  test('accepts preset with single councillor', () => {
    const raw = {
      solo: {
        model: 'openai/gpt-5.4-mini',
      },
    };

    const result = CouncilPresetSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.councillors)).toEqual(['solo']);
    }
  });

  test('accepts empty preset (no councillors)', () => {
    const raw = {};

    const result = CouncilPresetSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.councillors).toEqual({});
    }
  });

  test('separates master key from councillors', () => {
    const raw = {
      master: { model: 'openai/gpt-5.4', prompt: 'Override prompt.' },
      alpha: { model: 'openai/gpt-5.4-mini' },
      beta: { model: 'google/gemini-3-pro' },
    };

    const result = CouncilPresetSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.councillors)).toEqual(['alpha', 'beta']);
      expect(result.data.master).toEqual({
        model: 'openai/gpt-5.4',
        prompt: 'Override prompt.',
      });
    }
  });

  test('preset without master key has no master override', () => {
    const raw = {
      alpha: { model: 'openai/gpt-5.4-mini' },
    };

    const result = CouncilPresetSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.councillors)).toEqual(['alpha']);
      expect(result.data.master).toBeUndefined();
    }
  });

  test('rejects invalid master override in preset', () => {
    const raw = {
      master: { model: 'invalid-no-slash' },
      alpha: { model: 'openai/gpt-5.4-mini' },
    };

    const result = CouncilPresetSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });
});

describe('CouncilConfigSchema', () => {
  test('validates complete config with defaults', () => {
    const config = {
      master: {
        model: 'anthropic/claude-opus-4-6',
      },
      presets: {
        default: {
          alpha: { model: 'openai/gpt-5.4-mini' },
          beta: { model: 'openai/gpt-5.3-codex' },
          gamma: { model: 'google/gemini-3-pro' },
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);

    if (result.success) {
      // Check defaults are filled in
      expect(result.data.master_timeout).toBe(300000);
      expect(result.data.councillors_timeout).toBe(180000);
      expect(result.data.default_preset).toBe('default');
    }
  });

  test('fills in defaults for optional fields', () => {
    const config = {
      master: {
        model: 'anthropic/claude-opus-4-6',
      },
      presets: {
        custom: {
          alpha: { model: 'openai/gpt-5.4-mini' },
        },
      },
      default_preset: 'custom',
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.master_timeout).toBe(300000);
      expect(result.data.councillors_timeout).toBe(180000);
      expect(result.data.default_preset).toBe('custom');
    }
  });

  test('rejects missing master config', () => {
    const badConfig = {
      presets: {
        default: {
          alpha: { model: 'openai/gpt-5.4-mini' },
        },
      },
    };

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

  test('rejects invalid master_timeout (negative)', () => {
    const badConfig = {
      master: {
        model: 'anthropic/claude-opus-4-6',
      },
      presets: {
        default: {
          alpha: { model: 'openai/gpt-5.4-mini' },
        },
      },
      master_timeout: -1000,
    };

    const result = CouncilConfigSchema.safeParse(badConfig);
    expect(result.success).toBe(false);
  });

  test('rejects invalid councillors_timeout (negative)', () => {
    const badConfig = {
      master: {
        model: 'anthropic/claude-opus-4-6',
      },
      presets: {
        default: {
          alpha: { model: 'openai/gpt-5.4-mini' },
        },
      },
      councillors_timeout: -1000,
    };

    const result = CouncilConfigSchema.safeParse(badConfig);
    expect(result.success).toBe(false);
  });

  test('accepts zero timeout values (no timeout)', () => {
    const config = {
      master: {
        model: 'anthropic/claude-opus-4-6',
      },
      presets: {
        default: {
          alpha: { model: 'openai/gpt-5.4-mini' },
        },
      },
      master_timeout: 0,
      councillors_timeout: 0,
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.master_timeout).toBe(0);
      expect(result.data.councillors_timeout).toBe(0);
    }
  });

  test('accepts multiple presets', () => {
    const config = {
      master: {
        model: 'anthropic/claude-opus-4-6',
      },
      presets: {
        default: {
          alpha: { model: 'openai/gpt-5.4-mini' },
          beta: { model: 'openai/gpt-5.3-codex' },
        },
        fast: {
          quick: { model: 'openai/gpt-5.4-mini', variant: 'low' },
        },
        thorough: {
          detailed1: {
            model: 'anthropic/claude-opus-4-6',
            prompt: 'Provide detailed analysis with citations.',
          },
          detailed2: { model: 'openai/gpt-5.4' },
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);

    if (result.success) {
      // Verify prompt is preserved (not silently stripped)
      const thoroughPreset = result.data.presets.thorough;
      expect(thoroughPreset.councillors.detailed1.prompt).toBe(
        'Provide detailed analysis with citations.',
      );
      // Verify prompt is undefined when not set
      expect(thoroughPreset.councillors.detailed2.prompt).toBeUndefined();
    }
  });

  test('accepts master with prompt', () => {
    const config = {
      master: {
        model: 'anthropic/claude-opus-4-6',
        prompt: 'Prioritize correctness over creativity.',
      },
      presets: {
        default: {
          alpha: { model: 'openai/gpt-5.4-mini' },
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.master.prompt).toBe(
        'Prioritize correctness over creativity.',
      );
    }
  });
});

describe('PresetMasterOverrideSchema', () => {
  test('accepts empty override (all fields optional)', () => {
    const result = PresetMasterOverrideSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test('accepts full override with model, variant, and prompt', () => {
    const override = {
      model: 'openai/gpt-5.4',
      variant: 'high',
      prompt: 'Be extra thorough.',
    };
    const result = PresetMasterOverrideSchema.safeParse(override);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe('openai/gpt-5.4');
      expect(result.data.variant).toBe('high');
      expect(result.data.prompt).toBe('Be extra thorough.');
    }
  });

  test('accepts partial override with only model', () => {
    const result = PresetMasterOverrideSchema.safeParse({
      model: 'anthropic/claude-sonnet-4-6',
    });
    expect(result.success).toBe(true);
  });

  test('accepts partial override with only prompt', () => {
    const result = PresetMasterOverrideSchema.safeParse({
      prompt: 'Focus on security.',
    });
    expect(result.success).toBe(true);
  });

  test('rejects invalid model format in override', () => {
    const result = PresetMasterOverrideSchema.safeParse({
      model: 'invalid-no-slash',
    });
    expect(result.success).toBe(false);
  });
});
