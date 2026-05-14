import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionGoalHook } from './index';

function createHook(directory = '.') {
  return createSessionGoalHook(
    { directory } as Parameters<typeof createSessionGoalHook>[0],
    { interview: { outputFolder: 'interview' } } as Parameters<
      typeof createSessionGoalHook
    >[1],
    { getAgentName: () => 'orchestrator' },
  );
}

describe('createSessionGoalHook', () => {
  test('sets and shows a manual session goal', async () => {
    const hook = createHook();
    const output = { parts: [] as Array<{ type: string; text?: string }> };

    await hook.handleCommandExecuteBefore(
      {
        command: 'goal',
        sessionID: 'ses_1',
        arguments: 'Ship the goal feature. Done when tests pass.',
      },
      output,
    );

    expect(output.parts[0].text).toContain('Set active goal:');
    expect(hook.getGoal('ses_1')?.text).toBe(
      'Ship the goal feature. Done when tests pass.',
    );

    const showOutput = { parts: [] as Array<{ type: string; text?: string }> };
    await hook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'ses_1', arguments: '' },
      showOutput,
    );

    expect(showOutput.parts[0].text).toContain('Active goal:');
    expect(showOutput.parts[0].text).toContain('Auto-continuation');
  });

  test('injects active goal into orchestrator system prompt', async () => {
    const hook = createHook();
    await hook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'ses_1', arguments: 'Stay on target.' },
      { parts: [] },
    );
    const output = { system: ['base prompt'] };

    hook.handleSystemTransform({ sessionID: 'ses_1' }, output);

    expect(output.system.join('\n')).toContain('<active_goal>');
    expect(output.system.join('\n')).toContain('Stay on target.');
    expect(output.system.join('\n')).toContain(
      'Use todos as the execution ledger',
    );
  });

  test('inherits parent goal for child sessions', async () => {
    const hook = createSessionGoalHook(
      { directory: '.' } as Parameters<typeof createSessionGoalHook>[0],
      {} as Parameters<typeof createSessionGoalHook>[1],
      { getAgentName: () => 'explorer' },
    );
    await hook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'parent', arguments: 'Parent objective.' },
      { parts: [] },
    );

    hook.handleEvent({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child', parentID: 'parent' } },
      },
    });

    const output = { system: [] as string[] };
    hook.handleSystemTransform({ sessionID: 'child' }, output);

    expect(output.system.join('\n')).toContain('<parent_goal>');
    expect(output.system.join('\n')).toContain('Parent objective.');
    expect(output.system.join('\n')).toContain('bounded task');
  });

  test('child sessions resolve updated parent goal live', async () => {
    const hook = createSessionGoalHook(
      { directory: '.' } as Parameters<typeof createSessionGoalHook>[0],
      {} as Parameters<typeof createSessionGoalHook>[1],
      { getAgentName: () => 'explorer' },
    );
    await hook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'parent', arguments: 'Original.' },
      { parts: [] },
    );
    hook.handleEvent({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child', parentID: 'parent' } },
      },
    });
    await hook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'parent', arguments: 'Updated.' },
      { parts: [] },
    );

    const output = { system: [] as string[] };
    hook.handleSystemTransform({ sessionID: 'child' }, output);

    expect(output.system.join('\n')).toContain('Updated.');
    expect(output.system.join('\n')).not.toContain('Original.');
  });

  test('child sessions stop inheriting after parent goal is cleared', async () => {
    const hook = createSessionGoalHook(
      { directory: '.' } as Parameters<typeof createSessionGoalHook>[0],
      {} as Parameters<typeof createSessionGoalHook>[1],
      { getAgentName: () => 'explorer' },
    );
    await hook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'parent', arguments: 'Parent objective.' },
      { parts: [] },
    );
    hook.handleEvent({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child', parentID: 'parent' } },
      },
    });
    await hook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'parent', arguments: 'clear' },
      { parts: [] },
    );

    const output = { system: [] as string[] };
    hook.handleSystemTransform({ sessionID: 'child' }, output);

    expect(output.system).toEqual([]);
    expect(hook.getGoal('child')).toBeUndefined();
  });

  test('sets goal from an interview document', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'goal-test-'));
    const interviewDir = path.join(directory, 'interview');
    await mkdir(interviewDir, { recursive: true });
    await writeFile(
      path.join(interviewDir, 'feature.md'),
      [
        '# Feature Goal',
        '',
        '## Current spec',
        '',
        'Build the feature with minimal scope.',
        '',
        '## Q&A history',
        '',
        'No answers yet.',
      ].join('\n'),
      'utf8',
    );

    const hook = createHook(directory);
    const output = { parts: [] as Array<{ type: string; text?: string }> };

    await hook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'ses_1', arguments: 'from feature' },
      output,
    );

    expect(output.parts[0].text).toContain('Set active goal from interview');
    expect(hook.getGoal('ses_1')?.text).toContain('Feature Goal');
    expect(hook.getGoal('ses_1')?.text).toContain(
      'Build the feature with minimal scope.',
    );
  });

  test('clears goals on command and session deletion', async () => {
    const hook = createHook();
    await hook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'ses_1', arguments: 'Temporary goal.' },
      { parts: [] },
    );
    await hook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'ses_1', arguments: 'clear' },
      { parts: [] },
    );
    expect(hook.getGoal('ses_1')).toBeUndefined();

    await hook.handleCommandExecuteBefore(
      { command: 'goal', sessionID: 'ses_1', arguments: 'Temporary goal.' },
      { parts: [] },
    );
    hook.handleEvent({
      event: { type: 'session.deleted', properties: { sessionID: 'ses_1' } },
    });
    expect(hook.getGoal('ses_1')).toBeUndefined();
  });
});
