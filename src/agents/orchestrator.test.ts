import { describe, expect, test } from 'bun:test';
import { buildOrchestratorPrompt } from './orchestrator';

describe('buildOrchestratorPrompt', () => {
  test('granular mode includes @long-fixer and @quick-fixer references', () => {
    const prompt = buildOrchestratorPrompt(true);
    expect(prompt).toContain('@long-fixer');
    expect(prompt).toContain('@quick-fixer');
  });

  test('granular mode does not include @fixer in agent descriptions', () => {
    const prompt = buildOrchestratorPrompt(true);
    // Should not contain the standalone @fixer agent description block
    expect(prompt).not.toContain(
      '@fixer\n- Role: Fast implementation specialist',
    );
    // Should not reference @fixer in delegation lines
    expect(prompt).not.toContain('- @fixer');
  });

  test('standard mode includes @fixer description', () => {
    const prompt = buildOrchestratorPrompt(false);
    expect(prompt).toContain('@fixer');
    expect(prompt).toContain('@fixer\n- Role: Fast implementation specialist');
  });

  test('standard mode does not include granular fixer references', () => {
    const prompt = buildOrchestratorPrompt(false);
    expect(prompt).not.toContain('@long-fixer');
    expect(prompt).not.toContain('@quick-fixer');
  });
});
