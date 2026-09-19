import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLIM_INTERNAL_INITIATOR_MARKER } from '../../utils';
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
    // Description describes bounded delivery, not file-based history.
    expect(command.description).toContain('bounded delivery');
    expect(command.description).not.toContain('file-based history');
    expect(command.template).not.toContain('execute-verify');
    expect(command.template).not.toContain('Dispatch fixer');
  });

  test('does not overwrite existing /loop command', () => {
    const hook = createLoopCommandHook();
    const existing = { template: 'custom', description: 'custom loop' };
    const config: Record<string, unknown> = { command: { loop: existing } };
    hook.registerCommand(config);
    expect((config.command as Record<string, unknown>).loop).toBe(existing);
  });

  test('shows adapter help when no arguments provided', async () => {
    const hook = createLoopCommandHook();
    const output = { parts: [] as Array<{ type: string; text?: string }> };

    await hook.handleCommandExecuteBefore(
      { command: 'loop', sessionID: 's1', arguments: '  ' },
      output,
    );

    expect(output.parts.length).toBe(1);
    const text = output.parts[0].text as string;
    expect(text).toContain('Usage');
    expect(text).toContain('user-entry adapter');
    expect(text).toContain('loop-engineering protocol');
    expect(text).toContain('non-resettable ceiling');
    expect(text).toContain('not a callable subprocedure');
    expect(text).toContain(SLIM_INTERNAL_INITIATOR_MARKER);
  });

  test('generates loop-engineering adapter activation prompt with user text', async () => {
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

    const text = output.parts[0].text as string;
    expect(output.parts.length).toBe(1);
    // Adapter framing.
    expect(text).toContain('The user ran `/loop`');
    expect(text).toContain('user-entry adapter');
    expect(text).toContain(
      'parent/orchestrator coordinates the loop-engineering protocol',
    );
    expect(text).toContain('loop-engineering skill');
    // Prepared unit + proof contract requirement.
    expect(text).toContain('prepared unit/specification and a proof contract');
    expect(text).toContain('must not redesign the initiative');
    // Stricter attempt limit preserved as non-resettable ceiling.
    expect(text).toContain('non-resettable ceiling');
    // Explicit prohibitions.
    expect(text).toContain('do not create `.opencode/loop-history/`');
    expect(text).toContain('do not treat a pass as initiative completion');
    expect(text).toContain('resettable attempt budget');
    expect(text).toContain('callable subprocedure');
    // Handoff contract.
    expect(text).toContain('Delivery unit packet');
    expect(text).toContain('Reviewer');
    expect(text).toContain('parent acceptance');
    expect(text).toContain('programmatically dispatch');
    expect(text).toContain('typed return objects');
    // User context preserved.
    expect(text).toContain(
      'fix typescript errors until typecheck passes, max 3 tries',
    );
    // Legacy loop workflow phrases must be gone.
    expect(text).not.toContain('goal, successCriteria, maxAttempts');
    expect(text).not.toContain('missing or unclear');
    expect(text).not.toContain('history-{NNN}.md');
    expect(text).not.toContain('Dispatch @fixer');
    expect(text).not.toContain(SLIM_INTERNAL_INITIATOR_MARKER);
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

describe('loop-engineering SKILL.md canonical protocol', () => {
  const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const skillPath = join(packageRoot, 'src/skills/loop-engineering/SKILL.md');
  const content = readFileSync(skillPath, 'utf8');

  test('contains canonical protocol wording', () => {
    expect(content).toContain('bounded delivery protocol');
    expect(content).toContain('parent/orchestrator owns the lifecycle');
    expect(content).toContain('user-entry adapter');
    expect(content).toContain('never a callable procedure');
    expect(content).toContain('prepared delivery unit packet');
    expect(content).toContain('review_mode=implementation');
    expect(content).toContain('planned proof');
    expect(content).toContain('parent acceptance');
    expect(content).toContain('non-resettable ceiling');
    expect(content).toContain('replan');
  });

  test('contains pre-dispatch blocking checks', () => {
    expect(content).toContain('Block dispatch');
    expect(content).toContain('proof command is missing');
    expect(content).toContain('dependency is unmet');
    expect(content).toContain('Tier-2');
    expect(content).toContain('user authorisation');
  });

  test('contains delivery result recording', () => {
    expect(content).toContain('Delivery Result');
    expect(content).toContain('candidate and diff identity');
    expect(content).toContain('proof results');
    expect(content).toContain('review verdict');
    expect(content).toContain('parent acceptance outcome');
    expect(content).toContain('next action');
  });

  test('legacy Grill/Monitor/callback phrases appear only in prohibitions', () => {
    // These legacy terms must not appear as active instructions.
    // They may appear in the Prohibitions section as explicitly banned.
    const prohibitionsStart = content.indexOf('## Prohibitions');
    const prohibitionsEnd = content.indexOf('##', prohibitionsStart + 1);
    const prohibitionsSection =
      prohibitionsStart >= 0
        ? content.slice(prohibitionsStart, prohibitionsEnd)
        : '';
    const beforeProhibitions =
      prohibitionsStart >= 0 ? content.slice(0, prohibitionsStart) : content;

    // Active instruction sections must not contain legacy runtime concepts.
    expect(beforeProhibitions).not.toContain('Grill');
    expect(beforeProhibitions).not.toContain('Loop Monitor');
    expect(beforeProhibitions).not.toContain('onLoopComplete');
    expect(beforeProhibitions).not.toContain('onEscalated');
    expect(beforeProhibitions).not.toContain('onManualReview');
    expect(beforeProhibitions).not.toContain('resolveManualReview');
    expect(beforeProhibitions).not.toContain('cancel(loopID)');
    expect(beforeProhibitions).not.toContain('BackgroundJobBoard');
    expect(beforeProhibitions).not.toContain('success type');
    expect(beforeProhibitions).not.toContain('Max attempts');

    // The Prohibitions section must explicitly ban the callback API.
    expect(prohibitionsSection).toContain('onLoopComplete');
    expect(prohibitionsSection).toContain('resolveManualReview');

    // Manual verification must not appear as an active feature anywhere
    // before prohibitions.
    expect(beforeProhibitions).not.toContain('manual verification');
  });
});
