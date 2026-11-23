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
/** Forced root inference (ADR-005): the live-session application of a
 * preset's orchestrator entry. Present only on root records; consumed when
 * the session model differs from the forced value (native pick wins). */
const rootForceSchema = z
  .object({
    model,
    temperature: z.number().finite().optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    managedProviderOptionKeys: z.array(z.string()).optional(),
  })
  .strict();
const recordSchema = z
  .object({
    schemaVersion: z.literal(1),
    parentID: z.string().optional(),
    bundle: bundleSchema,
    // Selection provenance. Absent legacy records are explicit: they were
    // written before default bindings existed, so never rewrite them eagerly.
    selection: z.enum(['explicit', 'default']).optional(),
    // Applying to a child changes its descendants, not its own inference.
    execution: bundleSchema.optional(),
    preserveModel: z.boolean().optional(),
    explicitModel: z.boolean().optional(),
    inheritedProviderID: z.string().min(1).optional(),
    rootForce: rootForceSchema.optional(),
  })
  .strict();
type SessionRootForce = z.infer<typeof rootForceSchema>;

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
  /** Present on new bindings; absent legacy records mean explicit. */
  selection?: 'explicit' | 'default';
  affects: 'future-children-only';
  /** Root session's model line: the forced value while a rootForce record
   * is active, otherwise the host-reported live model. Roots only. */
  root?: { model: string; variant?: string; forced: boolean };
  /** Present on a `--force-orchestrator` apply: the root switch happened,
   * or the preset defines no orchestrator model. */
  rootForce?:
    | { outcome: 'switched'; model: string }
    | { outcome: 'no-orchestrator-model' };
  team?: {
    agentModels: Record<string, string>;
    agentVariants: Record<string, string>;
    inheritance: Record<string, 'session' | 'orchestrator'>;
  };
};
/** Per-call execution intent is separate from the inherited team bundle. */
export type SessionTeamAdmission = {
  /** Null explicitly leaves execution to the host, never a missing capture. */
  bundle: SessionTeamBundle | null;
  explicitModel: boolean;
  inheritedProviderID?: string;
  /** Native continuation selection, captured from the direct parent's team. */
  model?: string;
  /** Parent binding provenance; absent legacy bindings are explicit. */
  selection?: 'explicit' | 'default';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Host session model ref. A `default` variant is a default-selection
 * sentinel, not an explicit pin (native 2.1.2 fromRow projection), so it is
 * normalized away like the capture path in setup.ts. */
function liveModelRef(
  info: Record<string, unknown> | undefined,
): { providerID: string; id: string; variant?: string } | undefined {
  const stored = isRecord(info) ? info.model : undefined;
  if (
    !isRecord(stored) ||
    typeof stored.providerID !== 'string' ||
    typeof stored.id !== 'string'
  )
    return undefined;
  return {
    providerID: stored.providerID,
    id: stored.id,
    ...(typeof stored.variant === 'string' && stored.variant !== 'default'
      ? { variant: stored.variant }
      : {}),
  };
}

/** Same model comparison for force consumption: provider and id decide.
 * A variant-only native change of the same model keeps the force (the
 * forced temperature/options keep applying to it). */
function sameModelRef(
  a: { providerID: string; id: string; variant?: string },
  b: { providerID: string; id: string; variant?: string },
): boolean {
  return a.providerID === b.providerID && a.id === b.id;
}

/** Exact model comparison for rollback: provider, id and variant must all
 * match. A variant-only switch is still a change to undo, unlike the
 * consumption comparison above (a native variant pick keeps the force). */
function identicalModelRef(
  a: { providerID: string; id: string; variant?: string },
  b: { providerID: string; id: string; variant?: string },
): boolean {
  return (
    a.providerID === b.providerID && a.id === b.id && a.variant === b.variant
  );
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
  current: () => SessionTeamBundle;
  /** True while `current` is not a valid live config (fallback or failed refresh); roots keep their snapshot. */
  currentIsFallback?: () => boolean;
  named: (name: string) => Promise<SessionTeamBundle>;
  /** True when the preset's own resolved definition sets an orchestrator
   * model. Gates --force-orchestrator: the merged orchestrator profile
   * also carries root-level and host settings, which are never a force
   * target (ADR-005 decision 4). */
  presetOwnOrchestratorModel?: (name: string) => Promise<boolean>;
}) {
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
  /** Host identity read for one session id, unwrapping the `{data}` envelope.
   * The cast mirrors the previous inline read: a missing envelope still
   * yields a falsy value at runtime, caught by the `!info` guard below. */
  async function readSession(id: string) {
    const session = options.session;
    if (!session || typeof session.get !== 'function') {
      throw new Error('Session preset identity unavailable');
    }
    const response = await session.get({ sessionID: id });
    check();
    const value = response as Record<string, unknown>;
    return (value?.data ?? value) as Record<string, unknown>;
  }
  /** Best-effort parent identity read for the session_move fallback:
   * any failure proves nothing, so it reports absence and the caller
   * keeps the strict rejection. */
  async function readSessionQuiet(id: string) {
    try {
      return await readSession(id);
    } catch {
      return undefined;
    }
  }
  /** Strict directory guard: the session id matches and its reported
   * directory is the plugin's startup directory. */
  function inPluginDirectory(
    info: Record<string, unknown> | undefined,
    id: string,
  ): boolean {
    if (!info || info.id !== id) return false;
    const location = info.location as { directory?: string } | undefined;
    const directory = location?.directory ?? info.directory;
    return (
      typeof directory === 'string' &&
      path.resolve(directory) === path.resolve(options.directory)
    );
  }
  async function identity(id: string) {
    check();
    if (!id || typeof options.session?.get !== 'function') {
      throw new Error('Session preset identity unavailable');
    }
    const info = await readSession(id);
    if (inPluginDirectory(info, id)) return info;
    // #1915: a child that moved itself after creation (session_move)
    // reports a directory outside the plugin's startup directory. Its
    // parent still lives there, so prove provenance through the parent
    // instead of rejecting a live child of this project. A session with
    // no reported directory, no parent, or an unprovable parent keeps
    // the strict rejection below.
    const location = info?.location as { directory?: string } | undefined;
    const directory = location?.directory ?? info?.directory;
    const parentID =
      typeof info?.parentID === 'string' ? info.parentID : undefined;
    if (info?.id === id && typeof directory === 'string' && parentID) {
      const parent = await readSessionQuiet(parentID);
      if (parent?.id === parentID && inPluginDirectory(parent, parentID)) {
        return info;
      }
    }
    throw new Error('Session preset session/location mismatch');
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
      // ADR-005: a forced root model is consumed once the live session model
      // differs from it — a native pick wins permanently. An absent host
      // model pin proves nothing either way, so the force is kept.
      let binding = existing;
      if (existing.rootForce) {
        const live = liveModelRef(info);
        if (live && !sameModelRef(live, existing.rootForce.model)) {
          const { rootForce: _consumed, ...stripped } = existing;
          binding = stripped;
        }
      }
      // A root on the live default follows strict config refreshes; a team
      // applied by name, or a root during a fallback config, keeps its snapshot.
      let bundle = binding.bundle;
      if (
        !parentID &&
        binding.selection === 'default' &&
        !options.currentIsFallback?.()
      ) {
        const live = options.current();
        assertJSON(live);
        bundle = JSON.parse(JSON.stringify(live));
      }
      const current = isDeepStrictEqual(binding.bundle, bundle)
        ? binding
        : { ...binding, bundle };
      if (
        explicitModel === true &&
        (!current.explicitModel || !current.preserveModel)
      ) {
        return write(
          id,
          { ...current, explicitModel: true, preserveModel: true },
          signal,
        );
      }
      if (
        explicitModel === false &&
        (current.explicitModel || current.preserveModel)
      ) {
        const { preserveModel: _preserve, ...rest } = current;
        return write(id, { ...rest, explicitModel: false }, signal);
      }
      return current === existing ? existing : write(id, current, signal);
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
      { schemaVersion: 1, bundle: options.current(), selection: 'default' },
      signal,
    );
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
      /** Parent binding provenance; absent legacy bindings are explicit. */
      selection?: 'explicit' | 'default';
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
          selection: selection?.selection ?? 'explicit',
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
    live?: { providerID: string; id: string; variant?: string },
    rootForceOutcome?: SessionPresetState['rootForce'],
  ): SessionPresetState => ({
    sessionID: id,
    status: record ? 'bound' : 'unbound',
    presetName: record?.bundle.presetName ?? null,
    ...(record?.selection ? { selection: record.selection } : {}),
    affects: 'future-children-only',
    ...(rootForceOutcome ? { rootForce: rootForceOutcome } : {}),
    ...(record && !record.parentID
      ? {
          root: record.rootForce
            ? {
                model: `${record.rootForce.model.providerID}/${record.rootForce.model.id}`,
                ...(record.rootForce.model.variant
                  ? { variant: record.rootForce.model.variant }
                  : {}),
                forced: true,
              }
            : live
              ? {
                  model: `${live.providerID}/${live.id}`,
                  ...(live.variant ? { variant: live.variant } : {}),
                  forced: false,
                }
              : { model: 'default', forced: false },
        }
      : {}),
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
        // A concurrent child Apply owns the future-delegation bundle
        // and its selection, while this execution still advances. Persist
        // both in the execution branch below: returning early would skip the
        // required durable commit and swallow storage failures.
        return write(
          id,
          existing.execution
            ? {
                ...adopted,
                bundle: existing.bundle,
                execution: adopted.execution ?? adopted.bundle,
                ...(existing.selection
                  ? { selection: existing.selection }
                  : {}),
              }
            : adopted,
          signal,
        );
      });
    },
    checkActive: check,
    peek: (id: string) => cache.get(id),
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
        return state(id, record, liveModelRef(info));
      });
    },
    async apply(
      id: string,
      name: string,
      signal?: AbortSignal,
      applyOptions?: { forceOrchestrator?: boolean },
    ) {
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
        const force = applyOptions?.forceOrchestrator === true;
        if (force && parentID)
          throw new Error(
            '--force-orchestrator applies to root sessions only; this is a child session. Nothing was applied.',
          );
        const session = options.session;
        const switchModel = session?.switchModel;
        if (force && typeof switchModel !== 'function')
          throw new Error(
            'The host does not support switching the session model, so --force-orchestrator is unavailable. Run /preset <name> without the flag to bind the team. Nothing was applied.',
          );
        if (force && !options.presetOwnOrchestratorModel)
          throw new Error(
            'The preset orchestrator entry is not readable, so --force-orchestrator is unavailable. Run /preset <name> without the flag to bind the team. Nothing was applied.',
          );
        const bundle = await options.named(name);
        // A root apply replaces the whole binding: a previous forced root
        // model never survives a reapply (ADR-005); a forced apply
        // re-captures it below from the fresh bundle. The force target is
        // gated on the preset's own orchestrator model: the merged
        // orchestrator profile also carries root-level and host settings,
        // so a team-only preset never switches the root model.
        const ownOrchestratorModel = force
          ? await options.presetOwnOrchestratorModel?.(name)
          : undefined;
        const rootProfile =
          force && ownOrchestratorModel
            ? bundle.profiles.orchestrator
            : undefined;
        const rootForce: SessionRootForce | undefined = rootProfile?.model
          ? {
              model: rootProfile.model,
              ...(rootProfile.temperature !== undefined
                ? { temperature: rootProfile.temperature }
                : {}),
              ...(rootProfile.providerOptions
                ? { providerOptions: rootProfile.providerOptions }
                : {}),
              managedProviderOptionKeys: [
                ...new Set([
                  ...(rootProfile.managedProviderOptionKeys ?? []),
                  ...Object.keys(rootProfile.providerOptions ?? {}),
                ]),
              ],
            }
          : undefined;
        if (force && !rootForce) {
          // Not an error: the team binds and the caller reports that the
          // preset defines no orchestrator model (ADR-005 decision 4).
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
              selection: 'explicit',
            },
            signal,
          );
          return state(id, record, liveModelRef(info), {
            outcome: 'no-orchestrator-model',
          });
        }
        // Switch first, commit second: a host refusal leaves nothing
        // applied. A commit failure restores the pre-switch live model,
        // best-effort (ADR-005 decision 1).
        if (rootForce && switchModel) {
          try {
            await switchModel.call(session, {
              sessionID: id,
              model: rootForce.model,
            });
          } catch (err) {
            throw new Error(
              `--force-orchestrator: the host refused the model switch (${
                err instanceof Error ? err.message : String(err)
              }). Nothing was applied.`,
            );
          }
        }
        let record: SessionPresetRecord;
        const attempt: SessionPresetRecord = {
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
          selection: 'explicit',
          ...(rootForce ? { rootForce } : {}),
        };
        try {
          record = await write(id, attempt, signal);
        } catch (err) {
          // A save that already committed — a cancellation that landed
          // after the KV write throws here — is not a failed save: the
          // stored record matches the switched model, so roll back only
          // when nothing was committed.
          const committed = isDeepStrictEqual(cache.get(id), attempt);
          if (rootForce && switchModel && !committed) {
            const live = liveModelRef(info);
            const restore =
              live && !identicalModelRef(live, rootForce.model)
                ? live
                : undefined;
            if (restore) {
              try {
                await switchModel.call(session, {
                  sessionID: id,
                  model: restore,
                });
              } catch (revertErr) {
                throw new Error(
                  `--force-orchestrator: the team binding failed (${
                    err instanceof Error ? err.message : String(err)
                  }) and restoring the previous root model also failed (${
                    revertErr instanceof Error
                      ? revertErr.message
                      : String(revertErr)
                  }). Re-run /preset <name> --force-orchestrator or pick a model natively.`,
                );
              }
            }
          }
          throw err;
        }
        return state(
          id,
          record,
          liveModelRef(info),
          rootForce
            ? {
                outcome: 'switched',
                model: `${rootForce.model.providerID}/${rootForce.model.id}`,
              }
            : undefined,
        );
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
    if (!bundle) return options.execute(input, rawContext);
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
      agent && agent === args.agent && bundle.profiles[agent],
    );
    const changed = Boolean(
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
                if (changed && current?.record && !adopted) {
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
                    selection: current.record.selection ?? 'explicit',
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
              } else {
                await options.presets.bindChild(
                  update.sessionID,
                  context.sessionID,
                  bundle,
                  context.signal,
                  {
                    preserveModel: typeof args.model === 'string',
                    explicitModel: admission.explicitModel,
                    ...(admission.selection
                      ? { selection: admission.selection }
                      : {}),
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
