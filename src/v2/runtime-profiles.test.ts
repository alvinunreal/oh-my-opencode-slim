import { describe, expect, test } from 'bun:test';
import { createTimerHarness, tick } from '../utils/test-timers';
import {
  applyRuntimeProfileOptions,
  createSessionProfileBridge,
  reconcileRuntimeProfileOptionKeys,
  resolveV2EventPayload,
} from './runtime-profiles';
import {
  assertAvailableDelegationSelection,
  createSessionPresets,
  type SessionTeamBundle,
  wrapSessionPresetSubagent,
} from './session-presets';
import type { ModelRef, V2SessionContextEvent } from './types';

const PROFILES = {
  explorer: {
    model: { providerID: 'openai', id: 'gpt-5-mini' },
    temperature: 0.3,
    providerOptions: { thinking: { type: 'enabled' } },
    sidebarModel: 'openai/gpt-5-mini',
  },
  oracle: {
    sidebarModel: 'default',
  },
};

interface BridgeOptions {
  withSwitchModel?: boolean;
  switchModel?: (input: unknown) => Promise<unknown>;
  get?: (input: unknown) => Promise<unknown>;
  knownAgent?: (sessionID: string) => string | undefined;
  /** Current profile table (mutable for freshness tests). */
  profiles?: () => typeof PROFILES;
  registeredProfiles?: typeof PROFILES;
  /** Defaults to the fixture plugin agents. */
  pluginAgents?: string[];
  /** Bound for the request-path switch. */
  switchTimeoutMs?: number;
  onSessionCaptured?: (sessionID: string) => void;
  onSessionCaptureFailed?: (sessionID: string) => void;
}

function makeBridge(options?: BridgeOptions) {
  const switchCalls: Array<unknown> = [];
  const getCalls: Array<unknown> = [];
  const session: Record<string, unknown> = {};
  if (options?.get) {
    session.get = async (input: unknown) => {
      getCalls.push(input);
      return options.get?.(input);
    };
  }
  if (options?.withSwitchModel !== false) {
    session.switchModel = async (input: unknown) => {
      switchCalls.push(input);
      if (options?.switchModel) return options.switchModel(input);
      return {};
    };
  }
  const bridge = createSessionProfileBridge({
    profiles: options?.profiles ?? (() => PROFILES),
    registeredProfiles: options?.registeredProfiles,
    pluginAgents: new Set(options?.pluginAgents ?? ['explorer', 'oracle']),
    session: session as never,
    ...(options?.knownAgent ? { knownAgent: options.knownAgent } : {}),
    ...(options?.switchTimeoutMs
      ? { switchTimeoutMs: options.switchTimeoutMs }
      : {}),
    ...(options?.onSessionCaptured
      ? { onSessionCaptured: options.onSessionCaptured }
      : {}),
    ...(options?.onSessionCaptureFailed
      ? { onSessionCaptureFailed: options.onSessionCaptureFailed }
      : {}),
    log: () => {},
  });
  return { bridge, switchCalls, getCalls };
}

/** A `session.created` event for a plugin child. */
const created = (sessionID: string, agent = 'explorer', parentID = 'p') => ({
  type: 'session.created',
  data: { sessionID, parentID, agent },
});

/** The switch the fixture profile issues for a `gpt-5-mini` child. */
const GPT5_SWITCH = {
  sessionID: 'child-1',
  model: { providerID: 'openai', id: 'gpt-5-mini' },
};

