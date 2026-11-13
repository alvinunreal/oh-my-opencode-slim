/** Focused tests for bounded root creation and one-admission read reuse.

Scope: the admission transaction returns `{record, identity}` from ONE
host identity read + ONE KV lookup; the fences that make the preset
service trustworthy (id+directory+parent identity on every admission,
serial transactions, write/abort/dispose fences) stay load-bearing.
These tests do NOT build the whole v1 plugin.
*/
import { describe, expect, mock, test } from 'bun:test';
import { sessionPresetRpc } from './preset-rpc';
import type { SessionPresetRecord, SessionTeamBundle } from './session-presets';
import { createSessionPresets } from './session-presets';

const DIRECTORY = '/project';

const BUNDLE: SessionTeamBundle = {
  presetName: 'default',
  fallbackEnabled: true,
  profiles: {
    explorer: { sidebarModel: 'openai/gpt-5-mini' },
  },
  chains: {},
  inheritance: {},
};

function makeHarness(options?: {
  directory?: string;
  named?: (name: string) => Promise<SessionTeamBundle>;
  current?: () => SessionTeamBundle;
}) {
  const storage = new Map<string, unknown>();
  const getCalls: Array<unknown> = [];
  const log: Array<'identity' | 'kv-read' | 'kv-write'> = [];
  let getResponse: unknown;
  const get = async (input: { sessionID: string }) => {
    getCalls.push(input);
    log.push('identity');
    return getResponse;
  };
  const session = {
    get,
    create: mock(async (_input: unknown) => ({ id: 'new-root' })),
    prompt: mock(async () => {}),
    switchModel: mock(async () => {}),
    switchAgent: mock(async () => {}),
  };
  const backend = {
    get: async (key: string) => {
      log.push('kv-read');
      return storage.get(key);
    },
    set: async (key: string, value: unknown) => {
      log.push('kv-write');
      storage.set(key, value);
    },
    remove: async (key: string) => {
      log.push('kv-write');
      storage.delete(key);
    },
    scan: async () => ({ entries: [] }),
  };
  const location = { directory: DIRECTORY, workspaceID: 'workspace-original' };
  const presets = createSessionPresets({
    storage: backend,
    session,
    directory: options?.directory ?? DIRECTORY,
    location,
    current: options?.current ?? (() => BUNDLE),
    named: options?.named ?? (async () => BUNDLE),
  });
  return {
    presets,
    storage,
    backend,
    session,
    location,
    getCalls,
    log,
    setGetResponse: (response: unknown) => {
      getResponse = response;
    },
  };
}

function storageKey(id: string) {
  return `session-preset/v1/${id}`;
}

