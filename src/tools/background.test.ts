import { describe, expect, mock, test } from 'bun:test';
import type { PluginConfig } from '../config';
import { createBackgroundTools } from './background';

function createMockManager() {
  return {
    isAgentAllowed: mock(() => true),
    getAllowedSubagents: mock(() => ['oracle']),
    launch: mock(
      (opts: {
        agent: string;
        prompt: string;
        description: string;
        parentSessionId: string;
      }) => ({
        id: 'bg_test1234',
        sessionId: undefined,
        description: opts.description,
        agent: opts.agent,
        status: 'pending',
        startedAt: new Date(),
        config: { maxConcurrentStarts: 10 },
        parentSessionId: opts.parentSessionId,
        prompt: opts.prompt,
      }),
    ),
    getResult: mock(() => null),
    waitForCompletion: mock(async () => null),
    cancel: mock(() => 0),
  };
}

describe('createBackgroundTools displayName runtime aliasing', () => {
  test('resolves displayName alias for background_task direct invocation', async () => {
    const manager = createMockManager();
    const config: PluginConfig = {
      agents: {
        oracle: { displayName: 'advisor' },
      },
    };

    const tools = createBackgroundTools(
      {} as any,
      manager as any,
      undefined,
      config,
    );

    const result = await tools.background_task.execute(
      {
        agent: 'advisor',
        prompt: 'Analyze this architecture',
        description: 'Architecture analysis',
      },
      { sessionID: 'session-1' } as any,
    );

    expect(manager.isAgentAllowed).toHaveBeenCalledWith('session-1', 'oracle');
    expect(manager.launch).toHaveBeenCalledWith({
      agent: 'oracle',
      prompt: 'Analyze this architecture',
      description: 'Architecture analysis',
      parentSessionId: 'session-1',
    });
    expect(result).toContain('Agent: oracle');
  });

  test('keeps internal agent names working for background_task', async () => {
    const manager = createMockManager();
    const config: PluginConfig = {
      agents: {
        oracle: { displayName: 'advisor' },
      },
    };

    const tools = createBackgroundTools(
      {} as any,
      manager as any,
      undefined,
      config,
    );

    await tools.background_task.execute(
      {
        agent: 'oracle',
        prompt: 'Analyze this architecture',
        description: 'Architecture analysis',
      },
      { sessionID: 'session-1' } as any,
    );

    expect(manager.isAgentAllowed).toHaveBeenCalledWith('session-1', 'oracle');
    expect(manager.launch).toHaveBeenCalledWith({
      agent: 'oracle',
      prompt: 'Analyze this architecture',
      description: 'Architecture analysis',
      parentSessionId: 'session-1',
    });
  });
});
