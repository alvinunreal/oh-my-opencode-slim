import { describe, expect, test } from "bun:test";
import type { PluginConfig } from "./schema";
import { getAgentOverride, getCustomAgentNames } from "./utils";

describe("getAgentOverride", () => {
  test("reads override by explicit custom agent key", () => {
    const config = {
      agents: {
        "custom-reviewer": { model: "openai/gpt-5.4-mini" },
      },
    } as PluginConfig;

    const override = getAgentOverride(config, "custom-reviewer");

    expect(override).toBeDefined();
    expect(override?.model).toBe("openai/gpt-5.4-mini");
  });

  test("reads override from legacy alias when mapped", () => {
    const config = {
      agents: {
        explore: { model: "openai/gpt-5.4-mini" },
      },
    } as PluginConfig;

    const override = getAgentOverride(config, "explorer");

    expect(override).toBeDefined();
    expect(override?.model).toBe("openai/gpt-5.4-mini");
  });

  test("returns undefined when no override exists", () => {
    const config = {
      agents: {
        explorer: { model: "openai/gpt-5.4-mini" },
      },
    } as PluginConfig;

    expect(getAgentOverride(config, "no-such-agent")).toBeUndefined();
  });
});

describe("getCustomAgentNames", () => {
  test("returns only unknown non-alias agent keys", () => {
    const config = {
      agents: {
        explorer: { model: "openai/gpt-5.4-mini" },
        explore: { model: "openai/gpt-5.4-mini" },
        janitor: { model: "openai/gpt-5.4-mini" },
      },
    } as PluginConfig;

    expect(getCustomAgentNames(config)).toEqual(["janitor"]);
  });

  test("returns an empty list when no custom agents exist", () => {
    const config = {
      agents: {
        explorer: { model: "openai/gpt-5.4-mini" },
        oracle: { model: "openai/gpt-5.5" },
      },
    } as PluginConfig;

    expect(getCustomAgentNames(config)).toEqual([]);
  });
});
