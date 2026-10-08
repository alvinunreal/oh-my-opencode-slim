/**
 * Tool execute hooks for task session manager.
 *
 * Handles `tool.execute.before` (task tool: pending call creation,
 * reusable/recoverable task_id resolution) and `tool.execute.after`
 * (read context tracking, task launch registration/update from output).
 */

import type { BackgroundJobRecord } from '../../background-jobs';
import {
  type BackgroundJobLifecycle,
  type ContextFile,
  deriveFullObjective,
  deriveTaskSessionLabel,
} from '../../background-jobs';
import type { BackgroundTaskConcurrency } from '../../utils';
import {
  maskTaskOutputStructure,
  parseTaskIdFromTaskOutput,
  parseTaskLaunchOutput,
  parseTaskStatusOutput,
} from '../../utils';
import { isRecord as isObjectRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import { controlParamName } from '../../v2/adapters';
import { type DelegationWording, delegationWording } from '../../v2/delegation';
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
import { extractReadFiles } from './task-context-tracker';

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

function isNativeContinuableCompleted(
  job: BackgroundJobRecord,
  agentType: string,
): boolean {
  if (job.agent !== agentType) return false;
  if (job.state === 'completed') return true;
  return job.state === 'reconciled' && job.terminalState === 'completed';
}

function refuseKnownTaskResume(
  requested: string,
  job: ResumeRefusalJob,
  agentType: string,
  delegation: DelegationWording,
): never {
  const label = `${job.alias} / ${job.taskID}`;
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
      `${label}: stopped, ${ack}; ${delegation.tool}() cannot resume this session. Use task_revive with a new prompt. No new session was created.`,
      { state: job.state, acknowledged: !job.terminalUnreconciled },
    );
  }
  if (job.terminalUnreconciled) {
    refuseExplicitTaskId(
      requested,
      delegation.tool === 'task'
        ? `${label}: ${job.state}, unreconciled; task() cannot resume until acknowledgement. Call task_revive(task_id: "${job.taskID}", prompt: "...") directly; it continues that same session. task_result is not required first. This prompt was not sent.`
        : `${label}: ${job.state}, unreconciled; ${delegation.tool}() cannot resume this session. Use task_revive with a new prompt. It was not dropped; no new session was created. This prompt was not sent.`,
      { state: job.state, terminalUnreconciled: true },
    );
  }
  refuseExplicitTaskId(
    requested,
    `${label}: ${job.state}; ${delegation.tool}() cannot resume this session. Use task_revive with a new prompt. No new session was created.`,
    { state: job.state },
  );
}

