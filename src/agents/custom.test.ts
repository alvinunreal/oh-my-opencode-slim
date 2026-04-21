import { describe, expect, test } from 'bun:test';
import { createCustomAgent } from './custom';

describe('createCustomAgent', () => {
  test('creates agent with correct name', () => {
    const agent = createCustomAgent('janitor', 'test/model');
    expect(agent.name).toBe('janitor');
  });

  test('creates agent with correct model', () => {
    const agent = createCustomAgent(
      'janitor',
      'anthropic/claude-sonnet-4-20250514',
    );
    expect(agent.config.model).toBe('anthropic/claude-sonnet-4-20250514');
  });

  test('sets temperature to 0.1', () => {
    const agent = createCustomAgent('janitor', 'test/model');
    expect(agent.config.temperature).toBe(0.1);
  });

  test('uses default prompt when no basePrompt given', () => {
    const agent = createCustomAgent('janitor', 'test/model');
    expect(agent.config.prompt).toBe(
      "You are a specialized AI agent called janitor. Follow the user's instructions carefully.",
    );
  });

  test('default prompt includes agent name', () => {
    const agent = createCustomAgent('my-specialist', 'test/model');
    expect(agent.config.prompt).toContain('my-specialist');
  });

  test('uses default description when no description given', () => {
    const agent = createCustomAgent('janitor', 'test/model');
    expect(agent.description).toBe('Custom agent: janitor');
  });

  test('uses provided basePrompt when given', () => {
    const agent = createCustomAgent(
      'janitor',
      'test/model',
      'You clean up code.',
    );
    expect(agent.config.prompt).toBe('You clean up code.');
    expect(agent.config.prompt).not.toContain('specialized AI agent');
  });

  test('uses provided description', () => {
    const agent = createCustomAgent(
      'janitor',
      'test/model',
      undefined,
      'Code cleanup specialist',
    );
    expect(agent.description).toBe('Code cleanup specialist');
  });

  test('file prompt replaces base prompt when provided', () => {
    const filePrompt = 'File-based prompt override.';
    const agent = createCustomAgent(
      'janitor',
      'test/model',
      'Inline base prompt.',
      undefined,
      filePrompt,
    );
    expect(agent.config.prompt).toBe(filePrompt);
    expect(agent.config.prompt).not.toContain('Inline base prompt.');
  });

  test('file append prompt appends to base prompt', () => {
    const appendPrompt = 'Additional instructions.';
    const agent = createCustomAgent(
      'janitor',
      'test/model',
      'Base prompt.',
      undefined,
      undefined,
      appendPrompt,
    );
    expect(agent.config.prompt).toContain('Base prompt.');
    expect(agent.config.prompt).toContain('Additional instructions.');
  });

  test('file append prompt appends to default prompt when no base given', () => {
    const appendPrompt = 'Extra rules.';
    const agent = createCustomAgent(
      'janitor',
      'test/model',
      undefined,
      undefined,
      undefined,
      appendPrompt,
    );
    expect(agent.config.prompt).toContain(
      'specialized AI agent called janitor',
    );
    expect(agent.config.prompt).toContain('Extra rules.');
  });

  test('file prompt takes priority over both base and append prompt', () => {
    const filePrompt = 'File prompt only.';
    const appendPrompt = 'Should be ignored.';
    const agent = createCustomAgent(
      'janitor',
      'test/model',
      'Base prompt.',
      undefined,
      filePrompt,
      appendPrompt,
    );
    expect(agent.config.prompt).toBe(filePrompt);
    expect(agent.config.prompt).not.toContain('Base prompt.');
    expect(agent.config.prompt).not.toContain('Should be ignored.');
  });

  test('creates agent with all parameters', () => {
    const agent = createCustomAgent(
      'janitor',
      'anthropic/claude-sonnet-4-20250514',
      'You clean up code.',
      'Code cleanup specialist',
    );
    expect(agent.name).toBe('janitor');
    expect(agent.config.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(agent.config.prompt).toBe('You clean up code.');
    expect(agent.description).toBe('Code cleanup specialist');
    expect(agent.config.temperature).toBe(0.1);
  });
});