describe('durable session team presets', () => {
  function fixture() {
    const bundle = (name: string): SessionTeamBundle => ({
      presetName: name,
      fallbackEnabled: true,
      profiles: {
        explorer: {
          model: { providerID: 'test', id: name, variant: 'high' },
          temperature: name === 'A' ? 0.1 : 0.8,
          providerOptions: { reasoning: name },
          sidebarModel: `test/${name}`,
        },
      },
      chains: {
        explorer: [
          { id: `test/${name}`, variant: 'high' },
          { id: `backup/${name}` },
        ],
      },
      inheritance: { oracle: 'session' },
    });
    let current = bundle('A');
    const values = new Map<string, unknown>();
    const parents = new Map<string, string>();
    const order: string[] = [];
    const storage = {
      get: async (key: string) => structuredClone(values.get(key)),
      set: async (key: string, value: unknown) => {
        order.push(`persist:${key.split('/').at(-1)}`);
        values.set(key, structuredClone(value));
      },
      remove: async (key: string) => {
        values.delete(key);
      },
      scan: async () => ({ entries: [] }),
    };
    const session = {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        directory: '/project',
        ...(parents.has(sessionID) ? { parentID: parents.get(sessionID) } : {}),
        // Legacy guard may recover the agent from the parent transcript even
        // when the host child identity itself no longer carries that field.
        ...(sessionID === 'interrupted-child' ? {} : { agent: 'explorer' }),
      }),
    };
    const installs: unknown[] = [];
    const create = () => {
      const presets = createSessionPresets({
        storage,
        session: session as never,
        directory: '/project',
        location: { directory: '/project' },
        current: () => current,
        named: async (name) => bundle(name),
      });
      presets.setExecution({
        assertIdle: () => {},
        install: async (id, record) => {
          installs.push({ id, record });
        },
      });
      return presets;
    };
    return {
      create,
      bundle,
      values,
      parents,
      order,
      storage,
      session,
      installs,
      setCurrent: (name: string) => {
        current = bundle(name);
      },
    };
  }

  test('failed same-ID transition remains pending across restart and retries only its frozen execution', async () => {
    const f = fixture();
    let presets = f.create();
    f.parents.set('child', 'root');
    f.parents.set('sibling', 'root');
    await presets.bindChild('child', 'root', f.bundle('A'), undefined, {
      explicitModel: true,
      preserveModel: true,
    });
    await presets.bindChild('sibling', 'root', f.bundle('A'));
    let started!: () => void;
    const entering = new Promise<void>((resolve) => {
      started = resolve;
    });
    let fail!: (error: Error) => void;
    const installing = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    presets.setExecution({
      assertIdle: () => {},
      install: async () => {
        started();
        await installing;
      },
    });
    const transition = presets.resumeChild(
      'child',
      'root',
      {
        bundle: f.bundle('B'),
        explicitModel: false,
      },
      'explorer',
    );
    const rejection = transition.catch((error: Error) => error);
    await entering;
    const pending = await presets.readState('child');
    expect(pending).toMatchObject({
      status: 'transitioning',
      presetName: 'A',
      pending: { kind: 'transition', presetName: 'B' },
    });
    await expect(presets.ensure('child')).rejects.toThrow('pending');
    await expect(presets.admit('child')).rejects.toThrow('pending');
    expect((await presets.ensure('sibling'))?.bundle.presetName).toBe('A');
    fail(new Error('switch unavailable'));
    expect(await rejection).toMatchObject({ message: 'switch unavailable' });
    await presets.dispose();
    f.setCurrent('C');
    presets = f.create();
    await expect(presets.ensure('child')).rejects.toThrow('pending');
    await expect(presets.retry('child', 'wrong-operation')).rejects.toThrow(
      'mismatch',
    );
    if (!pending.pending) throw new Error('Missing pending operation');
    const operationID = pending.pending.operationID;
    const ready = await presets.retry('child', operationID);
    expect(ready).toMatchObject({
      status: 'bound',
      presetName: 'B',
      team: { agentModels: { explorer: 'test/B' } },
    });
    const record = await presets.ensure('child');
    expect(record).toMatchObject({
      revision: 1,
      explicitModel: false,
      executionModel: { providerID: 'test', id: 'B', variant: 'high' },
    });
    const before = f.order.length;
    await presets.resumeChild(
      'child',
      'root',
      { bundle: f.bundle('B'), explicitModel: false },
      'explorer',
    );
    expect(f.order).toHaveLength(before);
    expect(f.installs).toHaveLength(1);
    await presets.apply('child', 'C');
    expect((await presets.retry('child', operationID)).presetName).toBe('C');
    expect((await presets.ensure('child'))?.execution?.presetName).toBe('B');
    await presets.resumeChild(
      'child',
      'root',
      {
        bundle: f.bundle('B'),
        explicitModel: false,
      },
      'explorer',
    );
    expect(await presets.ensure('child')).toMatchObject({
      bundle: { presetName: 'B' },
      revision: 1,
      executionModel: { providerID: 'test', id: 'B', variant: 'high' },
    });
    expect(f.installs).toHaveLength(1);
    await presets.dispose();
  });

  test('transition install timeout retains pending and its real flight until retirement drains the host', async () => {
    const f = fixture();
    const presets = f.create();
    f.parents.set('child', 'root');
    await presets.bindChild('child', 'root', f.bundle('A'));
    const timers = createTimerHarness();
    const flight = Promise.withResolvers<void>();
    let switches = 0;
    let published = 0;
    const bridge = createSessionProfileBridge({
      profiles: () => f.bundle('A').profiles,
      pluginAgents: new Set(['explorer']),
      session: {
        switchModel: async () => {
          switches++;
          await flight.promise;
        },
      } as never,
      switchTimeoutMs: 10,
      setTimeout: timers.setTimeout,
      clearTimeout: (timer) => {
        if (typeof timer !== 'number')
          throw new Error('Expected harness timer');
        timers.clearTimeout(timer);
      },
    });
    await bridge.installSessionProfile(
      'child',
      f.bundle('A').profiles.explorer,
      0,
    );
    presets.setExecution({
      assertIdle: (id) => bridge.assertIdle(id),
      install: async (id, record, agent) => {
        await bridge.installSessionProfile(
          id,
          record.bundle.profiles[agent],
          record.revision ?? 0,
          record.executionModel,
        );
        published++; // setup's subsequent fallback publication must not run
      },
    });
    const transition = presets
      .resumeChild(
        'child',
        'root',
        {
          bundle: f.bundle('B'),
          explicitModel: false,
        },
        'explorer',
      )
      .catch((error: Error) => error);
    await tick();
    expect(switches).toBe(1);
    await timers.advance(10);
    expect(await transition).toMatchObject({
      message: 'session profile model switch timed out',
    });
    const state = await presets.readState('child');
    expect(state.status).toBe('transitioning');
    if (!state.pending) throw new Error('Missing pending operation');
    const originalIdentity = f.session.get;
    let identityReads = 0;
    f.session.get = async (input) => {
      identityReads++;
      return originalIdentity(input);
    };
    const retry = presets
      .retry('child', state.pending.operationID)
      .catch((error: Error) => error);
    await tick();
    expect(timers.pending()).toBe(0);
    expect(await retry).toMatchObject({
      message: 'Session profile model switch is still in flight',
    });
    expect(identityReads).toBe(0);
    f.session.get = originalIdentity;
    expect(switches).toBe(1);
    expect(published).toBe(0);
    expect(bridge.profileForSession('child')).toEqual(
      f.bundle('A').profiles.explorer,
    );
    bridge.retire();
    let drained = false;
    const drain = bridge.drain().then(() => {
      drained = true;
    });
    await presets.dispose(); // the bounded install no longer holds serial
    await tick();
    expect(drained).toBe(false); // teardown still owns the actual native call
    await expect(
      bridge.installSessionProfile(
        'other',
        f.bundle('B').profiles.explorer,
        1,
        f.bundle('B').profiles.explorer.model,
      ),
    ).rejects.toThrow('retired');
    await expect(bridge.ensureSessionProfile('child')).rejects.toThrow(
      'retired',
    );
    flight.resolve();
    await drain;
    expect(drained).toBe(true);
    expect(switches).toBe(1);
    expect(published).toBe(0);
    expect(bridge.profileForSession('child')).toEqual(
      f.bundle('A').profiles.explorer,
    );
    expect(f.values.get('session-preset/v1/child')).toMatchObject({
      pending: { kind: 'transition', target: { bundle: { presetName: 'B' } } },
    });
  });

  test('empty root initialization persists before native create, blocks admission and recovers the same ID without overwriting later Apply', async () => {
    const f = fixture();
    const roots = new Map<string, unknown>();
    let creates = 0;
    let lookupError: Error | undefined;
    let service: ReturnType<typeof createSessionPresets>;
    const session = {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (lookupError) throw lookupError;
        if (!roots.has(sessionID))
          throw Object.assign(new Error('Session.NotFoundError'), {
            _tag: 'Session.NotFoundError',
            sessionID,
          });
        return roots.get(sessionID);
      },
      create: async (input: { id: string; agent: string; model: ModelRef }) => {
        creates++;
        expect(f.values.get(`session-preset/v1/${input.id}`)).toMatchObject({
          pending: { kind: 'createBound' },
        });
        roots.set(input.id, { ...input, directory: '/project' });
        await expect(service.ensure(input.id)).rejects.toThrow('pending');
        throw new Error('create acknowledgement lost');
      },
    };
    let namedCalls = 0;
    const createService = () =>
      createSessionPresets({
        storage: f.storage,
        session: session as never,
        directory: '/project',
        location: { directory: '/project' },
        current: () => f.bundle('default'),
        named: async (name) => {
          namedCalls++;
          return f.bundle(name);
        },
        agents: async () => ({
          location: { directory: '/project' },
          data: [
            { id: 'lead', mode: 'primary' },
            { id: 'hidden', mode: 'all', hidden: true },
          ],
        }),
      });
    service = createService();
    const input = {
      sessionID: 'root',
      operationID: 'create-op',
      presetName: 'A',
      agent: 'lead',
      model: { providerID: 'native', id: 'selected', variant: 'high' },
    };
    lookupError = Object.assign(new Error('missing endpoint'), { status: 404 });
    await expect(service.createBound(input)).rejects.toThrow(
      'missing endpoint',
    );
    expect(f.values.size).toBe(0);
    expect(creates).toBe(0);
    lookupError = undefined;
    await expect(service.createBound(input)).rejects.toThrow(
      'acknowledgement lost',
    );
    expect((await service.readState('root')).status).toBe('initializing');
    await expect(
      service.createBound({ ...input, presetName: 'B' }),
    ).rejects.toThrow('conflicts');
    await service.dispose();
    service = createService();
    await expect(service.ensure('root')).rejects.toThrow('pending');
    expect((await service.retry('root', 'create-op')).status).toBe('bound');
    expect(creates).toBe(1);
    expect(namedCalls).toBe(1);
    await service.apply('root', 'B');
    expect((await service.createBound(input)).presetName).toBe('B');
    expect((await service.retry('root', 'create-op')).presetName).toBe('B');
    roots.set('occupied', { id: 'occupied' });
    await expect(
      service.createBound({ ...input, sessionID: 'occupied' }),
    ).rejects.toThrow('unused session ID');
    await expect(
      service.createBound({
        ...input,
        sessionID: 'hidden-root',
        agent: 'hidden',
      }),
    ).rejects.toThrow('visible primary/all');
    await service.dispose();
  });

  test('roots freeze at admission; switch, descendants and restart keep independent complete bundles', async () => {
    const f = fixture();
    let presets = f.create();
    await presets.ensure('root-A');
    f.setCurrent('B');
    await presets.ensure('root-B');
    // A never delegated before the global edit, but its new child still gets A.
    f.parents.set('old-child', 'root-A');
    await presets.bindChild(
      'old-child',
      'root-A',
      (await presets.ensure('root-A')).bundle,
    );
    const capture = (await presets.ensure('root-A')).bundle;
    await Promise.all([presets.apply('root-A', 'B'), presets.ensure('root-B')]);
    f.parents.set('in-flight', 'root-A');
    await presets.bindChild('in-flight', 'root-A', capture);
    f.parents.set('new-child', 'root-A');
    await presets.bindChild(
      'new-child',
      'root-A',
      (await presets.ensure('root-A')).bundle,
    );
    f.parents.set('grandchild', 'old-child');
    await presets.bindChild(
      'grandchild',
      'old-child',
      (await presets.ensure('old-child')).bundle,
    );
    // Crash after native create but before progress bind. Parent has already
    // moved to B; restart keeps the child unmanaged, never pretending B was
    // its launch team and never blocking native compatibility admission.
    f.parents.set('interrupted-child', 'root-A');
    await presets.dispose();
    presets = f.create();
    f.setCurrent('C');
    for (const [id, name] of [
      ['old-child', 'A'],
      ['in-flight', 'A'],
      ['grandchild', 'A'],
      ['new-child', 'B'],
      ['root-B', 'B'],
    ]) {
      const record = await presets.ensure(id);
      expect(record.bundle).toEqual(f.bundle(name));
    }
    // Another location may update KV while this instance still has an old
    // peek. Reads must observe KV without mutating an admitted frozen bundle.
    const priorRoot = presets.peek('root-B');
    f.values.set('session-preset/v1/root-B', {
      schemaVersion: 1,
      bundle: f.bundle('D'),
    });
    expect((await presets.readState('root-B')).presetName).toBe('D');
    expect((await presets.ensure('root-B')).bundle).toEqual(f.bundle('D'));
    expect(priorRoot?.bundle).toEqual(f.bundle('B'));
    // Apply must also read the remote execution policy, not its stale peek.
    f.values.set('session-preset/v1/new-child', {
      schemaVersion: 1,
      parentID: 'root-A',
      bundle: f.bundle('D'),
      execution: f.bundle('B'),
      preserveModel: true,
      explicitModel: true,
    });
    await presets.apply('new-child', 'E');
    expect(presets.peek('new-child')?.execution).toEqual(f.bundle('B'));
    expect(presets.peek('new-child')?.explicitModel).toBe(true);
    // Reads started before deletion, or during an uncertain deletion, must
    // not resurrect the old snapshot after remove invalidates its cache.
    for (const [id, uncertain] of [
      ['grandchild', false],
      ['in-flight', true],
    ] as const) {
      const originalGet = f.storage.get;
      const originalRemove = f.storage.remove;
      const readEntered = Promise.withResolvers<void>();
      const readRelease = Promise.withResolvers<void>();
      const removeEntered = Promise.withResolvers<void>();
      const removeRelease = Promise.withResolvers<void>();
      let pauseRead = true;
      f.storage.get = async (key) => {
        const value = await originalGet(key);
        if (key === `session-preset/v1/${id}` && pauseRead) {
          pauseRead = false;
          readEntered.resolve();
          await readRelease.promise;
        }
        return value;
      };
      f.storage.remove = async (key) => {
        if (uncertain) {
          removeEntered.resolve();
          await removeRelease.promise;
        }
        await originalRemove(key);
        if (uncertain) throw new Error('delete acknowledgement lost');
      };
      const removing = uncertain
        ? presets.remove(id).catch((error: Error) => error)
        : undefined;
      if (uncertain) await removeEntered.promise;
      const reading = presets.readState(id);
      await readEntered.promise;
      if (uncertain) {
        removeRelease.resolve();
        expect(await removing).toMatchObject({
          message: 'delete acknowledgement lost',
        });
      } else await presets.remove(id);
      expect(presets.peek(id)).toBeUndefined();
      readRelease.resolve();
      expect((await reading).status).toBe('unbound');
      expect(presets.peek(id)).toBeUndefined();
      f.storage.get = originalGet;
      f.storage.remove = originalRemove;
    }
    // A deleted child stays unmanaged; no parent-copy rebind.
    expect((await presets.readState('grandchild')).status).toBe('unbound');
    expect(presets.peek('grandchild')).toBeUndefined();
    expect(await presets.ensure('grandchild')).toBeUndefined();
    f.values.set('session-preset/v1/root-B', { schemaVersion: 2 });
    await expect(presets.ensure('root-B')).rejects.toThrow();
    expect(presets.peek('root-B')).toBeUndefined();
    expect(await presets.ensure('interrupted-child')).toBeUndefined();
    expect(f.values.has('session-preset/v1/interrupted-child')).toBe(false);
    expect((await presets.readState('interrupted-child')).status).toBe(
      'unbound',
    );
    await expect(presets.apply('interrupted-child', 'B')).rejects.toThrow(
      'unbound child',
    );
    const compat = wrapSessionPresetSubagent({
      presets,
      capture: async () => ({ bundle: null, explicitModel: false }),
      execute: async (_input, raw) => {
        f.parents.set('compat-child', 'interrupted-child');
        await (
          raw as { progress: (update: unknown) => Promise<void> }
        ).progress({ sessionID: 'compat-child', status: 'running' });
        expect(await presets.ensure('compat-child')).toBeUndefined();
        return 'native-compat';
      },
    });
    expect(
      await compat(
        {},
        {
          sessionID: 'interrupted-child',
          id: 'compat-call',
          signal: new AbortController().signal,
          progress: async () => {},
        },
      ),
    ).toBe('native-compat');
    const resumeCompat = wrapSessionPresetSubagent({
      presets,
      capture: async () => ({ bundle: f.bundle('B'), explicitModel: false }),
      execute: async (input, raw) => {
        expect(input).toEqual({
          sessionID: 'interrupted-child',
          agent: 'explorer',
          description: 'resume',
          prompt: 'work',
        });
        await (
          raw as { progress: (update: unknown) => Promise<void> }
        ).progress({ sessionID: 'interrupted-child', status: 'running' });
        return 'native-resume-compat';
      },
    });
    expect(
      await resumeCompat(
        {
          sessionID: 'interrupted-child',
          agent: 'explorer',
          description: 'resume',
          prompt: 'work',
        },
        {
          sessionID: 'root-A',
          id: 'resume-compat-call',
          signal: new AbortController().signal,
          progress: async () => {},
        },
      ),
    ).toBe('native-resume-compat');
    expect(f.values.has('session-preset/v1/interrupted-child')).toBe(false);
    expect(f.values.has('session-preset/v1/compat-child')).toBe(false);
    await presets.apply('old-child', 'B');
    expect((await presets.ensure('old-child')).execution).toEqual(
      f.bundle('A'),
    );
    await presets.remove('root-A');
    expect((await presets.ensure('old-child')).execution).toEqual(
      f.bundle('A'),
    );
    f.parents.set('orphan', 'missing-root');
    expect(await presets.ensure('orphan')).toBeUndefined();
    f.values.set('session-preset/v1/corrupt', { schemaVersion: 2 });
    await expect(presets.ensure('corrupt')).rejects.toThrow();
    f.parents.set('conflict', 'root-B');
    f.values.set('session-preset/v1/conflict', {
      schemaVersion: 1,
      parentID: 'wrong-parent',
      bundle: f.bundle('A'),
    });
    await expect(presets.ensure('conflict')).rejects.toThrow(
      'parent identity mismatch',
    );
    f.storage.get = async () => {
      throw new Error('get unavailable');
    };
    await expect(presets.ensure('new-child')).rejects.toThrow(
      'get unavailable',
    );
    expect(presets.peek('new-child')).toBeUndefined();
    await presets.dispose();
    // Reduced hosts keep legacy prompts/delegation without pretending that
    // session-only RPC or managed child persistence is available. Missing
    // storage must not force an identity probe, nor vice versa.
    for (const capability of [
      {
        storage: undefined,
        session: {
          get: async () => {
            throw new Error('unexpected identity probe');
          },
        },
      },
      { storage: f.storage, session: {} },
    ]) {
      const reduced = createSessionPresets({
        ...capability,
        session: capability.session as never,
        directory: '/project',
        current: () => {
          throw new Error('unexpected managed snapshot');
        },
        named: async () => f.bundle('A'),
      });
      expect(reduced.available).toBe(false);
      expect(await reduced.ensure('legacy-root')).toBeUndefined();
      await expect(reduced.readState('legacy-root')).rejects.toThrow(
        'unavailable',
      );
      await expect(reduced.apply('legacy-root', 'A')).rejects.toThrow(
        'unavailable',
      );
      await expect(
        reduced.bindChild('legacy-child', 'legacy-root', f.bundle('A')),
      ).rejects.toThrow('unavailable');
      await reduced.remove('legacy-root');
      await reduced.dispose();
      expect(() => reduced.checkActive()).toThrow('retired');
    }
  });

  test.each(['missing', 'rejecting'])(
    'legacy explicit resume bypasses %s model availability preflight without binding',
    async (availability) => {
      const f = fixture();
      const presets = f.create();
      const bundle = (await presets.ensure('root')).bundle;
      f.parents.set('legacy-child', 'root');
      const before = structuredClone([...f.values]);
      let validations = 0;
      let nativeCalls = 0;
      let progressCalls = 0;
      const input = {
        sessionID: 'legacy-child',
        agent: 'explorer',
        model: 'manual/chosen#low',
      };
      const result = { content: 'native legacy result' };
      const execute = wrapSessionPresetSubagent({
        presets,
        capture: async () => ({ bundle, explicitModel: true }),
        ...(availability === 'rejecting'
          ? {
              validateSelection: async () => {
                validations++;
                throw new Error('legacy must not require model.list');
              },
            }
          : {}),
        execute: async (args, raw) => {
          nativeCalls++;
          expect(args).toBe(input);
          await (
            raw as { progress: (update: unknown) => Promise<void> }
          ).progress({ sessionID: 'legacy-child', status: 'running' });
          return result;
        },
      });
      try {
        expect(
          await execute(input, {
            sessionID: 'root',
            id: 'legacy-explicit',
            signal: new AbortController().signal,
            progress: async () => {
              progressCalls++;
            },
          }),
        ).toBe(result);
        expect(validations).toBe(0);
        expect(nativeCalls).toBe(1);
        expect(progressCalls).toBe(1);
        expect([...f.values]).toEqual(before);
        expect(await presets.ensure('legacy-child')).toBeUndefined();
        expect(f.installs).toHaveLength(0);
      } finally {
        await presets.dispose();
      }
    },
  );

  test('native execute is called once; persist → original progress → prompt; resume updates the captured team and explicit selection', async () => {
    const f = fixture();
    const presets = f.create();
    const captured = (await presets.ensure('root')).bundle;
    let calls = 0;
    const signal = new AbortController().signal;
    const input = { agent: 'explorer', model: 'manual/chosen#low' };
    const context = {
      sessionID: 'root',
      id: 'call',
      signal,
      progress: async () => {
        f.order.push('progress');
      },
    };
    const execute = wrapSessionPresetSubagent({
      presets,
      capture: async () => ({ bundle: captured, explicitModel: true }),
      execute: async (args, raw) => {
        calls++;
        expect(args).toBe(input);
        const ctx = raw as typeof context;
        expect(ctx.signal).toBe(signal);
        f.parents.set('child', 'root');
        await presets.apply('root', 'B');
        await ctx.progress({ sessionID: 'child', status: 'running' } as never);
        await ctx.progress({ sessionID: 'child', status: 'running' } as never);
        f.order.push('prompt');
        return 'native-result';
      },
    });
    expect(await execute(input, context)).toBe('native-result');
    // Repeated progress and a structurally identical bundle with different
    // JSON key order must not overwrite or conflict with the launch binding.
    await presets.bindChild('child', 'root', {
      inheritance: captured.inheritance,
      chains: captured.chains,
      profiles: captured.profiles,
      fallbackEnabled: captured.fallbackEnabled,
      presetName: captured.presetName,
    });
    expect(calls).toBe(1);
    expect(f.order.slice(-4)).toEqual([
      'persist:child',
      'progress',
      'progress',
      'prompt',
    ]);
    const child = await presets.ensure('child');
    expect(child.bundle).toEqual(f.bundle('A'));
    expect(child.preserveModel).toBe(true);
    expect(child.explicitModel).toBe(true);
    const resumedInput = {
      agent: 'explorer',
      sessionID: 'child',
      model: 'manual/changed#low',
    };
    const resumed = wrapSessionPresetSubagent({
      presets,
      validateSelection: async (selection) =>
        assertAvailableDelegationSelection(selection, [
          { providerID: 'manual', id: 'changed', variants: [{ id: 'low' }] },
        ]),
      capture: async () => ({ bundle: f.bundle('B'), explicitModel: true }),
      execute: async (args, raw) => {
        expect(args).toEqual({ agent: 'explorer', sessionID: 'child' });
        expect(resumedInput.model).toBe('manual/changed#low');
        await (raw as { progress: (data: unknown) => Promise<void> }).progress({
          sessionID: 'child',
          status: 'running',
        });
        return 'resumed';
      },
    });
    expect(await resumed(resumedInput, context)).toBe('resumed');
    expect((await presets.ensure('child')).bundle).toEqual(f.bundle('B'));
    expect(f.installs).toMatchObject([
      {
        id: 'child',
        record: {
          revision: 1,
          executionModel: {
            providerID: 'manual',
            id: 'changed',
            variant: 'low',
          },
        },
      },
    ]);
    const switches: unknown[] = [];
    const bridge = createSessionProfileBridge({
      profiles: () => f.bundle('B').profiles,
      profilesForSession: async (id) =>
        (await presets.ensure(id)).bundle.profiles,
      preserveSessionModel: (id) => presets.peek(id)?.preserveModel === true,
      pluginAgents: new Set(['explorer']),
      registeredProfiles: f.bundle('B').profiles,
      session: {
        switchModel: async (args: unknown) => {
          switches.push(args);
        },
      } as never,
    });
    await bridge.ensureSessionProfile('child', {
      parentID: 'root',
      agent: 'explorer',
      model: f.bundle('B').profiles.explorer.model,
    });
    expect(switches).toEqual([]);
    expect(bridge.profileForSession('child')?.temperature).toBe(0.8);
    // Explicit cross-provider launches and cross-provider fallback requests
    // keep generic temperature, but never carry test-vendor reasoning keys.
    const profile = {
      ...bridge.profileForSession('child'),
      managedProviderOptionKeys: ['reasoning', 'registeredKey'],
    };
    for (const providerID of ['test', 'manual', 'backup']) {
      const event = {
        sessionID: 'child',
        agent: 'explorer',
        model: { providerID, id: 'selected' },
        options: {
          reasoning: 'stale-preset',
          registeredKey: 'stale-baseline',
          native: true,
          temperature: 0.9,
        },
      } as unknown as V2SessionContextEvent;
      applyRuntimeProfileOptions(event, profile, child);
      expect(event.options).toEqual({
        native: true,
        temperature: 0.8,
        ...(providerID === 'test' ? { reasoning: 'B' } : {}),
      });
    }
    expect(profile.model?.providerID).toBe('test');
    const genericTemperature = {
      model: { providerID: 'test' },
      options: {},
    } as unknown as V2SessionContextEvent;
    applyRuntimeProfileOptions(
      genericTemperature,
      {
        ...profile,
        providerOptions: { ...profile.providerOptions, temperature: 99 },
        managedProviderOptionKeys: [
          ...profile.managedProviderOptionKeys,
          'temperature',
        ],
      },
      child,
    );
    expect(genericTemperature.options?.temperature).toBe(0.8);
    const { model: _model, ...inherited } = profile;
    const inheritedEvent = {
      model: { providerID: 'test' },
      options: {},
    } as unknown as V2SessionContextEvent;
    applyRuntimeProfileOptions(inheritedEvent, inherited, {
      inheritedProviderID: 'test',
    });
    expect(inheritedEvent.options).toEqual({
      temperature: 0.8,
      reasoning: 'B',
    });
    const legacyEvent = {
      model: { providerID: 'manual' },
      options: {},
    } as unknown as V2SessionContextEvent;
    applyRuntimeProfileOptions(legacyEvent, profile);
    expect(legacyEvent.options).toEqual({ temperature: 0.8, reasoning: 'B' });
    await presets.dispose();
  });

  test.each(['reject', 'cancel', 'retire'])(
    'authorized resume preflight %s cannot publish a pending revision or prompt',
    async (failure) => {
      const f = fixture();
      const presets = f.create();
      f.parents.set('child', 'root');
      await presets.bindChild('child', 'root', f.bundle('A'));
      const before = structuredClone([...f.values]);
      const writes = f.order.length;
      const entered = Promise.withResolvers<void>();
      const validation = Promise.withResolvers<void>();
      const abort = new AbortController();
      let retirement: Promise<void> | undefined;
      let drained = false;
      let nativeCalls = 0;
      let prompts = 0;
      const execute = wrapSessionPresetSubagent({
        presets,
        capture: async () => ({ bundle: f.bundle('B'), explicitModel: true }),
        validateSelection: async () => {
          entered.resolve();
          await validation.promise;
        },
        execute: async (_args, raw) => {
          nativeCalls++;
          await (
            raw as { progress: (data: unknown) => Promise<void> }
          ).progress({
            sessionID: 'child',
            status: 'running',
          });
          prompts++;
        },
      });
      const outcome = execute(
        { sessionID: 'child', agent: 'explorer', model: 'manual/chosen#low' },
        {
          sessionID: 'root',
          id: 'call',
          signal: abort.signal,
          progress: async () => {},
        },
      ).catch((error: Error) => error);
      await entered.promise;
      expect([...f.values]).toEqual(before);
      if (failure === 'reject')
        validation.reject(new Error('model list failed'));
      else {
        if (failure === 'cancel')
          abort.abort(new Error('cancelled validation'));
        else {
          retirement = presets.dispose().then(() => {
            drained = true;
          });
          // The serial transaction now owns the in-flight preflight too.
          expect(drained).toBe(false);
        }
        validation.resolve();
      }
      expect(String(await outcome)).toContain(
        failure === 'reject'
          ? 'model list failed'
          : failure === 'cancel'
            ? 'cancelled validation'
            : 'retired',
      );
      expect([...f.values]).toEqual(before);
      expect(f.order).toHaveLength(writes);
      expect(f.installs).toHaveLength(0);
      expect(nativeCalls).toBe(1);
      expect(prompts).toBe(0);
      if (retirement) {
        await retirement;
        expect(drained).toBe(true);
      }
      await presets.dispose();
    },
  );

  test('explicit model availability accepts only exact host model and variant entries', () => {
    const models = [
      { providerID: 'manual', id: 'chosen', variants: [{ id: 'low' }] },
      {
        providerID: 'router',
        id: 'vendor/model:v1',
        variants: [{ id: 'reasoning/high' }],
      },
    ];
    for (const response of [models, { data: models }]) {
      expect(() =>
        assertAvailableDelegationSelection('manual/chosen', response),
      ).not.toThrow();
      expect(() =>
        assertAvailableDelegationSelection('manual/chosen#low', response),
      ).not.toThrow();
      // Fixed host Model.Ref.parse splits on the first slash, then first #;
      // it does not reject additional slashes or colons inside IDs.
      for (const value of [
        'router/vendor/model:v1',
        'router/vendor/model:v1#reasoning/high',
      ]) {
        expect(() =>
          assertAvailableDelegationSelection(value, response),
        ).not.toThrow();
      }
      for (const value of ['missing/chosen', 'manual/chosen#high']) {
        expect(() =>
          assertAvailableDelegationSelection(value, response),
        ).toThrow('not available');
      }
      for (const value of [
        'invalid',
        'manual/chosen#',
        'manual/chosen#low#x',
        'manual#invalid/chosen',
      ]) {
        expect(() =>
          assertAvailableDelegationSelection(value, response),
        ).toThrow('Invalid explicit');
      }
    }
    for (const response of [undefined, {}, { data: {} }]) {
      expect(() =>
        assertAvailableDelegationSelection('manual/chosen', response),
      ).toThrow('cannot be verified');
    }
  });

  test('storage failure, cancellation and retired generation cannot pass the native progress prompt barrier', async () => {
    for (const failure of ['storage', 'cancel', 'retired']) {
      const f = fixture();
      const presets = f.create();
      const bundle = (await presets.ensure('root')).bundle;
      const abort = new AbortController();
      let prompted = false;
      let progressed = false;
      const execute = wrapSessionPresetSubagent({
        presets,
        capture: async () => ({ bundle, explicitModel: false }),
        execute: async (_args, raw) => {
          f.parents.set('child', 'root');
          if (failure === 'storage')
            f.storage.set = async () => {
              throw new Error('disk unavailable');
            };
          if (failure === 'cancel') abort.abort();
          if (failure === 'retired') await presets.dispose();
          await (
            raw as { progress: (data: unknown) => Promise<void> }
          ).progress({ sessionID: 'child', status: 'running' });
          prompted = true;
        },
      });
      await expect(
        execute(
          {},
          {
            sessionID: 'root',
            id: 'call',
            signal: abort.signal,
            progress: async () => {
              progressed = true;
            },
          },
        ),
      ).rejects.toThrow();
      expect(prompted).toBe(false);
      expect(progressed).toBe(false);
      await presets.dispose();
    }
    // A KV write already underway must drain before the old generation's
    // disposal resolves; its late completion may not open the prompt gate.
    const f = fixture();
    const presets = f.create();
    const bundle = (await presets.ensure('root')).bundle;
    f.parents.set('child', 'root');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalSet = f.storage.set;
    f.storage.set = async (key, value) => {
      entered.resolve();
      await release.promise;
      await originalSet(key, value);
    };
    let progressed = false;
    const execute = wrapSessionPresetSubagent({
      presets,
      capture: async () => ({ bundle, explicitModel: false }),
      execute: async (_input, raw) => {
        await (raw as { progress: (data: unknown) => Promise<void> }).progress({
          sessionID: 'child',
          status: 'running',
        });
        throw new Error('prompt barrier was bypassed');
      },
    });
    const outcome = execute(
      {},
      {
        sessionID: 'root',
        id: 'call',
        signal: new AbortController().signal,
        progress: async () => {
          progressed = true;
        },
      },
    ).catch((error: Error) => error);
    await entered.promise;
    let drained = false;
    const dispose = presets.dispose().then(() => {
      drained = true;
    });
    expect(drained).toBe(false);
    release.resolve();
    expect(String(await outcome)).toContain('retired');
    await dispose;
    expect(progressed).toBe(false);
    expect(presets.peek('child')).toBeUndefined();
    const restarted = f.create();
    expect((await restarted.ensure('child')).bundle).toEqual(f.bundle('A'));
    await restarted.dispose();
  });
});

