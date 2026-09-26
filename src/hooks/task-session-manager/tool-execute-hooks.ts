/**
 * Tool execute hooks for task session manager.
 *
 * Handles `tool.execute.before` (task tool: pending call creation,
 * reusable/recoverable task_id resolution) and `tool.execute.after`
 * (read context tracking, task launch registration/update from output).
 */
import type { PluginInput } from '@opencode-ai/plugin';
import type {
  BackgroundJobStore,
  BackgroundJobSupervisor,
  BackgroundTaskConcurrency,
  ContextFile,
} from '../../utils';
import {
  deriveFullObjective,
  deriveTaskSessionLabel,
  maskTaskOutputStructure,
  parseTaskIdFromTaskOutput,
  parseTaskLaunchOutput,
  parseTaskStatusOutput,
} from '../../utils';
import type {
  createBackgroundJobIdentityIndex,
  ResumeClaimBaseline,
} from '../../utils/background-job-identity-index';
import type { BackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import { isRecord as isObjectRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import type {
  SameProcessResumeEvidence,
  SameProcessResumeEvidenceToken,
} from '../../utils/same-process-resume-evidence';
import { isMissingRememberedSessionError } from './board-injection';
import type { PendingTaskCall } from './pending-call-tracker';
import { convertSameProviderBackgroundTask } from './same-provider-policy';
import { classifySessionRecovery } from './session-recovery';
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

type IdentityIndex = ReturnType<typeof createBackgroundJobIdentityIndex>;

const SCHEMA_REJECTION_CLOCK_SKEW_MS = 1_000;

/**
 * The recovery classifier currently does not need to know about the
 * process-local broker. Keep the lookup deliberately structural so a newer
 * classifier can expose an opaque token without making this hook depend on a
 * particular recovery-result union.
 */
function recoveryResumeToken(
  recovery: unknown,
): SameProcessResumeEvidenceToken | undefined {
  if (!isObjectRecord(recovery)) return undefined;
  const direct =
    recovery.resumeToken ??
    recovery.resumeEvidenceToken ??
    recovery.sameProcessResumeToken;
  if (isObjectRecord(direct)) {
    return direct as SameProcessResumeEvidenceToken;
  }
  const evidence = recovery.evidence;
  if (!isObjectRecord(evidence)) return undefined;
  const nested =
    evidence.resumeToken ??
    evidence.resumeEvidenceToken ??
    evidence.sameProcessResumeToken;
  return isObjectRecord(nested)
    ? (nested as SameProcessResumeEvidenceToken)
    : undefined;
}

function releaseResumeEvidenceBeforeSend(
  pending: PendingTaskCall,
  broker?: SameProcessResumeEvidence,
): void {
  const claim = pending.resumeEvidenceClaim;
  if (!claim) return;
  pending.resumeEvidenceClaim = undefined;
  broker?.releaseBeforeSend(claim);
}

function isTaskToolPart(part: unknown): part is Record<string, unknown> {
  return (
    isObjectRecord(part) &&
    part.type === 'tool' &&
    (part.tool === 'task' ||
      part.name === 'task' ||
      part.tool === 'subagent' ||
      part.name === 'subagent')
  );
}

function isMissingDescriptionSchemaError(error: unknown): boolean {
  if (typeof error === 'string') {
    return (
      /SchemaError/.test(error) &&
      /description/i.test(error) &&
      /(missing|required)/i.test(error)
    );
  }
  if (!isObjectRecord(error) || error.name !== 'SchemaError') return false;
  const message = error.message;
  return (
    typeof message === 'string' &&
    /description/i.test(message) &&
    /(missing|required)/i.test(message)
  );
}

function taskErrorTimestamp(
  state: Record<string, unknown>,
): number | undefined {
  const time = state.time;
  if (!isObjectRecord(time)) return undefined;
  const end = time.end;
  return typeof end === 'number' && Number.isFinite(end) && end >= 0
    ? end
    : undefined;
}

async function settleSchemaRejectedResumeClaim(
  requested: string,
  parentSessionID: string,
  identity: { alias: string; taskID: string },
  claim: NonNullable<ReturnType<IdentityIndex['inspectResumeClaim']>>,
  deps: {
    directory?: string;
    hostClient?: PluginInput['client'];
    identityIndex: IdentityIndex;
  },
): Promise<boolean> {
  const claimedAt = claim.baseline?.claimedAt;
  if (claimedAt === undefined) return false;

  const session = deps.hostClient?.session;
  if (typeof session?.messages !== 'function') return false;

  let response: unknown;
  try {
    response = await session.messages({
      path: { id: parentSessionID },
      query: { directory: deps.directory ?? '' },
    });
  } catch {
    return false;
  }
  if (
    !isObjectRecord(response) ||
    response.error != null ||
    !Array.isArray(response.data)
  )
    return false;

  const taskIDs = new Set([requested, identity.alias, identity.taskID]);
  const hasAuthoritativeRejection = response.data.some((message) => {
    if (!isObjectRecord(message) || !isObjectRecord(message.info)) return false;
    const info = message.info;
    if (
      info.role !== 'assistant' ||
      (info.sessionID !== undefined && info.sessionID !== parentSessionID) ||
      !Array.isArray(message.parts)
    )
      return false;
    return message.parts.some((part) => {
      if (!isTaskToolPart(part) || !isObjectRecord(part.state)) return false;
      const state = part.state;
      if (state.status !== 'error' || !isObjectRecord(state.input))
        return false;
      const taskID = state.input.task_id;
      if (typeof taskID !== 'string' || !taskIDs.has(taskID)) return false;
      const error = state.error ?? part.error ?? info.error;
      if (!isMissingDescriptionSchemaError(error)) return false;
      const errorAt = taskErrorTimestamp(state);
      return (
        errorAt !== undefined &&
        errorAt + SCHEMA_REJECTION_CLOCK_SKEW_MS >= claimedAt
      );
    });
  });
  if (!hasAuthoritativeRejection) return false;

  try {
    deps.identityIndex.settleResume(
      parentSessionID,
      identity.taskID,
      claim.token,
    );
    return !deps.identityIndex.inspectResumeClaim(
      parentSessionID,
      identity.taskID,
    );
  } catch (error) {
    log(
      '[task-session-manager] schema rejection claim settlement failed',
      String(error),
    );
    return false;
  }
}

function aliasPrefix(agent: string): string {
  const known: Record<string, string> = {
    council: 'cou',
    designer: 'des',
    explorer: 'exp',
    fixer: 'fix',
    librarian: 'lib',
    observer: 'obs',
    oracle: 'ora',
  };
  const prefix = known[agent] ?? agent.slice(0, 3).toLowerCase();
  return /^[a-z][a-z0-9_]*$/.test(prefix) ? prefix : 'job';
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

function refuseKnownTaskResume(
  requested: string,
  job: ResumeRefusalJob,
  agentType: string,
): never {
  const label = `${job.alias} / ${job.taskID}`;
  if (job.agent !== agentType) {
    refuseExplicitTaskId(
      requested,
      `${label}: agent is ${job.agent}, not ${agentType}. task() cannot resume this session. No new session was created.`,
      { state: job.state, agent: job.agent, requestedAgent: agentType },
    );
  }
  if (job.state === 'stopped') {
    const ack = job.terminalUnreconciled ? 'unreconciled' : 'acknowledged';
    refuseExplicitTaskId(
      requested,
      `${label}: stopped, ${ack}; task() cannot resume this session. Use task_revive with a new prompt. No new session was created.`,
      { state: job.state, acknowledged: !job.terminalUnreconciled },
    );
  }
  if (job.terminalUnreconciled) {
    refuseExplicitTaskId(
      requested,
      `${label}: ${job.state}, unreconciled; task() cannot resume until acknowledgement. Use task_revive now, or wait for ack then task(). No new session was created.`,
      { state: job.state, terminalUnreconciled: true },
    );
  }
  refuseExplicitTaskId(
    requested,
    `${label}: ${job.state}; task() cannot resume this session. Use task_revive with a new prompt. No new session was created.`,
    { state: job.state },
  );
}

function recoveryRequest(
  requested: { alias: string } | { sessionID: string },
  parentSessionID: string,
  agent: string,
  deps: {
    directory?: string;
    hostClient?: PluginInput['client'];
    identityIndex?: IdentityIndex;
    resumeEvidence?: SameProcessResumeEvidence;
    resumeEvidenceContext?: {
      generation: number;
      terminalRevision: number;
    };
  },
) {
  const session = deps.hostClient?.session;
  const directory = deps.directory ?? '';
  return {
    requested,
    parentSessionID,
    agent,
    directory,
    identityIndex: deps.identityIndex,
    readParentTranscript:
      typeof session?.messages === 'function'
        ? () =>
            session.messages({
              path: { id: parentSessionID },
              query: { directory },
            })
        : undefined,
    readChildTranscript:
      typeof session?.messages === 'function'
        ? (id: string) =>
            session.messages({ path: { id }, query: { directory } })
        : undefined,
    getSession:
      typeof session?.get === 'function'
        ? (id: string) => session.get({ path: { id }, query: { directory } })
        : undefined,
    probeStatus:
      typeof session?.status === 'function'
        ? () => session.status({ query: { directory } })
        : undefined,
    sameProcessResumeEvidence: deps.resumeEvidence,
    sameProcessResumeEvidenceContext: deps.resumeEvidenceContext,
  };
}

type ChildUser = { id: string; createdAt?: number };

async function readChildUsers(
  taskID: string,
  deps: { directory?: string; hostClient?: PluginInput['client'] },
): Promise<ChildUser[] | undefined> {
  const session = deps.hostClient?.session;
  const messages = session?.messages;
  if (typeof messages !== 'function') return undefined;
  let response: unknown;
  try {
    response = await messages.call(session, {
      path: { id: taskID },
      query: { directory: deps.directory ?? '' },
    });
  } catch {
    return undefined;
  }
  if (
    !isObjectRecord(response) ||
    response.error != null ||
    !Array.isArray(response.data)
  )
    return undefined;
  const users: ChildUser[] = [];
  const ids = new Set<string>();
  for (const message of response.data) {
    if (
      !isObjectRecord(message) ||
      !isObjectRecord(message.info) ||
      typeof message.info.role !== 'string' ||
      !Array.isArray(message.parts)
    )
      return undefined;
    const info = message.info;
    if (info.sessionID !== undefined && info.sessionID !== taskID)
      return undefined;
    if (info.role !== 'user') continue;
    if (
      info.synthetic === true ||
      message.parts.some(
        (part: unknown) => isObjectRecord(part) && part.synthetic === true,
      )
    )
      return undefined;
    if (
      typeof info.id !== 'string' ||
      !info.id.trim() ||
      info.id !== info.id.trim() ||
      ids.has(info.id)
    )
      return undefined;
    const time = isObjectRecord(info.time) ? info.time.created : undefined;
    if (
      time !== undefined &&
      (!Number.isSafeInteger(time) || (time as number) < 0)
    )
      return undefined;
    ids.add(info.id);
    users.push({
      id: info.id,
      ...(time === undefined ? {} : { createdAt: time as number }),
    });
  }
  return users.length ? users : undefined;
}

async function verifyClaimChild(
  taskID: string,
  parentSessionID: string,
  agent: string,
  deps: {
    directory?: string;
    hostClient?: PluginInput['client'];
    identityIndex: IdentityIndex;
  },
): Promise<boolean> {
  const session = deps.hostClient?.session;
  const get = session?.get;
  if (typeof get !== 'function') return false;
  try {
    const identity = deps.identityIndex.lookup(parentSessionID, taskID);
    if (
      identity?.taskID !== taskID ||
      identity.parentSessionID !== parentSessionID ||
      identity.agent !== agent ||
      identity.directory !== deps.directory
    )
      return false;
    const response: unknown = await get({
      path: { id: taskID },
      query: { directory: deps.directory ?? '' },
    });
    if (
      !isObjectRecord(response) ||
      response.error != null ||
      !isObjectRecord(response.data)
    )
      return false;
    const child = response.data;
    if (
      child.id !== taskID ||
      child.parentID !== parentSessionID ||
      child.directory !== deps.directory ||
      (child.agent !== undefined && child.agent !== agent)
    )
      return false;
    if (child.agent === agent) return true;

    // v1 session.get has no agent. Require the parent's native delegation
    // to bind this exact child ID to the indexed agent before settling intent.
    if (typeof session?.messages !== 'function') return false;
    const parent: unknown = await session.messages({
      path: { id: parentSessionID },
      query: { directory: deps.directory ?? '' },
    });
    if (
      !isObjectRecord(parent) ||
      parent.error != null ||
      !Array.isArray(parent.data)
    )
      return false;
    let delegated = false;
    for (const message of parent.data) {
      if (
        !isObjectRecord(message) ||
        !isObjectRecord(message.info) ||
        !Array.isArray(message.parts) ||
        (message.info.sessionID !== undefined &&
          message.info.sessionID !== parentSessionID)
      )
        return false;
      if (message.info.role !== 'assistant') continue;
      for (const part of message.parts) {
        if (
          !isObjectRecord(part) ||
          part.type !== 'tool' ||
          (part.tool !== 'task' &&
            part.name !== 'task' &&
            part.tool !== 'subagent' &&
            part.name !== 'subagent') ||
          !isObjectRecord(part.state)
        )
          continue;
        const state = part.state;
        const content = state.content;
        const text =
          typeof state.output === 'string'
            ? state.output
            : Array.isArray(content) &&
                content.length === 1 &&
                isObjectRecord(content[0]) &&
                content[0].type === 'text' &&
                typeof content[0].text === 'string'
              ? content[0].text
              : undefined;
        if (!text || parseTaskStatusOutput(text)?.taskID !== taskID) continue;
        if (
          !isObjectRecord(state.input) ||
          (state.input.subagent_type ?? state.input.agent) !== agent ||
          state.input.background !== true
        )
          return false;
        delegated = true;
      }
    }
    return delegated;
  } catch {
    return false;
  }
}

async function refuseUnsettledResume(
  requested: string,
  parentSessionID: string,
  taskID: string,
  agent: string,
  deps: {
    directory?: string;
    hostClient?: PluginInput['client'];
    identityIndex: IdentityIndex;
  },
): Promise<never> {
  let claim: ReturnType<IdentityIndex['inspectResumeClaim']>;
  try {
    claim = deps.identityIndex.inspectResumeClaim(parentSessionID, taskID);
  } catch {
    refuseExplicitTaskId(
      requested,
      `Task ${requested}: persistent resume claim unreadable; no new session was created.`,
    );
  }
  if (
    claim?.baseline &&
    (await verifyClaimChild(taskID, parentSessionID, agent, deps))
  ) {
    const users = await readChildUsers(taskID, deps);
    const baseline = claim.baseline;
    const before =
      users?.findIndex((user) => user.id === baseline.childLatestUserID) ?? -1;
    const next = users?.at(-1);
    if (
      before >= 0 &&
      users &&
      before < users.length - 1 &&
      next &&
      (baseline.childLatestUserCreatedAt === undefined ||
        users[before]?.createdAt === baseline.childLatestUserCreatedAt) &&
      (baseline.childLatestUserCreatedAt === undefined ||
        next.createdAt === undefined ||
        next.createdAt >= baseline.childLatestUserCreatedAt)
    ) {
      try {
        deps.identityIndex.settleResume(parentSessionID, taskID, claim.token);
        if (deps.identityIndex.inspectResumeClaim(parentSessionID, taskID)) {
          throw new Error('claim not settled');
        }
      } catch {
        refuseExplicitTaskId(
          requested,
          `Task ${requested}: admitted resume claim could not be settled; no new session was created.`,
        );
      }
      refuseExplicitTaskId(
        requested,
        `Task ${taskID}: the previous resume was already admitted by the host. No new task() was sent. Check task_status or task_result with task_id "${taskID}"; retry only after the current run is terminal and acknowledged.`,
        { admitted: true },
      );
    }
  }
  refuseExplicitTaskId(
    requested,
    `Task ${requested}: another resume is unsettled or its admission cannot be proven; no new session was created. Check task_status or task_result with task_id "${taskID}" before retrying.`,
  );
}

function parentConfirmationRetryGuidance(
  requested: string,
  recovery: Awaited<ReturnType<typeof classifySessionRecovery>>,
): string | undefined {
  if (
    recovery.kind !== 'uncertain' ||
    (recovery.reason !== 'parent terminal notice unproven' &&
      recovery.reason !== 'parent acknowledgement unproven')
  )
    return undefined;
  return ` Call task_result with task_id "${requested}" (the same alias or exact ID), then retry once with the original task_id. Do not wait for a later parent turn. No new session was created.`;
}

async function recoverUnknownTask(
  requested: string,
  parentSessionID: string,
  agent: string,
  label: string,
  deps: {
    directory?: string;
    hostClient?: PluginInput['client'];
    identityIndex?: IdentityIndex;
    backgroundJobBoard: BackgroundJobStore;
  },
): Promise<NonNullable<ReturnType<BackgroundJobStore['get']>>> {
  const directory = deps.directory ?? '';
  const requestedKey =
    requested.startsWith('ses_') ||
    !/^[a-z][a-z0-9_]*-[1-9]\d*$/.test(requested)
      ? { sessionID: requested }
      : { alias: requested };
  const recovery = await classifySessionRecovery(
    recoveryRequest(requestedKey, parentSessionID, agent, deps),
  );
  if (
    recovery.kind !== 'reusable' ||
    !recovery.taskID ||
    recovery.evidence.acknowledged !== true
  ) {
    const retryGuidance = parentConfirmationRetryGuidance(requested, recovery);
    if (recovery.kind === 'uncertain' && retryGuidance) {
      refuseExplicitTaskId(
        requested,
        `Task ${requested}: fresh host evidence does not confirm a reusable session; resume blocked.${retryGuidance}`,
        { recovery: recovery.kind, reason: recovery.reason },
      );
    }
    const guidance =
      recovery.kind === 'live'
        ? 'The child is busy or retrying; wait for its result.'
        : recovery.kind === 'stopped'
          ? 'The child stopped; use task_revive with a new prompt.'
          : recovery.kind === 'missing'
            ? 'The host confirmed it missing; omit task_id to spawn explicitly.'
            : 'Recovery is unconfirmed; wait or omit task_id to spawn explicitly.';
    refuseExplicitTaskId(
      requested,
      `Task ${requested}: ${guidance} The task_id was not dropped; no new session was created.`,
      { recovery: recovery.kind },
    );
  }
  if (!deps.identityIndex)
    refuseExplicitTaskId(
      requested,
      `Task ${requested}: persistent identity index unavailable; cannot safely resume.`,
    );
  try {
    const minimumCounter = Math.max(
      0,
      ...deps.backgroundJobBoard
        .list(parentSessionID)
        .map((job) => Number(/-([1-9]\d*)$/.exec(job.alias)?.[1] ?? 0)),
    );
    const identity =
      deps.identityIndex.lookup(parentSessionID, recovery.taskID) ??
      deps.identityIndex.reserve(
        parentSessionID,
        recovery.taskID,
        agent,
        aliasPrefix(agent),
        minimumCounter,
      );
    if (
      identity.taskID !== recovery.taskID ||
      identity.agent !== agent ||
      identity.directory !== directory ||
      identity.parentSessionID !== parentSessionID ||
      (recovery.alias !== undefined && identity.alias !== recovery.alias)
    )
      throw new Error('identity changed during recovery');
    return deps.backgroundJobBoard.adoptExistingSession(
      {
        parentSessionID,
        taskID: recovery.taskID,
        agent,
        alias: identity.alias,
        description: recovery.description || label,
        background: true,
      },
      recovery.evidence,
    );
  } catch (error) {
    refuseExplicitTaskId(
      requested,
      `Task ${requested}: recovered identity cannot be adopted safely; no new session was created.`,
      { error: String(error) },
    );
  }
}

export async function handleToolExecuteBefore(
  input: { tool: string; sessionID?: string; callID?: string },
  output: { args?: unknown },
  deps: {
    shouldManageSession: (sessionID: string) => boolean;
    registerSessionAsOrchestrator?: (sessionID: string) => void;
    backgroundJobBoard: BackgroundJobStore;
    terminalGate: BackgroundJobTerminalGate;
    pendingCallTracker: {
      add(call: PendingTaskCall): void;
      take(
        callID?: string,
        sessionID?: string,
        ownerBoard?: BackgroundJobStore,
        options?: { recordConsumed?: boolean },
      ): PendingTaskCall | undefined;
      release?(call: PendingTaskCall): void;
      pendingCallId(sessionID?: string, callID?: string): string;
    };
    resumeEvidence?: SameProcessResumeEvidence;
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
    /** Legacy caller option; recovery now uses scoped host get/messages/status. */
    hasUntrackedRunningChild?: (parentSessionID?: string) => Promise<boolean>;
    identityIndex?: IdentityIndex;
    hostClient?: PluginInput['client'];
    directory?: string;
  },
): Promise<void> {
  const toolName = input.tool.toLowerCase();
  if (toolName !== 'task') return;
  if (!input.sessionID) return;
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
  if (
    typeof args.subagent_type !== 'string' ||
    args.subagent_type.trim() === ''
  ) {
    if (typeof args.task_id === 'string' && args.task_id.trim() !== '') {
      const requested = args.task_id.trim();
      refuseExplicitTaskId(
        requested,
        `Task ${requested}: task() requires a valid subagent_type with an explicit task_id. The task_id was not dropped; no new session was created.`,
      );
    }
    return;
  }

  const agentType = args.subagent_type.trim();
  const requestedTaskID =
    typeof args.task_id === 'string' && args.task_id.trim() !== ''
      ? args.task_id.trim()
      : undefined;
  if (
    requestedTaskID !== undefined &&
    (typeof args.description !== 'string' || args.description.trim() === '')
  ) {
    // The native task schema rejects this call before dispatch. Refuse it
    // before inspecting or mutating durable identity state, so the host cannot
    // leave an orphaned resume claim behind.
    refuseExplicitTaskId(
      requestedTaskID,
      `Task ${requestedTaskID}: task() requires a non-empty description when task_id is explicit; no new session was created.`,
    );
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
  if (requestedTaskID !== undefined) {
    const requested = requestedTaskID;
    if (deps.identityIndex) {
      let identity: ReturnType<IdentityIndex['lookup']>;
      let claim: ReturnType<IdentityIndex['inspectResumeClaim']>;
      try {
        identity = deps.identityIndex.lookup(input.sessionID, requested);
        if (identity) {
          claim = deps.identityIndex.inspectResumeClaim(
            input.sessionID,
            identity.taskID,
          );
        }
      } catch {
        refuseExplicitTaskId(
          requested,
          `Task ${requested}: identity index unreadable; resume blocked.`,
        );
      }
      if (claim && identity) {
        if (
          identity.parentSessionID !== input.sessionID ||
          identity.agent !== agentType ||
          identity.directory !== deps.directory ||
          (identity.alias !== requested && identity.taskID !== requested)
        ) {
          refuseExplicitTaskId(
            requested,
            `Task ${requested}: persisted identity disagrees with the request; resume blocked.`,
          );
        }
        const schemaRejectionSettled = await settleSchemaRejectedResumeClaim(
          requested,
          input.sessionID,
          identity,
          claim,
          {
            identityIndex: deps.identityIndex,
            directory: deps.directory,
            hostClient: deps.hostClient,
          },
        );
        if (!schemaRejectionSettled) {
          await refuseUnsettledResume(
            requested,
            input.sessionID,
            identity.taskID,
            agentType,
            {
              identityIndex: deps.identityIndex,
              directory: deps.directory,
              hostClient: deps.hostClient,
            },
          );
        }
      }
    }
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
      let knownManagedTask = deps.backgroundJobBoard.resolve(
        input.sessionID,
        requested,
      );
      if (!knownManagedTask && deps.identityIndex) {
        let identity: ReturnType<IdentityIndex['lookup']>;
        try {
          identity = deps.identityIndex.lookup(input.sessionID, requested);
        } catch {
          refuseExplicitTaskId(
            requested,
            `Task ${requested}: identity index unreadable; resume blocked.`,
          );
        }
        const candidate =
          identity && deps.backgroundJobBoard.get(identity.taskID);
        if (
          identity?.alias === requested &&
          candidate?.parentSessionID === input.sessionID &&
          candidate.agent === identity.agent &&
          candidate.alias === candidate.taskID &&
          identity.directory === deps.directory
        ) {
          knownManagedTask = candidate;
          remembered =
            deps.backgroundJobBoard.resolveReusable(
              input.sessionID,
              candidate.taskID,
              agentType,
            ) ??
            deps.backgroundJobBoard.resolveRecoverable(
              input.sessionID,
              candidate.taskID,
              agentType,
            );
        }
      }
      if (!remembered && knownManagedTask) {
        if (knownManagedTask.state === 'running') {
          if (knownManagedTask.agent !== agentType) {
            refuseKnownTaskResume(requested, knownManagedTask, agentType);
          }
          remembered = knownManagedTask;
        } else if (
          knownManagedTask.state === 'completed' &&
          knownManagedTask.terminalUnreconciled
        ) {
          // The board flag can still say unreconciled after task_result.
          // Classify that retrieval before refusing the same-ID call.
          remembered = knownManagedTask;
        } else {
          refuseKnownTaskResume(requested, knownManagedTask, agentType);
        }
      } else if (!remembered) {
        remembered = await recoverUnknownTask(
          requested,
          input.sessionID,
          agentType,
          label,
          deps,
        );
      }
    }
    if (remembered) {
      const observedGeneration = remembered.generation;
      const recovery = await classifySessionRecovery(
        recoveryRequest(
          { sessionID: remembered.taskID },
          input.sessionID,
          agentType,
          {
            ...deps,
            resumeEvidence: deps.resumeEvidence,
            resumeEvidenceContext: {
              generation: remembered.generation,
              terminalRevision: remembered.terminalRevision,
            },
          },
        ),
      );
      if (recovery.taskID !== remembered.taskID) {
        refuseExplicitTaskId(
          requested,
          `Task ${requested}: host identity unconfirmed; resume blocked.`,
          { recovery: recovery.kind },
        );
      }
      if (recovery.kind === 'live') {
        refuseExplicitTaskId(
          requested,
          `Task ${requested}: child ${remembered.taskID} is busy or retrying; task() cannot send another prompt. Wait for its result, or check task_status or task_message with the same task_id. No new session was created.`,
          { recovery: recovery.kind },
        );
      }
      if (remembered.state === 'running' && recovery.kind === 'reusable') {
        // Only the terminal gate may advance an active generation. Its
        // independent observation can defer; never overwrite it by adoption.
        await deps.terminalGate.reconcile({
          taskID: remembered.taskID,
          generation: observedGeneration,
        });
        remembered = deps.backgroundJobBoard.resolveReusable(
          input.sessionID,
          remembered.taskID,
          agentType,
        );
      }
      if (
        remembered?.state === 'completed' &&
        remembered.terminalUnreconciled
      ) {
        if (recovery.kind === 'reusable' && recovery.evidence.acknowledged) {
          const reconciled = deps.backgroundJobBoard.markReconciled(
            remembered.taskID,
            Date.now(),
            remembered.generation,
            remembered.terminalRevision,
          );
          if (reconciled) remembered = reconciled;
        }
        if (remembered.terminalUnreconciled) {
          refuseKnownTaskResume(requested, remembered, agentType);
        }
      }
      if (
        !remembered ||
        recovery.kind !== 'reusable' ||
        (recovery.kind === 'reusable' &&
          !deps.backgroundJobBoard.resolveReusable(
            input.sessionID,
            remembered.taskID,
            agentType,
          ))
      ) {
        if (remembered?.state === 'running') {
          throw new Error(
            `Task ${requested} is still running on the board and cannot be resumed or amended with task(). The host observation is ${recovery.kind}; wait for generation-safe terminal reconciliation before retrying. Do not spawn or cancel a duplicate for an additive request.`,
          );
        }
        const retryGuidance =
          parentConfirmationRetryGuidance(requested, recovery) ?? '';
        refuseExplicitTaskId(
          requested,
          `Task ${requested}: fresh host evidence does not confirm a reusable session; resume blocked.${retryGuidance}`,
          {
            recovery: recovery.kind,
            reason: 'reason' in recovery ? recovery.reason : undefined,
            hasPendingAcknowledgement:
              recovery.kind === 'uncertain' &&
              recovery.pendingAcknowledgement !== undefined,
            hasBrokerToken: recoveryResumeToken(recovery) !== undefined,
            boardGeneration: remembered?.generation,
            boardTerminalRevision: remembered?.terminalRevision,
          },
        );
      }
      if (
        deps.backgroundJobBoard.get(remembered.taskID)?.generation !==
        remembered.generation
      ) {
        refuseExplicitTaskId(
          requested,
          `Task ${requested}: board generation changed; resume blocked.`,
        );
      }
      if (!deps.identityIndex) {
        refuseExplicitTaskId(
          requested,
          `Task ${requested}: persistent identity index unavailable; resume baseline cannot be claimed. No new session was created.`,
        );
      }
      if (deps.identityIndex) {
        let indexed: ReturnType<IdentityIndex['lookup']>;
        try {
          indexed = deps.identityIndex.lookup(
            input.sessionID,
            remembered.taskID,
          );
        } catch {
          refuseExplicitTaskId(
            requested,
            `Task ${requested}: identity index unreadable; resume blocked.`,
          );
        }
        if (
          !indexed &&
          requested === remembered.taskID &&
          recovery.kind === 'reusable'
        ) {
          try {
            const minimumCounter = Math.max(
              0,
              ...deps.backgroundJobBoard
                .list(input.sessionID)
                .map((job) => Number(/-([1-9]\d*)$/.exec(job.alias)?.[1] ?? 0)),
            );
            indexed = deps.identityIndex.reserve(
              input.sessionID,
              remembered.taskID,
              agentType,
              aliasPrefix(agentType),
              minimumCounter,
            );
          } catch (error) {
            refuseExplicitTaskId(
              requested,
              `Task ${requested}: identity reservation unavailable; resume blocked.`,
              { error: String(error) },
            );
          }
        }
        if (
          !indexed ||
          indexed.parentSessionID !== input.sessionID ||
          indexed.taskID !== remembered.taskID ||
          indexed.agent !== agentType ||
          (indexed.alias !== remembered.alias &&
            !(
              remembered.alias === remembered.taskID &&
              (requested === remembered.taskID || requested === indexed.alias)
            )) ||
          indexed.directory !== deps.directory
        )
          refuseExplicitTaskId(
            requested,
            `Task ${requested}: persisted identity disagrees with the board; resume blocked.`,
          );
      }
      const relaunchLease = deps.backgroundJobBoard.acquireRelaunchLease(
        remembered.taskID,
        remembered.generation,
      );
      if (!relaunchLease) {
        throw new Error(
          `Task ${requested} cannot be resumed safely: its current generation is already owned by another lifecycle operation. Do not launch a duplicate with the same task_id.`,
        );
      }
      const resumeToken = recoveryResumeToken(recovery);
      if (resumeToken && deps.resumeEvidence) {
        const claim = deps.resumeEvidence.claim(resumeToken);
        if (!claim) {
          deps.backgroundJobBoard.releaseLease(relaunchLease);
          refuseExplicitTaskId(
            requested,
            `Task ${requested}: same-process resume evidence is stale or already in use; no new session was created.`,
          );
        }
        pendingCall.resumeEvidenceClaim = claim;
      }
      const users = await readChildUsers(remembered.taskID, deps);
      const latestUser = users?.at(-1);
      if (!latestUser) {
        releaseResumeEvidenceBeforeSend(pendingCall, deps.resumeEvidence);
        deps.backgroundJobBoard.releaseLease(relaunchLease);
        refuseExplicitTaskId(
          requested,
          `Task ${requested}: latest native child user turn cannot be verified; resume blocked.`,
        );
      }
      if (deps.identityIndex) {
        let token: string | undefined;
        const baseline: ResumeClaimBaseline = {
          childLatestUserID: latestUser.id,
          ...(latestUser.createdAt === undefined
            ? {}
            : { childLatestUserCreatedAt: latestUser.createdAt }),
          claimedAt: Date.now(),
        };
        try {
          token = deps.identityIndex.claimResume(
            input.sessionID,
            remembered.taskID,
            baseline,
          );
        } catch {
          releaseResumeEvidenceBeforeSend(pendingCall, deps.resumeEvidence);
          deps.backgroundJobBoard.releaseLease(relaunchLease);
          refuseExplicitTaskId(
            requested,
            `Task ${requested}: persistent resume claim unavailable.`,
          );
        }
        if (!token) {
          releaseResumeEvidenceBeforeSend(pendingCall, deps.resumeEvidence);
          deps.backgroundJobBoard.releaseLease(relaunchLease);
          throw await refuseUnsettledResume(
            requested,
            input.sessionID,
            remembered.taskID,
            agentType,
            {
              identityIndex: deps.identityIndex,
              directory: deps.directory,
              hostClient: deps.hostClient,
            },
          );
        }
        pendingCall.resumeClaim = {
          parentSessionID: input.sessionID,
          taskID: remembered.taskID,
          token,
        };
      }
      args.task_id = remembered.taskID;
      deps.taskContextTracker.pendingManagedTaskIds.add(remembered.taskID);
      try {
        deps.backgroundJobBoard.markUsed(input.sessionID, remembered.taskID);
      } catch (error) {
        releaseResumeEvidenceBeforeSend(pendingCall, deps.resumeEvidence);
        deps.backgroundJobBoard.releaseLease(relaunchLease);
        args.task_id = requested;
        if (pendingCall.resumeClaim) {
          try {
            deps.identityIndex?.settleResume(
              pendingCall.resumeClaim.parentSessionID,
              pendingCall.resumeClaim.taskID,
              pendingCall.resumeClaim.token,
            );
          } catch (settleError) {
            log(
              '[task-session-manager] pre-dispatch claim settlement failed',
              String(settleError),
            );
          }
        }
        deps.taskContextTracker.pendingManagedTaskIds.delete(remembered.taskID);
        throw error;
      }
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
        `A background task with the same objective already finished and its result is awaiting acknowledgment: ${duplicate.alias} / ${duplicate.taskID}. Call task_result with task_id "${duplicate.taskID}" to retrieve it instead of spawning a duplicate. If the retrieved result is insufficient, retry the spawn after retrieval — retrieval authorizes the retry.`,
      );
    }
  }

  try {
    deps.pendingCallTracker.add(pendingCall);
    if (pendingCall.background && deps.backgroundTaskConcurrency) {
      // Nested orchestration exemption: a session that is itself a managed
      // task already holds an admission slot. Waiting for another one while
      // the queue is saturated would deadlock — this session could never
      // finish, so its own slot could never be released.
      const isManagedTask = deps.backgroundJobBoard
        .taskIDs()
        .has(input.sessionID);
      if (!isManagedTask) {
        const ticket = deps.backgroundTaskConcurrency.acquire({
          model: deps.getModelForAgent?.(
            agentType,
            pendingCall.parentSessionId,
          ),
        });
        pendingCall.concurrencyTicket = ticket;
        await ticket.ready;
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
    releaseResumeEvidenceBeforeSend(
      tracked ?? pendingCall,
      deps.resumeEvidence,
    );
    if (pendingCall.resumeClaim) {
      try {
        deps.identityIndex?.settleResume(
          pendingCall.resumeClaim.parentSessionID,
          pendingCall.resumeClaim.taskID,
          pendingCall.resumeClaim.token,
        );
      } catch (settleError) {
        log(
          '[task-session-manager] pre-dispatch claim settlement failed',
          String(settleError),
        );
      }
    }
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
  input: {
    tool: string;
    sessionID?: string;
    callID?: string;
    nativeToolStatus?: 'error' | 'completed';
  },
  output: { output: unknown; metadata?: unknown },
  deps: {
    directory: string;
    backgroundJobBoard: BackgroundJobStore;
    terminalGate: BackgroundJobTerminalGate;
    pendingCallTracker: {
      take(
        callID?: string,
        sessionID?: string,
        ownerBoard?: BackgroundJobStore,
        options?: { recordConsumed?: boolean },
      ): PendingTaskCall | undefined;
      takeByTaskID(
        sessionID: string,
        taskID: string,
        ownerBoard?: BackgroundJobStore,
      ): PendingTaskCall | undefined;
      takeUnresolvedFirstMatch(
        sessionID: string,
        selection?: {
          identityTaskID?: string;
          agentType?: string;
          ownerBoard?: BackgroundJobStore;
        },
      ): PendingTaskCall | undefined;
      release?(call: PendingTaskCall): void;
    };
    resumeEvidence?: SameProcessResumeEvidence;
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
    identityIndex?: IdentityIndex;
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
  const nativeTaskID =
    input.nativeToolStatus !== 'error' && typeof output.output === 'string'
      ? parseTaskIdFromTaskOutput(output.output)
      : undefined;
  let pending =
    !exactCallID && nativeTaskID && input.sessionID
      ? deps.pendingCallTracker.takeByTaskID(
          input.sessionID,
          nativeTaskID,
          deps.backgroundJobBoard,
        )
      : undefined;
  const verifiedTaskID = pending ? nativeTaskID : undefined;
  pending ??= deps.pendingCallTracker.take(
    exactCallID,
    exactCallID ? undefined : input.sessionID,
    deps.backgroundJobBoard,
  );
  const exactCallConfirmed =
    exactCallID !== undefined && pending?.callId === exactCallID;
  let identityTaskID = verifiedTaskID;
  if (!pending && nativeTaskID) {
    // No tool call ID (or unknown one): resolve identity via the task
    // ID parsed from this call's own output, matched against the
    // pending the early registration claimed for that child. This
    // avoids guessing by insertion order among parallel calls.
    identityTaskID = nativeTaskID;
    if (identityTaskID && input.sessionID) {
      pending = deps.pendingCallTracker.takeByTaskID(
        input.sessionID,
        identityTaskID,
        deps.backgroundJobBoard,
      );
      if (pending) {
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
    // v2 can render a failed native call as text that resembles a valid task
    // result. It is not a launch, even when its text contains the exact ID.
    if (input.nativeToolStatus === 'error') return;
    if (
      pending.resumedTaskId &&
      !exactCallConfirmed &&
      (identityTaskID !== pending.resumedTaskId || pending.identityUnresolved)
    )
      return;
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
      const record = registerTaskOutputLaunch(
        launch.taskID,
        pending,
        exactCallConfirmed,
        hostConfirmedBackground,
        deps,
      );
      if (!record) return;
      settleAcceptedResume(
        pending,
        record,
        exactCallConfirmed ||
          (identityTaskID === record.taskID && !pending.identityUnresolved),
        deps.identityIndex,
        deps.resumeEvidence,
      );
      deps.bindConcurrencyTicket?.(record.taskID, pending);
      deps.clearRehydrateTombstone?.(launch.taskID);
      if (exactCallConfirmed) deps.backgroundJobSupervisor?.onLaunch(record);
      log('[task-session-manager] background task launch registered', {
        taskID: record.taskID,
        alias: record.alias,
        parentSessionID: record.parentSessionID,
        agent: record.agent,
        description: record.description,
        state: record.state,
      });
      deps.taskContextTracker.pendingManagedTaskIds.add(launch.taskID);
      deps.backgroundJobBoard.addContext(
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
      settleAcceptedResume(
        pending,
        record,
        exactCallConfirmed ||
          (identityTaskID === record.taskID && !pending.identityUnresolved),
        deps.identityIndex,
        deps.resumeEvidence,
      );
      deps.bindConcurrencyTicket?.(record.taskID, pending);
      deps.clearRehydrateTombstone?.(status.taskID);
      normalizeLateCancelledTaskOutput(output, deps.backgroundJobBoard);
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
      deps.taskContextTracker.pendingManagedTaskIds.add(taskId);
    } else {
      deps.taskContextTracker.pendingManagedTaskIds.delete(taskId);
    }
    deps.backgroundJobBoard.addContext(
      taskId,
      deps.taskContextTracker.contextFilesForPrompt(taskId),
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

function settleAcceptedResume(
  pending: PendingTaskCall,
  record: NonNullable<ReturnType<BackgroundJobStore['get']>>,
  exactCallConfirmed: boolean,
  index?: IdentityIndex,
  resumeEvidence?: SameProcessResumeEvidence,
): void {
  const claim = pending.resumeClaim;
  if (
    !claim ||
    !exactCallConfirmed ||
    pending.identityUnresolved ||
    pending.resumedTaskId !== record.taskID ||
    claim.taskID !== record.taskID ||
    record.state !== 'running' ||
    record.generation === pending.relaunchLease?.generation
  )
    return;
  try {
    index?.settleResume(claim.parentSessionID, claim.taskID, claim.token);
  } catch (error) {
    log(
      '[task-session-manager] native resume claim settlement failed',
      String(error),
    );
  }
  if (pending.resumeEvidenceClaim && resumeEvidence) {
    const claim = pending.resumeEvidenceClaim;
    pending.resumeEvidenceClaim = undefined;
    if (!resumeEvidence.accept(claim)) {
      log('[task-session-manager] same-process resume evidence claim rejected');
    }
  }
}

function registerTaskOutputLaunch(
  taskID: string,
  pending: PendingTaskCall,
  exactCallConfirmed: boolean,
  hostConfirmedBackground: boolean,
  deps: {
    backgroundJobBoard: BackgroundJobStore;
    backgroundJobSupervisor?: BackgroundJobSupervisor;
    isStaleDeletedTaskOutput?: (
      taskID: string,
      lifecycleEpoch: number,
    ) => boolean;
  },
): ReturnType<BackgroundJobStore['get']> {
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
