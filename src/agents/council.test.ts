import { describe, expect, test } from 'bun:test';
import {
  COUNCIL_COMPACTION_EXCEPTION,
  createCouncilAgent,
  ensureCouncilCompactionException,
} from './council';

const COMPACTION_EXCEPTION =
  'if the host asks you to produce a session checkpoint or compaction summary in a specific template, follow that template exactly and do not use the council report format';

function councilPrompt(...args: Parameters<typeof createCouncilAgent>): string {
  const prompt = createCouncilAgent(...args).config.prompt;
  expect(prompt).toBeDefined();
  return prompt as string;
}

describe('createCouncilAgent', () => {
  test('keeps the council report format for normal synthesis', () => {
    const prompt = councilPrompt('test/model');
    expect(prompt).toContain('## Council Response');
    expect(prompt).toContain('## Per-Councillor Details');
    expect(prompt).toContain('## Council Summary');
  });

  test('excepts host checkpoint/compaction templates from the council format', () => {
    const prompt = councilPrompt('test/model');
    expect(prompt).toContain(COMPACTION_EXCEPTION);
    // The exception is in both the base prompt and the post-override
    // reinforcement, so a custom prompt cannot drop it.
    const occurrences = prompt.split(COMPACTION_EXCEPTION).length - 1;
    expect(occurrences).toBe(2);
  });

  test('still excepts compaction when the base prompt is overridden', () => {
    const prompt = councilPrompt(
      'test/model',
      'Custom council prompt with no format rules.',
    );
    expect(prompt).toContain('Custom council prompt with no format rules.');
    expect(prompt).toContain(COMPACTION_EXCEPTION);
  });

  test('ensureCouncilCompactionException is idempotent', () => {
    const once = ensureCouncilCompactionException('custom council prompt');
    const twice = ensureCouncilCompactionException(once);
    expect(once).toBe(twice);
    expect(once.split(COUNCIL_COMPACTION_EXCEPTION).length - 1).toBe(1);
  });
});
