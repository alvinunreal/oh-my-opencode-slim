import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SubagentDepthTracker } from '../../utils/subagent-depth';
import { createSubtaskState } from './state';
import { createReadSessionTool, createSubtaskTool } from './tools';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omos-subtask-tool-'));
}

describe('subtask tool', () => {
  test('runs a worker child session and returns its subtask summary', async () => {
    const directory = makeTempDir();
    try {
      fs.mkdirSync(path.join(directory, 'src'));
      fs.writeFileSync(path.join(directory, 'src/index.ts'), 'export {}\n');

      const sessionCreate = mock(async () => ({ data: { id: 'ses_new' } }));
      const sessionPrompt = mock(async () => ({}));
      const sessionMessages = mock(async () => ({
        data: [
          {
            info: { role: 'assistant' },
            parts: [
              {
                type: 'text',
                text: '<subtask_summary>\nSummary from worker\n</subtask_summary>',
              },
            ],
          },
        ],
      }));
      const sessionAbort = mock(async () => ({}));
      const state = createSubtaskState();
      const tool = createSubtaskTool(
        {
          directory,
          client: {
            session: {
              abort: sessionAbort,
              create: sessionCreate,
              messages: sessionMessages,
              prompt: sessionPrompt,
            },
          },
        } as any,
        state,
        new SubagentDepthTracker(),
      );

      const result = await tool.execute(
        { prompt: 'Continue implementation', files: ['src/index.ts'] },
        { sessionID: 'ses_old' } as any,
      );

      expect(result).toContain('task_id: ses_new');
      expect(result).toContain('<subtask_summary>');
      expect(result).toContain('Summary from worker');
      expect(result.match(/<subtask_summary>/g)).toHaveLength(1);
      expect(result.match(/<\/subtask_summary>/g)).toHaveLength(1);
      expect(sessionCreate).toHaveBeenCalledWith({
        responseStyle: 'data',
        throwOnError: true,
        query: { directory },
        body: {
          parentID: 'ses_old',
          title: 'Subtask worker from ses_old',
        },
      });
      expect(sessionPrompt).toHaveBeenCalledTimes(1);
      const promptCall = sessionPrompt.mock.calls[0]?.[0] as {
        path: { id: string };
        body: {
          agent: string;
          parts: Array<Record<string, unknown>>;
          tools?: Record<string, boolean>;
        };
      };
      expect(promptCall.path.id).toBe('ses_new');
      expect(promptCall.body.agent).toBe('orchestrator');
      expect(promptCall.body.tools).toBeUndefined();
      const workerPrompt = String(promptCall.body.parts[0]?.text);
      expect(promptCall.body.parts[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining(
          'You are a subtask worker spawned by parent session ses_old',
        ),
      });
      expect(workerPrompt).toContain('Your job is bounded');
      expect(workerPrompt).toContain('TASK:');
      expect(workerPrompt).toContain('FILES PROVIDED:');
      expect(workerPrompt).toContain('<subtask_summary>');
      expect(promptCall.body.parts).toContainEqual(
        expect.objectContaining({ synthetic: true, type: 'text' }),
      );
      expect(sessionMessages).toHaveBeenCalledWith({
        path: { id: 'ses_new' },
        query: { directory },
      });
      expect(sessionAbort).toHaveBeenCalledWith({
        path: { id: 'ses_new' },
        query: { directory },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('normalizes nested worker summary tags', async () => {
    const directory = makeTempDir();
    try {
      const sessionCreate = mock(async () => ({ data: { id: 'ses_new' } }));
      const sessionPrompt = mock(async () => ({}));
      const sessionMessages = mock(async () => ({
        data: [
          {
            info: { role: 'assistant' },
            parts: [
              {
                type: 'text',
                text: '<subtask_summary><subtask_summary>Inner</subtask_summary></subtask_summary>',
              },
            ],
          },
        ],
      }));
      const sessionAbort = mock(async () => ({}));
      const state = createSubtaskState();
      const tool = createSubtaskTool(
        {
          directory,
          client: {
            session: {
              abort: sessionAbort,
              create: sessionCreate,
              messages: sessionMessages,
              prompt: sessionPrompt,
            },
          },
        } as any,
        state,
      );

      const result = await tool.execute({ prompt: 'Summarize only' }, {
        sessionID: 'ses_old',
      } as any);

      expect(result).toContain('Inner');
      expect(result.match(/<subtask_summary>/g)).toHaveLength(1);
      expect(result.match(/<\/subtask_summary>/g)).toHaveLength(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('aborts child session when parent tool call is cancelled', async () => {
    const directory = makeTempDir();
    const controller = new AbortController();
    try {
      const sessionCreate = mock(async () => ({ data: { id: 'ses_new' } }));
      const sessionPrompt = mock(() => {
        setTimeout(() => controller.abort(), 0);
        return new Promise(() => {});
      });
      const sessionMessages = mock(async () => ({ data: [] }));
      const sessionAbort = mock(async () => ({}));
      const state = createSubtaskState();
      const tool = createSubtaskTool(
        {
          directory,
          client: {
            session: {
              abort: sessionAbort,
              create: sessionCreate,
              messages: sessionMessages,
              prompt: sessionPrompt,
            },
          },
        } as any,
        state,
      );

      await expect(
        tool.execute({ prompt: 'Cancel me' }, {
          sessionID: 'ses_old',
          abort: controller.signal,
        } as any),
      ).rejects.toThrow('Prompt cancelled');

      expect(sessionAbort).toHaveBeenCalledWith({
        path: { id: 'ses_new' },
        query: { directory },
      });
      expect(state.isSubtaskSession('ses_new')).toBe(false);
      expect(sessionMessages).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('blocks nested subtask calls from a subtask worker', async () => {
    const directory = makeTempDir();
    try {
      let nestedResult = '';
      const state = createSubtaskState();
      const tool = createSubtaskTool(
        {
          directory,
          client: {
            session: {
              abort: mock(async () => ({})),
              create: mock(async () => ({ data: { id: 'ses_subtask' } })),
              messages: mock(async () => ({
                data: [
                  {
                    info: { role: 'assistant' },
                    parts: [{ type: 'text', text: 'done' }],
                  },
                ],
              })),
              prompt: mock(async () => {
                nestedResult = String(
                  await tool.execute({ prompt: 'nested subtask' }, {
                    sessionID: 'ses_subtask',
                  } as any),
                );
              }),
            },
          },
        } as any,
        state,
        new SubagentDepthTracker(),
      );

      await tool.execute({ prompt: 'outer subtask' }, {
        sessionID: 'ses_old',
      } as any);

      expect(nestedResult).toContain('Nested subtask is disabled');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('read_session tool', () => {
  test('formats session transcripts', async () => {
    const messages = mock(async () => ({
      data: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'Hi' }] },
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'text', text: 'Hello' },
            {
              type: 'tool',
              tool: 'read',
              state: { status: 'completed', title: 'Read file' },
            },
          ],
        },
      ],
    }));
    const state = createSubtaskState();
    state.markSession('ses_worker', 'ses_old');

    const result = await createReadSessionTool(
      { session: { messages } } as any,
      state,
    ).execute({ sessionID: 'ses_old' }, { sessionID: 'ses_worker' } as any);

    expect(result).toContain('## User');
    expect(result).toContain('Hi');
    expect(result).toContain('## Assistant');
    expect(result).toContain('[Tool: read] Read file');
  });

  test('blocks reads outside the source session', async () => {
    const state = createSubtaskState();
    state.markSession('ses_worker', 'ses_old');
    const messages = mock(async () => ({ data: [] }));

    const result = await createReadSessionTool(
      { session: { messages } } as any,
      state,
    ).execute({ sessionID: 'ses_other' }, { sessionID: 'ses_worker' } as any);

    expect(result).toContain('can only read the source session');
    expect(messages).not.toHaveBeenCalled();
  });
});
