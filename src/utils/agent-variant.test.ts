import { describe, expect, test } from "bun:test";
import {
  normalizeAgentName,
  resolveAgentVariant,
  applyAgentVariant,
} from "./agent-variant";
import type { PluginConfig } from "../config";

describe("normalizeAgentName", () => {
  test("returns name unchanged if no @ prefix", () => {
    expect(normalizeAgentName("oracle")).toBe("oracle");
  });

  test("strips @ prefix from agent name", () => {
    expect(normalizeAgentName("@oracle")).toBe("oracle");
  });

  test("trims whitespace", () => {
    expect(normalizeAgentName("  oracle  ")).toBe("oracle");
  });

  test("handles @ prefix with whitespace", () => {
    expect(normalizeAgentName("  @explore  ")).toBe("explore");
  });

  test("handles empty string", () => {
    expect(normalizeAgentName("")).toBe("");
  });
});

describe("resolveAgentVariant", () => {
  test("returns undefined when config is undefined", () => {
    expect(resolveAgentVariant(undefined, "oracle")).toBeUndefined();
  });

  test("returns undefined when agents is undefined", () => {
    const config = {} as PluginConfig;
    expect(resolveAgentVariant(config, "oracle")).toBeUndefined();
  });

  test("returns undefined when agent has no variant", () => {
    const config = {
      agents: {
        oracle: { model: "gpt-4" },
      },
    } as PluginConfig;
    expect(resolveAgentVariant(config, "oracle")).toBeUndefined();
  });

  test("returns variant when configured", () => {
    const config = {
      agents: {
        oracle: { variant: "high" },
      },
    } as PluginConfig;
    expect(resolveAgentVariant(config, "oracle")).toBe("high");
  });

  test("normalizes agent name with @ prefix", () => {
    const config = {
      agents: {
        oracle: { variant: "low" },
      },
    } as PluginConfig;
    expect(resolveAgentVariant(config, "@oracle")).toBe("low");
  });

  test("returns undefined for empty string variant", () => {
    const config = {
      agents: {
        oracle: { variant: "" },
      },
    } as PluginConfig;
    expect(resolveAgentVariant(config, "oracle")).toBeUndefined();
  });

  test("returns undefined for whitespace-only variant", () => {
    const config = {
      agents: {
        oracle: { variant: "   " },
      },
    } as PluginConfig;
    expect(resolveAgentVariant(config, "oracle")).toBeUndefined();
  });

  test("trims variant whitespace", () => {
    const config = {
      agents: {
        oracle: { variant: "  medium  " },
      },
    } as PluginConfig;
    expect(resolveAgentVariant(config, "oracle")).toBe("medium");
  });

  test("returns undefined for non-string variant", () => {
    const config = {
      agents: {
        oracle: { variant: 123 as unknown as string },
      },
    } as PluginConfig;
    expect(resolveAgentVariant(config, "oracle")).toBeUndefined();
  });
});

describe("applyAgentVariant", () => {
  test("returns body unchanged when variant is undefined", () => {
    const body = { agent: "oracle", parts: [] };
    const result = applyAgentVariant(undefined, body);
    expect(result).toEqual(body);
    expect(result).toBe(body); // Same reference
  });

  test("returns body unchanged when body already has variant", () => {
    const body = { agent: "oracle", variant: "medium", parts: [] };
    const result = applyAgentVariant("high", body);
    expect(result.variant).toBe("medium");
    expect(result).toBe(body); // Same reference
  });

  test("applies variant to body without variant", () => {
    const body = { agent: "oracle", parts: [] };
    const result = applyAgentVariant("high", body);
    expect(result.variant).toBe("high");
    expect(result.agent).toBe("oracle");
    expect(result).not.toBe(body); // New object
  });

  test("preserves all existing body properties", () => {
    const body = {
      agent: "oracle",
      parts: [{ type: "text" as const, text: "hello" }],
      tools: { background_task: false },
    };
    const result = applyAgentVariant("low", body);
    expect(result.agent).toBe("oracle");
    expect(result.parts).toEqual([{ type: "text", text: "hello" }]);
    expect(result.tools).toEqual({ background_task: false });
    expect(result.variant).toBe("low");
  });
});
