import { describe, expect, test } from 'bun:test';
import {
  CouncilConfigSchema,
  type CouncillorConfig,
  CouncillorConfigSchema,
  type CouncilMasterConfig,
  CouncilMasterConfigSchema,
  type CouncilPreset,
  CouncilPresetSchema,
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
});

describe('CouncilPresetSchema', () => {
  test('validates a named preset with multiple councillors', () => {
    const preset: CouncilPreset = {
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

    const result = CouncilPresetSchema.safeParse(preset);
    expect(result.success).toBe(true);
  });

  test('accepts preset with single councillor', () => {
    const preset: CouncilPreset = {
      solo: {
        model: 'openai/gpt-5.4-mini',
      },
    };

    const result = CouncilPresetSchema.safeParse(preset);
    expect(result.success).toBe(true);
  });

  test('accepts empty preset (no councillors)', () => {
    const preset: CouncilPreset = {};

    const result = CouncilPresetSchema.safeParse(preset);
    expect(result.success).toBe(true);
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
  });
});
