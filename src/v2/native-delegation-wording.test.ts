/**
 * C2 layer 1: native delegation vocabulary in generated prompts.
 *
 * On v2 hosts (hostFlavor 'v2', stamped by the v2 client shim) the
 * generated orchestrator/council prompt text must use the v2-native
 * delegation vocabulary directly (`subagent(...)` tool with the `agent`
 * parameter) instead of emitting v1 wording (`task(...)`,
 * `subagent_type`).
 *
 * v1 hosts (no hostFlavor) must keep byte-identical v1 wording. That is
 * locked here by literal delegation-sentence assertions (matching the
 * pre-change master strings) plus the repo-wide golden snapshot in
 * src/hooks/cache-payload.snapshot.test.ts, which snapshots
 * buildOrchestratorPrompt with no hostFlavor and must not drift.
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
  test('v2 hostFlavor emits subagent( wording with agent param', () => {
    const prompt = buildOrchestratorPrompt(
      undefined,
      undefined,
      true,
      true,
      'v2',
    );

    expect(prompt).toContain('`subagent(agent, sessionID, prompt)`');
    // Background-default flip: the Prefer-background line is gone — the
    // flipped subagent description owns the default; the slim prompt keeps
    // only the post-dispatch discipline.
    expect(prompt).not.toContain('Prefer `subagent(..., background: true)`');
    expect(prompt).toContain('After dispatching, do non-overlapping work');
    expect(prompt).toContain('multiple `subagent` calls in one message');
    expect(prompt).not.toContain('subagent_type');
    expect(prompt).not.toContain('task(');
    expect(prompt).not.toContain('task_id');
  });

  test('v1 (no hostFlavor) keeps the exact v1 delegation sentences', () => {
    const prompt = buildOrchestratorPrompt();

    expect(prompt).toContain(
      'Never use `task(..., task_id: ...)` to fetch output',
    );
    expect(prompt).toContain('any resume starts new model work');
    // The blanket prefer-background line is replaced by the two-channel rule;
    // launch/poll mechanics stay with the host's tool description.
    expect(prompt).toContain(
      'Two-channel delegation: short work whose result feeds the next step → foreground',
    );
    expect(prompt).not.toContain('Prefer `task(..., background: true)`');
    expect(prompt).toContain('cannot receive another `task` call');
    expect(prompt).toContain(
      '`task_revive(task_id: "<task-id>", prompt: "...")`',
    );
    expect(prompt).toContain(
      'even when that session is not listed under Reusable Sessions',
    );
    expect(prompt).not.toContain('optional `model` argument');
  });

  test('explicit v1/unknown hostFlavor is byte-identical to no hostFlavor', () => {
    expect(
      buildOrchestratorPrompt(undefined, undefined, true, true, 'v1'),
    ).toBe(buildOrchestratorPrompt());
    expect(
      buildOrchestratorPrompt(undefined, undefined, true, true, 'v3-ish'),
    ).toBe(buildOrchestratorPrompt());
  });
});

/** v2.0.5+ model-param guidance, appended at the two `vocab.tool` prompt
 * sites (orchestrator base prompt + council block) when the host's
 * subagent tool supports the optional `model` parameter. */
const MODEL_PARAM_SENTENCE = ` The subagent tool also accepts an optional \`model\` argument ("providerID/modelID"). Only set it when the user explicitly asks for a specific model or variant; never guess the ID — look it up with the models tool first, filtering to your own provider.`;

/** Slim v2 model-param guidance (buildOrchestratorPromptV2): the optional
 * `model` parameter note compressed to one routing line. */
const SLIM_MODEL_PARAM_SENTENCE =
  'Set `model` only when the user asks; look up IDs with the models tool first.';

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
    // The slim base prompt carries the compressed model-param guidance.
    expect(prompt).toContain(SLIM_MODEL_PARAM_SENTENCE);
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
    expect(prompt).not.toContain(SLIM_MODEL_PARAM_SENTENCE);
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

    const v2 = disabledPromptFor('v2');
    expect(v2).toContain(
      'Seats: councillor-alpha — dispatch via subagent() when the user asks for consensus.',
    );
    expect(v2).not.toContain('dispatch via task()');

    const v1 = disabledPromptFor();
    expect(v1).toContain(
      'Seats: councillor-alpha — dispatch via task() when the user asks for consensus.',
    );
    expect(v1).not.toContain('dispatch via subagent()');
  });

  test('v2 keeps native resume guidance and does not adopt the v1 task_revive-first rule', () => {
    const v2 = orchestratorPromptFor('v2');

    expect(v2).toContain(
      '`task_status` is read-only inspection; `task_result` reads a finished result; neither launches, resumes, or instructs a child.',
    );
    expect(v2).toContain(
      'Continue a completed session with `subagent(agent, sessionID, prompt)` by exact id even when unlisted; cancelled/errored/stopped sessions use `task_revive`.',
    );
    expect(v2).not.toContain(
      'Only sessions listed under Reusable Sessions may be resumed with `subagent()`.',
    );
    expect(v2).not.toContain('task_revive(task_id:');
    expect(v2).not.toContain('task_id');
    expect(v2).not.toContain('task(');
  });
});
