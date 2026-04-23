import { describe, expect, test } from "bun:test";
import {
  CouncilConfigSchema,
  type CouncillorConfig,
  CouncillorConfigSchema,
  CouncilPresetSchema,
} from "./council-schema";

describe("CouncillorConfigSchema", () => {
  test("validates config with model and optional variant", () => {
    const goodConfig: CouncillorConfig = {
      model: "openai/gpt-5.4-mini",
      variant: "low",
    };

    const result = CouncillorConfigSchema.safeParse(goodConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(goodConfig);
    }
  });

  test("accepts deprecated master fields and reports them", () => {
    const config = {
      master: { model: "anthropic/claude-opus-4-6" },
      master_timeout: 300000,
      master_fallback: ["openai/gpt-5.5"],
      presets: {
        default: {
          alpha: { model: "openai/gpt-5.4-mini" },
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);

    if (result.success) {
      // Deprecated fields are stripped but reported via _deprecated
      expect(result.data._deprecated).toEqual([
        "master",
        "master_timeout",
        "master_fallback",
      ]);
      // Core fields still work normally
      expect(result.data.timeout).toBe(180000);
      expect(Object.keys(result.data.presets.default)).toEqual(["alpha"]);
      // Legacy master.model is extracted for backward-compat fallback
      expect(result.data._legacyMasterModel).toBe("anthropic/claude-opus-4-6");
    }
  });

  test("no _deprecated when config has no deprecated fields", () => {
    const config = {
      presets: {
        default: {
          alpha: { model: "openai/gpt-5.4-mini" },
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data._deprecated).toBeUndefined();
      expect(result.data._legacyMasterModel).toBeUndefined();
    }
  });
});

test('preset with only legacy "master" key results in empty councillors', () => {
  const config = {
    presets: {
      "master-only": {
        master: { model: "anthropic/claude-opus-4-6" },
      },
    },
  };

  const result = CouncilConfigSchema.safeParse(config);
  expect(result.success).toBe(true);

  if (result.success) {
    const preset = result.data.presets["master-only"];
    expect(Object.keys(preset)).toEqual([]);
  }
});

test('unwraps legacy nested "councillors" key in preset', () => {
  const config = {
    presets: {
      default: {
        councillors: {
          alpha: { model: "openai/gpt-5.4-mini" },
          beta: { model: "openai/gpt-5.3-codex" },
        },
      },
    },
  };

  const result = CouncilConfigSchema.safeParse(config);
  expect(result.success).toBe(true);

  if (result.success) {
    const preset = result.data.presets.default;
    expect(Object.keys(preset)).toEqual(["alpha", "beta"]);
    expect(preset.alpha.model).toBe("openai/gpt-5.4-mini");
    expect(preset.beta.model).toBe("openai/gpt-5.3-codex");
  }
});

test('mixed legacy "councillors" and flat keys in same preset', () => {
  const config = {
    presets: {
      mixed: {
        councillors: {
          alpha: { model: "openai/gpt-5.4-mini" },
        },
        beta: { model: "google/gemini-3-pro" },
      },
    },
  };

  const result = CouncilConfigSchema.safeParse(config);
  expect(result.success).toBe(true);

  if (result.success) {
    const preset = result.data.presets.mixed;
    expect(Object.keys(preset).sort()).toEqual(["alpha", "beta"]);
  }
});

test("deprecated master with non-standard model ID still parses", () => {
  const config = {
    master: { model: "claude-opus-4-6" }, // no provider/ prefix
    master_timeout: "fast", // not a number
    master_fallback: "all", // not an array
    presets: {
      default: {
        alpha: { model: "openai/gpt-5.4-mini" },
      },
    },
  };

  const result = CouncilConfigSchema.safeParse(config);
  expect(result.success).toBe(true);

  if (result.success) {
    expect(result.data._deprecated).toEqual([
      "master",
      "master_timeout",
      "master_fallback",
    ]);
    // Even non-standard model IDs are extracted as-is for backward compat
    expect(result.data._legacyMasterModel).toBe("claude-opus-4-6");
  }
});

test("legacyMasterModel undefined when master.model is not a string", () => {
  const config = {
    master: { model: 42 }, // not a string
    presets: {
      default: {
        alpha: { model: "openai/gpt-5.4-mini" },
      },
    },
  };

  const result = CouncilConfigSchema.safeParse(config);
  expect(result.success).toBe(true);

  if (result.success) {
    expect(result.data._legacyMasterModel).toBeUndefined();
  }
});

test("legacyMasterModel undefined when master is not an object", () => {
  const config = {
    master: "oops", // not an object
    presets: {
      default: {
        alpha: { model: "openai/gpt-5.4-mini" },
      },
    },
  };

  const result = CouncilConfigSchema.safeParse(config);
  expect(result.success).toBe(true);

  if (result.success) {
    expect(result.data._legacyMasterModel).toBeUndefined();
  }
});

test("rejects empty model string", () => {
  const config = {
    model: "",
  };

  const result = CouncillorConfigSchema.safeParse(config);
  expect(result.success).toBe(false);
});

test("accepts optional prompt field", () => {
  const config: CouncillorConfig = {
    model: "openai/gpt-5.4-mini",
    prompt: "Focus on security implications and edge cases.",
  };

  const result = CouncillorConfigSchema.safeParse(config);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.prompt).toBe(
      "Focus on security implications and edge cases."
    );
  }
});

test("prompt is optional and defaults to undefined", () => {
  const config: CouncillorConfig = {
    model: "openai/gpt-5.4-mini",
  };

  const result = CouncillorConfigSchema.safeParse(config);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.prompt).toBeUndefined();
  }
});

