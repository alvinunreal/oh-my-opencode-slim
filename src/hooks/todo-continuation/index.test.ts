import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { createTodoContinuationHook } from './index';

function makeBoard(): BackgroundJobBoard {
  return new BackgroundJobBoard();
}

function makeOutput(messages: unknown[]): {
  messages: {
    info: { role: string; agent?: string; sessionID?: string };
    parts: Array<{ type: string; text?: string; synthetic?: boolean }>;
  }[];
} {
  return { messages: messages as never };
}

describe('createTodoContinuationHook (issue #587)', () => {
  test('does nothing when the session has no background jobs and no idle event', async () => {
    const board = makeBoard();
    const hook = createTodoContinuationHook({
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    });

    const output = makeOutput([
      {
        info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
        parts: [{ type: 'text', text: 'continue with the next step' }],
      },
    ]);

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages).toHaveLength(1);
  });

  test('does not suppress non-synthetic user messages on a deferred session', async () => {
    const board = makeBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const hook = createTodoContinuationHook({
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    });

    // Simulate the orchestrator going idle while a background task is
    // still running.
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });

    const output = makeOutput([
      {
        info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
        parts: [{ type: 'text', text: 'I typed something new' }],
      },
    ]);

    await hook['experimental.chat.messages.transform']({}, output);

    // Real user messages are never suppressed.
    expect(output.messages).toHaveLength(1);
    expect(output.messages[0].parts[0].text).toBe('I typed something new');
  });

  test('suppresses the synthetic auto-continue wake-up when background tasks are active', async () => {
    const board = makeBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const hook = createTodoContinuationHook({
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    });

    // Simulate session.idle for the parent while a background task
    // is still running.
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });

    const output = makeOutput([
      {
        info: { role: 'assistant', agent: 'orchestrator' },
        parts: [{ type: 'text', text: 'partial response' }],
      },
      {
        info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
        parts: [
          {
            type: 'text',
            text: 'Continue with the next step.',
            synthetic: true,
          },
        ],
      },
    ]);

    await hook['experimental.chat.messages.transform']({}, output);

    // The synthetic wake-up must be removed.
    expect(output.messages).toHaveLength(1);
    expect(output.messages[0].info.role).toBe('assistant');
  });

  test('does not defer when the parent has no active background tasks', async () => {
    const board = makeBoard();
    // No background tasks registered.

    const hook = createTodoContinuationHook({
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });

    const output = makeOutput([
      {
        info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
        parts: [
          {
            type: 'text',
            text: 'Continue with the next step.',
            synthetic: true,
          },
        ],
      },
    ]);

    await hook['experimental.chat.messages.transform']({}, output);

    // Without active background tasks, the auto-continue prompt is
    // allowed through.
    expect(output.messages).toHaveLength(1);
  });

  test('clears deferral when the session becomes busy', async () => {
    const board = makeBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const hook = createTodoContinuationHook({
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });

    // The session woke up on its own (e.g. user typed something).
    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'busy' } },
      },
    });

    const output = makeOutput([
      {
        info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
        parts: [
          {
            type: 'text',
            text: 'Continue with the next step.',
            synthetic: true,
          },
        ],
      },
    ]);

    await hook['experimental.chat.messages.transform']({}, output);

    // The deferral was cleared on busy, so the synthetic prompt is
    // allowed through.
    expect(output.messages).toHaveLength(1);
  });

  test('clears deferral on session.deleted', async () => {
    const board = makeBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const hook = createTodoContinuationHook({
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });
    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 'parent-1' } },
      },
    });

    // A new session with the same id should not be deferred.
    const output = makeOutput([
      {
        info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
        parts: [
          {
            type: 'text',
            text: 'Continue with the next step.',
            synthetic: true,
          },
        ],
      },
    ]);

    await hook['experimental.chat.messages.transform']({}, output);
    expect(output.messages).toHaveLength(1);
  });

  test('skips non-managed sessions entirely', async () => {
    const board = makeBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'subagent-1',
      agent: 'explorer',
    });

    const hook = createTodoContinuationHook({
      backgroundJobBoard: board,
      shouldManageSession: (sessionID) => sessionID === 'parent-1',
    });

    // subagent-1 going idle must not mark it as deferred because it
    // is not the orchestrator.
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'subagent-1' } },
    });

    const output = makeOutput([
      {
        info: { role: 'user', agent: 'explorer', sessionID: 'subagent-1' },
        parts: [
          {
            type: 'text',
            text: 'Continue with the next step.',
            synthetic: true,
          },
        ],
      },
    ]);

    await hook['experimental.chat.messages.transform']({}, output);
    expect(output.messages).toHaveLength(1);
  });

  test('ignores synthetic text parts that carry the internal initiator marker', async () => {
    const board = makeBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const hook = createTodoContinuationHook({
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });

    const output = makeOutput([
      {
        info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
        parts: [
          {
            type: 'text',
            text: `Background task completion <!-- SLIM_INTERNAL_INITIATOR -->`,
            synthetic: true,
          },
        ],
      },
    ]);

    await hook['experimental.chat.messages.transform']({}, output);

    // Internal notifications are not auto-continue prompts; preserve
    // them so the rest of the pipeline can process them.
    expect(output.messages).toHaveLength(1);
  });

  test('handles session.status idle variant (not just session.idle event)', async () => {
    const board = makeBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const hook = createTodoContinuationHook({
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    });

    await hook.event({
      event: {
        type: 'session.status',
        properties: { sessionID: 'parent-1', status: { type: 'idle' } },
      },
    });

    const output = makeOutput([
      {
        info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
        parts: [
          {
            type: 'text',
            text: 'Continue with the next step.',
            synthetic: true,
          },
        ],
      },
    ]);

    await hook['experimental.chat.messages.transform']({}, output);
    expect(output.messages).toHaveLength(0);
  });

  test('clears deferral when a background task becomes reconciled between idle cycles', async () => {
    const board = makeBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const hook = createTodoContinuationHook({
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });

    // Background task completes and the parent consumes the result.
    board.updateStatus({ taskID: 'ses_1', state: 'completed' });
    board.markReconciled('ses_1');

    // Next idle cycle should clear the deferral.
    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });

    const output = makeOutput([
      {
        info: { role: 'user', agent: 'orchestrator', sessionID: 'parent-1' },
        parts: [
          {
            type: 'text',
            text: 'Continue with the next step.',
            synthetic: true,
          },
        ],
      },
    ]);

    await hook['experimental.chat.messages.transform']({}, output);
    expect(output.messages).toHaveLength(1);
  });

  test('handles empty messages array', async () => {
    const board = makeBoard();
    const hook = createTodoContinuationHook({
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    });

    const output = makeOutput([]);
    await hook['experimental.chat.messages.transform']({}, output);
    expect(output.messages).toEqual([]);
  });

  test('handles messages with no user role', async () => {
    const board = makeBoard();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    const hook = createTodoContinuationHook({
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    });

    await hook.event({
      event: { type: 'session.idle', properties: { sessionID: 'parent-1' } },
    });

    const output = makeOutput([
      {
        info: { role: 'assistant', agent: 'orchestrator' },
        parts: [{ type: 'text', text: 'partial' }],
      },
    ]);

    await hook['experimental.chat.messages.transform']({}, output);
    expect(output.messages).toHaveLength(1);
  });
});
