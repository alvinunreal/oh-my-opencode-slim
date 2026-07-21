/**
 * Continuation evaluator subsystem for task session manager.
 *
 * Evaluates whether a parent session needs a continuation nudge
 * when its children complete but todos remain unfinished.
 *
 * Exported as a pure function taking explicit dependency objects
 * to avoid circular dependency issues with the other subsystems.
 */
import { createInternalAgentTextPart } from '../../utils';
import type { BackgroundJobStore } from '../../utils/background-job-store';
import { isRecord as isObjectRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import { isActiveStatus } from './status-utils';

const CONTINUATION_NUDGE =
  'Continue coordinating the remaining incomplete todos. Do not finalize while work remains.';

/**
 * Shared 5-condition guard that appears (in identical form) after
 * each async liveness re-check inside the main evaluation loop.
 * Deduplicated here to avoid repeating the same short-circuit chain.
 *
 * Does NOT include the SDK-availability checks (first guard only);
 * those remain inline since they only run once before any I/O.
 */
function isEvaluationAborted(
  parentSessionID: string,
  sessionToken: symbol,
  evaluationToken: symbol,
  deps: {
    continuationTokens: {
      consumed: { has: (sessionID: string) => boolean };
      isCurrentContinuation: (
        sessionID: string,
        sessionToken: symbol,
        evaluationToken?: symbol,
      ) => boolean;
    };
    inputWaits: {
      hasInputWait: (sessionID: string) => boolean;
    };
    options: {
      isFallbackInProgress?: (sessionID: string) => boolean;
    };
    backgroundJobBoard: BackgroundJobStore;
  },
): boolean {
  return (
    deps.continuationTokens.consumed.has(parentSessionID) ||
    deps.inputWaits.hasInputWait(parentSessionID) ||
    !deps.continuationTokens.isCurrentContinuation(
      parentSessionID,
      sessionToken,
      evaluationToken,
    ) ||
    deps.options.isFallbackInProgress?.(parentSessionID) ||
    deps.backgroundJobBoard.hasTerminalUnreconciled(parentSessionID)
  );
}

function cleanupEvaluationToken(
  parentSessionID: string,
  evaluationToken: symbol,
  evaluations: Map<string, Set<symbol>>,
): void {
  const active = evaluations.get(parentSessionID);
  active?.delete(evaluationToken);
  if (active?.size === 0) {
    evaluations.delete(parentSessionID);
  }
}

export async function evaluateContinuation(
  parentSessionID: string,
  sessionToken: symbol,
  deps: {
    continueOnIdle: boolean;
    backgroundJobBoard: BackgroundJobStore;
    continuationTokens: {
      evaluations: Map<string, Set<symbol>>;
      consumed: { has: (sessionID: string) => boolean };
      isCurrentContinuation: (
        sessionID: string,
        sessionToken: symbol,
        evaluationToken?: symbol,
      ) => boolean;
      tryReserveAttempt: (sessionID: string) => symbol | null;
      commitAttempt: (sessionID: string, owner: symbol) => boolean;
      releaseAttempt: (sessionID: string, owner: symbol) => void;
    };
    inputWaits: {
      hasInputWait: (sessionID: string) => boolean;
    };
    options: {
      isFallbackInProgress?: (sessionID: string) => boolean;
    };
    sessionSdk?: {
      todo?: (input: unknown) => Promise<{ data?: unknown }>;
      children?: (input: unknown) => Promise<{ data?: unknown }>;
      status?: (input: unknown) => Promise<{ data?: unknown }>;
      promptAsync?: (input: unknown) => Promise<unknown>;
    };
  },
): Promise<void> {
  // Explicit opt-out: idle reconciliation still runs; continuation SDK calls do not.
  if (!deps.continueOnIdle) {
    return;
  }

  const evaluationToken = Symbol(parentSessionID);
  const activeEvaluations =
    deps.continuationTokens.evaluations.get(parentSessionID) ??
    new Set<symbol>();
  activeEvaluations.add(evaluationToken);
  deps.continuationTokens.evaluations.set(parentSessionID, activeEvaluations);

  // Guard 1: pre-flight checks (includes SDK availability — only once)
  if (
    deps.continuationTokens.consumed.has(parentSessionID) ||
    deps.inputWaits.hasInputWait(parentSessionID) ||
    !deps.continuationTokens.isCurrentContinuation(
      parentSessionID,
      sessionToken,
      evaluationToken,
    ) ||
    deps.options.isFallbackInProgress?.(parentSessionID) ||
    deps.backgroundJobBoard.hasTerminalUnreconciled(parentSessionID) ||
    !deps.sessionSdk?.todo ||
    !deps.sessionSdk.children ||
    !deps.sessionSdk.status ||
    !deps.sessionSdk.promptAsync
  ) {
    cleanupEvaluationToken(
      parentSessionID,
      evaluationToken,
      deps.continuationTokens.evaluations,
    );
    return;
  }

  // Reserve before any async SDK liveness reads so concurrent idle events and
  // independently created hook instances cannot both proceed to promptAsync.
  const reservationOwner =
    deps.continuationTokens.tryReserveAttempt(parentSessionID);
  if (!reservationOwner) {
    cleanupEvaluationToken(
      parentSessionID,
      evaluationToken,
      deps.continuationTokens.evaluations,
    );
    return;
  }

  let committed = false;
  try {
    const [todoResponse, childrenResponse, statusResponse] = await Promise.all([
      deps.sessionSdk.todo({
        path: { id: parentSessionID },
        throwOnError: true,
      }),
      deps.sessionSdk.children({
        path: { id: parentSessionID },
        throwOnError: true,
      }),
      deps.sessionSdk.status({ throwOnError: true }),
    ]);
    if (
      !Array.isArray(todoResponse.data) ||
      !Array.isArray(childrenResponse.data) ||
      !isObjectRecord(statusResponse.data)
    ) {
      return;
    }
    const todos = todoResponse.data;
    const children = childrenResponse.data;
    const status = statusResponse.data;
    if (
      !todos.every(
        (todo) => isObjectRecord(todo) && typeof todo.status === 'string',
      ) ||
      !children.every(
        (child) => isObjectRecord(child) && typeof child.id === 'string',
      )
    ) {
      return;
    }
    if (
      !todos.some(
        (todo) => todo.status !== 'completed' && todo.status !== 'cancelled',
      )
    ) {
      return;
    }
    const childIDs = children.map((child) => child.id as string);
    if (
      isActiveStatus(status, parentSessionID) ||
      childIDs.some((childID) => isActiveStatus(status, childID))
    ) {
      return;
    }

    // Re-read liveness immediately before queuing work; board state is only
    // authoritative for terminal results observed by this plugin instance.
    const [latestChildrenResponse, latestStatusResponse] = await Promise.all([
      deps.sessionSdk.children({
        path: { id: parentSessionID },
        throwOnError: true,
      }),
      deps.sessionSdk.status({ throwOnError: true }),
    ]);
    if (
      !Array.isArray(latestChildrenResponse.data) ||
      !isObjectRecord(latestStatusResponse.data) ||
      !latestChildrenResponse.data.every(
        (child) => isObjectRecord(child) && typeof child.id === 'string',
      ) ||
      isEvaluationAborted(parentSessionID, sessionToken, evaluationToken, deps)
    ) {
      return;
    }
    const latestChildIDs = latestChildrenResponse.data.map(
      (child) => child.id as string,
    );
    const latestStatus = latestStatusResponse.data;
    if (
      isActiveStatus(latestStatus, parentSessionID) ||
      latestChildIDs.some((childID) => isActiveStatus(latestStatus, childID))
    ) {
      return;
    }

    if (
      isEvaluationAborted(parentSessionID, sessionToken, evaluationToken, deps)
    ) {
      return;
    }

    // Commit immediately before promptAsync — no await between commit and call.
    // Once invoked, never retry in this epoch even if promptAsync rejects.
    if (
      !deps.continuationTokens.commitAttempt(parentSessionID, reservationOwner)
    ) {
      return;
    }
    committed = true;
    await deps.sessionSdk.promptAsync({
      path: { id: parentSessionID },
      body: {
        agent: 'orchestrator',
        parts: [createInternalAgentTextPart(CONTINUATION_NUDGE)],
      },
      throwOnError: true,
    });
  } catch (error) {
    log(
      '[task-session-manager] continuation nudge suppressed after SDK error',
      {
        parentSessionID,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  } finally {
    if (!committed) {
      deps.continuationTokens.releaseAttempt(parentSessionID, reservationOwner);
    }
    cleanupEvaluationToken(
      parentSessionID,
      evaluationToken,
      deps.continuationTokens.evaluations,
    );
  }
}
