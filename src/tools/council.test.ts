import { describe, expect, mock, test } from 'bun:test';
import type { CouncilResult } from '../config/council-schema';
import type { CouncilManager } from '../council/council-manager';
import { createCouncilTool } from './council';

function createMockPluginContext() {
  return {
    client: {
      session: {
        create: mock(async () => ({})),
        messages: mock(async () => ({})),
        prompt: mock(async () => ({})),
        abort: mock(async () => ({})),
      },
    },
    directory: '/tmp/test',
  } as any;
}

// Test mocks can omit 'model' field — it's filled by the manager, not the test
type TestCouncillorResult = {
  name: string;
  model?: string;
  status: 'completed' | 'failed' | 'timed_out';
  result?: string;
  error?: string;
};

function createMockCouncilManager(
  results: {
    success?: boolean;
    result?: string;
    error?: string;
    councillorResults?: TestCouncillorResult[];
  } = {},
) {
  const councillorResults: CouncilResult['councillorResults'] = (
    results.councillorResults ?? [
      { name: 'alpha', status: 'completed', result: 'Alpha response' },
      { name: 'beta', status: 'completed', result: 'Beta response' },
    ]
  ).map((cr) => ({
    model: 'test/model',
    ...cr,
  }));

  const mockManager = {
    runCouncil: mock(async (): Promise<CouncilResult> => {
      return {
        success: results.success ?? true,
        result: 'result' in results ? results.result : 'Synthesized response',
        error: results.error,
        councillorResults,
      };
    }),
    getDeprecatedFields: mock(() => undefined),
  } as unknown as CouncilManager;

  return mockManager;
}

