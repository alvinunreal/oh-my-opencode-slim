/**
 * Tool execute hooks for task session manager.
 *
 * Handles `tool.execute.before` (task tool: pending call creation,
 * reusable/recoverable task_id resolution) and `tool.execute.after`
 * (read context tracking, task launch registration/update from output).
 */
import type {
  BackgroundJobBoard,
  BackgroundJobSupervisor,
  BackgroundTaskConcurrency,
  ContextFile,
  TaskOutputState,
} from '../../utils';
import {
  deriveFullObjective,
  deriveTaskSessionLabel,
  maskTaskOutputStructure,
  parseTaskIdFromTaskOutput,
  parseTaskLaunchOutput,
  parseTaskStatusOutput,
} from '../../utils';
import type { BackgroundJobRecord } from '../../utils/background-job-board';
import { getBackgroundJobLifecycleLedger } from '../../utils/background-job-board';
import type { BackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import { isRecord as isObjectRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import { controlParamName } from '../../v2/adapters';
import {
  type DelegationWording,
  delegationWording,
  v2ResumeCall,
} from '../../v2/delegation';
import { isMissingRememberedSessionError } from './board-injection';
import type { PendingTaskCall } from './pending-call-tracker';
import { convertSameProviderBackgroundTask } from './same-provider-policy';
import {
  appendChildRefSuffix,
  type CanonicalTaskReference,
  noteExactSessionAlias,
  pluginDisposedMessage,
  type RetainedRecoveryResult,
  unrecognizedTaskReferenceMessage,
} from './session-recovery';
import { normalizeLateCancelledTaskOutput } from './status-utils';
import {
  extractReadFiles,
  filterStaleContextFiles,
} from './task-context-tracker';

interface TaskArgs {
  description?: unknown;
  prompt?: unknown;
  subagent_type?: unknown;
  task_id?: unknown;
  background?: unknown;
}

interface ResumeRefusalJob {
  taskID: string;
  alias: string;
  agent: string;
  state: string;
  terminalUnreconciled: boolean;
}

function normalizeObjectiveKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Trigger line the orchestrator emits on a council synthesis call: the
 * session IDs / board aliases the seat dispatches returned, which the
 * harness resolves host-side from its own job board, so the
 * orchestrator never re-emits seat text as output tokens (Mixture-of-Agents
 * assembly with an independent judge). No /g flag: lastIndex state would
 * skip matches across the findIndex/exec passes. */
const COUNCIL_SEATS_LINE_PATTERN = /^Seats:\s*(.+)$/;

/** Seat body per the assembly contract; read-only over the record. Only a
 * completed terminal with text is a real response — lifecycle diagnostics
 * (cancelled/error/stopped text) must never be injected as a councillor's
 * opinion (the task_status result mode refuses non-completed terminals). */
function councilSeatBody(record: BackgroundJobRecord | undefined): string {
  if (!record) return '[no response — unresolved ref]';
  if (record.state === 'running') return '[no response — still running]';
  const terminal =
    record.state === 'reconciled'
      ? (record.terminalState ?? 'reconciled')
      : record.state;
  if (
    terminal === 'completed' &&
    record.resultSummary &&
    record.resultSummary.trim() !== ''
  ) {
    // Verbatim: resultSummary holds the child's full terminal text.
    return record.resultSummary;
  }
  return `[no response — no output (${terminal})]`;
}

/**
 * Host-side council seat assembly. When a council call's prompt carries a
 * `Seats: <id, id>` line (the IDs the seat dispatches returned), resolve
 * each ref against the CALLER's own board
 * rows (the same parent-scoped invariant the control tools enforce — a ref
 * owned by another parent never resolves), strip the trigger line, and
 * append one `## Seat: <name>` section per ref. The FINAL matching line is
 * used, so a `Seats:` roster quoted in the question cannot shadow the
 * orchestrator's refs. A trigger line with refs always rewrites: unresolved
 * refs (restart, eviction, cross-conversation) become per-seat placeholders
 * so the council sees which seats are missing. Resolution is strictly
 * read-only: no markUsed, no reconcile, no board mutation, and never a wait
 * on a running seat (a still-running ref gets a placeholder).
 */
function assembleCouncilSeatResponses(
  args: TaskArgs,
  parentSessionID: string,
  board: BackgroundJobBoard,
): void {
  if (typeof args.prompt !== 'string') return;
  const lines = args.prompt.split('\n');
  const triggerIndex = lines.findLastIndex((line) =>
    COUNCIL_SEATS_LINE_PATTERN.test(line),
  );
  if (triggerIndex === -1) return;
  const refs = (COUNCIL_SEATS_LINE_PATTERN.exec(lines[triggerIndex])?.[1] ?? '')
    .split(',')
    .map((ref) => ref.trim())
    .filter((ref) => ref !== '');
  // A trigger line always rewrites, so the council never receives a bare ID
  // line it cannot use: unresolved refs (restart, eviction,
  // cross-conversation) become per-seat placeholders, and a malformed
  // empty-refs line reports itself instead of passing through silently.
  const sections =
    refs.length === 0
      ? ['[no seat references were provided]']
      : refs.map((ref) => {
          const record = board.resolve(parentSessionID, ref);
          return `## Seat: ${record?.agent || ref}\n${councilSeatBody(record)}`;
        });
  const kept = [
    ...lines.slice(0, triggerIndex),
    ...lines.slice(triggerIndex + 1),
  ]
    .join('\n')
    .replace(/\n+$/, '');
  // Single assignment: the trigger is stripped and the sections appended as
  // one new string, so nothing can observe (or throw out of) a half-rewritten
  // prompt — the assembly's sole idempotence guarantee now that the
  // `## Seat:` sentinel is gone.
  const assembled = `${kept}\n\n${sections.join('\n\n')}`;
  args.prompt = assembled;
  log('[task-session-manager] council seat assembly applied', {
    parentSessionID,
    seats: refs.length,
    promptLength: assembled.length,
  });
}

function refuseExplicitTaskId(
  requested: string,
  message: string,
  details?: Record<string, unknown>,
): never {
  log('[task-session-manager] refused explicit task_id', {
    task_id: requested,
    ...details,
  });
  throw new Error(message);
}

function isNativeResumable(
  job: BackgroundJobRecord,
  agentType: string,
): boolean {
  return job.agent === agentType;
}

/** A v2 native steer: a resumed call with no relaunch lease — the after-
 * hook's resumed-output guard identifies it the same way. Shared with the
 * two admission sites so the steer contract has one source of truth. */
function isSteeredCall(pending: {
  resumedTaskId?: string;
  relaunchLease?: unknown;
}): boolean {
  return (
    pending.resumedTaskId !== undefined && pending.relaunchLease === undefined
  );
}

function refuseKnownTaskResume(
  requested: string,
  job: ResumeRefusalJob,
  agentType: string,
  delegation: DelegationWording,
): never {
  const label = `${job.alias} / ${job.taskID}`;
  // v2 retired task_revive: continuation is the native delegation resume.
  const continueHint =
    delegation.tool === 'subagent'
      ? `Continue it with ${v2ResumeCall(job.taskID)}.`
      : 'Use task_revive with a new prompt.';
  if (job.agent !== agentType) {
    refuseExplicitTaskId(
      requested,
      `${label}: agent is ${job.agent}, not ${agentType}. ${delegation.tool}() cannot resume this session. No new session was created.`,
      { state: job.state, agent: job.agent, requestedAgent: agentType },
    );
  }
  if (job.state === 'stopped') {
    const ack = job.terminalUnreconciled ? 'unreconciled' : 'acknowledged';
    refuseExplicitTaskId(
      requested,
      `${label}: stopped, ${ack}; ${delegation.tool}() cannot resume this session. ${continueHint} No new session was created.`,
      { state: job.state, acknowledged: !job.terminalUnreconciled },
    );
  }
  if (job.terminalUnreconciled) {
    refuseExplicitTaskId(
      requested,
      delegation.tool === 'task'
        ? `${label}: ${job.state}, unreconciled; task() cannot resume until acknowledgement. Call task_revive(task_id: "${job.taskID}", prompt: "...") directly; it continues that same session. No result read is required first. This prompt was not sent.`
        : `${label}: ${job.state}, unreconciled; ${delegation.tool}() cannot resume this session. ${continueHint} It was not dropped; no new session was created. This prompt was not sent.`,
      { state: job.state, terminalUnreconciled: true },
    );
  }
  refuseExplicitTaskId(
    requested,
    `${label}: ${job.state}; ${delegation.tool}() cannot resume this session. ${continueHint} No new session was created.`,
    { state: job.state },
  );
}

export async function handleToolExecuteBefore(
  input: { tool: string; sessionID?: string; callID?: string },
  output: { args?: unknown },
  deps: {
    shouldManageSession: (sessionID: string) => boolean;
    registerSessionAsOrchestrator?: (sessionID: string) => void;
    backgroundJobBoard: BackgroundJobBoard;
    pendingCallTracker: {
      add(call: PendingTaskCall): void;
      take(
        callID?: string,
        sessionID?: string,
        ownerBoard?: BackgroundJobBoard,
        options?: { recordConsumed?: boolean },
      ): PendingTaskCall | undefined;
      release?(call: PendingTaskCall): void;
      pendingCallId(sessionID?: string, callID?: string): string;
    };
    taskContextTracker: { pendingManagedTaskIds: Set<string> };
    backgroundJobSupervisor?: BackgroundJobSupervisor;
    backgroundTaskConcurrency?: BackgroundTaskConcurrency;
    getModelForAgent?: (
      agentType: string,
      parentSessionID?: string,
    ) => string | undefined;
    /** Current "provider/model" for a session (parent metadata store). */
    getSessionModel?: (sessionID: string) => string | undefined;
    /** Opt-in provider → "foreground" map for same-provider conversion. */
    sameProviderPolicy?: Record<string, 'foreground'>;
    getLifecycleEpoch?: () => number;
    /** Host flavor marker ('v2' on OpenCode v2 hosts); selects the native
     * delegation vocabulary for model-visible refusal guidance. Defaults to
     * v1 wording. */
    hostFlavor?: string;
    /** Per-instance pairing flag for the background-default flip: true only
     * after this setup's v2 description rewrite verifiably landed. */
    isBackgroundDefaultFlipArmed?: () => boolean;
    recoverRetainedSession?: (request: {
      parentSessionID: string;
      requested: string;
      agent?: string;
      purpose?: 'revive';
      allowExactAdoption?: boolean;
      allowQueuedContinuation?: boolean;
    }) => Promise<RetainedRecoveryResult>;
    resolveCanonicalTaskRef?: (
      parentSessionID: string,
      requested: string,
    ) => Promise<CanonicalTaskReference>;
    isDisposed?: () => boolean;
    adoptRequested?: (
      parent: string,
      requested: string,
      agent: string,
    ) => Promise<'adopted' | 'unchecked' | 'rejected'>;
  },
): Promise<void> {
  const toolName = input.tool.toLowerCase();
  if (toolName !== 'task') return;
  if (!input.sessionID) return;
  const delegation = delegationWording(deps.hostFlavor);
  if (!deps.shouldManageSession(input.sessionID)) {
    // ponytail: no agent-identity guard here — at tool.execute.before
    // time there's no message to inspect. Only orchestrators call `task`
    // in standard architecture; non-orchestrator false-positives are
    // accepted because leaf agents don't use this tool.
    deps.registerSessionAsOrchestrator?.(input.sessionID);
    if (!deps.shouldManageSession(input.sessionID)) return;
    log('[task-session-manager] recovered stale orchestrator mapping', {
      sessionID: input.sessionID,
    });
  }
  if (!isObjectRecord(output.args)) return;

  const args = output.args as TaskArgs;
  // Background-default flip (v2 only): the native `subagent` schema has no
  // default, so an omitted `background` silently blocks the parent turn —
  // measured 2:1 foreground habit even in orchestration sessions. Flip the
  // omitted-parameter default to background for managed sessions; explicit
  // `false` (dependent work) and explicit `true` pass through untouched.
  // Gated on the per-instance pairing flag: the flip only runs once this
  // setup's v2 description rewrite verifiably landed (arm via
  // 'v2.backgroundDefaultFlip') — otherwise the native foreground default
  // keeps operating end-to-end with its native wording intact. v1 hosts
  // keep the full native behavior (no flavor gate entry).
  if (deps.hostFlavor === 'v2' && deps.isBackgroundDefaultFlipArmed?.()) {
    if (args.background === undefined) {
      args.background = true;
      log('[task-session-manager] v2 background default applied', {
        sessionID: input.sessionID,
      });
    } else {
      // Observation lamp for the explicit lane: `false` usage is the
      // dependent-work health metric; `true` distinguishes model-chosen
      // background from the rewritten default.
      log('[task-session-manager] v2 background explicit', {
        sessionID: input.sessionID,
        background: args.background,
      });
    }
  }
  if (typeof args.task_id === 'string' && args.task_id.trim() === '') {
    refuseExplicitTaskId(
      args.task_id,
      `${delegation.tool}() received an empty ${delegation.resumeParam}. It was not treated as omitted; no new session was created. Omit ${delegation.resumeParam} on a separate call to start a new session.`,
      { empty: true },
    );
  }
  if (
    typeof args.subagent_type !== 'string' ||
    args.subagent_type.trim() === ''
  ) {
    if (typeof args.task_id === 'string' && args.task_id.trim() !== '') {
      const requested = args.task_id.trim();
      refuseExplicitTaskId(
        requested,
        `Task ${requested}: ${delegation.tool}() requires a valid ${delegation.agentParam} with an explicit ${delegation.resumeParam}. The ${delegation.resumeParam} was not dropped; no new session was created.`,
      );
    }
    return;
  }

  const agentType = args.subagent_type.trim();
  // Council Mode host-side assembly (both host flavors arrive here: the v2
  // execute.before bridge normalizes `subagent` calls into this v1 `task`
  // shape before the hook runs, so one injection point covers both).
  // Unconditional and fail-open: the resolver only acts on a final Seats
  // line and never refuses — a shape check that fails closed (rejecting
  // prompts whose quoted content mentions a Seats line) would DoS
  // legitimate council calls, while anything without the trigger passes
  // through byte-identically.
  if (agentType === 'council') {
    assembleCouncilSeatResponses(
      args,
      input.sessionID,
      deps.backgroundJobBoard,
    );
  }
  if (typeof args.task_id === 'string' && args.task_id.trim() !== '') {
    const canonical = deps.resolveCanonicalTaskRef
      ? await deps.resolveCanonicalTaskRef(input.sessionID, args.task_id.trim())
      : undefined;
    if (deps.isDisposed?.() || canonical?.kind === 'refused') {
      refuseExplicitTaskId(
        args.task_id.trim(),
        canonical?.kind === 'refused'
          ? canonical.reason
          : pluginDisposedMessage(),
        { unresolved: true },
      );
    }
    if (canonical?.kind === 'exact') args.task_id = canonical.taskID;
  }
  let background = args.background === true;
  if (background) {
    const conversion = convertSameProviderBackgroundTask({
      agentType,
      parentSessionID: input.sessionID,
      args,
      policy: deps.sameProviderPolicy,
      getParentModel: (id) => deps.getSessionModel?.(id),
      getChildModel: (agent, parent) => deps.getModelForAgent?.(agent, parent),
    });
    if (conversion.converted) {
      background = false;
      log(
        '[task-session-manager] same-provider background task converted to foreground',
        {
          parentProvider: conversion.parentProvider,
          childProvider: conversion.childProvider,
          agentType,
          parentSessionID: input.sessionID,
        },
      );
    }
  }

  const label = deriveTaskSessionLabel({
    description:
      typeof args.description === 'string' ? args.description : undefined,
    prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
    agentType,
  });

  const pendingCall: PendingTaskCall = {
    callId: deps.pendingCallTracker.pendingCallId(
      input.sessionID,
      input.callID,
    ),
    parentSessionId: input.sessionID,
    agentType,
    label,
    background,
    lifecycleEpoch: deps.getLifecycleEpoch?.() ?? 0,
    releaseLease: (lease) => deps.backgroundJobBoard.releaseLease(lease),
  };
  pendingCall.fullObjective = deriveFullObjective({
    description:
      typeof args.description === 'string' ? args.description : undefined,
    prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
  });
  if (typeof args.task_id === 'string' && args.task_id.trim() !== '') {
    const requested = args.task_id.trim();
    let remembered =
      deps.backgroundJobBoard.resolveReusable(
        input.sessionID,
        requested,
        agentType,
      ) ??
      deps.backgroundJobBoard.resolveRecoverable(
        input.sessionID,
        requested,
        agentType,
      );

    if (!remembered) {
      const knownManagedTask = deps.backgroundJobBoard.resolve(
        input.sessionID,
        requested,
      );
      if (knownManagedTask?.state === 'running') {
        if (deps.hostFlavor === 'v2' && knownManagedTask.agent === agentType) {
          // Native steer: the host continues a running child safely. The
          // board row keeps its generation; no lease, no markUsed, and the
          // output is not registered as a new launch.
          remembered = knownManagedTask;
        } else if (deps.hostFlavor === 'v2') {
          refuseKnownTaskResume(
            requested,
            knownManagedTask,
            agentType,
            delegation,
          );
        } else {
          throw new Error(
            `Task ${requested} is still running and cannot be resumed or amended with ${delegation.tool}(). Do not spawn or cancel a duplicate for an additive request. Wait for its terminal result, then resume the session after that terminal notification is acknowledged if follow-up work is still needed.`,
          );
        }
      } else if (
        knownManagedTask &&
        deps.hostFlavor === 'v2' &&
        isNativeResumable(knownManagedTask, agentType)
      ) {
        remembered = knownManagedTask;
      } else if (knownManagedTask) {
        refuseKnownTaskResume(
          requested,
          knownManagedTask,
          agentType,
          delegation,
        );
      } else {
        let adoption: 'adopted' | 'unchecked' | 'rejected' | undefined;
        if (
          deps.hostFlavor !== 'v2' &&
          requested.startsWith('ses_') &&
          deps.adoptRequested
        ) {
          adoption = await deps.adoptRequested(
            input.sessionID,
            requested,
            agentType,
          );
          if (deps.isDisposed?.()) {
            throw new Error(
              `${pluginDisposedMessage()} No session was created.`,
            );
          }
          if (adoption === 'adopted') {
            remembered = deps.backgroundJobBoard.resolveReusable(
              input.sessionID,
              requested,
              agentType,
            );
          }
        } else if (deps.hostFlavor === 'v2' && deps.recoverRetainedSession) {
          const recovery = await deps.recoverRetainedSession({
            parentSessionID: input.sessionID,
            requested,
            agent: agentType,
            purpose: 'revive',
            allowQueuedContinuation: true,
          });
          if (deps.isDisposed?.()) {
            throw new Error(
              `${pluginDisposedMessage()} No session was created.`,
            );
          }
          let restored = deps.backgroundJobBoard.resolve(
            input.sessionID,
            requested,
          );
          if (!restored && recovery.kind === 'adoptable') {
            // Restart untracked-incomplete adoption: the host may still be
            // running the round the board lost. Adopt the verified identity
            // the way task_revive did, so the native resume below owns a
            // tracked record instead of leaving the seat a permanent
            // unresolved placeholder.
            const raced = deps.backgroundJobBoard.get(recovery.taskID);
            if (raced && raced.parentSessionID !== input.sessionID) {
              refuseExplicitTaskId(
                requested,
                `Task ${requested}: tracking does not survive a host restart and the recovered session belongs to a different parent; verify whether the host restored it before re-dispatching.`,
                { unresolved: true },
              );
            }
            if (
              getBackgroundJobLifecycleLedger(
                deps.backgroundJobBoard,
              ).deletionEpochs.get(recovery.taskID) !== recovery.deletionEpoch
            ) {
              refuseExplicitTaskId(
                requested,
                `Task ${requested} was deleted during recovery; no prompt was sent.`,
                { unresolved: true, deleted: true },
              );
            }
            if (raced) {
              restored = raced;
            } else {
              const adopted = deps.backgroundJobBoard.registerLaunch({
                taskID: recovery.taskID,
                parentSessionID: input.sessionID,
                agent: recovery.agent,
                description: recovery.description,
                background: true,
                adopted: true,
                now: Date.now(),
              });
              // Until a continuation is accepted this row still represents
              // recovered host work, including across a refused attempt.
              adopted.recoveredWithoutPrompt = true;
              log('[task-session-manager] adopted untracked session', {
                taskID: recovery.taskID,
                parentSessionID: input.sessionID,
                agent: recovery.agent,
              });
              restored = adopted;
            }
          }
          if (restored && isNativeResumable(restored, agentType)) {
            remembered = restored;
          } else if (restored) {
            refuseKnownTaskResume(requested, restored, agentType, delegation);
          } else {
            const reason =
              recovery.kind === 'refused'
                ? recovery.reason
                : 'the host session could not be restored';
            refuseExplicitTaskId(
              requested,
              `Task ${requested}: ${delegation.tool}() cannot resolve this ${delegation.resumeParam}. ${reason} It was not dropped; no new session was created. This prompt was not sent.`,
              { unresolved: true },
            );
          }
        }
        if (!remembered) {
          refuseExplicitTaskId(
            requested,
            adoption === 'rejected' ||
              adoption === 'adopted' ||
              delegation.tool !== 'task'
              ? `Task ${requested}: ${delegation.tool}() cannot resolve this ${delegation.resumeParam}. It was not dropped; no new session was created. Omit ${delegation.resumeParam} on a separate call to start a new session.`
              : unrecognizedTaskReferenceMessage(requested),
            { unresolved: true },
          );
        }
      }
    }
    if (remembered) {
      if (deps.isDisposed?.()) {
        throw new Error(`${pluginDisposedMessage()} No session was created.`);
      }
      // A running v2 child is continued by native steer: the host owns the
      // timeline, so this call takes no relaunch lease, acknowledges no old
      // round, and publishes nothing. The resumedTaskId marker alone fences
      // the after-hook (no lease -> its resumed-output guard drops the ack).
      // v1 keeps the lease protocol (a running recoverable record there is a
      // timed-out relaunch, not a live steer).
      const steered =
        deps.hostFlavor === 'v2' && remembered.state === 'running';
      if (steered) {
        // Same generation fence as a relaunch: a cancellation or another
        // lifecycle operation that owns this generation must win.
        const fence = deps.backgroundJobBoard.acquireLease(
          remembered.taskID,
          remembered.generation,
          'relaunch',
        );
        if (!fence) {
          throw new Error(
            `Task ${requested} cannot be resumed safely: its current generation is already owned by another lifecycle operation. Do not launch a duplicate with the same ${delegation.resumeParam}.`,
          );
        }
        deps.backgroundJobBoard.releaseLease(fence);
      }
      if (!steered) {
        const relaunchLease = deps.backgroundJobBoard.acquireLease(
          remembered.taskID,
          remembered.generation,
          'relaunch',
        );
        if (!relaunchLease) {
          throw new Error(
            `Task ${requested} cannot be resumed safely: its current generation is already owned by another lifecycle operation. Do not launch a duplicate with the same ${delegation.resumeParam}.`,
          );
        }
        if (deps.isDisposed?.()) {
          deps.backgroundJobBoard.releaseLease(relaunchLease);
          throw new Error(`${pluginDisposedMessage()} No session was created.`);
        }
        // v2 reconciliation internalization: task_revive used to acknowledge
        // the previous round. The native resume path now owns it: with the
        // relaunch lease held and before the host sends the continuation,
        // acknowledge an unreconciled terminal or a retained stop. A failed
        // generation/revision validation aborts the resume.
        if (
          deps.hostFlavor === 'v2' &&
          (remembered.terminalUnreconciled || remembered.state === 'stopped')
        ) {
          const resumedGeneration = remembered.generation;
          const resumedRevision = remembered.terminalRevision;
          // An already-acknowledged retained stop has no old round left to
          // close: markReconciled is a no-op for it, so its fresh read below
          // is the only proof that the record did not change under the lease.
          const alreadyAcknowledgedStop =
            remembered.state === 'stopped' && !remembered.terminalUnreconciled;
          const acknowledged = deps.backgroundJobBoard.markReconciled(
            remembered.taskID,
            Date.now(),
            resumedGeneration,
            resumedRevision,
          );
          let settled = false;
          if (
            acknowledged &&
            acknowledged.generation === resumedGeneration &&
            acknowledged.terminalRevision === resumedRevision &&
            !acknowledged.terminalUnreconciled &&
            (acknowledged.state === 'reconciled' ||
              acknowledged.state === 'stopped')
          ) {
            settled = true;
            remembered = acknowledged;
          } else if (alreadyAcknowledgedStop) {
            const current = deps.backgroundJobBoard.get(remembered.taskID);
            settled =
              current !== undefined &&
              current.generation === resumedGeneration &&
              current.terminalRevision === resumedRevision &&
              current.state === 'stopped' &&
              !current.terminalUnreconciled;
          }
          if (!settled) {
            deps.backgroundJobBoard.releaseLease(relaunchLease);
            throw new Error(
              `Task ${requested} changed while its previous round was being acknowledged; the resume prompt was NOT sent and no duplicate was launched. Use task_status to inspect it.`,
            );
          }
        }
        deps.backgroundJobBoard.markUsed(input.sessionID, remembered.taskID);
        pendingCall.relaunchLease = relaunchLease;
      }
      args.task_id = remembered.taskID;
      deps.taskContextTracker.pendingManagedTaskIds.add(remembered.taskID);
      pendingCall.resumedTaskId = remembered.taskID;
    }
  }

  // New spawns only: block re-dispatch of an objective already owned by an
  // unreconciled terminal job from this parent (self-reinforcing dispatch
  // loop, #1070). The full objective text is compared, not the 48-char display
  // label, so long exact duplicates match while distinct objectives that only
  // share a truncated prefix stay unaffected.
  // Escape hatch: a task_status result read after completion updates
  // lastUsedAt beyond completedAt, marking the result as consumed and
  // authorizing retry.
  if (!pendingCall.resumedTaskId) {
    const objectiveKey = normalizeObjectiveKey(
      pendingCall.fullObjective ?? label,
    );
    const duplicate = deps.backgroundJobBoard
      .list(input.sessionID)
      .find(
        (job) =>
          job.agent === agentType &&
          job.terminalUnreconciled &&
          !(
            job.completedAt !== undefined && job.lastUsedAt > job.completedAt
          ) &&
          normalizeObjectiveKey(job.objective || job.description) ===
            objectiveKey,
      );
    if (duplicate) {
      throw new Error(
        `A background task with the same objective already finished and its result is awaiting acknowledgment: ${duplicate.alias} / ${duplicate.taskID}. Call task_status with result true and ${delegation.resumeParam} "${duplicate.taskID}" to retrieve it instead of spawning a duplicate. If the retrieved result is insufficient, retry the spawn after retrieval — retrieval authorizes the retry.`,
      );
    }
  }

  if (deps.isDisposed?.()) {
    if (pendingCall.relaunchLease) {
      deps.backgroundJobBoard.releaseLease(pendingCall.relaunchLease);
      pendingCall.relaunchLease = undefined;
    }
    throw new Error(`${pluginDisposedMessage()} No session was created.`);
  }
  try {
    deps.pendingCallTracker.add(pendingCall);
    if (pendingCall.background && deps.backgroundTaskConcurrency) {
      // Nested orchestration exemption: a session that is itself a managed
      // task already holds an admission slot. Waiting for another one while
      // the queue is saturated would deadlock — this session could never
      // finish, so its own slot could never be released. A native steer of
      // a running child adds no run either: the child owns its slot, and
      // queueing the steer behind it would deadlock the amendment.
      const isManagedTask = deps.backgroundJobBoard
        .taskIDs()
        .has(input.sessionID);
      if (!isManagedTask && !isSteeredCall(pendingCall)) {
        const ticket = deps.backgroundTaskConcurrency.acquire({
          model: deps.getModelForAgent?.(
            agentType,
            pendingCall.parentSessionId,
          ),
        });
        pendingCall.concurrencyTicket = ticket;
        await ticket.ready;
        if (deps.isDisposed?.()) {
          throw new Error(`${pluginDisposedMessage()} No session was created.`);
        }
      }
    }
  } catch (error) {
    const tracked = deps.pendingCallTracker.take(
      pendingCall.callId,
      undefined,
      undefined,
      {
        recordConsumed: false,
      },
    );
    if (tracked) deps.pendingCallTracker.release?.(tracked);
    else pendingCall.concurrencyTicket?.releaseIfUnbound();
    throw error;
  }
  log(
    '[task-session-manager] tool.execute.before task — pending call created',
    {
      callId: pendingCall.callId,
      parentSessionId: pendingCall.parentSessionId,
      agentType: pendingCall.agentType,
      label: pendingCall.label,
      inputCallID: input.callID,
      inputSessionID: input.sessionID,
    },
  );
}

export async function handleToolExecuteAfter(
  input: { tool: string; sessionID?: string; callID?: string },
  output: { output: unknown; metadata?: unknown },
  deps: {
    directory: string;
    backgroundJobBoard: BackgroundJobBoard;
    terminalGate: BackgroundJobTerminalGate;
    pendingCallTracker: {
      take(
        callID?: string,
        sessionID?: string,
        ownerBoard?: BackgroundJobBoard,
        options?: { recordConsumed?: boolean },
      ): PendingTaskCall | undefined;
      takeByTaskID(
        sessionID: string,
        taskID: string,
        ownerBoard?: BackgroundJobBoard,
      ): PendingTaskCall | undefined;
      takeUnresolvedFirstMatch(
        sessionID: string,
        selection?: {
          identityTaskID?: string;
          agentType?: string;
          ownerBoard?: BackgroundJobBoard;
        },
      ): PendingTaskCall | undefined;
      release?(call: PendingTaskCall): void;
    };
    taskContextTracker: {
      pendingManagedTaskIds: Set<string>;
      addContext(taskId: string, files: ContextFile[]): void;
      contextFilesForPrompt(taskId: string): ContextFile[];
      prune(board: { taskIDs(): Set<string> }): void;
    };
    backgroundJobSupervisor?: BackgroundJobSupervisor;
    bindConcurrencyTicket?: (taskID: string, pending: PendingTaskCall) => void;
    backgroundTaskConcurrency?: BackgroundTaskConcurrency;
    getModelForAgent?: (
      agentType: string,
      parentSessionID?: string,
    ) => string | undefined;
    /** Record direct task cleanup even when the store is a thin facade. */
    recordLifecycleSuppression?: (taskID: string) => void;
    /** Clear a deletion guard when a new native task output proves a run exists. */
    clearRehydrateTombstone?: (taskID: string) => void;
    isStaleDeletedTaskOutput?: (
      taskID: string,
      lifecycleEpoch: number,
    ) => boolean;
    /** Host flavor marker ('v2' on OpenCode v2 hosts); selects the native
     * control-tool identifier param for model-visible output. Defaults v1. */
    hostFlavor?: string;
  },
): Promise<void> {
  if (input.tool.toLowerCase() === 'read') {
    if (input.sessionID) {
      const canTrack =
        deps.taskContextTracker.pendingManagedTaskIds.has(input.sessionID) ||
        deps.backgroundJobBoard.taskIDs().has(input.sessionID);
      if (canTrack) {
        deps.taskContextTracker.addContext(
          input.sessionID,
          extractReadFiles(deps.directory, output),
        );
      }
    }
    return;
  }

  if (input.tool.toLowerCase() !== 'task') return;

  const exactCallID =
    typeof input.callID === 'string' && input.callID.trim() !== ''
      ? input.callID
      : undefined;
  let pending = deps.pendingCallTracker.take(
    exactCallID,
    exactCallID ? undefined : input.sessionID,
    deps.backgroundJobBoard,
  );
  const exactCallConfirmed =
    exactCallID !== undefined && pending?.callId === exactCallID;
  let childRefAllowed = exactCallConfirmed;
  let identityTaskID: string | undefined;
  if (!pending && typeof output.output === 'string') {
    // No tool call ID (or unknown one): resolve identity via the task
    // ID parsed from this call's own output, matched against the
    // pending the early registration claimed for that child. This
    // avoids guessing by insertion order among parallel calls.
    identityTaskID = parseTaskIdFromTaskOutput(output.output);
    if (identityTaskID && input.sessionID) {
      pending = deps.pendingCallTracker.takeByTaskID(
        input.sessionID,
        identityTaskID,
        deps.backgroundJobBoard,
      );
      if (pending) {
        childRefAllowed = true;
        log(
          '[task-session-manager] resolved task output identity via early-registered task ID',
          { taskID: identityTaskID, callID: pending.callId },
        );
      }
    }
  }
  if (!pending && !exactCallID && identityTaskID && input.sessionID) {
    // Both identity sources missed: a parallel no-callID burst where
    // no early registration claimed the parsed task ID. Returning
    // here would strand a pending — its concurrency ticket never
    // releases, and sole-survivor takes refuse forever while it
    // remains (parent poisoning). The task ID parsed from this call's
    // own output is authoritative, so drain the oldest eligible
    // pending through the guarded first-match fallback and let the
    // normal try/finally path release the ticket and process output.
    const childRecord = deps.backgroundJobBoard.get(identityTaskID);
    const childAgent =
      childRecord && childRecord.parentSessionID === input.sessionID
        ? childRecord.agent
        : undefined;
    pending = deps.pendingCallTracker.takeUnresolvedFirstMatch(
      input.sessionID,
      {
        identityTaskID,
        agentType: childAgent,
        ownerBoard: deps.backgroundJobBoard,
      },
    );
    if (pending) {
      childRefAllowed = false;
      log(
        '[task-session-manager] unresolvable no-ID take; consuming first-match pending (drain fallback)',
        {
          taskID: identityTaskID,
          callID: pending.callId,
          consumedAgent: pending.agentType,
        },
      );
    }
  }
  log('[task-session-manager] tool.execute.after task', {
    callID: input.callID,
    sessionID: input.sessionID,
    hasPending: !!pending,
    outputType: typeof output.output,
    outputPreview:
      typeof output.output === 'string'
        ? output.output.slice(0, 120)
        : undefined,
  });

  if (!pending) return;

  try {
    // v2 gate: the executor wrapper registered this call's delegated
    // (subagent) launch from the STRUCTURED executor result — launch
    // registration, background promotion, ticket binding, tombstone clear,
    // supervisor binding, context merge, and any terminal reconcile already
    // happened there. Re-registering from the rendered prose would
    // double-register. The status branch (task_status tool outputs),
    // read-context tracking, and residual identity fallback stay live; v1
    // never sets the flag. The finally block still releases the pending, its
    // lease, and its ticket.
    if (deps.hostFlavor === 'v2' && pending.registeredByWrapper === true) {
      log(
        '[task-session-manager] v2 subagent launch already registered by executor wrapper',
        { callID: pending.callId },
      );
      return;
    }
    if (typeof output.output !== 'string') return;
    const backgroundMeta = output.metadata as
      | { background?: unknown }
      | undefined;
    // The host only reports background:true here when it promoted the
    // foreground waiter (or the launch was native): it is authoritative
    // for the child this output describes, regardless of call identity.
    const hostConfirmedBackground = backgroundMeta?.background === true;
    if (hostConfirmedBackground && !pending.background) {
      // Foreground-fallback promoted this waiter to background before its
      // fallback abort: the tool resolved via backgroundResult, so the
      // pending (registered as a foreground call) must follow suit or the
      // board record would stay foreground and miss the background-only
      // observation and supervision paths.
      pending.background = true;
      // The foreground call skipped concurrency admission, so the
      // promoted run would otherwise bypass the configured limits: take
      // the same ticket a native background launch holds. No ready-await
      // — the child is already running; registration below binds the
      // ticket and the terminal path releases it.
      if (
        deps.backgroundTaskConcurrency &&
        !pending.concurrencyTicket &&
        // A host-promoted steer must not double-bind the running child's
        // existing admission slot: bind() would replace it, and the
        // terminal releaseTask frees only the newer entry.
        !isSteeredCall(pending)
      ) {
        const isManagedTask = deps.backgroundJobBoard
          .taskIDs()
          .has(pending.parentSessionId);
        if (!isManagedTask) {
          pending.concurrencyTicket = deps.backgroundTaskConcurrency.acquire({
            model: deps.getModelForAgent?.(
              pending.agentType,
              pending.parentSessionId,
            ),
          });
          // Fire-and-forget accounting: nobody awaits ticket.ready here,
          // so a rejection (queue cancelled by disposal while waiting)
          // must be marked handled or it surfaces as an unhandled
          // rejection. A granted or released ticket is unaffected.
          void pending.concurrencyTicket.ready.catch(() => {});
        }
      }
    }
    if (pending.earlyRegistrationRejected) {
      log(
        '[task-session-manager] task output previously fenced; re-evaluating registration against board state',
        { callID: pending.callId },
      );
    }

    const launch = parseTaskLaunchOutput(output.output);
    if (launch && !launch.result?.match(/Timed out after \d+ms/i)) {
      // Shared launch-registration pipeline (fences + promotion + ticket/
      // gate/supervisor/context routing). Used by both the v1 after-hook and
      // the v2 executor wrapper so the delegated-subagent launch line has one
      // source of truth.
      const record = await registerDelegatedLaunchFromStructured(
        {
          callID: pending.callId,
          childTaskID: launch.taskID,
          state: 'running',
          background: hostConfirmedBackground,
          exactCallConfirmed,
          pending,
        },
        deps,
      );
      if (!record) return;
      appendRegisteredChildRef(
        output,
        record,
        pending,
        childRefAllowed,
        deps.hostFlavor,
      );
      log('[task-session-manager] background task launch registered', {
        taskID: record.taskID,
        alias: record.alias,
        parentSessionID: record.parentSessionID,
        agent: record.agent,
        description: record.description,
        state: record.state,
      });
      return;
    }

    const status = parseTaskStatusOutput(output.output);
    if (status) {
      const record = registerTaskOutputLaunch(
        status.taskID,
        pending,
        exactCallConfirmed,
        hostConfirmedBackground,
        deps,
      );
      if (!record) return;
      deps.bindConcurrencyTicket?.(record.taskID, pending);
      deps.clearRehydrateTombstone?.(status.taskID);
      normalizeLateCancelledTaskOutput(
        output,
        deps.backgroundJobBoard,
        controlParamName(deps.hostFlavor),
      );
      appendRegisteredChildRef(
        output,
        record,
        pending,
        childRefAllowed,
        deps.hostFlavor,
      );
      if (exactCallConfirmed) deps.backgroundJobSupervisor?.onLaunch(record);
      await deps.terminalGate.reconcile(record, {
        kind: 'output',
        status,
        origin: {
          kind: 'native',
          run: record,
          callID: pending.callId,
          callIDConfirmed: exactCallConfirmed,
        },
      });
      // The synchronous terminal listener owns release and context settlement.
      // The returned publication may already have been withdrawn while awaiting.
      const current = deps.backgroundJobBoard.get(status.taskID);
      const updated =
        current?.generation === record.generation ? current : undefined;
      log('[task-session-manager] foreground task status registered', {
        taskID: status.taskID,
        alias: updated?.alias ?? record.alias,
        parentSessionID: pending.parentSessionId,
        agent: pending.agentType,
        state: updated?.state ?? record.state,
      });
      return;
    }

    const taskId = parseTaskIdFromTaskOutput(output.output);
    if (!taskId) {
      // Host-output-drift detector: the task tool's terminal output no
      // longer carries a parsable task id. The preview shows what the
      // host actually returned so format drift is diagnosable from the
      // plugin log (board-injection has its own textPreview for
      // synthetic parts — this one covers the native tool result path).
      // Structure-preserving VALUE masking (maskTaskOutputStructure):
      // parse-miss content is untrusted-by-format, so tag/field names
      // survive for drift diagnosis but every value is fully hidden as
      // [masked] — description fields carry orchestrator/user-authored
      // text. The full string is masked BEFORE slicing (a straddling
      // secret cannot leak a raw prefix); the logger-level redaction
      // remains the backstop for every other log site.
      log('[task-session-manager] task output without a task id', {
        callID: pending.callId,
        sessionID: input.sessionID,
        outputPreview: maskTaskOutputStructure(output.output).slice(0, 140),
      });
      if (
        pending.resumedTaskId &&
        isMissingRememberedSessionError(output.output)
      ) {
        deps.recordLifecycleSuppression?.(pending.resumedTaskId);
        deps.backgroundJobBoard.drop(pending.resumedTaskId);
        deps.backgroundJobSupervisor?.drop(pending.resumedTaskId);
      }
      return;
    }

    if (pending.resumedTaskId && pending.resumedTaskId !== taskId) {
      log(
        '[task-session-manager] ignored task output with mismatched resumed task ID',
        {
          expectedTaskID: pending.resumedTaskId,
          observedTaskID: taskId,
          callID: pending.callId,
        },
      );
      return;
    }

    // An ID-only output still identifies this call's own child: a
    // placeholder is promoted with the owning pending's launch metadata
    // (identity-unresolved pendings paint nothing, per the identity rule),
    // and once promoted the child is supervised and context-tracked like
    // any parsed launch.
    const promoted = deps.backgroundJobBoard.promoteProvisional(
      taskId,
      pending.parentSessionId,
      pending.identityUnresolved
        ? undefined
        : {
            agent: pending.agentType,
            description: pending.label,
            objective: pending.fullObjective,
            background: pending.background,
          },
    );
    if (promoted && !promoted.provisional) {
      deps.bindConcurrencyTicket?.(promoted.taskID, pending);
      if (exactCallConfirmed) {
        deps.backgroundJobSupervisor?.onLaunch(promoted);
      }
      appendRegisteredChildRef(
        output,
        promoted,
        pending,
        childRefAllowed,
        deps.hostFlavor,
      );
      deps.taskContextTracker.pendingManagedTaskIds.add(taskId);
    } else {
      deps.taskContextTracker.pendingManagedTaskIds.delete(taskId);
    }
    deps.backgroundJobBoard.addContext(
      taskId,
      filterStaleContextFiles(deps.directory, [
        ...(deps.backgroundJobBoard.get(taskId)?.contextFiles ?? []),
        ...deps.taskContextTracker.contextFilesForPrompt(taskId),
      ]),
    );
    deps.taskContextTracker.prune(deps.backgroundJobBoard);
  } finally {
    deps.pendingCallTracker.release?.(pending);
    if (pending.relaunchLease) {
      deps.backgroundJobBoard.releaseLease(pending.relaunchLease);
    }
    pending.concurrencyTicket?.releaseIfUnbound();
  }
}

function registerTaskOutputLaunch(
  taskID: string,
  pending: PendingTaskCall,
  exactCallConfirmed: boolean,
  hostConfirmedBackground: boolean,
  deps: {
    backgroundJobBoard: BackgroundJobBoard;
    backgroundJobSupervisor?: BackgroundJobSupervisor;
    isStaleDeletedTaskOutput?: (
      taskID: string,
      lifecycleEpoch: number,
    ) => boolean;
  },
): ReturnType<BackgroundJobBoard['get']> {
  if (deps.isStaleDeletedTaskOutput?.(taskID, pending.lifecycleEpoch)) {
    log('[task-session-manager] ignored stale task output after deletion', {
      taskID,
      callID: pending.callId,
      lifecycleEpoch: pending.lifecycleEpoch,
    });
    return undefined;
  }

  const resumed = pending.resumedTaskId !== undefined;
  if (resumed && pending.resumedTaskId !== taskID) return undefined;

  const existing = deps.backgroundJobBoard.get(taskID);
  const earlyRegistrationGeneration = pending.earlyRegistration?.generation;
  if (
    pending.earlyRegisteredTaskID === taskID &&
    earlyRegistrationGeneration !== undefined &&
    existing?.generation !== earlyRegistrationGeneration
  ) {
    log('[task-session-manager] ignored stale native task output', {
      taskID,
      callID: pending.callId,
      registeredGeneration: earlyRegistrationGeneration,
      currentGeneration: existing?.generation,
    });
    return undefined;
  }
  if (resumed && pending.relaunchLease === undefined) {
    log(
      '[task-session-manager] refused resumed task output without relaunch lease',
      { taskID, callID: pending.callId },
    );
    return undefined;
  }
  if (!resumed && existing && pending.earlyRegistrationRejected) {
    log(
      '[task-session-manager] refused task output that collided with an existing task ID',
      { taskID, callID: pending.callId },
    );
    return undefined;
  }
  if (
    pending.earlyRegisteredTaskID &&
    pending.earlyRegisteredTaskID !== taskID &&
    !existing
  ) {
    // The pending was cross-marked by another child's session.created
    // (parallel same-agent launches). The taskID parsed from THIS call's
    // own output is authoritative — register it instead of dropping.
    log(
      '[task-session-manager] registering authoritative task ID despite cross-marked pending',
      {
        taskID,
        crossMarkedTaskID: pending.earlyRegisteredTaskID,
        callID: pending.callId,
      },
    );
  }

  if (pending.identityUnresolved) {
    log(
      '[task-session-manager] registered authoritative task ID with generic metadata (identity unresolved)',
      { taskID, callID: pending.callId },
    );
  }

  try {
    return deps.backgroundJobBoard.registerLaunch({
      taskID,
      parentSessionID: pending.parentSessionId,
      agent: pending.agentType,
      // Identity was unresolved (no-ID drain or window-shifted take):
      // the label/objective may belong to a sibling call, so never
      // paint them. Existing placeholder records keep their honest
      // description; fresh records fall back to registerLaunch's
      // generic default.
      ...(pending.identityUnresolved
        ? {}
        : {
            description: pending.label,
            objective: pending.fullObjective ?? pending.label,
          }),
      background:
        (exactCallConfirmed || hostConfirmedBackground) && pending.background,
      // Provenance for terminal-session GC: a fresh (non-resume) background
      // child launched by this plugin's own tracked task call. The board
      // refuses it for adopted, restored, or placeholder records.
      ...((exactCallConfirmed || hostConfirmedBackground) &&
      pending.background &&
      pending.resumedTaskId === undefined
        ? { pluginLaunched: true as const }
        : {}),
      preserveRun:
        pending.earlyRegisteredTaskID === taskID ||
        pending.resumedTaskId === undefined,
      ...(pending.relaunchLease
        ? { relaunchLease: pending.relaunchLease }
        : {}),
    });
  } catch (error) {
    log('[task-session-manager] refused task output launch registration', {
      taskID,
      callID: pending.callId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Shared delegated-launch registration entry point, used by BOTH the v1
 * after-hook's launch-output branch and the v2-only executor wrapper, so the
 * delegated-`subagent` launch line has ONE source of truth. All registration
 * fences (stale lifecycle epoch, early-registration generation,
 * resumed-without-lease refusal, earlyRejected collision, authoritative-ID
 * override) live in `registerTaskOutputLaunch` unchanged.
 *
 * Routing order matches the after-hook launch branch: host-confirmed
 * background promotion, board registration, concurrency-ticket binding,
 * rehydrate-tombstone clear, supervisor launch binding, task-context mark +
 * board context merge, and — for terminal (non-running) outcomes — the
 * terminal-gate reconcile. Registration/fence errors are logged and
 * swallowed; the tool result always passes through.
 */
export interface RegisterDelegatedLaunchDeps {
  directory: string;
  backgroundJobBoard: BackgroundJobBoard;
  terminalGate: BackgroundJobTerminalGate;
  backgroundJobSupervisor?: BackgroundJobSupervisor;
  backgroundTaskConcurrency?: BackgroundTaskConcurrency;
  getModelForAgent?: (
    agentType: string,
    parentSessionID?: string,
  ) => string | undefined;
  taskContextTracker: {
    pendingManagedTaskIds: Set<string>;
    addContext(taskId: string, files: ContextFile[]): void;
    contextFilesForPrompt(taskId: string): ContextFile[];
  };
  isStaleDeletedTaskOutput?: (
    taskID: string,
    lifecycleEpoch: number,
  ) => boolean;
  bindConcurrencyTicket?: (taskID: string, pending: PendingTaskCall) => void;
  clearRehydrateTombstone?: (taskID: string) => void;
}

export interface DelegatedLaunchFromStructuredInput {
  /** Tool.CallID the before-hook recorded for this pending call. */
  callID: string;
  /** The child session/task ID reported by the host (sessionID). */
  childTaskID: string;
  /** Structured status: 'running' | 'completed' | 'error' | 'cancelled'. */
  state: TaskOutputState;
  /** Host-confirmed background promotion from structured metadata. */
  background: boolean;
  /**
   * The child's final text (v2 executor-wrapper path only): carried
   * verbatim into the terminal gate's status so the textless-completion
   * policy cannot turn a valid answer into an error. The v1 after-hook
   * path never sets it (its terminal branch parses its own output).
   */
  result?: string;
  exactCallConfirmed: boolean;
  pending: PendingTaskCall;
  /** Set only on the v2 executor-wrapper path — marks the pending so the
   *  after-hook gates its launch-output / background-promotion branches off
   *  (launch is registered exactly once on v2). v1 leaves this undefined. */
  handledByWrapper?: boolean;
}

export async function registerDelegatedLaunchFromStructured(
  input: DelegatedLaunchFromStructuredInput,
  deps: RegisterDelegatedLaunchDeps,
): Promise<BackgroundJobRecord | undefined> {
  try {
    // Host-confirmed background promotion (formerly only in the after-hook):
    // a foreground waiter promoted before its fallback abort must follow the
    // background lane and take the same admission ticket a native background
    // launch holds. Idempotent for v1, where the after-hook already promoted.
    if (input.background && !input.pending.background) {
      input.pending.background = true;
      if (
        deps.backgroundTaskConcurrency &&
        !input.pending.concurrencyTicket &&
        // A host-promoted steer must not double-bind the running child's
        // existing admission slot (same rule as the after-hook block).
        !isSteeredCall(input.pending)
      ) {
        const isManagedTask = deps.backgroundJobBoard
          .taskIDs()
          .has(input.pending.parentSessionId);
        if (!isManagedTask) {
          input.pending.concurrencyTicket =
            deps.backgroundTaskConcurrency.acquire({
              model: deps.getModelForAgent?.(
                input.pending.agentType,
                input.pending.parentSessionId,
              ),
            });
          // Fire-and-forget accounting, matching the after-hook: nobody
          // awaits ticket.ready here, so a rejection (queue cancelled by
          // disposal while waiting) must be marked handled.
          void input.pending.concurrencyTicket.ready.catch(() => {});
        }
      }
    }

    const record = registerTaskOutputLaunch(
      input.childTaskID,
      input.pending,
      input.exactCallConfirmed,
      input.background,
      deps,
    );
    if (!record) return undefined;
    if (input.handledByWrapper === true) {
      input.pending.registeredByWrapper = true;
    }
    deps.bindConcurrencyTicket?.(record.taskID, input.pending);
    deps.clearRehydrateTombstone?.(input.childTaskID);
    if (input.exactCallConfirmed) {
      deps.backgroundJobSupervisor?.onLaunch(record);
    }
    deps.taskContextTracker.pendingManagedTaskIds.add(input.childTaskID);
    // Preserves the after-hook launch-branch context order: board context
    // files first, then the tracker-derived set, so the merge is identical.
    deps.backgroundJobBoard.addContext(
      input.childTaskID,
      filterStaleContextFiles(deps.directory, [
        ...(deps.backgroundJobBoard.get(input.childTaskID)?.contextFiles ?? []),
        ...deps.taskContextTracker.contextFilesForPrompt(input.childTaskID),
      ]),
    );
    if (input.state !== 'running') {
      await deps.terminalGate.reconcile(record, {
        kind: 'output',
        status: {
          taskID: input.childTaskID,
          state: input.state,
          timedOut: false,
          ...(input.result !== undefined ? { result: input.result } : {}),
        },
        origin: {
          kind: 'native',
          run: record,
          callID: input.callID,
          callIDConfirmed: input.exactCallConfirmed,
        },
      });
    }
    return record;
  } catch (error) {
    log('[task-session-manager] structured launch registration failed', {
      taskID: input.childTaskID,
      callID: input.callID,
      error: error instanceof Error ? error.message : String(error),
    });
    // v1 keeps the after-hook's historic fail-loud semantics (its outer
    // finally still releases the pending, lease, and ticket); the v2 wrapper
    // path must never let a registration failure corrupt the tool result.
    if (input.handledByWrapper !== true) throw error;
    return undefined;
  }
}

function appendRegisteredChildRef(
  output: { output: unknown },
  record: {
    taskID: string;
    parentSessionID: string;
    agent: string;
    alias: string;
    provisional?: boolean;
  },
  pending: PendingTaskCall,
  allowed: boolean,
  hostFlavor?: string,
): void {
  // v2 renders the contract-native sessionID; the child-ref comment is a
  // v1-only identity format and must never appear on v2 surfaces. The
  // alias is still allocated and resolvable on v2 (board.resolve plus the
  // parent-history markers read by the alias authority) — only the
  // rendered comment disappears.
  if (hostFlavor === 'v2') return;
  if (!allowed || record.provisional) return;
  if (pending.identityUnresolved) return;
  if (record.parentSessionID !== pending.parentSessionId) return;
  if (record.agent !== pending.agentType) return;
  if (typeof output.output !== 'string') return;
  if (parseTaskIdFromTaskOutput(output.output) !== record.taskID) return;
  const text =
    record.alias === record.taskID
      ? noteExactSessionAlias(output.output, record.taskID)
      : output.output;
  output.output = appendChildRefSuffix(text, {
    parentSessionID: record.parentSessionID,
    agent: record.agent,
    alias: record.alias,
    sessionID: record.taskID,
  });
}
