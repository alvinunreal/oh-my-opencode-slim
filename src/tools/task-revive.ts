import { randomUUID } from 'node:crypto';
import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type {
  BackgroundJobLease,
  BackgroundJobLifecycle,
} from '../background-jobs';
import type { RevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import { pluginDisposedMessage } from '../hooks/task-session-manager/session-recovery';
import { responseError } from '../utils/child-transcript';
import { log } from '../utils/logger';
import { getClient } from '../utils/opencode-client';
import {
  OperationTimeoutError,
  SESSION_ID_PATTERN,
  withTimeout,
} from '../utils/session';
import { getRuntimeSessionStatusSnapshot } from '../utils/session-runtime-status';
import type { ExperimentalV2 } from '../v2/client-shim';
import {
  assertOrchestrator,
  cancelTrackedExecution,
  type TaskControlToolOptions,
} from './cancel-task';
import { idParamFor, readTaskRef, taskRefArgs } from './task-ref';

const z = tool.schema;
const DEFAULT_BASELINE_TIMEOUT_MS = 5_000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 5_000;

class ReviveAdmissionDeadlineError extends Error {}

export interface TaskReviveToolOptions extends TaskControlToolOptions {
  recoverRetainedSession: NonNullable<
    TaskControlToolOptions['recoverRetainedSession']
  >;
  revivedRunTracker: RevivedRunTracker;
  baselineTimeoutMs?: number;
  admissionTimeoutMs?: number;
  waitForIdleTimeoutMs?: number;
  isDisposed?: () => boolean;
  isFallbackPending?: (taskID: string) => boolean;
  registerIntent?: (parentID: string, childID: string, agent: string) => void;
}

export function createTaskReviveTool(
  options: TaskReviveToolOptions,
): Record<'task_revive', ToolDefinition> {
  const revivedRunTracker = options.revivedRunTracker;
  const idParam = idParamFor(options.input);
  const task_revive = tool({
    description:
      'Revive a retained background task in its existing session with a new prompt. An untracked session ID (e.g. after a host restart) is verified against the host and re-adopted on demand.',
    args: {
      ...taskRefArgs(idParam),
      prompt: z.string().min(1).describe('Prompt for the revived task'),
    },
    async execute(args, toolContext) {
      const parentSessionID = assertOrchestrator(
        options,
        toolContext,
        'task_revive',
      );
      const requested = readTaskRef(args, idParam);
      const prompt = args.prompt.trim();
      if (!requested) throw new Error(`task_revive requires ${idParam}`);
      if (!prompt) throw new Error('task_revive requires prompt');
      const canonical = options.resolveCanonicalTaskRef
        ? await options.resolveCanonicalTaskRef(parentSessionID, requested)
        : undefined;
      if (options.isDisposed?.()) throw new Error(pluginDisposedMessage());
      if (canonical?.kind === 'refused') throw new Error(canonical.reason);
      const identity = canonical?.taskID ?? requested;
      let resolved = canonical
        ? options.backgroundJobs.get(identity)
        : options.backgroundJobs.resolve(parentSessionID, requested);
      if (resolved && resolved.parentSessionID !== parentSessionID) {
        throw new Error(`Unknown or unowned background task: ${requested}`);
      }
      let adopted = resolved?.recoveredWithoutPrompt === true;
      if (!resolved) {
        const guidance = await resolveOrAdoptUntrackedTask(
          options,
          parentSessionID,
          identity,
          SESSION_ID_PATTERN.test(requested),
        );
        if (guidance !== undefined) throw new Error(guidance);
        // undefined ⇒ adopted: the board now owns a fresh record for this
        // session, so the resolution below must be repeated.
        resolved = canonical
          ? options.backgroundJobs.get(identity)
          : options.backgroundJobs.resolve(parentSessionID, requested);
        adopted = true;
      }
      if (!resolved) {
        throw new Error(
          `task_revive adoption did not produce a tracked record for ${requested}`,
        );
      }

      let current = getCurrentReviveJob(
        options,
        parentSessionID,
        resolved.taskID,
        resolved.generation,
      );
      const captured = {
        taskID: current.taskID,
        generation: current.generation,
      };
      const queuedRun = revivedRunTracker.promptMessageIDFor?.(
        current.taskID,
        current.generation,
      );
      if (queuedRun && current.state === 'running') {
        throw new Error(
          `Task ${requested} already has a queued continuation; do not retry task_revive. Use task_status to inspect it.`,
        );
      }
      const queueContinuation =
        supportsQueuedContinuation(options) && (adopted || !!queuedRun);
      const promptMessageID = queueContinuation
        ? `msg_omos_revive_${randomUUID().replaceAll('-', '')}`
        : undefined;

      // Establish a real verification mechanism before any destructive abort.
      // A historical session.get outcome is not a live-idle capability.
      const session = getClient(options.input).session;
      const hasStatusMap = typeof session.status === 'function';
      const channel = (options.input as { experimental_v2?: ExperimentalV2 })
        .experimental_v2?.waitForSessionIdle;
      const waitForIdle =
        !hasStatusMap && typeof channel === 'function' ? channel : undefined;
      if (!queueContinuation && !hasStatusMap && !waitForIdle) {
        throw new Error(
          'task_revive idle-verification capability unavailable: the host must expose session.status or waitForSessionIdle; no abort or prompt was sent',
        );
      }

      let cancelledForRevive = false;
      // Adoption does not grant ownership of the pre-existing execution.
      // V2 queues behind it; V1 retains the live-state verification below.
      if (current.state === 'running' && !adopted && !queueContinuation) {
        if (
          options.isFallbackPending?.(current.taskID) ||
          revivedRunTracker.isObservationPending(
            current.taskID,
            current.generation,
          ) ||
          revivedRunTracker.isFallbackRun(current.taskID, current.generation)
        ) {
          throw new Error(
            `Task ${requested} is recovering on a fallback model; wait for its result. Use task_cancel if it is obsolete.`,
          );
        }
        await cancelTrackedExecution(options, captured, 'revived');
        cancelledForRevive = true;
        current = getCurrentReviveJob(
          options,
          parentSessionID,
          captured.taskID,
          captured.generation,
        );
      }

      if (
        !cancelledForRevive &&
        !adopted &&
        !isReviveableRetainedJob(current)
      ) {
        throw new Error(
          `Task ${requested} cannot be revived: state ${current.state} is not a verified retained terminal session`,
        );
      }

      const relaunchLease = options.backgroundJobs.acquireRelaunchLease(
        current.taskID,
        current.generation,
      );
      if (!relaunchLease) {
        throw new Error(
          `Task ${requested} cannot be revived: relaunch lease unavailable`,
        );
      }

      let admissionOwner: { settled: boolean } | undefined;
      let launched:
        | ReturnType<TaskControlToolOptions['backgroundJobs']['registerLaunch']>
        | undefined;
      try {
        const observedLiveBusyAt = current.lastLiveBusyAt;
        const deletionEpoch = options.backgroundJobs.ledger.deletionEpochs.get(
          current.taskID,
        );
        const baselineMessageID = queueContinuation
          ? undefined
          : await withTimeout(
              revivedRunTracker.captureBaseline(current.taskID),
              Math.max(
                1,
                options.baselineTimeoutMs ?? DEFAULT_BASELINE_TIMEOUT_MS,
              ),
              'Baseline capture deadline exceeded; the revive prompt was NOT sent',
            );
        if (!queueContinuation && waitForIdle) {
          const timeoutMs = Math.max(
            1,
            options.waitForIdleTimeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS,
          );
          const deadline = Date.now() + timeoutMs;
          const waiting = waitForIdle(current.taskID);
          if (!waiting || typeof waiting.then !== 'function') {
            throw new Error(
              'Invalid session idle wait operation; the revive prompt was NOT sent',
            );
          }
          const completion = await withTimeout(
            waiting,
            timeoutMs,
            'Session idle wait timed out; the revive prompt was NOT sent',
          );
          // The 2.0.5 adapter does not forward AbortSignal. Late settlement is
          // observed by withTimeout but cannot resume this terminated flow.
          if (Date.now() >= deadline) {
            throw new OperationTimeoutError(
              'Session idle wait timed out; the revive prompt was NOT sent',
            );
          }
          if (completion !== undefined) {
            throw new Error(
              'Invalid session idle wait result; the revive prompt was NOT sent',
            );
          }
        } else if (!queueContinuation) {
          const liveSnapshot = await getRuntimeSessionStatusSnapshot(
            options.input,
          );
          const liveStatus = liveSnapshot.statuses.get(current.taskID);
          if (liveStatus === 'busy' || liveStatus === 'retry') {
            throw new Error(
              `Task ${requested} is executing at the host (live status: ${liveStatus}); the revive prompt was NOT sent and no duplicate was launched. Use task_status to inspect it.`,
            );
          }
          if (
            liveSnapshot.error !== undefined ||
            liveSnapshot.malformedSessionIDs.has(current.taskID)
          ) {
            throw new Error(
              `Task ${requested} could not be verified against the live session map (${liveSnapshot.error ?? 'malformed entry'}); the revive prompt was NOT sent. Retry task_revive.`,
            );
          }
        }
        if (typeof session.promptAsync !== 'function') {
          throw new Error('The host session does not support promptAsync');
        }
        // Both reads above await network I/O. Revalidate immediately before
        // sending: live busy can restore running even under a relaunch lease.
        // A changed busy timestamp also fences activity that stopped again.
        current = getCurrentReviveJob(
          options,
          parentSessionID,
          captured.taskID,
          captured.generation,
        );
        if (
          options.isDisposed?.() ||
          options.backgroundJobs.ledger.deletionEpochs.get(current.taskID) !==
            deletionEpoch ||
          !options.backgroundJobs.validateLease(relaunchLease) ||
          // V1 adoption still requires live quiescence. The V2 identity-bound
          // queue path deliberately permits the existing execution to run.
          (!queueContinuation &&
            !adopted &&
            !isReviveableRetainedJob(current)) ||
          (!queueContinuation &&
            current.lastLiveBusyAt !== undefined &&
            current.lastLiveBusyAt !== observedLiveBusyAt)
        ) {
          throw new Error(
            `Task ${requested} became active again (${current.state}) before the revive prompt was sent; the prompt was NOT sent and no duplicate was launched. Use task_status to inspect it.`,
          );
        }
        // A remote resume can race this send. `queue` avoids steering an
        // in-flight run, but may enqueue a continuation after an independent
        // resume; it does not deduplicate. The v1 SDK ignores this client-side
        // hint (not part of the HTTP request); the v2 shim forwards it.
        const admissionStartedAt = Date.now();
        const replaced = current;
        if (promptMessageID) {
          // Own this one input before sending. A late acknowledgement must
          // never reinstall the tracker after it has delivered the answer.
          launched = options.backgroundJobs.registerLaunch({
            taskID: current.taskID,
            parentSessionID,
            agent: current.agent,
            description: current.description,
            objective: current.objective,
            background: true,
            relaunchLease,
            now: admissionStartedAt,
          });
          revivedRunTracker.register({
            taskID: launched.taskID,
            generation: launched.generation,
            parentSessionID,
            promptMessageID,
            admissionLease: relaunchLease,
            attemptStartedAt: admissionStartedAt,
            description: launched.description,
          });
          // A session-wide timeout abort could kill the preceding execution.
          // This input is observed by identity, without an automatic abort.
        }
        options.registerIntent?.(
          parentSessionID,
          current.taskID,
          current.agent,
        );
        const request = (
          session.promptAsync as (
            args: Record<string, unknown>,
          ) => Promise<unknown>
        )({
          path: { id: current.taskID },
          query: { directory: options.input.directory },
          body: {
            agent: current.agent,
            ...(promptMessageID ? { messageID: promptMessageID } : {}),
            parts: [{ type: 'text', text: prompt }],
          },
          delivery: 'queue',
        });
        // This captured owner, not the caller's deadline, owns settlement.
        // Keep exclusion while admission is unknown; never retry the write.
        const owner = { settled: false, transferred: false };
        admissionOwner = owner;
        const admission = Promise.resolve(request)
          .then((response) => {
            if (owner.settled) return;
            owner.settled = true;
            const apiError = responseError(response);
            if (apiError !== undefined) {
              // An explicit refusal admitted nothing. Release the queued
              // identity so the task neither waits for it nor fences retries.
              if (queueContinuation && launched) {
                revivedRunTracker.discard(launched.taskID, launched.generation);
                options.backgroundJobs.abandonLaunch(launched, replaced);
                launched = undefined;
              }
              throw new Error(errorText(apiError));
            }
            // Retirement is not deletion. The accepted write is not resent
            // and is not compensated with abort. Settle only this lease.
            if (
              options.isDisposed?.() &&
              options.backgroundJobs.get(captured.taskID)
            ) {
              throw new Error(
                'the revive write was accepted, but this plugin instance is retired and will not track it',
              );
            }
            if (queueContinuation) {
              if (
                !launched ||
                options.backgroundJobs.get(captured.taskID)?.generation !==
                  launched.generation
              ) {
                owner.transferred = true;
                throw new Error(
                  'queued admission became stale; no interrupt sent and exclusion retained',
                );
              }
              return;
            }
            // Deletion wins, but it leaves this write's lease alive. Only
            // that precise case may compensate; all stale owners/generations
            // still go through registerLaunch's existing rejection fence.
            if (
              !options.backgroundJobs.get(captured.taskID) &&
              options.backgroundJobs.validateLease(relaunchLease)
            ) {
              owner.transferred = true;
              // Starts synchronously under the lease, independently of the
              // admission race. Its abort is never awaited by this caller.
              void ownInvalidatedAdmission(options, relaunchLease);
              throw new Error(
                'admission accepted but invalidated by loss of the record; compensation initiated',
              );
            }
            if (current.terminalUnreconciled) {
              const acked = options.backgroundJobs.markReconciled(
                current.taskID,
                admissionStartedAt,
                current.generation,
                current.terminalRevision,
              );
              if (
                !acked ||
                acked.generation !== current.generation ||
                (acked.state !== 'reconciled' && acked.terminalUnreconciled)
              ) {
                throw new Error(
                  `Task ${requested} old round could not be acknowledged; no new generation was registered`,
                );
              }
            }
            launched = options.backgroundJobs.registerLaunch({
              taskID: current.taskID,
              parentSessionID,
              agent: current.agent,
              description: current.description,
              objective: current.objective,
              background: true,
              relaunchLease,
              now: admissionStartedAt,
            });
            revivedRunTracker.register({
              taskID: launched.taskID,
              generation: launched.generation,
              parentSessionID,
              baselineMessageID,
              promptMessageID,
              attemptStartedAt: admissionStartedAt,
              description: launched.description,
            });
            options.backgroundJobs.onLaunch(launched);
          })
          .catch((error: unknown) => {
            if (queueContinuation && !owner.settled) {
              // A rejected transport can still have admitted the input. Keep
              // identity and exclusion; never turn uncertainty into a retry.
              owner.transferred = true;
              throw new ReviveAdmissionDeadlineError(
                `Queued admission outcome unknown: ${errorText(error)}`,
              );
            }
            throw error;
          })
          .finally(() => {
            owner.settled = true;
            if (!owner.transferred)
              options.backgroundJobs.releaseLease(relaunchLease);
          });
        const observation = admission
          .then(async () => {
            if (!launched) return;
            try {
              await revivedRunTracker.probe(
                launched.taskID,
                launched.generation,
              );
            } catch (error) {
              log('[task-revive] observation failed', {
                taskID: current.taskID,
                error: errorText(error),
              });
            }
          })
          .catch((error: unknown) => {
            if (launched) {
              options.backgroundJobs.markStatusUncertain(
                current.taskID,
                `task_revive failed: ${errorText(error)}`,
                launched.generation,
              );
            }
            log('[task-revive] admission failed', {
              taskID: current.taskID,
              error: errorText(error),
            });
          });
        let admissionTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            admission,
            new Promise<never>((_, reject) => {
              admissionTimer = setTimeout(
                () =>
                  reject(
                    new ReviveAdmissionDeadlineError(
                      'Revive admission deadline exceeded',
                    ),
                  ),
                Math.max(
                  1,
                  options.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS,
                ),
              );
            }),
          ]);
        } catch (error) {
          // Preserve the local race outcome, regardless of later settlement.
          // A timeout error from the transport is still an admission failure.
          if (error instanceof ReviveAdmissionDeadlineError) {
            return renderReviveOutput(
              idParam,
              queueContinuation ? (launched ?? current) : current,
              true,
            );
          }
          throw error;
        } finally {
          clearTimeout(admissionTimer);
        }
        // Observe fast completion without holding exclusion over the probe.
        await observation;
      } catch (error) {
        throw new Error(`Task ${requested} revive failed: ${errorText(error)}`);
      } finally {
        // Before a write exists there is no late admission to protect.
        if (!admissionOwner) options.backgroundJobs.releaseLease(relaunchLease);
      }

      if (!launched) {
        throw new Error(`Task ${requested} revive did not launch`);
      }
      const latest = options.backgroundJobs.get(current.taskID);
      if (!latest || latest.generation !== launched.generation) {
        throw new Error(
          `Task ${requested} revive became stale before launch completed`,
        );
      }
      return renderReviveOutput(idParam, latest);
    },
  });

  return { task_revive };
}

