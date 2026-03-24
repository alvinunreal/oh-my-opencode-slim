import { describe, expect, test } from 'bun:test';
import { mergePluginAgentConfig } from './index';

describe('mergePluginAgentConfig', () => {
  test('keeps plugin-managed model fields authoritative', () => {
    const merged = mergePluginAgentConfig(
      {
        model: 'local/qwen3.5-27b-64k',
        temperature: 0.25,
        mode: 'subagent',
      },
      {
        model: 'openai/gpt-5.4-mini',
        temperature: 0.1,
        mode: 'subagent',
      },
    );

    expect(merged.model).toBe('local/qwen3.5-27b-64k');
    expect(merged.temperature).toBe(0.25);
  });

  test('preserves user tools and merges permissions', () => {
    const merged = mergePluginAgentConfig(
      {
        model: 'local/qwen3.5-27b-64k',
        permission: {
          question: 'allow',
          skill: { '*': 'deny' },
        },
      },
      {
        tools: { bash: true },
        permission: {
          question: 'deny',
          grep: 'allow',
        },
      },
    );

    expect(merged.tools).toEqual({ bash: true });
    expect(merged.permission).toEqual({
      question: 'deny',
      skill: { '*': 'deny' },
      grep: 'allow',
    });
  });

  test('returns plugin config unchanged when no existing agent config', () => {
    const merged = mergePluginAgentConfig({
      model: 'local/qwen3.5-27b-64k',
      prompt: 'test prompt',
    });

    expect(merged).toEqual({
      model: 'local/qwen3.5-27b-64k',
      prompt: 'test prompt',
    });
  });
});