describe('createBound', () => {
  test('captures the named team once before native creation and returns only after binding', async () => {
    const selected = structuredClone(BUNDLE);
    const named = mock(async () => selected);
    const h = makeHarness({ named });
    const writing = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const set = h.backend.set;
    h.backend.set = async (key, value) => {
      writing.resolve();
      await commit.promise;
      await set(key, value);
    };
    h.session.create.mockImplementation(async () => {
      expect(named).toHaveBeenCalledTimes(1);
      selected.profiles.explorer.sidebarModel = 'edited/after-selection';
      return { id: 'new-root' };
    });
    // Location is captured from the trusted plugin context, not mutable UI state.
    h.location.directory = '/changed';
    h.location.workspaceID = 'workspace-changed';
    let returned = false;
    const creating = h.presets.createBound('default').then((state) => {
      returned = true;
      return state;
    });
    await writing.promise;
    expect(returned).toBe(false);
    expect(h.storage.size).toBe(0);
    commit.resolve();
    const state = await creating;
    expect(sessionPresetRpc.methods.createBound.output.parse(state)).toEqual(
      state,
    );
    expect(state).toMatchObject({
      sessionID: 'new-root',
      status: 'bound',
      presetName: 'default',
      affects: 'future-children-only',
      team: { agentModels: { explorer: 'openai/gpt-5-mini' } },
    });
    expect(h.storage.get(storageKey('new-root'))).toEqual({
      schemaVersion: 1,
      bundle: BUNDLE,
      selection: 'explicit',
    });
    expect(named).toHaveBeenCalledTimes(1);
    expect(named).toHaveBeenCalledWith('default');
    expect(h.session.create).toHaveBeenCalledTimes(1);
    expect(h.session.create).toHaveBeenCalledWith({
      location: { directory: DIRECTORY, workspaceID: 'workspace-original' },
    });
    expect(h.session.prompt).not.toHaveBeenCalled();
    expect(h.session.switchModel).not.toHaveBeenCalled();
    expect(h.session.switchAgent).not.toHaveBeenCalled();
  });

  test('post-create binding failure retains the ID and cause and allows existing Apply recovery', async () => {
    const h = makeHarness();
    const failure = new Error('KV write failed');
    const set = h.backend.set;
    h.backend.set = async () => {
      throw failure;
    };
    const error = await h.presets
      .createBound('default')
      .catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Created session new-root');
    expect(error.message).toContain('use Apply');
    expect(error.cause).toBe(failure);
    expect(h.session.create).toHaveBeenCalledTimes(1);
    expect(h.session.prompt).not.toHaveBeenCalled();
    expect(h.storage.size).toBe(0);
    h.setGetResponse({ id: 'new-root', location: { directory: DIRECTORY } });
    expect((await h.presets.readState('new-root')).status).toBe('unbound');
    h.backend.set = set;
    expect((await h.presets.apply('new-root', 'default')).status).toBe('bound');
    expect(h.session.create).toHaveBeenCalledTimes(1);
  });

  test('rejects unknown presets before creating and accepts only a preset name at the RPC boundary', async () => {
    const h = makeHarness({
      named: async () => {
        throw new Error('Unknown preset: missing');
      },
    });
    await expect(h.presets.createBound('missing')).rejects.toThrow(
      'Unknown preset: missing',
    );
    expect(h.session.create).not.toHaveBeenCalled();
    const input = sessionPresetRpc.methods.createBound.input;
    expect(input.parse({ presetName: 'default' })).toEqual({
      presetName: 'default',
    });
    expect(input.safeParse({ presetName: '' }).success).toBe(false);
    expect(
      input.safeParse({ presetName: 'default', sessionID: 'old-root' }).success,
    ).toBe(false);
    expect(
      input.safeParse({ presetName: 'default', location: { directory: '/' } })
        .success,
    ).toBe(false);
  });
});

