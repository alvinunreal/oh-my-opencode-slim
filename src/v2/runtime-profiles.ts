/**
 * Execution-revision-frozen v2 runtime profiles.
 *
 * AGENTS.md: system prompts and tool sets stay frozen for the lifetime of a
 * session — so a config/preset change must never rebuild agent definitions or
 * reload the host registry. Instead, the adapter resolves ONLY the
 * inference/runtime fields (model, variant, temperature, provider options)
 * into a per-agent profile, freezes each child's execution revision, and
 * applies it before that revision's first request:
 *
 * - `model`/`variant`: `session.switchModel` for host defaults; per-call models
 *   stay untouched (v2 prompts carry no model).
 * - `temperature`/provider `options`: mutated onto the context hook's
 *   `options` record for that captured session only (never system/messages/
 *   tools — prompt bytes and tool catalogs stay untouched).
 *
 * Ordinary same-content resumes keep their profile/model/fallback state.
 * Explicit parent re-delegation can install a new durable execution revision;
 * parents and foreign-agent sessions are never profiled.
 */
import type { ModelRef, V2Context, V2SessionContextEvent } from './types';

/** One agent's hot-applicable inference fields + sidebar projection. */
export interface V2AgentRuntimeProfile {
  model?: { providerID: string; id: string; variant?: string };
  temperature?: number;
  providerOptions?: Record<string, unknown>;
  /** Provider-option keys owned by the startup or refreshed profile. Keys
   * absent from `providerOptions` are removed from the request so clearing a
   * preset field cannot leak the startup registry value into a new child. */
  managedProviderOptionKeys?: readonly string[];
  sidebarModel: string;
  sidebarVariant?: string;
}

export type V2AgentRuntimeProfiles = Record<string, V2AgentRuntimeProfile>;

/** Per-session frozen profile (`null` = frozen with no applicable profile). */
type FrozenProfile = V2AgentRuntimeProfile | null;

/** Cap on per-session bookkeeping (FIFO eviction, mirrors the other v2 maps). */
const MAX_PROFILE_SESSIONS = 1024;
const PROFILE_OPERATION_TIMEOUT_MS = 2_000;
/** Bound for the request-path model switch. Rejecting (not proceeding) is
 * fail-closed: the prompt hook aborts the admission before any request can
 * run on a stale model. Retrying cannot start another switch until the real
 * native operation settles: a request timeout is not cancellation. */
const PROFILE_SWITCH_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameModel(a: unknown, b: V2AgentRuntimeProfile['model']): boolean {
  return (
    isRecord(a) &&
    b !== undefined &&
    a.providerID === b.providerID &&
    a.id === b.id &&
    (a.variant ?? 'default') === (b.variant ?? 'default')
  );
}

async function withProfileTimeout<T>(
  operation: Promise<T>,
  message: string,
  timeoutMs: number = PROFILE_OPERATION_TIMEOUT_MS,
  timers: Pick<SessionProfileBridgeOptions, 'setTimeout' | 'clearTimeout'> = {},
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | number | undefined;
  const schedule = timers.setTimeout ?? setTimeout;
  const cancel = timers.clearTimeout ?? clearTimeout;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = schedule(() => reject(new Error(message)), timeoutMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) cancel(timer);
  }
}

/**
 * Resolve the payload of a raw v2 event: live hosts carry it under `data`;
 * `properties` is the legacy spelling. Exported so every raw-event bridge
 * (permission rules, runtime profiles) resolves payloads identically.
 */
export function resolveV2EventPayload(
  event: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(event)) return {};
  if (isRecord(event.data)) return event.data;
  if (isRecord(event.properties)) return event.properties;
  return {};
}

