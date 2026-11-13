import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../config';
import { RuntimeConfig } from '../config/runtime';
import { createAgents } from './index';
import {
  buildOrchestratorPrompt,
  createOrchestratorAgent,
} from './orchestrator';
import { ROLE_ROUTING_SLIM_LINES } from './role-routing';

const v1 = (options = {}) => buildOrchestratorPrompt(options);
const v2 = (options = {}) =>
  buildOrchestratorPrompt({ ...options, hostFlavor: 'v2' });

describe('orchestrator prompt: host vocabulary', () => {
  test('default prompts name no optional delegation, model, or prompt tools', () => {
    for (const prompt of [v1(), v2()]) {
      // Tool usage lives in the tool descriptions, not in the prompt.
      expect(prompt).not.toContain('`task`');
      expect(prompt).not.toContain('`subagent`');
      expect(prompt).not.toContain('models tool');
      expect(prompt).not.toContain('wait_for_user');
      expect(prompt).not.toContain('`question`');
      expect(prompt).not.toContain('task_id');
      expect(prompt).not.toContain('task_message');
      expect(prompt).not.toContain('task_revive');
      expect(prompt).not.toContain('task_result');
    }
  });

  test('v1 without the scheduler renders the same bytes as v2', () => {
    // Host vocabulary no longer reaches the prompt; only the resume channel
    // differs.
    expect(v1({ wakeScheduler: false })).toBe(v2());
  });

  test('unknown flavors render the v1 vocabulary', () => {
    expect(buildOrchestratorPrompt({ hostFlavor: 'v1' })).toBe(v1());
    expect(buildOrchestratorPrompt({ hostFlavor: 'v3-ish' })).toBe(v1());
  });

  test('shared guidance is identical across hosts', () => {
    for (const prompt of [v1(), v2()]) {
      expect(prompt).toContain('You are Orchestrator, a workflow manager');
      expect(prompt).toContain('Value productivity');
      expect(prompt).toContain('Build in passes');
      expect(prompt).toContain('Subagent summaries are claims, not evidence');
      expect(prompt).not.toContain('## File operations');
    }
  });
});

describe('orchestrator prompt: scoped catalog', () => {
  const count = (prompt: string, token: string) =>
    prompt.split(token).length - 1;

  test('a scoped catalog is wrapped exactly once', () => {
    const prompt = v2({ onlyAgents: ['fixer'] });
    expect(count(prompt, '<Agents>')).toBe(1);
    expect(count(prompt, '</Agents>')).toBe(1);
  });

  test('the unscoped catalog keeps its single wrapping', () => {
    const prompt = v1();
    expect(count(prompt, '<Agents>')).toBe(1);
    expect(count(prompt, '</Agents>')).toBe(1);
  });

  test('out-of-scope @mentions are scrubbed from a reused routing line', () => {
    const prompt = v2({ onlyAgents: ['designer'] });
    expect(prompt).toContain('@designer — owns all UI/UX');
    expect(prompt).not.toContain('@fixer');
  });

  test('a fully in-scope built-in line stays byte-identical', () => {
    const prompt = v2({ onlyAgents: ['fixer'] });
    expect(prompt).toContain(ROLE_ROUTING_SLIM_LINES.fixer);
  });
});

describe('orchestrator prompt: blocking on the user', () => {
  test('manual-step guidance is tool-neutral on every host', () => {
    for (const prompt of [v1(), v2()]) {
      expect(prompt).not.toContain('wait_for_user');
      expect(prompt).not.toContain('`question`');
      expect(prompt).toContain('external manual step, give concrete steps');
      expect(prompt).toContain(
        'Do not ask the user to wait for background tasks.',
      );
    }
  });
});

