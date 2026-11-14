import { describe, expect, test } from 'bun:test';
import { sessionPresetRpc } from './preset-rpc';
import {
  applyRuntimeProfileOptions,
  createSessionProfileBridge,
  reconcileRuntimeProfileOptionKeys,
  resolveV2EventPayload,
  type SessionProfileBridgeOptions,
} from './runtime-profiles';
import {
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
  profilesForSession?: SessionProfileBridgeOptions['profilesForSession'];
  registeredProfiles?: typeof PROFILES;
  /** Defaults to the fixture plugin agents. */
  pluginAgents?: string[];
  /** Bound for the request-path switch. */
  switchTimeoutMs?: number;
  onSessionCaptured?: (sessionID: string) => void;
  onSessionCaptureFailed?: (sessionID: string) => void;
  isModelAvailable?: (
    ref: ModelRef,
  ) => boolean | undefined | Promise<boolean | undefined>;
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
    ...(options?.profilesForSession
      ? { profilesForSession: options.profilesForSession }
      : {}),
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
    ...(options?.isModelAvailable
      ? { isModelAvailable: options.isModelAvailable }
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
        agent: 'explorer',
      }),
    };
    const create = () =>
      createSessionPresets({
        storage,
        session: session as never,
        directory: '/project',
        current: () => current,
        named: async (name) => bundle(name),
      });
    return {
      create,
      bundle,
      values,
      parents,
      order,
      storage,
      setCurrent: (name: string) => {
        current = bundle(name);
      },
    };
  }

  test('state and RPC display the saved team rather than the edited same-name default without binding on read', async () => {
    const f = fixture();
    const saved = f.bundle('A');
    saved.profiles.explorer.model = {
      providerID: 'test',
      id: 'saved-A',
      variant: 'high',
    };
    saved.profiles.explorer.sidebarVariant = 'low';
    saved.profiles.oracle = {
      sidebarModel: 'default',
      sidebarVariant: 'max',
    };
    saved.profiles.designer = { sidebarModel: 'default' };
    saved.profiles.fixer = {
      model: { providerID: 'test', id: 'saved-A' },
      sidebarModel: 'test/saved-A',
      sidebarVariant: 'medium',
    };
    saved.inheritance.fixer = 'orchestrator';
    f.values.set('session-preset/v1/root', {
      schemaVersion: 1,
      bundle: saved,
    });
    // Current and named A resolve to test/A, not the saved test/saved-A.
    const presets = f.create();
    const state = await presets.readState('root');
    expect(state).toEqual({
      sessionID: 'root',
      status: 'bound',
      presetName: 'A',
      affects: 'future-children-only',
      team: {
        agentModels: {
          explorer: 'test/saved-A',
          oracle: 'default',
          designer: 'default',
          fixer: 'test/saved-A',
        },
        agentVariants: { explorer: 'high', oracle: 'max', fixer: 'medium' },
        inheritance: { oracle: 'session', fixer: 'orchestrator' },
      },
    });
    expect(sessionPresetRpc.methods.read.output.parse(state)).toEqual(state);
    const unbound = await presets.readState('unbound');
    expect(unbound).toEqual({
      sessionID: 'unbound',
      status: 'unbound',
      presetName: null,
      affects: 'future-children-only',
    });
    expect(sessionPresetRpc.methods.read.output.parse(unbound)).toEqual(
      unbound,
    );
    expect(f.values.has('session-preset/v1/unbound')).toBe(false);
    expect(f.order).toEqual([]);
    await presets.dispose();
  });

  test('applied roots freeze; switch, descendants and restart keep independent complete bundles', async () => {
    const f = fixture();
    let presets = f.create();
    // Explicitly applied roots keep their team; default roots follow refreshes.
    await presets.apply('root-A', 'A');
    await presets.apply('root-B', 'B');
    f.setCurrent('B');
    // root-A's new child gets A, not the live default.
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
    // An externally deleted child stays unmanaged; no parent-copy rebind.
    f.values.delete('session-preset/v1/grandchild');
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
        expect(input).toEqual({ sessionID: 'interrupted-child' });
        await (
          raw as { progress: (update: unknown) => Promise<void> }
        ).progress({ sessionID: 'interrupted-child', status: 'running' });
        return 'native-resume-compat';
      },
    });
    expect(
      await resumeCompat(
        { sessionID: 'interrupted-child' },
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
    const applied = await presets.apply('old-child', 'B');
    expect(applied.team).toEqual({
      agentModels: { explorer: 'test/B' },
      agentVariants: { explorer: 'high' },
      inheritance: { oracle: 'session' },
    });
    expect(sessionPresetRpc.methods.apply.output.parse(applied)).toEqual(
      applied,
    );
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

  test('native execute is called once; persist → original progress → prompt; resume preserves its own bundle and explicit selection', async () => {
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
      capture: async () => ({ bundle: f.bundle('B'), explicitModel: true }),
      execute: async (args, raw) => {
        expect(args).toBe(resumedInput);
        await (raw as { progress: (data: unknown) => Promise<void> }).progress({
          sessionID: 'child',
          status: 'running',
        });
        return 'resumed';
      },
    });
    expect(await resumed(resumedInput, context)).toBe('resumed');
    expect((await presets.ensure('child')).bundle).toEqual(f.bundle('A'));
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
    expect(bridge.profileForSession('child')?.temperature).toBe(0.1);
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
        temperature: 0.1,
        ...(providerID === 'test' ? { reasoning: 'A' } : {}),
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
    expect(genericTemperature.options?.temperature).toBe(0.1);
    const { model: _model, ...inherited } = profile;
    const inheritedEvent = {
      model: { providerID: 'test' },
      options: {},
    } as unknown as V2SessionContextEvent;
    applyRuntimeProfileOptions(inheritedEvent, inherited, {
      inheritedProviderID: 'test',
    });
    expect(inheritedEvent.options).toEqual({
      temperature: 0.1,
      reasoning: 'A',
    });
    const legacyEvent = {
      model: { providerID: 'manual' },
      options: {},
    } as unknown as V2SessionContextEvent;
    applyRuntimeProfileOptions(legacyEvent, profile);
    expect(legacyEvent.options).toEqual({ temperature: 0.1, reasoning: 'A' });
    await presets.dispose();
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

  test('switches a stale retired model to the current profile (#1689)', async () => {
    const retired = { providerID: 'cline-oauth', id: 'muse', variant: 'xhigh' };
    const { bridge, switchCalls } = makeBridge({
      registeredProfiles: PROFILES,
      get: async () => ({
        parentID: 'p',
        agent: 'explorer',
        model: retired,
      }),
      isModelAvailable: (ref) => ref.id !== 'muse',
    });
    await bridge.ensureSessionProfile('child');
    // The retired pin is gone from the catalog: it must not be replayed —
    // the child is refreshed onto the current explorer model.
    expect(switchCalls).toEqual([
      { sessionID: 'child', model: PROFILES.explorer.model },
    ]);
  });

  test('keeps a valid per-call model that still resolves in the catalog (#1689)', async () => {
    const override = { providerID: 'openai', id: 'per-call', variant: 'low' };
    const { bridge, switchCalls } = makeBridge({
      registeredProfiles: PROFILES,
      get: async () => ({
        parentID: 'p',
        agent: 'explorer',
        model: override,
      }),
      isModelAvailable: () => true,
    });
    await bridge.ensureSessionProfile('child');
    expect(switchCalls).toEqual([]);
    expect(bridge.profileForSession('child')).toBe(PROFILES.explorer);
  });

  test('keeps a differing model when catalog availability is unknown (#1689)', async () => {
    const unknown = { providerID: 'other', id: 'maybe' };
    const { bridge, switchCalls } = makeBridge({
      registeredProfiles: PROFILES,
      get: async () => ({
        parentID: 'p',
        agent: 'explorer',
        model: unknown,
      }),
      isModelAvailable: () => undefined,
    });
    await bridge.ensureSessionProfile('child');
    expect(switchCalls).toEqual([]);
  });

  test('keeps the child model when the catalog lookup fails (#1689)', async () => {
    const override = { providerID: 'openai', id: 'per-call' };
    const { bridge, switchCalls } = makeBridge({
      registeredProfiles: PROFILES,
      get: async () => ({
        parentID: 'p',
        agent: 'explorer',
        model: override,
      }),
      isModelAvailable: () => Promise.reject(new Error('registry down')),
    });
    await bridge.ensureSessionProfile('child');
    expect(switchCalls).toEqual([]);
  });

  test('refreshes a retired pin onto the current model when the saved team names it too (#1689)', async () => {
    const retired = { providerID: 'cline-oauth', id: 'muse', variant: 'xhigh' };
    const { bridge, switchCalls } = makeBridge({
      registeredProfiles: PROFILES,
      get: async () => ({
        parentID: 'p',
        agent: 'explorer',
        model: retired,
      }),
      profilesForSession: async () => ({
        explorer: { ...PROFILES.explorer, model: retired },
      }),
      isModelAvailable: (ref) => ref.id !== 'muse',
    });
    await bridge.ensureSessionProfile('child');
    // The frozen team names the same retired model as the pin; the switch
    // must land on the current profile model, not the retired one.
    expect(switchCalls).toEqual([
      { sessionID: 'child', model: PROFILES.explorer.model },
    ]);
  });

  test('captures the current profile options when refreshing a retired pin (#1689)', async () => {
    const retired = { providerID: 'cline-oauth', id: 'muse', variant: 'xhigh' };
    const frozen = {
      ...PROFILES.explorer,
      model: retired,
      temperature: 0.9,
      providerOptions: { retiredOnly: true },
    };
    const { bridge, switchCalls } = makeBridge({
      registeredProfiles: PROFILES,
      get: async () => ({
        parentID: 'p',
        agent: 'explorer',
        model: retired,
      }),
      profilesForSession: async () => ({ explorer: frozen }),
      isModelAvailable: (ref) => ref.id !== 'muse',
    });
    await bridge.ensureSessionProfile('child');
    expect(switchCalls).toEqual([
      { sessionID: 'child', model: PROFILES.explorer.model },
    ]);
    // The session must carry the live model's inference profile, not the
    // retired model's temperature/provider options.
    expect(bridge.profileForSession('child')).toBe(PROFILES.explorer);
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
    // Fail-closed: nothing is captured, so a retry re-awaits the switch.
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

describe('ensureSessionProfile admission capture (identity + bound profiles)', () => {
  test('uses the authoritative identity and capture: no host read, no profilesForSession', async () => {
    const forSessionCalls: Array<string> = [];
    const { bridge, getCalls, switchCalls } = makeBridge({
      profilesForSession: (sessionID) => {
        forSessionCalls.push(sessionID);
        return Promise.resolve(PROFILES);
      },
    });
    await bridge.ensureSessionProfile(
      'child-1',
      {
        parentID: 'p',
        agent: 'explorer',
        authoritative: true,
      },
      { profiles: PROFILES },
    );
    // One switched model from the captured table; the host identity
    // lookup and profilesForSession re-ensure never ran.
    expect(getCalls).toHaveLength(0);
    expect(forSessionCalls).toHaveLength(0);
    expect(switchCalls).toEqual([GPT5_SWITCH]);
  });

  test('supplying the capture alone does not bind the identity source', async () => {
    // Capture without an authoritative identity keeps the historic
    // request-path behavior: identity resolved via session.get.
    const { bridge, getCalls, switchCalls } = makeBridge({
      get: async () => ({ id: 'child-1', parentID: 'p', agent: 'explorer' }),
    });
    await bridge.ensureSessionProfile('child-1', undefined, {
      profiles: PROFILES,
    });
    expect(getCalls).toEqual([{ sessionID: 'child-1' }]);
    expect(switchCalls).toEqual([GPT5_SWITCH]);
  });

  test('authoritative identity without parentID is a proven root — host not re-read', async () => {
    const { bridge, getCalls, switchCalls } = makeBridge({
      knownAgent: () => 'orchestrator',
    });
    await bridge.ensureSessionProfile(
      'root-1',
      {
        parentID: undefined,
        agent: 'orchestrator',
        authoritative: true,
      },
      { profiles: PROFILES },
    );
    expect(getCalls).toHaveLength(0);
    expect(switchCalls).toHaveLength(0);
    // Root latched: the next admission is O(1) without a host read.
    await bridge.ensureSessionProfile(
      'root-1',
      {
        parentID: undefined,
        agent: 'orchestrator',
        authoritative: true,
      },
      { profiles: PROFILES },
    );
    expect(getCalls).toHaveLength(0);
  });

  test('event hints keep the enriching host re-read (no authoritative flag)', async () => {
    const { bridge, getCalls } = makeBridge({
      get: async () => ({ id: 'child-1', parentID: 'p', agent: 'explorer' }),
      profilesForSession: () => Promise.resolve(PROFILES),
    });
    await bridge.ensureSessionProfile('child-1', { parentID: 'p' });
    // agent was missing → host read filled it (unchanged historic path).
    expect(getCalls).toEqual([{ sessionID: 'child-1' }]);
  });

  test('model switch is fully awaited with the same fences', async () => {
    const captured: Array<string> = [];
    const failed: Array<string> = [];
    const { bridge, switchCalls } = makeBridge({
      switchModel: async () => {
        throw new Error('switch rejected');
      },
      onSessionCaptured: (id) => captured.push(id),
      onSessionCaptureFailed: (id) => failed.push(id),
    });
    await expect(
      bridge.ensureSessionProfile(
        'child-1',
        {
          parentID: 'p',
          agent: 'explorer',
          authoritative: true,
        },
        { profiles: PROFILES },
      ),
    ).rejects.toThrow('switch rejected');
    // The admission-failed fence fired; the capture pin was released.
    expect(failed).toEqual(['child-1']);
    expect(switchCalls).toHaveLength(1);
    // Not captured: a retry re-awaits the idempotent switch.
    expect(bridge.size()).toBe(0);
  });

  test('capture profiles are used as-is; per-call models still preserved', async () => {
    const { bridge, switchCalls } = makeBridge({
      registeredProfiles: PROFILES,
    });
    // A per-call model on the authoritative identity: no switch, but the
    // captured profile is still frozen.
    await bridge.ensureSessionProfile(
      'child-1',
      {
        parentID: 'p',
        agent: 'explorer',
        model: { providerID: 'openai', id: 'other', variant: 'x' },
        authoritative: true,
      },
      { profiles: PROFILES },
    );
    expect(switchCalls).toHaveLength(0);
    expect(bridge.profileForSession('child-1')).toEqual(PROFILES.explorer);
  });
});
