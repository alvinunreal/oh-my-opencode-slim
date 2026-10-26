import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { V2AgentRuntimeProfiles } from './runtime-profiles';
import type { ModelRef, V2Context } from './types';

const model = z
  .object({
    providerID: z.string().min(1),
    id: z.string().min(1),
    variant: z.string().optional(),
  })
  .strict();
const profile = z
  .object({
    model: model.optional(),
    temperature: z.number().finite().optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    managedProviderOptionKeys: z.array(z.string()).optional(),
    sidebarModel: z.string(),
    sidebarVariant: z.string().optional(),
  })
  .strict();
const bundleSchema = z
  .object({
    presetName: z.string().nullable(),
    fallbackEnabled: z.boolean(),
    profiles: z.record(z.string(), profile),
    chains: z.record(
      z.string(),
      z.array(
        z
          .object({
            id: z.string().min(1),
            variant: z.string().optional(),
          })
          .strict(),
      ),
    ),
    inheritance: z.record(z.string(), z.enum(['session', 'orchestrator'])),
  })
  .strict();
const stableSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    revision: z.number().int().nonnegative().optional(),
    parentID: z.string().optional(),
    bundle: bundleSchema,
    // Applying to a child changes its descendants, not its own inference.
    execution: bundleSchema.optional(),
    preserveModel: z.boolean().optional(),
    explicitModel: z.boolean().optional(),
    inheritedProviderID: z.string().min(1).optional(),
    executionModel: model.optional(),
  })
  .strict();
const creationScopeSchema = z
  .object({
    directory: z.string().min(1),
    // null is proven local; absent scope on old records means unknown.
    workspaceID: z.string().min(1).nullable(),
  })
  .strict();
const createInputSchema = z
  .object({
    directory: z.string().min(1),
    scope: creationScopeSchema.optional(),
    operationID: z.string().min(1),
    presetName: z.string().min(1),
    agent: z.string().min(1),
    model,
  })
  .strict();
const recordSchema = stableSchema
  .extend({
    pending: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('transition'),
            operationID: z.string().min(1),
            agent: z.string().min(1),
            target: stableSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal('createBound'),
            operationID: z.string().min(1),
            input: createInputSchema,
          })
          .strict(),
      ])
      .optional(),
    createdBy: createInputSchema.optional(),
    completedOperationID: z.string().optional(),
  })
  .strict();

export type SessionTeamBundle = Omit<
  z.infer<typeof bundleSchema>,
  'profiles'
> & {
  profiles: V2AgentRuntimeProfiles;
};
export type SessionPresetRecord = Omit<
  z.infer<typeof recordSchema>,
  'bundle' | 'execution'
> & {
  bundle: SessionTeamBundle;
  execution?: SessionTeamBundle;
};
export type SessionPresetState = {
  sessionID: string;
  status: 'bound' | 'unbound' | 'initializing' | 'transitioning';
  presetName: string | null;
  affects: 'future-delegations';
  team?: {
    agentModels: Record<string, string>;
    agentVariants: Record<string, string>;
    inheritance: Record<string, 'session' | 'orchestrator'>;
  };
  executionPresetName?: string | null;
  pending?: {
    kind: 'createBound' | 'transition';
    operationID: string;
    presetName: string | null;
  };
};
/** Per-call execution intent is separate from the inherited team bundle. */
export type SessionTeamAdmission = {
  /** Null is an explicit compatibility admission, never a missing capture. */
  bundle: SessionTeamBundle | null;
  explicitModel: boolean;
  inheritedProviderID?: string;
  resolvedModel?: ModelRef;
};

export type SessionPresetExecution = {
  assertIdle: (id: string) => void;
  install: (
    id: string,
    record: SessionPresetRecord,
    agent: string,
  ) => Promise<void>;
};

export function sameSelection(actual: unknown, expected: ModelRef): boolean {
  if (!actual || typeof actual !== 'object') return false;
  const ref = actual as ModelRef;
  return (
    ref.providerID === expected.providerID &&
    ref.id === expected.id &&
    (ref.variant ?? 'default') === (expected.variant ?? 'default')
  );
}