export interface SessionProfileBridgeOptions {
  /** Current profile table (read on every newly seen child). */
  profiles: () => V2AgentRuntimeProfiles;
  /** Durable per-session team; never consult the global table for a child
   * when the session preset service is installed. */
  profilesForSession?: (sessionID: string) => Promise<V2AgentRuntimeProfiles>;
  preserveSessionModel?: (sessionID: string) => boolean;
  revisionForSession?: (sessionID: string) => number | undefined;
  /** Startup profiles, matching the host-registered agent defaults. */
  registeredProfiles?: V2AgentRuntimeProfiles;
  /** Plugin-defined agent ids; foreign children are never profiled. */
  pluginAgents: ReadonlySet<string>;
  /** Session domain used for `session.get` (identity) and `switchModel`. */
  session: V2Context['session'] | undefined;
  /** Agent most recently learned from the prompt bridge's context events;
   * consulted when `session.get` carries no `agent` (or is unavailable). */
  knownAgent?: (sessionID: string) => string | undefined;
  /** Observability/log seam (tests inject; defaults to no logging). */
  log?: (message: string, meta?: unknown) => void;
  /** Fired when a plugin child's profile is frozen (the registration
   *  moment). The factory pins the fallback-chain generation here so the
   *  session's chain snapshot comes from the same generation as its frozen
   *  profile — a refresh between registration and the first failure cannot
   *  mix generations for one child. */
  onSessionCaptured?: (sessionID: string) => void;
  /** A capture attempt failed (switch rejected or timed out) and the
   *  admission aborted — release anything pinned by the failed attempt. */
  onSessionCaptureFailed?: (sessionID: string) => void;
  /** Test seam: override the request-path model-switch bound. */
  switchTimeoutMs?: number;
  /** Scheduling seams for deterministic timeout tests; never replace globals. */
  setTimeout?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout> | number;
  clearTimeout?: (timer: ReturnType<typeof setTimeout> | number) => void;
}

/**
 * Identity fields the child gate keys on. `session.created` payloads carry
 * `{parentID, agent}`; the awaited `session.prompt` hook carries neither, so
 * the prompt path resolves them through `session.get` (and the prompt
 * bridge's learned agent as a fallback).
 */
export interface SessionProfileIdentity {
  parentID?: string;
  agent?: string;
  model?: unknown;
}

export interface SessionProfileBridge {
  /** Synchronously reject new work and post-await publication. */
  retire(): void;
  /** After retirement, wait for real native operations, not timeout wrappers. */
  drain(): Promise<void>;
  assertIdle(sessionID: string): void;
  installSessionProfile(
    sessionID: string,
    profile: V2AgentRuntimeProfile | undefined,
    revision: number,
    model?: ModelRef,
  ): Promise<void>;
  /** Observe one raw v2 event (prewarm/cleanup path); never throws. */
  observeEvent(event: Record<string, unknown>): Promise<void>;
  /**
   * Idempotent capture-and-switch for ONE session, awaited on the request
   * path (the native `session.prompt` hook) before the admission's first
   * model request. When `identity` is omitted, `session.get` resolves the
   * session's `parentID`/`agent`. For an identified plugin child, model
   * switching is fully awaited and a failed switch rejects the admission;
   * unknown identity remains untouched because it may be a root or foreign
   * session. Once captured (or proven root/foreign) the call is O(1).
   */
  ensureSessionProfile(
    sessionID: string,
    identity?: SessionProfileIdentity,
  ): Promise<void>;
  /** Frozen profile for a session (undefined when not captured). */
  profileForSession(sessionID: string): V2AgentRuntimeProfile | undefined;
  /** Captured session count (bounded; test seam). */
  size(): number;
}

/**
 * Freeze the current runtime profile for each newly seen plugin child session
 * and apply the model via `session.switchModel`.
 *
 * Two entry points share one idempotent, concurrency-safe capture:
 * - `ensureSessionProfile`: awaited from the native `session.prompt` hook
 *   (and any other request-path caller) so a child's first model request
 *   can never race the asynchronous event pump. Identity comes from
 *   `session.get` (or a caller-provided hint).
 * - `observeEvent`: the `session.created` prewarm plus `session.deleted`
 *   cleanup. It never determines the outcome on its own; a session already
 *   captured here is a no-op.
 *
 * Sessions proven to be roots or foreign-agent children are latched as
 * ignored so the request path does not re-query the host on every prompt.
 */
