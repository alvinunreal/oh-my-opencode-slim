import { describe, expect, test } from 'bun:test';
import { buildOrchestratorPrompt, resolvePrompt } from './orchestrator';
import {
  DESIGNER_PROMPT,
  EXPLORER_PROMPT,
  FIXER_PROMPT,
  LIBRARIAN_PROMPT,
  OBSERVER_PROMPT,
  ORACLE_PROMPT,
} from './role-prompts';
import { ROLE_ROUTING_BLOCKS, renderRoleRoutingBlock } from './role-routing';

// These are instruction-contract regressions, not behavioral LLM evals.
// Golden snapshots cover the full text; these assertions explain the
// specific boundaries that an intentional prompt edit must preserve.
describe('agent prompt contracts', () => {
  test('routes by specialization without fixed model performance claims', () => {
    const prompt = buildOrchestratorPrompt();
    expect(prompt).toContain('depend on the configured models');
    expect(prompt).not.toMatch(/Stats:.*\d+(?:\.\d+)?x/);
    expect(prompt).not.toContain('perfect understanding');
    expect(prompt).toContain('quality, speed, cost, and reliability');
  });

  test('keeps specialist-first scheduling on both hosts', () => {
    for (const host of [undefined, 'v2']) {
      const prompt = buildOrchestratorPrompt(
        undefined,
        undefined,
        true,
        true,
        host,
      );
      expect(prompt).toContain('not the default implementation worker');
      expect(prompt).toContain('one isolated, clear, low-risk action');
      expect(prompt).toContain('dispatch them in parallel');
      expect(prompt).toContain('their write scopes do not conflict');
      expect(prompt).toContain('Never handle UI/design work directly');
      expect(
        buildOrchestratorPrompt(undefined, undefined, true, true, host),
      ).toBe(prompt);
    }
  });

  test('uses the same narrow direct-work exception in fixer routing', () => {
    const routing = ROLE_ROUTING_BLOCKS.fixer;
    expect(routing).toContain('one isolated, clear, low-risk action');
    expect(routing).not.toContain('<20 lines');
    expect(routing).not.toContain('Tight integration with your current work');
  });

  test('hands off decisions and acceptance criteria, not only file paths', () => {
    const prompt = buildOrchestratorPrompt();
    expect(prompt).toContain('objective, allowed scope and exclusions');
    expect(prompt).toContain('acceptance criteria');
    expect(prompt).toContain('validation owner and assigned checks');
    expect(prompt).toContain('parent conversation');
    expect(prompt).toContain('decisions not recorded in files');
    expect(prompt).toContain('send the delta');
    expect(prompt).toContain("Reference paths/lines, don't paste files");
  });

  test('allows only specified mechanical follow-up on approved designs', () => {
    expect(FIXER_PROMPT).toContain('No design decisions');
    expect(FIXER_PROMPT).toContain('explicitly specified mechanical');
    expect(FIXER_PROMPT).toContain('preserves the approved design exactly');
    expect(FIXER_PROMPT).toContain('visual judgment');
    expect(FIXER_PROMPT).toContain('use @designer');
    expect(FIXER_PROMPT).toContain('NO external research');
    expect(FIXER_PROMPT).toContain('NO spawning subagents');
    expect(FIXER_PROMPT).toContain('partial work and blockers');
    for (const tag of ['summary', 'changes', 'verification']) {
      expect(FIXER_PROMPT).toContain(`<${tag}>`);
      expect(FIXER_PROMPT).toContain(`</${tag}>`);
    }
  });

  test('keeps distinctive design subordinate to product constraints', () => {
    expect(DESIGNER_PROMPT).toContain('take precedence');
    expect(DESIGNER_PROMPT).toContain('existing design system');
    expect(DESIGNER_PROMPT).toContain('accessibility');
    expect(DESIGNER_PROMPT).toContain('product language');
    expect(DESIGNER_PROMPT).toContain('Distinctive design');
    expect(DESIGNER_PROMPT).not.toContain('code perfection comes second');
    expect(DESIGNER_PROMPT).not.toContain('regular english');
    expect(DESIGNER_PROMPT).toContain('Minimalist designs');
    expect(DESIGNER_PROMPT).toContain('Maximalist designs');
  });

  test('retains assigned-only validation for both writers', () => {
    for (const prompt of [FIXER_PROMPT, DESIGNER_PROMPT]) {
      expect(prompt).toContain('Run only validation assigned');
      expect(prompt).toContain('do not broaden it');
      expect(prompt).toContain('Report validation results and skips');
    }
  });

  test('bounds exploration and distinguishes search gaps from absence', () => {
    expect(EXPLORER_PROMPT).toContain('requested scope');
    expect(EXPLORER_PROMPT).toContain('not found in the searched scope');
    expect(EXPLORER_PROMPT).toContain('READ-ONLY');
    expect(EXPLORER_PROMPT).toContain('<results>');
    expect(EXPLORER_PROMPT).toContain('</results>');
  });

  test('anchors library guidance to project versions and available tools', () => {
    expect(LIBRARIAN_PROMPT).toContain("project's dependency version");
    expect(LIBRARIAN_PROMPT).toContain('version is unknown');
    expect(LIBRARIAN_PROMPT).toContain('available and permitted');
    expect(LIBRARIAN_PROMPT).toContain('official and community');
    expect(LIBRARIAN_PROMPT).toContain('READ-ONLY');
  });

  test('requires grounded findings without making oracle a mandatory hop', () => {
    expect(ORACLE_PROMPT).toContain('evidence and impact');
    expect(ORACLE_PROMPT).toContain('hypotheses and optional improvements');
    expect(ORACLE_PROMPT).toContain('no actionable findings');
    expect(ORACLE_PROMPT).toContain("You advise, you don't implement");
    expect(ROLE_ROUTING_BLOCKS.oracle).toContain(
      'an escalation, not a default verification step',
    );
  });

  test('uses native visual reading without requiring an OCR pipeline', () => {
    expect(OBSERVER_PROMPT).toContain('native read tool');
    expect(OBSERVER_PROMPT).toContain('exact visible text');
    expect(OBSERVER_PROMPT).not.toContain('via OCR');
    expect(OBSERVER_PROMPT).toContain('never guess or fabricate');
    expect(OBSERVER_PROMPT).toContain('Do not use bash or shell commands');
  });

  test('reports execution outcomes without routine narration', () => {
    const prompt = buildOrchestratorPrompt();
    expect(prompt).toContain('outcome, validation status');
    expect(prompt).toContain('unresolved limitations');
    expect(prompt).toContain("Do not restate the user's request");
    expect(prompt).not.toContain("Don't summarize what you did unless asked");
  });

  test('keeps council synthesis-only with its structured result contract', () => {
    expect(ROLE_ROUTING_BLOCKS.council).toContain('Synthesis only; no tools');
    expect(ROLE_ROUTING_BLOCKS.council).toContain('Per-Councillor Details');
    expect(ROLE_ROUTING_BLOCKS.council).toContain('Council Summary');
  });

  test('preserves disabled routing and custom prompt precedence', () => {
    const prompt = buildOrchestratorPrompt(new Set(['explorer']));
    expect(prompt).not.toContain(ROLE_ROUTING_BLOCKS.explorer);
    expect(prompt).toContain(ROLE_ROUTING_BLOCKS.fixer);
    expect(
      renderRoleRoutingBlock(
        { id: 'fixer', routingBlock: ROLE_ROUTING_BLOCKS.fixer },
        'worker',
      ),
    ).not.toContain('@fixer');
    expect(resolvePrompt('fixer', 'custom', undefined, FIXER_PROMPT)).toBe(
      'custom',
    );
    expect(
      resolvePrompt('fixer', undefined, 'file', FIXER_PROMPT, 'extra'),
    ).toBe('file\n\nextra');
  });
});
