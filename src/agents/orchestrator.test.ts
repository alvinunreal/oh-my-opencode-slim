import { describe, expect, test } from 'bun:test';
import { buildOrchestratorPrompt } from './orchestrator';

describe('orchestrator prompt', () => {
  test('requires the question tool for blocking user input', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('use the `question` tool');
    expect(prompt).toContain('Enable custom input');
    expect(prompt).toContain('concise pasted response or command output');
    expect(prompt).toContain('small bounded set of options');
    expect(prompt).toContain('ordinary dialogue that does not block work');
  });

  test('requires wait_for_user for external manual work', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('call `wait_for_user` as your final tool action');
    expect(prompt).toContain('give the user concrete manual steps');
    expect(prompt).toContain('end the turn');
    expect(prompt).toContain('never use `wait_for_user` to await them');
    expect(prompt).toContain('Do not rely on ordinary text alone');
  });

  test('falls back to question when wait_for_user is disabled', () => {
    const prompt = buildOrchestratorPrompt(undefined, undefined, false);

    expect(prompt).not.toContain(
      'call `wait_for_user` as your final tool action',
    );
    expect(prompt).toContain('`wait_for_user` is disabled');
    expect(prompt).toContain(
      'use the `question` tool as the blocking boundary',
    );
  });

  test('omits end-turn instruction when wake scheduler is disabled', () => {
    const prompt = buildOrchestratorPrompt(undefined, undefined, true, false);

    expect(prompt).toContain('call `wait_for_user` as your final tool action');
    expect(prompt).not.toContain('End Turn After Background Tasks');
    expect(prompt).toContain('Do not immediately wait after spawning');
  });

  test('orchestrator is a workflow manager, not an implementation worker', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('workflow manager');
    expect(prompt).toContain('belongs to specialists');
    expect(prompt).toContain('Your output is a work graph');
    expect(prompt).not.toContain('MUST NOT');
    expect(prompt).not.toContain(
      'You are not the default implementation worker',
    );
  });

  test('no "Don\'t delegate when" escape hatches remain in agent descriptions', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).not.toMatch(/\*\*Don't delegate when:\*\*/);
    expect(prompt).not.toContain('Single small change');
    expect(prompt).not.toContain('First bug fix attempt');
    expect(prompt).not.toContain('Routine implementation/debugging');
  });

  test('no "handle directly" or "answer directly" permissions for orchestrator', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).not.toContain('handle directly');
    expect(prompt).not.toContain('answer directly');
    expect(prompt).not.toContain('delegation overhead exceeds');
  });

  test('no "Delegate when" sections in agent descriptions', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).not.toMatch(/\*\*Delegate when:\*\*/);
  });

  test('no "Rule of thumb" patterns in agent descriptions', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).not.toMatch(/\*\*Rule of thumb:\*\*/);
  });

  test('no "Stats:" comparisons in agent descriptions', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).not.toMatch(/\*\*Stats:\*\*/);
    expect(prompt).not.toContain('2x faster');
  });

  test('no example-based instructions in agent descriptions', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).not.toContain('Avoid:');
    expect(prompt).not.toContain('IMPORTANT:');
    expect(prompt).not.toContain('How to call:');
    expect(prompt).not.toContain('Result handling:');
  });

  test('routing section keeps identity frame and design guardrail, no explicit agent routing table', () => {
    const prompt = buildOrchestratorPrompt();

    // Identity frame stays
    expect(prompt).toContain('produced by a specialist');
    // Hard design guardrail stays
    expect(prompt).toContain('always routes to @designer');
    // Explicit routing table removed
    expect(prompt).not.toContain('routes to @explorer');
    expect(prompt).not.toContain('routes to @librarian');
    expect(prompt).not.toContain('route to @oracle');
    expect(prompt).not.toContain('routes to @fixer');
  });
});
