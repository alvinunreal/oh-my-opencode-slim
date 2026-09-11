/**
 * Periodic orchestrator wake scheduler.
 *
 * After continuous parent-idle time, capability-gated host session APIs may
 * receive a static internal wake prompt when incomplete todos remain. Active
 * children suppress periodic wakes. Host responses are authoritative; the local
 * job board is never consulted. Progress/reservation state is process-global
 * so independently created hook instances share one-flight and the two-wake
 * no-progress cap.
 *
 * v2 hosts (hostFlavor 'v2', stamped by the client shim) have no todo/
 * children/status surfaces, so the scheduler runs there in a children-driven
 * degraded mode: children are enumerated via `session.list({parentID})`
 * (event-tracked fallback when the listing is unavailable), the wake
 * condition is "children without a terminal outcome" plus stopped-job
 * recovery, and the wake prompt is delivered with `delivery: 'queue'`
 * (v1 prompt_async queued; v2 steer would hijack an in-flight run). All new
 * behavior is behind the host-flavor/capability probe — the v1 code path is
 * unchanged.
 */
import type { PluginInput } from '@opencode-ai/plugin';
import type { OpencodeClient } from '@opencode-ai/sdk';
import {
  createInternalAgentTextPart,
  isInternalInitiatorPart,
} from '../../utils';
import { isRecord as isObjectRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import type { SessionLifecycle } from '../session-lifecycle';
import {
  type ContinuationModelSelection,
  parseContinuationModelSelection,
} from '../task-session-manager/continuation-model-selection';
import { isActiveStatus } from '../task-session-manager/status-utils';
import {
  clearExpectingWakeBusy,
  clearWakeSession,
  commitWakeReservation,
  getObservedWakeModel,
  getWakeProgress,
  isExpectingWakeBusy,
  noteHostProgress,
  rearmWakeProgress,
  releaseWakeEvaluation,
  retryAfterWakeEvaluation,
  setObservedWakeModel,
  tryBeginWakeEvaluation,
} from './wake-gate';

export const ORCHESTRATOR_WAKE_TEXT =
  '<system-reminder>\nFinish any incomplete TODOs. Await running agents; if one appears stuck, assess it and cancel/respawn only when justified. Do not respond to this reminder.\n</system-reminder>';

export const ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT =
  '<system-reminder>\nA background job stopped without a terminal result. Consult the Background Job Board, recover or reroute the work as needed, and do not wait for that job as if it were still running. Do not respond to this reminder.\n</system-reminder>';

/** Children-mode variant (v2 degraded mode): watchdog over background
 * children and unreconciled jobs instead of the todo list. */
export const ORCHESTRATOR_CHILDREN_WAKE_TEXT =
  '<system-reminder>\nCheck on unfinished background child sessions and unreconciled jobs. Await running agents; if one appears stuck, assess it and cancel/respawn only when justified. Do not respond to this reminder.\n</system-reminder>';

/** After this many successful wakes with an unchanged fingerprint, stop. */
export const ORCHESTRATOR_WAKE_UNCHANGED_CAP = 2;

/**
 * Children-driven mode: a child with `outcome === undefined` counts as
 * inactive once its newest update evidence (host `time.updated` or a
 * tracked status change) is older than this multiple of the wake interval.
 * Bounds wakes when a child crashes mid-run without recording an outcome;
 * stopped-job recovery remains the explicit path for such children.
 */
export const CHILD_STALENESS_INTERVALS = 3;

const SUPPORTED_TODO_STATUSES = new Set([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]);

type SessionClient = OpencodeClient['session'];

/** Todo-mode host snapshot (v1): todos + children + live status map. */
type TodoModeSnapshot = {
  kind: 'todo';
  todos: Array<Record<string, unknown>>;
  children: Array<Record<string, unknown>>;
  status: Record<string, unknown>;
  model?: ContinuationModelSelection;
};

/** Children-mode snapshot (v2 degraded mode / explicit 'children'). */
type ChildrenModeSnapshot = {
  kind: 'children';
  children: Array<WakeChildInfo>;
  /** v1 status-map parent activity (v2 has no status map; the event-tracked
   * race guard covers it). */
  hostParentActive: boolean;
  model?: ContinuationModelSelection;
};

type WakeSnapshot = TodoModeSnapshot | ChildrenModeSnapshot;

/** Checkpoint verdict shared by both wake modes. */
type SnapshotVerdict = 'parent-active' | 'children-active' | 'no-work' | 'wake';

type LocalSessionState = {
  /** Invalidates local timers/async work for this hook instance. */
  generation: symbol;
  timer: ReturnType<typeof setTimeout> | undefined;
  continuousIdle: boolean;
};

export type OrchestratorWakeConfig = {
  enabled: boolean;
  intervalMs: number;
  /** Wake-condition source; resolved against host capabilities (see
   * `resolveWakeMode`). Optional for callers built before the field
   * existed — absent means 'auto'. */
  mode?: 'auto' | 'todo' | 'children';
};

export type OrchestratorWakeOptions = {
  config: OrchestratorWakeConfig;
  shouldManageSession: (sessionID: string) => boolean;
  hasInputWait: (sessionID: string) => boolean;
  isFallbackInProgress?: (sessionID: string) => boolean;
  coordinator?: SessionLifecycle;
  /** Test seam: override interval without changing config validation. */
  intervalMs?: number;
};

/**
 * Capability record for the host session surface. The v1 branch keeps
 * exactly the historical probe set (get/todo/children/status/promptAsync);
 * the v2 branch (hostFlavor 'v2', stamped by the client shim) requires only
 * list+promptAsync — `get` is optional enrichment and todo/children/status
 * have no v2 equivalent (children-driven degraded mode covers them).
 */
export type WakeSessionApis = {
  flavor: 'v1' | 'v2';
  hasGet: boolean;
  hasTodo: boolean;
  hasChildren: boolean;
  hasStatus: boolean;
  hasList: boolean;
  hasPromptAsync: boolean;
  /** True when the scheduler can operate against this host surface. */
  ready: boolean;
};

function probeSessionApis(
  session: SessionClient | undefined,
  hostFlavor: string | undefined,
): WakeSessionApis {
  const flavor = hostFlavor === 'v2' ? ('v2' as const) : ('v1' as const);
  const caps = {
    flavor,
    hasGet: typeof session?.get === 'function',
    hasTodo: typeof session?.todo === 'function',
    hasChildren: typeof session?.children === 'function',
    hasStatus: typeof session?.status === 'function',
    hasList: typeof session?.list === 'function',
    hasPromptAsync: typeof session?.promptAsync === 'function',
  } as WakeSessionApis;
  caps.ready =
    flavor === 'v2'
      ? caps.hasList && caps.hasPromptAsync
      : caps.hasGet &&
        caps.hasTodo &&
        caps.hasChildren &&
        caps.hasStatus &&
        caps.hasPromptAsync;
  return caps;
}

export type ResolvedWakeMode = 'todo' | 'children';

/**
 * Resolve the configured wake mode against host capabilities: 'auto' uses
 * todo-gating on v1 and children-driven degraded mode on v2; an explicit
 * 'todo' degrades to children on hosts without the todo API (v2).
 */
export function resolveWakeMode(
  configured: 'auto' | 'todo' | 'children' | undefined,
  caps: Pick<WakeSessionApis, 'flavor' | 'hasTodo'>,
): ResolvedWakeMode {
  if (configured === 'children') return 'children';
  if (configured === 'todo') {
    return caps.flavor === 'v2' || !caps.hasTodo ? 'children' : 'todo';
  }
  return caps.flavor === 'v2' ? 'children' : 'todo';
}

/** Normalized child view for children-driven wake decisions. */
export type WakeChildInfo = {
  id: string;
  /** v2 Session.Info.outcome — present only on terminal transition
   * (succeeded|failed|interrupted). */
  outcome?: string;
  /** Workspace directory when the host reports it (scope filter). */
  directory?: string;
  /** Newest update-evidence timestamp (epoch ms) when known. */
  evidenceAt?: number;
};

/** Event-tracked session status (busy-set + parent-active race guard). */
export type TrackedSessionStatus = { status: 'busy' | 'idle'; at: number };

/** Numeric variant of the update-evidence cascade (staleness bound). */
export function childUpdateEvidenceMs(
  child: Record<string, unknown>,
): number | undefined {
  const time = isObjectRecord(child.time) ? child.time : undefined;
  const candidates = [
    time?.updated,
    time?.completed,
    child.updatedAt,
    child.updated,
    time?.created,
    child.createdAt,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

/** Map one host child/list entry to the normalized children-mode view. */
export function mapWakeChild(
  child: Record<string, unknown>,
): WakeChildInfo | undefined {
  if (typeof child.id !== 'string' || !child.id) return undefined;
  const info: WakeChildInfo = { id: child.id };
  if (typeof child.outcome === 'string' && child.outcome) {
    info.outcome = child.outcome;
  }
  if (typeof child.directory === 'string' && child.directory) {
    info.directory = child.directory;
  }
  const evidence = childUpdateEvidenceMs(child);
  if (evidence !== undefined) {
    info.evidenceAt = evidence;
  }
  return info;
}

/**
 * Active-child determination for children-driven mode: a terminal outcome
 * always wins; otherwise the child is active while its newest evidence —
 * host update time OR tracked status change (the event busy-set) — is
 * fresher than the staleness bound. Children with no evidence at all are
 * inactive (cannot be proven active).
 */
export function isWakeChildActive(
  child: WakeChildInfo,
  tracked: TrackedSessionStatus | undefined,
  now: number,
  stalenessMs: number,
): boolean {
  if (child.outcome !== undefined) return false;
  const evidenceAt = Math.max(child.evidenceAt ?? 0, tracked?.at ?? 0);
  if (evidenceAt <= 0) return false;
  return now - evidenceAt <= stalenessMs;
}

/** Children-mode fingerprint: id + outcome + tracked status + evidence. */
export function buildChildrenWakeFingerprint(
  children: Array<WakeChildInfo>,
  trackedStatuses: ReadonlyMap<string, TrackedSessionStatus>,
): string {
  return children
    .map((child) => {
      const tracked = trackedStatuses.get(child.id);
      return [
        child.id,
        child.outcome ?? '',
        tracked?.status ?? '',
        String(child.evidenceAt ?? ''),
      ].join(':');
    })
    .sort()
    .join('\n');
}

function isIncompleteTodoStatus(status: string): boolean {
  return status === 'pending' || status === 'in_progress';
}

function todosHaveValidStatuses(
  todos: Array<Record<string, unknown>>,
): boolean {
  return todos.every(
    (todo) =>
      typeof todo.status === 'string' &&
      SUPPORTED_TODO_STATUSES.has(todo.status),
  );
}

function hasIncompleteTodos(todos: Array<Record<string, unknown>>): boolean {
  return todos.some(
    (todo) =>
      typeof todo.status === 'string' && isIncompleteTodoStatus(todo.status),
  );
}

function hasActiveChild(
  children: Array<Record<string, unknown>>,
  status: Record<string, unknown>,
): boolean {
  return children.some(
    (child) => typeof child.id === 'string' && isActiveStatus(status, child.id),
  );
}

function todoFingerprint(todos: Array<Record<string, unknown>>): string {
  return todos
    .map((todo) => {
      const id =
        typeof todo.id === 'string'
          ? todo.id
          : typeof todo.content === 'string'
            ? todo.content
            : '';
      return `${id}:${String(todo.status)}`;
    })
    .sort()
    .join('\n');
}

function childUpdateEvidence(child: Record<string, unknown>): string {
  const time = isObjectRecord(child.time) ? child.time : undefined;
  const candidates = [
    time?.updated,
    time?.completed,
    child.updatedAt,
    child.updated,
    time?.created,
    child.createdAt,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' || typeof value === 'string') {
      return String(value);
    }
  }
  return '';
}

function childStatusEvidence(
  childID: string,
  status: Record<string, unknown>,
): string {
  if (!Object.hasOwn(status, childID)) return 'absent';
  const entry = status[childID];
  if (!isObjectRecord(entry)) return 'malformed';
  return typeof entry.type === 'string' ? entry.type : 'active';
}

function childrenFingerprint(
  children: Array<Record<string, unknown>>,
  status: Record<string, unknown>,
): string {
  return children
    .map((child) => {
      const id = String(child.id);
      return `${id}:${childStatusEvidence(id, status)}:${childUpdateEvidence(child)}`;
    })
    .sort()
    .join('\n');
}

export function buildOrchestratorWakeFingerprint(
  todos: Array<Record<string, unknown>>,
  children: Array<Record<string, unknown>>,
  status: Record<string, unknown>,
): string {
  return `${todoFingerprint(todos)}\n--\n${childrenFingerprint(children, status)}`;
}

function extractSessionID(event: {
  properties?: { info?: { id?: string }; sessionID?: string };
}): string | undefined {
  return event.properties?.info?.id || event.properties?.sessionID;
}

function isIdleEvent(
  type: string,
  properties?: { status?: { type?: string } },
) {
  return (
    type === 'session.idle' ||
    (type === 'session.status' && properties?.status?.type === 'idle')
  );
}

function isBusyEvent(
  type: string,
  properties?: { status?: { type?: string } },
): boolean {
  return type === 'session.status' && properties?.status?.type === 'busy';
}

function isInputWaitAskEvent(type: string): boolean {
  return type === 'permission.asked' || type === 'question.asked';
}

export function createOrchestratorWakeScheduler(
  ctx: PluginInput,
  options: OrchestratorWakeOptions,
) {
  const intervalMs = options.intervalMs ?? options.config.intervalMs;
  const enabled = options.config.enabled === true;
  const directory = ctx.directory;
  const sessionSdk = (ctx.client as OpencodeClient).session;

  /** Static host-surface capability record (the client never changes). */
  const capabilities = probeSessionApis(
    sessionSdk,
    (ctx as PluginInput & { hostFlavor?: string }).hostFlavor,
  );
  const wakeMode = resolveWakeMode(options.config.mode, capabilities);
  if (enabled && capabilities.flavor === 'v2' && !capabilities.hasTodo) {
    log(
      '[orchestrator-wake] host provides no session todo API; running in children-driven degraded mode',
      { directory },
    );
  }

  /** Local timer/generation state only; progress lives in the process gate. */
  const localSessions = new Map<string, LocalSessionState>();
  /** Reservations this hook owns and must release when it is disposed. */
  const localWakeOwners = new Map<string, symbol>();
  const pendingStoppedRecoveries = new Set<string>();
  /** Event-tracked session statuses (busy-set + parent race guard). */
  const lastStatusBySession = new Map<string, TrackedSessionStatus>();
  /** parentID → child session ids observed via session.created events. */
  const childSessions = new Map<string, Set<string>>();
  /** Newest event evidence (created/status change) per child, epoch ms. */
  const childEvidence = new Map<string, number>();
  let disposed = false;

  /** Bound for the event-tracked bookkeeping maps (FIFO eviction). */
  const MAX_EVENT_TRACKED_SESSIONS = 512;

  function boundTrackedMap<T>(map: Map<string, T>): void {
    while (map.size > MAX_EVENT_TRACKED_SESSIONS) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  function recordTrackedStatus(
    sessionID: string,
    status: 'busy' | 'idle',
  ): void {
    const now = Date.now();
    lastStatusBySession.set(sessionID, { status, at: now });
    boundTrackedMap(lastStatusBySession);
    if (childEvidence.has(sessionID)) {
      childEvidence.set(sessionID, now);
      boundTrackedMap(childEvidence);
    }
  }

  function recordChildSession(parentID: string, childID: string): void {
    let kids = childSessions.get(parentID);
    if (!kids) {
      kids = new Set();
      childSessions.set(parentID, kids);
      boundTrackedMap(childSessions);
    }
    kids.add(childID);
    childEvidence.set(childID, Date.now());
    boundTrackedMap(childEvidence);
  }

  function forgetSessionEvents(sessionID: string): void {
    lastStatusBySession.delete(sessionID);
    childEvidence.delete(sessionID);
    childSessions.delete(sessionID);
    for (const kids of childSessions.values()) {
      kids.delete(sessionID);
    }
  }

  function isParentActiveByEvents(sessionID: string): boolean {
    return lastStatusBySession.get(sessionID)?.status === 'busy';
  }

  function touchLocal(sessionID: string): LocalSessionState {
    const existing = localSessions.get(sessionID);
    if (existing) return existing;
    const created: LocalSessionState = {
      generation: Symbol(sessionID),
      timer: undefined,
      continuousIdle: false,
    };
    localSessions.set(sessionID, created);
    return created;
  }

  function clearTimer(state: LocalSessionState): void {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  }

  function bumpGeneration(state: LocalSessionState): void {
    state.generation = Symbol('wake-generation');
  }

  function clearLocalSession(sessionID: string): void {
    const state = localSessions.get(sessionID);
    if (!state) return;
    clearTimer(state);
    bumpGeneration(state);
    localSessions.delete(sessionID);
  }

  function releaseLocalWakeOwner(sessionID: string): void {
    const owner = localWakeOwners.get(sessionID);
    if (!owner) return;
    localWakeOwners.delete(sessionID);
    releaseWakeEvaluation(sessionID, owner);
  }

  function clearSession(sessionID: string): void {
    releaseLocalWakeOwner(sessionID);
    clearLocalSession(sessionID);
    clearWakeSession(sessionID);
    pendingStoppedRecoveries.delete(sessionID);
  }

  /**
   * Suppress scheduling without dropping process-global progress.
   * Used for input waits and temporary blocks.
   */
  function suppress(sessionID: string): void {
    const state = localSessions.get(sessionID);
    if (!state) return;
    clearTimer(state);
    bumpGeneration(state);
    state.continuousIdle = false;
    releaseLocalWakeOwner(sessionID);
  }

  /**
   * End a continuous idle spell. When `rearmProgress` is true, reset the
   * process-global no-progress cap (external busy / lifecycle). Wake-initiated
   * busy must pass false so the two-wake cap survives busy→idle.
   */
  function endIdleSpell(sessionID: string, rearmProgress: boolean): void {
    const state = localSessions.get(sessionID);
    if (state) {
      clearTimer(state);
      bumpGeneration(state);
      state.continuousIdle = false;
    }
    releaseLocalWakeOwner(sessionID);
    if (rearmProgress) rearmWakeProgress(sessionID);
  }

  function canSchedule(sessionID: string): boolean {
    if (!enabled) return false;
    if (!capabilities.ready) return false;
    if (!options.shouldManageSession(sessionID)) return false;
    if (options.hasInputWait(sessionID)) return false;
    if (options.isFallbackInProgress?.(sessionID)) return false;
    if (getWakeProgress(sessionID).stopped) return false;
    return true;
  }

  function schedule(sessionID: string): void {
    if (!canSchedule(sessionID)) return;
    const state = touchLocal(sessionID);
    if (!state.continuousIdle || state.timer !== undefined) return;
    if (getWakeProgress(sessionID).stopped) return;

    const generation = state.generation;
    const timer = setTimeout(() => {
      state.timer = undefined;
      if (state.generation !== generation) return;
      void evaluate(sessionID, generation);
    }, intervalMs);
    timer.unref?.();
    state.timer = timer;
  }

  function beginContinuousIdle(sessionID: string): void {
    if (!canSchedule(sessionID)) return;
    const state = touchLocal(sessionID);
    if (state.continuousIdle && state.timer !== undefined) return;
    state.continuousIdle = true;
    if (getWakeProgress(sessionID).stopped) return;
    if (state.timer === undefined) schedule(sessionID);
  }

  /** Fail-soft session-model enrichment (v2 `get` is optional). */
  async function readSessionModel(
    sessionID: string,
  ): Promise<ContinuationModelSelection | undefined> {
    if (typeof sessionSdk?.get !== 'function') return undefined;
    try {
      const sessionResponse = await sessionSdk.get({
        path: { id: sessionID },
        query: { directory },
        throwOnError: true,
      });
      // Session.model is version-dependent; read via record shape.
      const session = isObjectRecord(sessionResponse?.data)
        ? sessionResponse.data
        : undefined;
      return parseContinuationModelSelection(
        session ? (session as Record<string, unknown>).model : undefined,
      );
    } catch {
      // Model enrichment is fail-soft.
      return undefined;
    }
  }

  async function readHostSnapshot(
    sessionID: string,
  ): Promise<TodoModeSnapshot | undefined> {
    if (!capabilities.ready) return undefined;

    const dirQuery = { directory };
    const [todoResponse, childrenResponse, statusResponse] = await Promise.all([
      sessionSdk.todo({
        path: { id: sessionID },
        query: dirQuery,
        throwOnError: true,
      }),
      sessionSdk.children({
        path: { id: sessionID },
        query: dirQuery,
        throwOnError: true,
      }),
      sessionSdk.status({
        query: dirQuery,
        throwOnError: true,
      }),
    ]);

    if (
      !Array.isArray(todoResponse.data) ||
      !Array.isArray(childrenResponse.data) ||
      !isObjectRecord(statusResponse.data)
    ) {
      return undefined;
    }

    const todos = todoResponse.data;
    const children = childrenResponse.data;
    const status = statusResponse.data;

    if (
      !todos.every(
        (todo) => isObjectRecord(todo) && typeof todo.status === 'string',
      ) ||
      !todosHaveValidStatuses(todos as Array<Record<string, unknown>>) ||
      !children.every(
        (child) => isObjectRecord(child) && typeof child.id === 'string',
      )
    ) {
      return undefined;
    }

    const model = await readSessionModel(sessionID);

    return {
      kind: 'todo',
      todos: todos as Array<Record<string, unknown>>,
      children: children as Array<Record<string, unknown>>,
      status,
      model,
    };
  }

  /**
   * Children-driven degraded mode snapshot (v2, or explicit 'children' on
   * v1). Children are enumerated via `session.list({parentID})` through the
   * shim; when the listing is unavailable (missing/erroring/empty) the
   * event-tracked bookkeeping (session.created parentID links + tracked
   * statuses) is the fallback. Results are scoped to this workspace and
   * enriched with the session model (fail-soft).
   */
  async function readChildrenSnapshot(
    sessionID: string,
  ): Promise<ChildrenModeSnapshot | undefined> {
    if (!capabilities.ready) return undefined;

    let children: Array<WakeChildInfo> | undefined;
    let hostParentActive = false;

    if (capabilities.flavor === 'v2') {
      try {
        const response = (await sessionSdk.list({
          query: { parentID: sessionID, directory },
        } as Parameters<SessionClient['list']>[0])) as { data?: unknown };
        if (Array.isArray(response?.data)) {
          children = response.data
            .filter(isObjectRecord)
            .map(mapWakeChild)
            .filter((child): child is WakeChildInfo => child !== undefined);
        }
      } catch (error) {
        log(
          '[orchestrator-wake] session.list child enumeration failed; using event-tracked fallback',
          {
            sessionID,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    } else {
      const dirQuery = { directory };
      const [childrenResponse, statusResponse] = await Promise.all([
        sessionSdk.children({
          path: { id: sessionID },
          query: dirQuery,
          throwOnError: true,
        }),
        sessionSdk.status({
          query: dirQuery,
          throwOnError: true,
        }),
      ]);
      if (
        !Array.isArray(childrenResponse.data) ||
        !isObjectRecord(statusResponse.data)
      ) {
        return undefined;
      }
      if (
        !childrenResponse.data.every(
          (child) => isObjectRecord(child) && typeof child.id === 'string',
        )
      ) {
        return undefined;
      }
      children = childrenResponse.data
        .filter(isObjectRecord)
        .map(mapWakeChild)
        .filter((child): child is WakeChildInfo => child !== undefined);
      hostParentActive = isActiveStatus(statusResponse.data, sessionID);
    }

    if (children === undefined || children.length === 0) {
      const trackedKids = childSessions.get(sessionID);
      children = trackedKids
        ? [...trackedKids].map((id) => {
            const evidenceAt = childEvidence.get(id);
            return evidenceAt === undefined ? { id } : { id, evidenceAt };
          })
        : [];
    }

    // Workspace scoping: drop children the host reports under another
    // directory (only when the info is available).
    children = children.filter(
      (child) => child.directory === undefined || child.directory === directory,
    );

    const model = await readSessionModel(sessionID);

    return { kind: 'children', children, hostParentActive, model };
  }

  /** Active-child check for children-driven mode (see isWakeChildActive). */
  function hasActiveWakeChild(children: Array<WakeChildInfo>): boolean {
    const now = Date.now();
    const stalenessMs = intervalMs * CHILD_STALENESS_INTERVALS;
    return children.some((child) =>
      isWakeChildActive(
        child,
        lastStatusBySession.get(child.id),
        now,
        stalenessMs,
      ),
    );
  }

  /**
   * Classify a snapshot at a wake checkpoint. The todo branch is the exact
   * v1 check sequence (host status map → active-child suppression →
   * incomplete-todo condition); children mode replaces the status-map
   * lookups with the event-tracked parent guard and the outcome-based child
   * check (active children ARE the wake condition there — recovery wakes
   * bypass it, as on v1).
   */
  function classifyTodoSnapshot(
    snapshot: TodoModeSnapshot,
    sessionID: string,
    recoveryWake: boolean,
  ): SnapshotVerdict {
    if (isActiveStatus(snapshot.status, sessionID)) return 'parent-active';
    if (!recoveryWake && hasActiveChild(snapshot.children, snapshot.status)) {
      return 'children-active';
    }
    if (!recoveryWake && !hasIncompleteTodos(snapshot.todos)) {
      return 'no-work';
    }
    return 'wake';
  }

  function classifyChildrenSnapshot(
    snapshot: ChildrenModeSnapshot,
    sessionID: string,
    recoveryWake: boolean,
  ): SnapshotVerdict {
    if (snapshot.hostParentActive || isParentActiveByEvents(sessionID)) {
      return 'parent-active';
    }
    if (!recoveryWake && !hasActiveWakeChild(snapshot.children)) {
      return 'no-work';
    }
    return 'wake';
  }

  function classifySnapshot(
    snapshot: WakeSnapshot,
    sessionID: string,
    recoveryWake: boolean,
  ): SnapshotVerdict {
    return snapshot.kind === 'children'
      ? classifyChildrenSnapshot(snapshot, sessionID, recoveryWake)
      : classifyTodoSnapshot(snapshot, sessionID, recoveryWake);
  }

  function buildSnapshotFingerprint(snapshot: WakeSnapshot): string {
    return snapshot.kind === 'children'
      ? buildChildrenWakeFingerprint(snapshot.children, lastStatusBySession)
      : buildOrchestratorWakeFingerprint(
          snapshot.todos,
          snapshot.children,
          snapshot.status,
        );
  }

  /** Apply a checkpoint verdict; false means the evaluation ended. */
  function applySnapshotVerdict(
    sessionID: string,
    verdict: SnapshotVerdict,
  ): boolean {
    if (verdict === 'parent-active') {
      endIdleSpell(sessionID, true);
      return false;
    }
    if (verdict === 'children-active') {
      schedule(sessionID);
      return false;
    }
    if (verdict === 'no-work') {
      // No incomplete work: end the spell; do not keep polling.
      endIdleSpell(sessionID, false);
      return false;
    }
    return true;
  }

  async function evaluate(
    sessionID: string,
    generation: symbol,
    recoveryWake = false,
  ): Promise<void> {
    const state = localSessions.get(sessionID);
    if (!state || state.generation !== generation) return;
    if (!state.continuousIdle) return;
    if (!canSchedule(sessionID)) {
      suppress(sessionID);
      return;
    }

    const owner = tryBeginWakeEvaluation(sessionID);
    if (!owner) {
      retryAfterWakeEvaluation(sessionID, () => {
        const current = localSessions.get(sessionID);
        if (
          current === state &&
          current.generation === generation &&
          current.continuousIdle
        ) {
          void evaluate(sessionID, generation, recoveryWake);
        }
      });
      return;
    }
    localWakeOwners.set(sessionID, owner);

    try {
      const snapshot =
        wakeMode === 'children'
          ? await readChildrenSnapshot(sessionID)
          : await readHostSnapshot(sessionID);
      if (!snapshot || state.generation !== generation) return;
      if (!state.continuousIdle) return;
      if (!canSchedule(sessionID)) {
        suppress(sessionID);
        return;
      }

      if (
        !applySnapshotVerdict(
          sessionID,
          classifySnapshot(snapshot, sessionID, recoveryWake),
        )
      ) {
        return;
      }

      const fingerprint = buildSnapshotFingerprint(snapshot);
      noteHostProgress(sessionID, fingerprint);

      const progress = getWakeProgress(sessionID);
      if (
        progress.stopped ||
        (progress.lastFingerprint === fingerprint &&
          progress.unchangedWakeCount >= ORCHESTRATOR_WAKE_UNCHANGED_CAP)
      ) {
        progress.stopped = true;
        state.continuousIdle = false;
        return;
      }

      // Recheck host status/waits immediately before promptAsync.
      const latest =
        wakeMode === 'children'
          ? await readChildrenSnapshot(sessionID)
          : await readHostSnapshot(sessionID);
      if (!latest || state.generation !== generation) return;
      if (!state.continuousIdle) return;
      if (!canSchedule(sessionID)) {
        suppress(sessionID);
        return;
      }
      if (
        !applySnapshotVerdict(
          sessionID,
          classifySnapshot(latest, sessionID, recoveryWake),
        )
      ) {
        return;
      }

      const latestFingerprint = buildSnapshotFingerprint(latest);
      noteHostProgress(sessionID, latestFingerprint);

      const latestProgress = getWakeProgress(sessionID);
      if (
        latestProgress.stopped ||
        latestProgress.unchangedWakeCount >= ORCHESTRATOR_WAKE_UNCHANGED_CAP
      ) {
        latestProgress.stopped = true;
        state.continuousIdle = false;
        return;
      }

      const modelSelection =
        latest.model ?? snapshot.model ?? getObservedWakeModel(sessionID);

      // Reserve before promptAsync so a failed call cannot storm retries and
      // concurrent hook instances cannot double-wake.
      if (!commitWakeReservation(sessionID, owner, latestFingerprint)) {
        return;
      }

      if (!capabilities.ready) return;

      const wakeText = recoveryWake
        ? ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT
        : wakeMode === 'children'
          ? ORCHESTRATOR_CHILDREN_WAKE_TEXT
          : ORCHESTRATOR_WAKE_TEXT;
      const body = {
        agent: 'orchestrator',
        ...(modelSelection ? { model: modelSelection.model } : {}),
        parts: [createInternalAgentTextPart(wakeText)],
      };
      if (wakeMode === 'children' && capabilities.flavor === 'v2') {
        // v1 prompt_async queued; 'queue' preserves that on v2 ('steer'
        // would hijack an in-flight run).
        await (
          sessionSdk.promptAsync as (
            args: Record<string, unknown>,
          ) => Promise<unknown>
        )({
          path: { id: sessionID },
          query: { directory },
          body,
          delivery: 'queue',
          throwOnError: true,
        });
      } else {
        await sessionSdk.promptAsync({
          path: { id: sessionID },
          query: { directory },
          body,
          throwOnError: true,
        });
      }
      if (recoveryWake) pendingStoppedRecoveries.delete(sessionID);
    } catch (error) {
      // Failed promptAsync already reserved; clear expecting-busy so a later
      // unrelated busy can rearm normally.
      clearExpectingWakeBusy(sessionID);
      log('[orchestrator-wake] wake suppressed after SDK error', {
        sessionID,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Always release ownership — even when suppress/endIdle bumped generation.
      releaseWakeEvaluation(sessionID, owner);
      if (localWakeOwners.get(sessionID) === owner) {
        localWakeOwners.delete(sessionID);
      }

      const current = localSessions.get(sessionID);
      if (
        current &&
        current.generation === generation &&
        current.continuousIdle &&
        current.timer === undefined &&
        !getWakeProgress(sessionID).stopped
      ) {
        schedule(sessionID);
      }
    }
  }

  function observeChatMessage(input: unknown, output: unknown): void {
    const inputMessage = isObjectRecord(input) ? input : undefined;
    const outputRecord = isObjectRecord(output) ? output : undefined;
    const outputMessage = isObjectRecord(outputRecord?.message)
      ? outputRecord.message
      : undefined;
    const sessionID =
      typeof outputMessage?.sessionID === 'string'
        ? outputMessage.sessionID
        : typeof inputMessage?.sessionID === 'string'
          ? inputMessage.sessionID
          : undefined;
    const parts = Array.isArray(outputRecord?.parts)
      ? outputRecord.parts
      : inputMessage?.parts;
    if (
      !sessionID ||
      (typeof outputMessage?.role === 'string' &&
        outputMessage.role !== 'user') ||
      !options.shouldManageSession(sessionID) ||
      !Array.isArray(parts) ||
      parts.some(isInternalInitiatorPart) ||
      !parts.some(
        (part) =>
          isObjectRecord(part) &&
          part.synthetic !== true &&
          !isInternalInitiatorPart(part) &&
          ((part.type === 'text' && typeof part.text === 'string') ||
            part.type === 'file' ||
            part.type === 'image'),
      )
    ) {
      return;
    }

    const outputModel = isObjectRecord(outputMessage?.model)
      ? outputMessage.model
      : undefined;
    const variant =
      typeof inputMessage?.variant === 'string'
        ? inputMessage.variant
        : outputModel?.variant;
    const modelSelection =
      parseContinuationModelSelection(inputMessage?.model, variant) ??
      parseContinuationModelSelection(outputModel, variant);

    setObservedWakeModel(sessionID, modelSelection);

    const state = touchLocal(sessionID);
    clearTimer(state);
    bumpGeneration(state);
    state.continuousIdle = false;
    // External user activity rearms the process-global no-progress cap.
    rearmWakeProgress(sessionID);
  }

  /**
   * Immediately evaluate an idle orchestrator after a child stops without a
   * native terminal result. This is deliberately separate from the periodic
   * TODO wake: stopped work needs recovery even when its parent has no todo.
   */
  function triggerStoppedJobRecovery(sessionID: string): void {
    if (
      disposed ||
      !enabled ||
      !capabilities.ready ||
      !options.shouldManageSession(sessionID)
    ) {
      return;
    }
    pendingStoppedRecoveries.add(sessionID);
    rearmWakeProgress(sessionID);
    if (!canSchedule(sessionID)) return;
    const state = touchLocal(sessionID);
    clearTimer(state);
    bumpGeneration(state);
    state.continuousIdle = true;
    rearmWakeProgress(sessionID);
    void evaluate(sessionID, state.generation, true);
  }

  async function event(input: {
    event: {
      type: string;
      properties?: {
        info?: { id?: string; parentID?: string };
        sessionID?: string;
        parentID?: string;
        status?: { type?: string };
      };
    };
  }): Promise<void> {
    const { type, properties } = input.event;

    if (type === 'server.instance.disposed') {
      disposed = true;
      pendingStoppedRecoveries.clear();
      lastStatusBySession.clear();
      childSessions.clear();
      childEvidence.clear();
      for (const sessionID of [...localWakeOwners.keys()]) {
        releaseLocalWakeOwner(sessionID);
      }
      for (const sessionID of [...localSessions.keys()]) {
        clearLocalSession(sessionID);
      }
      return;
    }

    const sessionID = extractSessionID(input.event);
    if (!sessionID) return;

    // Event bookkeeping (children-driven mode + parent-active race guard).
    // Status tracking covers ALL sessions: child entries feed the busy-set
    // and update evidence, the parent entry is the race guard on hosts
    // without a live status map (v2).
    if (type === 'session.status') {
      const statusType = properties?.status?.type;
      if (statusType === 'busy' || statusType === 'idle') {
        recordTrackedStatus(sessionID, statusType);
      }
    } else if (type === 'session.created') {
      const parentID =
        typeof properties?.info?.parentID === 'string'
          ? properties.info.parentID
          : typeof properties?.parentID === 'string'
            ? properties.parentID
            : undefined;
      if (parentID) recordChildSession(parentID, sessionID);
    }

    if (type === 'session.deleted') {
      forgetSessionEvents(sessionID);
      clearSession(sessionID);
      return;
    }

    if (isInputWaitAskEvent(type)) {
      if (options.shouldManageSession(sessionID)) {
        suppress(sessionID);
      }
      return;
    }

    if (isIdleEvent(type, properties)) {
      if (options.shouldManageSession(sessionID)) {
        clearExpectingWakeBusy(sessionID);
        if (pendingStoppedRecoveries.has(sessionID)) {
          triggerStoppedJobRecovery(sessionID);
          return;
        }
        beginContinuousIdle(sessionID);
      }
      return;
    }

    if (isBusyEvent(type, properties)) {
      if (options.shouldManageSession(sessionID)) {
        // Wake-initiated busy preserves the no-progress cap; external busy rearms.
        const wakeBusy = isExpectingWakeBusy(sessionID);
        endIdleSpell(sessionID, !wakeBusy);
      }
      return;
    }

    if (type === 'session.error' || type === 'session.status') {
      if (
        type === 'session.error' ||
        (type === 'session.status' &&
          properties?.status?.type !== 'idle' &&
          properties?.status?.type !== 'busy')
      ) {
        if (options.shouldManageSession(sessionID)) {
          // Errors / retry are external lifecycle — rearm.
          clearExpectingWakeBusy(sessionID);
          endIdleSpell(sessionID, true);
        }
      }
    }
  }

  if (options.coordinator) {
    options.coordinator.onSessionDeleted((sessionID) => {
      clearSession(sessionID);
    });
  }

  return {
    event,
    observeChatMessage,
    triggerStoppedJobRecovery,
    /** Clear timers when wait_for_user or fallback begins. */
    suppress,
    /** Test seam */
    _test: {
      localSessions,
      intervalMs,
      enabled,
      hasRequiredSessionApis: () => capabilities.ready,
      capabilities: () => capabilities,
      wakeMode: () => wakeMode,
      lastStatusBySession,
      childEvidence,
      childSessions,
    },
  };
}

export type OrchestratorWakeScheduler = ReturnType<
  typeof createOrchestratorWakeScheduler
>;