describe('orchestrator prompt: options', () => {
  test('wake scheduler off drops the scheduler from the resume promise', () => {
    expect(v1()).toContain(
      'completion notifications and the wake scheduler resume you',
    );
    const off = v1({ wakeScheduler: false });
    expect(off).toContain('completion notifications resume you');
    expect(off).not.toContain('wake scheduler');
  });

  test('v2 never promises the wake scheduler', () => {
    expect(v2()).toContain('completion notifications resume you');
    expect(v2()).not.toContain('wake scheduler');
    expect(v2({ wakeScheduler: true })).toBe(v2());
  });

  test('disabledAgents and excludeDescriptions filter routing lines', () => {
    for (const render of [v1, v2]) {
      const full = render();
      for (const line of Object.values(ROLE_ROUTING_SLIM_LINES)) {
        expect(full).toContain(line);
      }
      const filtered = render({
        disabledAgents: new Set(['explorer']),
        excludeDescriptions: ['council'],
      });
      expect(filtered).not.toContain('@explorer —');
      expect(filtered).not.toContain('@council —');
      expect(filtered).toContain(ROLE_ROUTING_SLIM_LINES.fixer);
    }
  });

  test('routingBlock=false removes the whole <Agents> element and nothing else', () => {
    for (const render of [v1, v2]) {
      const on = render();
      const off = render({ routingBlock: false });
      expect(on.match(/<Agents>/g)?.length).toBe(1);
      expect(off).not.toContain('<Agents>');
      expect(off).not.toContain('read-only codebase recon');
      const [head, tail] = on.split('<Agents>');
      expect(off).toBe(`${head}${tail.split('</Agents>\n\n')[1]}`);
    }
  });
});

describe('orchestrator prompt: cache safety', () => {
  test('renders byte-identical output for identical options', () => {
    // No time, randomness, or per-request state may reach the template.
    for (const render of [v1, v2]) {
      const first = render();
      const second = render();
      expect(first).toContain('You are Orchestrator, a workflow manager');
      expect(first).toBe(second);
    }

    const opts = { disabledAgents: new Set(['explorer']) };
    const scoped1 = v2(opts);
    const scoped2 = v2(opts);
    expect(scoped1).not.toContain('@explorer');
    expect(scoped1).toContain('@oracle');
    expect(scoped1).toBe(scoped2);
  });

  test('v1 render is snapshot-pinned', () => {
    expect(v1()).toMatchSnapshot();
  });

  test('v2 render is snapshot-pinned', () => {
    expect(v2()).toMatchSnapshot();
  });
});

describe('createOrchestratorAgent', () => {
  test('passes prompt options through to the builder', () => {
    const options = { hostFlavor: 'v2', routingBlock: false };
    const agent = createOrchestratorAgent(undefined, undefined, undefined, {
      ...options,
    });
    expect(agent.config.prompt).toBe(buildOrchestratorPrompt(options));
  });

  test('a custom prompt replaces the built one and appends still apply', () => {
    const agent = createOrchestratorAgent(undefined, 'custom', 'extra');
    expect(agent.config.prompt).toBe('custom\n\nextra');
  });
});

