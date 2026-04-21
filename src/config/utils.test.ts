import { describe, expect, test } from 'bun:test';
import type { PluginConfig } from './schema';
import { getCustomAgentNames } from './utils';

describe('getCustomAgentNames', () => {
  test('returns empty array when no config', () => {
    expect(getCustomAgentNames(undefined)).toEqual([]);
  });

  test('returns empty array when config has no agents', () => {
    const config: PluginConfig = {};
    expect(getCustomAgentNames(config)).toEqual([]);
  });

  test('returns empty array when config only has built-in agent names', () => {
    const config: PluginConfig = {
      agents: {
        orchestrator: { model: 'test/model' },
        explorer: { model: 'test/model' },
        fixer: { model: 'test/model' },
      },
    };
    expect(getCustomAgentNames(config)).toEqual([]);
  });

  test('returns custom names when config has non-built-in names', () => {
    const config: PluginConfig = {
      agents: {
        janitor: { model: 'test/janitor-model' },
      },
    };
    expect(getCustomAgentNames(config)).toEqual(['janitor']);
  });

  test('legacy alias explore is NOT returned as custom', () => {
    const config: PluginConfig = {
      agents: {
        explore: { model: 'test/model' },
      },
    };
    expect(getCustomAgentNames(config)).toEqual([]);
  });

  test('legacy alias frontend-ui-ux-engineer is NOT returned as custom', () => {
    const config: PluginConfig = {
      agents: {
        'frontend-ui-ux-engineer': { model: 'test/model' },
      },
    };
    expect(getCustomAgentNames(config)).toEqual([]);
  });

  test('mixed config: built-in + alias + custom returns only custom names', () => {
    const config: PluginConfig = {
      agents: {
        explorer: { model: 'test/model' },
        explore: { model: 'test/old-model' },
        janitor: { model: 'test/janitor-model' },
      },
    };
    const names = getCustomAgentNames(config);
    expect(names).toContain('janitor');
    expect(names).not.toContain('explorer');
    expect(names).not.toContain('explore');
    expect(names).toHaveLength(1);
  });

  test('returns multiple custom agents', () => {
    const config: PluginConfig = {
      agents: {
        janitor: { model: 'test/janitor-model' },
        reviewer: { model: 'test/reviewer-model' },
        deployer: { model: 'test/deployer-model' },
      },
    };
    const names = getCustomAgentNames(config);
    expect(names).toContain('janitor');
    expect(names).toContain('reviewer');
    expect(names).toContain('deployer');
    expect(names).toHaveLength(3);
  });

  test('does not return built-in subagent names as custom', () => {
    const config: PluginConfig = {
      agents: {
        librarian: { model: 'test/model' },
        oracle: { model: 'test/model' },
        designer: { model: 'test/model' },
        council: { model: 'test/model' },
        councillor: { model: 'test/model' },
        'council-master': { model: 'test/model' },
      },
    };
    expect(getCustomAgentNames(config)).toEqual([]);
  });
});
