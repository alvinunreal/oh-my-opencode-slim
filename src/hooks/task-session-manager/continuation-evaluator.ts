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
      consumed: Set<string>;
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

export async function evaluateContinuation(
  parentSessionID: string,
  sessionToken: symbol,
  deps: {
    backgroundJobBoard: BackgroundJobStore;
    continuationTokens: {
      evaluations: Map<string, Set<symbol>>;
      consumed: Set<string>;
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
    sessionSdk?: {
      todo?: (input: unknown) => Promise<{ data?: unknown }>;
      children?: (input: unknown) => Promise<{ data?: unknown }>;
      status?: (input: unknown) => Promise<{ data?: unknown }>;
      promptAsync?: (input: unknown) => Promise<unknown>;
    };
  },
): Promise<void> {
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
    activeEvaluations.delete(evaluationToken);
    if (activeEvaluations.size === 0) {
      deps.continuationTokens.evaluations.delete(parentSessionID);
    }
    return;
  }

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
    deps.continuationTokens.consumed.add(parentSessionID);
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
    const evaluations =
      deps.continuationTokens.evaluations.get(parentSessionID);
    evaluations?.delete(evaluationToken);
    if (evaluations?.size === 0) {
      deps.continuationTokens.evaluations.delete(parentSessionID);
    }
  }
}
