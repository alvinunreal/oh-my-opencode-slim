import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from './background-job-board';

describe('BackgroundJobBoard', () => {
  test('registers background launches as running jobs with aliases', () => {
    const board = new BackgroundJobBoard();

    const job = board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config',
      now: 100,
    });

    expect(job).toMatchObject({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config',
      state: 'running',
      alias: 'exp-1',
      terminalUnreconciled: false,
    });
    expect(board.hasRunning('parent-1')).toBe(true);
  });

  test('updates terminal task results as unreconciled', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
      now: 100,
    });

    const updated = board.updateStatus({
      taskID: 'ses_1',
      state: 'completed',
      resultSummary: 'looks good',
      now: 200,
    });

    expect(updated).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      completedAt: 200,
      resultSummary: 'looks good',
    });
    expect(board.hasTerminalUnreconciled('parent-1')).toBe(true);
  });

  test('keeps timeout status running with timedOut overlay', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement parser',
    });

    board.updateStatus({
      taskID: 'ses_1',
      state: 'running',
      timedOut: true,
    });

    expect(board.get('ses_1')).toMatchObject({
      state: 'running',
      timedOut: true,
      terminalUnreconciled: false,
    });
  });

  test('formats running and terminal unreconciled jobs for prompt', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map config',
    });
    board.registerLaunch({
      taskID: 'ses_2',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({
      taskID: 'ses_2',
      state: 'completed',
      resultSummary: 'plan is sound',
    });

    const prompt = board.formatForPrompt('parent-1');

    expect(prompt).toContain('### Background Job Board');
    expect(prompt).toContain('exp-1 / ses_1 / explorer / running');
    expect(prompt).toContain(
      'ora-1 / ses_2 / oracle / completed, unreconciled',
    );
    expect(prompt).toContain('Result: plan is sound');
  });

  test('marks terminal jobs as reconciled and hides them from prompt', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });
    board.markReconciled('ses_1', 300);

    expect(board.get('ses_1')).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
      updatedAt: 300,
    });
    expect(board.formatForPrompt('parent-1')).toContain('Reusable Sessions');
  });

  test('does not expose unreconciled terminal jobs as reusable', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });

    const prompt = board.formatForPrompt('parent-1');

    expect(prompt).toContain(
      'ora-1 / ses_1 / oracle / completed, unreconciled',
    );
    expect(prompt).toContain('#### Reusable Sessions\n- none');
  });

  test('does not expose cancelled or errored jobs as reusable', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_cancelled',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'cancelled review',
    });
    board.updateStatus({ taskID: 'ses_cancelled', state: 'cancelled' });
    board.markReconciled('ses_cancelled');
    board.registerLaunch({
      taskID: 'ses_error',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'errored review',
    });
    board.updateStatus({ taskID: 'ses_error', state: 'error' });
    board.markReconciled('ses_error');

    expect(board.formatForPrompt('parent-1')).toBeUndefined();
    expect(board.resolveReusable('parent-1', 'ses_cancelled')).toBeUndefined();
    expect(board.resolveReusable('parent-1', 'ses_error')).toBeUndefined();
  });

  test('prompt tells orchestrator to reuse completed sessions only', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });
    board.markReconciled('ses_1');

    expect(board.formatForPrompt('parent-1')).toContain(
      'Reuse only completed sessions',
    );
  });

  test('does not reconcile running jobs', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'still running',
    });

    expect(board.markReconciled('ses_1')).toBeUndefined();
    expect(board.get('ses_1')).toMatchObject({ state: 'running' });
  });

  test('resets terminal state when an existing task id is relaunched', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'first run',
      now: 100,
    });
    board.updateStatus({
      taskID: 'ses_1',
      state: 'completed',
      resultSummary: 'old result',
      now: 200,
    });

    const relaunched = board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'second run',
      now: 300,
    });

    expect(relaunched).toMatchObject({
      state: 'running',
      timedOut: false,
      terminalUnreconciled: false,
      completedAt: undefined,
      resultSummary: undefined,
      launchedAt: 100,
      lastLaunchedAt: 300,
      updatedAt: 300,
    });
  });

  test('updates status from native task output', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map files',
    });

    board.updateFromStatusOutput(
      [
        'task_id: ses_1',
        'state: error',
        '<task_result>',
        'failed',
        '</task_result>',
      ].join('\n'),
    );

    expect(board.get('ses_1')).toMatchObject({
      state: 'error',
      terminalUnreconciled: true,
      resultSummary: 'failed',
    });
  });

  test('updates error summary from task_error output', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
      description: 'map files',
    });

    board.updateFromStatusOutput(
      [
        'task_id: ses_1',
        'state: cancelled',
        '',
        '<task_error>',
        'cancelled by user',
        '</task_error>',
      ].join('\n'),
    );

    expect(board.get('ses_1')).toMatchObject({
      state: 'cancelled',
      terminalUnreconciled: true,
      resultSummary: 'cancelled by user',
    });
  });

  test('resolves task IDs and aliases within parent scope', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.registerLaunch({
      taskID: 'ses_2',
      parentSessionID: 'parent-2',
      agent: 'explorer',
    });

    expect(board.resolve('parent-1', 'ses_1')?.taskID).toBe('ses_1');
    expect(board.resolve('parent-1', 'exp-1')?.taskID).toBe('ses_1');
    expect(board.resolve('parent-2', 'exp-1')?.taskID).toBe('ses_2');
    expect(board.resolve('parent-1', 'ses_2')).toBeUndefined();
  });

  test('marks running jobs as cancelled and unreconciled', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      now: 100,
    });

    const cancelled = board.markCancelled('ses_1', 'obsolete lane', 200);

    expect(cancelled).toMatchObject({
      state: 'cancelled',
      timedOut: false,
      terminalUnreconciled: true,
      completedAt: 200,
      resultSummary: 'cancelled: obsolete lane',
    });
    expect(board.hasTerminalUnreconciled('parent-1')).toBe(true);
    expect(board.formatForPrompt('parent-1')).toContain(
      'fix-1 / ses_1 / fixer / cancelled, unreconciled',
    );
  });

  test('markCancelled does not mutate already terminal jobs', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });
    board.updateStatus({
      taskID: 'ses_1',
      state: 'completed',
      resultSummary: 'done',
    });

    board.markCancelled('ses_1', 'too late');

    expect(board.get('ses_1')).toMatchObject({
      state: 'completed',
      resultSummary: 'done',
    });
  });

  test('stale running status cannot reopen terminal jobs', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    board.markCancelled('ses_1', 'obsolete');

    board.updateStatus({
      taskID: 'ses_1',
      state: 'running',
      timedOut: true,
    });

    expect(board.get('ses_1')).toMatchObject({
      state: 'cancelled',
      terminalUnreconciled: true,
      timedOut: false,
    });
  });

  test('cancelled jobs ignore late non-cancelled terminal statuses', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    board.markCancelled('ses_1', 'user requested');

    board.updateStatus({
      taskID: 'ses_1',
      state: 'error',
      resultSummary: 'request cancelled upstream',
    });
    expect(board.get('ses_1')).toMatchObject({
      state: 'cancelled',
      resultSummary: 'cancelled: user requested',
    });

    board.updateStatus({
      taskID: 'ses_1',
      state: 'completed',
      resultSummary: 'late completion',
    });
    expect(board.get('ses_1')).toMatchObject({
      state: 'cancelled',
      resultSummary: 'cancelled: user requested',
    });
  });

  test('live busy session does not reopen stale cancelled jobs', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({
      taskID: 'ses_1',
      state: 'cancelled',
      resultSummary: 'upstream cancelled during compaction',
      now: 100,
    });

    const updated = board.markRunningFromLiveSession('ses_1', 200);

    expect(updated).toMatchObject({
      state: 'cancelled',
      terminalUnreconciled: true,
      lastLiveBusyAt: 200,
    });
    expect(updated?.completedAt).toBeDefined();
    expect(updated?.terminalState).toBe('cancelled');
    expect(updated?.resultSummary).toBe('upstream cancelled during compaction');
  });

  test('live busy session does not reopen explicit cancel requests', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
    });
    board.markCancelled('ses_1', 'user requested', 100);

    const updated = board.markRunningFromLiveSession('ses_1', 200);

    expect(updated).toMatchObject({
      state: 'cancelled',
      cancellationRequested: true,
      terminalUnreconciled: true,
    });
  });

  test('live busy session does not reopen reconciled stale cancellations', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'cancelled', now: 100 });
    board.markReconciled('ses_1', 150);

    const updated = board.markRunningFromLiveSession('ses_1', 200);

    expect(updated).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
      terminalState: 'cancelled',
      lastLiveBusyAt: 200,
    });
  });

  test('live busy session does not reopen non-cancelled terminal jobs', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed', now: 100 });

    const updated = board.markRunningFromLiveSession('ses_1', 200);

    expect(updated).toMatchObject({
      state: 'completed',
      terminalUnreconciled: true,
      terminalState: 'completed',
      lastLiveBusyAt: 200,
    });
    expect(updated?.completedAt).toBeDefined();
  });

  test('stale status updates cannot reopen already reconciled jobs', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });
    board.markReconciled('ses_1', 300);

    // Stale status updates should not reopen the reconciled job
    const staleCompleted = board.updateStatus({
      taskID: 'ses_1',
      state: 'completed',
      resultSummary: 'stale result',
    });
    expect(staleCompleted).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });

    const staleError = board.updateStatus({
      taskID: 'ses_1',
      state: 'error',
      resultSummary: 'stale error',
    });
    expect(staleError).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });

    const staleCancelled = board.updateStatus({
      taskID: 'ses_1',
      state: 'cancelled',
    });
    expect(staleCancelled).toMatchObject({
      state: 'reconciled',
      terminalUnreconciled: false,
    });

    expect(board.formatForPrompt('parent-1')).toContain('Reusable Sessions');
  });

  test('annotates just-launched running jobs with age in the prompt', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement feature',
      now: 1_000,
    });

    // 4 seconds after launch — should show age annotation
    const prompt = board.formatForPrompt('parent-1', 5_000);
    expect(prompt).toContain('running [just launched, 4s ago]');
  });

  test('does not annotate running jobs older than 30s', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement feature',
      now: 1_000,
    });

    // 39 seconds after launch — age label should be absent
    const prompt = board.formatForPrompt('parent-1', 40_000);
    expect(prompt).not.toContain('just launched');
    expect(prompt).toContain('/ running\n');
  });

  test('registerLaunch can reset a reconciled job to running', () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan',
      now: 100,
    });
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });
    board.markReconciled('ses_1', 300);

    // Relaunch should reset the reconciled job to running
    const relaunched = board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'review plan again',
      now: 400,
    });

    expect(relaunched).toMatchObject({
      state: 'running',
      terminalUnreconciled: false,
      completedAt: undefined,
      resultSummary: undefined,
      updatedAt: 400,
    });
  });

  test('annotates resumed running jobs with resumed label in the prompt', () => {
    const board = new BackgroundJobBoard();
    // Initial launch at t=1000
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement feature',
      now: 1_000,
    });
    // Reuse the same session ID at t=5000 (session reuse)
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement feature continued',
      now: 5_000,
    });

    // 4 seconds after relaunch — should show [resumed, 4s ago]
    const prompt = board.formatForPrompt('parent-1', 9_000);
    expect(prompt).toContain('running [resumed, 4s ago]');
  });
});
