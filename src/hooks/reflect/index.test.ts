import { describe, expect, test } from 'bun:test';
import { SLIM_INTERNAL_INITIATOR_MARKER } from '../../utils';
import { createReflectCommandHook } from './index';

describe('reflect command hook', () => {
  test('registers /reflect command when absent', () => {
    const hook = createReflectCommandHook();
    const config: Record<string, unknown> = {};

    hook.registerCommand(config);

    const command = (config.command as Record<string, unknown>).reflect as {
      template?: string;
      description?: string;
    };
    expect(command).toBeDefined();
    expect(command.template).toContain('repeated work');
    expect(command.description).toContain('repeated workflows');
  });

  test('does not overwrite existing /reflect command', () => {
    const hook = createReflectCommandHook();
    const existing = { template: 'custom', description: 'custom command' };
    const config: Record<string, unknown> = { command: { reflect: existing } };

    hook.registerCommand(config);

    expect((config.command as Record<string, unknown>).reflect).toBe(existing);
  });

  test('does not handle an existing custom /reflect command', async () => {
    const hook = createReflectCommandHook();
    const existing = { template: 'custom', description: 'custom command' };
    hook.registerCommand({ command: { reflect: existing } });
    const output = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      { command: 'reflect', sessionID: 's1', arguments: '  ' },
      output,
    );

    expect(output.parts).toEqual([{ type: 'text', text: 'template' }]);
  });

  test('expands empty arguments into broad reflect activation prompt', async () => {
    const hook = createReflectCommandHook();
    hook.registerCommand({});
    const output = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      { command: 'reflect', sessionID: 's1', arguments: '  ' },
      output,
    );

    expect(output.parts).toHaveLength(1);
    expect(output.parts[0].text).toContain('Use the reflect skill');
    expect(output.parts[0].text).toContain('Review recent work broadly');
    expect(output.parts[0].text).toContain('creating nothing');
    expect(output.parts[0].text).not.toContain(SLIM_INTERNAL_INITIATOR_MARKER);
  });

  test('expands arguments into focused reflect activation prompt', async () => {
    const hook = createReflectCommandHook();
    hook.registerCommand({});
    const output = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      {
        command: 'reflect',
        sessionID: 's1',
        arguments: 'release workflow and checks',
      },
      output,
    );

    expect(output.parts).toHaveLength(1);
    expect(output.parts[0].text).toContain('Use the reflect skill');
    expect(output.parts[0].text).toContain(
      'Focus:\nrelease workflow and checks',
    );
    expect(output.parts[0].text).toContain('MCP/tool permission change');
  });

  test('detects --sessions flag and activates session mode', async () => {
    const hook = createReflectCommandHook();
    hook.registerCommand({});
    const output = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      { command: 'reflect', sessionID: 's1', arguments: '--sessions' },
      output,
    );

    expect(output.parts).toHaveLength(1);
    expect(output.parts[0].text).toContain('Session Reflection Mode:');
    expect(output.parts[0].text).toContain('Analyze the last 50 sessions');
    expect(output.parts[0].text).toContain(
      '- Extract session IDs from OpenCode logs',
    );
    expect(output.parts[0].text).toContain(
      '- Load session content from SQLite database',
    );
    expect(output.parts[0].text).toContain(
      '- Analyze each session for patterns and friction',
    );
    expect(output.parts[0].text).toContain(
      '- Aggregate findings across all sessions',
    );
    expect(output.parts[0].text).toContain(
      '- Report with scope (global/cross-repo/project-specific), confidence, and impact',
    );
    // Default focus for session mode
    expect(output.parts[0].text).toContain(
      'Analyze recent sessions to find repeated patterns, friction, and improvement opportunities.',
    );
  });

  test('parses --last N flag in session mode', async () => {
    const hook = createReflectCommandHook();
    hook.registerCommand({});
    const output = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      {
        command: 'reflect',
        sessionID: 's1',
        arguments: '--sessions --last 20',
      },
      output,
    );

    expect(output.parts).toHaveLength(1);
    expect(output.parts[0].text).toContain('Analyze the last 20 sessions');
  });

  test('caps --last at 100 in session mode', async () => {
    const hook = createReflectCommandHook();
    hook.registerCommand({});
    const output = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      {
        command: 'reflect',
        sessionID: 's1',
        arguments: '--sessions --last 999',
      },
      output,
    );

    expect(output.parts).toHaveLength(1);
    expect(output.parts[0].text).toContain('Analyze the last 100 sessions');
  });

  test('--sessions with focus text includes both session mode and custom focus', async () => {
    const hook = createReflectCommandHook();
    hook.registerCommand({});
    const output = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      {
        command: 'reflect',
        sessionID: 's1',
        arguments: '--sessions feedback on PR reviews',
      },
      output,
    );

    expect(output.parts).toHaveLength(1);
    expect(output.parts[0].text).toContain('Session Reflection Mode:');
    expect(output.parts[0].text).toContain('Focus:\nfeedback on PR reviews');
  });

  test('defaults to 50 sessions when --last is not provided', async () => {
    const hook = createReflectCommandHook();
    hook.registerCommand({});
    const output = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      { command: 'reflect', sessionID: 's1', arguments: '--sessions' },
      output,
    );

    expect(output.parts[0].text).toContain('Analyze the last 50 sessions');
  });

  test('ignores other commands', async () => {
    const hook = createReflectCommandHook();
    hook.registerCommand({});
    const output = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      { command: 'deepwork', sessionID: 's1', arguments: 'x' },
      output,
    );

    expect(output.parts).toEqual([{ type: 'text', text: 'template' }]);
  });
});
