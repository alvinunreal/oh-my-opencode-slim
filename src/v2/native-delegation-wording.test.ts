/**
 * C2 layer 1: native delegation vocabulary in generated prompts.
 *
 * On v2 hosts (hostFlavor 'v2', stamped by the v2 client shim) the
 * generated orchestrator/council prompt text must use the v2-native
 * delegation vocabulary directly (`subagent(...)` tool with the `agent`
 * parameter) instead of emitting v1 wording (`task(...)`,
 * `subagent_type`) and relying on the rewritePromptForV2 fallback.
 *
 * v1 hosts (no hostFlavor) must keep byte-identical v1 wording. That is
 * locked here by literal delegation-sentence assertions (matching the
 * pre-change master strings) plus the repo-wide golden snapshot in
 * src/hooks/cache-payload.snapshot.test.ts, which snapshots
 * buildOrchestratorPrompt with no hostFlavor and must not drift.
 *
 * rewritePromptForV2 stays as belt-and-suspenders for user-customized
 * presets that still contain v1 wording, and must be a no-op on native
 * v2 output (locked below).
 */

import { describe, expect, test } from 'bun:test';
import { createAgents } from '../agents';
import { buildOrchestratorPrompt } from '../agents/orchestrator';
import type { PluginConfig } from '../config';
import { CouncilConfigSchema } from '../config';
import { RuntimeConfig } from '../config/runtime';
import { delegationVocabulary, rewritePromptForV2 } from './adapters';

const TEST_DIRECTORY = 'runtime-test-native-delegation-wording';

function runtimeFor(config: PluginConfig | undefined = {}) {
  RuntimeConfig.reset(TEST_DIRECTORY);
  RuntimeConfig.init(TEST_DIRECTORY, config ?? {});
  return RuntimeConfig.get(TEST_DIRECTORY);
}

function councilConfig() {
  return CouncilConfigSchema.parse({
    presets: { default: { alpha: { model: 'test/councillor' } } },
  });
}

function orchestratorPromptFor(hostFlavor?: string): string {
  const agents = createAgents(
    runtimeFor({
      council: councilConfig(),
      disabled_agents: [],
    }),
    { hostFlavor },
  );
  const orchestrator = agents.find((a) => a.name === 'orchestrator');
  return orchestrator?.config.prompt as string;
}

describe('delegationVocabulary', () => {
  test("v2 → { tool: 'subagent', agentParam: 'agent' }", () => {
    expect(delegationVocabulary('v2')).toEqual({
      tool: 'subagent',
      agentParam: 'agent',
    });
  });

  test("v1/default → { tool: 'task', agentParam: 'subagent_type' }", () => {
    expect(delegationVocabulary(undefined)).toEqual({
      tool: 'task',
      agentParam: 'subagent_type',
    });
    expect(delegationVocabulary('v1')).toEqual({
      tool: 'task',
      agentParam: 'subagent_type',
    });
  });
});

describe('buildOrchestratorPrompt delegation vocabulary', () => {
  test('v2 hostFlavor emits subagent( wording with agent param', () => {
    const prompt = buildOrchestratorPrompt(
      undefined,
      undefined,
      true,
      true,
      'v2',
    );

    expect(prompt).toContain('`subagent(..., task_id: ...)`');
    expect(prompt).toContain('Prefer `subagent(..., background: true)`');
    expect(prompt).toContain('cannot receive another `subagent` call');
    expect(prompt).toContain("in the subagent tool's `task_id` argument");
    expect(prompt).toContain('call subagent with `agent: "fixer"`');
    expect(prompt).not.toContain('subagent_type');
    expect(prompt).not.toContain('task(');
  });

  test('v1 (no hostFlavor) keeps the exact v1 delegation sentences', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain(
      'Never use `task(..., task_id: ...)` to fetch output',
    );
    expect(prompt).toContain(
      'never use `task(..., task_id: ...)` as a progress check',
    );
    expect(prompt).toContain('Prefer `task(..., background: true)`');
    expect(prompt).toContain('cannot receive another `task` call');
    expect(prompt).toContain("in the task tool's `task_id` argument");
    expect(prompt).toContain('call task with `subagent_type: "fixer"`');
  });

  test('explicit v1/unknown hostFlavor is byte-identical to no hostFlavor', () => {
    expect(
      buildOrchestratorPrompt(undefined, undefined, true, true, 'v1'),
    ).toBe(buildOrchestratorPrompt());
    expect(
      buildOrchestratorPrompt(undefined, undefined, true, true, 'v3-ish'),
    ).toBe(buildOrchestratorPrompt());
  });

  test('rewritePromptForV2 is a no-op on native v2 output', () => {
    const v2 = buildOrchestratorPrompt(undefined, undefined, true, true, 'v2');
    expect(rewritePromptForV2(v2)).toBe(v2);
  });
});

describe('createAgents council dispatch vocabulary', () => {
  test('v2 hostFlavor emits subagent(agent=...) dispatch instructions', () => {
    const prompt = orchestratorPromptFor('v2');

    expect(prompt).toContain('## Council Mode');
    expect(prompt).toContain("subagent(agent='councillor-alpha'");
    expect(prompt).toContain('in PARALLEL via subagent():');
    expect(prompt).toContain("subagent(agent='council'");
    expect(prompt).not.toContain('subagent_type');
    expect(prompt).not.toContain('task(');
  });

  test('v1 (no hostFlavor) keeps the exact v1 council dispatch sentence', () => {
    const prompt = orchestratorPromptFor();

    expect(prompt).toContain('## Council Mode');
    expect(prompt).toContain("task(subagent_type='councillor-alpha'");
    expect(prompt).toContain('in PARALLEL via task():');
    expect(prompt).toContain("task(subagent_type='council'");
  });

  test('v2 and v1 prompts differ only by delegation vocabulary', () => {
    const v1 = orchestratorPromptFor();
    const v2 = orchestratorPromptFor('v2');
    expect(v2).toBe(
      v1
        .replaceAll('subagent_type', 'agent')
        .replaceAll('task(', 'subagent(')
        .replaceAll('`task` call', '`subagent` call')
        .replaceAll("the task tool's", "the subagent tool's")
        .replaceAll('call task with', 'call subagent with'),
    );
  });
});
