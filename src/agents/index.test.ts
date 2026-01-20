import { describe, expect, test } from "bun:test";
import { createAgents, getAgentConfigs, getSubagentNames, getPrimaryAgentNames } from "./index";
import type { PluginConfig } from "../config";

describe("agent alias backward compatibility", () => {
  test("applies 'explore' config to 'explorer' agent", () => {
    const config: PluginConfig = {
      agents: {
        explore: { model: "test/old-explore-model" },
      },
    };
    const agents = createAgents(config);
    const explorer = agents.find((a) => a.name === "explorer");
    expect(explorer).toBeDefined();
    expect(explorer!.config.model).toBe("test/old-explore-model");
  });

  test("applies 'frontend-ui-ux-engineer' config to 'designer' agent", () => {
    const config: PluginConfig = {
      agents: {
        "frontend-ui-ux-engineer": { model: "test/old-frontend-model" },
      },
    };
    const agents = createAgents(config);
    const designer = agents.find((a) => a.name === "designer");
    expect(designer).toBeDefined();
    expect(designer!.config.model).toBe("test/old-frontend-model");
  });

  test("new name takes priority over old alias", () => {
    const config: PluginConfig = {
      agents: {
        explore: { model: "old-model" },
        explorer: { model: "new-model" },
      },
    };
    const agents = createAgents(config);
    const explorer = agents.find((a) => a.name === "explorer");
    expect(explorer!.config.model).toBe("new-model");
  });

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

  test("temperature override via old alias", () => {
    const config: PluginConfig = {
      agents: {
        explore: { temperature: 0.5 },
      },
    };
    const agents = createAgents(config);
    const explorer = agents.find((a) => a.name === "explorer");
    expect(explorer!.config.temperature).toBe(0.5);
  });
});

describe("agent classification", () => {
  test("getPrimaryAgentNames returns only orchestrator", () => {
    const names = getPrimaryAgentNames();
    expect(names).toEqual(["orchestrator"]);
  });

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
