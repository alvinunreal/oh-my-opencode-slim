import { describe, expect, mock, test } from 'bun:test';
import { SubagentDepthTracker } from '../background/subagent-depth';
import type { PluginConfig } from '../config';
import { CouncilConfigSchema } from '../config/council-schema';
import { CouncilManager } from './council-manager';

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
          if (typeof overrideResult === 'function') {
            return overrideResult();
          }
          return (
            overrideResult ?? {
              data: { id: `test-session-${callCount}` },
            }
          );
        }),
        messages: mock(
          async () => overrides?.sessionMessagesResult ?? { data: [] },
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
    directory: '/tmp/test',
  } as any;
}

function createTestCouncilConfig(overrides?: {
  master?: { model?: string; variant?: string };
  presets?: Record<string, Record<string, { model: string; variant?: string }>>;
  default_preset?: string;
  master_timeout?: number;
  councillors_timeout?: number;
}): PluginConfig {
  const councilConfig = CouncilConfigSchema.parse({
    master: overrides?.master ?? { model: 'anthropic/claude-opus-4-6' },
    presets: overrides?.presets ?? {
      default: {
        alpha: { model: 'openai/gpt-5.4-mini' },
        beta: { model: 'openai/gpt-5.3-codex' },
      },
    },
    default_preset: overrides?.default_preset,
    master_timeout: overrides?.master_timeout,
    councillors_timeout: overrides?.councillors_timeout,
  });

  return { council: councilConfig } as any;
}