describe('ensureAdmission', () => {
  test('returns record + precise identity from one identity read and one KV lookup', async () => {
    const h = makeHarness();
    h.setGetResponse({
      data: {
        id: 'root-1',
        agent: 'orchestrator',
        parentID: undefined,
        model: { providerID: 'openai', id: 'gpt-5' },
        location: { directory: DIRECTORY },
      },
    });
    const admission = await h.presets.ensureAdmission('root-1');
    expect(admission).toBeDefined();
    expect(admission?.record?.bundle.presetName).toBe('default');
    expect(admission?.record?.parentID).toBeUndefined();
    expect(admission?.identity).toEqual({
      agent: 'orchestrator',
      model: { providerID: 'openai', id: 'gpt-5' },
      authoritative: true,
    });
    // ONE host identity read and ONE KV lookup for the whole admission.
    expect(h.getCalls).toEqual([{ sessionID: 'root-1' }]);
    expect([...h.storage.keys()]).toEqual([storageKey('root-1')]);
  });

  test('identity is absent fields parsed precisely, not the raw info object', async () => {
    const h = makeHarness();
    h.setGetResponse({
      data: {
        id: 'child-1',
        parentID: 'root-1',
        // No agent, no model: precise identity carries neither.
        location: { directory: DIRECTORY },
      },
    });
    const admission = await h.presets.ensureAdmission('child-1');
    expect(admission?.record).toBeUndefined();
    expect(admission?.identity).toEqual({
      parentID: 'root-1',
      authoritative: true,
    });
    expect(h.getCalls).toHaveLength(1);
  });

  test('next admission revalidates directory and identity', async () => {
    const h = makeHarness();
    const info = {
      data: {
        id: 'root-2',
        location: { directory: DIRECTORY },
      },
    };
    h.setGetResponse(info);
    await h.presets.ensureAdmission('root-2');
    expect(h.getCalls).toHaveLength(1);

    // Second admission re-reads host identity (directory guard) and KV.
    await h.presets.ensureAdmission('root-2');
    expect(h.getCalls).toHaveLength(2);

    // Directory mismatch is still fatal.
    h.setGetResponse({
      data: { id: 'root-2', location: { directory: '/elsewhere' } },
    });
    await expect(h.presets.ensureAdmission('root-2')).rejects.toThrow(
      'Session preset session/location mismatch',
    );
  });

  test('aborts and retries keep the fences', async () => {
    const h = makeHarness();
    h.setGetResponse({
      data: { id: 'root-3', location: { directory: DIRECTORY } },
    });
    const controller = new AbortController();
    controller.abort();
    // Aborted before the transaction starts: nothing is read or written.
    await expect(
      h.presets.ensureAdmission('root-3', controller.signal),
    ).rejects.toThrow();
    expect(h.getCalls).toHaveLength(0);
    expect(h.storage.size).toBe(0);
    // Retry after abort still captures (transaction runs fully).
    const admission = await h.presets.ensureAdmission('root-3');
    expect(admission?.record).toBeDefined();
    expect(h.getCalls).toHaveLength(1);
  });

  test('concurrent admissions serialize on the binding transaction', async () => {
    const h = makeHarness();
    let resolveGet: (value: unknown) => void = () => {};
    h.setGetResponse(
      new Promise((resolve) => {
        resolveGet = resolve;
      }),
    );
    const first = h.presets.ensureAdmission('root-4');
    // A second concurrent admission chains on the pending transaction;
    // its effects only start after the first completes (serial fence).
    const second = h.presets.ensureAdmission('root-4');
    resolveGet({ data: { id: 'root-4', location: { directory: DIRECTORY } } });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    // Two full transactions, strictly non-interleaved: identity → KV,
    // then identity → KV again (never identity, identity, KV, KV).
    expect(h.log).toEqual([
      'identity',
      'kv-read',
      'kv-write',
      'identity',
      'kv-read',
    ]);
  });

  test('write path (explicit model) still runs inside the admission transaction', async () => {
    const h = makeHarness();
    h.storage.set(storageKey('child-1'), {
      schemaVersion: 1,
      parentID: 'root-1',
      bundle: BUNDLE,
    });
    h.setGetResponse({
      data: {
        id: 'child-1',
        parentID: 'root-1',
        location: { directory: DIRECTORY },
      },
    });
    const admission = await h.presets.ensureAdmission(
      'child-1',
      undefined,
      true,
    );
    expect(admission?.record?.explicitModel).toBe(true);
    expect(admission?.record?.preserveModel).toBe(true);
    expect(admission?.record?.parentID).toBe('root-1');
  });

  test('a continuation the host does not know reports absence, not a failure', async () => {
    const h = makeHarness();
    // The host's tagged not-found carries an EMPTY message; surfacing it as
    // the tool rejection is the empty "tool.execution" error this guards.
    const notFound = Object.assign(new Error(''), {
      _tag: 'Session.NotFoundError',
      sessionID: 'ses_unused',
    });
    h.setGetResponse(Promise.reject(notFound));
    // Absent identity, so the caller keeps its own agent and the host's own
    // lookup owns the refusal wording.
    expect(await h.presets.ensureAdmission('ses_unused')).toBeUndefined();
    expect([...h.storage.keys()]).toEqual([]);
  });

  test('a continuation read that fails for another reason still rejects', async () => {
    const h = makeHarness();
    h.setGetResponse(
      Promise.reject(
        Object.assign(new Error('host unavailable'), { _tag: 'Host.Timeout' }),
      ),
    );
    await expect(h.presets.ensureAdmission('ses_child')).rejects.toThrow(
      'host unavailable',
    );
  });

  test('a snapshot/model re-pin for an unknown continuation stays absent instead of failing', async () => {
    const h = makeHarness();
    const notFound = Object.assign(new Error(''), {
      _tag: 'Session.NotFoundError',
      sessionID: 'ses_unused',
    });
    h.setGetResponse(Promise.reject(notFound));
    expect(await h.presets.ensure('ses_unused')).toBeUndefined();
    expect([...h.storage.keys()]).toEqual([]);
  });

  test('parent identity mismatch still rejects inside an admission', async () => {
    const h = makeHarness();
    h.storage.set(storageKey('child-2'), {
      schemaVersion: 1,
      parentID: 'root-a',
      bundle: BUNDLE,
    });
    h.setGetResponse({
      data: {
        id: 'child-2',
        parentID: 'root-b',
        location: { directory: DIRECTORY },
      },
    });
    await expect(h.presets.ensureAdmission('child-2')).rejects.toThrow(
      'Session preset parent identity mismatch',
    );
  });

  test('strict bindChild rejects an unknown child with the host not-found', async () => {
    const h = makeHarness();
    h.setGetResponse(
      Promise.reject(
        Object.assign(new Error(''), {
          _tag: 'Session.NotFoundError',
          sessionID: 'ses_unused',
        }),
      ),
    );
    // bindChild is strict: the parent link is verified, never inferred.
    await expect(
      h.presets.bindChild('ses_unused', 'root-1', BUNDLE),
    ).rejects.toMatchObject({ _tag: 'Session.NotFoundError' });
    expect([...h.storage.keys()]).toEqual([]);
  });
});

