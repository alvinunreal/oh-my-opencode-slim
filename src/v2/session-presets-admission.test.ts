import { describe, expect, test } from 'bun:test';
import { createSessionProfileBridge } from './runtime-profiles';
import {
  createSessionPresets,
  type SessionTeamBundle,
  wrapSessionPresetSubagent,
} from './session-presets';
import type { ModelRef } from './types';

const bundle = (name: string): SessionTeamBundle => ({
  presetName: name,
  fallbackEnabled: true,
  profiles: {
    explorer: {
      model: { providerID: 'test', id: name },
      temperature: name === 'A' ? 0.1 : 0.8,
      providerOptions: { reasoning: name },
      sidebarModel: `test/${name}`,
    },
  },
  chains: { explorer: [{ id: `test/${name}` }, { id: `backup/${name}` }] },
  inheritance: {},
});

function storageFixture() {
  const values = new Map<string, any>();
  let writes = 0;
  return {
    values,
    writes: () => writes,
    storage: {
      get: async (key: string) => structuredClone(values.get(key)),
      set: async (key: string, value: unknown) => {
        writes++;
        values.set(key, structuredClone(value));
      },
      remove: async (key: string) => {
        values.delete(key);
      },
    },
  };
}

async function managedFixture() {
  const f = storageFixture();
  const info = {
    id: 'child',
    parentID: 'root',
    agent: 'explorer',
    directory: '/project',
    model: { providerID: 'test', id: 'A' } as ModelRef,
  };
  let switches = 0;
  let installs = 0;
  let fallback = bundle('A').chains;
  const session = {
    get: async () => structuredClone(info),
    switchModel: async ({ model }: { model: ModelRef }) => {
      switches++;
      info.model = model;
    },
  };
  const presets = createSessionPresets({
    storage: f.storage,
    session: session as never,
    directory: '/project',
    current: () => bundle('A'),
    named: async (name) => bundle(name),
  });
  const profiles = createSessionProfileBridge({
    session: session as never,
    profiles: () => bundle('A').profiles,
    pluginAgents: new Set(['explorer']),
  });
  await presets.bindChild('child', 'root', bundle('A'));
  await profiles.installSessionProfile(
    'child',
    bundle('A').profiles.explorer,
    0,
  );
  presets.setExecution({
    assertIdle: (id) => profiles.assertIdle(id),
    install: async (id, record, agent) => {
      installs++;
      await profiles.installSessionProfile(
        id,
        record.bundle.profiles[agent],
        record.revision ?? 0,
        record.executionModel,
      );
      fallback = record.explicitModel ? {} : record.bundle.chains;
    },
  });
  return {
    ...f,
    info,
    presets,
    profiles,
    switches: () => switches,
    installs: () => installs,
    fallback: () => fallback,
    context: {
      sessionID: 'root',
      id: 'call',
      signal: new AbortController().signal,
      progress: async (_update: Record<string, unknown>) => {},
    },
    dispose: async () => {
      await presets.dispose();
      profiles.retire();
      await profiles.drain();
    },
  };
}

test('saved team display retains inherited sidebar variants without rewriting the bundle', async () => {
  const f = storageFixture();
  const saved: SessionTeamBundle = {
    ...bundle('A'),
    profiles: {
      explorer: { sidebarModel: 'Inherits session', sidebarVariant: 'medium' },
      fixer: { sidebarModel: 'Inherits orchestrator', sidebarVariant: 'low' },
      oracle: {
        model: { providerID: 'test', id: 'A', variant: 'high' },
        sidebarModel: 'test/A',
      },
    },
    inheritance: { explorer: 'session', fixer: 'orchestrator' },
  };
  const before = structuredClone(saved);
  const presets = createSessionPresets({
    storage: f.storage,
    session: {
      get: async () => ({ id: 'root', directory: '/project' }),
    } as never,
    directory: '/project',
    current: () => saved,
    named: async () => saved,
  });
  try {
    await presets.ensure('root');
    const storedBefore = structuredClone(f.values);
    const writes = f.writes();
    expect((await presets.readState('root')).team).toEqual({
      agentModels: { oracle: 'test/A' },
      agentVariants: { explorer: 'medium', fixer: 'low', oracle: 'high' },
      inheritance: saved.inheritance,
    });
    expect(saved).toEqual(before);
    expect(f.values).toEqual(storedBefore);
    expect(f.writes()).toBe(writes);
  } finally {
    await presets.dispose();
  }
});