/**
 * Owns a single compensating abort after deletion invalidates an accepted
 * admission. The board retains the token even without a job: no TTL, retry,
 * terminal publication, or recovery is allowed on this path.
 */
async function ownInvalidatedAdmission(
  options: TaskReviveToolOptions,
  lease: BackgroundJobLease,
): Promise<void> {
  const board = options.backgroundJobs;
  const { taskID, generation } = lease;
  const stillOwns = () => {
    const valid = board.validateLease(lease) && !board.get(taskID);
    if (!valid)
      log('[task-revive] compensation ownership lost', { taskID, generation });
    return valid;
  };
  try {
    const session = getClient(options.input).session;
    // No await between this fence and issuing the only compensating write.
    if (!stillOwns()) return;
    const response = await session.abort({ path: { id: taskID } });
    // No local abort timeout: an idle read cannot retire a token while the
    // remote write could still execute. Only actual settlement reaches here.
    if (!stillOwns()) return;
    const apiError = responseError(response);
    if (apiError !== undefined)
      throw new Error(`abort failed: ${errorText(apiError)}`);

    // Historical session.get outcomes cannot prove the accepted run stopped.
    // Take fresh live evidence after abort settlement, with a bounded budget.
    const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
      timeoutMs: options.verifyAbortMs ?? 1_500,
    });
    if (!stillOwns()) return;
    const status = snapshot.statuses.get(taskID);
    if (
      snapshot.error !== undefined ||
      snapshot.malformedSessionIDs.has(taskID) ||
      status === 'busy' ||
      status === 'retry'
    ) {
      throw new Error(
        `live quiescence not verified: ${snapshot.error ?? status ?? 'malformed entry'}`,
      );
    }

    // Valid idle/absence proves current quiescence, not purging queued work.
    // Revalidate above and release synchronously: never retire a successor.
    board.releaseLease(lease);
    log('[task-revive] compensation quiescence verified', {
      taskID,
      generation,
    });
  } catch (error) {
    // Explicit quarantine: retain exclusion without fabricating a cancelled
    // record or notifying a deleted parent. No automatic recovery/retry.
    log('[task-revive] compensation unconfirmed', {
      taskID,
      generation,
      error: errorText(error),
      leaseRetained: board.validateLease(lease),
    });
  }
}

