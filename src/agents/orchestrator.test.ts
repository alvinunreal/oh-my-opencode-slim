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

  test('role identity defines orchestrator as workflow manager', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('workflow manager for coding work');
    expect(prompt).toContain('You are not the default implementation worker');
  });

  test('routing section describes task() mechanism', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('Dispatch work to a specialist');
    expect(prompt).toContain('calling the `task` tool');
    expect(prompt).toContain('subagent_type');
  });

  test('no "Don\'t delegate when" escape hatches remain', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).not.toMatch(/\*\*Don't delegate when:\*\*/);
    expect(prompt).not.toContain('Single small change');
    expect(prompt).not.toContain('First bug fix attempt');
    expect(prompt).not.toContain('Routine implementation/debugging');
  });

  test('no "handle directly" or "answer directly" permissions', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).not.toContain('handle directly');
    expect(prompt).not.toContain('answer directly');
    expect(prompt).not.toContain('delegation overhead exceeds');
  });

  test('no "Do not delegate merely because an agent exists"', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).not.toContain('Do not delegate merely because');
  });

  test('"Delegate when" sections are still present', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toMatch(/\*\*Delegate when:\*\*/);
  });

  test('design guardrail is present', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('Never handle UI/design work directly');
  });
});
