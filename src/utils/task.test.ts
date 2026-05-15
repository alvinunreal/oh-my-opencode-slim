import { describe, expect, test } from 'bun:test';
import {
  parseTaskIdFromTaskOutput,
  parseTaskLaunchOutput,
  parseTaskResultFromOutput,
  parseTaskStatusOutput,
} from './task';

describe('parseTaskIdFromTaskOutput', () => {
  test('parses task_id line from successful task tool output', () => {
    const output = [
      'task_id: session-abc-123 (for resuming to continue this task if needed)',
      '',
      '<task_result>',
      'done',
      '</task_result>',
    ].join('\n');

    expect(parseTaskIdFromTaskOutput(output)).toBe('session-abc-123');
  });

  test('returns undefined when task_id is absent', () => {
    const output = ['<task_result>', 'no task id here', '</task_result>'].join(
      '\n',
    );

    expect(parseTaskIdFromTaskOutput(output)).toBeUndefined();
  });
});

describe('parseTaskLaunchOutput', () => {
  test('parses background task launch output only when state is running', () => {
    const output = [
      'task_id: ses_123 (for polling this task with task_status)',
      'state: running',
      '',
      '<task_result>',
      'Background task started.',
      '</task_result>',
    ].join('\n');

    expect(parseTaskLaunchOutput(output)).toEqual({
      taskID: 'ses_123',
      state: 'running',
      result: 'Background task started.',
    });
  });

  test('ignores blocking task output without running state', () => {
    const output = [
      'task_id: ses_123 (for resuming to continue this task if needed)',
      '',
      '<task_result>',
      'completed result',
      '</task_result>',
    ].join('\n');

    expect(parseTaskLaunchOutput(output)).toBeUndefined();
  });

  test('ignores state lines inside task result body', () => {
    const output = [
      'task_id: ses_123 (for resuming to continue this task if needed)',
      '',
      '<task_result>',
      'state: running',
      '</task_result>',
    ].join('\n');

    expect(parseTaskLaunchOutput(output)).toBeUndefined();
  });
});

describe('parseTaskStatusOutput', () => {
  test('parses completed status output with task result', () => {
    const output = [
      'task_id: ses_123',
      'state: completed',
      '',
      '<task_result>',
      'done',
      '</task_result>',
    ].join('\n');

    expect(parseTaskStatusOutput(output)).toEqual({
      taskID: 'ses_123',
      state: 'completed',
      timedOut: false,
      result: 'done',
    });
  });

  test('parses error status output with task_error', () => {
    const output = [
      'task_id: ses_123',
      'state: error',
      '',
      '<task_error>',
      'failed hard',
      '</task_error>',
    ].join('\n');

    expect(parseTaskStatusOutput(output)).toEqual({
      taskID: 'ses_123',
      state: 'error',
      timedOut: false,
      result: 'failed hard',
    });
  });

  test('parses cancelled status output with task_error', () => {
    const output = [
      'task_id: ses_123',
      'state: cancelled',
      '',
      '<task_error>',
      'cancelled by user',
      '</task_error>',
    ].join('\n');

    expect(parseTaskStatusOutput(output)).toEqual({
      taskID: 'ses_123',
      state: 'cancelled',
      timedOut: false,
      result: 'cancelled by user',
    });
  });

  test('keeps timeout as running with timedOut overlay', () => {
    const output = [
      'task_id: ses_123',
      'state: running',
      '',
      '<task_result>',
      'Timed out after 120000ms while waiting for task completion.',
      '</task_result>',
    ].join('\n');

    expect(parseTaskStatusOutput(output)).toEqual({
      taskID: 'ses_123',
      state: 'running',
      timedOut: true,
      result: 'Timed out after 120000ms while waiting for task completion.',
    });
  });

  test('returns undefined when state is absent', () => {
    expect(parseTaskStatusOutput('task_id: ses_123')).toBeUndefined();
  });
});

describe('parseTaskResultFromOutput', () => {
  test('extracts trimmed task result block', () => {
    expect(
      parseTaskResultFromOutput(
        ['<task_result>', '  hello  ', '</task_result>'].join('\n'),
      ),
    ).toBe('hello');
  });

  test('extracts task error block', () => {
    expect(
      parseTaskResultFromOutput(
        ['<task_error>', '  broken  ', '</task_error>'].join('\n'),
      ),
    ).toBe('broken');
  });

  test('returns undefined for mismatched tags', () => {
    // Opening with task_result but closing with task_error
    expect(
      parseTaskResultFromOutput(
        ['<task_result>', 'content', '</task_error>'].join('\n'),
      ),
    ).toBeUndefined();

    // Opening with task_error but closing with task_result
    expect(
      parseTaskResultFromOutput(
        ['<task_error>', 'content', '</task_result>'].join('\n'),
      ),
    ).toBeUndefined();
  });

  test('requires matching open and close tags via backreference', () => {
    // Valid: task_result with task_result
    expect(parseTaskResultFromOutput('<task_result>data</task_result>')).toBe(
      'data',
    );

    // Valid: task_error with task_error
    expect(
      parseTaskResultFromOutput('<task_error>error data</task_error>'),
    ).toBe('error data');

    // Invalid: mismatched
    expect(
      parseTaskResultFromOutput('<task_result>data</task_error>'),
    ).toBeUndefined();
    expect(
      parseTaskResultFromOutput('<task_error>data</task_result>'),
    ).toBeUndefined();
  });
});