describe('CouncilManager', () => {
  describe('constructor', () => {
    test('creates manager without config', () => {
      const ctx = createMockContext();
      const manager = new CouncilManager(ctx, undefined);
      expect(manager).toBeDefined();
    });

    test('creates manager with plugin config', async () => {
      const ctx = createMockContext();
      const config = createTestCouncilConfig();
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        'test prompt',
        undefined,
        'parent-session-id',
      );

      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();
      expect(result.councillorResults).toHaveLength(2);

      // Check all councillors completed
      expect(
        result.councillorResults.every((r) => r.status === 'completed'),
      ).toBe(true);
    });

    test('returns error when all councillors fail', async () => {
      const ctx = createMockContext({
        sessionCreateResult: () => ({ data: {} }), // Missing ID triggers failure
      });
      const config = createTestCouncilConfig();
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        'test prompt',
        undefined,
        'parent-session-id',
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('All councillors failed or timed out');
      expect(result.councillorResults).toHaveLength(2);
      expect(result.councillorResults.every((r) => r.status === 'failed')).toBe(
        true,
      );
    });

    test('uses default_preset when presetName is undefined', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Councillor response' }],
            },
          ],
        },
      });
      const config = createTestCouncilConfig({
        presets: {
          default: {
            alpha: { model: 'openai/gpt-5.4-mini' },
          },
          custom: {
            beta: { model: 'openai/gpt-5.3-codex' },
          },
        },
        default_preset: 'custom',
      });
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        'test prompt',
        undefined,
        'parent-session-id',
      );

      expect(result.success).toBe(true);
      expect(result.councillorResults).toHaveLength(1);
      expect(result.councillorResults[0].name).toBe('beta');
    });

    test('handles mixed councillor success/failure', async () => {
      let createCallCount = 0;
      const ctx = createMockContext({
        sessionCreateResult: () => {
          createCallCount++;
          // First councillor succeeds, second fails
          if (createCallCount === 1) {
            return { data: { id: 'councillor-success' } };
          }
          if (createCallCount === 2) {
            return { data: {} }; // Missing ID = failure
          }
          return { data: { id: `session-${createCallCount}` } };
        },
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Successful response' }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          master: { model: 'anthropic/claude-opus-4-6' },
          presets: {
            default: {
              councillors: {
                councillor1: { model: 'openai/gpt-5.4-mini' },
                councillor2: { model: 'openai/gpt-5.3-codex' },
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        'test prompt',
        undefined,
        'parent-session-id',
      );

      expect(result.success).toBe(true);
      expect(result.councillorResults).toHaveLength(2);

      // Check that one completed and one failed (order not guaranteed)
      const completedCount = result.councillorResults.filter(
        (r) => r.status === 'completed',
      ).length;
      const failedCount = result.councillorResults.filter(
        (r) => r.status === 'failed',
      ).length;

      expect(completedCount).toBe(1);
      expect(failedCount).toBe(1);
    });

    test('uses custom timeouts from config', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          master: { model: 'anthropic/claude-opus-4-6' },
          presets: {
            default: {
              councillors: {
                alpha: { model: 'openai/gpt-5.4-mini' },
              },
            },
            custom: {
              councillors: {
                beta: { model: 'openai/gpt-5.3-codex' },
              },
            },
          },
          default_preset: 'custom',
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        'test prompt',
        undefined,
        'parent-session-id',
      );

      expect(result.success).toBe(true);
    });

    test('handles councillor timeout', async () => {
      let sessionCount = 0;
      const ctx = createMockContext({
        sessionCreateResult: () => {
          sessionCount++;
          return { data: { id: `session-${sessionCount}` } };
        },
        promptImpl: async (args: any) => {
          // First councillor times out, second succeeds
          const sessionId = args.path?.id;
          if (sessionId === 'session-1') {
            // Simulate timeout
            throw new Error('Prompt timed out after 180000ms');
          }
          return {};
        },
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Success' }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          master: { model: 'anthropic/claude-opus-4-6' },
          presets: {
            default: {
              councillors: {
                timeout: { model: 'openai/gpt-5.4-mini' },
                success: { model: 'openai/gpt-5.3-codex' },
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        'test prompt',
        undefined,
        'parent-session-id',
      );

      expect(result.success).toBe(true);
      expect(result.councillorResults).toHaveLength(2);

      const timeoutResult = result.councillorResults.find(
        (r) => r.name === 'timeout',
      );
      const successResult = result.councillorResults.find(
        (r) => r.name === 'success',
      );

      expect(timeoutResult?.status).toBe('timed_out');
      expect(timeoutResult?.error).toContain('timed out');
      expect(successResult?.status).toBe('completed');
    });

    test('returns degraded result when master fails but councillors succeed', async () => {
      let createCallCount = 0;
      const ctx = createMockContext({
        sessionCreateResult: () => {
          createCallCount++;
          return { data: { id: `session-${createCallCount}` } };
        },
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Councillor result' }],
            },
          ],
        },
        promptImpl: async (args: any) => {
          // Master is third session (after 2 councillors), fail it
          const sessionId = args.path?.id;
          if (sessionId === 'session-3') {
            throw new Error('Master synthesis failed');
          }
          return {};
        },
      });
      const config: PluginConfig = {
        council: {
          master: { model: 'anthropic/claude-opus-4-6' },
          presets: {
            default: {
              councillors: {
                alpha: { model: 'openai/gpt-5.4-mini' },
                beta: { model: 'openai/gpt-5.3-codex' },
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        'test prompt',
        undefined,
        'parent-session-id',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('synthesis failed');
      expect(result.result).toBeDefined();
      expect(result.result).toContain('Degraded');
      expect(result.councillorResults).toHaveLength(2);
    });

    test('passes variant to councillor sessions', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          master: { model: 'anthropic/claude-opus-4-6' },
          presets: {
            default: {
              councillors: {
                alpha: { model: 'openai/gpt-5.4-mini', variant: 'low' },
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil('test prompt', undefined, 'parent-session-id');

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body?: { variant?: string; agent?: string } }]
      >;
      // Find the councillor call by agent field (notification may be at [0])
      const councillorCall = promptCalls.find(
        (c) => c[0].body?.agent === 'councillor',
      );
      expect(councillorCall).toBeDefined();
      expect(councillorCall?.[0].body?.variant).toBe('low');
    });

    test('passes variant to master session', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          master: { model: 'anthropic/claude-opus-4-6', variant: 'high' },
          presets: {
            default: {
              councillors: {
                alpha: { model: 'openai/gpt-5.4-mini' },
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil('test prompt', undefined, 'parent-session-id');

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body?: { variant?: string } }]
      >;
      // Last prompt call is for master (after councillor)
      const masterCall = promptCalls[promptCalls.length - 1];
      expect(masterCall[0].body?.variant).toBe('high');
    });

    test('always aborts councillor sessions after completion', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          master: { model: 'anthropic/claude-opus-4-6' },
          presets: {
            default: {
              councillors: {
                alpha: { model: 'openai/gpt-5.4-mini' },
                beta: { model: 'openai/gpt-5.3-codex' },
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil('test prompt', undefined, 'parent-session-id');

      // Should abort 2 councillors + 1 master = 3 total
      expect(ctx.client.session.abort).toHaveBeenCalledTimes(3);
    });

    test('handles councillor with invalid model format', async () => {
      const ctx = createMockContext();
      const config: PluginConfig = {
        council: {
          master: { model: 'anthropic/claude-opus-4-6' },
          presets: {
            default: {
              councillors: {
                badmodel: { model: 'invalid-model-no-slash' },
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        'test prompt',
        undefined,
        'parent-session-id',
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('All councillors failed or timed out');
      expect(result.councillorResults).toHaveLength(1);
      expect(result.councillorResults[0].status).toBe('failed');
      expect(result.councillorResults[0].error).toContain(
        'Invalid model format',
      );
    });

    test('handles master with invalid model format', async () => {
      let createCallCount = 0;
      const ctx = createMockContext({
        sessionCreateResult: () => {
          createCallCount++;
          return { data: { id: `session-${createCallCount}` } };
        },
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Councillor response' }],
            },
          ],
        },
        promptImpl: async (args: any) => {
          // Master is second session (after 1 councillor), fail it due to invalid model
          const sessionId = args.path?.id;
          if (sessionId === 'session-2') {
            throw new Error(
              'Invalid master model format: invalid-model-no-slash',
            );
          }
          return {};
        },
      });
      const config: PluginConfig = {
        council: {
          master: { model: 'invalid-model-no-slash' },
          presets: {
            default: {
              councillors: {
                alpha: { model: 'openai/gpt-5.4-mini' },
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        'test prompt',
        undefined,
        'parent-session-id',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid model format');
      expect(result.error).toContain('All master models failed');
      expect(result.result).toBeDefined(); // Degraded result
    });

    test('extracts text and reasoning content from councillor responses', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [
                { type: 'reasoning', text: 'I am thinking...' },
                { type: 'text', text: 'Final answer.' },
              ],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          master: { model: 'anthropic/claude-opus-4-6' },
          presets: {
            default: {
              councillors: {
                alpha: { model: 'openai/gpt-5.4-mini' },
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        'test prompt',
        undefined,
        'parent-session-id',
      );

      expect(result.success).toBe(true);
      // Councillors filter out reasoning parts to avoid bloating master synthesis
      expect(result.councillorResults[0].result).not.toContain(
        'I am thinking...',
      );
      expect(result.councillorResults[0].result).toContain('Final answer.');
    });

    test('handles concurrent council sessions with different presets', async () => {
      const ctx = createMockContext({
        sessionCreateResult: () => ({ data: { id: 'session-1' } }),
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
      });
      const defaultConfig = createTestCouncilConfig({
        presets: {
          default: {
            alpha: { model: 'openai/gpt-5.4-mini' },
          },
          fast: {
            beta: { model: 'openai/gpt-5.3-codex' },
          },
        },
      });
      const manager1 = new CouncilManager(ctx, defaultConfig, undefined);
      const manager2 = new CouncilManager(ctx, defaultConfig, undefined);

      const [result1, result2] = await Promise.all([
        manager1.runCouncil('test prompt 1', 'default', 'parent-1'),
        manager2.runCouncil('test prompt 2', 'fast', 'parent-2'),
      ]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.councillorResults[0].name).toBe('alpha');
      expect(result2.councillorResults[0].name).toBe('beta');
    });

    test('handles empty preset gracefully', async () => {
      const ctx = createMockContext();
      const config = createTestCouncilConfig({
        presets: {
          empty: {},
        },
      });
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        'test prompt',
        'empty',
        'parent-id',
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Preset "empty" has no councillors configured');
      expect(result.councillorResults).toHaveLength(0);
    });

    test('returns available presets when invalid preset name given', async () => {
      const ctx = createMockContext();
      const config = createTestCouncilConfig({
        presets: {
          default: {
            alpha: { model: 'openai/gpt-5.4-mini' },
          },
          roled: {
            beta: { model: 'openai/gpt-5.3-codex' },
          },
        },
      });
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        'test prompt',
        'architect',
        'parent-id',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Preset "architect" does not exist');
      expect(result.error).toContain('Omit the preset parameter');
      expect(result.error).toContain('default, roled');
      expect(result.councillorResults).toHaveLength(0);
    });

    test('returns error when depth exceeded', async () => {
      const ctx = createMockContext();
      const config = createTestCouncilConfig();
      const tracker = new SubagentDepthTracker(3);

      // Simulate depth: root (0) → child1 (1) → child2 (2) → child3 (3)
      tracker.registerChild('root', 'child1'); // depth 1
      tracker.registerChild('child1', 'child2'); // depth 2
      tracker.registerChild('child2', 'child3'); // depth 3 (max)

      const manager = new CouncilManager(ctx, config, tracker);

      const result = await manager.runCouncil(
        'test prompt',
        undefined,
        'child3', // parent at max depth, next spawn would exceed limit
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Subagent depth exceeded');
      expect(result.councillorResults).toHaveLength(0);
    });

    test('passes agent field in councillor prompt body', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
      });
      const config = createTestCouncilConfig();
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil('test prompt', undefined, 'parent-id');

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body?: { agent?: string } }]
      >;
      // Find councillor call by agent (notification may interleave)
      const councillorCall = promptCalls.find(
        (c) => c[0].body?.agent === 'councillor',
      );
      expect(councillorCall).toBeDefined();
    });

    test('passes agent field in master prompt body', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
      });
      const config = createTestCouncilConfig();
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil('test prompt', undefined, 'parent-id');

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body?: { agent?: string } }]
      >;
      // Last prompt call is for master
      const masterCall = promptCalls[promptCalls.length - 1];
      expect(masterCall[0].body?.agent).toBe('council-master');
    });

    test('disables delegation tools in councillor prompt body', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
      });
      const config = createTestCouncilConfig();
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil('test prompt', undefined, 'parent-id');

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body?: { tools?: Record<string, boolean>; agent?: string } }]
      >;
      // Find councillor call by agent field (notification may interleave)
      const councillorCall = promptCalls.find(
        (c) => c[0].body?.agent === 'councillor',
      );
      // Councillor tools: delegation disabled (leaf node)
      expect(councillorCall?.[0].body?.tools).toEqual({
        background_task: false,
        task: false,
      });
    });

    test('disables delegation tools in master prompt body', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
      });
      const config = createTestCouncilConfig();
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil('test prompt', undefined, 'parent-id');

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body?: { tools?: Record<string, boolean> } }]
      >;
      // Master tools: everything disabled
      const masterCall = promptCalls[promptCalls.length - 1];
      expect(masterCall[0].body?.tools).toEqual({
        background_task: false,
        task: false,
      });
    });

    test('creates session with model label in title', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          master: { model: 'anthropic/claude-opus-4-6' },
          presets: {
            default: {
              councillors: {
                alpha: { model: 'openai/gpt-5.4-mini' },
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil('test prompt', undefined, 'parent-id');

      const createCalls = ctx.client.session.create.mock.calls as Array<
        [{ body?: { title?: string } }]
      >;
      // Councillor title: "Council alpha (gpt-5.4-mini)"
      expect(createCalls[0][0].body?.title).toBe(
        'Council alpha (gpt-5.4-mini)',
      );
      // Master title: "Council Master (claude-opus-4-6)"
      const masterCreate = createCalls[createCalls.length - 1];
      expect(masterCreate[0].body?.title).toBe(
        'Council Master (claude-opus-4-6)',
      );
    });

    test('tries master_fallback models on primary failure', async () => {
      let promptCallCount = 0;
      const ctx = createMockContext({
        sessionCreateResult: () => ({ data: { id: 'session-1' } }),
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
        promptImpl: async (args: any) => {
          // Only count agent prompt calls (skip start notification)
          if (args.body?.agent) {
            promptCallCount++;
            // Councillor succeeds, master primary fails, fallback succeeds
            if (promptCallCount === 2) {
              throw new Error('Primary model timeout');
            }
          }
          return {};
        },
      });
      const config: PluginConfig = {
        council: {
          master: { model: 'openai/primary-model' },
          master_fallback: ['anthropic/fallback-model'],
          presets: {
            default: {
              councillors: {
                alpha: { model: 'openai/gpt-5.4-mini' },
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        'test prompt',
        'default',
        'parent-id',
      );

      expect(result.success).toBe(true);
      // 1 councillor + 1 primary master (fail) + 1 fallback master (succeed) = 3
      expect(promptCallCount).toBe(3);
    });

    test('returns error when all master_fallback models fail', async () => {
      let agentPromptCount = 0;
      const ctx = createMockContext({
        sessionCreateResult: () => ({ data: { id: 'session-1' } }),
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Councillor response' }],
            },
          ],
        },
        promptImpl: async (args: any) => {
          // Only count agent prompt calls (skip start notification)
          if (args.body?.agent) {
            agentPromptCount++;
            // Councillor succeeds, all master attempts fail
            if (agentPromptCount > 1) {
              throw new Error('Model unavailable');
            }
          }
          return {};
        },
      });
      const config: PluginConfig = {
        council: {
          master: { model: 'openai/primary-model' },
          master_fallback: ['anthropic/fallback-one', 'google/fallback-two'],
          presets: {
            default: {
              councillors: {
                alpha: { model: 'openai/gpt-5.4-mini' },
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        'test prompt',
        'default',
        'parent-id',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('All master models failed');
      // Should try primary + 2 fallbacks = 3 master attempts
      // 1 councillor + 3 master = 4 total agent prompts
      expect(agentPromptCount).toBe(4);
      // Degraded result from councillor
      expect(result.result).toBeDefined();
    });

    test('passes councillor prompt to councillor session', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response with role guidance' }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          master: { model: 'anthropic/claude-opus-4-6' },
          presets: {
            default: {
              councillors: {
                alpha: {
                  model: 'openai/gpt-5.4-mini',
                  prompt:
                    'You are a meticulous reviewer focused on edge cases.',
                },
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil('test prompt', undefined, 'parent-id');

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [
          {
            body?: {
              parts?: Array<{ type: string; text?: string }>;
              agent?: string;
            };
          },
        ]
      >;
      const councillorCall = promptCalls.find(
        (c) => c[0].body?.agent === 'councillor',
      );
      expect(councillorCall).toBeDefined();
      const promptText = councillorCall?.[0]?.body?.parts?.[0]?.text;
      expect(promptText).toContain('test prompt');
      expect(promptText).toContain(
        'You are a meticulous reviewer focused on edge cases.',
      );
    });

    test('passes master prompt to master session', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Synthesized response' }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          master: {
            model: 'anthropic/claude-opus-4-6',
            prompt: 'Prioritize correctness over creativity.',
          },
          presets: {
            default: {
              councillors: {
                alpha: { model: 'openai/gpt-5.4-mini' },
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil('test prompt', undefined, 'parent-id');

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [
          {
            body?: {
              parts?: Array<{ type: string; text?: string }>;
              agent?: string;
            };
          },
        ]
      >;
      // Last call is master
      const masterCall = promptCalls[promptCalls.length - 1];
      expect(masterCall[0].body?.agent).toBe('council-master');
      const promptText = masterCall[0]?.body?.parts?.[0]?.text;
      expect(promptText).toContain('Prioritize correctness over creativity.');
    });

    test('works without any prompt overrides (backward compatible)', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          master: { model: 'anthropic/claude-opus-4-6' },
          presets: {
            default: {
              councillors: {
                alpha: { model: 'openai/gpt-5.4-mini' },
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      const result = await manager.runCouncil(
        'test prompt',
        undefined,
        'parent-id',
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
          },
        ]
      >;
      const councillorCall = promptCalls.find(
        (c) => c[0].body?.agent === 'councillor',
      );
      // Without prompt override, councillor gets just the raw user prompt
      expect(councillorCall?.[0]?.body?.parts?.[0]?.text).toBe('test prompt');
    });

    test('per-preset master model override replaces global master model', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          master: { model: 'anthropic/claude-opus-4-6' },
          presets: {
            default: {
              councillors: {
                alpha: { model: 'openai/gpt-5.4-mini' },
              },
              master: { model: 'google/gemini-3-pro' },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil('test prompt', undefined, 'parent-id');

      const createCalls = ctx.client.session.create.mock.calls as Array<
        [{ body?: { title?: string } }]
      >;
      // Master title should use the override model, not global
      const masterCreate = createCalls[createCalls.length - 1];
      expect(masterCreate[0].body?.title).toBe('Council Master (gemini-3-pro)');
    });

    test('per-preset master prompt override replaces global master prompt', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          master: {
            model: 'anthropic/claude-opus-4-6',
            prompt: 'Global master prompt.',
          },
          presets: {
            default: {
              councillors: {
                alpha: { model: 'openai/gpt-5.4-mini' },
              },
              master: { prompt: 'Preset-specific master prompt.' },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil('test prompt', undefined, 'parent-id');

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [
          {
            body?: {
              parts?: Array<{ type: string; text?: string }>;
              agent?: string;
            };
          },
        ]
      >;
      const masterCall = promptCalls[promptCalls.length - 1];
      const promptText = masterCall[0]?.body?.parts?.[0]?.text;
      expect(promptText).toContain('Preset-specific master prompt.');
      expect(promptText).not.toContain('Global master prompt.');
    });

    test('per-preset master variant override replaces global variant', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          master: {
            model: 'anthropic/claude-opus-4-6',
            variant: 'low',
          },
          presets: {
            default: {
              councillors: {
                alpha: { model: 'openai/gpt-5.4-mini' },
              },
              master: { variant: 'high' },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil('test prompt', undefined, 'parent-id');

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [{ body?: { variant?: string } }]
      >;
      const masterCall = promptCalls[promptCalls.length - 1];
      expect(masterCall[0].body?.variant).toBe('high');
    });

    test('no per-preset master override falls back to global master config', async () => {
      const ctx = createMockContext({
        sessionMessagesResult: {
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'Response' }],
            },
          ],
        },
      });
      const config: PluginConfig = {
        council: {
          master: {
            model: 'anthropic/claude-opus-4-6',
            variant: 'high',
            prompt: 'Global prompt.',
          },
          presets: {
            default: {
              councillors: {
                alpha: { model: 'openai/gpt-5.4-mini' },
              },
            },
          },
        },
      } as any;
      const manager = new CouncilManager(ctx, config, undefined);

      await manager.runCouncil('test prompt', undefined, 'parent-id');

      const promptCalls = ctx.client.session.prompt.mock.calls as Array<
        [
          {
            body?: {
              parts?: Array<{ type: string; text?: string }>;
              variant?: string;
              agent?: string;
            };
          },
        ]
      >;
      const masterCall = promptCalls[promptCalls.length - 1];
      // Uses global model (in title)
      const createCalls = ctx.client.session.create.mock.calls as Array<
        [{ body?: { title?: string } }]
      >;
      const masterCreate = createCalls[createCalls.length - 1];
      expect(masterCreate[0].body?.title).toBe(
        'Council Master (claude-opus-4-6)',
      );
      // Uses global variant
      expect(masterCall[0].body?.variant).toBe('high');
      // Uses global prompt
      const promptText = masterCall[0]?.body?.parts?.[0]?.text;
      expect(promptText).toContain('Global prompt.');
    });
  });
});
