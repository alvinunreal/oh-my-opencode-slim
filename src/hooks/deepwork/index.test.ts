import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SLIM_INTERNAL_INITIATOR_MARKER } from '../../utils';
import { createDeepworkCommandHook } from './index';

describe('deepwork command hook', () => {
  test('registers /deepwork command when absent', () => {
    const hook = createDeepworkCommandHook();
    const config: Record<string, unknown> = {};

    hook.registerCommand(config);

    const command = (config.command as Record<string, unknown>).deepwork as {
      template?: string;
      description?: string;
    };
    expect(command).toBeDefined();
    expect(command.template).toContain('deepwork');
    expect(command.description).toContain('heavy');
  });

  test('does not overwrite existing /deepwork command', () => {
    const hook = createDeepworkCommandHook();
    const existing = { template: 'custom', description: 'custom command' };
    const config: Record<string, unknown> = { command: { deepwork: existing } };

    hook.registerCommand(config);

    expect((config.command as Record<string, unknown>).deepwork).toBe(existing);
  });

  test('asks for a task when no arguments are provided', async () => {
    const hook = createDeepworkCommandHook();
    const output = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      { command: 'deepwork', sessionID: 's1', arguments: '  ' },
      output,
    );

    expect(output.parts).toHaveLength(1);
    expect(output.parts[0].text).toContain('What task should deepwork manage?');
    expect(output.parts[0].text).toContain(SLIM_INTERNAL_INITIATOR_MARKER);
  });

  test('expands arguments into a deepwork activation prompt', async () => {
    const hook = createDeepworkCommandHook();
    const output = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      {
        command: 'deepwork',
        sessionID: 's1',
        arguments: 'refactor scheduler state',
      },
      output,
    );

    expect(output.parts).toHaveLength(1);
    // Content-delivery seam: the bundled SKILL.md body itself must arrive
    // with the command (/deepwork is self-contained — it works even when the
    // skill is disabled). Head + tail pins prove the whole body survives; the
    // frontmatter guard catches a strip failure (including the CRLF case).
    expect(output.parts[0].text).toContain('# Deepwork');
    expect(output.parts[0].text).toContain('## Completion');
    expect(output.parts[0].text).not.toContain('name: deepwork');
    expect(output.parts[0].text).toContain('.slim/deepwork/');
    // Dynamic-input propagation seam: the pinned per-session path must carry
    // the caller's real session ID (a hardcoded path cannot contain it).
    expect(output.parts[0].text).toContain('.slim/deepwork/s1.md');
    expect(output.parts[0].text).toContain('refactor scheduler state');
    expect(output.parts[0].text).not.toContain(SLIM_INTERNAL_INITIATOR_MARKER);
  });

  test('ignores other commands', async () => {
    const hook = createDeepworkCommandHook();
    const output = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      { command: 'preset', sessionID: 's1', arguments: 'x' },
      output,
    );

    expect(output.parts).toEqual([{ type: 'text', text: 'template' }]);
  });

  test('pins a distinct progress-file path per session', async () => {
    // Uniqueness seam: two concurrent sessions must never resolve to the same
    // progress file — the direct anti-clobber guarantee of #1329.
    const hook = createDeepworkCommandHook();
    const a = { parts: [{ type: 'text', text: 'template' }] };
    const b = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      { command: 'deepwork', sessionID: 's1', arguments: 'task one' },
      a,
    );
    await hook.handleCommandExecuteBefore(
      { command: 'deepwork', sessionID: 's2', arguments: 'task two' },
      b,
    );

    expect(a.parts[0].text).toContain('.slim/deepwork/s1.md');
    expect(b.parts[0].text).toContain('.slim/deepwork/s2.md');
    expect(a.parts[0].text).not.toContain('s2');
    expect(b.parts[0].text).not.toContain('s1');
  });

  test('the skill is the single contract source for deepwork state', () => {
    // Cross-artifact machine-field seam: the session-keyed path token and the
    // verbatim ignore-file values must stay in the skill (the authoritative
    // contract) so they cannot drift apart silently.
    const skill = readFileSync(
      path.join(import.meta.dir, '../../skills/deepwork/SKILL.md'),
      'utf-8',
    );
    expect(skill).toContain('.slim/deepwork/<session-id>.md');
    expect(skill).toContain('ensure `.gitignore` contains');
    expect(skill).not.toContain('!.slim/deepwork/**');
    expect(skill).toContain('status: active');
  });
});