describe('reset', () => {
  test('binds an unnamed effective default and keeps it bound through the next ensure', async () => {
    const unnamed = { ...BUNDLE, presetName: null };
    const h = makeHarness({ current: () => unnamed });
    h.setGetResponse({
      data: { id: 'root-default', location: { directory: DIRECTORY } },
    });
    const state = await h.presets.reset('root-default');
    expect(state).toEqual({
      sessionID: 'root-default',
      status: 'bound',
      presetName: null,
      selection: 'default',
      affects: 'future-children-only',
      team: {
        agentModels: { explorer: 'openai/gpt-5-mini' },
        agentVariants: {},
        inheritance: {},
      },
    });
    expect(sessionPresetRpc.methods.read.output.parse(state)).toEqual(state);
    expect(sessionPresetRpc.methods.unbind.output.parse(state)).toEqual(state);
    expect(h.storage.get(storageKey('root-default'))).toEqual({
      schemaVersion: 1,
      bundle: unnamed,
      selection: 'default',
    });
    // The next admission must not rewrite the default provenance or the
    // captured bundle that was present when the user turned the team off.
    const record = await h.presets.ensure('root-default');
    expect(record?.selection).toBe('default');
    expect(record?.bundle).toEqual(unnamed);
  });

  test('serializes reset and apply so the last operation wins', async () => {
    const next = { ...BUNDLE, presetName: 'next' };
    const h = makeHarness({ named: async () => next });
    h.setGetResponse({
      data: { id: 'root-on', location: { directory: DIRECTORY } },
    });
    const [resetState, applyState] = await Promise.all([
      h.presets.reset('root-on'),
      h.presets.apply('root-on', 'next'),
    ]);
    expect(resetState.selection).toBe('default');
    expect(applyState).toMatchObject({
      status: 'bound',
      presetName: 'next',
      selection: 'explicit',
    });
    expect(h.log).toEqual([
      'identity',
      'kv-read',
      'kv-write',
      'identity',
      'kv-read',
      'kv-write',
    ]);
    expect((await h.presets.readState('root-on')).selection).toBe('explicit');

    h.setGetResponse({
      data: { id: 'root-off', location: { directory: DIRECTORY } },
    });
    await Promise.all([
      h.presets.apply('root-off', 'next'),
      h.presets.reset('root-off'),
    ]);
    const final = await h.presets.readState('root-off');
    expect(final.presetName).toBe('default');
    expect(final.selection).toBe('default');
  });

  test('rejects a parent identity mismatch before writing', async () => {
    const h = makeHarness();
    const previous = {
      schemaVersion: 1,
      parentID: 'root-a',
      bundle: BUNDLE,
    };
    h.storage.set(storageKey('child'), previous);
    h.setGetResponse({
      data: {
        id: 'child',
        parentID: 'root-b',
        location: { directory: DIRECTORY },
      },
    });
    await expect(h.presets.reset('child')).rejects.toThrow(
      'Session preset parent identity mismatch',
    );
    expect(h.log).toEqual(['identity', 'kv-read']);
    expect(h.storage.get(storageKey('child'))).toEqual(previous);
  });

  test('keeps a native child with no snapshot unbound without inventing one', async () => {
    const h = makeHarness();
    h.setGetResponse({
      data: {
        id: 'native-child',
        parentID: 'root',
        location: { directory: DIRECTORY },
      },
    });
    expect(await h.presets.reset('native-child')).toEqual({
      sessionID: 'native-child',
      status: 'unbound',
      presetName: null,
      affects: 'future-children-only',
    });
    expect(h.storage.size).toBe(0);
    expect(h.log).toEqual(['identity', 'kv-read']);
  });

  test('child reset preserves its execution and model flags, then Apply rebinds explicitly', async () => {
    const next = { ...BUNDLE, presetName: 'next' };
    const h = makeHarness({ named: async () => next });
    const execution = { ...BUNDLE, presetName: 'frozen-A' };
    h.storage.set(storageKey('child'), {
      schemaVersion: 1,
      parentID: 'root',
      bundle: { ...BUNDLE, presetName: 'A' },
      execution,
      preserveModel: true,
      explicitModel: true,
      inheritedProviderID: 'openai',
    });
    h.setGetResponse({
      data: {
        id: 'child',
        parentID: 'root',
        location: { directory: DIRECTORY },
      },
    });
    const state = await h.presets.reset('child');
    expect(state).toMatchObject({
      sessionID: 'child',
      status: 'bound',
      presetName: 'default',
      selection: 'default',
    });
    expect(h.storage.get(storageKey('child'))).toEqual({
      schemaVersion: 1,
      parentID: 'root',
      bundle: BUNDLE,
      execution,
      preserveModel: true,
      explicitModel: true,
      inheritedProviderID: 'openai',
      selection: 'default',
    });
    expect(await h.presets.apply('child', 'next')).toMatchObject({
      sessionID: 'child',
      status: 'bound',
      presetName: 'next',
      selection: 'explicit',
    });
    expect(h.storage.get(storageKey('child'))).toMatchObject({
      parentID: 'root',
      execution,
      preserveModel: true,
      explicitModel: true,
      inheritedProviderID: 'openai',
      selection: 'explicit',
    });
  });

  test('aborts before touching identity or storage and retries cleanly', async () => {
    const h = makeHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(h.presets.reset('root', controller.signal)).rejects.toThrow();
    expect(h.getCalls).toHaveLength(0);
    expect(h.storage.size).toBe(0);
    h.setGetResponse({
      data: { id: 'root', location: { directory: DIRECTORY } },
    });
    expect((await h.presets.reset('root')).status).toBe('bound');
    expect(h.getCalls).toHaveLength(1);
  });

  test('legacy records without selection read as explicit without an eager rewrite', async () => {
    const legacy = { ...BUNDLE, presetName: 'A' };
    const h = makeHarness();
    h.storage.set(storageKey('root'), {
      schemaVersion: 1,
      bundle: legacy,
    });
    h.setGetResponse({
      data: { id: 'root', location: { directory: DIRECTORY } },
    });
    const state = await h.presets.readState('root');
    expect(state.selection).toBeUndefined();
    expect(sessionPresetRpc.methods.read.output.parse(state)).toEqual(state);
    const record = await h.presets.ensure('root');
    expect(record?.selection).toBeUndefined();
    expect(record?.bundle).toEqual(legacy);
    expect(h.storage.get(storageKey('root'))).toEqual({
      schemaVersion: 1,
      bundle: legacy,
    });
  });

  test('bindChild carries default provenance and keeps absent legacy selection explicit', async () => {
    const h = makeHarness();
    h.setGetResponse({
      data: {
        id: 'child',
        parentID: 'root',
        location: { directory: DIRECTORY },
      },
    });
    await h.presets.bindChild('child', 'root', BUNDLE, undefined, {
      selection: 'default',
    });
    expect(h.storage.get(storageKey('child'))).toMatchObject({
      parentID: 'root',
      selection: 'default',
    });
    h.storage.delete(storageKey('child'));
    await h.presets.bindChild('child', 'root', BUNDLE);
    expect(h.storage.get(storageKey('child'))).toMatchObject({
      parentID: 'root',
      selection: 'explicit',
    });
  });
});

