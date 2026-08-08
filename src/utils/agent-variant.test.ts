import { describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../config';
import { RuntimeConfig } from '../config/runtime';
import { normalizeAgentName, resolveRuntimeAgentName } from './agent-variant';

const TEST_DIRECTORY = 'runtime-test-agent-variant';

function runtimeFor(config: PluginConfig | undefined = {}) {
  RuntimeConfig.reset(TEST_DIRECTORY);
  RuntimeConfig.init(TEST_DIRECTORY, config ?? {});
  return RuntimeConfig.get(TEST_DIRECTORY);
}

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

describe('resolveRuntimeAgentName', () => {
  test('keeps internal agent names unchanged', () => {
    const config = {
      agents: {
        oracle: { displayName: 'advisor' },
      },
    } as PluginConfig;

    expect(resolveRuntimeAgentName(runtimeFor(config), 'oracle')).toBe(
      'oracle',
    );
  });

  test('resolves displayName to internal name', () => {
    const config = {
      agents: {
        oracle: { displayName: 'advisor' },
      },
    } as PluginConfig;

    expect(resolveRuntimeAgentName(runtimeFor(config), 'advisor')).toBe(
      'oracle',
    );
  });

  test('resolves displayName with @ prefix and whitespace', () => {
    const config = {
      agents: {
        oracle: { displayName: 'advisor' },
      },
    } as PluginConfig;

    expect(resolveRuntimeAgentName(runtimeFor(config), '  @advisor  ')).toBe(
      'oracle',
    );
  });

  test('resolves displayName configured via legacy alias key', () => {
    const config = {
      agents: {
        explore: { displayName: 'researcher' },
      },
    } as PluginConfig;

    expect(resolveRuntimeAgentName(runtimeFor(config), 'researcher')).toBe(
      'explorer',
    );
  });

  test('returns normalized name when no displayName match exists', () => {
    const config = {
      agents: {
        oracle: { displayName: 'advisor' },
      },
    } as PluginConfig;

    expect(resolveRuntimeAgentName(runtimeFor(config), '  @unknown  ')).toBe(
      'unknown',
    );
  });
});
