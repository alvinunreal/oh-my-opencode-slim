import { describe, expect, test } from 'bun:test';
import { createCouncilMasterAgent } from './council-master';

describe('createCouncilMasterAgent', () => {
  test('creates agent with correct name', () => {
    const agent = createCouncilMasterAgent('test-model');
    expect(agent.name).toBe('council-master');
  });

  test('creates agent with correct description', () => {
    const agent = createCouncilMasterAgent('test-model');
    expect(agent.description).toContain('Council synthesis engine');
  });

  test('sets model from argument', () => {
    const agent = createCouncilMasterAgent('custom-model');
    expect(agent.config.model).toBe('custom-model');
  });

  test('sets temperature to 0.1', () => {
    const agent = createCouncilMasterAgent('test-model');
    expect(agent.config.temperature).toBe(0.1);
  });

  test('sets default prompt when no custom prompts provided', () => {
    const agent = createCouncilMasterAgent('test-model');
    expect(agent.config.prompt).toContain(
      'council master responsible for synthesizing',
    );
  });

  test('uses custom prompt when provided', () => {
    const customPrompt = 'You are a custom synthesizer.';
    const agent = createCouncilMasterAgent('test-model', customPrompt);
    expect(agent.config.prompt).toBe(customPrompt);
    expect(agent.config.prompt).not.toContain('council master');
  });

  test('appends custom append prompt', () => {
    const customAppendPrompt = 'Additional instructions here.';
    const agent = createCouncilMasterAgent(
      'test-model',
      undefined,
      customAppendPrompt,
    );
    expect(agent.config.prompt).toContain('council master');
    expect(agent.config.prompt).toContain(customAppendPrompt);
    expect(agent.config.prompt).toContain('Additional instructions here.');
  });

  test('custom prompt takes priority over append prompt', () => {
    const customPrompt = 'Custom prompt only.';
    const customAppendPrompt = 'Should be ignored.';
    const agent = createCouncilMasterAgent(
      'test-model',
      customPrompt,
      customAppendPrompt,
    );
    expect(agent.config.prompt).toBe(customPrompt);
    expect(agent.config.prompt).not.toContain(customAppendPrompt);
  });
});

describe('council-master permissions', () => {
  test('denies all with single wildcard deny', () => {
    const agent = createCouncilMasterAgent('test-model');
    expect(agent.config.permission).toBeDefined();
    expect((agent.config.permission as Record<string, string>)['*']).toBe(
      'deny',
    );
  });

  test('denies question explicitly', () => {
    const agent = createCouncilMasterAgent('test-model');
    const permission = agent.config.permission as Record<string, string>;
    expect(permission.question).toBe('deny');
  });

  test('has exactly 2 permission entries', () => {
    const agent = createCouncilMasterAgent('test-model');
    const permission = agent.config.permission as Record<string, string>;
    expect(Object.keys(permission)).toHaveLength(2);
  });
});
