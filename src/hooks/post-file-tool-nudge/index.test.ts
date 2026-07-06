import { describe, expect, test } from 'bun:test';

import { PHASE_REMINDER } from '../../config/constants';
import { SessionLifecycle } from '../session-lifecycle';
import { createPostFileToolNudgeHook } from './index';

describe('post-file-tool-nudge hook', () => {
  test('records pending session on Read tool', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });
    const output = { system: [] };

    await hook['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, {});
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      output,
    );

    expect(output.system).toContain(PHASE_REMINDER);
  });

  test('records pending session on Write tool', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });
    const output = { system: [] };

    await hook['tool.execute.after']({ tool: 'Write', sessionID: 's1' }, {});
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      output,
    );

    expect(output.system).toContain(PHASE_REMINDER);
  });

  test('does not mutate tool output', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });
    const toolOutput = { output: 'real content' };

    await hook['tool.execute.after'](
      { tool: 'Read', sessionID: 's1' },
      toolOutput,
    );

    expect(toolOutput.output).toBe('real content');
  });

  test('deduplicates multiple Read/Write calls in same session', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });

    await hook['tool.execute.after']({ tool: 'read', sessionID: 's1' }, {});
    await hook['tool.execute.after']({ tool: 'write', sessionID: 's1' }, {});
    await hook['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, {});

    const output = { system: [] };
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      output,
    );

    expect(output.system.filter((s) => s === PHASE_REMINDER)).toHaveLength(1);
  });

  test('consumes pending marker after injection', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });

    await hook['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, {});
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      { system: [] },
    );

    // Second transform should not inject
    const output = { system: [] };
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      output,
    );

    expect(output.system).toHaveLength(0);
  });

  test('ignores non-file tools', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });
    const output = { system: [] };

    await hook['tool.execute.after']({ tool: 'bash', sessionID: 's1' }, {});
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      output,
    );

    expect(output.system).toHaveLength(0);
  });

  test('skips injection when shouldInject returns false', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({
      shouldInject: () => false,
      coordinator,
    });
    const output = { system: [] };

    await hook['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, {});
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      output,
    );

    expect(output.system).toHaveLength(0);
  });

  test('ignores Read/Write without sessionID', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });
    const output = { system: [] };

    await hook['tool.execute.after']({ tool: 'read' }, {});
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      output,
    );

    expect(output.system).toHaveLength(0);
  });

  test('cleans up pending marker on session.deleted via coordinator', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });

    await hook['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, {});
    coordinator.dispatchSessionDeleted('s1');

    const output = { system: [] };
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      output,
    );

    expect(output.system).toHaveLength(0);
  });

  test('cleans up pending marker via coordinator with info.id shape', async () => {
    const coordinator = new SessionLifecycle(() => {});
    const hook = createPostFileToolNudgeHook({ coordinator });

    await hook['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, {});
    coordinator.dispatchSessionDeleted('s1');

    const output = { system: [] };
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      output,
    );

    expect(output.system).toHaveLength(0);
  });

  test('composed: phase-reminder skips when post-file-tool-nudge handles system', async () => {
    const { createPhaseReminderHook } = await import('../phase-reminder/index');
    const coordinator = new SessionLifecycle(() => {});
    const nudgeHook = createPostFileToolNudgeHook({ coordinator });
    const phaseHook = createPhaseReminderHook(coordinator);

    // Simulate Read tool call
    await nudgeHook['tool.execute.after'](
      { tool: 'Read', sessionID: 's1' },
      {},
    );

    // System transform injects into system array
    const systemOutput = { system: [] as string[] };
    await nudgeHook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      systemOutput,
    );
    expect(systemOutput.system).toContain(PHASE_REMINDER);

    // Messages transform should NOT inject (pending already handled by system)
    const messagesOutput = {
      messages: [
        {
          info: { role: 'user', sessionID: 's1' },
          parts: [{ type: 'text', text: 'hello' }],
        },
      ],
    };
    await phaseHook['experimental.chat.messages.transform']({}, messagesOutput);

    const userParts = messagesOutput.messages[0].parts;
    const reminderParts = userParts.filter(
      (p: { text?: string }) => p.text === PHASE_REMINDER,
    );
    expect(reminderParts).toHaveLength(0);
  });
});