export async function handleToolExecuteBefore(
  input: { tool: string; sessionID?: string; callID?: string },
  output: { args?: unknown },
  deps: {
    shouldManageSession: (sessionID: string) => boolean;
    registerSessionAsOrchestrator?: (sessionID: string) => void;
    backgroundJobs: BackgroundJobLifecycle;
    pendingCallTracker: {
      add(call: PendingTaskCall): void;
      take(
        callID?: string,
        sessionID?: string,
        ownerBoard?: BackgroundJobLifecycle,
        options?: { recordConsumed?: boolean },
      ): PendingTaskCall | undefined;
      release?(call: PendingTaskCall): void;
      pendingCallId(sessionID?: string, callID?: string): string;
    };
    taskContextTracker: { pendingManagedTaskIds: Set<string> };
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
    recoverRetainedSession?: (request: {
      parentSessionID: string;
      requested: string;
      agent?: string;
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
    releaseLease: (lease) => deps.backgroundJobs.releaseLease(lease),
  };
  pendingCall.fullObjective = deriveFullObjective({
    description:
      typeof args.description === 'string' ? args.description : undefined,
    prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
  });
  if (typeof args.task_id === 'string' && args.task_id.trim() !== '') {
    const requested = args.task_id.trim();
    let remembered =
      deps.backgroundJobs.resolveReusable(
        input.sessionID,
        requested,
        agentType,
      ) ??
      deps.backgroundJobs.resolveRecoverable(
        input.sessionID,
        requested,
        agentType,
      );

    if (!remembered) {
      const knownManagedTask = deps.backgroundJobs.resolve(
        input.sessionID,
        requested,
      );
      if (knownManagedTask?.state === 'running') {
        throw new Error(
          `Task ${requested} is still running and cannot be resumed or amended with ${delegation.tool}(). Do not spawn or cancel a duplicate for an additive request. Wait for its terminal result, then resume the session after that terminal notification is acknowledged if follow-up work is still needed.`,
        );
      }

      if (
        knownManagedTask &&
        deps.hostFlavor === 'v2' &&
        isNativeContinuableCompleted(knownManagedTask, agentType)
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
            remembered = deps.backgroundJobs.resolveReusable(
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
          });
          if (deps.isDisposed?.()) {
            throw new Error(
              `${pluginDisposedMessage()} No session was created.`,
            );
          }
          const restored = deps.backgroundJobs.resolve(
            input.sessionID,
            requested,
          );
          if (restored && isNativeContinuableCompleted(restored, agentType)) {
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
      const relaunchLease = deps.backgroundJobs.acquireRelaunchLease(
        remembered.taskID,
        remembered.generation,
      );
      if (!relaunchLease) {
        throw new Error(
          `Task ${requested} cannot be resumed safely: its current generation is already owned by another lifecycle operation. Do not launch a duplicate with the same ${delegation.resumeParam}.`,
        );
      }
      if (deps.isDisposed?.()) {
        deps.backgroundJobs.releaseLease(relaunchLease);
        throw new Error(`${pluginDisposedMessage()} No session was created.`);
      }
      args.task_id = remembered.taskID;
      deps.taskContextTracker.pendingManagedTaskIds.add(remembered.taskID);
      deps.backgroundJobs.markUsed(input.sessionID, remembered.taskID);
      pendingCall.resumedTaskId = remembered.taskID;
      pendingCall.relaunchLease = relaunchLease;
    }
  }

  // New spawns only: block re-dispatch of an objective already owned by an
  // unreconciled terminal job from this parent (self-reinforcing dispatch
  // loop, #1070). The full objective text is compared, not the 48-char display
  // label, so long exact duplicates match while distinct objectives that only
  // share a truncated prefix stay unaffected.
  // Escape hatch: task_result retrieval after completion updates lastUsedAt
  // beyond completedAt, marking the result as consumed and authorizing retry.
  if (!pendingCall.resumedTaskId) {
    const objectiveKey = normalizeObjectiveKey(
      pendingCall.fullObjective ?? label,
    );
    const duplicate = deps.backgroundJobs
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
        `A background task with the same objective already finished and its result is awaiting acknowledgment: ${duplicate.alias} / ${duplicate.taskID}. Call task_result with ${delegation.resumeParam} "${duplicate.taskID}" to retrieve it instead of spawning a duplicate. If the retrieved result is insufficient, retry the spawn after retrieval — retrieval authorizes the retry.`,
      );
    }
  }

  if (deps.isDisposed?.()) {
    if (pendingCall.relaunchLease) {
      deps.backgroundJobs.releaseLease(pendingCall.relaunchLease);
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
      // finish, so its own slot could never be released.
      const isManagedTask = deps.backgroundJobs.taskIDs().has(input.sessionID);
      if (!isManagedTask) {
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
    backgroundJobs: BackgroundJobLifecycle;
    pendingCallTracker: {
      take(
        callID?: string,
        sessionID?: string,
        ownerBoard?: BackgroundJobLifecycle,
        options?: { recordConsumed?: boolean },
      ): PendingTaskCall | undefined;
      takeByTaskID(
        sessionID: string,
        taskID: string,
        ownerBoard?: BackgroundJobLifecycle,
      ): PendingTaskCall | undefined;
      takeUnresolvedFirstMatch(
        sessionID: string,
        selection?: {
          identityTaskID?: string;
          agentType?: string;
          ownerBoard?: BackgroundJobLifecycle;
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
        deps.backgroundJobs.taskIDs().has(input.sessionID);
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
    deps.backgroundJobs,
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
        deps.backgroundJobs,
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
    const childRecord = deps.backgroundJobs.get(identityTaskID);
    const childAgent =
      childRecord && childRecord.parentSessionID === input.sessionID
        ? childRecord.agent
        : undefined;
    pending = deps.pendingCallTracker.takeUnresolvedFirstMatch(
      input.sessionID,
      {
        identityTaskID,
        agentType: childAgent,
        ownerBoard: deps.backgroundJobs,
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
      if (deps.backgroundTaskConcurrency && !pending.concurrencyTicket) {
        const isManagedTask = deps.backgroundJobs
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
      const record = registerTaskOutputLaunch(
        launch.taskID,
        pending,
        exactCallConfirmed,
        hostConfirmedBackground,
        deps,
      );
      if (!record) return;
      deps.bindConcurrencyTicket?.(record.taskID, pending);
      deps.clearRehydrateTombstone?.(launch.taskID);
      if (exactCallConfirmed) deps.backgroundJobs.onLaunch(record);
      appendRegisteredChildRef(output, record, pending, childRefAllowed);
      log('[task-session-manager] background task launch registered', {
        taskID: record.taskID,
        alias: record.alias,
        parentSessionID: record.parentSessionID,
        agent: record.agent,
        description: record.description,
        state: record.state,
      });
      deps.taskContextTracker.pendingManagedTaskIds.add(launch.taskID);
      deps.backgroundJobs.addContext(
        launch.taskID,
        deps.taskContextTracker.contextFilesForPrompt(launch.taskID),
      );
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
        deps.backgroundJobs,
        controlParamName(deps.hostFlavor),
      );
      appendRegisteredChildRef(output, record, pending, childRefAllowed);
      if (exactCallConfirmed) deps.backgroundJobs.onLaunch(record);
      await deps.backgroundJobs.reconcile(record, {
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
      const current = deps.backgroundJobs.get(status.taskID);
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
        deps.backgroundJobs.drop(pending.resumedTaskId);
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
    const promoted = deps.backgroundJobs.promoteProvisional(
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
        deps.backgroundJobs.onLaunch(promoted);
      }
      appendRegisteredChildRef(output, promoted, pending, childRefAllowed);
      deps.taskContextTracker.pendingManagedTaskIds.add(taskId);
    } else {
      deps.taskContextTracker.pendingManagedTaskIds.delete(taskId);
    }
    deps.backgroundJobs.addContext(
      taskId,
      deps.taskContextTracker.contextFilesForPrompt(taskId),
    );
    deps.taskContextTracker.prune(deps.backgroundJobs);
  } finally {
    deps.pendingCallTracker.release?.(pending);
    if (pending.relaunchLease) {
      deps.backgroundJobs.releaseLease(pending.relaunchLease);
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
    backgroundJobs: BackgroundJobLifecycle;
    isStaleDeletedTaskOutput?: (
      taskID: string,
      lifecycleEpoch: number,
    ) => boolean;
  },
): ReturnType<BackgroundJobLifecycle['get']> {
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

  const existing = deps.backgroundJobs.get(taskID);
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
    return deps.backgroundJobs.registerLaunch({
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
): void {
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