describe('council_session tool', () => {
  describe('tool definition', () => {
    test('creates council_session tool', () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager();
      const tools = createCouncilTool(ctx, councilManager);

      expect(tools).toBeDefined();
      expect(tools.council_session).toBeDefined();
      expect(tools.council_session.description).toBeDefined();
      expect(tools.council_session.args).toBeDefined();
    });

    test('has correct tool description', () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager();
      const tools = createCouncilTool(ctx, councilManager);

      expect(tools.council_session.description).toContain('multi-LLM');
      expect(tools.council_session.description).toContain('consensus');
      expect(tools.council_session.description).toContain('councillors');
    });

    test('defines required prompt argument', () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager();
      const tools = createCouncilTool(ctx, councilManager);

      expect(tools.council_session.args.prompt).toBeDefined();
      expect(tools.council_session.args).toHaveProperty('prompt');
    });

    test('defines optional preset argument', () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager();
      const tools = createCouncilTool(ctx, councilManager);

      expect(tools.council_session.args.preset).toBeDefined();
      expect(tools.council_session.args).toHaveProperty('preset');
    });
  });

  describe('execute', () => {
    test('calls councilManager.runCouncil with correct arguments', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager();
      const tools = createCouncilTool(ctx, councilManager);

      const _result = await tools.council_session.execute(
        {
          prompt: 'Test prompt',
          preset: 'custom',
        },
        { sessionID: 'test-session-123' } as any,
      );

      expect(councilManager.runCouncil).toHaveBeenCalledTimes(1);
      expect(councilManager.runCouncil).toHaveBeenCalledWith(
        'Test prompt',
        'custom',
        'test-session-123',
      );
    });

    test('uses default preset when not specified', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager();
      const tools = createCouncilTool(ctx, councilManager);

      await tools.council_session.execute({ prompt: 'Test prompt' }, {
        sessionID: 'test-session-123',
      } as any);

      expect(councilManager.runCouncil).toHaveBeenCalledWith(
        'Test prompt',
        undefined,
        'test-session-123',
      );
    });

    test('returns successful council result with output', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager({
        success: true,
        result: 'Synthesized answer from council',
        councillorResults: [
          {
            name: 'alpha',
            model: 'openai/gpt-5.4-mini',
            status: 'completed',
            result: 'Alpha says yes',
          },
          {
            name: 'beta',
            model: 'google/gemini-3-pro',
            status: 'completed',
            result: 'Beta says no',
          },
        ],
      });
      const tools = createCouncilTool(ctx, councilManager);

      const result = await tools.council_session.execute(
        { prompt: 'Test prompt' },
        { sessionID: 'test-session' } as any,
      );

      expect(result).toContain('Synthesized answer from council');
      expect(result).toContain('Council: 2/2 councillors responded');
    });

    test('appends councillor summary to successful result', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager({
        success: true,
        result: 'Main answer',
        councillorResults: [
          { name: 'alpha', status: 'completed', result: 'A' },
          { name: 'beta', status: 'completed', result: 'B' },
          { name: 'gamma', status: 'completed', result: 'G' },
        ],
      });
      const tools = createCouncilTool(ctx, councilManager);

      const result = await tools.council_session.execute({ prompt: 'Test' }, {
        sessionID: 'test',
      } as any);

      expect(result).toContain('Main answer');
      expect(result).toContain('Council: 3/3 councillors responded');
      expect(result).toMatch(/---\s*\*Council:/);
    });

    test('handles mixed councillor success/failure in summary', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager({
        success: true,
        result: 'Answer',
        councillorResults: [
          { name: 'alpha', status: 'completed', result: 'A' },
          { name: 'beta', status: 'failed', error: 'Error' },
          { name: 'gamma', status: 'completed', result: 'G' },
        ],
      });
      const tools = createCouncilTool(ctx, councilManager);

      const result = await tools.council_session.execute({ prompt: 'Test' }, {
        sessionID: 'test',
      } as any);

      // Summary should only count completed councillors
      expect(result).toContain('Council: 2/3 councillors responded');
    });

    test('handles all councillors failing', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager({
        success: false,
        error: 'All councillors failed',
        result: undefined,
        councillorResults: [
          { name: 'alpha', status: 'failed', error: 'Failed' },
          { name: 'beta', status: 'timed_out', error: 'Timeout' },
        ],
      });
      const tools = createCouncilTool(ctx, councilManager);

      const result = await tools.council_session.execute({ prompt: 'Test' }, {
        sessionID: 'test',
      } as any);

      expect(result).toContain('Council session failed');
      expect(result).toContain('All councillors failed');
    });

    test('handles case when result is undefined', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager({
        success: true,
        result: undefined,
        councillorResults: [
          { name: 'alpha', status: 'completed', result: 'A' },
        ],
      });
      const tools = createCouncilTool(ctx, councilManager);

      const result = await tools.council_session.execute({ prompt: 'Test' }, {
        sessionID: 'test',
      } as any);

      // Tool uses result ?? '(No output)', so it should show (No output)
      // But the mock manager is returning undefined in the outer object
      // The tool actually gets the result from the returned object
      expect(result).toContain('Council: 1/1 councillors responded');
    });

    test('converts prompt to string', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager();
      const tools = createCouncilTool(ctx, councilManager);

      await tools.council_session.execute({ prompt: 12345 as any }, {
        sessionID: 'test',
      } as any);

      expect(councilManager.runCouncil).toHaveBeenCalledWith(
        '12345',
        undefined,
        'test',
      );
    });

    test('handles preset as non-string (falls back to undefined)', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager();
      const tools = createCouncilTool(ctx, councilManager);

      await tools.council_session.execute(
        { preset: 123 as any, prompt: 'Test' },
        { sessionID: 'test' } as any,
      );

      expect(councilManager.runCouncil).toHaveBeenCalledWith(
        'Test',
        undefined,
        'test',
      );
    });
  });

  describe('error handling', () => {
    test('throws error when toolContext is missing', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager();
      const tools = createCouncilTool(ctx, councilManager);

      await expect(
        tools.council_session.execute({ prompt: 'Test' }, undefined as any),
      ).rejects.toThrow('Invalid toolContext');
    });

    test('throws error when toolContext is not object', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager();
      const tools = createCouncilTool(ctx, councilManager);

      await expect(
        tools.council_session.execute({ prompt: 'Test' }, 'invalid' as any),
      ).rejects.toThrow('Invalid toolContext');
    });

    test('throws error when toolContext is missing sessionID', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager();
      const tools = createCouncilTool(ctx, councilManager);

      await expect(
        tools.council_session.execute({ prompt: 'Test' }, {} as any),
      ).rejects.toThrow('Invalid toolContext');
    });

    test('handles CouncilManager throwing exception', async () => {
      const ctx = createMockPluginContext();
      const councilManager = {
        runCouncil: mock(async () => {
          throw new Error('Council manager crashed');
        }),
        getDeprecatedFields: mock(() => undefined),
      } as unknown as CouncilManager;
      const tools = createCouncilTool(ctx, councilManager);

      await expect(
        tools.council_session.execute({ prompt: 'Test' }, {
          sessionID: 'test',
        } as any),
      ).rejects.toThrow('Council manager crashed');
    });
  });

  describe('agent guard', () => {
    test('allows council agent to invoke council session', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager({
        success: true,
        result: 'Synthesised answer',
        councillorResults: [
          { name: 'alpha', status: 'completed', result: 'A' },
        ],
      });
      const tools = createCouncilTool(ctx, councilManager);

      const result = await tools.council_session.execute({ prompt: 'Test' }, {
        sessionID: 'test',
        agent: 'council',
      } as any);

      expect(result).toContain('Synthesised answer');
      expect(councilManager.runCouncil).toHaveBeenCalledTimes(1);
    });

    test('blocks orchestrator agent from invoking council session', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager();
      const tools = createCouncilTool(ctx, councilManager);

      expect(
        tools.council_session.execute({ prompt: 'Test' }, {
          sessionID: 'test',
          agent: 'orchestrator',
        } as any),
      ).rejects.toThrow(
        'Council sessions can only be invoked by the council agent',
      );
      expect(councilManager.runCouncil).not.toHaveBeenCalled();
    });

    test('blocks disallowed agents from invoking council session', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager();
      const tools = createCouncilTool(ctx, councilManager);

      expect(
        tools.council_session.execute({ prompt: 'Test' }, {
          sessionID: 'test',
          agent: 'explorer',
        } as any),
      ).rejects.toThrow(
        'Council sessions can only be invoked by the council agent',
      );
      expect(councilManager.runCouncil).not.toHaveBeenCalled();
    });

    test('allows undefined agent (backward compatible)', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager({
        success: true,
        result: 'Synthesised answer',
        councillorResults: [
          { name: 'alpha', status: 'completed', result: 'A' },
        ],
      });
      const tools = createCouncilTool(ctx, councilManager);

      const result = await tools.council_session.execute({ prompt: 'Test' }, {
        sessionID: 'test',
      } as any);

      expect(result).toContain('Synthesised answer');
      expect(councilManager.runCouncil).toHaveBeenCalledTimes(1);
    });
  });

  describe('edge cases', () => {
    test('handles empty councillor results', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager({
        success: false,
        error: 'No councillors',
        result: undefined,
        councillorResults: [],
      });
      const tools = createCouncilTool(ctx, councilManager);

      const result = await tools.council_session.execute({ prompt: 'Test' }, {
        sessionID: 'test',
      } as any);

      // When success is false, tool returns error message without summary
      expect(result).toContain('Council session failed');
      expect(result).toContain('No councillors');
    });

    test('handles all councillors timed out', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager({
        success: false,
        error: 'All timed out',
        result: undefined,
        councillorResults: [
          { name: 'alpha', status: 'timed_out', error: 'Timeout' },
          { name: 'beta', status: 'timed_out', error: 'Timeout' },
        ],
      });
      const tools = createCouncilTool(ctx, councilManager);

      const result = await tools.council_session.execute({ prompt: 'Test' }, {
        sessionID: 'test',
      } as any);

      // When success is false, tool returns error message without summary
      expect(result).toContain('Council session failed');
      expect(result).toContain('All timed out');
    });

    test('handles single successful councillor', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager({
        success: true,
        result: 'Single result',
        councillorResults: [
          { name: 'solo', status: 'completed', result: 'Solo answer' },
        ],
      });
      const tools = createCouncilTool(ctx, councilManager);

      const result = await tools.council_session.execute({ prompt: 'Test' }, {
        sessionID: 'test',
      } as any);

      expect(result).toContain('Single result');
      expect(result).toContain('Council: 1/1 councillors responded');
    });

    test('handles many councillors', async () => {
      const ctx = createMockPluginContext();
      const councilManager = createMockCouncilManager({
        success: true,
        result: 'Multi result',
        councillorResults: Array.from({ length: 10 }, (_, i) => ({
          name: `councillor${i}`,
          status: 'completed',
          result: `Response ${i}`,
        })),
      });
      const tools = createCouncilTool(ctx, councilManager);

      const result = await tools.council_session.execute({ prompt: 'Test' }, {
        sessionID: 'test',
      } as any);

      expect(result).toContain('Council: 10/10 councillors responded');
    });

    test('includes deprecation warning when deprecated config fields detected', async () => {
      const ctx = createMockPluginContext();
      const councilManager = {
        runCouncil: mock(async () => ({
          success: true,
          result: 'Synthesized response',
          councillorResults: [
            {
              name: 'alpha',
              model: 'test/model',
              status: 'completed',
              result: 'Response',
            },
          ],
        })),
        getDeprecatedFields: mock(() => ['master', 'master_timeout']),
      } as unknown as CouncilManager;
      const tools = createCouncilTool(ctx, councilManager);

      const result = await tools.council_session.execute({ prompt: 'Test' }, {
        sessionID: 'test',
      } as any);

      expect(result).toContain('Config warning');
      expect(result).toContain('`council.master`');
      expect(result).toContain('`council.master_timeout`');
      expect(result).toContain('deprecated and ignored');
    });
  });
});