describe("CouncilPresetSchema", () => {
  test("validates a named preset with multiple councillors", () => {
    const raw = {
      alpha: {
        model: "openai/gpt-5.4-mini",
      },
      beta: {
        model: "openai/gpt-5.3-codex",
        variant: "low",
      },
      gamma: {
        model: "google/gemini-3-pro",
      },
    };

    const result = CouncilPresetSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data)).toEqual(["alpha", "beta", "gamma"]);
    }
  });

  test("accepts preset with single councillor", () => {
    const raw = {
      solo: {
        model: "openai/gpt-5.4-mini",
      },
    };

    const result = CouncilPresetSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data)).toEqual(["solo"]);
    }
  });

  test("accepts empty preset (no councillors)", () => {
    const raw = {};

    const result = CouncilPresetSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({});
    }
  });
});

describe("CouncilConfigSchema", () => {
  test("validates complete config with defaults", () => {
    const config = {
      presets: {
        default: {
          alpha: { model: "openai/gpt-5.4-mini" },
          beta: { model: "openai/gpt-5.3-codex" },
          gamma: { model: "google/gemini-3-pro" },
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);

    if (result.success) {
      // Check defaults are filled in
      expect(result.data.timeout).toBe(180000);
      expect(result.data.default_preset).toBe("default");
    }
  });

  test("fills in defaults for optional fields", () => {
    const config = {
      presets: {
        custom: {
          alpha: { model: "openai/gpt-5.4-mini" },
        },
      },
      default_preset: "custom",
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.timeout).toBe(180000);
      expect(result.data.default_preset).toBe("custom");
    }
  });

  test("rejects missing presets", () => {
    const badConfig = {};

    const result = CouncilConfigSchema.safeParse(badConfig);
    expect(result.success).toBe(false);
  });

  test("rejects invalid timeout (negative)", () => {
    const badConfig = {
      presets: {
        default: {
          alpha: { model: "openai/gpt-5.4-mini" },
        },
      },
      timeout: -1000,
    };

    const result = CouncilConfigSchema.safeParse(badConfig);
    expect(result.success).toBe(false);
  });

  test("accepts zero timeout values (no timeout)", () => {
    const config = {
      presets: {
        default: {
          alpha: { model: "openai/gpt-5.4-mini" },
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

  test("rejects missing presets", () => {
    const badConfig = {
      master: {
        model: "anthropic/claude-opus-4-6",
      },
    };

    const result = CouncilConfigSchema.safeParse(badConfig);
    expect(result.success).toBe(false);
  });

  test("accepts multiple presets", () => {
    const config = {
      presets: {
        default: {
          alpha: { model: "openai/gpt-5.4-mini" },
          beta: { model: "openai/gpt-5.3-codex" },
        },
        fast: {
          quick: { model: "openai/gpt-5.4-mini", variant: "low" },
        },
        thorough: {
          detailed1: {
            model: "anthropic/claude-opus-4-6",
            prompt: "Provide detailed analysis with citations.",
          },
          detailed2: { model: "openai/gpt-5.5" },
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);

    if (result.success) {
      // Verify prompt is preserved (not silently stripped)
      const thoroughPreset = result.data.presets.thorough;
      expect(thoroughPreset.detailed1.prompt).toBe(
        "Provide detailed analysis with citations."
      );
      // Verify prompt is undefined when not set
      expect(thoroughPreset.detailed2.prompt).toBeUndefined();
    }
  });
});
