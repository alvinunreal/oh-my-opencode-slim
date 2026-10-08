import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  BackgroundJobBoard,
  createBackgroundJobLifecycle,
} from '../background-jobs';
import { createTaskMessageTool } from './task-message';
import { idParamFor, readTaskRef, taskRefArgs } from './task-ref';
import { createTaskResultTool } from './task-result';
import { createTaskStatusTool } from './task-status';

const asJobs = (board: BackgroundJobBoard) =>
  createBackgroundJobLifecycle({ backgroundJobBoard: board });

/**
 * Mirror `src/v2/setup.ts`'s `schemaFor` (`z.object(def.args)` →
 * `z.toJSONSchema`): a schema `required` entry rejects an alias-only call
 * before `execute()` runs, so the host path must be asserted, not `execute()`.
 */
function hostShape(def: { args?: unknown }) {
  return z.object((def.args ?? {}) as never);
}

function v2ControlTools() {
  const board = new BackgroundJobBoard();
  const input = { directory: '/test', client: {}, hostFlavor: 'v2' } as never;
  return [
    {
      name: 'task_result',
      def: createTaskResultTool({ input, backgroundJobs: asJobs(board) })
        .task_result,
      base: {},
    },
    {
      name: 'task_status',
      def: createTaskStatusTool({ input, backgroundJobs: asJobs(board) })
        .task_status,
      base: {},
    },
    {
      name: 'task_message',
      def: createTaskMessageTool({ input, backgroundJobs: asJobs(board) })
        .task_message,
      base: { message: 'hi' },
    },
  ];
}

describe('task-ref', () => {
  test('idParamFor resolves the identifier param per host flavor', () => {
    expect(idParamFor({ hostFlavor: 'v2' })).toBe('sessionID');
    expect(idParamFor({ hostFlavor: 'v1' })).toBe('task_id');
    expect(idParamFor({})).toBe('task_id');
    expect(idParamFor(undefined)).toBe('task_id');
  });

  test('taskRefArgs exposes sessionID plus a task_id alias on v2', () => {
    expect(Object.keys(taskRefArgs('sessionID'))).toEqual([
      'sessionID',
      'task_id',
    ]);
  });

  test('taskRefArgs exposes only task_id on v1', () => {
    expect(Object.keys(taskRefArgs('task_id'))).toEqual(['task_id']);
  });

  test('readTaskRef prefers the native param and falls back to the alias', () => {
    expect(
      readTaskRef({ sessionID: 'ses_1', task_id: 'ses_2' }, 'sessionID'),
    ).toBe('ses_1');
    expect(readTaskRef({ task_id: 'ses_2' }, 'sessionID')).toBe('ses_2');
    expect(readTaskRef({ sessionID: 'ses_3' }, 'task_id')).toBe('ses_3');
  });

  test('readTaskRef trims and returns empty when absent or non-string', () => {
    expect(readTaskRef({ sessionID: '  ses_1  ' }, 'sessionID')).toBe('ses_1');
    expect(readTaskRef({}, 'sessionID')).toBe('');
    expect(readTaskRef({ sessionID: 42 }, 'sessionID')).toBe('');
  });

  test('v2 host schemas accept alias-only and native-only identifier calls', () => {
    for (const { name, def, base } of v2ControlTools()) {
      const schema = hostShape(def);
      expect({
        name,
        task_id: schema.safeParse({ ...base, task_id: 'ses_1' }).success,
      }).toEqual({ name, task_id: true });
      expect({
        name,
        sessionID: schema.safeParse({ ...base, sessionID: 'ses_1' }).success,
      }).toEqual({ name, sessionID: true });
    }
  });

  test('v2 host schemas leave identifier presence to execution', () => {
    for (const { def, base } of v2ControlTools()) {
      expect(hostShape(def).safeParse(base).success).toBe(true);
    }
  });

  test('v2 host JSON schemas never list sessionID as required', () => {
    const toJSONSchema = (
      z as unknown as { toJSONSchema?: (schema: unknown) => unknown }
    ).toJSONSchema;
    if (typeof toJSONSchema !== 'function') return;
    for (const { def } of v2ControlTools()) {
      const json = toJSONSchema(hostShape(def)) as { required?: string[] };
      expect(json.required ?? []).not.toContain('sessionID');
    }
  });

  test('v1 host schemas still require task_id and reject sessionID', () => {
    const board = new BackgroundJobBoard();
    for (const extra of [{}, { hostFlavor: 'v1' }]) {
      const input = { directory: '/test', client: {}, ...extra } as never;
      const def = createTaskStatusTool({
        input,
        backgroundJobs: asJobs(board),
      }).task_status;
      const schema = hostShape(def);
      expect(schema.safeParse({ task_id: 'ses_1' }).success).toBe(true);
      expect(schema.safeParse({ sessionID: 'ses_1' }).success).toBe(false);
      const toJSONSchema = (
        z as unknown as { toJSONSchema?: (s: unknown) => unknown }
      ).toJSONSchema;
      if (typeof toJSONSchema === 'function') {
        const json = toJSONSchema(schema) as { required?: string[] };
        expect(json.required ?? []).toContain('task_id');
      }
    }
  });

  test('task_message reports a missing id instead of an unknown task', async () => {
    const board = new BackgroundJobBoard();
    const input = { directory: '/test', client: {}, hostFlavor: 'v2' } as never;
    const { task_message } = createTaskMessageTool({
      input,
      backgroundJobs: asJobs(board),
    });
    await expect(
      task_message.execute(
        { message: 'hi' } as never,
        {
          sessionID: 'parent-1',
        } as never,
      ),
    ).rejects.toThrow('task_message requires sessionID');
  });
});
