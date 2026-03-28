import { describe, expect, test } from 'bun:test';
import { createCouncillorAgent } from './councillor';

describe('createCouncillorAgent', () => {
  test('creates agent with correct name', () => {
    const agent = createCouncillorAgent('test-model');
    expect(agent.name).toBe('councillor');
  });

  test('creates agent with correct description', () => {
    const agent = createCouncillorAgent('test-model');
    expect(agent.description).toContain('Read-only council advisor');
  });

  test('sets model from argument', () => {
    const agent = createCouncillorAgent('custom-model');
    expect(agent.config.model).toBe('custom-model');
  });

  test('sets temperature to 0.2', () => {
    const agent = createCouncillorAgent('test-model');
    expect(agent.config.temperature).toBe(0.2);
  });

  test('sets default prompt when no custom prompts provided', () => {
    const agent = createCouncillorAgent('test-model');
    expect(agent.config.prompt).toContain(
      'councillor in a multi-model council',
    );
  });

  test('uses custom prompt when provided', () => {
    const customPrompt = 'You are a custom advisor.';
    const agent = createCouncillorAgent('test-model', customPrompt);
    expect(agent.config.prompt).toBe(customPrompt);
    expect(agent.config.prompt).not.toContain('multi-model council');
  });

  test('appends custom append prompt', () => {
    const customAppendPrompt = 'Additional instructions here.';
    const agent = createCouncillorAgent(
      'test-model',
      undefined,
      customAppendPrompt,
    );
    expect(agent.config.prompt).toContain('multi-model council');
    expect(agent.config.prompt).toContain(customAppendPrompt);
    expect(agent.config.prompt).toContain('Additional instructions here.');
  });

  test('custom prompt takes priority over append prompt', () => {
    const customPrompt = 'Custom prompt only.';
    const customAppendPrompt = 'Should be ignored.';
    const agent = createCouncillorAgent(
      'test-model',
      customPrompt,
      customAppendPrompt,
    );
    expect(agent.config.prompt).toBe(customPrompt);
    expect(agent.config.prompt).not.toContain(customAppendPrompt);
  });
});

describe('councillor permissions', () => {
  test('denies all by default with wildcard', () => {
    const agent = createCouncillorAgent('test-model');
    expect(agent.config.permission).toBeDefined();
    expect((agent.config.permission as Record<string, string>)['*']).toBe(
      'deny',
    );
  });

  test('denies question explicitly', () => {
    const agent = createCouncillorAgent('test-model');
    expect((agent.config.permission as Record<string, string>).question).toBe(
      'deny',
    );
  });

  test('allows read-only tools', () => {
    const agent = createCouncillorAgent('test-model');
    const permission = agent.config.permission as Record<string, string>;
    expect(permission.read).toBe('allow');
    expect(permission.glob).toBe('allow');
    expect(permission.grep).toBe('allow');
  });

  test('allows lsp and list tools', () => {
    const agent = createCouncillorAgent('test-model');
    const permission = agent.config.permission as Record<string, string>;
    expect(permission.lsp).toBe('allow');
    expect(permission.list).toBe('allow');
  });

  test('has exactly 8 permission entries', () => {
    const agent = createCouncillorAgent('test-model');
    const permission = agent.config.permission as Record<string, string>;
    expect(Object.keys(permission)).toHaveLength(8);
  });
});
