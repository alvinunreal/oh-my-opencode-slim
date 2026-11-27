import { afterEach, describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../config';
import { CouncilConfigSchema } from '../config';
import { RuntimeConfig } from '../config/runtime';
import { createAgents, getAgentConfigsFromDefinitions } from './index';
import {
  buildOrchestratorPrompt,
  createOrchestratorAgent,
} from './orchestrator';
import { SPECIALIST_DESCRIPTIONS } from './role-descriptions';

const DIRECTORY = 'runtime-test-orchestrator-native-catalog';
function agentsFor(config: PluginConfig = {}) {
  RuntimeConfig.reset(DIRECTORY);
  const runtime = RuntimeConfig.init(DIRECTORY, config);
  return { runtime, agents: createAgents(runtime, { hostFlavor: 'v2' }) };
}

afterEach(() => RuntimeConfig.reset(DIRECTORY));

function promptOf(config: PluginConfig = {}): string {
  return agentsFor(config).agents.find((agent) => agent.name === 'orchestrator')
    ?.config.prompt as string;
}

describe('orchestrator prompt', () => {
  test('keeps coordination policy without a second agent catalog', () => {
    const prompt = buildOrchestratorPrompt();
    for (const policy of [
      'Orchestrator plans, delegates, monitors, reconciles and verifies',
      'context-heavy docs',
      'disjoint',
      '<user_request>',
      'commands, exit statuses',
      'Summaries are claims, not evidence',
      'same child',
    ]) {
      expect(prompt).toContain(policy);
    }
    for (const duplicate of [
      '<Agents>',
      'Skills:',
      'Available subagents:',
      '@explorer',
      '@fixer',
      'completion notifications resume you',
      '`subagent`',
      'task_id',
      'task_message',
      'task_revive',
    ]) {
      expect(prompt).not.toContain(duplicate);
    }
  });

  test('renders deterministic bytes', () => {
    const first = buildOrchestratorPrompt();
    expect(buildOrchestratorPrompt()).toBe(first);
    expect(first).toMatchSnapshot();
  });

  test('manual user steps remain tool-neutral', () => {
    const prompt = buildOrchestratorPrompt();
    expect(prompt).toContain('external manual step, give concrete');
    expect(prompt).toContain('instructions, then ask and end the turn.');
    expect(prompt).not.toContain('wait_for_user');
    expect(prompt).not.toContain('`question`');
  });

  test('custom replacements and append text are unchanged', () => {
    expect(
      createOrchestratorAgent(undefined, 'custom', 'extra').config.prompt,
    ).toBe('custom\n\nextra');
    expect(createOrchestratorAgent().config.prompt).toBe(
      buildOrchestratorPrompt(),
    );
  });
});

describe('native agent catalog ownership', () => {
  test('ordinary roster changes do not alter the coordinator prompt', () => {
    const expected = buildOrchestratorPrompt();
    for (const config of [
      {},
      { backgroundJobs: { mode: 'off' } },
      { disabled_agents: ['explorer', 'oracle', 'designer', 'fixer'] },
      { agents: { fixer: { skills: ['simplify'] } } },
    ] satisfies PluginConfig[]) {
      expect(promptOf(config)).toBe(expected);
    }
  });

  test('native descriptions carry routing criteria and permission maps stay authored', () => {
    const { runtime, agents } = agentsFor({
      disabled_agents: [],
      agents: {
        oracle: { displayName: 'Advisor' },
        orchestrator: {
          permission: { task: { '*': 'deny', Advisor: 'allow' } },
        },
      },
    });
    const config = getAgentConfigsFromDefinitions(runtime, agents);
    expect(config.Advisor.description).toBe(SPECIALIST_DESCRIPTIONS.oracle);
    const permissions = config.orchestrator.permission as {
      task: Record<string, string>;
    };
    expect(Object.entries(permissions.task)).toEqual([
      ['*', 'deny'],
      ['Advisor', 'allow'],
    ]);
    expect(config.orchestrator.prompt).not.toContain('<Agents>');
    expect(config.orchestrator.prompt).not.toContain('@Advisor');
  });

  test('skill authorization no longer needs a second routing projection', () => {
    const { agents } = agentsFor({
      agents: {
        fixer: {
          permission: { skill: { '*': 'deny', 'custom-review': 'allow' } },
        },
      },
    });
    expect(
      agents.find((agent) => agent.name === 'fixer')?.config.permission,
    ).toMatchObject({ skill: { '*': 'deny', 'custom-review': 'allow' } });
    expect(
      agents.find((agent) => agent.name === 'orchestrator')?.config.prompt,
    ).not.toContain('Skills:');
  });

  test('the hidden Council roster and its procedure pointer remain', () => {
    const { runtime, agents } = agentsFor({
      backgroundJobs: { mode: 'off' },
      disabled_agents: ['explorer', 'oracle', 'designer', 'fixer'],
      council: CouncilConfigSchema.parse({
        presets: { default: { alpha: { model: 'test/seat' } } },
      }),
    });
    const config = getAgentConfigsFromDefinitions(runtime, agents);
    expect(config.orchestrator.prompt).toContain(
      '## Council\nSeats: councillor-alpha',
    );
    expect(config.orchestrator.prompt).not.toContain('<Agents>');
    expect(config['councillor-alpha'].hidden).toBe(true);
    expect(config.observer.description).toBe(SPECIALIST_DESCRIPTIONS.observer);
  });
});
