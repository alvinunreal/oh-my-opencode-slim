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
        questions: [],
      }),
    ),
    getResult: mock(() => null),
    waitForCompletion: mock(async () => null),
    cancel: mock(() => 0),
    addQuestion: mock(() => true),
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

describe('ask_orchestrator tool', () => {
  test('records question via manager.addQuestion with session context', async () => {
    const manager = createMockManager();
    const tools = createBackgroundTools(
      {} as any,
      manager as any,
      undefined,
      undefined,
    );

    const result = await tools.ask_orchestrator.execute(
      { question: 'Should I use REST or GraphQL?' },
      { sessionID: 'session-bg-1' } as any,
    );

    expect(manager.addQuestion).toHaveBeenCalledWith(
      'session-bg-1',
      'Should I use REST or GraphQL?',
    );
    expect(result).toContain('Question recorded');
    expect(result).toContain('[ASSUMED:');
  });

  test('returns non-blocking response even without session context', async () => {
    const manager = createMockManager();
    const tools = createBackgroundTools(
      {} as any,
      manager as any,
      undefined,
      undefined,
    );

    const result = await tools.ask_orchestrator.execute(
      { question: 'What framework should I use?' },
      undefined,
    );

    expect(manager.addQuestion).not.toHaveBeenCalled();
    expect(result).toContain('Continue');
  });

  test('returns non-blocking response when task not found', async () => {
    const manager = createMockManager();
    manager.addQuestion = mock(() => false); // task not found
    const tools = createBackgroundTools(
      {} as any,
      manager as any,
      undefined,
      undefined,
    );

    const result = await tools.ask_orchestrator.execute(
      { question: 'Should I add tests?' },
      { sessionID: 'session-cleaned-up' } as any,
    );

    expect(manager.addQuestion).toHaveBeenCalledWith(
      'session-cleaned-up',
      'Should I add tests?',
    );
    // Still non-blocking
    expect(result).toContain('Continue');
  });
});

describe('background_output surfaces questions', () => {
  test('includes relayed questions in completed task output', async () => {
    const manager = createMockManager();
    const completedAt = new Date();
    manager.getResult = mock(() => ({
      id: 'bg_test1234',
      description: 'Architecture analysis',
      status: 'completed',
      result: 'Use REST for this endpoint.',
      startedAt: new Date(completedAt.getTime() - 5000),
      completedAt,
      questions: ['Should I use REST or GraphQL?', 'Should I add pagination?'],
    }));

    const tools = createBackgroundTools(
      {} as any,
      manager as any,
      undefined,
      undefined,
    );

    const result = await tools.background_output.execute({
      task_id: 'bg_test1234',
    });

    expect(result).toContain('Use REST for this endpoint.');
    expect(result).toContain('Questions relayed from subagent');
    expect(result).toContain('Should I use REST or GraphQL?');
    expect(result).toContain('Should I add pagination?');
  });

  test('no questions section when questions array is empty', async () => {
    const manager = createMockManager();
    const completedAt = new Date();
    manager.getResult = mock(() => ({
      id: 'bg_test1234',
      description: 'Simple task',
      status: 'completed',
      result: 'Done.',
      startedAt: new Date(completedAt.getTime() - 1000),
      completedAt,
      questions: [],
    }));

    const tools = createBackgroundTools(
      {} as any,
      manager as any,
      undefined,
      undefined,
    );

    const result = await tools.background_output.execute({
      task_id: 'bg_test1234',
    });

    expect(result).toContain('Done.');
    expect(result).not.toContain('Questions relayed');
  });
});
