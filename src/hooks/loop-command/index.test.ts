import { describe, expect, test } from 'bun:test';
import { createLoopCommandHook } from './index';

describe('loop command hook', () => {
  test('registers /loop command when absent', () => {
    const hook = createLoopCommandHook();
    const config: Record<string, unknown> = {};
    hook.registerCommand(config);

    const command = (config.command as Record<string, unknown>).loop as {
      template: string;
      description: string;
    };

    expect(command).toBeDefined();
    expect(command.template).toContain('loop');
    expect(command.description).toBeDefined();
  });

  test('does not overwrite existing /loop command', () => {
    const hook = createLoopCommandHook();
    const existing = { template: 'custom', description: 'custom loop' };
    const config: Record<string, unknown> = { command: { loop: existing } };
    hook.registerCommand(config);
    expect((config.command as Record<string, unknown>).loop).toBe(existing);
  });

  test('shows help when no arguments provided', async () => {
    const hook = createLoopCommandHook();
    const output = { parts: [] as Array<{ type: string; text?: string }> };

    await hook.handleCommandExecuteBefore(
      { command: 'loop', sessionID: 's1', arguments: '  ' },
      output,
    );

    expect(output.parts.length).toBe(1);
    expect(output.parts[0].text).toContain('Usage');
  });

  test('generates activation prompt with user text', async () => {
    const hook = createLoopCommandHook();
    const output = { parts: [] as Array<{ type: string; text?: string }> };

    await hook.handleCommandExecuteBefore(
      {
        command: 'loop',
        sessionID: 's1',
        arguments: 'fix typescript errors until typecheck passes, max 3 tries',
      },
      output,
    );

    const text = output.parts[0].text;
    expect(output.parts.length).toBe(1);
    expect(text).toContain('The user ran `/loop`');
    expect(text).toContain(
      'fix typescript errors until typecheck passes, max 3 tries',
    );
    expect(text).toContain('goal, successCriteria, maxAttempts');
    expect(text).toContain('missing or unclear');
    expect(text).toContain('.opencode/loop-history/');
    expect(text).toContain('history-{NNN}.md');
    expect(text).not.toContain('attempt-{N}.md');
    expect(text).toContain('Dispatch @fixer');
  });

  test('ignores other commands', async () => {
    const hook = createLoopCommandHook();
    const output = { parts: [{ type: 'text' as const, text: 'original' }] };

    await hook.handleCommandExecuteBefore(
      { command: 'deepwork', sessionID: 's1', arguments: 'x' },
      output,
    );

    expect(output.parts.length).toBe(1);
    expect(output.parts[0].text).toBe('original');
  });
});