export function delegationSelection(value: unknown): ModelRef | undefined {
  if (typeof value !== 'string') return undefined;
  const [selection, variant] = value.split('#');
  const slash = selection.indexOf('/');
  if (slash <= 0 || slash === selection.length - 1) return undefined;
  return {
    providerID: selection.slice(0, slash),
    id: selection.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

/** Public model.list and native subagent validation both read models.available.
 * Managed resumes validate here after native authorization; new/legacy calls
 * retain native validation. This lookup is not an availability lease. */
export function assertAvailableDelegationSelection(
  value: string,
  response: unknown,
): void {
  const selected = delegationSelection(value);
  if (
    !selected ||
    `${selected.providerID}/${selected.id}${selected.variant ? `#${selected.variant}` : ''}` !==
      value
  )
    throw new Error('Invalid explicit subagent model selection');
  const models =
    response && typeof response === 'object' && 'data' in response
      ? response.data
      : response;
  if (!Array.isArray(models))
    throw new Error('Explicit subagent model availability cannot be verified');
  const available = models.find(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      entry.providerID === selected.providerID &&
      entry.id === selected.id,
  );
  if (!available)
    throw new Error(`Explicit subagent model '${value}' is not available`);
  if (
    selected.variant &&
    (!Array.isArray(available.variants) ||
      !available.variants.some(
        (variant: unknown) =>
          variant &&
          typeof variant === 'object' &&
          'id' in variant &&
          variant.id === selected.variant,
      ))
  )
    throw new Error(
      `Explicit subagent variant '${selected.variant}' is not available for '${selected.providerID}/${selected.id}'`,
    );
}

function assertJSON(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertJSON(item);
    return;
  }
  if (
    typeof value === 'object' &&
    value &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    for (const item of Object.values(value)) assertJSON(item);
    return;
  }
  throw new Error('Session preset snapshot is not JSON');
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Host KV is authoritative. Locks cover only one binding transaction, never
 * native execution. Dispose drains writes before the next activation loads. */
export function createSessionPresets(options: {
  storage: V2Context['storage'];
  session: V2Context['session'];
  directory: string;
  location?: Pick<
    NonNullable<V2Context['location']>,
    'directory' | 'workspaceID'
  >;
  current: () => SessionTeamBundle;
  named: (name: string) => Promise<SessionTeamBundle>;
  agents?: () => Promise<unknown>;
}) {
  const cache = new Map<string, SessionPresetRecord>();
  const pending = new Map<string, Promise<unknown>>();
  const changing = new Set<string>();
  const writeEpochs = new Map<string, number>();
  let execution: SessionPresetExecution | undefined;
  const available =
    typeof options.storage?.get === 'function' &&
    typeof options.storage?.set === 'function' &&
    typeof options.storage?.remove === 'function' &&
    typeof options.session?.get === 'function';
  let retired = false;
  const key = (id: string) => `session-preset/v1/${id}`;
  const check = (signal?: AbortSignal) => {
    if (retired) throw new Error('Session preset generation retired');
    signal?.throwIfAborted();
  };
  const creationScope = () => {
    if (!options.location)
      throw new Error('Bound session creation scope unavailable');
    const scope = creationScopeSchema.parse({
      directory: path.resolve(options.location.directory),
      workspaceID: options.location.workspaceID ?? null,
    });
    if (scope.directory !== path.resolve(options.directory))
      throw new Error('Bound session creation scope mismatch');
    return scope;
  };
  const assertCreationScope = (input: z.infer<typeof createInputSchema>) => {
    if (!input.scope)
      throw new Error('Bound session creation scope unknown; cannot retry');
    if (
      input.directory !== input.scope.directory ||
      !isDeepStrictEqual(input.scope, creationScope())
    )
      throw new Error('Bound session creation scope mismatch');
  };
  const requireAvailable = () => {
    check();
    if (!available)
      throw new Error(
        'Session presets unavailable: host storage or identity API missing',
      );
  };
  const storage = () => {
    requireAvailable();
    const backend = options.storage;
    if (!backend) throw new Error('Session presets require ctx.storage');
    return backend;
  };
  async function serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    check();
    const task = (pending.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        check();
        return action();
      });
    pending.set(id, task);
    try {
      return await task;
    } finally {
      if (pending.get(id) === task) pending.delete(id);
    }
  }
  async function read(id: string): Promise<SessionPresetRecord | undefined> {
    check();
    try {
      const epoch = writeEpochs.get(id);
      const value = await storage().get(key(id));
      check();
      // A slow KV read must not overwrite a newer local commit's cache.
      if (writeEpochs.get(id) !== epoch) return read(id);
      if (value === undefined) {
        cache.delete(id);
        return undefined;
      }
      assertJSON(value);
      const record = freeze(
        recordSchema.parse(JSON.parse(JSON.stringify(value))),
      );
      cache.set(id, record);
      return record;
    } catch (error) {
      cache.delete(id);
      throw error;
    }
  }
  async function write(
    id: string,
    value: SessionPresetRecord,
    signal?: AbortSignal,
  ) {
    // Optional fields are omitted by construction; reject non-JSON provider data.
    assertJSON(value);
    const record = freeze(
      recordSchema.parse(JSON.parse(JSON.stringify(value))),
    );
    check(signal);
    writeEpochs.set(id, (writeEpochs.get(id) ?? 0) + 1);
    try {
      await storage().set(key(id), record);
    } catch (error) {
      // A backend may report an uncertain commit. Never retain a stale
      // last-good cache entry instead of consulting KV on the next attempt.
      cache.delete(id);
      throw error;
    } finally {
      writeEpochs.set(id, (writeEpochs.get(id) ?? 0) + 1);
    }
    // KV commit is authoritative even if cancellation arrived while awaiting
    // it. Still reject the caller/prompt, but do not serve the old cache.
    if (!retired) cache.set(id, record);
    check(signal);
    return record;
  }
  async function identity(id: string) {
    check();
    if (!id || typeof options.session?.get !== 'function') {
      throw new Error('Session preset identity unavailable');
    }
    const response = await options.session.get({ sessionID: id });
    check();
    const value = response as Record<string, unknown>;
    const info = (value?.data ?? value) as Record<string, unknown>;
    const location = info?.location as { directory?: string } | undefined;
    const directory = location?.directory ?? info?.directory;
    if (
      !info ||
      info.id !== id ||
      typeof directory !== 'string' ||
      path.resolve(directory) !== path.resolve(options.directory)
    ) {
      throw new Error('Session preset session/location mismatch');
    }
    return info;
  }
  function assertStable(id: string, record?: SessionPresetRecord) {
    check();
    if (changing.has(id) || record?.pending) {
      throw new Error(
        `Session preset pending for ${id}; retry operation ${record?.pending?.operationID ?? 'shown by read'}. No prompt was sent.`,
      );
    }
  }
  async function admit(id: string) {
    check();
    if (!available) return undefined;
    assertStable(id, cache.get(id));
    const record = await read(id);
    assertStable(id, record);
    return record;
  }
  async function ensure(id: string, signal?: AbortSignal) {
    check(signal);
    if (!available) return undefined;
    await admit(id);
    return serial(id, async () => {
      const info = await identity(id);
      check(signal);
      const existing = await read(id);
      assertStable(id, existing);
      const parentID =
        typeof info.parentID === 'string' ? info.parentID : undefined;
      if (existing) {
        if (existing.parentID !== parentID)
          throw new Error('Session preset parent identity mismatch');
        return existing;
      }
      if (parentID) {
        // Historical/host-created children have no proven launch snapshot.
        // Keep their native compatibility workflow; never infer a team from
        // the parent's *current* bundle after a create→bind interruption.
        return undefined;
      }
      // First admission of an old, unbound root is migration, not recovery
      // of historical settings. Capture now, not at its first delegation.
      return write(
        id,
        { schemaVersion: 2, revision: 0, bundle: options.current() },
        signal,
      );
    });
  }
  async function bindChild(
    id: string,
    parentID: string,
    bundle: SessionTeamBundle,
    signal?: AbortSignal,
    selection?: {
      preserveModel?: boolean;
      explicitModel?: boolean;
      inheritedProviderID?: string;
    },
  ) {
    requireAvailable();
    return serial(id, async () => {
      const info = await identity(id);
      if (info.parentID !== parentID)
        throw new Error('Subagent parent identity mismatch');
      const existing = await read(id);
      assertStable(id, existing);
      if (existing) {
        if (
          existing.parentID !== parentID ||
          !isDeepStrictEqual(existing.execution ?? existing.bundle, bundle)
        ) {
          throw new Error(
            'Subagent team binding conflicts with existing snapshot',
          );
        }
        check(signal);
        return existing;
      }
      return write(
        id,
        {
          schemaVersion: 2,
          revision: 0,
          parentID,
          bundle,
          ...(selection?.preserveModel ? { preserveModel: true } : {}),
          explicitModel: selection?.explicitModel === true,
          ...(selection?.inheritedProviderID
            ? { inheritedProviderID: selection.inheritedProviderID }
            : {}),
        },
        signal,
      );
    });
  }
  const state = (
    id: string,
    record?: SessionPresetRecord,
  ): SessionPresetState => ({
    sessionID: id,
    status: record?.pending
      ? record.pending.kind === 'createBound'
        ? 'initializing'
        : 'transitioning'
      : record
        ? 'bound'
        : 'unbound',
    presetName: record?.bundle.presetName ?? null,
    affects: 'future-delegations',
    ...(record
      ? {
          team: {
            agentModels: Object.fromEntries(
              Object.entries(record.bundle.profiles)
                .filter(([, profile]) => profile.model)
                .map(([agent, profile]) => [
                  agent,
                  `${profile.model?.providerID}/${profile.model?.id}`,
                ]),
            ),
            agentVariants: Object.fromEntries(
              Object.entries(record.bundle.profiles).flatMap(
                ([agent, profile]) => {
                  const variant =
                    profile.model?.variant ?? profile.sidebarVariant;
                  return variant === undefined ? [] : [[agent, variant]];
                },
              ),
            ),
            inheritance: { ...record.bundle.inheritance },
          },
          ...(record.parentID
            ? {
                executionPresetName: (record.execution ?? record.bundle)
                  .presetName,
              }
            : {}),
          ...(record.pending
            ? {
                pending: {
                  kind: record.pending.kind,
                  operationID: record.pending.operationID,
                  presetName:
                    record.pending.kind === 'transition'
                      ? record.pending.target.bundle.presetName
                      : record.bundle.presetName,
                },
              }
            : {}),
        }
      : {}),
  });
  async function complete(
    id: string,
    record: SessionPresetRecord,
    signal?: AbortSignal,
  ) {
    const operation = record.pending;
    if (!operation) return record;
    check(signal);
    if (operation.kind === 'transition') {
      if (!execution)
        throw new Error('Session preset execution publisher unavailable');
      // An unresolved native flight is known locally: reject retry before
      // awaiting another host identity lookup or occupying its serial queue.
      execution.assertIdle(id);
      const info = await identity(id);
      if (info.parentID !== record.parentID || info.agent !== operation.agent)
        throw new Error('Session preset transition identity mismatch');
      await execution.install(id, operation.target, operation.agent);
      check(signal);
      return write(
        id,
        {
          ...operation.target,
          ...(record.createdBy ? { createdBy: record.createdBy } : {}),
          completedOperationID: operation.operationID,
        },
        signal,
      );
    }
    const { input } = operation;
    assertCreationScope(input);
    const create = options.session.create;
    if (!create) throw new Error('Bound session creation unavailable');
    // Native create is idempotent by caller-supplied ID. On retry a created
    // session is verified, not recreated or silently replaced by another ID.
    const found = await lookup(id);
    check(signal);
    assertCreationScope(input);
    if (!found) {
      await create.call(options.session, {
        id,
        agent: input.agent,
        model: input.model,
        // Public create.location strips workspaceID. The frozen, verified
        // context scope above authorizes using the host's complete default.
      });
    }
    check(signal);
    const info = await identity(id);
    assertCreationScope(input);
    if (
      info.parentID ||
      info.agent !== input.agent ||
      !sameSelection(info.model, input.model)
    )
      throw new Error('Bound session initialization identity mismatch');
    const { pending: _pending, ...stable } = record;
    return write(
      id,
      {
        ...stable,
        createdBy: input,
        completedOperationID: operation.operationID,
      },
      signal,
    );
  }
  async function lookup(id: string): Promise<unknown> {
    try {
      return await options.session.get?.({ sessionID: id });
    } catch (error) {
      // Only a proven not-found is absence. Transport/auth failures must not
      // authorize creation of a possibly existing session.
      const value = error as { _tag?: string; name?: string };
      if (
        value?._tag === 'Session.NotFoundError' ||
        value?.name === 'Session.NotFoundError'
      )
        return undefined;
      throw error;
    }
  }
  async function resumeRecord(
    id: string,
    parentID: string,
    admission: SessionTeamAdmission,
    agent: string,
  ) {
    const info = await identity(id);
    if (info.parentID !== parentID)
      throw new Error('Subagent resume identity mismatch');
    const previous = await read(id);
    assertStable(id, previous);
    // Historical children remain native-owned, even with a managed parent.
    if (!previous || !admission.bundle) return undefined;
    if (info.agent !== agent)
      throw new Error('Subagent resume identity mismatch');
    if (previous.parentID !== parentID)
      throw new Error('Subagent parent identity mismatch');
    return previous;
  }
  async function inspectResume(
    id: string,
    parentID: string,
    admission: SessionTeamAdmission,
    agent: string,
    signal?: AbortSignal,
  ) {
    requireAvailable();
    await admit(id);
    const record = await resumeRecord(id, parentID, admission, agent);
    check(signal);
    return record !== undefined;
  }
  async function resumeChild(
    id: string,
    parentID: string,
    admission: SessionTeamAdmission,
    agent: string,
    signal?: AbortSignal,
    preflight?: () => Promise<void>,
  ) {
    requireAvailable();
    await admit(id);
    return serial(id, async () => {
      const previous = await resumeRecord(id, parentID, admission, agent);
      if (!previous || !admission.bundle)
        throw new Error('Managed subagent resume binding lost');
      check(signal);
      const changed = !isDeepStrictEqual(
        previous.execution ?? previous.bundle,
        admission.bundle,
      );
      if (!changed && !admission.explicitModel) {
        // Parent re-delegation owns the future team even after a child Apply.
        // Only that team changes: leave this execution's model/fallback alone.
        if (isDeepStrictEqual(previous.bundle, admission.bundle))
          return { record: previous };
        return {
          record: await write(
            id,
            { ...previous, bundle: admission.bundle },
            signal,
          ),
        };
      }
      execution?.assertIdle(id);
      // Only managed execution revisions need a preflight. Keep it inside
      // this serial transaction, after identity/legacy checks and before any
      // pending write or install; legacy continuations remain native-owned.
      if (admission.explicitModel) {
        check(signal);
        if (!preflight)
          throw new Error(
            'Explicit subagent model availability cannot be verified',
          );
        await preflight();
        check(signal);
      }
      const target = stableSchema.parse({
        schemaVersion: 2,
        revision: (previous.revision ?? 0) + 1,
        parentID,
        bundle: admission.bundle,
        preserveModel: true,
        explicitModel: admission.explicitModel,
        ...((admission.resolvedModel ?? admission.bundle.profiles[agent]?.model)
          ? {
              executionModel:
                admission.resolvedModel ??
                admission.bundle.profiles[agent]?.model,
            }
          : {}),
        ...(admission.inheritedProviderID
          ? { inheritedProviderID: admission.inheritedProviderID }
          : {}),
      });
      const operationID = randomUUID();
      changing.add(id);
      try {
        const record = await write(
          id,
          {
            ...previous,
            schemaVersion: 2,
            pending: { kind: 'transition', operationID, agent, target },
          },
          signal,
        );
        return {
          record: await complete(id, record, signal),
          committedOperationID: operationID,
        };
      } finally {
        changing.delete(id);
      }
    });
  }
  return {
    available,
    setExecution: (publisher: SessionPresetExecution) => {
      execution = publisher;
    },
    admit,
    async assertRequestSelection(
      id: string,
      actual: ModelRef,
      revision: number,
    ) {
      // Compare the REAL request ref with the host's authoritative selection.
      // A native/manual selection is valid even outside the preset; an old
      // request ref is not relabelled with the session's newer model.
      const info = await identity(id);
      const record = cache.get(id);
      assertStable(id, record);
      if ((record?.revision ?? 0) !== revision)
        throw new Error('Session preset request revision mismatch');
      const request = model.safeParse(actual);
      if (!request.success || request.data.variant === '')
        throw new Error('Session preset request model/variant mismatch');
      const agent = typeof info.agent === 'string' ? info.agent : undefined;
      const bundle = record?.execution ?? record?.bundle;
      // The native runner can resolve a default without persisting session.model.
      // This is an automatic-selection policy, not equality with a missing ref:
      // an explicit/preset/inherited selection still requires a complete host ref.
      if (
        info.model == null &&
        record?.parentID &&
        record.parentID === info.parentID &&
        record?.explicitModel === false &&
        !record.executionModel &&
        !record.inheritedProviderID &&
        agent &&
        bundle &&
        !bundle.profiles[agent]?.model &&
        !bundle.inheritance[agent] &&
        (!bundle.fallbackEnabled || !bundle.chains[agent]?.length)
      )
        return;
      if (!sameSelection(info.model, actual))
        throw new Error('Session preset request model/variant mismatch');
    },
    assertStable: (id: string) => assertStable(id, cache.get(id)),
    resumeChild,
    inspectResume,
    ensure,
    bindChild,
    checkActive: check,
    peek: (id: string) => cache.get(id),
    async readState(id: string) {
      requireAvailable();
      const record = await read(id);
      if (record?.pending?.kind === 'createBound') {
        if (record.pending.input.directory !== path.resolve(options.directory))
          throw new Error('Session preset initialization location mismatch');
        return state(id, record);
      }
      const info = await identity(id);
      if (
        record &&
        record.parentID !==
          (typeof info.parentID === 'string' ? info.parentID : undefined)
      )
        throw new Error('Session preset parent identity mismatch');
      return state(id, record);
    },
    async apply(id: string, name: string, signal?: AbortSignal) {
      requireAvailable();
      return serial(id, async () => {
        const info = await identity(id);
        const previous = await read(id);
        assertStable(id, previous);
        const parentID =
          typeof info.parentID === 'string' ? info.parentID : undefined;
        if (previous && previous.parentID !== parentID)
          throw new Error('Session preset parent identity mismatch');
        if (parentID && !previous)
          throw new Error('Cannot apply to an unbound child');
        const bundle = await options.named(name);
        const record = await write(
          id,
          {
            ...previous,
            schemaVersion: 2,
            ...(parentID && previous
              ? { parentID, execution: previous.execution ?? previous.bundle }
              : {}),
            bundle,
          },
          signal,
        );
        return state(id, record);
      });
    },
    async createBound(
      input: Omit<z.infer<typeof createInputSchema>, 'directory' | 'scope'> & {
        sessionID: string;
      },
      signal?: AbortSignal,
    ) {
      requireAvailable();
      if (!options.session.create)
        throw new Error('Bound session creation unavailable');
      const { sessionID: id, ...intent } = input;
      const frozenInput = createInputSchema.parse({
        ...intent,
        directory: path.resolve(options.directory),
        scope: creationScope(),
      });
      return serial(id, async () => {
        const previous = await read(id);
        if (previous) {
          const original =
            previous.pending?.kind === 'createBound'
              ? previous.pending.input
              : previous.createdBy;
          if (original) assertCreationScope(original);
          if (!original || !isDeepStrictEqual(original, frozenInput))
            throw new Error(
              'Bound session creation conflicts with existing operation',
            );
          if (!previous.pending) return state(id, previous);
          if (previous.pending.kind !== 'createBound')
            return state(id, previous);
          changing.add(id);
          try {
            return state(id, await complete(id, previous, signal));
          } finally {
            changing.delete(id);
          }
        }
        if (await lookup(id))
          throw new Error(
            'Bound session creation requires an unused session ID',
          );
        const response = await options.agents?.();
        const agents =
          response && typeof response === 'object' && 'data' in response
            ? response.data
            : response;
        if (
          !Array.isArray(agents) ||
          !agents.some((entry) => {
            const agent = entry as {
              id?: string;
              mode?: string;
              hidden?: boolean;
            };
            return (
              agent.id === intent.agent &&
              !agent.hidden &&
              (agent.mode === 'primary' || agent.mode === 'all')
            );
          })
        )
          throw new Error(
            'Bound session creation requires a visible primary/all agent',
          );
        const bundle = await options.named(intent.presetName);
        changing.add(id);
        try {
          const record = await write(
            id,
            {
              schemaVersion: 2,
              revision: 0,
              bundle,
              pending: {
                kind: 'createBound',
                operationID: intent.operationID,
                input: frozenInput,
              },
            },
            signal,
          );
          return state(id, await complete(id, record, signal));
        } finally {
          changing.delete(id);
        }
      });
    },
    async retry(id: string, operationID: string, signal?: AbortSignal) {
      requireAvailable();
      return serial(id, async () => {
        const record = await read(id);
        if (!record) throw new Error('Session preset operation not found');
        if (record.createdBy?.operationID === operationID)
          assertCreationScope(record.createdBy);
        if (record.pending?.operationID !== operationID) {
          if (
            record.completedOperationID === operationID ||
            record.createdBy?.operationID === operationID
          )
            return state(id, record);
          throw new Error('Session preset operation mismatch');
        }
        changing.add(id);
        try {
          return state(id, await complete(id, record, signal));
        } finally {
          changing.delete(id);
        }
      });
    },
    async remove(id: string) {
      check();
      if (!available) return;
      await serial(id, async () => {
        check();
        writeEpochs.set(id, (writeEpochs.get(id) ?? 0) + 1);
        try {
          await storage().remove(key(id));
        } finally {
          // Removal may commit before reporting failure. A read from either
          // side of this operation must re-read KV, never resurrect its cache.
          writeEpochs.set(id, (writeEpochs.get(id) ?? 0) + 1);
          cache.delete(id);
        }
      });
    },
    async dispose() {
      retired = true;
      await Promise.allSettled([...pending.values()]);
      cache.clear();
    },
  };
}