describe('createSessionProfileBridge', () => {
  test('captures a newly seen plugin child and switches its model', async () => {
    const { bridge, switchCalls } = makeBridge();

    await bridge.observeEvent(created('child-1', 'explorer', 'parent'));

    expect(switchCalls).toEqual([GPT5_SWITCH]);
    expect(bridge.profileForSession('child-1')?.model).toEqual({
      providerID: 'openai',
      id: 'gpt-5-mini',
    });
  });

  test.each(['null', 'model-less', 'preserveModel'])(
    'failed %s capture publication is shared, remains unpublished, and retries successfully',
    async (kind) => {
      let attempts = 0;
      let revision = 1;
      const ready = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const profile =
        kind === 'null'
          ? undefined
          : kind === 'model-less'
            ? { sidebarModel: 'default', temperature: 0.2 }
            : PROFILES.explorer;
      const failure = new Error('fallback model switch is still in flight');
      const bridge = createSessionProfileBridge({
        profiles: () => ({}),
        profilesForSession: async () => {
          entered.resolve();
          await ready.promise;
          return profile ? { explorer: profile } : {};
        },
        pluginAgents: new Set(['explorer']),
        session: undefined,
        preserveSessionModel: () => kind === 'preserveModel',
        revisionForSession: () => revision,
        onSessionCaptured: () => {
          attempts++;
          expect(bridge.size()).toBe(0);
          expect(bridge.profileForSession('child')).toBeUndefined();
          if (attempts === 1) throw failure;
        },
      });
      const identity = { parentID: 'root', agent: 'explorer' };
      const first = bridge
        .ensureSessionProfile('child', identity)
        .catch((error) => error);
      await entered.promise;
      const concurrent = bridge
        .ensureSessionProfile('child', identity)
        .catch((error) => error);
      ready.resolve();
      expect(await first).toBe(failure);
      expect(await concurrent).toBe(failure);
      expect(attempts).toBe(1);
      expect(bridge.size()).toBe(0);
      expect(bridge.profileForSession('child')).toBeUndefined();
      await bridge.ensureSessionProfile('child', identity);
      expect(attempts).toBe(2);
      expect(bridge.size()).toBe(1);
      expect(bridge.profileForSession('child')).toBe(profile);
      await bridge.ensureSessionProfile('child', identity);
      expect(attempts).toBe(2);
      revision = 2;
      await bridge.ensureSessionProfile('child', identity);
      expect(attempts).toBe(3);
      bridge.retire();
      await bridge.drain();
    },
  );

  test('pins chains before the awaited model switch (refresh-race guard)', async () => {
    const gate = Promise.withResolvers<void>();
    const switchEntered = Promise.withResolvers<void>();
    let switchDone = false;
    const captured: string[] = [];
    const { bridge, switchCalls } = makeBridge({
      onSessionCaptured: (sessionID) => captured.push(sessionID),
      switchModel: async () => {
        switchEntered.resolve();
        await gate.promise;
        switchDone = true;
        return {};
      },
    });

    const pending = bridge.observeEvent(created('child-1', 'explorer', 'p'));
    // The switch has started; the capture callback must already have
    // fired. Pinning happens at capture time, before the awaited switch,
    // so a refresh completing mid-switch cannot pair the old profile with
    // a newer chain generation.
    await switchEntered.promise;
    expect(captured).toEqual(['child-1']);
    expect(switchCalls).toEqual([GPT5_SWITCH]);
    expect(switchDone).toBe(false);

    gate.resolve();
    await pending;
    expect(switchDone).toBe(true);
  });

  test('releases the pin when the model switch fails (retry-race guard)', async () => {
    const captured: string[] = [];
    const failed: string[] = [];
    const { bridge } = makeBridge({
      onSessionCaptured: (sessionID) => captured.push(sessionID),
      onSessionCaptureFailed: (sessionID) => failed.push(sessionID),
      switchModel: async () => {
        throw new Error('switch failed');
      },
    });

    // Fail-closed: the rejection still aborts the admission (the awaited
    // prompt path propagates; only the event pump swallows).
    await expect(
      bridge.ensureSessionProfile('child-1', {
        parentID: 'p',
        agent: 'explorer',
      }),
    ).rejects.toThrow('switch failed');
    // The capture-time pin fired, then its release: the retry pins the
    // generation current at that retry instead of keeping this pin.
    expect(captured).toEqual(['child-1']);
    expect(failed).toEqual(['child-1']);
  });

  test('accepts the flat early-registration shape', async () => {
    const { bridge, switchCalls } = makeBridge();

    await bridge.observeEvent({
      type: 'session.created',
      id: 'child-flat',
      parentID: 'parent',
      agent: 'explorer',
    });

    expect(switchCalls).toHaveLength(1);
    expect(bridge.profileForSession('child-flat')).toBeDefined();
  });

  test('never touches root, foreign-agent, or non-created events', async () => {
    const { bridge, switchCalls } = makeBridge();

    await bridge.observeEvent({
      type: 'session.created',
      data: { sessionID: 'root', agent: 'explorer' },
    });
    await bridge.observeEvent({
      type: 'session.created',
      data: { sessionID: 'foreign', parentID: 'parent', agent: 'custom' },
    });
    await bridge.observeEvent({
      type: 'message.updated',
      data: { sessionID: 'x', parentID: 'parent', agent: 'explorer' },
    });
    await bridge.observeEvent({});

    expect(switchCalls).toHaveLength(0);
    expect(bridge.size()).toBe(0);
  });

  test('keeps per-call models and variants but refreshes exact host defaults', async () => {
    let profiles = PROFILES;
    const models: Record<string, ModelRef> = {
      event: { providerID: 'other', id: 'gpt-5-mini', variant: 'low' },
      get: { providerID: 'openai', id: 'per-call', variant: 'low' },
      variant: { ...PROFILES.explorer.model, variant: 'max' },
      default: { ...PROFILES.explorer.model, variant: 'default' },
    };
    const { bridge, switchCalls } = makeBridge({
      profiles: () => profiles,
      registeredProfiles: PROFILES,
      get: async (input) => ({
        parentID: 'parent',
        agent: 'explorer',
        model: models[(input as { sessionID: string }).sessionID],
      }),
    });
    const event = created('event');
    await bridge.observeEvent({
      ...event,
      data: { ...event.data, model: models.event },
    });
    await bridge.ensureSessionProfile('get');
    await bridge.ensureSessionProfile('variant');
    expect(switchCalls).toEqual([]);
    expect(bridge.profileForSession('get')).toBe(PROFILES.explorer);

    profiles = {
      ...PROFILES,
      explorer: {
        ...PROFILES.explorer,
        model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' },
        sidebarModel: 'anthropic/claude-sonnet-4-5',
      },
    };
    await bridge.observeEvent(event);
    await bridge.ensureSessionProfile('default');
    expect(switchCalls).toEqual([
      { sessionID: 'default', model: profiles.explorer.model },
    ]);
    expect(bridge.profileForSession('event')).toBe(PROFILES.explorer);
    expect(bridge.profileForSession('default')).toBe(profiles.explorer);
  });

  test('captures without a model and leaves a failed switch uncaptured', async () => {
    const { bridge } = makeBridge({
      switchModel: async () => {
        throw new Error('host refused');
      },
    });

    await bridge.observeEvent(created('c1', 'oracle'));
    await bridge.observeEvent(created('c2'));

    expect(bridge.profileForSession('c1')?.model).toBeUndefined();
    expect(bridge.profileForSession('c2')).toBeUndefined();
    expect(bridge.size()).toBe(1);
  });

  test('keeps an explicit model when a model-less startup profile is refreshed', async () => {
    const model = { providerID: 'other', id: 'fallback', variant: 'max' };
    const { bridge, switchCalls } = makeBridge({
      registeredProfiles: PROFILES,
      profiles: () => ({ ...PROFILES, oracle: PROFILES.explorer }),
      get: async (input) => ({
        parentID: 'p',
        agent: 'oracle',
        model:
          (input as { sessionID: string }).sessionID === 'default'
            ? undefined
            : model,
      }),
    });
    await bridge.ensureSessionProfile('child');
    expect(switchCalls).toEqual([]);
    expect(bridge.profileForSession('child')).toBe(PROFILES.explorer);
    await bridge.ensureSessionProfile('default');
    expect(switchCalls).toEqual([
      { sessionID: 'default', model: PROFILES.explorer.model },
    ]);
  });

  test('leaves a modeled child uncaptured without session.switchModel', async () => {
    const { bridge } = makeBridge({ withSwitchModel: false });

    await bridge.observeEvent(created('c1'));

    expect(bridge.profileForSession('c1')).toBeUndefined();
  });

  test('drops captured state on session.deleted', async () => {
    const { bridge, getCalls, switchCalls } = makeBridge();
    await bridge.observeEvent(created('c1'));
    expect(bridge.size()).toBe(1);

    await bridge.observeEvent({
      type: 'session.deleted',
      data: { sessionID: 'c1' },
    });

    expect(bridge.size()).toBe(0);
    expect(bridge.profileForSession('c1')).toBeUndefined();

    // A prompt racing after deletion must not perform a potentially hanging
    // identity lookup. A fresh creation event proves id reuse and re-arms it.
    await bridge.ensureSessionProfile('c1');
    expect(getCalls).toHaveLength(0);
    expect(switchCalls).toHaveLength(1);
    await bridge.observeEvent(created('c1'));
    expect(switchCalls).toHaveLength(2);
  });

  test('bounded capture map evicts oldest entries', async () => {
    const { bridge } = makeBridge();
    for (let index = 0; index < 1100; index += 1) {
      await bridge.observeEvent(created(`child-${index}`, 'oracle'));
    }
    expect(bridge.size()).toBeLessThanOrEqual(1024);
    expect(bridge.profileForSession('child-0')).toBeUndefined();
  });

  test('ensureSessionProfile resolves identity through session.get and awaits the switch', async () => {
    const { bridge, switchCalls, getCalls } = makeBridge({
      get: async () => ({
        id: 'child-1',
        parentID: 'parent',
        agent: 'explorer',
      }),
    });

    await bridge.ensureSessionProfile('child-1');

    expect(getCalls).toEqual([{ sessionID: 'child-1' }]);
    expect(switchCalls).toEqual([GPT5_SWITCH]);
    expect(bridge.profileForSession('child-1')?.temperature).toBe(0.3);
  });

  test('ensureSessionProfile accepts a data-wrapped session.get response', async () => {
    const { bridge, switchCalls } = makeBridge({
      get: async () => ({
        data: {
          id: 'child-1',
          parentID: 'parent',
          agent: 'explorer',
        },
      }),
    });

    await bridge.ensureSessionProfile('child-1');

    expect(switchCalls).toEqual([GPT5_SWITCH]);
  });

  test('ensureSessionProfile is idempotent and a later refresh never alters a captured profile', async () => {
    let profiles = PROFILES;
    const { bridge, switchCalls } = makeBridge({
      profiles: () => profiles,
      get: async () => ({ id: 'c1', parentID: 'p', agent: 'explorer' }),
    });

    await bridge.ensureSessionProfile('c1');
    await bridge.ensureSessionProfile('c1');
    expect(switchCalls).toHaveLength(1);

    // A config refresh replaces the table; the captured profile is frozen.
    profiles = {
      explorer: {
        model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' },
        temperature: 0.9,
        sidebarModel: 'anthropic/claude-sonnet-4-5',
      },
    };
    await bridge.ensureSessionProfile('c1');

    expect(switchCalls).toHaveLength(1);
    expect(bridge.profileForSession('c1')?.model?.id).toBe('gpt-5-mini');
    expect(bridge.profileForSession('c1')?.temperature).toBe(0.3);
  });

  test('ensureSessionProfile latches roots and foreign agents without switching', async () => {
    const { bridge, switchCalls, getCalls } = makeBridge({
      get: async (input) => {
        const sessionID = (input as { sessionID: string }).sessionID;
        return sessionID.startsWith('root')
          ? { id: sessionID, agent: 'explorer' }
          : { id: sessionID, parentID: 'p', agent: 'build' };
      },
    });

    await bridge.ensureSessionProfile('root-1');
    await bridge.ensureSessionProfile('foreign-1');
    // Latched: a second prompt for the same sessions never re-queries.
    await bridge.ensureSessionProfile('root-1');
    await bridge.ensureSessionProfile('foreign-1');

    expect(getCalls).toHaveLength(2);
    expect(switchCalls).toHaveLength(0);
    expect(bridge.size()).toBe(0);
  });

  test('ensureSessionProfile falls back to the prompt bridge agent when session.get lacks it', async () => {
    const { bridge, switchCalls } = makeBridge({
      get: async () => ({ id: 'c1', parentID: 'p' }),
      knownAgent: () => 'explorer',
    });

    await bridge.ensureSessionProfile('c1');

    expect(switchCalls).toHaveLength(1);
    expect(bridge.profileForSession('c1')?.model?.id).toBe('gpt-5-mini');
  });

  test('ensureSessionProfile leaves unknown identity untouched until the event path supplies it', async () => {
    const { bridge, switchCalls } = makeBridge();

    await bridge.ensureSessionProfile('c1');
    expect(switchCalls).toHaveLength(0);
    expect(bridge.profileForSession('c1')).toBeUndefined();

    await bridge.observeEvent(created('c1'));
    expect(switchCalls).toHaveLength(1);

    // The delayed event capture is a no-op for later prompt-path calls.
    await bridge.ensureSessionProfile('c1');
    expect(switchCalls).toHaveLength(1);
  });

  test('ensureSessionProfile captures null for a plugin-managed agent absent from the profile table', async () => {
    const { bridge, switchCalls, getCalls } = makeBridge({
      pluginAgents: ['explorer', 'oracle', 'marketplace-agent'],
      get: async () => ({
        id: 'mkt-1',
        parentID: 'p',
        agent: 'marketplace-agent',
      }),
    });

    // Must resolve (admission proceeds); the host-registered model is kept.
    await bridge.ensureSessionProfile('mkt-1');

    expect(switchCalls).toHaveLength(0);
    expect(bridge.profileForSession('mkt-1')).toBeUndefined();
    expect(bridge.size()).toBe(1);

    // Frozen: a second prompt never re-queries or switches.
    await bridge.ensureSessionProfile('mkt-1');
    expect(getCalls).toHaveLength(1);
    expect(switchCalls).toHaveLength(0);
  });

  test('a timed-out native switch fences retries, refreshed profiles and new revisions until that exact flight settles', async () => {
    const timers = createTimerHarness();
    const first = Promise.withResolvers<void>();
    const next = Promise.withResolvers<void>();
    const calls: ModelRef[] = [];
    let nativeModel: ModelRef | undefined;
    let revision = 0;
    let profiles = PROFILES;
    const profileB = {
      ...PROFILES.explorer,
      model: { providerID: 'test', id: 'B' },
      sidebarModel: 'test/B',
    };
    const identity = { parentID: 'parent', agent: 'explorer' };
    const bridge = createSessionProfileBridge({
      profiles: () => profiles,
      revisionForSession: () => revision,
      pluginAgents: new Set(['explorer']),
      session: {
        switchModel: async ({ model }: { model: ModelRef }) => {
          calls.push(model);
          await (calls.length === 1 ? first.promise : next.promise);
          nativeModel = model;
        },
      } as never,
      switchTimeoutMs: 10,
      setTimeout: timers.setTimeout,
      clearTimeout: (timer) => {
        if (typeof timer !== 'number')
          throw new Error('Expected harness timer');
        timers.clearTimeout(timer);
      },
    });
    const initial = bridge
      .ensureSessionProfile('child', identity)
      .catch((error: Error) => error);
    await tick();
    expect(calls).toHaveLength(1);
    await timers.advance(10);
    expect(await initial).toMatchObject({
      message: 'session profile model switch timed out',
    });
    const retry = bridge
      .ensureSessionProfile('child', identity)
      .catch((error: Error) => error);
    await tick();
    expect(calls).toHaveLength(1); // no second A whose late arrival can undo B
    expect(await retry).toMatchObject({
      message: 'Session profile model switch is still in flight',
    });
    profiles = { ...PROFILES, explorer: profileB };
    revision = 1;
    await expect(
      bridge.ensureSessionProfile('child', identity),
    ).rejects.toThrow('still in flight');
    await expect(
      bridge.installSessionProfile('child', profileB, revision, profileB.model),
    ).rejects.toThrow('still in flight');
    expect(() => bridge.assertIdle('child')).toThrow('still in flight');
    expect(bridge.profileForSession('child')).toBeUndefined();
    first.resolve();
    await tick();
    expect(nativeModel).toEqual(PROFILES.explorer.model);
    expect(bridge.profileForSession('child')).toBeUndefined(); // late A cannot publish B
    expect(() => bridge.assertIdle('child')).not.toThrow();
    const install = bridge.installSessionProfile(
      'child',
      profileB,
      revision,
      profileB.model,
    );
    await tick();
    expect(calls).toEqual([PROFILES.explorer.model, profileB.model]);
    await expect(
      bridge.ensureSessionProfile('child', identity),
    ).rejects.toThrow('still in flight');
    expect(() => bridge.assertIdle('child')).toThrow('still in flight');
    next.resolve();
    await install;
    await bridge.ensureSessionProfile('child', identity);
    expect(nativeModel).toEqual(profileB.model);
    expect(bridge.profileForSession('child')).toEqual(profileB);
    expect(calls).toHaveLength(2);
    expect(timers.pending()).toBe(0);
  });

  test('ensureSessionProfile rejects the admission when switchModel hangs past the bound', async () => {
    const hangingSwitch = () => new Promise(() => undefined);
    const identity = { id: 'c1', parentID: 'p', agent: 'explorer' };
    const { bridge } = makeBridge({
      get: async () => identity,
      switchModel: hangingSwitch,
    });
    const { bridge: bounded } = makeBridge({
      get: async () => identity,
      switchModel: hangingSwitch,
      switchTimeoutMs: 20,
    });

    await expect(bounded.ensureSessionProfile('c1')).rejects.toThrow(
      'session profile model switch timed out',
    );
    // Fail-closed: nothing is captured; the real switch still owns its fence.
    expect(bounded.profileForSession('c1')).toBeUndefined();
    expect(bridge.profileForSession('c1')).toBeUndefined();
  });

  test('ensureSessionProfile awaits switchModel without racing a timeout', async () => {
    let finishSwitch: (() => void) | undefined;
    const { bridge } = makeBridge({
      get: async () => ({ id: 'c1', parentID: 'p', agent: 'explorer' }),
      switchModel: () =>
        new Promise<void>((resolve) => {
          finishSwitch = resolve;
        }),
    });
    let finished = false;
    const capture = bridge.ensureSessionProfile('c1').then(() => {
      finished = true;
    });

    await Bun.sleep(10);
    expect(finished).toBe(false);
    expect(bridge.profileForSession('c1')).toBeUndefined();
    finishSwitch?.();
    await capture;
    expect(finished).toBe(true);
    expect(bridge.profileForSession('c1')?.model?.id).toBe('gpt-5-mini');
  });
});

