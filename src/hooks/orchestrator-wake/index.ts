/**
 * Periodic orchestrator wake scheduler.
 *
 * After continuous parent-idle time, capability-gated host session APIs may
 * receive a static internal wake prompt when incomplete todos remain. Active
 * children suppress periodic wakes. Host responses are authoritative; the local
 * job board is never consulted. Progress/reservation state is process-global
 * so independently created hook instances share one-flight and the two-wake
 * no-progress cap.
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

/** After this many successful wakes with an unchanged fingerprint, stop. */
export const ORCHESTRATOR_WAKE_UNCHANGED_CAP = 2;

const SUPPORTED_TODO_STATUSES = new Set([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]);

type SessionClient = OpencodeClient['session'];

type LocalSessionState = {
  /** Invalidates local timers/async work for this hook instance. */
  generation: symbol;
  timer: ReturnType<typeof setTimeout> | undefined;
  continuousIdle: boolean;
};

export type OrchestratorWakeConfig = {
  enabled: boolean;
  intervalMs: number;
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

function hasRequiredSessionApis(
  session: SessionClient | undefined,
): session is SessionClient & {
  get: NonNullable<SessionClient['get']>;
  todo: NonNullable<SessionClient['todo']>;
  children: NonNullable<SessionClient['children']>;
  status: NonNullable<SessionClient['status']>;
  promptAsync: NonNullable<SessionClient['promptAsync']>;
} {
  return (
    typeof session?.get === 'function' &&
    typeof session.todo === 'function' &&
    typeof session.children === 'function' &&
    typeof session.status === 'function' &&
    typeof session.promptAsync === 'function'
  );
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

  /** Local timer/generation state only; progress lives in the process gate. */
  const localSessions = new Map<string, LocalSessionState>();
  /** Reservations this hook owns and must release when it is disposed. */
  const localWakeOwners = new Map<string, symbol>();
  const pendingStoppedRecoveries = new Set<string>();
  let disposed = false;

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
    if (!hasRequiredSessionApis(sessionSdk)) return false;
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

  async function readHostSnapshot(sessionID: string): Promise<
    | {
        todos: Array<Record<string, unknown>>;
        children: Array<Record<string, unknown>>;
        status: Record<string, unknown>;
        model?: ContinuationModelSelection;
      }
    | undefined
  > {
    if (!hasRequiredSessionApis(sessionSdk)) return undefined;

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

    let model: ContinuationModelSelection | undefined;
    try {
      const sessionResponse = await sessionSdk.get({
        path: { id: sessionID },
        query: dirQuery,
        throwOnError: true,
      });
      // Session.model is version-dependent; read via record shape.
      const session = isObjectRecord(sessionResponse?.data)
        ? sessionResponse.data
        : undefined;
      model = parseContinuationModelSelection(
        session ? (session as Record<string, unknown>).model : undefined,
      );
    } catch {
      // Model enrichment is fail-soft.
    }

    return {
      todos: todos as Array<Record<string, unknown>>,
      children: children as Array<Record<string, unknown>>,
      status,
      model,
    };
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
      const snapshot = await readHostSnapshot(sessionID);
      if (!snapshot || state.generation !== generation) return;
      if (!state.continuousIdle) return;
      if (!canSchedule(sessionID)) {
        suppress(sessionID);
        return;
      }

      if (isActiveStatus(snapshot.status, sessionID)) {
        endIdleSpell(sessionID, true);
        return;
      }
      if (!recoveryWake && hasActiveChild(snapshot.children, snapshot.status)) {
        schedule(sessionID);
        return;
      }
      if (!recoveryWake && !hasIncompleteTodos(snapshot.todos)) {
        // No incomplete work: end the spell; do not keep polling.
        endIdleSpell(sessionID, false);
        return;
      }

      const fingerprint = buildOrchestratorWakeFingerprint(
        snapshot.todos,
        snapshot.children,
        snapshot.status,
      );
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
      const latest = await readHostSnapshot(sessionID);
      if (!latest || state.generation !== generation) return;
      if (!state.continuousIdle) return;
      if (!canSchedule(sessionID)) {
        suppress(sessionID);
        return;
      }
      if (isActiveStatus(latest.status, sessionID)) {
        endIdleSpell(sessionID, true);
        return;
      }
      if (!recoveryWake && hasActiveChild(latest.children, latest.status)) {
        schedule(sessionID);
        return;
      }
      if (!recoveryWake && !hasIncompleteTodos(latest.todos)) {
        endIdleSpell(sessionID, false);
        return;
      }

      const latestFingerprint = buildOrchestratorWakeFingerprint(
        latest.todos,
        latest.children,
        latest.status,
      );
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

      if (!hasRequiredSessionApis(sessionSdk)) return;

      await sessionSdk.promptAsync({
        path: { id: sessionID },
        query: { directory },
        body: {
          agent: 'orchestrator',
          ...(modelSelection ? { model: modelSelection.model } : {}),
          parts: [
            createInternalAgentTextPart(
              recoveryWake
                ? ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT
                : ORCHESTRATOR_WAKE_TEXT,
            ),
          ],
        },
        throwOnError: true,
      });
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
      !hasRequiredSessionApis(sessionSdk) ||
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
        info?: { id?: string };
        sessionID?: string;
        status?: { type?: string };
      };
    };
  }): Promise<void> {
    const { type, properties } = input.event;

    if (type === 'server.instance.disposed') {
      disposed = true;
      pendingStoppedRecoveries.clear();
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

    if (type === 'session.deleted') {
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
      hasRequiredSessionApis: () => hasRequiredSessionApis(sessionSdk),
    },
  };
}

export type OrchestratorWakeScheduler = ReturnType<
  typeof createOrchestratorWakeScheduler
>;
