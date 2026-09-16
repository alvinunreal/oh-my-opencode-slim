import { describe, expect, test } from 'bun:test';
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
    expect(command.description).toContain('adapter');
    expect(command.description).toContain('deepwork');
    // Stale legacy phrasing must be gone.
    expect(command.description).not.toContain('heavy multi-phase');
    expect(command.template).not.toContain('deepwork session');
  });

  test('does not overwrite existing /deepwork command', () => {
    const hook = createDeepworkCommandHook();
    const existing = { template: 'custom', description: 'custom command' };
    const config: Record<string, unknown> = { command: { deepwork: existing } };

    hook.registerCommand(config);

    expect((config.command as Record<string, unknown>).deepwork).toBe(existing);
  });

  test('asks for an initiative when no arguments are provided', async () => {
    const hook = createDeepworkCommandHook();
    const output = { parts: [{ type: 'text', text: 'template' }] };

    await hook.handleCommandExecuteBefore(
      { command: 'deepwork', sessionID: 's1', arguments: '  ' },
      output,
    );

    expect(output.parts).toHaveLength(1);
    expect(output.parts[0].text).toContain(
      'What initiative should deepwork coordinate?',
    );
    expect(output.parts[0].text).toContain(SLIM_INTERNAL_INITIATOR_MARKER);
  });

  test('expands arguments into a deepwork adapter activation prompt', async () => {
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

    const text = output.parts[0].text as string;
    expect(output.parts).toHaveLength(1);
    // Adapter framing: slash command is an adapter, parent is sole controller.
    expect(text).toContain('user-entry adapter');
    expect(text).toContain(
      'parent/orchestrator is the sole lifecycle controller',
    );
    expect(text).toContain('never a callable');
    expect(text).toContain('procedure');
    // Explicit load/follow directive for the deepwork skill.
    expect(text).toContain('Load the deepwork skill and follow');
    // Every Tier-2 initiative including single-unit, plus long-horizon Tier-1.
    expect(text).toContain('every Tier-2 initiative');
    expect(text).toContain('single-unit');
    expect(text).toContain('long-horizon Tier-1 coordination');
    // Risk and horizon are separate axes.
    expect(text).toContain('Risk and horizon are separate');
    // Canonical records path with PLAN.md and REVIEW-LOG.md.
    expect(text).toContain('.slim/plans/<initiative>/PLAN.md');
    expect(text).toContain('REVIEW-LOG.md');
    // Explicit prohibitions.
    expect(text).toContain('per-phase Oracle gates');
    expect(text).toContain('second retry controller');
    expect(text).toContain('callable subprocedure');
    // Handoff contract.
    expect(text).toContain('Delivery unit packet');
    expect(text).toContain('Reviewer');
    expect(text).toContain('parent acceptance');
    expect(text).toContain('programmatically dispatch');
    expect(text).toContain('typed return objects');
    // User context preserved.
    expect(text).toContain('refactor scheduler state');
    // Legacy deepwork workflow phrases must be gone.
    expect(text).not.toContain('!.slim/deepwork/');
    expect(text).not.toContain('!.slim/deepwork/**');
    expect(text).not.toContain('git-local yet OpenCode-readable');
    expect(text).not.toContain('save code/doc deliverables');
    expect(text).not.toContain('@oracle');
    expect(text).not.toContain('simplify/readability');
    expect(text).not.toContain(SLIM_INTERNAL_INITIATOR_MARKER);
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
});
