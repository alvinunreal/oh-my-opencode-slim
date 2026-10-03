import { randomUUID } from 'node:crypto';
import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { RevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import type { BackgroundJobLease } from '../utils/background-job-board';
import { getSuppressionTombstone } from '../utils/background-job-persistence';
import { clearBackgroundJobSuppression } from '../utils/background-job-store';
import type { BackgroundJobSupervisor } from '../utils/background-job-supervisor';
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
  backgroundJobSupervisor?: BackgroundJobSupervisor;
  revivedRunTracker: RevivedRunTracker;
  baselineTimeoutMs?: number;
  admissionTimeoutMs?: number;
  waitForIdleTimeoutMs?: number;
}

export function createTaskReviveTool(
  options: TaskReviveToolOptions,
): Record<'task_revive', ToolDefinition> {
  const revivedRunTracker = options.revivedRunTracker;
  const idParam = idParamFor(options.input);
  const task_revive = tool({
    description:
      'Revive a retained background task in its existing session with a new prompt. Tracking does not survive a host restart; an untracked session owned by this parent is verified against the host and re-adopted on demand.',
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

      let resolved = options.backgroundJobBoard.resolve(
        parentSessionID,
        requested,
      );
      let adopted = false;
      if (!resolved) {
        const guidance = await resolveOrAdoptUntrackedTask(
          options,
          parentSessionID,
          requested,
        );
        if (guidance !== undefined) throw new Error(guidance);
        // undefined ⇒ adopted: the board now owns a fresh record for this
        // session, so the resolution below must be repeated.
        resolved = options.backgroundJobBoard.resolve(
          parentSessionID,
          requested,
        );
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
        requested,
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
        await cancelTrackedExecution(options, captured, 'revived');
        cancelledForRevive = true;
        current = getCurrentReviveJob(
          options,
          parentSessionID,
          requested,
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

      const relaunchLease = options.backgroundJobBoard.acquireRelaunchLease(
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
        | ReturnType<
            TaskControlToolOptions['backgroundJobBoard']['registerLaunch']
          >
        | undefined;
      try {
        const observedLiveBusyAt = current.lastLiveBusyAt;
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
          requested,
          captured.taskID,
          captured.generation,
        );
        if (
          !options.backgroundJobBoard.validateLease(relaunchLease) ||
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
        if (promptMessageID) {
          // Own this one input before sending. A late acknowledgement must
          // never reinstall the tracker after it has delivered the answer.
          launched = options.backgroundJobBoard.registerLaunch({
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
              throw new Error(errorText(apiError));
            }
            if (queueContinuation) {
              if (
                !launched ||
                options.backgroundJobBoard.get(captured.taskID)?.generation !==
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
              !options.backgroundJobBoard.get(captured.taskID) &&
              options.backgroundJobBoard.validateLease(relaunchLease)
            ) {
              owner.transferred = true;
              // Starts synchronously under the lease, independently of the
              // admission race. Its abort is never awaited by this caller.
              void ownInvalidatedAdmission(options, relaunchLease);
              throw new Error(
                'admission accepted but invalidated by loss of the record; compensation initiated',
              );
            }
            launched = options.backgroundJobBoard.registerLaunch({
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
            options.backgroundJobSupervisor?.onLaunch(launched);
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
              options.backgroundJobBoard.releaseLease(relaunchLease);
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
              options.backgroundJobBoard.markStatusUncertain(
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
        if (!admissionOwner)
          options.backgroundJobBoard.releaseLease(relaunchLease);
      }

      if (!launched) {
        throw new Error(`Task ${requested} revive did not launch`);
      }
      const latest = options.backgroundJobBoard.get(current.taskID);
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
  const board = options.backgroundJobBoard;
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
    ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>
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
  requested: string,
  taskID: string,
  generation: number,
): NonNullable<ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>> {
  const current = options.backgroundJobBoard.get(taskID);
  const resolved = options.backgroundJobBoard.resolve(
    parentSessionID,
    requested,
  );
  if (!current || !resolved || resolved.taskID !== taskID) {
    throw new Error(
      `Task ${requested} is no longer tracked; refusing stale revive`,
    );
  }
  if (current.generation !== generation || resolved.generation !== generation) {
    throw new Error(
      `Task ${requested} run generation changed; refusing stale revive`,
    );
  }
  return current;
}

function isReviveableRetainedJob(
  job: NonNullable<
    ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>
  >,
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

/**
 * Untracked-revive guidance, distinguished by what the host still knows.
 *
 * - Alias input: aliases are deliberately not restored after a restart
 *   (persistence header); the session may still exist under its ID.
 * - Session-ID input: one read-only `session.get` probe tells the caller
 *   whether the host still has it — possibly auto-resumed by the host's
 *   own recovery, in which case re-dispatching would duplicate the work.
 * - Probe failure: stay neutral instead of advising a write.
 */
/**
 * Untracked-revive handling (the #1387 P0 adopt-on-miss design).
 *
 * The board record is process-local and deliberately not restored after a
 * restart, while the child session itself is durable at the host. On a
 * resolve miss this function turns guidance into adoption when the host
 * proves the session belongs to this caller:
 *
 * 1. Alias input: aliases are deliberately not restored; guide instead.
 * 2. `session.get` probe (read-only): gone → re-dispatch advice; transport
 *    or API error → neutral verify advice.
 * 3. Ownership: `data.parentID` must equal the caller — the host-endorsed
 *    ledger. Every non-adoptable probe outcome (gone, API error, transport
 *    failure, foreign parent) returns one byte-identical generic response:
 *    the probe must not become an existence oracle for foreign sessions.
 * 4. V2 with prompt/context queues a new input without asserting live idle.
 *    V1 live-state gate (`getRuntimeSessionStatusSnapshot`): busy/retry → the
 *    host may have restored the task; its result is still delivered, so
 *    refuse adoption and forbid re-dispatch. Malformed snapshot → retry.
 * 4b. Persisted terminal result: an evicted task that already completed
 *     with a result returns it instead of re-prompting (tombstone cleared;
 *     the deletion epoch survives, so a later revive adopts normally).
 * 5. Adopt: `registerLaunch` rebuilds the record (state `running`,
 *    generation from the process sequence; the persisted deletion epoch
 *    survives and keeps fencing late pre-restart artifacts, while the
 *    tombstone itself is cleared by registerLaunch for this proven
 *    explicit relaunch). The revive pipeline never aborts an adopted
 *    record: if the host resumed the session between the gate and the
 *    send, the pre-send live re-verification refuses (the record stays
 *    accurately `running`) — recovered work is never cancelled.
 *
 * Returns undefined when the session was adopted (the caller continues
 * into the normal revive flow); otherwise returns the guidance message.
 */
async function resolveOrAdoptUntrackedTask(
  options: TaskReviveToolOptions,
  parentSessionID: string,
  requested: string,
): Promise<string | undefined> {
  const prefix = `Unknown or unowned background task: ${requested}`;
  // One byte-identical response for every non-adoptable probe outcome: the
  // probe must not become an existence oracle for foreign sessions.
  const generic = `${prefix}. Tracking does not survive a host restart; verify whether the host restored it before re-dispatching.`;
  if (!SESSION_ID_PATTERN.test(requested)) {
    return `${prefix}. Aliases do not survive a host restart; retry with the task's session ID from history or notifications, or re-dispatch the work.`;
  }
  let data: Record<string, unknown>;
  try {
    const session = getClient(options.input).session;
    const response = await (
      session.get as unknown as (
        args: Record<string, unknown>,
      ) => Promise<unknown>
    )({
      path: { id: requested },
      query: { directory: options.input.directory },
    });
    if (responseError(response) !== undefined) return generic;
    const probed = (response as Record<string, unknown> | undefined)?.data;
    if (probed === undefined || probed === null) return generic;
    data = probed as Record<string, unknown>;
  } catch {
    return generic;
  }
  if (data.parentID !== parentSessionID) return generic;
  const queueContinuation = supportsQueuedContinuation(options);
  // V1 cannot attribute a queued input by identity. Its adoption path keeps
  // the live-state gate; V2 deliberately admits a follow-up even when busy.
  if (
    !queueContinuation &&
    typeof getClient(options.input).session.status !== 'function'
  ) {
    return `${prefix}. This host does not expose the live session-status capability required to safely adopt an untracked session. Waiting for completion cannot establish whether recovered work is already running. No session was adopted, aborted, or prompted. Retrying task_revive on this host will not resolve the missing capability; inspect the existing session before deciding whether to dispatch more work.`;
  }
  if (!queueContinuation) {
    const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
      timeoutMs: options.verifyAbortMs ?? 1_500,
    });
    const liveStatus = snapshot.statuses.get(requested);
    if (liveStatus === 'busy' || liveStatus === 'retry') {
      return `${prefix}. The host is executing that session (it may have been restored after a restart); its result is still delivered on completion — do not re-dispatch.`;
    }
    if (
      snapshot.error !== undefined ||
      snapshot.malformedSessionIDs.has(requested)
    ) {
      return `${prefix}. The host could not confirm the session state (${
        snapshot.error ?? 'malformed entry'
      }); retry task_revive.`;
    }
    const tombstone = getSuppressionTombstone(requested);
    if (tombstone?.terminalState !== undefined && tombstone.resultSummary) {
      // The task completed and was evicted before the tracking loss. Surface
      // the recorded result instead of re-prompting the child, and clear the
      // tombstone (the deletion epoch survives, so fencing stays intact) so a
      // later task_revive adopts and continues the session normally.
      clearBackgroundJobSuppression(options.backgroundJobBoard, requested);
      const ending =
        tombstone.terminalState === 'completed'
          ? 'completed'
          : `ended in state ${tombstone.terminalState}`;
      return `${prefix}. The session ${ending} before the tracking loss; its recorded result: ${tombstone.resultSummary}. Re-dispatch only if this result does not satisfy the objective.`;
    }
  }
  // Another caller may have adopted while our ownership probe was in flight.
  // Preserve its generation and lease instead of replacing its admission.
  if (options.backgroundJobBoard.resolve(parentSessionID, requested))
    return undefined;
  const agent =
    typeof data.agent === 'string' && data.agent ? data.agent : 'unknown';
  const title =
    typeof data.title === 'string' && data.title ? data.title : undefined;
  // V1 re-verifies live state before sending; V2 installs its input identity
  // under the relaunch lease before sending. Neither aborts adopted work.
  options.backgroundJobBoard.registerLaunch({
    taskID: requested,
    parentSessionID,
    agent,
    description: title ? `recovered: ${title}` : 'recovered background task',
    background: true,
    now: Date.now(),
  });
  log('[task-revive] adopted untracked session', {
    taskID: requested,
    parentSessionID,
    agent,
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
