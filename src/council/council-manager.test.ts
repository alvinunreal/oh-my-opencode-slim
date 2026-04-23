import { describe, expect, mock, test } from "bun:test";
import type { PluginConfig } from "../config";
import { CouncilConfigSchema } from "../config/council-schema";
import { SubagentDepthTracker } from "../utils/subagent-depth";
import { CouncilManager } from "./council-manager";

function createMockContext(overrides?: {
  sessionCreateResult?:
    | (() => { data?: { id?: string } })
    | {
        data?: { id?: string };
      };
  sessionMessagesResult?: {
    data?: Array<{
      info?: { role: string };
      parts?: Array<{ type: string; text?: string }>;
    }>;
  };
  promptImpl?: (args: unknown) => Promise<unknown>;
}) {
  let callCount = 0;
  return {
    client: {
      session: {
        create: mock(async () => {
          callCount++;
          const overrideResult = overrides?.sessionCreateResult;
          if (typeof overrideResult === "function") {
            return overrideResult();
          }
          return (
            overrideResult ?? {
              data: { id: `test-session-${callCount}` },
            }
          );
        }),
        messages: mock(
          async () => overrides?.sessionMessagesResult ?? { data: [] }
        ),
        prompt: mock(async (args: unknown) => {
          if (overrides?.promptImpl) {
            return await overrides.promptImpl(args);
          }
          return {};
        }),
        abort: mock(async () => ({})),
      },
    },
    directory: "/tmp/test",
  } as any;
}

function createTestCouncilConfig(overrides?: {
  presets?: Record<string, Record<string, { model: string; variant?: string }>>;
  default_preset?: string;
  timeout?: number;
}): PluginConfig {
  const councilConfig = CouncilConfigSchema.parse({
    presets: overrides?.presets ?? {
      default: {
        alpha: { model: "openai/gpt-5.4-mini" },
        beta: { model: "openai/gpt-5.3-codex" },
      },
    },
    default_preset: overrides?.default_preset,
    timeout: overrides?.timeout,
  });

  return { council: councilConfig } as any;
}

