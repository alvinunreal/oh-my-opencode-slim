import { describe, expect, test } from 'bun:test';

import { PHASE_REMINDER_TEXT } from '../../config/constants';
import { createPostFileToolNudgeHook } from './index';

function createOutput(output = 'real content') {
  return {
    title: 'Read',
    output,
    metadata: {},
  };
}

function countReminder(system: string[]) {
  return system.join('\n').split(PHASE_REMINDER_TEXT).length - 1;
}

describe('post-file-tool-nudge hook', () => {
  test('does not contaminate persisted Read output', async () => {
    const hook = createPostFileToolNudgeHook();
    const output = createOutput();

    await hook['tool.execute.after']({ tool: 'read', sessionID: 's1' }, output);

    expect(output.output).toBe('real content');
    expect(output.output).not.toContain(PHASE_REMINDER_TEXT);
  });

  test('injects the delegation reminder in system transform', async () => {
    const hook = createPostFileToolNudgeHook();
    const output = createOutput();
    const system = { system: ['base system prompt'] };

    await hook['tool.execute.after']({ tool: 'Read', sessionID: 's1' }, output);
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      system,
    );

    expect(output.output).toBe('real content');
    expect(system.system.join('\n')).toContain(PHASE_REMINDER_TEXT);
  });

  test('consumes the reminder once', async () => {
    const hook = createPostFileToolNudgeHook();
    const first = { system: ['base'] };
    const second = { system: ['base'] };

    await hook['tool.execute.after'](
      { tool: 'write', sessionID: 's1' },
      createOutput(),
    );
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      first,
    );
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      second,
    );

    expect(countReminder(first.system)).toBe(1);
    expect(countReminder(second.system)).toBe(0);
  });

  test('deduplicates multiple Read/Write calls before the next prompt', async () => {
    const hook = createPostFileToolNudgeHook();
    const system = { system: ['base'] };

    await hook['tool.execute.after'](
      { tool: 'read', sessionID: 's1' },
      createOutput(),
    );
    await hook['tool.execute.after'](
      { tool: 'write', sessionID: 's1' },
      createOutput(),
    );
    await hook['tool.execute.after'](
      { tool: 'Read', sessionID: 's1' },
      createOutput(),
    );
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      system,
    );

    expect(countReminder(system.system)).toBe(1);
  });

  test('ignores non-file tools', async () => {
    const hook = createPostFileToolNudgeHook();
    const output = createOutput('ok');
    const system = { system: ['base'] };

    await hook['tool.execute.after']({ tool: 'bash', sessionID: 's1' }, output);
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      system,
    );

    expect(output.output).toBe('ok');
    expect(countReminder(system.system)).toBe(0);
  });

  test('consumes without injecting when the session should not receive the nudge', async () => {
    const hook = createPostFileToolNudgeHook({ shouldInject: () => false });
    const first = { system: ['base'] };
    const second = { system: ['base'] };

    await hook['tool.execute.after'](
      { tool: 'read', sessionID: 's1' },
      createOutput(),
    );
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      first,
    );
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      second,
    );

    expect(countReminder(first.system)).toBe(0);
    expect(countReminder(second.system)).toBe(0);
  });

  test('ignores Read/Write without sessionID', async () => {
    const hook = createPostFileToolNudgeHook();
    const output = createOutput();
    const system = { system: ['base'] };

    await hook['tool.execute.after']({ tool: 'read' }, output);
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      system,
    );

    expect(output.output).toBe('real content');
    expect(countReminder(system.system)).toBe(0);
  });

  test('cleans up pending reminders when a session is deleted', async () => {
    const hook = createPostFileToolNudgeHook();
    const system = { system: ['base'] };

    await hook['tool.execute.after'](
      { tool: 'read', sessionID: 's1' },
      createOutput(),
    );
    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 's1' } },
      },
    });
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      system,
    );

    expect(countReminder(system.system)).toBe(0);
  });

  test('cleans up pending reminders from sessionID delete events', async () => {
    const hook = createPostFileToolNudgeHook();
    const system = { system: ['base'] };

    await hook['tool.execute.after'](
      { tool: 'write', sessionID: 's1' },
      createOutput(),
    );
    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 's1' },
      },
    });
    await hook['experimental.chat.system.transform'](
      { sessionID: 's1' },
      system,
    );

    expect(countReminder(system.system)).toBe(0);
  });
});
