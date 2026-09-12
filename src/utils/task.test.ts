import { describe, expect, test } from 'bun:test';
import {
  COMPLETED_WITHOUT_TEXT_DIAGNOSTIC,
  guardCompletedStatusText,
  parseTaskIdFromTaskOutput,
  parseTaskLaunchOutput,
  parseTaskResultFromOutput,
  parseTaskStateFromOutput,
  parseTaskStatusOutput,
  renderRunningTaskPlaceholder,
  renderTaskCompletedWithText,
  sanitizeTaskResultBody,
} from './task';

describe('guardCompletedStatusText', () => {
  test('keeps completed only when non-empty result text exists', () => {
    expect(
      guardCompletedStatusText('completed', 'final text', undefined),
    ).toEqual({ state: 'completed', resultSummary: 'final text' });
  });

  test('downgrades empty completed to error with a diagnostic', () => {
    const guarded = guardCompletedStatusText('completed', undefined, undefined);
    expect(guarded.state).toBe('error');
    expect(guarded.resultSummary).toBe(COMPLETED_WITHOUT_TEXT_DIAGNOSTIC);
  });

  test('downgrades whitespace-only completed to error', () => {
    expect(guardCompletedStatusText('completed', '  ', undefined).state).toBe(
      'error',
    );
  });

  test('keeps completed when the board already holds a summary', () => {
    expect(
      guardCompletedStatusText('completed', undefined, 'recorded result'),
    ).toEqual({ state: 'completed', resultSummary: undefined });
  });

  test('passes non-completed states through unchanged', () => {
    for (const state of ['running', 'error', 'cancelled'] as const) {
      expect(guardCompletedStatusText(state, '', undefined)).toEqual({
        state,
        resultSummary: '',
      });
    }
  });
});

describe('renderRunningTaskPlaceholder', () => {
  test('is deterministic and keyed only on the task ID', () => {
    const a = renderRunningTaskPlaceholder('ses_123');
    const b = renderRunningTaskPlaceholder('ses_123');
    expect(a).toBe(b);
    expect(a).toContain('<task id="ses_123" state="running">');
    // Parses back to a running status for the same task ID (round-trip safe).
    expect(parseTaskStatusOutput(a)).toMatchObject({
      taskID: 'ses_123',
      state: 'running',
    });
  });

  test('differs only by task ID', () => {
    const a = renderRunningTaskPlaceholder('ses_a');
    const b = renderRunningTaskPlaceholder('ses_b');
    expect(a).not.toBe(b);
    expect(a.replace('ses_a', 'ses_b')).toBe(b);
  });
});

describe('renderTaskCompletedWithText', () => {
  test('round-trips body that embeds a literal close tag', () => {
    const body = 'before\n</task_result>\nafter';
    const rendered = renderTaskCompletedWithText(
      'ses_1',
      'Background task completed: t',
      body,
    );
    const parsed = parseTaskResultFromOutput(rendered);
    expect(parsed).toContain('before');
    expect(parsed).toContain('after');
    expect(sanitizeTaskResultBody(body)).toContain('\u200b');
  });
});

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

  test('parses task id from XML task output', () => {
    const output = [
      '<task id="ses_123" state="completed">',
      '<task_result>',
      'done',
      '</task_result>',
      '</task>',
    ].join('\n');

    expect(parseTaskIdFromTaskOutput(output)).toBe('ses_123');
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
      'task_id: ses_123',
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

  test('parses XML background task launch output', () => {
    const output = [
      '<task id="ses_123" state="running">',
      '<task_result>',
      'Background task started.',
      '</task_result>',
      '</task>',
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

  test('parses XML completed status output with task result', () => {
    const output = [
      '<task id="ses_123" state="completed">',
      '<task_result>',
      'done',
      '</task_result>',
      '</task>',
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

describe('v2 subagent output formats', () => {
  test('parses subagent XML completion', () => {
    const out = [
      '<subagent sessionID="ses_a" state="completed" description="fix lint">',
      'done',
      '</subagent>',
    ].join('\n');
    expect(parseTaskIdFromTaskOutput(out)).toBe('ses_a');
    expect(parseTaskStateFromOutput(out)).toBe('completed');
    expect(parseTaskResultFromOutput(out)).toBe('done');
    const status = parseTaskStatusOutput(out);
    expect(status).toMatchObject({ taskID: 'ses_a', state: 'completed' });
  });

  test('parses subagent XML error completion', () => {
    const out =
      '<subagent sessionID="ses_b" state="error" description="d">broken</subagent>';
    expect(parseTaskStatusOutput(out)).toMatchObject({
      taskID: 'ses_b',
      state: 'error',
      result: 'broken',
    });
  });

  test('parses plain-text background launch', () => {
    const out =
      'The subagent is working in the background (sessionID: ses_c). You will be notified automatically when it finishes.';
    expect(parseTaskIdFromTaskOutput(out)).toBe('ses_c');
    expect(parseTaskStateFromOutput(out)).toBe('running');
    expect(parseTaskLaunchOutput(out)).toMatchObject({
      taskID: 'ses_c',
      state: 'running',
    });
  });

  test('parses subagent failure message', () => {
    const out = 'Subagent failed (sessionID: ses_d): rate limited';
    expect(parseTaskIdFromTaskOutput(out)).toBe('ses_d');
    expect(parseTaskStateFromOutput(out)).toBe('error');
  });

  test('v1 <task> formats still parse unchanged', () => {
    const out =
      '<task id="ses_e" state="running">\n<task_result>\nx\n</task_result>\n</task>';
    expect(parseTaskIdFromTaskOutput(out)).toBe('ses_e');
    expect(parseTaskStateFromOutput(out)).toBe('running');
  });

  test('v1 task_id line wins over a stray bracketed sessionID', () => {
    const out = [
      'Launched background task.',
      'task_id: ses_v1',
      'Related discussion mentions (sessionID: ses_other) in passing.',
    ].join('\n');
    expect(parseTaskIdFromTaskOutput(out)).toBe('ses_v1');
  });

  test('v2 background-launch text still parses after precedence reorder', () => {
    const out =
      'The subagent is working in the background (sessionID: ses_c). You will be notified automatically when it finishes.';
    expect(parseTaskIdFromTaskOutput(out)).toBe('ses_c');
  });
});
