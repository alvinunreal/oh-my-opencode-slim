/**
 * Session-frozen v2 runtime profiles.
 *
 * AGENTS.md: system prompts and tool sets stay frozen for the lifetime of a
 * session — so a config/preset change must never rebuild agent definitions or
 * reload the host registry. Instead, the adapter resolves ONLY the
 * inference/runtime fields (model, variant, temperature, provider options)
 * into a per-agent profile, freezes the current profile for each NEW child
 * session, and applies it before that child's first request:
 *
 * - `model`/`variant`: `session.switchModel` for host defaults; per-call models
 *   stay untouched (v2 prompts carry no model) unless the catalog proves one
 *   retired (issue #1689) — then the current profile model is switched in.
 * - `temperature`/provider `options`: mutated onto the context hook's
 *   `options` record for that captured session only (never system/messages/
 *   tools — prompt bytes and tool catalogs stay untouched).
 *
 * Existing/resumed child sessions keep the profile captured when they were
 * first seen; parents and foreign-agent sessions are never touched.
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
 * run on a stale model, and a retry re-awaits the idempotent switch. */
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

/** Extract the `ModelRef` the catalog lookup expects from a session's
 *  model value (v2 spells it `{ providerID, id, variant? }`). */
function modelRefOf(value: unknown): ModelRef | undefined {
  if (!isRecord(value)) return undefined;
  const providerID =
    typeof value.providerID === 'string' && value.providerID.length > 0
      ? value.providerID
      : undefined;
  const id =
    typeof value.id === 'string' && value.id.length > 0 ? value.id : undefined;
  return providerID && id ? { providerID, id } : undefined;
}

async function withProfileTimeout<T>(
  operation: Promise<T>,
  message: string,
  timeoutMs: number = PROFILE_OPERATION_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
  /** Catalog check for a differing child model: `false` = provably retired
   *  (switch to the current profile); `true`/`undefined` = keep the child's
   *  model. Implementations must bound their own I/O (issue #1689). */
  isModelAvailable?: (
    ref: ModelRef,
  ) => boolean | undefined | Promise<boolean | undefined>;
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
}

/**
 * Identity fields the child gate keys on. `session.created` payloads carry
 * `{parentID, agent}`; the awaited `session.prompt` hook carries neither, so
 * the prompt path resolves them through `session.get` (and the prompt
 * bridge's learned agent as a fallback).
 */
interface SessionProfileIdentity {
  parentID?: string;
  agent?: string;
  model?: unknown;
  /** The hint IS the host's own identity read for this admission (from
   * the session-preset `ensureAdmission` transaction): field absences are
   * definitive — a missing `parentID` is a proven root — and the host is
   * NOT re-consulted to fill missing fields. Omitted hints (event
   * prewarm) keep the re-read enrichment behavior. */
  authoritative?: boolean;
}

/**
 * Per-admission capture input: the per-session profile table already
 * bound by the SAME admission transaction (derived from the session
 * preset record). Supplied only alongside an `authoritative` identity,
 * it replaces the `profilesForSession` read so one admission performs
 * one identity lookup and one KV lookup total.
 */
interface SessionProfileCapture {
  profiles: V2AgentRuntimeProfiles;
}