/** `createAgents`-level option resolution for the orchestrator prompt. */
describe('createAgents orchestrator prompt gates', () => {
  const TEST_DIRECTORY = 'runtime-test-orchestrator-gates';

  function runtimeFor(config: PluginConfig | undefined = {}) {
    RuntimeConfig.reset(TEST_DIRECTORY);
    RuntimeConfig.init(TEST_DIRECTORY, config ?? {});
    return RuntimeConfig.get(TEST_DIRECTORY);
  }

  /** What the compact prompt may name: only the wake promise plus the
   * host-neutral correction policy; no optional lifecycle tool. */
  const capabilities = (prompt: string) => ({
    wakeScheduler: prompt.includes('wake scheduler'),
    amend: prompt.includes('Amend the same child, never respawn it.'),
  });

  beforeEach(() => {
    RuntimeConfig.reset(TEST_DIRECTORY);
  });

  afterEach(() => {
    RuntimeConfig.reset(TEST_DIRECTORY);
  });

  test('v1 lifecycle off keeps tool-neutral manual guidance and no scheduler', () => {
    const agents = createAgents(
      runtimeFor({ backgroundJobs: { mode: 'off' } }),
    );
    const prompt = agents.find((a) => a.name === 'orchestrator')?.config
      .prompt as string;
    expect(capabilities(prompt)).toEqual({
      wakeScheduler: false,
      amend: true,
    });
    expect(prompt).not.toContain('wait_for_user');
    expect(prompt).not.toContain('task_message');
  });

  test('v2 lifecycle off keeps the v2 vocabulary and names no managed tool', () => {
    const agents = createAgents(
      runtimeFor({ backgroundJobs: { mode: 'off' } }),
      { hostFlavor: 'v2' },
    );
    const prompt = agents.find((a) => a.name === 'orchestrator')?.config
      .prompt as string;
    expect(prompt).not.toContain('wait_for_user');
    expect(prompt).not.toContain('wake scheduler');
    expect(prompt).not.toContain('task_message');
    // The v2 resume promise never included the scheduler.
    expect(prompt).toContain('completion notifications resume you');
    expect(prompt).toContain('dispatch in parallel');
    expect(prompt).not.toContain('`subagent`');
  });

  test('the default v1 prompt keeps the correction policy', () => {
    const agents = createAgents(runtimeFor());
    const prompt = agents.find((a) => a.name === 'orchestrator')?.config
      .prompt as string;
    expect(capabilities(prompt)).toEqual({
      wakeScheduler: true,
      amend: true,
    });
    expect(prompt).not.toContain('wait_for_user');
  });

  test('v1 lifecycle off with the optional wait tool disabled renders the same tool-neutral prompt', () => {
    const agents = createAgents(
      runtimeFor({
        backgroundJobs: { mode: 'off' },
        disabled_tools: ['wait_for_user'],
      }),
    );
    const prompt = agents.find((a) => a.name === 'orchestrator')?.config
      .prompt as string;
    expect(capabilities(prompt)).toEqual({
      wakeScheduler: false,
      amend: true,
    });
    expect(prompt).not.toContain('wait_for_user');
    expect(prompt).not.toContain('task_message');
  });

  test("routing lines name each specialist's configured skills", () => {
    const prompt = createAgents(
      runtimeFor({ agents: { fixer: { skills: ['simplify'] } } }),
    ).find((a) => a.name === 'orchestrator')?.config.prompt as string;
    const fixerLine = prompt
      .split('\n')
      .find((line) => line.startsWith('@fixer'));
    expect(fixerLine).toEndWith(' Skills: simplify.');
    expect(prompt).toContain('A specialist can load only the skills');
  });

  test('routing lines keep skill grants from permission.skill', () => {
    const agents = createAgents(
      runtimeFor({
        agents: {
          fixer: {
            permission: { skill: { '*': 'deny', 'custom-review': 'allow' } },
          },
        },
      }),
    );
    const prompt = agents.find((a) => a.name === 'orchestrator')?.config
      .prompt as string;
    const fixerLine = prompt
      .split('\n')
      .find((line) => line.startsWith('@fixer'));
    expect(fixerLine).toEndWith(' Skills: custom-review.');
    const fixerPermission = agents.find((a) => a.name === 'fixer')?.config
      .permission as { skill?: Record<string, string> } | undefined;
    const fixerSkill = fixerPermission?.skill;
    expect(fixerSkill?.['custom-review']).toBe('allow');
  });

  test('defaults keep the snapshot-pinned builder bytes', () => {
    // No cold-gate is set: the default render must lead to the same bytes
    // the snapshot-pinned builder produces with the same option defaults.
    for (const hostFlavor of [undefined, 'v2'] as const) {
      const agents = createAgents(
        runtimeFor(undefined),
        hostFlavor === undefined ? {} : { hostFlavor },
      );
      const prompt = agents.find((a) => a.name === 'orchestrator')?.config
        .prompt as string;
      expect(prompt).toBe(
        buildOrchestratorPrompt({
          disabledAgents: new Set(['observer', 'council', 'councillor']),
          agentSkills: { oracle: 'simplify' },
          hostFlavor,
        }),
      );
    }
  });

  test('disabled_tools no longer changes orchestrator prompt bytes', () => {
    const prompt = (config: PluginConfig | undefined) =>
      createAgents(runtimeFor(config)).find((a) => a.name === 'orchestrator')
        ?.config.prompt as string;
    // The prompt is tool-neutral, so a disabled optional tool cannot be
    // duplicated in (or removed from) the rendered text.
    expect(prompt(undefined)).not.toContain('wait_for_user');
    expect(prompt({ disabled_tools: ['wait_for_user'] })).toBe(
      prompt(undefined),
    );
  });
});