describe('reconcileRuntimeProfileOptionKeys', () => {
  /** Startup reconcile followed by a later config that drops both agents. */
  const reconcileOnlyDefault = () => {
    const previous = reconcileRuntimeProfileOptionKeys({}, PROFILES);
    return {
      previous,
      next: reconcileRuntimeProfileOptionKeys(previous, {
        explorer: { sidebarModel: 'default' },
      }),
    };
  };

  test('carries startup keys so a refresh can clear removed options', () => {
    const { next } = reconcileOnlyDefault();

    expect(next.explorer.managedProviderOptionKeys).toEqual(['thinking']);
    expect(PROFILES.explorer).not.toHaveProperty('managedProviderOptionKeys');
  });

  test('retains startup-registered agents omitted by a later config', () => {
    const { previous, next } = reconcileOnlyDefault();

    expect(next.oracle).toEqual(previous.oracle);
  });
});

describe('resolveV2EventPayload', () => {
  test('prefers data, then properties, then the event itself', () => {
    expect(
      resolveV2EventPayload({ data: { a: 1 }, properties: { b: 2 } }),
    ).toEqual({ a: 1 });
    expect(resolveV2EventPayload({ properties: { b: 2 } })).toEqual({ b: 2 });
    expect(resolveV2EventPayload({ type: 'x' })).toEqual({});
  });
});

