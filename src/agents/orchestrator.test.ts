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
  test('v2 uses subagent and never names the retired task_message', () => {
    const prompt = v2();

    expect(prompt).toContain('`subagent` calls in one message');
    expect(prompt).toContain('look up IDs with the models tool');
    expect(prompt).not.toContain('task_id');
    expect(prompt).not.toContain('task_message');
  });

  test('v1 uses the task vocabulary and restates no tool mechanics', () => {
    const prompt = v1();

    expect(prompt).toContain('`task` calls in one message');
    expect(prompt).not.toContain('delivery:');
    expect(prompt).not.toContain('subagent(');
    expect(prompt).not.toContain('models tool');
    // Tool usage lives in the tool descriptions, not in the prompt.
    expect(prompt).not.toContain('task_message');
    expect(prompt).not.toContain('task_revive');
  });

  test('result reads go through task_status, not a task_result tool', () => {
    for (const prompt of [v1(), v2()]) {
      expect(prompt).not.toContain('task_result');
    }
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
      expect(prompt).toContain('## File operations');
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
  test('v1 with wait_for_user enabled ends manual steps with wait_for_user', () => {
    const prompt = v1();

    expect(prompt).toContain('then call `wait_for_user`');
    expect(prompt).toContain('Never use it to wait for');
  });

  test('v1 with wait_for_user disabled falls back to question', () => {
    const prompt = v1({ waitForUser: false });

    expect(prompt).not.toContain('wait_for_user');
    expect(prompt).toContain('then ask with `question`');
  });

  test('v2 never mentions wait_for_user, whatever the flag', () => {
    expect(v2()).not.toContain('wait_for_user');
    expect(v2({ waitForUser: false })).toBe(v2());
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

    const opts = { disabledAgents: new Set(['explorer']), waitForUser: false };
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

  /** Menus a tool that the lifecycle registers, so the prompt may name it. */
  const capabilities = (prompt: string) => ({
    waitForUser: prompt.includes('wait_for_user'),
    wakeScheduler: prompt.includes('wake scheduler'),
    // The correction policy is host-neutral: amend, never respawn.
    amend: prompt.includes('Amend the same child, never respawn it.'),
  });

  beforeEach(() => {
    RuntimeConfig.reset(TEST_DIRECTORY);
  });

  afterEach(() => {
    RuntimeConfig.reset(TEST_DIRECTORY);
  });

  test('v1 lifecycle off names no wait_for_user, no wake scheduler', () => {
    const agents = createAgents(
      runtimeFor({ backgroundJobs: { enabled: false } }),
    );
    const prompt = agents.find((a) => a.name === 'orchestrator')?.config
      .prompt as string;
    expect(capabilities(prompt)).toEqual({
      waitForUser: false,
      wakeScheduler: false,
      amend: true,
    });
    expect(prompt).not.toContain('task_message');
  });

  test('v2 lifecycle off keeps the v2 vocabulary and names no managed tool', () => {
    const agents = createAgents(
      runtimeFor({ backgroundJobs: { enabled: false } }),
      { hostFlavor: 'v2' },
    );
    const prompt = agents.find((a) => a.name === 'orchestrator')?.config
      .prompt as string;
    expect(prompt).not.toContain('wait_for_user');
    expect(prompt).not.toContain('wake scheduler');
    expect(prompt).not.toContain('task_message');
    // The v2 resume promise never included the scheduler.
    expect(prompt).toContain('completion notifications resume you');
    expect(prompt).toContain('`subagent` calls in one message');
  });

  test('the default v1 prompt carries the correction policy', () => {
    const agents = createAgents(runtimeFor());
    const prompt = agents.find((a) => a.name === 'orchestrator')?.config
      .prompt as string;
    expect(capabilities(prompt)).toEqual({
      waitForUser: true,
      wakeScheduler: true,
      amend: true,
    });
  });

  test('v1 lifecycle off with both tools disabled still renders the fallback channel', () => {
    const agents = createAgents(
      runtimeFor({
        backgroundJobs: { enabled: false },
        disabled_tools: ['wait_for_user'],
      }),
    );
    const prompt = agents.find((a) => a.name === 'orchestrator')?.config
      .prompt as string;
    expect(capabilities(prompt)).toEqual({
      waitForUser: false,
      wakeScheduler: false,
      amend: true,
    });
    expect(prompt).not.toContain('task_message');
  });

  test('defaults keep the registered-tool prompt bytes unchanged', () => {
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
          hostFlavor,
        }),
      );
    }
  });
});
