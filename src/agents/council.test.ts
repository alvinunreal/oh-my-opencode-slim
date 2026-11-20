import { describe, expect, test } from 'bun:test';
import { createCouncilAgent, ensureCouncilPrompt } from './council';

const COMPACTION_EXCEPTION =
  'Exception: if the host asks you to produce a session checkpoint or compaction summary in a specific template, follow that template exactly and do not use the council report format.';

const base = createCouncilAgent('test/model').config.prompt ?? '';
const headings = [
  '## Council Response',
  '## Per-Councillor Details',
  '## Council Summary',
];

describe('council synthesis', () => {
  test('the agent is tool-less by permission', () => {
    const { permission } = createCouncilAgent('test/model').config;
    expect(permission).toMatchObject({ '*': 'deny', task: 'deny' });
    expect(
      Object.values(permission ?? {}).every((value) => value === 'deny'),
    ).toBe(true);
  });

  test('the default report and compaction exception appear once', () => {
    expect(ensureCouncilPrompt(base)).toBe(base);
    for (const section of [...headings, COMPACTION_EXCEPTION]) {
      expect(base.split(section)).toHaveLength(2);
    }
    expect(base).toContain('By exact seat name');
    expect(base).toContain('failure status');
    expect(base).toContain(
      'If no seat answered, report synthesis unavailable.',
    );
  });

  test('a formatless override gets the same report as the default', () => {
    const custom = 'Custom council prompt without format rules.';
    const finalized = ensureCouncilPrompt(custom);
    expect(finalized).toBe(`${custom}\n\n${base}`);
    expect(ensureCouncilPrompt(finalized)).toBe(finalized);
  });

  test('an override with a report format gains only the compaction exception', () => {
    const custom = 'Custom prompt with its own ## Council Response format.';
    const finalized = `${custom}\n\n${COMPACTION_EXCEPTION}`;
    expect(ensureCouncilPrompt(custom)).toBe(finalized);
    expect(ensureCouncilPrompt(finalized)).toBe(finalized);
  });

  test('restoring a missing report preserves an existing compaction exception', () => {
    const custom = `Custom instructions.\n\n${COMPACTION_EXCEPTION}`;
    const finalized = ensureCouncilPrompt(custom);
    expect(finalized).toStartWith(custom);
    expect(finalized.split(COMPACTION_EXCEPTION)).toHaveLength(2);
    for (const heading of headings) expect(finalized).toContain(heading);
    expect(ensureCouncilPrompt(finalized)).toBe(finalized);
  });
});