describe('authorized managed resume boundary', () => {
  test('native automatic model resolves without a persisted selection at revision zero and after options-only transition', async () => {
    const f = storageFixture();
    const automatic = {
      ...bundle('auto'),
      profiles: { explorer: { sidebarModel: 'default', temperature: 0.2 } },
      chains: {},
    };
    let hostModel: unknown;
    const presets = createSessionPresets({
      storage: f.storage,
      directory: '/project',
      current: () => automatic,
      named: async () => automatic,
      session: {
        get: async () => ({
          id: 'child',
          parentID: 'root',
          agent: 'explorer',
          directory: '/project',
          ...(hostModel === undefined ? {} : { model: hostModel }),
        }),
      } as never,
    });
    const actual = { providerID: 'native', id: 'resolved-default' };
    presets.setExecution({ assertIdle: () => {}, install: async () => {} });
    try {
      await presets.bindChild('child', 'root', automatic);
      await presets.assertRequestSelection('child', actual, 0);
      hostModel = null;
      await presets.assertRequestSelection('child', actual, 0);
      hostModel = undefined;
      await presets.resumeChild(
        'child',
        'root',
        {
          bundle: {
            ...automatic,
            profiles: {
              explorer: { sidebarModel: 'default', temperature: 0.7 },
            },
          },
          explicitModel: false,
        },
        'explorer',
      );
      await presets.assertRequestSelection('child', actual, 1);
      await expect(
        presets.assertRequestSelection('child', actual, 0),
      ).rejects.toThrow('revision mismatch');
      for (const malformed of [
        {},
        { providerID: 'native' },
        { id: 'resolved-default' },
        { ...actual, variant: '' },
      ]) {
        await expect(
          presets.assertRequestSelection('child', malformed as ModelRef, 1),
        ).rejects.toThrow('model/variant mismatch');
      }
      for (const malformed of [
        {},
        { providerID: 'native' },
        { id: 'resolved-default' },
      ]) {
        hostModel = malformed;
        await expect(
          presets.assertRequestSelection('child', actual, 1),
        ).rejects.toThrow('model/variant mismatch');
      }
      hostModel = { ...actual, variant: 'high' };
      await expect(
        presets.assertRequestSelection('child', actual, 1),
      ).rejects.toThrow('model/variant mismatch');
      await presets.assertRequestSelection(
        'child',
        { ...actual, variant: 'high' },
        1,
      );
      hostModel = undefined;
      for (const policy of [
        { explicitModel: true },
        { executionModel: actual },
        { inheritedProviderID: 'native' },
        { bundle: bundle('explicit-preset') },
        { bundle: { ...automatic, inheritance: { explorer: 'session' } } },
        {
          bundle: {
            ...automatic,
            chains: { explorer: [{ id: 'native/explicit-chain' }] },
          },
        },
      ]) {
        const record = f.values.get('session-preset/v1/child');
        f.values.set('session-preset/v1/child', { ...record, ...policy });
        await presets.admit('child');
        await expect(
          presets.assertRequestSelection('child', actual, 1),
        ).rejects.toThrow('model/variant mismatch');
        f.values.set('session-preset/v1/child', record);
      }
    } finally {
      await presets.dispose();
    }
  });

  test.each(['cancel', 'retire'])(
    'authorization wait followed by %s never reaches installation or prompt',
    async (action) => {
      const f = await managedFixture();
      const before = structuredClone([...f.values]);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const controller = new AbortController();
      let prompts = 0;
      const execute = wrapSessionPresetSubagent({
        presets: f.presets,
        capture: async () => ({ bundle: bundle('B'), explicitModel: false }),
        execute: async (_args, raw) => {
          entered.resolve();
          await release.promise;
          await (
            raw as { progress: (value: unknown) => Promise<void> }
          ).progress({ sessionID: 'child' });
          prompts++;
        },
      });
      const outcome = execute(
        { sessionID: 'child', agent: 'explorer' },
        {
          ...f.context,
          signal: controller.signal,
        },
      ).catch((error: Error) => error);
      try {
        await entered.promise;
        if (action === 'cancel')
          controller.abort(new Error('cancelled authorization'));
        else await f.presets.dispose();
        release.resolve();
        expect(String(await outcome)).toContain(
          action === 'cancel' ? 'cancelled authorization' : 'retired',
        );
        expect([...f.values]).toEqual(before);
        expect(f.installs()).toBe(0);
        expect(f.switches()).toBe(0);
        expect(prompts).toBe(0);
      } finally {
        release.resolve();
        await outcome;
        await f.dispose();
      }
    },
  );

  test('native denial leaves KV, selection, profile and fallback untouched', async () => {
    const f = await managedFixture();
    const before = structuredClone([...f.values]);
    const failure = new Error('Subagent denied: explorer');
    let validations = 0;
    const input = { sessionID: 'child', agent: 'explorer', model: 'test/C' };
    const execute = wrapSessionPresetSubagent({
      presets: f.presets,
      capture: async () => ({ bundle: bundle('B'), explicitModel: true }),
      validateSelection: async () => {
        validations++;
      },
      execute: async (args) => {
        expect(args).toEqual({ sessionID: 'child', agent: 'explorer' });
        throw failure;
      },
    });
    try {
      expect(await execute(input, f.context).catch((error) => error)).toBe(
        failure,
      );
      expect(input.model).toBe('test/C');
      expect([...f.values]).toEqual(before);
      expect(f.info.model.id).toBe('A');
      expect(f.profiles.profileForSession('child')?.temperature).toBe(0.1);
      expect(f.fallback()).toEqual(bundle('A').chains);
      expect(f.installs()).toBe(0);
      expect(f.switches()).toBe(0);
      expect(validations).toBe(0);
    } finally {
      await f.dispose();
    }
  });

  test('duplicate awaited progress installs once; unchanged failure never borrows an old commit receipt', async () => {
    const f = await managedFixture();
    const failure = new Error('native prompt failed');
    let prompts = 0;
    const make = () =>
      wrapSessionPresetSubagent({
        presets: f.presets,
        capture: async () => ({ bundle: bundle('B'), explicitModel: false }),
        execute: async (_args, raw) => {
          const context = raw as typeof f.context;
          await Promise.all([
            context.progress({
              sessionID: 'child',
              status: 'running',
            }),
            context.progress({
              sessionID: 'child',
              status: 'running',
            }),
          ]);
          prompts++;
          throw failure;
        },
      });
    try {
      const first = await make()(
        { sessionID: 'child', agent: 'explorer' },
        f.context,
      ).catch((error) => error);
      expect(first.cause).toBe(failure);
      expect(first.message).toContain('configuration committed');
      expect(f.installs()).toBe(1);
      const record = await f.presets.ensure('child');
      expect(record?.revision).toBe(1);
      expect(record?.completedOperationID).toBeString();
      const unchanged = await make()(
        { sessionID: 'child', agent: 'explorer' },
        f.context,
      ).catch((error) => error);
      expect(unchanged).toBe(failure);
      expect(f.installs()).toBe(1);
      expect(prompts).toBe(2);
    } finally {
      await f.dispose();
    }
  });

  test('installation failure is memoized; retry uses frozen target without replaying native prompt', async () => {
    const f = await managedFixture();
    let attempts = 0;
    let nativeCalls = 0;
    let forwarded = 0;
    const failure = new Error('install failed');
    f.presets.setExecution({
      assertIdle: () => {},
      install: async () => {
        attempts++;
        throw failure;
      },
    });
    const execute = wrapSessionPresetSubagent({
      presets: f.presets,
      capture: async () => ({ bundle: bundle('B'), explicitModel: false }),
      execute: async (_args, raw) => {
        nativeCalls++;
        const context = raw as { progress: (value: unknown) => Promise<void> };
        const outcomes = await Promise.allSettled([
          context.progress({ sessionID: 'child' }),
          context.progress({ sessionID: 'child' }),
        ]);
        for (const outcome of outcomes) {
          expect(outcome).toMatchObject({
            status: 'rejected',
            reason: failure,
          });
        }
        throw failure;
      },
    });
    try {
      await expect(
        execute(
          { sessionID: 'child', agent: 'explorer' },
          {
            ...f.context,
            progress: async () => {
              forwarded++;
            },
          },
        ),
      ).rejects.toBe(failure);
      expect(attempts).toBe(1);
      expect(forwarded).toBe(0);
      const pending = (await f.presets.readState('child')).pending;
      f.presets.setExecution({
        assertIdle: () => {},
        install: async (_id, record) => {
          expect(record.bundle.presetName).toBe('B');
          expect(record.revision).toBe(1);
          attempts++;
        },
      });
      if (!pending) throw new Error('Expected frozen pending transition');
      await f.presets.retry('child', pending.operationID);
      expect(attempts).toBe(2);
      expect(nativeCalls).toBe(1);
    } finally {
      await f.dispose();
    }
  });

  test('boundary: concurrent manual agent change can still trigger native defaults before progress', async () => {
    const f = await managedFixture();
    let observedBeforeInstall: string | undefined;
    const execute = wrapSessionPresetSubagent({
      presets: f.presets,
      capture: async () => ({ bundle: bundle('B'), explicitModel: false }),
      execute: async (args, raw) => {
        expect(args).not.toHaveProperty('model');
        // Fixed native 2.1.4 contract: authorization can yield; its subsequent
        // get/switchAgent/switchModel occurs BEFORE awaited progress. There is
        // no public compare-and-switch token that lets this wrapper fence it.
        f.info.agent = 'manually-selected-agent';
        if (f.info.agent !== 'explorer') {
          f.info.agent = 'explorer';
          f.info.model = { providerID: 'native', id: 'agent-default' };
        }
        observedBeforeInstall = f.info.model.id;
        await (raw as { progress: (value: unknown) => Promise<void> }).progress(
          { sessionID: 'child' },
        );
      },
    });
    try {
      await execute({ sessionID: 'child', agent: 'explorer' }, f.context);
      expect(observedBeforeInstall).toBe('agent-default');
      expect(f.info.model.id).toBe('B');
    } finally {
      await f.dispose();
    }
  });
});