export function createSessionProfileBridge(
  options: SessionProfileBridgeOptions,
): SessionProfileBridge {
  const captured = new Map<string, FrozenProfile>();
  /** Sessions proven to never qualify (root / foreign / non-plugin agent). */
  const ignored = new Set<string>();
  /** Deleted ids stay inert until a fresh session.created proves reuse. */
  const deleted = new Set<string>();
  /** In-flight captures, so concurrent callers share one switch. */
  const pending = new Map<string, Promise<void>>();
  // Unlike the bounded admission task, this entry outlives a timeout. Never
  // evict an unresolved native call or let another operation share its slot.
  const switching = new Map<string, Promise<unknown>>();
  const revisions = new Map<string, number | undefined>();
  const emitLog = options.log ?? (() => {});
  let retired = false;
  const checkActive = () => {
    if (retired) throw new Error('Session profile generation retired');
  };

  function startSwitch(sessionID: string, operation: () => Promise<unknown>) {
    checkActive();
    if (switching.has(sessionID))
      throw new Error('Session profile model switch is still in flight');
    // Claim before invoking the host, including synchronous throws/reentry.
    const request = Promise.resolve().then(() => {
      checkActive();
      return operation();
    });
    switching.set(sessionID, request);
    const release = () => {
      if (switching.get(sessionID) === request) switching.delete(sessionID);
    };
    void request.then(release, release);
    return request;
  }

  function prune(): void {
    while (captured.size > MAX_PROFILE_SESSIONS) {
      const oldest = captured.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      captured.delete(oldest);
      revisions.delete(oldest);
    }
    while (ignored.size > MAX_PROFILE_SESSIONS) {
      const oldest = ignored.values().next().value as string | undefined;
      if (oldest === undefined) break;
      ignored.delete(oldest);
    }
    while (deleted.size > MAX_PROFILE_SESSIONS) {
      const oldest = deleted.values().next().value as string | undefined;
      if (oldest === undefined) break;
      deleted.delete(oldest);
    }
  }

  function cleanID(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
  }

  /**
   * Resolve `{parentID, agent}` for a session. A provided hint is
   * authoritative for the fields it carries (an undefined field is a
   * definitive absence — e.g. `session.created` for a root session).
   * Otherwise `session.get` is consulted; `agent` falls back to the prompt
   * bridge's learned state. `authoritative` reports whether the absence of
   * `parentID` is proven (so root sessions can be latched as ignored).
   */
  async function resolveIdentity(
    sessionID: string,
    hint: SessionProfileIdentity | undefined,
  ): Promise<{
    parentID?: string;
    agent?: string;
    model?: unknown;
    authoritative: boolean;
  }> {
    let parentID = cleanID(hint?.parentID);
    let agent = cleanID(hint?.agent);
    let model = hint?.model;
    let authoritative = hint !== undefined;
    const get = options.session?.get;
    if ((!parentID || !agent) && typeof get === 'function') {
      try {
        const response = await withProfileTimeout(
          get.call(options.session, { sessionID }),
          'session profile identity lookup timed out',
          PROFILE_OPERATION_TIMEOUT_MS,
          options,
        );
        const info =
          isRecord(response) && isRecord(response.data)
            ? response.data
            : response;
        if (isRecord(info)) {
          if (!parentID) parentID = cleanID(info.parentID);
          if (!agent) agent = cleanID(info.agent);
          model ??= info.model;
          authoritative = true;
        }
      } catch (err) {
        emitLog('[v2][profile] session identity lookup failed', {
          sessionID,
          error: String(err),
        });
      }
    }
    if (!agent) {
      agent = cleanID(options.knownAgent?.(sessionID));
    }
    return {
      ...(parentID ? { parentID } : {}),
      ...(agent ? { agent } : {}),
      model,
      authoritative,
    };
  }

  async function ensure(
    sessionID: string,
    identity?: SessionProfileIdentity,
  ): Promise<void> {
    checkActive();
    const inFlight = pending.get(sessionID);
    if (inFlight) {
      await inFlight;
      return;
    }
    // A previous admission may have timed out, or a revision installation
    // may be running. Neither permits a fresh capture (even a model-less one)
    // to publish a refreshed profile over the unresolved native selection.
    if (switching.has(sessionID))
      throw new Error('Session profile model switch is still in flight');
    const revision = options.revisionForSession?.(sessionID);
    if (captured.has(sessionID) && revisions.get(sessionID) !== revision) {
      captured.delete(sessionID);
      revisions.delete(sessionID);
    }
    if (
      captured.has(sessionID) ||
      ignored.has(sessionID) ||
      deleted.has(sessionID)
    ) {
      return;
    }
    const task = (async () => {
      const resolved = await resolveIdentity(sessionID, identity);
      checkActive();
      if (!resolved.parentID) {
        if (resolved.authoritative) {
          // Proven root session: never profile it.
          ignored.add(sessionID);
          prune();
          return;
        }
        // Reduced/temporarily unavailable host identity surface: the session
        // may be a root or foreign child, so touching or rejecting it would
        // violate isolation. Leave it uncaptured; a creation event can still
        // prove plugin-child identity before a later request.
        return;
      }
      if (!resolved.agent) {
        return;
      }
      if (!options.pluginAgents.has(resolved.agent)) {
        // Foreign-agent child: its sessions are never touched.
        ignored.add(sessionID);
        prune();
        return;
      }

      const profiles = options.profilesForSession
        ? await options.profilesForSession(sessionID)
        : options.profiles();
      checkActive();
      const captureRevision = options.revisionForSession?.(sessionID);
      const profile = profiles[resolved.agent];
      if (!profile) {
        // Plugin-managed but absent from the profile table (e.g. a
        // marketplace-agent child: the registry registers it yet the table
        // is built from createAgents, which has no marketplace handling).
        // Freeze null only after publishing its matching chain generation.
        // A failed publisher rejects admission and must be retried.
        options.onSessionCaptured?.(sessionID);
        checkActive();
        captured.set(sessionID, null);
        revisions.set(sessionID, captureRevision);
        prune();
        emitLog('[v2][profile] child session captured without a profile', {
          sessionID,
          agent: resolved.agent,
        });
        return;
      }
      const registered = options.registeredProfiles?.[resolved.agent]?.model;
      if (
        !profile.model ||
        options.preserveSessionModel?.(sessionID) ||
        (options.registeredProfiles &&
          resolved.model &&
          !sameModel(resolved.model, registered))
      ) {
        // Nothing to switch, or the host already runs a per-call model.
        options.onSessionCaptured?.(sessionID);
        checkActive();
        captured.set(sessionID, profile);
        revisions.set(sessionID, captureRevision);
        prune();
        emitLog('[v2][profile] child session captured without a model switch', {
          sessionID,
          agent: resolved.agent,
        });
        return;
      }
      const switchModel = options.session?.switchModel;
      if (typeof switchModel !== 'function') {
        throw new Error('session.switchModel unavailable for runtime profile');
      }
      // Pin the chain generation at profile-capture time — before the
      // awaited switch — so a refresh landing mid-switch cannot pair the
      // old profile with a newer chain generation.
      options.onSessionCaptured?.(sessionID);
      // Bounded and fail-closed: this rejection propagates to the prompt hook
      // and aborts the admission BEFORE any request can run on the wrong
      // model. A timeout does not release the real native-flight fence.
      const selectedModel = profile.model;
      try {
        const request = startSwitch(sessionID, () =>
          switchModel.call(options.session, {
            sessionID,
            model: selectedModel,
          }),
        );
        await withProfileTimeout(
          request,
          'session profile model switch timed out',
          options.switchTimeoutMs ?? PROFILE_SWITCH_TIMEOUT_MS,
          options,
        );
        checkActive();
      } catch (err) {
        // Aborted admission: no request ran, so releasing the capture-time
        // pin lets the retry pair a fresh capture with the generation
        // current at that retry instead of keeping this attempt's pin.
        options.onSessionCaptureFailed?.(sessionID);
        throw err;
      }
      captured.set(sessionID, profile);
      revisions.set(sessionID, captureRevision);
      prune();
      emitLog('[v2][profile] applied model to child session', {
        sessionID,
        agent: resolved.agent,
        model: profile.model,
      });
    })();
    pending.set(sessionID, task);
    try {
      await task;
    } finally {
      if (pending.get(sessionID) === task) pending.delete(sessionID);
    }
  }

  return {
    retire() {
      retired = true;
    },
    async drain() {
      // retire() prevents queued captures from starting another host call.
      // An unresolved native operation deliberately keeps teardown waiting.
      await Promise.allSettled([...pending.values(), ...switching.values()]);
    },
    assertIdle(sessionID) {
      checkActive();
      if (pending.has(sessionID) || switching.has(sessionID))
        throw new Error('Session profile model switch is still in flight');
    },
    async installSessionProfile(sessionID, profile, revision, model) {
      this.assertIdle(sessionID);
      if (model) {
        const switchModel = options.session?.switchModel;
        if (!switchModel)
          throw new Error('session.switchModel unavailable for transition');
        await withProfileTimeout(
          startSwitch(sessionID, () =>
            switchModel.call(options.session, { sessionID, model }),
          ),
          'session profile model switch timed out',
          options.switchTimeoutMs ?? PROFILE_SWITCH_TIMEOUT_MS,
          options,
        );
      }
      checkActive();
      captured.set(sessionID, profile ?? null);
      revisions.set(sessionID, revision);
      ignored.delete(sessionID);
      prune();
    },
    async observeEvent(event) {
      try {
        if (!isRecord(event)) return;
        if (event.type === 'session.deleted') {
          const payload = resolveV2EventPayload(event);
          const deletedID = payload.sessionID ?? payload.id;
          if (typeof deletedID === 'string' && deletedID) {
            captured.delete(deletedID);
            revisions.delete(deletedID);
            ignored.delete(deletedID);
            deleted.add(deletedID);
            prune();
          }
          return;
        }
        if (event.type !== 'session.created') return;
        // Flat child early-registration shape carries {id, parentID, agent}.
        const payload = isRecord(event.data)
          ? event.data
          : isRecord(event.properties)
            ? event.properties
            : event;
        const sessionID = payload.sessionID ?? payload.id;
        if (typeof sessionID !== 'string' || !sessionID) return;
        deleted.delete(sessionID);
        // The event payload is authoritative for both fields: an absent
        // parentID here means a root session, absent agent means unknown.
        await ensure(sessionID, {
          parentID: cleanID(payload.parentID),
          agent: cleanID(payload.agent),
          model: payload.model,
        });
      } catch (err) {
        emitLog('[v2][profile] bridge failed', String(err));
      }
    },

    async ensureSessionProfile(sessionID, identity) {
      if (typeof sessionID !== 'string' || !sessionID) return;
      await ensure(sessionID, identity);
    },

    profileForSession(sessionID) {
      return captured.get(sessionID) ?? undefined;
    },

    size() {
      return captured.size;
    },
  };
}

