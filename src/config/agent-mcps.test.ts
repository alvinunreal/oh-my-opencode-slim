import { describe, expect, test } from 'bun:test';
import { DEFAULT_AGENT_MCPS, getAgentMcpList, parseList } from './agent-mcps';
import { RuntimeConfig } from './runtime';
import type { PluginConfig } from './schema';

const TEST_DIRECTORY = 'runtime-test-agent-mcps';
function runtimeFor(config: PluginConfig = {}) {
  RuntimeConfig.reset(TEST_DIRECTORY);
  return RuntimeConfig.init(TEST_DIRECTORY, config);
}

describe('parseList', () => {
  test('empty list returns empty array', () => {
    expect(parseList([], ['mcp1', 'mcp2'])).toEqual([]);
  });

  test('wildcard includes all available', () => {
    expect(parseList(['*'], ['mcp1', 'mcp2', 'mcp3'])).toEqual([
      'mcp1',
      'mcp2',
      'mcp3',
    ]);
  });

  test('orchestrator wildcard excludes context7 but includes custom mcps', () => {
    expect(
      parseList(DEFAULT_AGENT_MCPS.orchestrator, [
        'context7',
        'gh_grep',
        'custom-mcp',
      ]),
    ).toEqual(['gh_grep', 'custom-mcp']);
  });

  test('wildcard with exclusions', () => {
    expect(parseList(['*', '!mcp2'], ['mcp1', 'mcp2', 'mcp3'])).toEqual([
      'mcp1',
      'mcp3',
    ]);
  });

  test('exclude wildcard returns empty', () => {
    expect(parseList(['!*'], ['mcp1', 'mcp2'])).toEqual([]);
  });

  test('specific items only', () => {
    expect(
      parseList(['mcp1', 'mcp3'], ['mcp1', 'mcp2', 'mcp3', 'mcp4']),
    ).toEqual(['mcp1', 'mcp3']);
  });

  test('specific items with exclusions', () => {
    expect(
      parseList(['mcp1', 'mcp3', '!mcp3'], ['mcp1', 'mcp2', 'mcp3']),
    ).toEqual(['mcp1']);
  });

  test('exclusions without matching allows', () => {
    expect(parseList(['!mcp2'], ['mcp1', 'mcp2', 'mcp3'])).toEqual([]);
  });

  test('exclude-all beats specific allows', () => {
    expect(parseList(['mcp1', '!*'], ['mcp1', 'mcp2'])).toEqual([]);
    expect(parseList(['*', '!*'], ['mcp1', 'mcp2'])).toEqual([]);
  });

  test('plain names never act as exclusions', () => {
    expect(
      parseList(['xabc', 'abc', '!zzz'], ['xabc', 'abc', 'zzz']),
    ).toEqual(['xabc', 'abc']);
  });
});

describe('default MCP policy', () => {
  test('per-agent defaults are the documented policy', () => {
    expect(DEFAULT_AGENT_MCPS).toEqual({
      orchestrator: ['*', '!context7'],
      designer: [],
      oracle: [],
      explorer: ['context7', 'gh_grep'],
      fixer: [],
      observer: [],
      council: [],
      councillor: [],
    });
  });

  test('unknown agents get no MCPs', () => {
    const runtime = runtimeFor({});
    expect(getAgentMcpList('not-an-agent', runtime)).toEqual([]);
  });
});

describe('getAgentMcpList rename continuity', () => {
  test("reads mcps from a legacy 'librarian' record for the explorer", () => {
    const runtime = runtimeFor({
      agents: { librarian: { mcps: ['legacy-mcp'] } },
    });
    expect(getAgentMcpList('explorer', runtime)).toEqual(['legacy-mcp']);
  });

  test("canonical 'explorer' mcps win over the legacy record", () => {
    const runtime = runtimeFor({
      agents: {
        explorer: { mcps: ['canonical-mcp'] },
        librarian: { mcps: ['legacy-mcp'] },
      },
    });
    expect(getAgentMcpList('explorer', runtime)).toEqual(['canonical-mcp']);
  });

  test('agent config without mcps falls back to the default policy', () => {
    const runtime = runtimeFor({ agents: { explorer: {} } });
    expect(getAgentMcpList('explorer', runtime)).toEqual([
      'context7',
      'gh_grep',
    ]);
  });
});
