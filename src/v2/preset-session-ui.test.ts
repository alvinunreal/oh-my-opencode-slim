import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { recordTuiAgentDisplayNames } from '../tui-state';
import {
  openPresetManagerV2,
  type V2PresetManagerContext,
  type V2PresetSelectInput,
} from './preset-manager';
import type { SessionPresetState } from './preset-rpc';
import { makeTestEnv } from './test-fixtures';

let env: ReturnType<typeof makeTestEnv>;
beforeEach(() => {
  env = makeTestEnv('omos-session-ui');
  env.writeUserConfig({
    preset: 'cheap',
    presets: { cheap: { oracle: { model: 'new-provider/new-model' } } },
  });
});
afterEach(() => env.restore());

function bound(sessionID: string): SessionPresetState {
  return {
    sessionID,
    status: 'bound',
    presetName: 'cheap',
    affects: 'future-delegations',
    team: {
      agentModels: { oracle: 'saved-provider/saved-model' },
      agentVariants: { oracle: 'high' },
      inheritance: { explorer: 'session' },
    },
  };
}

function harness(script: Array<string | { user: string }>) {
  const selects: V2PresetSelectInput<unknown>[] = [];
  const confirms: Array<{ title: string; message: string }> = [];
  const toasts: Array<{ title?: string; message: string; variant?: string }> =
    [];
  const opened: string[] = [];
  const state = {
    home: true,
    sessionID: undefined as string | undefined,
    model: { providerID: 'native', modelID: 'main', variant: 'medium' },
  };
  const ctx: V2PresetManagerContext = {
    location: { directory: env.projectDir },
    getSessionID: () => state.sessionID,
    isHome: () => state.home,
    openSession: (id) => {
      opened.push(id);
    },
    data: {
      location: {
        agent: {
          list: () => [
            { id: 'main', name: 'Main agent', mode: 'primary', hidden: false },
            { id: 'both', mode: 'all', hidden: false },
            { id: 'child', mode: 'subagent', hidden: false },
            { id: 'secret', mode: 'primary', hidden: true },
          ],
        },
      },
    },
    ui: {
      model: { current: () => state.model },
      toast: { show: (toast) => toasts.push(toast) },
      dialog: {
        select: async <Value>(input: V2PresetSelectInput<Value>) => {
          selects.push(input);
          return script.shift() as Value | undefined;
        },
        prompt: async () => undefined,
        confirm: async (input) => {
          confirms.push(input);
          return true;
        },
      },
    },
  };
  const dialog = ctx.ui?.dialog;
  if (!dialog) throw new Error('Missing test dialog');
  return { ctx, state, selects, confirms, toasts, opened, script, dialog };
}

