import { describe, expect, test } from 'bun:test';
import {
  COUNCIL_COMPACTION_EXCEPTION,
  createCouncilAgent,
  ensureCouncilCompactionException,
  ensureCouncilSynthesisReinforcement,
} from './council';

const COMPACTION_EXCEPTION =
  'if the host asks you to produce a session checkpoint or compaction summary in a specific template, follow that template exactly and do not use the council report format';

function councilPrompt(...args: Parameters<typeof createCouncilAgent>): string {
  const prompt = createCouncilAgent(...args).config.prompt;
  expect(prompt).toBeDefined();
  return prompt as string;
}

/** Assembly-layer chain: what agents/index.ts and registry.ts apply to the
 * FINAL effective council prompt (after resolvePrompt and host merge). */
function reinforced(prompt: string): string {
  return ensureCouncilCompactionException(
    ensureCouncilSynthesisReinforcement(prompt),
  );
}

describe('createCouncilAgent', () => {
  test('synthesis permission denies nested dispatch', () => {
    const permission = createCouncilAgent('provider/model').config
      .permission as Record<string, unknown>;
    expect(permission.task).toBe('deny');
  });

  test('factory emits the base prompt without inline reinforcement', () => {
    const prompt = councilPrompt('test/model');
    expect(prompt).toContain('## Council Response');
    expect(prompt).toContain('## Per-Councillor Details');
    expect(prompt).toContain('## Council Summary');
    // Reinforcement is applied at the assembly layer, not in the factory.
    expect(prompt).not.toContain('You MUST follow the Synthesis Process');
  });
});

describe('ensureCouncilSynthesisReinforcement (assembly layer)', () => {
  test('default base keeps the lean pointer, not the fallback', () => {
    const prompt = reinforced(councilPrompt('test/model'));
    expect(prompt).toContain(
      'You MUST follow the Synthesis Process and Required Output Format above',
    );
    expect(prompt).not.toContain('You MUST produce: ## Council Response');
    // The exception is in both the base prompt and the reinforcement,
    // so a custom prompt cannot drop it.
    const occurrences = prompt.split(COMPACTION_EXCEPTION).length - 1;
    expect(occurrences).toBe(2);
  });

  test('custom prompt override retains the required report format', () => {
    // Simulate the real assembly path: resolvePrompt replaced the generated
    // content with an override that dropped the format sections.
    const prompt = reinforced('Custom council prompt with no format rules.');
    expect(prompt).toContain('You MUST produce: ## Council Response');
    expect(prompt).toContain('## Per-Councillor Details');
    expect(prompt).toContain('## Council Summary');
    expect(prompt).toContain(COMPACTION_EXCEPTION);
  });

  test('override that keeps the format marker gets the lean pointer', () => {
    const prompt = reinforced(
      'Custom prompt with its own ## Council Response section.',
    );
    expect(prompt).toContain(
      'You MUST follow the Synthesis Process and Required Output Format above',
    );
    expect(prompt).not.toContain('You MUST produce: ## Council Response');
  });

  test('is idempotent', () => {
    const once = reinforced('Custom council prompt with no format rules.');
    const twice = reinforced(once);
    expect(once).toBe(twice);
    expect(once.split('You MUST produce: ## Council Response').length - 1).toBe(
      1,
    );
  });

  test('ensureCouncilCompactionException is idempotent', () => {
    const once = ensureCouncilCompactionException('custom council prompt');
    const twice = ensureCouncilCompactionException(once);
    expect(once).toBe(twice);
    expect(once.split(COUNCIL_COMPACTION_EXCEPTION).length - 1).toBe(1);
  });
});
