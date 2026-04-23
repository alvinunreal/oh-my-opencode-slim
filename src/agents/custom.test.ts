import { describe, expect, spyOn, test } from "bun:test";
import type { PluginConfig } from "../config";
import { createAgents, getAgentConfigs } from "./index";

describe("custom-agent creation", () => {
  test("infers custom agents from unknown keys", () => {
    const config: PluginConfig = {
      agents: {
        explorer: { model: "openai/gpt-5.4-mini" },
        reviewer: {
          model: "openai/gpt-5.5",
          prompt: "You are the custom reviewer agent.",
        },
      },
    };

    const agents = createAgents(config);
    const names = agents.map((agent) => agent.name);

    expect(names).toContain("reviewer");

    const customAgent = agents.find((agent) => agent.name === "reviewer");
    expect(customAgent).toBeDefined();
    expect(customAgent?.config.model).toBe("openai/gpt-5.5");
    expect(customAgent?.config.prompt).toBe(
      "You are the custom reviewer agent."
    );
  });

  test("supports prompt and orchestratorPrompt for custom agents", () => {
    const config: PluginConfig = {
      agents: {
        "test-auditor": {
          model: "openai/gpt-5.4-mini",
          prompt: "You are a custom subagent for auditing.",
          orchestratorPrompt:
            "@test-auditor\n- Role: Compliance audit specialist",
        },
      },
    };

    const agents = createAgents(config);
    const customAgent = agents.find((agent) => agent.name === "test-auditor");

    expect(customAgent).toBeDefined();
    expect(customAgent?.config.prompt).toBe(
      "You are a custom subagent for auditing."
    );

    const orchestrator = agents.find((agent) => agent.name === "orchestrator");
    expect(orchestrator?.config.prompt).toContain(
      "@test-auditor\n- Role: Compliance audit specialist"
    );
  });

  test("skips custom agents without a model", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const config: PluginConfig = {
        agents: {
          janitor: {
            prompt: "You are Janitor.",
            orchestratorPrompt: "@janitor\n- Role: Cleanup specialist",
          },
        },
      };

      const agentDefs = createAgents(config);
      expect(
        agentDefs.find((agent) => agent.name === "janitor")
      ).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        "[oh-my-opencode] Custom agent 'janitor' skipped: 'model' is required"
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("does not create or inject disabled custom agents", () => {
    const config: PluginConfig = {
      disabled_agents: ["test-auditor", "designer"],
      agents: {
        "test-auditor": {
          model: "openai/gpt-5.4-mini",
          prompt: "You are a disabled custom agent.",
        },
      },
    };

    const agentDefs = createAgents(config);
    const names = agentDefs.map((agent) => agent.name);
    expect(names).not.toContain("test-auditor");

    const sdkConfigs = getAgentConfigs(config);
    expect(sdkConfigs["test-auditor"]).toBeUndefined();
  });

  test("rejects unsafe custom agent names", () => {
    const config: PluginConfig = {
      agents: {
        "unsafe/name": {
          model: "openai/gpt-5.4-mini",
        },
      },
    };

    expect(() => createAgents(config)).toThrow();
  });

  test("accepts arbitrary orchestratorPrompt text for custom agents", () => {
    const config: PluginConfig = {
      agents: {
        janitor: {
          model: "openai/gpt-5.4-mini",
          orchestratorPrompt: "@cleanup\n- Role: Cleanup specialist",
        },
      },
    };

    const agents = createAgents(config);
    const orchestrator = agents.find((agent) => agent.name === "orchestrator");
    expect(orchestrator?.config.prompt).toContain(
      "@cleanup\n- Role: Cleanup specialist"
    );
  });
});