describe('saved session team view', () => {
  test('folds only registry-backed identities and preserves inherited variants', async () => {
    recordTuiAgentDisplayNames(
      {
        oracle: 'Research Lead',
        explore: 'explorer',
        librarian: 'explorer',
        custom_a: 'Same label',
        custom_b: 'Same label',
      },
      env.projectDir,
    );
    const saved: SessionPresetState = {
      ...bound('ses_root'),
      team: {
        agentModels: {
          'Research Lead': 'saved/model',
          oracle: 'saved/model',
          librarian: 'legacy/model',
          explore: 'legacy/model',
          explorer: 'saved/model',
          custom_a: 'saved/model',
          custom_b: 'saved/model',
        },
        agentVariants: { oracle: 'high', designer: 'medium', fixer: 'low' },
        inheritance: {
          'frontend-ui-ux-engineer': 'session',
          designer: 'session',
          fixer: 'orchestrator',
        },
      },
    };
    const before = structuredClone(saved);
    const h = harness(['__omo_view_session_team__', '__omo_back__']);
    h.state.sessionID = 'ses_root';
    h.ctx.client = { rpc: () => ({ read: async () => saved }) };
    await openPresetManagerV2(h.ctx, env.projectDir);
    expect(h.selects[1].options).toEqual([
      { title: 'custom_a', value: 'custom_a', description: 'saved/model' },
      { title: 'custom_b', value: 'custom_b', description: 'saved/model' },
      {
        title: 'designer',
        value: 'designer',
        description: 'Inherits session model #medium',
      },
      { title: 'explorer', value: 'explorer', description: 'saved/model' },
      {
        title: 'fixer',
        value: 'fixer',
        description: 'Inherits orchestrator model #low',
      },
      { title: 'oracle', value: 'oracle', description: 'saved/model #high' },
      expect.objectContaining({ value: '__omo_back__' }),
    ]);
    expect(saved).toEqual(before);
  });

  test('legacy preset names cannot collide with session-view actions', async () => {
    const name = '__omo_view_session_team__';
    env.writeUserConfig({ presets: { [name]: { oracle: { model: 'p/m' } } } });
    const h = harness([{ user: name }, 'apply', 'global']);
    h.state.sessionID = 'ses_root';
    h.ctx.client = { rpc: () => ({ read: async () => bound('ses_root') }) };
    await openPresetManagerV2(h.ctx, env.projectDir);
    expect(
      h.selects[0].options.some(
        (option) =>
          typeof option.value === 'object' &&
          option.value !== null &&
          'user' in option.value &&
          option.value.user === name,
      ),
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(env.userConfigPath, 'utf8')).preset).toBe(
      name,
    );
  });
  test('shows the saved models, inheritance and execution separately from editable definitions', async () => {
    const h = harness(['__omo_view_session_team__', '__omo_back__']);
    h.state.sessionID = 'ses_root';
    h.state.home = false;
    h.ctx.client = {
      rpc: () => ({
        read: async () => ({
          ...bound('ses_root'),
          executionPresetName: 'older',
        }),
      }),
    };
    await openPresetManagerV2(h.ctx, env.projectDir);
    expect(h.selects[0].placeholder).toBe('Default: cheap · Session: cheap');
    expect(h.selects[1].placeholder).toContain('Current execution: older');
    expect(h.selects[1].options).toContainEqual({
      title: 'oracle',
      value: 'oracle',
      description: 'saved-provider/saved-model #high',
    });
    expect(h.selects[1].options).toContainEqual({
      title: 'explorer',
      value: 'explorer',
      description: 'Inherits session model',
    });
    expect(JSON.stringify(h.selects[1])).not.toContain('new-provider');
  });

  test('missing saved models are unknown, not filled from the same-name preset', async () => {
    const h = harness(['__omo_view_session_team__']);
    h.state.sessionID = 'ses_root';
    h.ctx.client = {
      rpc: () => ({
        read: async () => ({ ...bound('ses_root'), team: undefined }),
      }),
    };
    await openPresetManagerV2(h.ctx, env.projectDir);
    expect(h.selects[1].placeholder).toContain('Saved models unavailable');
    expect(h.selects[1].options).toHaveLength(1);
  });

  test('pending transition offers explicit retry of its saved operation without prompting', async () => {
    const h = harness(['__omo_retry_session__']);
    h.state.sessionID = 'ses_root';
    const calls: unknown[] = [];
    h.ctx.client = {
      rpc: () => ({
        read: async () => ({
          ...bound('ses_root'),
          status: 'transitioning',
          pending: {
            kind: 'transition',
            operationID: 'op_saved',
            presetName: 'frozen',
          },
        }),
        retry: async (input: unknown) => {
          calls.push(input);
          return bound('ses_root');
        },
      }),
    };
    await openPresetManagerV2(h.ctx, env.projectDir);
    expect(h.selects[0].placeholder).toContain('frozen · update pending');
    expect(h.confirms[0].message).toContain('"frozen"');
    expect(calls).toEqual([{ sessionID: 'ses_root', operationID: 'op_saved' }]);
    expect(h.toasts.at(-1)?.message).toBe(
      'Configuration updated. No prompt was sent.',
    );
  });

  test('late session reads do not open a dialog on a different route', async () => {
    const h = harness([]);
    h.state.sessionID = 'ses_first';
    const result = Promise.withResolvers<SessionPresetState>();
    h.ctx.client = { rpc: () => ({ read: () => result.promise }) };
    const run = openPresetManagerV2(h.ctx, env.projectDir);
    h.state.sessionID = 'ses_second';
    result.resolve(bound('ses_first'));
    await run;
    expect(h.selects).toEqual([]);
  });

  test('late Apply confirmation does not describe another displayed session as updated', async () => {
    const h = harness(['cheap', 'apply', 'session']);
    h.state.sessionID = 'ses_root';
    h.state.home = false;
    h.ctx.client = {
      rpc: () => ({
        read: async () => bound('ses_root'),
        apply: async () => {
          h.state.sessionID = 'ses_other';
          return bound('ses_root');
        },
      }),
    };
    await openPresetManagerV2(h.ctx, env.projectDir);
    expect(h.toasts).toEqual([]);
  });
});