function renderReviveOutput(
  idParam: string,
  record: NonNullable<
    ReturnType<TaskReviveToolOptions['backgroundJobs']['get']>
  >,
  admissionUnknown = false,
): string {
  const state =
    record.state === 'reconciled'
      ? (record.terminalState ?? record.state)
      : record.state;
  const lines = [
    `${idParam}: ${record.taskID}`,
    `generation: ${record.generation}`,
    `state: ${state}`,
    `status: ${admissionUnknown ? 'admission_unknown' : state === 'running' ? 'started' : state}`,
  ];
  if (record.statusUncertain) {
    lines.push(
      'status_uncertain: true',
      `observation: ${record.lastStatusError ?? 'Task termination is unconfirmed.'}`,
    );
  }
  if (admissionUnknown) {
    lines.push(
      'The host may have accepted the prompt. Admission is still pending; do not retry task_revive. Use task_status to inspect the session.',
    );
  } else if (record.resultSummary !== undefined) {
    const tag = state === 'completed' ? 'task_result' : 'task_error';
    lines.push('', `<${tag}>`, record.resultSummary, `</${tag}>`);
  }
  return lines.join('\n');
}

function getCurrentReviveJob(
  options: TaskReviveToolOptions,
  parentSessionID: string,
  taskID: string,
  generation: number,
): NonNullable<ReturnType<TaskReviveToolOptions['backgroundJobs']['get']>> {
  const current = options.backgroundJobs.get(taskID);
  if (!current || current.parentSessionID !== parentSessionID) {
    throw new Error(
      `Task ${taskID} is no longer tracked; refusing stale revive`,
    );
  }
  if (current.generation !== generation) {
    throw new Error(
      `Task ${taskID} run generation changed; refusing stale revive`,
    );
  }
  return current;
}