describe('adoptExecution', () => {
  const futureBundle = { ...BUNDLE, presetName: 'newer-future' };
  const previousExecution = { ...BUNDLE, presetName: 'previous-execution' };
  const adoptedBundle = { ...BUNDLE, presetName: 'adopted-bundle' };
  const adoptedExecution = { ...BUNDLE, presetName: 'adopted-execution' };

  function existingRecord(
    selection: 'explicit' | 'default',
  ): SessionPresetRecord {
    return {
      schemaVersion: 1,
      parentID: 'root',
      bundle: futureBundle,
      execution: previousExecution,
      preserveModel: false,
      explicitModel: false,
      selection,
    };
  }

  function adoptedRecord(): SessionPresetRecord {
    return {
      schemaVersion: 1,
      parentID: 'root',
      bundle: adoptedBundle,
      execution: adoptedExecution,
      preserveModel: true,
      explicitModel: true,
      inheritedProviderID: 'openai',
      selection: 'explicit',
    };
  }

  for (const selection of ['default', 'explicit'] as const) {
    test(`persists the new execution while keeping the newer ${selection} future bundle and selection`, async () => {
      const h = makeHarness();
      h.storage.set(storageKey('child'), existingRecord(selection));
      h.setGetResponse({
        data: {
          id: 'child',
          parentID: 'root',
          location: { directory: DIRECTORY },
        },
      });
      const result = await h.presets.adoptExecution('child', adoptedRecord());
      expect(result).toEqual({
        schemaVersion: 1,
        parentID: 'root',
        bundle: futureBundle,
        execution: adoptedExecution,
        preserveModel: true,
        explicitModel: true,
        inheritedProviderID: 'openai',
        selection,
      });
      expect(h.storage.get(storageKey('child'))).toEqual(result);
      expect(h.log).toEqual(['identity', 'kv-read', 'kv-write']);
    });
  }

  test('propagates a storage write failure instead of returning the existing record', async () => {
    const h = makeHarness();
    h.storage.set(storageKey('child'), existingRecord('default'));
    h.setGetResponse({
      data: {
        id: 'child',
        parentID: 'root',
        location: { directory: DIRECTORY },
      },
    });
    const set = h.backend.set;
    h.backend.set = async (key, value) => {
      if (key === storageKey('child')) throw new Error('snapshot write failed');
      await set(key, value);
    };
    await expect(
      h.presets.adoptExecution('child', adoptedRecord()),
    ).rejects.toThrow('snapshot write failed');
  });
});