export type SessionPresets = ReturnType<typeof createSessionPresets>;

/** Wrap the official execute, never duplicate its create/prompt logic. The host
 * awaits progress between creation and prompt; persistence failure rejects it. */
export function wrapSessionPresetSubagent(options: {
  execute: (input: unknown, context: unknown) => Promise<unknown>;
  presets: SessionPresets;
  capture: (callID: string, parentID: string) => Promise<SessionTeamAdmission>;
  validateSelection?: (selection: string) => Promise<void>;
}) {
  return async (input: unknown, rawContext: unknown): Promise<unknown> => {
    const context = rawContext as {
      sessionID: string;
      id: string;
      signal: AbortSignal;
      progress: (update: Record<string, unknown>) => Promise<void>;
    };
    // Consume the handoff before checking cancellation: even an already
    // interrupted execute must not retain its admission entry until after.
    const admission = await options.capture(context.id, context.sessionID);
    const { bundle } = admission;
    options.presets.checkActive(context.signal);
    const args = input as Record<string, unknown>;
    const selection = args.model;
    if (admission.explicitModel)
      admission.resolvedModel = delegationSelection(selection);
    const existingID =
      typeof args.sessionID === 'string' ? args.sessionID : undefined;
    let configuredOperation: string | undefined;
    let managed = false;
    // Read-only classification before native authorization. Revalidate inside
    // the coordinator after permission succeeds; do not publish anything here.
    if (existingID) {
      if (options.presets.available) {
        managed = await options.presets.inspectResume(
          existingID,
          context.sessionID,
          admission,
          String(args.agent),
          context.signal,
        );
      } else await options.presets.ensure(existingID, context.signal);
    }
    options.presets.checkActive(context.signal);
    let nativeInput = input;
    if (managed) {
      // This prevents native model writes only while the agent stays the same.
      // A concurrent manual agent change can still activate native defaults
      // before progress; the public API offers no fence for that race.
      const { model: _model, ...rest } = args;
      nativeInput = rest;
    }
    // Memoize the awaited installation, including rejection, for duplicate
    // progress notifications. This is one existing coordinator transaction.
    let installation: Promise<void> | undefined;
    try {
      return await options.execute(nativeInput, {
        ...context,
        progress: async (update: Record<string, unknown>) => {
          options.presets.checkActive(context.signal);
          if (typeof update.sessionID === 'string') {
            if (existingID) {
              if (update.sessionID !== existingID)
                throw new Error('Subagent resume identity changed');
              if (managed) {
                installation ??= (async () => {
                  const validateSelection = options.validateSelection;
                  const result = await options.presets.resumeChild(
                    existingID,
                    context.sessionID,
                    admission,
                    String(args.agent),
                    context.signal,
                    validateSelection
                      ? () => validateSelection(String(selection))
                      : undefined,
                  );
                  configuredOperation = result.committedOperationID;
                })();
                await installation;
              } else await options.presets.ensure(existingID, context.signal);
            } else if (bundle) {
              await options.presets.bindChild(
                update.sessionID,
                context.sessionID,
                bundle,
                context.signal,
                {
                  preserveModel: typeof args.model === 'string',
                  explicitModel: admission.explicitModel,
                  ...(admission.inheritedProviderID
                    ? { inheritedProviderID: admission.inheritedProviderID }
                    : {}),
                },
              );
            }
          }
          options.presets.checkActive(context.signal);
          await context.progress(update);
        },
      });
    } catch (error) {
      if (configuredOperation)
        throw new Error(
          `Session preset configuration committed (${configuredOperation}); native continuation failed: ${String(error)}. Configuration retry does not resend the prompt.`,
          { cause: error },
        );
      throw error;
    }
  };
}