function isReviveableRetainedJob(
  job: NonNullable<ReturnType<TaskReviveToolOptions['backgroundJobs']['get']>>,
): boolean {
  if (job.statusUncertain) return false;
  if (job.state === 'stopped') return true;
  if (
    job.state === 'completed' ||
    job.state === 'error' ||
    job.state === 'cancelled'
  ) {
    return true;
  }
  return job.state === 'reconciled' && job.terminalState !== undefined;
}

/** Shared recovery verifies ownership and agent before adopting a continuation. */
async function resolveOrAdoptUntrackedTask(
  options: TaskReviveToolOptions,
  parentSessionID: string,
  requested: string,
  allowExactAdoption: boolean,
): Promise<string | undefined> {
  const prefix = `Unknown or unowned background task: ${requested}`;
  const recovery = await options.recoverRetainedSession({
    parentSessionID,
    requested,
    purpose: 'revive',
    allowExactAdoption,
    allowQueuedContinuation: supportsQueuedContinuation(options),
  });
  if (recovery.kind === 'refused') return recovery.reason;
  if (options.isDisposed?.()) return 'Session recovery was disposed';
  if (recovery.kind !== 'adoptable') return undefined;
  const raced = options.backgroundJobs.get(recovery.taskID);
  if (raced)
    return raced.parentSessionID === parentSessionID
      ? undefined
      : `${prefix}. Tracking does not survive a host restart; verify whether the host restored it before re-dispatching.`;
  if (
    options.backgroundJobs.ledger.deletionEpochs.get(recovery.taskID) !==
    recovery.deletionEpoch
  ) {
    return `Task ${requested} was deleted during recovery; no prompt was sent`;
  }
  const adopted = options.backgroundJobs.registerLaunch({
    taskID: recovery.taskID,
    parentSessionID,
    agent: recovery.agent,
    description: recovery.description,
    background: true,
    adopted: true,
    now: Date.now(),
  });
  // Until a continuation is accepted this row still represents recovered
  // host work, including across a refused pre-send attempt.
  adopted.recoveredWithoutPrompt = true;
  log('[task-revive] adopted untracked session', {
    taskID: recovery.taskID,
    parentSessionID,
    agent: recovery.agent,
  });
  return undefined;
}

function supportsQueuedContinuation(options: TaskReviveToolOptions): boolean {
  return (
    (options.input as { experimental_v2?: ExperimentalV2 }).experimental_v2
      ?.queuedPromptIdentity === true
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
