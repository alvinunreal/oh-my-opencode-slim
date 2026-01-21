import { describe, expect, test } from "bun:test";
import { createAgents, getAgentConfigs, getSubagentNames } from "./index";
import type { PluginConfig } from "../config";

describe("agent overrides", () => {
  test("new agent names work directly", () => {
    const config: PluginConfig = {
      agents: {
        explorer: { model: "direct-explorer" },
        designer: { model: "direct-designer" },
      },
    };
    const agents = createAgents(config);
    expect(agents.find((a) => a.name === "explorer")!.config.model).toBe("direct-explorer");
    expect(agents.find((a) => a.name === "designer")!.config.model).toBe("direct-designer");
  });

  test("prompt override works", () => {
    const config: PluginConfig = {
      agents: {
        explorer: { prompt: "custom prompt" },
      },
    };
    const agents = createAgents(config);
    expect(agents.find((a) => a.name === "explorer")!.config.prompt).toBe("custom prompt");
  });
});

describe("agent classification", () => {
  test("getSubagentNames excludes orchestrator", () => {
    const names = getSubagentNames();
    expect(names).not.toContain("orchestrator");
    expect(names).toContain("explorer");
    expect(names).toContain("fixer");
  });

  test("getAgentConfigs applies correct classification visibility and mode", () => {
    const configs = getAgentConfigs();

    // Primary agent
    expect(configs["orchestrator"].mode).toBe("primary");
    expect(configs["orchestrator"].hidden).toBeFalsy();

    // Subagents
    const subagents = getSubagentNames();
    for (const name of subagents) {
      expect(configs[name].mode).toBe("subagent");
      expect(configs[name].hidden).toBe(true);
    }
  });
});

describe("createAgents", () => {
  test("creates all agents without config", () => {
    const agents = createAgents();
    const names = agents.map((a) => a.name);
    expect(names).toContain("orchestrator");
    expect(names).toContain("explorer");
    expect(names).toContain("designer");
    expect(names).toContain("oracle");
    expect(names).toContain("librarian");
  });

  test("respects disabled_agents", () => {
    const config: PluginConfig = {
      disabled_agents: ["explorer", "designer"],
    };
    const agents = createAgents(config);
    const names = agents.map((a) => a.name);
    expect(names).not.toContain("explorer");
    expect(names).not.toContain("designer");
    expect(names).toContain("orchestrator");
    expect(names).toContain("oracle");
  });
});

describe("getAgentConfigs", () => {
  test("returns config record keyed by agent name", () => {
    const configs = getAgentConfigs();
    expect(configs["orchestrator"]).toBeDefined();
    expect(configs["explorer"]).toBeDefined();
    expect(configs["orchestrator"].model).toBeDefined();
  });
});
