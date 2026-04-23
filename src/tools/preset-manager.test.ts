import { describe, expect, mock, test } from "bun:test";
import type { PluginConfig } from "../config";
import { createPresetManager } from "./preset-manager";

function createMockContext() {
  const configUpdate = mock(async () => ({}));
  return {
    client: {
      config: {
        update: configUpdate,
      },
    },
    directory: "/tmp/test",
  } as any;
}

function createOutput() {
  return { parts: [] as Array<{ type: string; text?: string }> };
}

function getOutputText(output: ReturnType<typeof createOutput>): string {
  return output.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

describe("createPresetManager", () => {
  describe("handleCommandExecuteBefore", () => {
    test("ignores non-preset commands", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {};
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "auto-continue", sessionID: "s1", arguments: "on" },
        output
      );

      expect(output.parts).toHaveLength(0);
      expect(ctx.client.config.update).not.toHaveBeenCalled();
    });

    test("lists available presets when no argument given", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: {
            orchestrator: { model: "anthropic/claude-3.5-haiku" },
          },
          powerful: {
            orchestrator: { model: "openai/gpt-5.5" },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "" },
        output
      );

      const text = getOutputText(output);
      expect(text).toContain("cheap");
      expect(text).toContain("powerful");
      expect(ctx.client.config.update).not.toHaveBeenCalled();
    });

    test("lists presets with active marker when preset is set", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        preset: "cheap",
        presets: {
          cheap: { orchestrator: { model: "anthropic/claude-3.5-haiku" } },
          powerful: { orchestrator: { model: "openai/gpt-5.5" } },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "" },
        output
      );

      const text = getOutputText(output);
      expect(text).toContain("← active");
    });

    test("shows no-presets message when none configured", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {};
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "" },
        output
      );

      const text = getOutputText(output);
      expect(text).toContain("No presets configured");
    });

    test("switches preset and calls config.update", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: {
            orchestrator: { model: "anthropic/claude-3.5-haiku" },
            explorer: { model: "openai/gpt-5.4-mini" },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "cheap" },
        output
      );

      const text = getOutputText(output);
      expect(text).toContain('Switched to preset "cheap"');
      expect(text).toContain("orchestrator");
      expect(text).toContain("anthropic/claude-3.5-haiku");
      expect(text).toContain("explorer");
      expect(ctx.client.config.update).toHaveBeenCalledTimes(1);
      expect(ctx.client.config.update).toHaveBeenCalledWith({
        body: {
          agent: {
            orchestrator: { model: "anthropic/claude-3.5-haiku" },
            explorer: { model: "openai/gpt-5.4-mini" },
          },
        },
      });
    });

    test("passes temperature in config update", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          precise: {
            orchestrator: { model: "openai/o3", temperature: 0.1 },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "precise" },
        output
      );

      expect(ctx.client.config.update).toHaveBeenCalledWith({
        body: {
          agent: {
            orchestrator: { model: "openai/o3", temperature: 0.1 },
          },
        },
      });
    });

    test("passes variant in config update", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          thinker: {
            oracle: {
              model: "anthropic/claude-sonnet-4-6",
              variant: "thinking",
            },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "thinker" },
        output
      );

      expect(ctx.client.config.update).toHaveBeenCalledWith({
        body: {
          agent: {
            oracle: {
              model: "anthropic/claude-sonnet-4-6",
              variant: "thinking",
            },
          },
        },
      });
    });

    test("shows error for unknown preset name", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: { orchestrator: { model: "anthropic/claude-3.5-haiku" } },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "nonexistent" },
        output
      );

      const text = getOutputText(output);
      expect(text).toContain("not found");
      expect(text).toContain("cheap");
      expect(ctx.client.config.update).not.toHaveBeenCalled();
    });

    test("shows error when no presets configured but argument given", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {};
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "cheap" },
        output
      );

      const text = getOutputText(output);
      expect(text).toContain("not found");
      expect(text).toContain("No presets configured");
    });

    test("handles config.update error gracefully", async () => {
      const ctx = createMockContext();
      ctx.client.config.update = mock(async () => {
        throw new Error("Server unavailable");
      });
      const config: PluginConfig = {
        presets: {
          cheap: { orchestrator: { model: "anthropic/claude-3.5-haiku" } },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "cheap" },
        output
      );

      const text = getOutputText(output);
      expect(text).toContain("Failed to switch preset");
      expect(text).toContain("Server unavailable");
    });

    test("shows empty preset message when preset has no valid overrides", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          empty: {
            orchestrator: {},
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "empty" },
        output
      );

      const text = getOutputText(output);
      expect(text).toContain("empty");
      expect(ctx.client.config.update).not.toHaveBeenCalled();
    });

    test("forwards options field in config update", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          thinker: {
            oracle: {
              model: "anthropic/claude-sonnet-4-6",
              options: {
                thinking: { type: "enabled", budgetTokens: 10000 },
              },
            },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "thinker" },
        output
      );

      expect(ctx.client.config.update).toHaveBeenCalledWith({
        body: {
          agent: {
            oracle: {
              model: "anthropic/claude-sonnet-4-6",
              options: {
                thinking: { type: "enabled", budgetTokens: 10000 },
              },
            },
          },
        },
      });
    });

    test("trims whitespace from preset name argument", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: { orchestrator: { model: "anthropic/claude-3.5-haiku" } },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "  cheap  " },
        output
      );

      const text = getOutputText(output);
      expect(text).toContain('Switched to preset "cheap"');
      expect(ctx.client.config.update).toHaveBeenCalledTimes(1);
    });

    test("shows suggestion for multi-word arguments", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: { orchestrator: { model: "anthropic/claude-3.5-haiku" } },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "cheap powerful" },
        output
      );

      const text = getOutputText(output);
      expect(text).toContain("cannot contain spaces");
      expect(text).toContain("/preset cheap");
      expect(ctx.client.config.update).not.toHaveBeenCalled();
    });

    test("catches tab-separated arguments", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: { orchestrator: { model: "anthropic/claude-3.5-haiku" } },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "cheap\tpowerful" },
        output
      );

      const text = getOutputText(output);
      expect(text).toContain("cannot contain spaces");
      expect(ctx.client.config.update).not.toHaveBeenCalled();
    });

    test("skips agents with empty overrides in mixed preset", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          mixed: {
            orchestrator: { model: "anthropic/claude-3.5-haiku" },
            explorer: {},
            oracle: { temperature: 0.3 },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "mixed" },
        output
      );

      const text = getOutputText(output);
      expect(text).toContain('Switched to preset "mixed"');
      // Only orchestrator and oracle should be forwarded
      expect(ctx.client.config.update).toHaveBeenCalledWith({
        body: {
          agent: {
            orchestrator: { model: "anthropic/claude-3.5-haiku" },
            oracle: { temperature: 0.3 },
          },
        },
      });
    });

    test("resolves array-form model to first entry", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          fallback: {
            orchestrator: {
              model: ["anthropic/claude-3.5-haiku", "openai/gpt-5.5"],
            },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "fallback" },
        output
      );

      const text = getOutputText(output);
      expect(text).toContain('Switched to preset "fallback"');
      expect(ctx.client.config.update).toHaveBeenCalledWith({
        body: {
          agent: {
            orchestrator: { model: "anthropic/claude-3.5-haiku" },
          },
        },
      });
    });

    test("resolves array-form model with object entries", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          thinker: {
            oracle: {
              model: [
                { id: "anthropic/claude-sonnet-4-6", variant: "thinking" },
                { id: "openai/o3" },
              ],
            },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "thinker" },
        output
      );

      expect(ctx.client.config.update).toHaveBeenCalledWith({
        body: {
          agent: {
            oracle: {
              model: "anthropic/claude-sonnet-4-6",
              variant: "thinking",
            },
          },
        },
      });
    });

    test("shows variant and options in switch summary", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          thinker: {
            oracle: {
              model: "anthropic/claude-sonnet-4-6",
              variant: "thinking",
              options: { thinking: { type: "enabled", budgetTokens: 10000 } },
            },
          },
        },
      };
      const manager = createPresetManager(ctx, config);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "thinker" },
        output
      );

      const text = getOutputText(output);
      expect(text).toContain("variant: thinking");
      expect(text).toContain("options: yes");
    });

    test("tracks active preset after switch", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        presets: {
          cheap: { orchestrator: { model: "anthropic/claude-3.5-haiku" } },
          powerful: { orchestrator: { model: "openai/gpt-5.5" } },
        },
      };
      const manager = createPresetManager(ctx, config);

      // Switch to cheap
      const output1 = createOutput();
      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "cheap" },
        output1
      );
      expect(getOutputText(output1)).toContain("Switched");

      // List presets should now show cheap as active
      const output2 = createOutput();
      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "" },
        output2
      );
      expect(getOutputText(output2)).toContain("cheap ← active");

      // Switch to powerful
      const output3 = createOutput();
      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "powerful" },
        output3
      );
      expect(getOutputText(output3)).toContain('Switched to preset "powerful"');

      // List should now show powerful as active
      const output4 = createOutput();
      await manager.handleCommandExecuteBefore(
        { command: "preset", sessionID: "s1", arguments: "" },
        output4
      );
      expect(getOutputText(output4)).toContain("powerful ← active");
    });
  });

  describe("registerCommand", () => {
    test("registers preset command when not present", () => {
      const ctx = createMockContext();
      const config: PluginConfig = {};
      const manager = createPresetManager(ctx, config);
      const opencodeConfig: Record<string, unknown> = {};

      manager.registerCommand(opencodeConfig);

      const command = (opencodeConfig.command as Record<string, unknown>)
        .preset as { template: string; description: string };
      expect(command).toBeDefined();
      expect(command.template).toContain("presets");
      expect(command.description).toContain("/preset");
    });

    test("does not overwrite existing preset command", () => {
      const ctx = createMockContext();
      const config: PluginConfig = {};
      const manager = createPresetManager(ctx, config);
      const existing = { template: "custom", description: "custom" };
      const opencodeConfig: Record<string, unknown> = {
        command: { preset: existing },
      };

      manager.registerCommand(opencodeConfig);

      expect((opencodeConfig.command as Record<string, unknown>).preset).toBe(
        existing
      );
    });
  });
});