describe('local creation retry record', () => {
  test('requires confirmation, works across workspaces and leaves the old target intact when creating with new IDs', async () => {
    for (const crossWorkspace of [false, true]) {
      const h = harness(['cheap', 'create-session', 'main']);
      const requests: Array<{ sessionID: string; operationID: string }> = [];
      const server = new Map<string, SessionPresetState>();
      let rpcCalls = 0;
      h.ctx.client = {
        rpc: () => {
          rpcCalls++;
          return {
            createBound: async (input: {
              sessionID: string;
              operationID: string;
            }) => {
              requests.push(structuredClone(input));
              if (requests.length === 1) {
                server.set(input.sessionID, {
                  ...bound(input.sessionID),
                  status: 'initializing',
                  pending: {
                    kind: 'createBound',
                    operationID: input.operationID,
                    presetName: 'cheap',
                  },
                });
                throw new Error('Model unavailable');
              }
              const state = bound(input.sessionID);
              server.set(input.sessionID, state);
              return state;
            },
          };
        },
      };
      await openPresetManagerV2(h.ctx, env.projectDir);
      const original = requests[0];
      if (!original) throw new Error('Missing creation request');
      const frozen = structuredClone(server.get(original.sessionID));
      const directory = crossWorkspace
        ? `${env.projectDir}/other`
        : env.projectDir;
      fs.mkdirSync(directory, { recursive: true });
      h.ctx.location = {
        directory,
        ...(crossWorkspace ? { workspaceID: 'other' } : {}),
      };
      let accept = false;
      h.dialog.confirm = async (input) => {
        h.confirms.push(input);
        return accept;
      };
      h.script.push('__omo_forget_create__');
      await openPresetManagerV2(h.ctx, directory);
      expect(h.toasts.at(-1)?.title).toBe('Creation not confirmed');
      expect(rpcCalls).toBe(1);

      h.script.push('cheap', 'create-session');
      await openPresetManagerV2(h.ctx, directory);
      expect(h.toasts.at(-1)?.title).toBe('Creation already recorded');
      expect(h.toasts.at(-1)?.message).toContain('recorded workspace');
      expect(h.toasts.at(-1)?.message).toContain(
        'forget the local retry record',
      );
      expect(rpcCalls).toBe(1);

      accept = true;
      h.script.push('__omo_forget_create__');
      await openPresetManagerV2(h.ctx, directory);
      expect(
        h.selects
          .at(-1)
          ?.options.some(
            (option) => option.title === 'Forget local retry record',
          ),
      ).toBe(true);
      const message = h.confirms.at(-1)?.message;
      expect(message).toContain(`Directory: ${env.projectDir}`);
      expect(message).toContain(`Session: ${original.sessionID}`);
      expect(message).toContain(`Operation: ${original.operationID}`);
      expect(message).toContain('old request may still complete');
      expect(message).toContain('session may already exist');
      expect(message).toContain('another empty session');
      expect(h.toasts.at(-1)?.title).toBe('Local retry record forgotten');
      expect(h.toasts.at(-1)?.message).toContain(original.operationID);
      expect(rpcCalls).toBe(1);
      expect(server.get(original.sessionID)).toEqual(frozen);

      h.script.push('cheap', 'create-session', 'main', 'stay');
      await openPresetManagerV2(h.ctx, directory);
      expect(requests).toHaveLength(2);
      expect(requests[1].sessionID).not.toBe(original.sessionID);
      expect(requests[1].operationID).not.toBe(original.operationID);
      expect(server.get(original.sessionID)).toEqual(frozen);
      expect(h.toasts.at(-1)?.title).toBe('Empty session ready');
    }
  });

  test('refuses a second manager while creation is in flight and permits forgetting only after local timeout', async () => {
    const h = harness(['cheap', 'create-session', 'main']);
    const entered = Promise.withResolvers<void>();
    const result = Promise.withResolvers<SessionPresetState>();
    let rpcCalls = 0;
    h.ctx.client = {
      rpc: () => {
        rpcCalls++;
        return {
          createBound: () => {
            entered.resolve();
            return result.promise;
          },
        };
      },
    };
    const running = openPresetManagerV2(h.ctx, env.projectDir);
    await entered.promise;
    const directory = `${env.projectDir}/while-running`;
    fs.mkdirSync(directory, { recursive: true });
    h.ctx.location = { directory, workspaceID: 'other' };
    h.script.push('__omo_forget_create__');
    await openPresetManagerV2(Object.create(h.ctx), directory);
    expect(h.selects).toHaveLength(3);
    expect(h.confirms).toHaveLength(1);
    expect(rpcCalls).toBe(1);
    result.reject(new Error('Request timed out'));
    await running;
    await openPresetManagerV2(h.ctx, directory);
    expect(h.confirms.at(-1)?.title).toBe('Forget local retry record?');
    expect(h.toasts.at(-1)?.title).toBe('Local retry record forgotten');
    expect(rpcCalls).toBe(1);
  });
});