describe('applyRuntimeProfileOptions', () => {
  function makeContextEvent(
    options?: Record<string, unknown>,
  ): V2SessionContextEvent {
    return {
      sessionID: 'child-1',
      agent: 'explorer',
      model: { id: 'gpt-5-mini', providerID: 'openai' },
      system: [{ type: 'text', text: 'system' }],
      messages: [],
      tools: {},
      ...(options ? { options } : {}),
    } as V2SessionContextEvent;
  }

  test('mutates only the options record', () => {
    const event = makeContextEvent({ existing: true });
    const systemBefore = JSON.stringify(event.system);
    const messagesBefore = JSON.stringify(event.messages);

    applyRuntimeProfileOptions(event, PROFILES.explorer);

    expect(event.options).toEqual({
      existing: true,
      temperature: 0.3,
      thinking: { type: 'enabled' },
    });
    // Prompt/tool surfaces are untouched.
    expect(JSON.stringify(event.system)).toBe(systemBefore);
    expect(JSON.stringify(event.messages)).toBe(messagesBefore);
    expect(JSON.stringify(event.tools)).toBe('{}');
  });

  test('no-ops without a profile or an options record', () => {
    const event = makeContextEvent({ a: 1 });
    applyRuntimeProfileOptions(event, undefined);
    expect(event.options).toEqual({ a: 1 });

    const noOptions = makeContextEvent(undefined);
    applyRuntimeProfileOptions(noOptions, PROFILES.explorer);
    expect(noOptions.options).toBeUndefined();
  });

  test('removes temperature and managed provider options cleared by refresh', () => {
    const event = makeContextEvent({
      temperature: 0.8,
      thinking: { type: 'enabled' },
      unrelated: true,
    });

    applyRuntimeProfileOptions(event, {
      sidebarModel: 'default',
      managedProviderOptionKeys: ['thinking'],
    });

    expect(event.options).toEqual({ unrelated: true });
  });
});
