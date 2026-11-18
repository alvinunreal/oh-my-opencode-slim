import { describe, expect, test } from 'bun:test';
import {
  parseTaskOutputHeader,
  parseTaskResultFromOutput,
  parseTaskStatusOutput,
  type TaskOutputState,
} from './task';

test('parses a running task status for the same task ID', () => {
  const a =
    '<task id="ses_123" state="running"><task_result>The task is working in the background. You will be notified automatically when it finishes.</task_result></task>';
  expect(parseTaskStatusOutput(a)).toMatchObject({
    taskID: 'ses_123',
    state: 'running',
  });
});

describe('task output header parsing', () => {
  type HeaderCase = [
    id: string | undefined,
    state: TaskOutputState | undefined,
    input: string,
  ];
  // Format controls plus every quoted/duplicated/malformed attribution
  // vector: identity and state come only from the output's real opening.
  const headerCases: HeaderCase[] = [
    [
      'ses_A',
      undefined,
      'task_id: ses_A (for resuming to continue this task if needed)\n<task_result>done</task_result>',
    ],
    [
      'ses_A',
      'completed',
      'task_id: ses_A\nstate: completed\n<task_result>done</task_result>',
    ],
    [
      'ses_A',
      'completed',
      'sessionID: ses_A\nstate: completed\n<task_result>done</task_result>',
    ],
    [
      'ses_A',
      'running',
      '<task id="ses_A" state="running"><task_result>working</task_result></task>',
    ],
    [
      'ses_A',
      'completed',
      '<subagent sessionID="ses_A" state="completed" description="fix lint">done</subagent>',
    ],
    [
      'ses_A',
      'running',
      'The subagent is working in the background (sessionID: ses_A). You will be notified automatically when it finishes.',
    ],
    ['ses_A', 'error', 'Subagent failed (sessionID: ses_A): rate limited'],
    ['ses_A', 'cancelled', 'Subagent cancelled (sessionID: ses_A)'],
    [
      'ses_A',
      undefined,
      'Launched background task.\ntask_id: ses_A\nRelated discussion mentions (sessionID: ses_B) in passing.',
    ],
    [
      'ses_A',
      'completed',
      '<subagent sessionID="ses_A" state="completed">\n<task id="ses_B" state="completed">\n<task_result>\nquoted foreign result\n</task_result>\n</task>\n</subagent>',
    ],
    [
      'ses_A',
      'running',
      '<task id="ses_A" state="running">\n<task_result>\n<subagent sessionID="ses_B" state="completed">cita</subagent>\n</task_result>\n</task>',
    ],
    [
      'ses_A',
      'completed',
      'task_id: ses_A\nstate: completed\n\n<task_result>\n<task id="ses_B" state="completed">quoted</task>\n</task_result>',
    ],
    [
      'ses_A',
      'error',
      'Subagent failed (sessionID: ses_A): child reported:\n<task id="ses_B" state="completed">quoted</task>',
    ],
    [
      'ses_A',
      undefined,
      '<task id="ses_A">\n<task_result>\nSubagent failed (sessionID: ses_B)\n</task_result>\n</task>',
    ],
    [
      'ses_A',
      'completed',
      '<subagent sessionID="ses_A" state="completed" description="Inspect id=\'submit\' selector">done</subagent>',
    ],
    [
      'ses_A',
      'completed',
      '<subagent description="Inspect sessionID=\'ses_B\'" sessionID="ses_A" state="completed">done</subagent>',
    ],
    [
      'ses_A',
      'running',
      '<task id="ses_A" description="Inspect state=\'completed\'" state="running">…</task>',
    ],
    [
      'ses_A',
      'completed',
      '<subagent description="Check a > b" sessionID="ses_A" state="completed">done</subagent>',
    ],
    [
      undefined,
      undefined,
      '<subagent sessionID="ses_A" state="completed" sessionID="ses_B">done</subagent>',
    ],
    [
      undefined,
      undefined,
      '<task id="ses_A" state="running" state="completed">…</task>',
    ],
    [
      undefined,
      undefined,
      '<subagent sessionID="ses_A" state="completed" description="Fix 3" display">\ntask_id: ses_B\nstate: completed\n</subagent>',
    ],
    [
      undefined,
      undefined,
      '<subagent sessionID="ses_A" state="completed" description="Fix "<button>" element">\ntask_id: ses_B\nstate: completed\n</subagent>',
    ],
    [undefined, undefined, '<task_result>no task id here</task_result>'],
  ];
  test.each(headerCases)('header %s / %s: %s', (id, state, input) => {
    expect(parseTaskOutputHeader(input).taskID).toBe(id);
    expect(parseTaskOutputHeader(input).state).toBe(state);
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

    expect(parseTaskStatusOutput(output)).toEqual({
      taskID: 'ses_123',
      state: 'running',
      timedOut: false,
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

    expect(parseTaskStatusOutput(output)).toEqual({
      taskID: 'ses_123',
      state: 'running',
      timedOut: false,
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

    expect(parseTaskStatusOutput(output)).toBeUndefined();
  });

  test('ignores state lines inside task result body', () => {
    const output = [
      'task_id: ses_123 (for resuming to continue this task if needed)',
      '',
      '<task_result>',
      'state: running',
      '</task_result>',
    ].join('\n');

    expect(parseTaskStatusOutput(output)).toBeUndefined();
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

  test('parses a v2 sessionID header', () => {
    const output = [
      'sessionID: ses_123',
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

  test('quoted gt in a subagent attribute does not leak into the result', () => {
    // The opening tag must be scanned quote-aware: a `>` inside an
    // attribute value (description="Check a > b") cannot close the tag.
    expect(
      parseTaskResultFromOutput(
        '<subagent sessionID="ses_A" state="completed" description="Check a > b">done</subagent>',
      ),
    ).toBe('done');
  });

  test('unterminated subagent tag yields no result', () => {
    expect(
      parseTaskResultFromOutput(
        '<subagent sessionID="ses_A" state="completed" description="Fix 3" display">no close',
      ),
    ).toBeUndefined();
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
    expect(parseTaskOutputHeader(out).taskID).toBe('ses_a');
    expect(parseTaskOutputHeader(out).state).toBe('completed');
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
    expect(parseTaskOutputHeader(out).taskID).toBe('ses_c');
    expect(parseTaskOutputHeader(out).state).toBe('running');
    expect(parseTaskStatusOutput(out)).toMatchObject({
      taskID: 'ses_c',
      state: 'running',
    });
  });

  test('parses subagent failure message', () => {
    const out = 'Subagent failed (sessionID: ses_d): rate limited';
    expect(parseTaskOutputHeader(out).taskID).toBe('ses_d');
    expect(parseTaskOutputHeader(out).state).toBe('error');
  });

  test('v1 <task> formats still parse unchanged', () => {
    const out =
      '<task id="ses_e" state="running">\n<task_result>\nx\n</task_result>\n</task>';
    expect(parseTaskOutputHeader(out).taskID).toBe('ses_e');
    expect(parseTaskOutputHeader(out).state).toBe('running');
  });

  test('v1 task_id line wins over a stray bracketed sessionID', () => {
    const out = [
      'Launched background task.',
      'task_id: ses_v1',
      'Related discussion mentions (sessionID: ses_other) in passing.',
    ].join('\n');
    expect(parseTaskOutputHeader(out).taskID).toBe('ses_v1');
  });
});