export interface SessionProfileBridge {
  /** Observe one raw v2 event (prewarm/cleanup path); never throws. */
  observeEvent(event: Record<string, unknown>): Promise<void>;
  /**
   * Idempotent capture-and-switch for ONE session, awaited on the request
   * path (the native `session.prompt` hook) before the admission's first
   * model request. When `identity` is omitted, `session.get` resolves the
   * session's `parentID`/`agent`. An `authoritative` identity (from the
   * session-preset `ensureAdmission` transaction) is used as-is — a
   * missing `parentID` is a proven root and the host is not re-read —
   * and `capture` supplies profiles already bound by that same
   * transaction so the admission performs one identity lookup and one
   * KV lookup total. For an identified plugin child, model
   * switching is fully awaited and a failed switch rejects the admission;
   * unknown identity remains untouched because it may be a root or foreign
   * session. Once captured (or proven root/foreign) the call is O(1).
   */
  ensureSessionProfile(
    sessionID: string,
    identity?: SessionProfileIdentity,
    capture?: SessionProfileCapture,
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
  const emitLog = options.log ?? (() => {});

  function prune(): void {
    while (captured.size > MAX_PROFILE_SESSIONS) {
      const oldest = captured.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      captured.delete(oldest);
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
    // An authoritative hint IS the host identity read for this admission:
    // re-reading the host could only duplicate it. Missing fields stay
    // definitive (absent parentID = root); the known-agent fallback below
    // still applies. Event hints (no flag) keep the enriching re-read.
    if (
      hint?.authoritative !== true &&
      (!parentID || !agent) &&
      typeof get === 'function'
    ) {
      try {
        const response = await withProfileTimeout(
          get.call(options.session, { sessionID }),
          'session profile identity lookup timed out',
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
    capture?: SessionProfileCapture,
  ): Promise<void> {
    if (
      captured.has(sessionID) ||
      ignored.has(sessionID) ||
      deleted.has(sessionID)
    ) {
      return;
    }
    const inFlight = pending.get(sessionID);
    if (inFlight) {
      await inFlight;
      return;
    }
    const task = (async () => {
      const resolved = await resolveIdentity(sessionID, identity);
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

      // Per-admission capture: profiles already bound by the same
      // transaction as `identity` (a session-preset record's merged
      // table). Never a persistent cache — the capture is only the
      // admission-local reuse of a value the caller already read.
      const profiles =
        capture?.profiles ??
        (options.profilesForSession
          ? await options.profilesForSession(sessionID)
          : options.profiles());
      const profile = profiles[resolved.agent];
      if (!profile) {
        // Plugin-managed but absent from the profile table (e.g. a
        // marketplace-agent child: the registry registers it yet the table
        // is built from createAgents, which has no marketplace handling).
        // Freeze null so admission proceeds on the host-registered model
        // with no temperature/options applied — never reject the prompt hook.
        captured.set(sessionID, null);
        options.onSessionCaptured?.(sessionID);
        prune();
        emitLog('[v2][profile] child session captured without a profile', {
          sessionID,
          agent: resolved.agent,
        });
        return;
      }
      const registered = options.registeredProfiles?.[resolved.agent]?.model;
      // A differing child model is a per-call override and kept — unless the
      // catalog proves it retired (issue #1689); unknown keeps it, so this
      // only ever switches away from a provably retired model. The cheap
      // guards fold in first so a discarded decision never pays the lookup.
      const perCallCandidate = Boolean(
        profile.model &&
          !options.preserveSessionModel?.(sessionID) &&
          options.registeredProfiles &&
          resolved.model &&
          !sameModel(resolved.model, registered),
      );
      let keepPerCallModel = false;
      if (perCallCandidate) {
        const ref = modelRefOf(resolved.model);
        let live: boolean | undefined;
        try {
          live = ref ? await options.isModelAvailable?.(ref) : undefined;
        } catch (err) {
          emitLog('[v2][profile] model catalog lookup failed', {
            sessionID,
            error: String(err),
          });
          live = undefined;
        }
        keepPerCallModel = live !== false;
      }
      if (
        !profile.model ||
        options.preserveSessionModel?.(sessionID) ||
        keepPerCallModel
      ) {
        // Nothing to switch, or the host already runs a per-call model.
        captured.set(sessionID, profile);
        options.onSessionCaptured?.(sessionID);
        prune();
        emitLog('[v2][profile] child session captured without a model switch', {
          sessionID,
          agent: resolved.agent,
        });
        return;
      }
      // A rejected stale pin must land on a live model: the stored team's
      // frozen profile can name the same retired model as the pin (both
      // froze at creation), so refresh onto the current profile model
      // instead (issue #1689). Capture that whole current profile so the
      // session's temperature/provider options follow the live model rather
      // than the retired one's.
      const currentProfile =
        perCallCandidate && !keepPerCallModel
          ? options.profiles()[resolved.agent]
          : undefined;
      const appliedProfile = currentProfile?.model ? currentProfile : profile;
      const targetModel = currentProfile?.model ?? profile.model;
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
      // model. The host call cannot be cancelled, but a late switch can only
      // affect a later retry, which re-awaits the same idempotent call.
      try {
        await withProfileTimeout(
          switchModel.call(options.session, {
            sessionID,
            model: targetModel,
          }),
          'session profile model switch timed out',
          options.switchTimeoutMs ?? PROFILE_SWITCH_TIMEOUT_MS,
        );
      } catch (err) {
        // Aborted admission: no request ran, so releasing the capture-time
        // pin lets the retry pair a fresh capture with the generation
        // current at that retry instead of keeping this attempt's pin.
        options.onSessionCaptureFailed?.(sessionID);
        throw err;
      }
      captured.set(sessionID, appliedProfile);
      prune();
      emitLog('[v2][profile] applied model to child session', {
        sessionID,
        agent: resolved.agent,
        model: appliedProfile.model,
      });
    })();
    pending.set(sessionID, task);
    try {
      await task;
    } finally {
      pending.delete(sessionID);
    }
  }

  return {
    async observeEvent(event) {
      try {
        if (!isRecord(event)) return;
        if (event.type === 'session.deleted') {
          const payload = resolveV2EventPayload(event);
          const deletedID = payload.sessionID ?? payload.id;
          if (typeof deletedID === 'string' && deletedID) {
            captured.delete(deletedID);
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

    async ensureSessionProfile(sessionID, identity, capture) {
      if (typeof sessionID !== 'string' || !sessionID) return;
      await ensure(sessionID, identity, capture);
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
