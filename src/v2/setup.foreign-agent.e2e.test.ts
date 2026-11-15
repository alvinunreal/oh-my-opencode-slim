import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MarketplaceStore } from '../marketplace/store';
import { createV2Setup } from './setup';
import type { V2Context } from './types';

function createEvents() {
  const queued: Array<Record<string, unknown>> = [];
  const nextCallWaiters: Array<{ target: number; resolve: () => void }> = [];
  let nextCalls = 0;
  let resolveNext:
    | ((result: IteratorResult<Record<string, unknown>>) => void)
    | undefined;
  let stopped = false;

  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Record<string, unknown>>> {
          nextCalls += 1;
          for (const waiter of nextCallWaiters.splice(0)) {
            if (nextCalls >= waiter.target) waiter.resolve();
            else nextCallWaiters.push(waiter);
          }
          const next = queued.shift();
          if (next !== undefined) {
            return Promise.resolve({ value: next, done: false });
          }
          if (stopped) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
        return(): Promise<IteratorResult<Record<string, unknown>>> {
          stopped = true;
          resolveNext?.({ value: undefined, done: true });
          resolveNext = undefined;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return {
    iterable,
    push(event: Record<string, unknown>) {
      const resolve = resolveNext;
      resolveNext = undefined;
      if (resolve) resolve({ value: event, done: false });
      else queued.push(event);
    },
    waitForNextCall(target: number): Promise<void> {
      if (nextCalls >= target) return Promise.resolve();
      return new Promise((resolve) =>
        nextCallWaiters.push({ target, resolve }),
      );
    },
  };
}

type AgentTransform = (draft: unknown) => void;

function makeMockV2Context(projectDir: string, initialAgents: string[]) {
  const agentCallbacks = new Set<AgentTransform>();
  const events = createEvents();
  const calls: {
    prompt?: (event: {
      sessionID: string;
      messageID: string;
      prompt: { text: string };
    }) => Promise<void>;
    agentUpdates: string[];
    childUpdates: unknown[];
  } = { agentUpdates: [], childUpdates: [] };
  let currentAgents = new Map(
    initialAgents.map((id) => [id, { id, mode: 'primary' }]),
  );

  function replayAgents() {
    const draftAgents = new Map(
      initialAgents.map((id) => [id, { id, mode: 'primary' }]),
    );
    const draft = {
      list: () => [...draftAgents.values()],
      get: (id: string) => draftAgents.get(id),
      default: () => {},
      update: (
        id: string,
        project: (agent: Record<string, unknown>) => void,
      ) => {
        calls.agentUpdates.push(id);
        const agent = { ...(draftAgents.get(id) ?? { id }) };
        project(agent);
        agent.id = id;
        draftAgents.set(id, agent);
      },
      remove: (id: string) => draftAgents.delete(id),
    };
    for (const callback of agentCallbacks) callback(draft);
    currentAgents = draftAgents;
  }

  const ctx = {
    app: { name: 'opencode', version: 'v2-census' },
    options: {},
    location: {
      directory: projectDir,
      project: {
        id: 'census-project',
        directory: projectDir,
        canonical: projectDir,
      },
    },
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({ entries: [] }),
    },
    agent: {
      transform: async (callback: AgentTransform) => {
        agentCallbacks.add(callback);
        replayAgents();
        return { dispose: () => agentCallbacks.delete(callback) };
      },
      reload: async () => replayAgents(),
      // Real host shape: `{ location, data }` envelope (#1874 review).
      list: async () => ({
        location: { directory: projectDir },
        data: [...currentAgents.values()],
      }),
    },
    tool: {
      transform: async (callback: (draft: unknown) => void) => {
        callback({
          update: (id: string, update: (tool: unknown) => void) => {
            if (id === 'subagent')
              update({
                description: 'Native subagent',
                execute: async () => ({}),
              });
          },
          get: (id: string) =>
            id === 'subagent'
              ? { description: 'Native subagent', execute: async () => ({}) }
              : undefined,
          add: () => {},
        });
        return { dispose: () => {} };
      },
      hook: async () => ({ dispose: () => {} }),
    },
    command: {
      transform: async (callback: (draft: unknown) => void) => {
        callback({ add: () => {} });
        return { dispose: () => {} };
      },
      list: async () => [],
    },
    skill: {
      transform: async () => ({ dispose: () => {} }),
      list: async () => [],
      reload: async () => {},
    },
    session: {
      update: async (input: unknown) => calls.childUpdates.push(input),
      hook: async (name: string, callback: (event: never) => Promise<void>) => {
        if (name === 'prompt') calls.prompt = callback as typeof calls.prompt;
        return { dispose: () => {} };
      },
    },
    mcp: {
      transform: async (callback: (draft: unknown) => void) => {
        callback({
          list: () => [],
          get: () => undefined,
          set: () => {},
          update: () => {},
          remove: () => {},
        });
        return { dispose: () => {} };
      },
      reload: async () => {},
    },
    event: { subscribe: () => events.iterable },
    generate: { text: async () => ({ text: '' }) },
  } as unknown as V2Context;

  return {
    ctx,
    calls,
    events,
    // Same callback-set/reload seam as the e2e mock: a later plugin's
    // transform participates in the next host agent pass.
    addLaterAgentTransform(callback: AgentTransform) {
      agentCallbacks.add(callback);
    },
  };
}

describe('issue #1874 marketplace hidden-agent census', () => {
  let fixtureRoot: string | undefined;
  let originalEnv: typeof process.env;

  afterEach(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test('admits a later-registered foreign hidden child through the host envelope (#1874)', async () => {
    originalEnv = { ...process.env };
    fixtureRoot = await mkdtemp(path.join(tmpdir(), 'omos-census-1874-'));
    const projectDir = path.join(fixtureRoot, 'project');
    await mkdir(path.join(projectDir, '.opencode'), { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = path.join(fixtureRoot, 'config');
    process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, 'xdg-config');
    process.env.XDG_DATA_HOME = path.join(fixtureRoot, 'xdg-data');
    process.env.XDG_CACHE_HOME = path.join(fixtureRoot, 'xdg-cache');
    process.env.OPENCODE_LOG_DIR = path.join(fixtureRoot, 'logs');
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;

    new MarketplaceStore({ pluginVersion: '2.2.25' }).install({
      manifest: {
        schemaVersion: 2,
        id: 'team/v2-marketplace',
        version: '1.0.0',
        displayName: 'V2 marketplace agent',
        description: 'Marketplace child policy fixture',
        agentName: 'v2-marketplace-agent',
        prompt: 'Use only the package-authorized capabilities.',
        skills: [],
        mcps: [],
        tools: ['read'],
        author: { name: 'Test' },
        tags: [],
        license: 'MIT',
        compatibility: { plugin: '>=2.0.0' },
        model: { source: 'explicit', candidates: ['provider/package'] },
        routing: {
          description: 'Marketplace test lane',
          when: 'Testing marketplace routing.',
          keywords: ['marketplace'],
        },
      } as never,
    });

    const configPath = path.join(
      projectDir,
      '.opencode',
      'oh-my-opencode-slim.json',
    );
    await Bun.write(
      configPath,
      JSON.stringify({
        companion: { enabled: false },
        preset: 'marketplace-test',
        presets: {
          'marketplace-test': {
            marketplace: { agents: ['team/v2-marketplace'] },
          },
        },
      }),
    );

    async function runCase(
      label: string,
      initialAgents: string[],
    ): Promise<boolean> {
      const mock = makeMockV2Context(projectDir, initialAgents);
      const cleanup = await createV2Setup()(mock.ctx);
      try {
        // The later-loaded plugin contributes historian after OMOS's initial
        // callback. Its transform is replayed with the registered callbacks.
        mock.addLaterAgentTransform((rawDraft) => {
          const draft = rawDraft as {
            update: (
              id: string,
              project: (agent: Record<string, unknown>) => void,
            ) => void;
          };
          draft.update('historian', (agent) => {
            Object.assign(agent, {
              mode: 'primary',
              hidden: true,
              description: 'Historical context agent',
              prompt: 'Inspect historical context only.',
            });
          });
        });
        await mock.ctx.agent.reload?.();

        const finalized = (await mock.ctx.agent.list?.()) as {
          data: Array<{ id?: string }>;
        };
        const finalizedAgents = finalized.data;
        const hostDraftHasHistorian = finalizedAgents.some(
          (agent) => agent.id === 'historian',
        );
        const firstPassHadHistorian = initialAgents.includes('historian');

        await mock.events.waitForNextCall(1);
        mock.events.push({
          type: 'session.created',
          data: {
            sessionID: `ses_hist_child_${label}`,
            parentID: 'ses_marketplace_parent',
            agent: 'historian',
          },
        });
        await mock.events.waitForNextCall(2);

        let rejected = false;
        const prompt = mock.calls.prompt;
        expect(prompt).toBeDefined();
        if (!prompt) throw new Error('prompt hook was not registered');
        try {
          await prompt({
            sessionID: `ses_hist_child_${label}`,
            messageID: `msg_hist_child_${label}`,
            prompt: { text: 'test hidden child identity' },
          });
        } catch (error) {
          rejected = /identity is unknown; prompt blocked/i.test(String(error));
          if (!rejected) throw error;
        }

        expect(hostDraftHasHistorian).toBe(true);
        expect(firstPassHadHistorian).toBe(label === 'reordered-plugin');
        return rejected;
      } finally {
        await cleanup();
      }
    }

    // With only stock host agents in pass 1, the later plugin contributes
    // historian during the reload pass.
    const laterRejected = await runCase('later-plugin', ['build', 'plan']);
    expect(laterRejected).toBe(false);
    // Reordered-plugin control: historian is already in pass 1's host list.
    const controlRejected = await runCase('reordered-plugin', [
      'build',
      'plan',
      'historian',
    ]);
    expect(controlRejected).toBe(false);
  }, 30_000);
});
