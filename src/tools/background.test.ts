import { describe, expect, mock, test } from 'bun:test';
import { BackgroundTaskManager } from '../background/background-manager';
import { createBackgroundTools } from './background';

// Mock the plugin context
function createMockContext() {
  let callCount = 0;
  return {
    client: {
      session: {
        create: mock(async () => {
          callCount++;
          return { data: { id: `test-session-${callCount}` } };
        }),
        status: mock(async () => ({ data: {} })),
        messages: mock(async () => ({ data: [] })),
        prompt: mock(async () => ({})),
      },
    },
    directory: '/test/directory',
  } as any;
}

/**
 * Helper to extract the agent argument description from the tool definition.
 * The agent names are embedded in the Zod schema description for the `agent`
 * arg, accessible via `args.agent.description` on the ToolDefinition.
 */
function getAgentArgDescription(
  tools: ReturnType<typeof createBackgroundTools>,
): string {
  // ToolDefinition.args is the ZodRawShape, and agent is a ZodString
  // with .describe() set — Zod exposes that as schema.description
  const agentSchema = (tools.background_task.args as any).agent;
  return (agentSchema?.description as string) ?? '';
}

describe('createBackgroundTools', () => {
  describe('granularFixers filtering in tool description', () => {
    test('background_task tool description excludes long-fixer and quick-fixer when granularFixers is disabled', () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx);

      // No pluginConfig => granularFixers defaults to false
      const tools = createBackgroundTools(ctx, manager, undefined, undefined);
      const description = getAgentArgDescription(tools);

      expect(description).not.toContain('long-fixer');
      expect(description).not.toContain('quick-fixer');
    });

    test('background_task tool description excludes long-fixer and quick-fixer when granularFixers is explicitly false', () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx, undefined, {
        experimental: { granularFixers: false },
      });

      const tools = createBackgroundTools(ctx, manager, undefined, {
        experimental: { granularFixers: false },
      });
      const description = getAgentArgDescription(tools);

      expect(description).not.toContain('long-fixer');
      expect(description).not.toContain('quick-fixer');
    });

    test('background_task tool description includes long-fixer and quick-fixer when granularFixers is enabled', () => {
      const ctx = createMockContext();
      const manager = new BackgroundTaskManager(ctx, undefined, {
        experimental: { granularFixers: true },
      });

      const tools = createBackgroundTools(ctx, manager, undefined, {
        experimental: { granularFixers: true },
      });
      const description = getAgentArgDescription(tools);

      expect(description).toContain('long-fixer');
      expect(description).toContain('quick-fixer');
    });

    test('background_task tool description always includes base subagents regardless of granularFixers', () => {
      const ctx = createMockContext();
      const baseAgents = [
        'explorer',
        'librarian',
        'oracle',
        'designer',
        'fixer',
      ];

      // When granularFixers is disabled
      const managerDisabled = new BackgroundTaskManager(ctx);
      const toolsDisabled = createBackgroundTools(
        ctx,
        managerDisabled,
        undefined,
        undefined,
      );
      const descDisabled = getAgentArgDescription(toolsDisabled);

      for (const agent of baseAgents) {
        expect(descDisabled).toContain(agent);
      }

      // When granularFixers is enabled
      const managerEnabled = new BackgroundTaskManager(ctx, undefined, {
        experimental: { granularFixers: true },
      });
      const toolsEnabled = createBackgroundTools(
        ctx,
        managerEnabled,
        undefined,
        { experimental: { granularFixers: true } },
      );
      const descEnabled = getAgentArgDescription(toolsEnabled);

      for (const agent of baseAgents) {
        expect(descEnabled).toContain(agent);
      }
    });
  });
});
