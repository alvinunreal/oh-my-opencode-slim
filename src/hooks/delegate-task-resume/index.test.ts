import { describe, expect, test } from 'bun:test';
import { TaskSessionTracker } from '../../utils/task-session-tracker';
import { detectInterruptedTask, parseTaskId } from './detector';
import { buildResumeGuidance } from './guidance';
import { createDelegateTaskResumeHook } from './hook';

// ---------------------------------------------------------------------------
// detector.ts
// ---------------------------------------------------------------------------

describe('detectInterruptedTask', () => {
  test('returns true for empty string', () => {
    expect(detectInterruptedTask('')).toBe(true);
  });

  test('returns true for whitespace-only string', () => {
    expect(detectInterruptedTask('   \n  ')).toBe(true);
  });

  test('returns true for empty task_result XML', () => {
    expect(detectInterruptedTask('<task_result></task_result>')).toBe(true);
    expect(detectInterruptedTask('<task_result>  \n  </task_result>')).toBe(
      true,
    );
  });

  test('returns true for provider error signals', () => {
    expect(detectInterruptedTask('provider error: timeout')).toBe(true);
    expect(detectInterruptedTask('Error: 429 rate limit exceeded')).toBe(true);
    expect(detectInterruptedTask('server error: connection refused')).toBe(
      true,
    );
    expect(detectInterruptedTask('quota exceeded for this API')).toBe(true);
  });

  test('returns false for parameter validation errors', () => {
    expect(
      detectInterruptedTask(
        '[ERROR] Invalid arguments: Must provide either category or subagent_type',
      ),
    ).toBe(false);
    expect(
      detectInterruptedTask(
        "Agent 'oracle' is not allowed. Allowed agents: explorer, fixer",
      ),
    ).toBe(false);
  });

  test('returns false for successful task results', () => {
    expect(
      detectInterruptedTask(
        'I have completed the refactoring as requested. Here is a summary...',
      ),
    ).toBe(false);
    expect(
      detectInterruptedTask(
        '<task_result>\nSuccessfully updated 3 files.\n</task_result>',
      ),
    ).toBe(false);
  });

  test('returns false for non-string input', () => {
    expect(detectInterruptedTask(null as unknown as string)).toBe(false);
    expect(detectInterruptedTask(undefined as unknown as string)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// guidance.ts
// ---------------------------------------------------------------------------

describe('buildResumeGuidance', () => {
  test('returns guidance for interrupted session', () => {
    const guidance = buildResumeGuidance({
      sessionId: 'ses_abc123',
      agent: 'fixer',
      status: 'interrupted',
    });

    expect(guidance).toContain('[task partial state available]');
    expect(guidance).toContain('task_id: ses_abc123');
    expect(guidance).toContain('@fixer');
    expect(guidance).toContain('recovery context');
  });

  test('returns guidance for active session', () => {
    const guidance = buildResumeGuidance({
      sessionId: 'ses_abc123',
      status: 'active',
    });

    expect(guidance).toContain('[task partial state available]');
    expect(guidance).toContain('task_id: ses_abc123');
  });

  test('returns empty string for completed session', () => {
    const guidance = buildResumeGuidance({
      sessionId: 'ses_abc123',
      status: 'completed',
    });

    expect(guidance).toBe('');
  });

  test('omits agent line when agent is undefined', () => {
    const guidance = buildResumeGuidance({
      sessionId: 'ses_abc123',
      status: 'interrupted',
    });

    expect(guidance).not.toContain('Agent:');
  });
});

// ---------------------------------------------------------------------------
// detector — parseTaskId
// ---------------------------------------------------------------------------

describe('parseTaskId', () => {
  test('extracts task_id from task output', () => {
    expect(
      parseTaskId(
        '<task_id>ses_abc123</task_id><task_result>done</task_result>',
      ),
    ).toBe('ses_abc123');
  });

  test('extracts task_id when task_result is empty', () => {
    expect(
      parseTaskId('<task_id>ses_abc123</task_id><task_result></task_result>'),
    ).toBe('ses_abc123');
  });

  test('returns undefined when task_id not present', () => {
    expect(parseTaskId('')).toBeUndefined();
    expect(parseTaskId('<task_result>content</task_result>')).toBeUndefined();
    expect(parseTaskId('some plain text output')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// hook.ts (integration)
// ---------------------------------------------------------------------------

describe('createDelegateTaskResumeHook', () => {
  function createHook() {
    const tracker = new TaskSessionTracker();
    const hook = createDelegateTaskResumeHook({} as never, tracker);
    return { tracker, hook };
  }

  /** Task output with empty result but parseable task_id. */
  const emptyWithTaskId = (id: string) =>
    `<task_id>${id}</task_id><task_result></task_result>`;

  test('appends recovery note for empty task result with task_id', async () => {
    const { tracker, hook } = createHook();
    tracker.register('ses_child1', 'ses_parent', 'fixer');

    const output = { output: emptyWithTaskId('ses_child1') };
    await hook['tool.execute.after']({ tool: 'task' }, output);

    expect(output.output).toContain('[task partial state available]');
    expect(output.output).toContain('task_id: ses_child1');
    expect(output.output).toContain('@fixer');
  });

  test('appends recovery note for provider error with task_id', async () => {
    const { tracker, hook } = createHook();
    tracker.register('ses_child1', 'ses_parent', 'explorer');

    const output = {
      output: `<task_id>ses_child1</task_id><task_result></task_result>\nError: 429 rate limit exceeded`,
    };
    await hook['tool.execute.after']({ tool: 'task' }, output);

    expect(output.output).toContain('[task partial state available]');
    expect(output.output).toContain('task_id: ses_child1');
    expect(output.output).toContain('@explorer');
  });

  test('appends recovery note even for untracked task_id (OpenCode manages it)', async () => {
    const { hook } = createHook();
    // Tracker has no entry for this task_id — OpenCode still knows it
    const output = { output: emptyWithTaskId('ses_external') };
    await hook['tool.execute.after']({ tool: 'task' }, output);

    expect(output.output).toContain('[task partial state available]');
    expect(output.output).toContain('task_id: ses_external');
  });

  test('skips recovery note when task_id cannot be extracted', async () => {
    const { hook } = createHook();
    // Empty output with no parseable task_id — we cannot identify the session
    const output = { output: '' };
    await hook['tool.execute.after']({ tool: 'task' }, output);

    expect(output.output).toBe('');
  });

  test('does NOT append recovery for parameter errors', async () => {
    const { tracker, hook } = createHook();
    tracker.register('ses_child1', 'ses_parent', 'fixer');

    const output = {
      output:
        '<task_id>ses_child1</task_id>[ERROR] Invalid arguments: Must provide either category or subagent_type',
    };
    await hook['tool.execute.after']({ tool: 'task' }, output);

    expect(output.output).not.toContain('[task partial state available]');
  });

  test('marks session as completed for successful results', async () => {
    const { tracker, hook } = createHook();
    tracker.register('ses_child1', 'ses_parent', 'fixer');

    const output = {
      output: '<task_id>ses_child1</task_id><task_result>Done.</task_result>',
    };
    await hook['tool.execute.after']({ tool: 'task' }, output);

    expect(output.output).not.toContain('[task partial state available]');
    expect(tracker.get('ses_child1')?.status).toBe('completed');
  });

  test('ignores non-task tools', async () => {
    const { hook } = createHook();
    const output = { output: '' };
    await hook['tool.execute.after']({ tool: 'read' }, output);

    expect(output.output).toBe('');
  });

  test('ignores non-string output', async () => {
    const { hook } = createHook();
    const output = { output: { some: 'object' } as unknown };
    await hook['tool.execute.after']({ tool: 'task' }, output);

    expect(output.output).toEqual({ some: 'object' });
  });
});
