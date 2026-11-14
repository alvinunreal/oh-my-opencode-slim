/**
 * Native delegation vocabulary belongs to host tool descriptions. Generated
 * role prompts keep the workflow and council roster without repeating tool
 * names, argument syntax, or model-selection mechanics.
 */

import { describe, expect, test } from 'bun:test';
import { createAgents } from '../agents';
import { buildOrchestratorPrompt } from '../agents/orchestrator';
import type { PluginConfig } from '../config';
import { CouncilConfigSchema } from '../config';
import { RuntimeConfig } from '../config/runtime';
import { controlParamName, delegationVocabulary } from './adapters';

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
  test("v2 → { tool: 'subagent', agentParam: 'agent', resumeParam: 'sessionID' }", () => {
    expect(delegationVocabulary('v2')).toEqual({
      tool: 'subagent',
      agentParam: 'agent',
      resumeParam: 'sessionID',
    });
  });

  test("v1/default → { tool: 'task', agentParam: 'subagent_type', resumeParam: 'task_id' }", () => {
    expect(delegationVocabulary(undefined)).toEqual({
      tool: 'task',
      agentParam: 'subagent_type',
      resumeParam: 'task_id',
    });
    expect(delegationVocabulary('v1')).toEqual({
      tool: 'task',
      agentParam: 'subagent_type',
      resumeParam: 'task_id',
    });
  });

  test('controlParamName shares the delegation resume param per flavor', () => {
    expect(controlParamName('v2')).toBe('sessionID');
    expect(controlParamName('v1')).toBe('task_id');
    expect(controlParamName(undefined)).toBe('task_id');
    expect(delegationVocabulary('v2').resumeParam).toBe(controlParamName('v2'));
    expect(delegationVocabulary(undefined).resumeParam).toBe(
      controlParamName(undefined),
    );
  });
});

describe('buildOrchestratorPrompt delegation vocabulary', () => {
  test('v2 hostFlavor preserves the resume-only channel without v1 wake copy', () => {
    const prompt = buildOrchestratorPrompt({ hostFlavor: 'v2' });

    expect(prompt).toContain('completion notifications resume you');
    expect(prompt).not.toContain('wake scheduler resume you');
    expect(prompt).not.toContain('`subagent` calls in one message');
    expect(prompt).not.toContain('subagent_type');
    expect(prompt).not.toContain('task(');
    expect(prompt).not.toContain('task_id');
  });

  test('defaults to host completion notifications', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain('completion notifications resume you');
    expect(prompt).not.toContain('`task` calls in one message');
    expect(prompt).not.toContain('subagent(');
  });
});

/** v2.0.5+ model-param guidance, appended at the two `vocab.tool` prompt
 * sites (orchestrator base prompt + council block) when the host's
 * subagent tool supports the optional `model` parameter. */
const MODEL_PARAM_SENTENCE = ` The subagent tool also accepts an optional \`model\` argument ("providerID/modelID"). Only set it when the user explicitly asks for a specific model or variant; never guess the ID — look it up with the models tool first, filtering to your own provider.`;

describe('createAgents council seat pointer vocabulary', () => {
  test('v2 hostFlavor emits a roster-only seat pointer, not the full procedure', () => {
    const prompt = orchestratorPromptFor('v2');

    // Static pointer: seat roster only. The gate, the native vocabulary,
    // and the full Council Mode dispatch procedure all live in the block
    // the council-inject hook injects (first-hit, at the first council
    // trigger) — never carried statically.
    expect(prompt).toContain('## Council');
    expect(prompt).toContain('Seats: councillor-alpha');
    expect(prompt).not.toContain('dispatch via subagent()');
    expect(prompt).not.toContain('## Council Mode');
    expect(prompt).not.toContain('in PARALLEL');
    expect(prompt).not.toContain('models tool');
    expect(prompt).not.toContain('subagent_type');
    expect(prompt).not.toContain('task(');
  });

  test('v1 (no hostFlavor) keeps a roster-only seat pointer', () => {
    const prompt = orchestratorPromptFor();

    expect(prompt).toContain('## Council');
    expect(prompt).toContain('Seats: councillor-alpha');
    expect(prompt).not.toContain('dispatch via task()');
    expect(prompt).not.toContain('## Council Mode');
    expect(prompt).not.toContain('subagent(');
    expect(prompt).not.toContain(MODEL_PARAM_SENTENCE);
    expect(prompt).not.toContain('models tool');
  });

  test("the disabled-hook manual hint carries the flavor's native tool", () => {
    // With the hook off no block ever appears, so the roster's one-line
    // hint is the pointer's only vocabulary site — it must stay native.
    const disabledRuntime = () =>
      runtimeFor({
        council: councilConfig(),
        disabled_agents: [],
        disabled_hooks: ['council-inject'],
      });
    const disabledPromptFor = (hostFlavor?: string): string => {
      const agents = createAgents(disabledRuntime(), { hostFlavor });
      return agents.find((a) => a.name === 'orchestrator')?.config
        .prompt as string;
    };

    const expected =
      'Seats: councillor-alpha — dispatch when the user asks for consensus.';
    const v2 = disabledPromptFor('v2');
    expect(v2).toContain(expected);

    const v1 = disabledPromptFor();
    expect(v1).toContain(expected);
  });

  test('v2 does not adopt the v1 task_revive-first rule', () => {
    const v2 = orchestratorPromptFor('v2');

    expect(v2).not.toContain('task_result');
    expect(v2).not.toContain('task_revive');
    expect(v2).not.toContain(
      'Only sessions listed under Reusable Sessions may be resumed with `subagent()`.',
    );
    expect(v2).not.toContain('task_revive(task_id:');
    expect(v2).not.toContain('task_id');
    expect(v2).not.toContain('task(');
  });
});