describe('bound creation context scope', () => {
  function fixture() {
    const f = storageFixture();
    const sessions = new Map<string, any>();
    const creates: any[] = [];
    let offline = false;
    const service = (workspaceID?: string, known = true) =>
      createSessionPresets({
        storage: f.storage,
        directory: '/project',
        ...(known
          ? {
              location: {
                directory: '/project',
                ...(workspaceID ? { workspaceID } : {}),
              },
            }
          : {}),
        current: () => bundle('A'),
        named: async (name) => bundle(name),
        agents: async () => [{ id: 'lead', mode: 'primary' }],
        session: {
          get: async ({ sessionID }: { sessionID: string }) => {
            const info = sessions.get(sessionID);
            if (!info) throw { _tag: 'Session.NotFoundError' };
            // PublicRef deliberately does not expose workspaceID.
            return {
              id: info.id,
              agent: info.agent,
              model: info.model,
              location: { directory: '/project' },
            };
          },
          create: async (input: any) => {
            if (offline) throw new Error('host unavailable');
            expect(input).not.toHaveProperty('location');
            creates.push(input);
            sessions.set(input.id, {
              ...input,
              workspaceID: workspaceID ?? null,
            });
          },
        } as never,
      });
    return {
      ...f,
      service,
      sessions,
      creates,
      offline: (value: boolean) => {
        offline = value;
      },
    };
  }
  const input = {
    sessionID: 'root',
    operationID: 'create-op',
    presetName: 'A',
    agent: 'lead',
    model: { providerID: 'test', id: 'selected' },
  };

  test.each([undefined, 'workspace-A'])(
    'new creation freezes explicit local/workspace scope: %s',
    async (workspaceID) => {
      const f = fixture();
      const service = f.service(workspaceID);
      try {
        await service.createBound(input);
        expect(f.sessions.get('root').workspaceID).toBe(workspaceID ?? null);
        expect(f.values.get('session-preset/v1/root').createdBy.scope).toEqual({
          directory: '/project',
          workspaceID: workspaceID ?? null,
        });
        expect(f.creates).toHaveLength(1);
      } finally {
        await service.dispose();
      }
    },
  );

  test('same-directory cross-context retries and completed fast paths reject; matching context recovers frozen creation', async () => {
    const f = fixture();
    const a = f.service('workspace-A');
    const b = f.service('workspace-B');
    const local = f.service();
    try {
      f.offline(true);
      await expect(a.createBound(input)).rejects.toThrow('host unavailable');
      const before = structuredClone([...f.values]);
      f.offline(false);
      for (const foreign of [b, local]) {
        await expect(foreign.retry('root', 'create-op')).rejects.toThrow(
          'scope mismatch',
        );
        await expect(foreign.createBound(input)).rejects.toThrow(
          'scope mismatch',
        );
        expect([...f.values]).toEqual(before);
        expect(f.creates).toHaveLength(0);
      }
      await a.retry('root', 'create-op');
      expect(f.sessions.get('root').workspaceID).toBe('workspace-A');
      await a.apply('root', 'B');
      expect((await a.createBound(input)).presetName).toBe('B');
      expect((await a.retry('root', 'create-op')).presetName).toBe('B');
      for (const foreign of [b, local]) {
        await expect(foreign.retry('root', 'create-op')).rejects.toThrow(
          'scope mismatch',
        );
        await expect(foreign.createBound(input)).rejects.toThrow(
          'scope mismatch',
        );
      }
      expect(f.creates).toHaveLength(1);
    } finally {
      await Promise.all([a.dispose(), b.dispose(), local.dispose()]);
    }
  });

  test('unknown old creation scope is never filled by retry; ordinary old binding reads and Apply survive', async () => {
    const f = fixture();
    const service = f.service('workspace-A');
    try {
      f.offline(true);
      await expect(service.createBound(input)).rejects.toThrow(
        'host unavailable',
      );
      const record = f.values.get('session-preset/v1/root');
      delete record.pending.input.scope;
      const before = structuredClone([...f.values]);
      f.offline(false);
      await expect(service.retry('root', 'create-op')).rejects.toThrow(
        'scope unknown',
      );
      await expect(service.createBound(input)).rejects.toThrow('scope unknown');
      expect([...f.values]).toEqual(before);
      expect(f.creates).toHaveLength(0);
      f.sessions.set('root', { id: 'root', agent: 'lead', model: input.model });
      f.values.set('session-preset/v1/root', {
        schemaVersion: 2,
        revision: 0,
        bundle: bundle('A'),
        createdBy: record.pending.input,
        completedOperationID: 'create-op',
      });
      expect((await service.readState('root')).status).toBe('bound');
      expect((await service.ensure('root'))?.bundle.presetName).toBe('A');
      expect((await service.apply('root', 'B')).presetName).toBe('B');
      await expect(service.retry('root', 'create-op')).rejects.toThrow(
        'scope unknown',
      );
      await expect(service.createBound(input)).rejects.toThrow('scope unknown');
    } finally {
      await service.dispose();
    }
  });

  test('missing authoritative ctx.location cannot authorize even a local creation', async () => {
    const f = fixture();
    const service = f.service(undefined, false);
    try {
      await expect(service.createBound(input)).rejects.toThrow(
        'scope unavailable',
      );
      expect(f.values.size).toBe(0);
      expect(f.creates).toHaveLength(0);
    } finally {
      await service.dispose();
    }
  });

  test('boundary: public get cannot detect a later same-directory workspace move', async () => {
    const f = fixture();
    const a = f.service('workspace-A');
    try {
      await a.createBound(input);
      f.sessions.get('root').workspaceID = 'workspace-B';
      // The credential authenticates the original creation context, not the
      // session's present workspace (which public get intentionally hides).
      expect((await a.retry('root', 'create-op')).status).toBe('bound');
      expect(f.creates).toHaveLength(1);
    } finally {
      await a.dispose();
    }
  });
});
