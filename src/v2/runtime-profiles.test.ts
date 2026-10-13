import { describe, expect, test } from 'bun:test';
import {
  applyRuntimeProfileOptions,
  createSessionProfileBridge,
  reconcileRuntimeProfileOptionKeys,
  resolveV2EventPayload,
} from './runtime-profiles';
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
