import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { V2AgentRuntimeProfiles } from './runtime-profiles';
import type { V2Context } from './types';

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
const recordSchema = z
  .object({
    schemaVersion: z.literal(1),
    parentID: z.string().optional(),
    bundle: bundleSchema,
    // Applying to a child changes its descendants, not its own inference.
    execution: bundleSchema.optional(),
    preserveModel: z.boolean().optional(),
    explicitModel: z.boolean().optional(),
    inheritedProviderID: z.string().min(1).optional(),
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
  status: 'bound' | 'unbound';
  presetName: string | null;
  affects: 'future-children-only';
  team?: {
    agentModels: Record<string, string>;
    agentVariants: Record<string, string>;
    inheritance: Record<string, 'session' | 'orchestrator'>;
  };
};
/** Per-call execution intent is separate from the inherited team bundle. */
export type SessionTeamAdmission = {
  /** Null is an explicit compatibility admission, never a missing capture. */
  bundle: SessionTeamBundle | null;
  explicitModel: boolean;
  inheritedProviderID?: string;
  /** Native continuation selection, captured from the direct parent's team. */
  model?: string;
};

/**
 * Precise identity fields parsed from the ONE host read that guards a
 * preset admission (`session.get` inside the `ensure` transaction). The
 * fields are absent only when the host session info lacks them — a
 * missing `parentID` is a proven root. See `ensureAdmission`.
 */
export interface SessionPresetAdmissionIdentity {
  parentID?: string;
  agent?: string;
  model?: unknown;
  /** The fields came from the host's own identity read inside the same
   * transaction, so absences are definitive and consumers must not
   * re-consult the host to fill them. */
  readonly authoritative: true;
}

/**
 * One-admission reuse view of a session preset binding: the record and
 * the precise identity parsed from the SAME host read, produced by ONE
 * `ensure` transaction (one `session.get` + one storage lookup). The
 * `record` object is the exact object `ensure` would return — the
 * internal cache map stays the single owner; there is no second cached
 * copy. `undefined` when the service is unavailable (reduced host without
 * storage/identity) or when the host reports the id as not found — the
 * advisory absence case; a historical unbound child yields
 * `{ record: undefined, identity }`.
 */
export type SessionPresetAdmission = {
  record: SessionPresetRecord | undefined;
  identity: SessionPresetAdmissionIdentity;
};

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
}) {
  const location = options.location ? { ...options.location } : undefined;
  const cache = new Map<string, SessionPresetRecord>();
  const pending = new Map<string, Promise<unknown>>();
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
      const value = await storage().get(key(id));
      check();
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
    try {
      await storage().set(key(id), record);
    } catch (error) {
      // A backend may report an uncertain commit. Never retain a stale
      // last-good cache entry instead of consulting KV on the next attempt.
      cache.delete(id);
      throw error;
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
  async function ensureTransaction(
    id: string,
    signal: AbortSignal | undefined,
    explicitModel: boolean | undefined,
    info: Record<string, unknown>,
  ): Promise<SessionPresetRecord | undefined> {
    check(signal);
    const existing = await read(id);
    const parentID =
      typeof info.parentID === 'string' ? info.parentID : undefined;
    if (existing) {
      if (existing.parentID !== parentID)
        throw new Error('Session preset parent identity mismatch');
      if (
        explicitModel === true &&
        (!existing.explicitModel || !existing.preserveModel)
      ) {
        return write(
          id,
          { ...existing, explicitModel: true, preserveModel: true },
          signal,
        );
      }
      if (
        explicitModel === false &&
        (existing.explicitModel || existing.preserveModel)
      ) {
        const { preserveModel: _preserve, ...rest } = existing;
        return write(id, { ...rest, explicitModel: false }, signal);
      }
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
    return write(id, { schemaVersion: 1, bundle: options.current() }, signal);
  }

  function admissionIdentity(
    info: Record<string, unknown>,
  ): SessionPresetAdmissionIdentity {
    return {
      ...(typeof info.parentID === 'string' ? { parentID: info.parentID } : {}),
      ...(typeof info.agent === 'string' ? { agent: info.agent } : {}),
      ...(info.model !== undefined ? { model: info.model } : {}),
      authoritative: true,
    };
  }

  async function ensure(
    id: string,
    signal?: AbortSignal,
    explicitModel?: boolean,
  ) {
    check(signal);
    if (!available) return undefined;
    return serial(id, async () => {
      const info = await absentWhenUnknown(id);
      if (!info) return undefined;
      return ensureTransaction(id, signal, explicitModel, info);
    });
  }
  async function ensureAdmission(
    id: string,
    signal?: AbortSignal,
    explicitModel?: boolean,
  ): Promise<SessionPresetAdmission | undefined> {
    check(signal);
    if (!available) return undefined;
    return serial(id, async () => {
      const info = await absentWhenUnknown(id);
      if (!info) return undefined;
      check(signal);
      const record = await ensureTransaction(id, signal, explicitModel, info);
      return { record, identity: admissionIdentity(info) };
    });
  }
  /** Host identity for an id this store may not know yet. The host's
   * not-found is a tagged error with an EMPTY message; surfacing it from an
   * advisory read would reject the tool call with no readable reason and
   * hide the host's own refusal, so absence is reported as absence. */
  async function absentWhenUnknown(
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      return await identity(id);
    } catch (error) {
      if (
        (error as { _tag?: string } | undefined)?._tag ===
        'Session.NotFoundError'
      )
        return undefined;
      throw error;
    }
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
          schemaVersion: 1,
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
    status: record ? 'bound' : 'unbound',
    presetName: record?.bundle.presetName ?? null,
    affects: 'future-children-only',
    ...(record
      ? {
          team: {
            agentModels: Object.fromEntries(
              Object.entries(record.bundle.profiles).map(([agent, profile]) => [
                agent,
                profile.model
                  ? `${profile.model.providerID}/${profile.model.id}`
                  : profile.sidebarModel,
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
        }
      : {}),
  });
  return {
    available,
    ensure,
    ensureAdmission,
    bindChild,
    async adoptExecution(
      id: string,
      adopted: SessionPresetRecord,
      signal?: AbortSignal,
    ) {
      requireAvailable();
      return serial(id, async () => {
        const info = await identity(id);
        const existing = await read(id);
        if (
          !existing ||
          existing.parentID !== adopted.parentID ||
          info.parentID !== adopted.parentID
        )
          throw new Error('Subagent parent identity mismatch');
        // A child Apply owns its future-delegation bundle independently.
        return write(
          id,
          existing.execution
            ? {
                ...adopted,
                bundle: existing.bundle,
                execution: adopted.execution ?? adopted.bundle,
              }
            : adopted,
          signal,
        );
      });
    },
    checkActive: check,
    peek: (id: string) => cache.get(id),
    async createBound(name: string, signal?: AbortSignal) {
      requireAvailable();
      check(signal);
      if (!location || typeof options.session.create !== 'function')
        throw new Error(
          'Create with preset unavailable: host location or session.create API missing',
        );
      const bundle = structuredClone(await options.named(name));
      check(signal);
      // Native creation supplies a new, empty root and its initial selection.
      // Only its future delegation team is ours to bind; never submit a prompt.
      const { id } = await options.session.create({ location });
      try {
        return await serial(id, async () =>
          state(id, await write(id, { schemaVersion: 1, bundle }, signal)),
        );
      } catch (cause) {
        throw new Error(
          `Created session ${id}, but preset binding failed. Open it and use Apply to bind ${JSON.stringify(name)}.`,
          { cause },
        );
      }
    },
    async readState(id: string) {
      requireAvailable();
      return serial(id, async () => {
        const info = await identity(id);
        const record = await read(id);
        if (
          record &&
          record.parentID !==
            (typeof info.parentID === 'string' ? info.parentID : undefined)
        )
          throw new Error('Session preset parent identity mismatch');
        return state(id, record);
      });
    },
    async apply(id: string, name: string, signal?: AbortSignal) {
      requireAvailable();
      return serial(id, async () => {
        const info = await identity(id);
        const previous = await read(id);
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
            schemaVersion: 1,
            ...(previous?.preserveModel ? { preserveModel: true } : {}),
            ...(previous?.explicitModel !== undefined
              ? { explicitModel: previous.explicitModel }
              : {}),
            ...(previous?.inheritedProviderID
              ? { inheritedProviderID: previous.inheritedProviderID }
              : {}),
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
    async remove(id: string) {
      check();
      if (!available) return;
      await serial(id, async () => {
        check();
        await storage().remove(key(id));
        cache.delete(id);
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

/** Wrap official execute, never duplicate create/prompt or model selection.
 * Creation binds at progress; continuation installs inference there and commits
 * its snapshot only after execute succeeds (including a running return). */
export function wrapSessionPresetSubagent(options: {
  execute: (input: unknown, context: unknown) => Promise<unknown>;
  presets: SessionPresets;
  capture: (callID: string, parentID: string) => Promise<SessionTeamAdmission>;
  effectiveBinding?: (sessionID: string) => SessionPresetRecord | undefined;
  replaceProfile?: (
    sessionID: string,
    identity: SessionPresetAdmissionIdentity,
    record: SessionPresetRecord,
  ) => Promise<(committed: boolean) => void>;
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
    const existingID =
      typeof args.sessionID === 'string' ? args.sessionID : undefined;
    const previous = existingID
      ? await options.presets.ensureAdmission(existingID, context.signal)
      : undefined;
    const retained = existingID
      ? options.effectiveBinding?.(existingID)
      : undefined;
    const agent = previous?.identity.agent;
    const sameAgent = Boolean(
      agent && agent === args.agent && bundle?.profiles[agent],
    );
    const changed = Boolean(
      bundle &&
        previous?.record?.parentID === context.sessionID &&
        sameAgent &&
        agent &&
        bundle.profiles[agent] &&
        options.replaceProfile &&
        // A retained runtime binding needs reconciliation even when KV already
        // matches the target. Conversely, matching runtime must not skip a
        // stale KV commit after a previous submission's write failed.
        (retained ||
          !isDeepStrictEqual(
            previous.record.execution ?? previous.record.bundle,
            bundle,
          )),
    );
    // Unchanged teams retain manual model/fallback selections. Legacy and
    // different-agent continuations keep their existing admission behavior.
    if (existingID && !changed && (admission.explicitModel || !sameAgent))
      await options.presets.ensure(
        existingID,
        context.signal,
        admission.explicitModel,
      );
    options.presets.checkActive(context.signal);
    let adopted: SessionPresetRecord | undefined;
    let finishProfile: ((committed: boolean) => void) | undefined;
    let submitted = false;
    let committed = false;
    try {
      const result = await options.execute(
        changed && !admission.explicitModel && admission.model
          ? { ...args, model: admission.model }
          : input,
        {
          ...context,
          progress: async (update: Record<string, unknown>) => {
            options.presets.checkActive(context.signal);
            if (typeof update.sessionID === 'string') {
              if (existingID) {
                if (update.sessionID !== existingID)
                  throw new Error('Subagent resume identity changed');
                const current = await options.presets.ensureAdmission(
                  existingID,
                  context.signal,
                );
                if (changed && bundle && current?.record && !adopted) {
                  if (
                    current.identity.parentID !== context.sessionID ||
                    current.identity.agent !== previous?.identity.agent
                  )
                    throw new Error('Subagent resume identity changed');
                  // Native selection is already applied. Options retain their
                  // captured inheritance origin, not an explicit override's
                  // provider (the same source used when binding a new child).
                  adopted = {
                    schemaVersion: 1,
                    parentID: context.sessionID,
                    bundle: current.record.execution
                      ? current.record.bundle
                      : bundle,
                    ...(current.record.execution ? { execution: bundle } : {}),
                    preserveModel: true,
                    explicitModel: admission.explicitModel,
                    ...(admission.inheritedProviderID
                      ? { inheritedProviderID: admission.inheritedProviderID }
                      : {}),
                  };
                  finishProfile = await options.replaceProfile?.(
                    existingID,
                    current.identity,
                    adopted,
                  );
                }
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
        },
      );
      submitted = true;
      if (existingID && adopted) {
        await options.presets.adoptExecution(
          existingID,
          adopted,
          context.signal,
        );
        committed = true;
      }
      return result;
    } finally {
      // A KV error after native success must not strip inference from an
      // already submitted child. Retain the unpersisted effective binding.
      if (!submitted || committed) finishProfile?.(committed);
    }
  };
}