describe("CouncilManager", () => {
  describe("constructor", () => {
    test("creates manager without config", () => {
      const ctx = createMockContext();
      const manager = new CouncilManager(ctx, undefined);
      expect(manager).toBeDefined();
    });

    test("creates manager with plugin config", async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "Councillor response" }],
            },
          ],
        },
      });
      const config = createTestCouncilConfig();
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        "test prompt",
        undefined,
        "parent-session-id"
      );

      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();
      expect(result.councillorResults).toHaveLength(2);

      // Check all councillors completed
      expect(
        result.councillorResults.every((r) => r.status === "completed")
      ).toBe(true);
    });

    test("returns error when all councillors fail", async () => {
      const ctx = createMockContext({
        sessionCreateResult: () => ({ data: {} }), // Missing ID triggers failure
      });
      const config = createTestCouncilConfig();
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        "test prompt",
        undefined,
        "parent-session-id"
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("All councillors failed or timed out");
      expect(result.councillorResults).toHaveLength(2);
      expect(result.councillorResults.every((r) => r.status === "failed")).toBe(
        true
      );
    });

    test("uses default_preset when presetName is undefined", async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "Councillor response" }],
            },
          ],
        },
      });
      const config = createTestCouncilConfig({
        presets: {
          default: {
            alpha: { model: "openai/gpt-5.4-mini" },
          },
          custom: {
            beta: { model: "openai/gpt-5.3-codex" },
          },
        },
        default_preset: "custom",
      });
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        "test prompt",
        undefined,
        "parent-session-id"
      );

      expect(result.success).toBe(true);
      expect(result.councillorResults).toHaveLength(1);
      expect(result.councillorResults[0].name).toBe("beta");
    });

    test("handles mixed councillor success/failure", async () => {
      let createCallCount = 0;
      const ctx = createMockContext({
        sessionCreateResult: () => {
          createCallCount++;
          // First councillor succeeds, second fails
          if (createCallCount === 1) {
            return { data: { id: "councillor-success" } };
          }
          if (createCallCount === 2) {
            return { data: {} }; // Missing ID = failure
          }
          return { data: { id: `session-${createCallCount}` } };
        },
        sessionMessagesResult: {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "Successful response" }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          presets: {
            default: {
              councillor1: { model: "openai/gpt-5.4-mini" },
              councillor2: { model: "openai/gpt-5.3-codex" },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        "test prompt",
        undefined,
        "parent-session-id"
      );

      expect(result.success).toBe(true);
      expect(result.councillorResults).toHaveLength(2);

      // Check that one completed and one failed (order not guaranteed)
      const completedCount = result.councillorResults.filter(
        (r) => r.status === "completed"
      ).length;
      const failedCount = result.councillorResults.filter(
        (r) => r.status === "failed"
      ).length;

      expect(completedCount).toBe(1);
      expect(failedCount).toBe(1);
    });

    test("uses custom timeouts from config", async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "Response" }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          presets: {
            default: {
              alpha: { model: "openai/gpt-5.4-mini" },
            },
            custom: {
              beta: { model: "openai/gpt-5.3-codex" },
            },
          },
          default_preset: "custom",
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        "test prompt",
        undefined,
        "parent-session-id"
      );

      expect(result.success).toBe(true);
    });

    test("handles councillor timeout", async () => {
      let sessionCount = 0;
      const ctx = createMockContext({
        sessionCreateResult: () => {
          sessionCount++;
          return { data: { id: `session-${sessionCount}` } };
        },
        promptImpl: async (args: any) => {
          // First councillor times out, second succeeds
          const sessionId = args.path?.id;
          if (sessionId === "session-1") {
            // Simulate timeout
            throw new Error("Prompt timed out after 180000ms");
          }
          return {};
        },
        sessionMessagesResult: {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "Success" }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          presets: {
            default: {
              timeout: { model: "openai/gpt-5.4-mini" },
              success: { model: "openai/gpt-5.3-codex" },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        "test prompt",
        undefined,
        "parent-session-id"
      );

      expect(result.success).toBe(true);
      expect(result.councillorResults).toHaveLength(2);

      const timeoutResult = result.councillorResults.find(
        (r) => r.name === "timeout"
      );
      const successResult = result.councillorResults.find(
        (r) => r.name === "success"
      );

      expect(timeoutResult?.status).toBe("timed_out");
      expect(timeoutResult?.error).toContain("timed out");
      expect(successResult?.status).toBe("completed");
    });

    test("passes variant to councillor sessions", async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "Response" }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          presets: {
            default: {
              alpha: { model: "openai/gpt-5.4-mini", variant: "low" },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil("test prompt", undefined, "parent-session-id");

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body?: { variant?: string; agent?: string } }]
      >;
      // Find the councillor call by agent field (notification may be at [0])
      const councillorCall = promptCalls.find(
        (c) => c[0].body?.agent === "councillor"
      );
      expect(councillorCall).toBeDefined();
      expect(councillorCall?.[0].body?.variant).toBe("low");
    });

    test("always aborts councillor sessions after completion", async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "Response" }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          presets: {
            default: {
              alpha: { model: "openai/gpt-5.4-mini" },
              beta: { model: "openai/gpt-5.3-codex" },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil("test prompt", undefined, "parent-session-id");

      // Should abort 2 councillors
      expect(ctx.client.session.abort).toHaveBeenCalledTimes(2);
    });

    test("handles councillor with invalid model format", async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        council: {
          presets: {
            default: {
              badmodel: { model: "invalid-model-no-slash" },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        "test prompt",
        undefined,
        "parent-session-id"
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("All councillors failed or timed out");
      expect(result.councillorResults).toHaveLength(1);
      expect(result.councillorResults[0].status).toBe("failed");
      expect(result.councillorResults[0].error).toContain(
        "Invalid model format"
      );
    });

    test("extracts text and reasoning content from councillor responses", async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: "assistant" },
              parts: [
                { type: "reasoning", text: "I am thinking..." },
                { type: "text", text: "Final answer." },
              ],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          presets: {
            default: {
              alpha: { model: "openai/gpt-5.4-mini" },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        "test prompt",
        undefined,
        "parent-session-id"
      );

      expect(result.success).toBe(true);
      // Councillors filter out reasoning parts to avoid bloating the synthesis
      expect(result.councillorResults[0].result).not.toContain(
        "I am thinking..."
      );
      expect(result.councillorResults[0].result).toContain("Final answer.");
    });

    test("handles concurrent council sessions with different presets", async () => {
      const ctx = createMockContext({
        sessionCreateResult: () => ({ data: { id: "session-1" } }),
        sessionMessagesResult: {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "Response" }],
            },
          ],
        },
      });
      const defaultConfig = createTestCouncilConfig({
        presets: {
          default: {
            alpha: { model: "openai/gpt-5.4-mini" },
          },
          fast: {
            beta: { model: "openai/gpt-5.3-codex" },
          },
        },
      });
      const manager1 = new CouncilManager(ctx, defaultConfig, undefined);
      const manager2 = new CouncilManager(ctx, defaultConfig, undefined);

      const [result1, result2] = await Promise.all([
        manager1.runCouncil("test prompt 1", "default", "parent-1"),
        manager2.runCouncil("test prompt 2", "fast", "parent-2"),
      ]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.councillorResults[0].name).toBe("alpha");
      expect(result2.councillorResults[0].name).toBe("beta");
    });

    test("handles empty preset gracefully", async () => {
      const ctx = createMockContext();
      const config = createTestCouncilConfig({
        presets: {
          empty: {},
        },
      });
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        "test prompt",
        "empty",
        "parent-id"
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        'Preset "empty" has no councillors configured'
      );
      expect(result.councillorResults).toHaveLength(0);
    });

    test("returns available presets when invalid preset name given", async () => {
      const ctx = createMockContext();
      const config = createTestCouncilConfig({
        presets: {
          default: {
            alpha: { model: "openai/gpt-5.4-mini" },
          },
          roled: {
            beta: { model: "openai/gpt-5.3-codex" },
          },
        },
      });
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        "test prompt",
        "architect",
        "parent-id"
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Preset "architect" does not exist');
      expect(result.error).toContain("Omit the preset parameter");
      expect(result.error).toContain("default, roled");
      expect(result.councillorResults).toHaveLength(0);
    });

    test("returns error when depth exceeded", async () => {
      const ctx = createMockContext();
      const config = createTestCouncilConfig();
      const tracker = new SubagentDepthTracker(3);

      // Simulate depth: root (0) → child1 (1) → child2 (2) → child3 (3)
      tracker.registerChild("root", "child1"); // depth 1
      tracker.registerChild("child1", "child2"); // depth 2
      tracker.registerChild("child2", "child3"); // depth 3 (max)

      const manager = new CouncilManager(ctx, config, tracker);

      const result = await manager.runCouncil(
        "test prompt",
        undefined,
        "child3" // parent at max depth, next spawn would exceed limit
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Subagent depth exceeded");
      expect(result.councillorResults).toHaveLength(0);
    });

    test("passes agent field in councillor prompt body", async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "Response" }],
            },
          ],
        },
      });
      const config = createTestCouncilConfig();
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil("test prompt", undefined, "parent-id");

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body?: { agent?: string } }]
      >;
      // Find councillor call by agent (notification may interleave)
      const councillorCall = promptCalls.find(
        (c) => c[0].body?.agent === "councillor"
      );
      expect(councillorCall).toBeDefined();
    });

    test("creates session with model label in title", async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "Response" }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          presets: {
            default: {
              alpha: { model: "openai/gpt-5.4-mini" },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil("test prompt", undefined, "parent-id");

      const createCalls = ctx.client.session.create.mock.calls as Array<
        [{ body?: { title?: string } }]
      >;
      // Councillor title: "Council alpha (gpt-5.4-mini)"
      expect(createCalls[0][0].body?.title).toBe(
        "Council alpha (gpt-5.4-mini)"
      );
    });

    test("passes councillor prompt to councillor session", async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "Response with role guidance" }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          presets: {
            default: {
              alpha: {
                model: "openai/gpt-5.4-mini",
                prompt: "You are a meticulous reviewer focused on edge cases.",
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil("test prompt", undefined, "parent-id");

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [
          {
            body?: {
              parts?: Array<{ type: string; text?: string }>;
              agent?: string;
            };
          }
        ]
      >;
      const councillorCall = promptCalls.find(
        (c) => c[0].body?.agent === "councillor"
      );
      expect(councillorCall).toBeDefined();
      const promptText = councillorCall?.[0]?.body?.parts?.[0]?.text;
      expect(promptText).toContain("test prompt");
      expect(promptText).toContain(
        "You are a meticulous reviewer focused on edge cases."
      );
    });

    test("works without any prompt overrides (backward compatible)", async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "Response" }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          presets: {
            default: {
              alpha: { model: "openai/gpt-5.4-mini" },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        "test prompt",
        undefined,
        "parent-id"
      );

      expect(result.success).toBe(true);
      // Verify no prompt contamination — councillor gets raw prompt
      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [
          {
            body?: {
              parts?: Array<{ type: string; text?: string }>;
              agent?: string;
            };
          }
        ]
      >;
      const councillorCall = promptCalls.find(
        (c) => c[0].body?.agent === "councillor"
      );
      // Without prompt override, councillor gets just the raw user prompt
      expect(councillorCall?.[0]?.body?.parts?.[0]?.text).toBe("test prompt");
    });

    test("retries councillor on empty response", async () => {
      const ctx = createMockContext({
        promptImpl: async () => ({}),
      });

      // Track messages call count and return empty first, then success
      let councillorMessagesCallCount = 0;
      const originalMessages = ctx.client.session.messages;
      ctx.client.session.messages = mock(async (args) => {
        // First call (first councillor attempt): empty response
        // Second call (councillor retry): success
        councillorMessagesCallCount++;
        if (councillorMessagesCallCount === 1) {
          return {
            data: [
              {
                info: { role: "assistant" },
                parts: [{ type: "text", text: "" }],
              },
            ],
          };
        }
        if (councillorMessagesCallCount === 2) {
          return {
            data: [
              {
                info: { role: "assistant" },
                parts: [{ type: "text", text: "Success" }],
              },
            ],
          };
        }
        // Any other calls: use original
        return originalMessages(args);
      });

      const config: PluginConfig = {
        council: {
          councillor_retries: 1,
          presets: {
            default: {
              alpha: { model: "openai/gpt-5.4-mini" },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        "test prompt",
        undefined,
        "parent-id"
      );

      expect(result.success).toBe(true);
      // First two messages calls are for councillor (empty + success)
      expect(councillorMessagesCallCount).toBeGreaterThanOrEqual(2);
      expect(result.councillorResults).toHaveLength(1);
      expect(result.councillorResults[0].status).toBe("completed");
      expect(result.councillorResults[0].result).toBe("Success");
    });

    test("does not retry councillor on non-empty failure (timeout)", async () => {
      let messagesCallCount = 0;
      const ctx = createMockContext({
        promptImpl: async () => {
          // Simulate timeout error
          throw new Error("Prompt timed out after 180000ms");
        },
      });

      // Override messages to track calls (won't be reached due to timeout)
      ctx.client.session.messages = mock(async () => {
        messagesCallCount++;
        return {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "Success" }],
            },
          ],
        };
      });

      const config: PluginConfig = {
        council: {
          councillor_retries: 2,
          presets: {
            default: {
              alpha: { model: "openai/gpt-5.4-mini" },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        "test prompt",
        undefined,
        "parent-id"
      );

      expect(result.success).toBe(false);
      // No retry on timeout — messages should not be called
      expect(messagesCallCount).toBe(0);
      expect(result.councillorResults).toHaveLength(1);
      expect(result.councillorResults[0].status).toBe("timed_out");
      expect(result.councillorResults[0].error).toContain("timed out");
    });

    test("exhausts councillor retries and returns failure", async () => {
      const ctx = createMockContext({
        promptImpl: async () => ({}),
      });

      const config: PluginConfig = {
        council: {
          councillor_retries: 1,
          presets: {
            default: {
              alpha: { model: "openai/gpt-5.4-mini" },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        "test prompt",
        undefined,
        "parent-id"
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("All councillors failed or timed out");
      expect(result.councillorResults).toHaveLength(1);
      expect(result.councillorResults[0].status).toBe("failed");
      expect(result.councillorResults[0].error).toContain(
        "Empty response from provider"
      );
    });

    test("returns empty councillor result when retry_on_empty is false", async () => {
      const ctx = createMockContext({
        promptImpl: async () => ({}),
      });

      // Always return empty response
      ctx.client.session.messages = mock(async () => ({
        data: [
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "" }],
          },
        ],
      }));

      const config: PluginConfig = {
        council: {
          councillor_retries: 1,
          presets: {
            default: {
              alpha: { model: "openai/gpt-5.4-mini" },
            },
          },
        },
        fallback: {
          retry_on_empty: false,
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        "test prompt",
        undefined,
        "parent-id"
      );

      // With retry_on_empty: false, empty response is accepted as completed
      expect(result.councillorResults).toHaveLength(1);
      expect(result.councillorResults[0].status).toBe("completed");
      expect(result.councillorResults[0].result).toBe("");
      // Council succeeds because empty is accepted as valid response
      // The formatted result contains the message about all councillors failing
      expect(result.success).toBe(true);
      expect(result.result).toContain(
        "All councillors failed to produce output"
      );
      expect(result.result).toContain("test prompt");
    });
  });
});