/**
 * Carry the set of provider-option keys managed by previous profile
 * generations into the next table. Captured session objects are never mutated;
 * each refresh receives fresh profile records and key arrays.
 */
export function reconcileRuntimeProfileOptionKeys(
  previous: V2AgentRuntimeProfiles,
  next: V2AgentRuntimeProfiles,
): V2AgentRuntimeProfiles {
  return Object.fromEntries(
    [...new Set([...Object.keys(previous), ...Object.keys(next)])].map(
      (agent) => {
        const profile = next[agent] ?? previous[agent];
        const managed = new Set([
          ...(previous[agent]?.managedProviderOptionKeys ?? []),
          ...Object.keys(previous[agent]?.providerOptions ?? {}),
          ...Object.keys(profile.providerOptions ?? {}),
        ]);
        return [
          agent,
          {
            ...profile,
            ...(managed.size > 0
              ? { managedProviderOptionKeys: [...managed].sort() }
              : {}),
          },
        ];
      },
    ),
  );
}

/**
 * Apply a captured profile's temperature/provider options to the context
 * event's mutable `options` record. Only that session's requests are affected;
 * `system`, `messages`, and `tools` are never touched (prompt/tool/prefix
 * bytes stay frozen). Reduced hosts without `options` are left alone.
 */
export function applyRuntimeProfileOptions(
  event: V2SessionContextEvent,
  profile: V2AgentRuntimeProfile | undefined,
  binding?: { inheritedProviderID?: string },
): void {
  if (!profile) return;
  const options = (event as { options?: Record<string, unknown> }).options;
  if (!isRecord(options)) return;
  delete options.temperature;
  if (typeof profile.temperature === 'number') {
    options.temperature = profile.temperature;
  }
  for (const key of new Set([
    ...(profile.managedProviderOptionKeys ?? []),
    ...(binding ? Object.keys(profile.providerOptions ?? {}) : []),
  ])) {
    if (binding && key === 'temperature') continue;
    delete options[key];
  }
  if (binding) {
    const origin = profile.model?.providerID ?? binding.inheritedProviderID;
    if (!origin || origin !== event.model.providerID) return;
  }
  if (profile.providerOptions) {
    for (const [key, value] of Object.entries(profile.providerOptions)) {
      if (binding && key === 'temperature') continue;
      options[key] = value;
    }
  }
}