describe('new empty session from home', () => {
  test('uses an explicit primary/all agent and the native selected model; never sends or moves a prompt', async () => {
    const h = harness(['cheap', 'create-session', 'main', 'open']);
    const before = fs.readFileSync(env.userConfigPath, 'utf8');
    const inputs: Array<Record<string, unknown>> = [];
    h.ctx.client = {
      rpc: () => ({
        createBound: async (input: Record<string, unknown>) => {
          inputs.push(input);
          return bound(input.sessionID as string);
        },
      }),
    };
    await openPresetManagerV2(h.ctx, env.projectDir);
    expect(h.selects[2].options.map((option) => option.value)).toEqual([
      'main',
      'both',
    ]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      sessionID: expect.stringMatching(/^ses_[a-f0-9]{32}$/),
      operationID: expect.stringMatching(/^[a-f0-9-]{36}$/),
      presetName: 'cheap',
      agent: 'main',
      model: { providerID: 'native', id: 'main', variant: 'medium' },
    });
    expect(h.confirms[0].message).toContain('Home draft is not moved');
    expect(h.confirms[0].message).toContain(`Directory: ${env.projectDir}`);
    expect(h.opened).toEqual([inputs[0].sessionID as string]);
    expect(fs.readFileSync(env.userConfigPath, 'utf8')).toBe(before);
  });

  test('double entry and retry retain one session ID and operation ID', async () => {
    const h = harness(['cheap', 'create-session', 'main']);
    const entered = Promise.withResolvers<void>();
    const result = Promise.withResolvers<SessionPresetState>();
    let created: { sessionID: string; operationID: string } | undefined;
    const getCreated = () => {
      if (!created) throw new Error('Creation was not called');
      return created;
    };
    const retries: unknown[] = [];
    h.ctx.client = {
      rpc: () => ({
        createBound: (input: typeof created) => {
          created = input;
          entered.resolve();
          return result.promise;
        },
        read: async () => ({
          ...bound(getCreated().sessionID),
          status: 'initializing',
          pending: {
            kind: 'createBound',
            operationID: getCreated().operationID,
            presetName: 'cheap',
          },
        }),
        retry: async (input: unknown) => {
          retries.push(input);
          return bound(getCreated().sessionID);
        },
      }),
    };
    const run = openPresetManagerV2(h.ctx, env.projectDir);
    await entered.promise;
    await openPresetManagerV2(Object.create(h.ctx), env.projectDir);
    expect(h.selects).toHaveLength(3);
    result.reject(new Error('Request timed out'));
    await run;
    expect(h.toasts.at(-1)?.title).toBe('Creation not confirmed');
    h.script.push('__omo_retry_create__', 'stay');
    h.state.model.modelID = 'changed-after-request';
    await openPresetManagerV2(h.ctx, env.projectDir);
    expect(retries).toEqual([
      {
        sessionID: getCreated().sessionID,
        operationID: getCreated().operationID,
      },
    ]);
    expect(h.opened).toEqual([]);
    expect(h.toasts.at(-1)?.title).toBe('Empty session ready');
    expect(h.confirms[1].message).toContain(`Directory: ${env.projectDir}`);
  });

  test.each(['bound', 'transitioning'] as const)(
    'navigation recovery only reads and opens an existing session with later %s state',
    async (status) => {
      const h = harness(['cheap', 'create-session', 'main', 'open']);
      let createCalls = 0;
      let retryCalls = 0;
      let saved: SessionPresetState | undefined;
      const reads: string[] = [];
      h.ctx.client = {
        rpc: () => ({
          createBound: async (input: { sessionID: string }) => {
            createCalls++;
            saved = {
              ...bound(input.sessionID),
              presetName: 'later-applied',
              status,
              ...(status === 'transitioning'
                ? {
                    pending: {
                      kind: 'transition' as const,
                      operationID: 'later-operation',
                      presetName: 'later-target',
                    },
                  }
                : {}),
            };
            return bound(input.sessionID);
          },
          read: async (input: { sessionID: string }) => {
            reads.push(input.sessionID);
            if (!saved) throw new Error('Missing created session');
            return saved;
          },
          retry: async () => {
            retryCalls++;
            throw new Error('Must not retry configuration');
          },
        }),
      };
      h.ctx.openSession = async (id) => {
        h.opened.push(id);
        if (h.opened.length === 1) throw new Error('Navigation failed');
      };
      await openPresetManagerV2(h.ctx, env.projectDir);
      expect(h.toasts.at(-1)?.title).toBe('Session created — not opened');
      const before = structuredClone(saved);
      h.script.push('__omo_retry_create__', 'open');
      await openPresetManagerV2(h.ctx, env.projectDir);
      expect(createCalls).toBe(1);
      expect(retryCalls).toBe(0);
      expect(reads).toEqual([h.opened[0]]);
      expect(h.opened).toEqual([h.opened[0], h.opened[0]]);
      expect(saved).toEqual(before);
      expect(h.confirms).toHaveLength(1);
      expect(h.selects.at(-1)?.title).toBe('Session created');
    },
  );

  test('a read failure after successful creation never recreates or retries configuration', async () => {
    const h = harness(['cheap', 'create-session', 'main', 'open']);
    let createCalls = 0;
    let retryCalls = 0;
    h.ctx.client = {
      rpc: () => ({
        createBound: async (input: { sessionID: string }) => {
          createCalls++;
          return bound(input.sessionID);
        },
        read: async () => {
          throw new Error('Session unavailable');
        },
        retry: async () => {
          retryCalls++;
          throw new Error('Must not retry configuration');
        },
      }),
    };
    h.ctx.openSession = () => {
      throw new Error('Navigation failed');
    };
    await openPresetManagerV2(h.ctx, env.projectDir);
    h.script.push('__omo_retry_create__', 'open');
    await openPresetManagerV2(h.ctx, env.projectDir);
    expect(createCalls).toBe(1);
    expect(retryCalls).toBe(0);
    expect(h.toasts.at(-1)?.message).toContain('Session unavailable');
    expect(
      h.selects.filter((call) => call.title === 'Session created'),
    ).toHaveLength(1);
  });

  test('leaving home during read-only recovery cannot open a late dialog or navigate', async () => {
    const h = harness(['cheap', 'create-session', 'main']);
    const entered = Promise.withResolvers<string>();
    const result = Promise.withResolvers<SessionPresetState>();
    let createCalls = 0;
    let retryCalls = 0;
    h.ctx.client = {
      rpc: () => ({
        createBound: async (input: { sessionID: string }) => {
          createCalls++;
          return bound(input.sessionID);
        },
        read: (input: { sessionID: string }) => {
          entered.resolve(input.sessionID);
          return result.promise;
        },
        retry: async () => {
          retryCalls++;
          throw new Error('Must not retry configuration');
        },
      }),
    };
    await openPresetManagerV2(h.ctx, env.projectDir);
    h.script.push('__omo_retry_create__', 'open');
    const recovery = openPresetManagerV2(h.ctx, env.projectDir);
    const id = await entered.promise;
    h.state.home = false;
    h.state.sessionID = 'ses_elsewhere';
    result.resolve(bound(id));
    await recovery;
    expect(createCalls).toBe(1);
    expect(retryCalls).toBe(0);
    expect(h.opened).toEqual([]);
    expect(
      h.selects.filter((call) => call.title === 'Session created'),
    ).toHaveLength(1);
  });

  test('pre-admission retry replays the same create parameters instead of making another session', async () => {
    const h = harness(['cheap', 'create-session', 'main']);
    const inputs: unknown[] = [];
    h.ctx.client = {
      rpc: () => ({
        createBound: async (input: { sessionID: string }) => {
          inputs.push(structuredClone(input));
          if (inputs.length === 1) throw new Error('Offline');
          return bound(input.sessionID);
        },
        read: async () => {
          throw new Error('Session identity not found');
        },
      }),
    };
    await openPresetManagerV2(h.ctx, env.projectDir);
    h.script.push('__omo_retry_create__', 'stay');
    await openPresetManagerV2(h.ctx, env.projectDir);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toEqual(inputs[0]);
  });

  test('a model change during confirmation requires a second confirmation', async () => {
    const h = harness(['cheap', 'create-session', 'main', 'stay']);
    const inputModels: unknown[] = [];
    h.dialog.confirm = async (input) => {
      h.confirms.push(input);
      if (h.confirms.length === 1) h.state.model.modelID = 'new-selection';
      return true;
    };
    h.ctx.client = {
      rpc: () => ({
        createBound: async (input: { sessionID: string; model: unknown }) => {
          inputModels.push(input.model);
          return bound(input.sessionID);
        },
      }),
    };
    await openPresetManagerV2(h.ctx, env.projectDir);
    expect(h.confirms).toHaveLength(2);
    expect(h.confirms[1].message).toContain('native/new-selection');
    expect(inputModels).toEqual([
      { providerID: 'native', id: 'new-selection', variant: 'medium' },
    ]);
  });

  test('location changes before confirmation never create in either workspace', async () => {
    const h = harness(['cheap', 'create-session', 'main']);
    h.dialog.confirm = async () => {
      h.ctx.location = { directory: `${env.projectDir}/other` };
      return true;
    };
    h.ctx.client = {
      rpc: () => {
        throw new Error('RPC must not be reached');
      },
    };
    await openPresetManagerV2(h.ctx, env.projectDir);
    expect(h.opened).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  test('workspace changes at the same directory also require a new confirmation', async () => {
    const h = harness(['cheap', 'create-session', 'main']);
    h.dialog.confirm = async () => {
      h.ctx.location = {
        directory: env.projectDir,
        workspaceID: 'new-workspace',
      };
      return true;
    };
    h.ctx.client = {
      rpc: () => {
        throw new Error('RPC must not be reached');
      },
    };
    await openPresetManagerV2(h.ctx, env.projectDir);
    expect(h.opened).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  test('missing native model fails before allocating or requesting a session', async () => {
    const h = harness(['cheap', 'create-session', 'main']);
    h.ctx.ui = { ...h.ctx.ui, model: { current: () => undefined } };
    h.ctx.client = {
      rpc: () => {
        throw new Error('RPC must not be reached');
      },
    };
    await openPresetManagerV2(h.ctx, env.projectDir);
    expect(h.confirms).toEqual([]);
    expect(h.toasts.at(-1)?.message).toContain('Choose a model on home');
  });

  test('leaving home while creation runs never opens a late dialog or steals focus', async () => {
    const h = harness(['cheap', 'create-session', 'main', 'open']);
    h.ctx.client = {
      rpc: () => ({
        createBound: async (input: { sessionID: string }) => {
          h.state.home = false;
          h.state.sessionID = 'ses_elsewhere';
          return bound(input.sessionID);
        },
      }),
    };
    await openPresetManagerV2(h.ctx, env.projectDir);
    expect(h.selects).toHaveLength(3);
    expect(h.opened).toEqual([]);
    expect(h.toasts.at(-1)?.title).toBe('Empty session ready');
  });
});
