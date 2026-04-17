import { describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../config';
import {
  applyAgentVariant,
  normalizeAgentName,
  resolveAgentVariant,
  resolveRuntimeAgentName,
  rewriteDisplayNameMentions,
} from './agent-variant';

describe('normalizeAgentName', () => {
  test('returns name unchanged if no @ prefix', () => {
    expect(normalizeAgentName('oracle')).toBe('oracle');
  });

  test('strips @ prefix from agent name', () => {
    expect(normalizeAgentName('@oracle')).toBe('oracle');
  });

  test('trims whitespace', () => {
    expect(normalizeAgentName('  oracle  ')).toBe('oracle');
  });

  test('handles @ prefix with whitespace', () => {
    expect(normalizeAgentName('  @explore  ')).toBe('explore');
  });

  test('handles empty string', () => {
    expect(normalizeAgentName('')).toBe('');
  });
});

describe('resolveAgentVariant', () => {
  test('returns undefined when config is undefined', () => {
    expect(resolveAgentVariant(undefined, 'oracle')).toBeUndefined();
  });

  test('returns undefined when agents is undefined', () => {
    const config = {} as PluginConfig;
    expect(resolveAgentVariant(config, 'oracle')).toBeUndefined();
  });

  test('returns undefined when agent has no variant', () => {
    const config = {
      agents: {
        oracle: { model: 'gpt-4' },
      },
    } as PluginConfig;
    expect(resolveAgentVariant(config, 'oracle')).toBeUndefined();
  });

  test('returns variant when configured', () => {
    const config = {
      agents: {
        oracle: { variant: 'high' },
      },
    } as PluginConfig;
    expect(resolveAgentVariant(config, 'oracle')).toBe('high');
  });

  test('normalizes agent name with @ prefix', () => {
    const config = {
      agents: {
        oracle: { variant: 'low' },
      },
    } as PluginConfig;
    expect(resolveAgentVariant(config, '@oracle')).toBe('low');
  });

  test('returns undefined for empty string variant', () => {
    const config = {
      agents: {
        oracle: { variant: '' },
      },
    } as PluginConfig;
    expect(resolveAgentVariant(config, 'oracle')).toBeUndefined();
  });

  test('returns undefined for whitespace-only variant', () => {
    const config = {
      agents: {
        oracle: { variant: '   ' },
      },
    } as PluginConfig;
    expect(resolveAgentVariant(config, 'oracle')).toBeUndefined();
  });

  test('trims variant whitespace', () => {
    const config = {
      agents: {
        oracle: { variant: '  medium  ' },
      },
    } as PluginConfig;
    expect(resolveAgentVariant(config, 'oracle')).toBe('medium');
  });

  test('returns undefined for non-string variant', () => {
    const config = {
      agents: {
        oracle: { variant: 123 as unknown as string },
      },
    } as PluginConfig;
    expect(resolveAgentVariant(config, 'oracle')).toBeUndefined();
  });

  test('resolves displayName alias to internal agent for variant lookup', () => {
    const config = {
      agents: {
        oracle: { displayName: 'advisor', variant: 'high' },
      },
    } as PluginConfig;
    expect(resolveAgentVariant(config, '@advisor')).toBe('high');
  });
});

describe('resolveRuntimeAgentName', () => {
  test('keeps internal agent names unchanged', () => {
    const config = {
      agents: {
        oracle: { displayName: 'advisor' },
      },
    } as PluginConfig;

    expect(resolveRuntimeAgentName(config, 'oracle')).toBe('oracle');
  });

  test('resolves displayName to internal name', () => {
    const config = {
      agents: {
        oracle: { displayName: 'advisor' },
      },
    } as PluginConfig;

    expect(resolveRuntimeAgentName(config, 'advisor')).toBe('oracle');
  });

  test('resolves displayName with @ prefix and whitespace', () => {
    const config = {
      agents: {
        oracle: { displayName: 'advisor' },
      },
    } as PluginConfig;

    expect(resolveRuntimeAgentName(config, '  @advisor  ')).toBe('oracle');
  });

  test('resolves displayName configured via legacy alias key', () => {
    const config = {
      agents: {
        explore: { displayName: 'researcher' },
      },
    } as PluginConfig;

    expect(resolveRuntimeAgentName(config, 'researcher')).toBe('explorer');
  });

  test('returns normalized name when no displayName match exists', () => {
    const config = {
      agents: {
        oracle: { displayName: 'advisor' },
      },
    } as PluginConfig;

    expect(resolveRuntimeAgentName(config, '  @unknown  ')).toBe('unknown');
  });
});

describe('rewriteDisplayNameMentions', () => {
  test('rewrites displayName mentions to internal names for direct invocation', () => {
    const config = {
      agents: {
        oracle: { displayName: 'advisor' },
      },
    } as PluginConfig;

    expect(rewriteDisplayNameMentions(config, 'ask @advisor about this')).toBe(
      'ask @oracle about this',
    );
  });

  test('keeps internal mentions working while rewriting aliases', () => {
    const config = {
      agents: {
        oracle: { displayName: 'advisor' },
      },
    } as PluginConfig;

    expect(
      rewriteDisplayNameMentions(config, 'compare @advisor with @oracle'),
    ).toBe('compare @oracle with @oracle');
  });

  test('does not rewrite embedded text such as email addresses', () => {
    const config = {
      agents: {
        oracle: { displayName: 'advisor' },
      },
    } as PluginConfig;

    expect(
      rewriteDisplayNameMentions(
        config,
        'email foo@advisor.com and ask @advisor directly',
      ),
    ).toBe('email foo@advisor.com and ask @oracle directly');
  });
});

describe('applyAgentVariant', () => {
  test('returns body unchanged when variant is undefined', () => {
    const body = { agent: 'oracle', parts: [] };
    const result = applyAgentVariant(undefined, body);
    expect(result).toEqual(body);
    expect(result).toBe(body); // Same reference
  });

  test('returns body unchanged when body already has variant', () => {
    const body = { agent: 'oracle', variant: 'medium', parts: [] };
    const result = applyAgentVariant('high', body);
    expect(result.variant).toBe('medium');
    expect(result).toBe(body); // Same reference
  });

  test('applies variant to body without variant', () => {
    const body = { agent: 'oracle', parts: [] };
    const result = applyAgentVariant('high', body);
    expect(result.variant).toBe('high');
    expect(result.agent).toBe('oracle');
    expect(result).not.toBe(body); // New object
  });

  test('preserves all existing body properties', () => {
    const body = {
      agent: 'oracle',
      parts: [{ type: 'text' as const, text: 'hello' }],
      tools: { background_task: false },
    };
    const result = applyAgentVariant('low', body);
    expect(result.agent).toBe('oracle');
    expect(result.parts).toEqual([{ type: 'text', text: 'hello' }]);
    expect(result.tools).toEqual({ background_task: false });
    expect(result.variant).toBe('low');
  });
});
