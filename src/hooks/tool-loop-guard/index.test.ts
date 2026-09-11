import { beforeEach, describe, expect, test } from 'bun:test';
import type { ToolLoopGuardHook } from './hook';
import {
  createToolLoopGuardHook,
  LOOP_GUARD_WARNING,
  WAIT_GUARD_MARKER,
  WAIT_GUARD_WARNING,
} from './hook';

function beforeInput(
  overrides: Partial<{ tool: string; sessionID: string; callID: string }> = {},
) {
  return { tool: 'read', sessionID: 's1', callID: 'c1', ...overrides };
}

function afterInput(
  overrides: Partial<{ tool: string; sessionID: string; callID: string }> = {},
) {
  return { tool: 'read', sessionID: 's1', callID: 'c1', ...overrides };
}

describe('tool-loop-guard', () => {
  let hook: ToolLoopGuardHook;

  beforeEach(() => {
    hook = createToolLoopGuardHook();
  });

  async function runIdenticalCall(
    callID: string,
    args: unknown,
    toolOutput = '...file contents...',
  ) {
    await hook['tool.execute.before'](beforeInput({ callID }), { args });
    const output = { output: toolOutput, metadata: {} };
    await hook['tool.execute.after'](afterInput({ callID }), output);
    return output;
  }

  async function runToolCall(
    tool: string,
    callID: string,
    args: unknown,
    toolOutput: unknown,
  ) {
    await hook['tool.execute.before'](beforeInput({ tool, callID }), { args });
    const output = { output: toolOutput, metadata: {} };
    await hook['tool.execute.after'](afterInput({ tool, callID }), output);
    return output;
  }

  function makeTaskStatusOutput(
    overrides: {
      state?: string;
      lastActivityAt?: string;
      idleForSeconds?: number;
      guidance?: boolean;
    } = {},
  ) {
    const state = overrides.state ?? 'busy';
    const lastActivityAt =
      overrides.lastActivityAt ?? '2026-08-30T00:00:00.000Z';
    const idleForSeconds = overrides.idleForSeconds ?? 0;
    const lines = [
      'Task #1 (ses_child1)',
      `state: ${state}`,
      'agent: fixer',
      `last_activity_at: ${lastActivityAt}`,
      `idle_for_seconds: ${idleForSeconds}`,
      'possibly_stuck: false',
    ];
    if (
      overrides.guidance ??
      (state === 'busy' || state === 'running' || state === 'retry')
    ) {
      lines.push(
        '',
        '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.',
      );
    }
    return lines.join('\n');
  }

  test('leaves output untouched for first and second identical calls', async () => {
    const o1 = await runIdenticalCall('c1', { filePath: 'a.ts' });
    const o2 = await runIdenticalCall('c2', { filePath: 'a.ts' });
    expect(o1.output).toBe('...file contents...');
    expect(o2.output).toBe('...file contents...');
  });

  test('appends warning on third identical consecutive call', async () => {
    await runIdenticalCall('c1', { filePath: 'a.ts' });
    await runIdenticalCall('c2', { filePath: 'a.ts' });
    const o3 = await runIdenticalCall('c3', { filePath: 'a.ts' });
    expect(o3.output).toContain(LOOP_GUARD_WARNING);
  });

  test('resets the count when arguments change', async () => {
    await runIdenticalCall('c1', { filePath: 'a.ts' });
    await runIdenticalCall('c2', { filePath: 'a.ts' });
    const o3 = await runIdenticalCall('c3', { filePath: 'b.ts' });
    expect(o3.output).toBe('...file contents...');
    const o4 = await runIdenticalCall('c4', { filePath: 'b.ts' });
    expect(o4.output).toBe('...file contents...');
  });

  test('key order in args does not defeat detection', async () => {
    await runIdenticalCall('c1', { filePath: 'a.ts', offset: 12 });
    await runIdenticalCall('c2', { offset: 12, filePath: 'a.ts' });
    const o3 = await runIdenticalCall('c3', { filePath: 'a.ts', offset: 12 });
    expect(o3.output).toContain(LOOP_GUARD_WARNING);
  });

  test('sixth identical call with stable identical results is refused', async () => {
    for (let i = 1; i <= 5; i++) {
      await runIdenticalCall(`c${i}`, { filePath: 'a.ts' });
    }
    await expect(
      hook['tool.execute.before'](beforeInput({ callID: 'c6' }), {
        args: { filePath: 'a.ts' },
      }),
    ).rejects.toThrow('infinite loop');
  });

  test('blocked fingerprint stays blocked', async () => {
    for (let i = 1; i <= 5; i++) {
      await runIdenticalCall(`c${i}`, { filePath: 'a.ts' });
    }
    await expect(
      hook['tool.execute.before'](beforeInput({ callID: 'c6' }), {
        args: { filePath: 'a.ts' },
      }),
    ).rejects.toThrow();
    await expect(
      hook['tool.execute.before'](beforeInput({ callID: 'c7' }), {
        args: { filePath: 'a.ts' },
      }),
    ).rejects.toThrow();
  });

  test('task_status with identical state: busy output appends warning on 3rd call and does not block at call 5 and beyond', async () => {
    const statusOutput = makeTaskStatusOutput();

    for (let i = 1; i <= 6; i++) {
      const output = await runToolCall(
        'task_status',
        `s${i}`,
        { task_id: 'child-1' },
        statusOutput,
      );
      if (i < 3) {
        expect(output.output).toBe(statusOutput);
      } else {
        expect(output.output).toContain(LOOP_GUARD_WARNING);
      }
    }
  });

  test('task_status and task_result share one stream for the same running task', async () => {
    const statusOutput = makeTaskStatusOutput({ state: 'busy' });
    const resultOutput = [
      'task_id: ses_child1',
      'state: running',
      'message: Task is still running. Wait for its terminal result.',
    ].join('\n');

    for (let i = 1; i <= 3; i++) {
      const output = await runToolCall(
        i % 2 === 1 ? 'task_status' : 'task_result',
        `poll${i}`,
        { task_id: 'ses_child1' },
        i % 2 === 1 ? statusOutput : resultOutput,
      );
      if (i < 3) expect(output.output).not.toContain(LOOP_GUARD_WARNING);
      else expect(output.output).toContain(LOOP_GUARD_WARNING);
    }
  });

  test('a new parent turn resets polling counters but not within-turn detection', async () => {
    const statusOutput = makeTaskStatusOutput();

    await runToolCall(
      'task_status',
      'turn-1-status',
      { task_id: 'ses_child1' },
      statusOutput,
    );
    const withinTurn = await runToolCall(
      'task_result',
      'turn-1-result',
      { task_id: 'ses_child1' },
      'task_id: ses_child1\nstate: running',
    );
    expect(withinTurn.output).not.toContain(LOOP_GUARD_WARNING);
    await runToolCall(
      'task_status',
      'turn-1-status-2',
      { task_id: 'ses_child1' },
      statusOutput,
    );

    hook.resetTurn('s1');

    const newTurn = await runToolCall(
      'task_result',
      'turn-2-result',
      { task_id: 'ses_child1' },
      'task_id: ses_child1\nstate: running',
    );
    expect(newTurn.output).not.toContain(LOOP_GUARD_WARNING);
  });

  test('volatile idle_for_seconds changes do not break consecutive identical detection for task_status', async () => {
    for (let i = 1; i <= 6; i++) {
      const rawOutput = makeTaskStatusOutput({
        lastActivityAt: `2026-08-30T00:00:${i.toString().padStart(2, '0')}.000Z`,
        idleForSeconds: i * 5,
      });
      const output = await runToolCall(
        'task_status',
        `s${i}`,
        { task_id: 'child-1' },
        rawOutput,
      );
      if (i < 3) {
        expect(output.output).not.toContain(LOOP_GUARD_WARNING);
      } else {
        expect(output.output).toContain(LOOP_GUARD_WARNING);
      }
    }
  });

  test('task_result called repeatedly for a running task warns on 3rd call and does not block at call 5 and beyond', async () => {
    const runningOutput = [
      'task_id: ses_child1',
      'state: running',
      'message: Task is still running. Wait for its terminal result.',
      'next: use task_status to inspect the task',
    ].join('\n');

    for (let i = 1; i <= 6; i++) {
      const output = await runToolCall(
        'task_result',
        `r${i}`,
        { task_id: 'ses_child1' },
        runningOutput,
      );
      if (i < 3) {
        expect(output.output).toBe(runningOutput);
      } else {
        expect(output.output).toContain(LOOP_GUARD_WARNING);
      }
    }
  });

  test('genuine state change resets the consecutive run counter', async () => {
    // 2 busy calls
    for (let i = 1; i <= 2; i++) {
      const output = await runToolCall(
        'task_status',
        `s${i}`,
        { task_id: 'child-1' },
        makeTaskStatusOutput({ state: 'busy' }),
      );
      expect(output.output).not.toContain(LOOP_GUARD_WARNING);
    }

    // 3rd call has state change: completed
    const completedOutput = await runToolCall(
      'task_status',
      's3',
      { task_id: 'child-1' },
      makeTaskStatusOutput({ state: 'completed' }),
    );
    expect(completedOutput.output).not.toContain(LOOP_GUARD_WARNING);

    // 4th call is completed again -> counter 2 -> no warning
    const completedOutput2 = await runToolCall(
      'task_status',
      's4',
      { task_id: 'child-1' },
      makeTaskStatusOutput({ state: 'completed' }),
    );
    expect(completedOutput2.output).not.toContain(LOOP_GUARD_WARNING);

    // 5th call is completed again -> counter 3 -> warning appended
    const completedOutput3 = await runToolCall(
      'task_status',
      's5',
      { task_id: 'child-1' },
      makeTaskStatusOutput({ state: 'completed' }),
    );
    expect(completedOutput3.output).toContain(LOOP_GUARD_WARNING);
  });

  test('task and task lifecycle/control tools (cancel, message, revive) remain exempt', async () => {
    const exemptTools = [
      { tool: 'task', args: { subagent_type: 'explorer', prompt: 'find x' } },
      { tool: 'task_cancel', args: { task_id: 'child-1' } },
      { tool: 'task_message', args: { task_id: 'child-1', message: 'hello' } },
      { tool: 'task_revive', args: { task_id: 'child-1' } },
    ];

    for (const { tool: toolName, args } of exemptTools) {
      for (let i = 1; i <= 8; i++) {
        await hook['tool.execute.before'](
          beforeInput({ tool: toolName, callID: `${toolName}_${i}` }),
          { args },
        );
        const output = { output: 'ok', metadata: {} };
        await hook['tool.execute.after'](
          afterInput({ tool: toolName, callID: `${toolName}_${i}` }),
          output,
        );
        expect(output.output).toBe('ok');
      }
    }
  });

  test('non-readonly tools warn but are never hard-blocked', async () => {
    // bash is not in BLOCK_TOOLS: confirmed identical runs warn at 3 but
    // even a long identical run never throws.
    for (let i = 1; i <= 6; i++) {
      await hook['tool.execute.before'](
        beforeInput({ tool: 'bash', callID: `b${i}` }),
        { args: { command: 'uname' } },
      );
      const output = { output: 'Linux', metadata: {} };
      await hook['tool.execute.after'](
        afterInput({ tool: 'bash', callID: `b${i}` }),
        output,
      );
      // never throws (bash is not in BLOCK_TOOLS)
      expect(output.output).toContain(i >= 3 ? LOOP_GUARD_WARNING : 'Linux');
    }
  });

  test('identical args returning changing results never block', async () => {
    // Each re-read returns different content (file was modified) — this is
    // progress, not a loop. 6 identical-args calls must never be refused.
    for (let i = 1; i <= 6; i++) {
      await hook['tool.execute.before'](beforeInput({ callID: `d${i}` }), {
        args: { filePath: 'a.ts' },
      });
      const output = { output: `revision ${i}`, metadata: {} };
      await hook['tool.execute.after'](afterInput({ callID: `d${i}` }), output);
      expect(output.output).toBe(`revision ${i}`); // never warned, never blocked
    }
  });

  test('identical args with stable identical output warn but no block for non-readonly tool', async () => {
    // bash is not in BLOCK_TOOLS: warn at 3 but never throw even at 6.
    for (let i = 1; i <= 6; i++) {
      await hook['tool.execute.before'](
        beforeInput({ tool: 'bash', callID: `e${i}` }),
        { args: { command: 'uname' } },
      );
      await hook['tool.execute.after'](
        afterInput({ tool: 'bash', callID: `e${i}` }),
        { output: 'Linux', metadata: {} },
      );
    }
    // never throws (bash is not in BLOCK_TOOLS)
  });

  test('overlapping same-args calls with changing results never block', async () => {
    // All befores fire before any after — simulates parallel execution
    // where the counter previously inflated past the threshold.
    for (let i = 1; i <= 6; i++) {
      await hook['tool.execute.before'](beforeInput({ callID: `o${i}` }), {
        args: { filePath: 'a.ts' },
      });
    }
    // then results arrive, each different (file was being modified)
    for (let i = 1; i <= 6; i++) {
      const output = { output: `revision ${i}`, metadata: {} };
      await hook['tool.execute.after'](afterInput({ callID: `o${i}` }), output);
      expect(output.output).toBe(`revision ${i}`); // never warned
    }
    // next same-args call is still allowed
    await hook['tool.execute.before'](beforeInput({ callID: 'o7' }), {
      args: { filePath: 'a.ts' },
    });
  });

  test('overlapping same-args calls with identical results block the next call', async () => {
    for (let i = 1; i <= 6; i++) {
      await hook['tool.execute.before'](beforeInput({ callID: `p${i}` }), {
        args: { filePath: 'a.ts' },
      });
    }
    for (let i = 1; i <= 5; i++) {
      await hook['tool.execute.after'](afterInput({ callID: `p${i}` }), {
        output: 'same',
        metadata: {},
      });
    }
    // 5 confirmed identical results: the next same-args call is refused
    await expect(
      hook['tool.execute.before'](beforeInput({ callID: 'p7' }), {
        args: { filePath: 'a.ts' },
      }),
    ).rejects.toThrow('infinite loop');
  });

  test('sessions are isolated', async () => {
    for (let i = 1; i <= 2; i++) {
      await runIdenticalCall(`a${i}`, { filePath: 'a.ts' });
    }
    // same args, different session: count starts fresh
    await hook['tool.execute.before'](
      beforeInput({ sessionID: 's2', callID: 'b1' }),
      { args: { filePath: 'a.ts' } },
    );
    const output = { output: '...file contents...', metadata: {} };
    await hook['tool.execute.after'](
      afterInput({ sessionID: 's2', callID: 'b1' }),
      output,
    );
    expect(output.output).toBe('...file contents...');
  });

  test('does not append marker twice', async () => {
    let out = { output: 'x' };
    for (let i = 1; i <= 4; i++) {
      out = await runIdenticalCall(`c${i}`, { filePath: 'a.ts' });
    }
    const count =
      String(out.output).split(LOOP_GUARD_WARNING.trim()).length - 1;
    expect(count).toBe(1);
  });

  test('resetSession clears loop guard state for a specific session', async () => {
    for (let i = 1; i <= 3; i++) {
      await runIdenticalCall(`c${i}`, { filePath: 'a.ts' });
    }
    // After 3 calls, warning is appended
    const o3 = await runIdenticalCall('c3_check', { filePath: 'a.ts' });
    expect(o3.output).toContain(LOOP_GUARD_WARNING);

    // Reset session
    hook.resetSession('s1');

    // Next call starts fresh with no warning
    const fresh = await runIdenticalCall('c4_fresh', { filePath: 'a.ts' });
    expect(fresh.output).toBe('...file contents...');
  });

  test('resetForTests clears all tracked sessions', async () => {
    await runIdenticalCall('c1', { filePath: 'a.ts' });
    await runIdenticalCall('c2', { filePath: 'a.ts' });
    hook.resetForTests();

    const o1 = await runIdenticalCall('c3', { filePath: 'a.ts' });
    expect(o1.output).toBe('...file contents...');
  });

  test('session reset removes pending calls and ignores late after hooks', async () => {
    await hook['tool.execute.before'](
      beforeInput({ tool: 'task_status', callID: 'pending' }),
      { args: { task_id: 'ses_child1' } },
    );
    hook.resetSession('s1');

    for (let i = 1; i <= 4; i++) {
      const output = { output: makeTaskStatusOutput(), metadata: {} };
      await hook['tool.execute.after'](
        afterInput({ tool: 'task_status', callID: `late-${i}` }),
        output,
      );
      expect(output.output).not.toContain(LOOP_GUARD_WARNING);
    }
  });

  test('first wait_for_user call passes through untouched', async () => {
    const output = await runToolCall(
      'wait_for_user',
      'w1',
      { reason: 'user must restart the server' },
      'state: waiting_for_user\nreason: user must restart the server',
    );
    expect(output.output).not.toContain(WAIT_GUARD_WARNING);
  });

  test('second wait_for_user call with different reason still warns', async () => {
    await runToolCall(
      'wait_for_user',
      'w1',
      { reason: 'user must restart the server' },
      'state: waiting_for_user\nreason: user must restart the server',
    );
    const output = await runToolCall(
      'wait_for_user',
      'w2',
      { reason: 'idle wake again' },
      'state: waiting_for_user\nreason: idle wake again',
    );
    expect(output.output).toContain(WAIT_GUARD_WARNING);
  });

  test('third wait_for_user call is refused', async () => {
    for (let i = 1; i <= 2; i++) {
      await runToolCall(
        'wait_for_user',
        `w${i}`,
        { reason: `reason ${i}` },
        `state: waiting_for_user\nreason: reason ${i}`,
      );
    }
    await expect(
      hook['tool.execute.before'](
        beforeInput({ tool: 'wait_for_user', callID: 'w3' }),
        {
          args: { reason: 'reason 3' },
        },
      ),
    ).rejects.toThrow('end your turn');
  });

  test('wait_for_user and wait_for_background_tasks share one stream', async () => {
    await runToolCall(
      'wait_for_user',
      'w1',
      { reason: 'waiting on user' },
      'state: waiting_for_user',
    );
    const output = await runToolCall(
      'wait_for_background_tasks',
      'w2',
      {},
      'state: waiting',
    );
    expect(output.output).toContain(WAIT_GUARD_WARNING);
    await expect(
      hook['tool.execute.before'](
        beforeInput({ tool: 'wait_for_background_tasks', callID: 'w3' }),
        { args: {} },
      ),
    ).rejects.toThrow('end your turn');
  });

  test('observeNewUserMessage resets the wait counter', async () => {
    await runToolCall(
      'wait_for_user',
      'w1',
      { reason: 'waiting on user' },
      'state: waiting_for_user',
    );
    hook.observeNewUserMessage('s1', 'msg-1');
    const output = await runToolCall(
      'wait_for_user',
      'w2',
      { reason: 'waiting again after reply' },
      'state: waiting_for_user',
    );
    expect(output.output).not.toContain(WAIT_GUARD_WARNING);
  });

  test('resetTurn resets the wait counter', async () => {
    await runToolCall(
      'wait_for_user',
      'w1',
      { reason: 'waiting on user' },
      'state: waiting_for_user',
    );
    hook.resetTurn('s1');
    const output = await runToolCall(
      'wait_for_user',
      'w2',
      { reason: 'new turn wait' },
      'state: waiting_for_user',
    );
    expect(output.output).not.toContain(WAIT_GUARD_WARNING);
  });

  test('wait tool calls do not poison the fingerprint stream', async () => {
    await runToolCall(
      'wait_for_user',
      'w1',
      { reason: 'waiting on user' },
      'state: waiting_for_user',
    );
    await runToolCall(
      'wait_for_user',
      'w2',
      { reason: 'still waiting' },
      'state: waiting_for_user',
    );
    // Identical read calls still warn on the 3rd consecutive call.
    await runIdenticalCall('c1', { filePath: 'a.ts' });
    await runIdenticalCall('c2', { filePath: 'a.ts' });
    const o3 = await runIdenticalCall('c3', { filePath: 'a.ts' });
    expect(o3.output).toContain(LOOP_GUARD_WARNING);
    expect(o3.output).not.toContain(WAIT_GUARD_MARKER);
  });
});
