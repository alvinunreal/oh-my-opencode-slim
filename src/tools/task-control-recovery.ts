import type { PluginInput } from '@opencode-ai/plugin';
import {
  classifySessionRecovery,
  findStructuredParentTaskDelegation,
  type SameProcessResumeEvidenceContext,
  type SessionRecoveryResult,
} from '../hooks/task-session-manager/session-recovery';
import type {
  BackgroundJobAdoptionEvidence,
  BackgroundJobRecord,
} from '../utils/background-job-board';
import type {
  BackgroundJobIdentity,
  BackgroundJobOperation,
  OperationClaimResolution,
  ResumeClaimBaseline,
} from '../utils/background-job-identity-index';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { isRecord } from '../utils/guards';
import { getClient } from '../utils/opencode-client';
import type { SameProcessResumeEvidenceBroker } from '../utils/same-process-resume-evidence';
import {
  OperationTimeoutError,
  SESSION_ID_PATTERN,
  withTimeout,
} from '../utils/session';

const DEFAULT_RECOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_BASELINE_READ_TIMEOUT_MS = 5_000;
type OperationTransitionResult = boolean | Awaited<Promise<void>>;

const AGENT_ALIAS_PREFIX: Record<string, string> = {
  council: 'cou',
  designer: 'des',
  explorer: 'exp',
  fixer: 'fix',
  librarian: 'lib',
  observer: 'obs',
  oracle: 'ora',
};

function aliasPrefix(agent: string): string {
  const known = AGENT_ALIAS_PREFIX[agent];
  if (known) return known;
  const prefix = agent
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 3);
  return /^[a-z][a-z0-9_]*$/.test(prefix) ? prefix : 'job';
}

export interface TaskControlIdentityIndex {
  lookup(
    parentSessionID: string,
    key: string,
  ): BackgroundJobIdentity | undefined;
  reserve?: (
    parentSessionID: string,
    taskID: string,
    agent: string,
    prefix: string,
    minimumCounter?: number,
  ) => BackgroundJobIdentity;
  claimOperation?: (
    parentSessionID: string,
    taskID: string,
    operation: BackgroundJobOperation,
    baseline?: ResumeClaimBaseline,
  ) => string | undefined;
  markOperationSent?: (
    parentSessionID: string,
    taskID: string,
    operation: BackgroundJobOperation,
    token: string,
  ) => OperationTransitionResult;
  markOperationAccepted?: (
    parentSessionID: string,
    taskID: string,
    operation: BackgroundJobOperation,
    token: string,
  ) => OperationTransitionResult;
  beginOperationCompensation?: (
    parentSessionID: string,
    taskID: string,
    operation: BackgroundJobOperation,
    token: string,
  ) => OperationTransitionResult;
  settleOperation?: (
    parentSessionID: string,
    taskID: string,
    operation: BackgroundJobOperation,
    token: string,
    resolution?: OperationClaimResolution,
  ) => OperationTransitionResult;
}

export interface TaskControlRecoveryOptions {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  identityIndex?: TaskControlIdentityIndex;
  hostClient?: PluginInput['client'];
  readParentTranscript?: () => Promise<unknown>;
  readChildTranscript?: (taskID: string) => Promise<unknown>;
  getSession?: (taskID: string, directory: string) => Promise<unknown>;
  probeStatus?: (taskID: string, directory: string) => Promise<unknown>;
  /** Optional same-process gate for statusless v2 terminal reuse. */
  sameProcessResumeEvidence?: SameProcessResumeEvidenceBroker;
  /** Read-only board/recovery identity for the terminal publication being
   * classified. */
  sameProcessResumeEvidenceContextFor?: (
    taskID: string,
  ) => SameProcessResumeEvidenceContext | undefined;
  now?: () => number;
  /** Maximum time spent recovering an untracked task. */
  timeoutMs?: number;
  /** Maximum time spent reading a child transcript baseline. */
  baselineReadTimeoutMs?: number;
}

export type TaskControlRecoveryTarget =
  | {
      kind: 'board';
      requested: string;
      job: BackgroundJobRecord;
    }
  | {
      kind: 'recovered';
      requested: string;
      job: BackgroundJobRecord;
      classification: SessionRecoveryResult;
    }
  | {
      kind: 'orphan';
      requested: string;
      taskID?: string;
      classification: SessionRecoveryResult;
      reason: string;
    }
  | {
      kind: 'unknown';
      requested: string;
      reason: string;
    };

export interface TaskControlRecovery {
  resolve(
    parentSessionID: string,
    requested: string,
  ): Promise<TaskControlRecoveryTarget>;
  hasDurableOperationClaims(): boolean;
  readLatestChildUser(taskID: string): Promise<ResumeClaimBaseline | undefined>;
  claimOperation(
    parentSessionID: string,
    taskID: string,
    operation: BackgroundJobOperation,
    baseline: ResumeClaimBaseline,
  ): string | undefined;
  markOperationSent(
    parentSessionID: string,
    taskID: string,
    operation: BackgroundJobOperation,
    token: string,
  ): boolean | undefined;
  markOperationAccepted(
    parentSessionID: string,
    taskID: string,
    operation: BackgroundJobOperation,
    token: string,
  ): boolean | undefined;
  beginOperationCompensation(
    parentSessionID: string,
    taskID: string,
    operation: BackgroundJobOperation,
    token: string,
  ): boolean | undefined;
  settleOperation(
    parentSessionID: string,
    taskID: string,
    operation: BackgroundJobOperation,
    token: string,
    resolution?: OperationClaimResolution,
  ): boolean | undefined;
}

function responseData(response: unknown): unknown {
  return isRecord(response) && response.error == null
    ? response.data
    : undefined;
}

function hostSession(input: PluginInput, hostClient?: PluginInput['client']) {
  return (hostClient ?? getClient(input)).session;
}

function makeDefaultReaders(options: TaskControlRecoveryOptions) {
  const session = hostSession(options.input, options.hostClient);
  const directory = options.input.directory;
  const messages =
    typeof session?.messages === 'function'
      ? session.messages.bind(session)
      : undefined;
  const get =
    typeof session?.get === 'function' ? session.get.bind(session) : undefined;
  const status =
    typeof session?.status === 'function'
      ? session.status.bind(session)
      : undefined;
  return {
    readParentTranscript: options.readParentTranscript,
    readChildTranscript:
      options.readChildTranscript ??
      (messages
        ? (taskID: string) =>
            messages({ path: { id: taskID }, query: { directory } })
        : undefined),
    getSession:
      options.getSession ??
      (get
        ? (taskID: string) =>
            get({ path: { id: taskID }, query: { directory } })
        : undefined),
    probeStatus:
      options.probeStatus ??
      (status ? () => status({ query: { directory } }) : undefined),
  };
}

function isAdoptionResult(
  classification: SessionRecoveryResult,
): classification is Extract<
  SessionRecoveryResult,
  { kind: 'live' | 'stopped' | 'reusable' }
> {
  return (
    classification.kind === 'live' ||
    classification.kind === 'stopped' ||
    classification.kind === 'reusable'
  );
}

function adoptionEvidence(
  classification: Extract<
    SessionRecoveryResult,
    { kind: 'live' | 'stopped' | 'reusable' }
  >,
): BackgroundJobAdoptionEvidence {
  return classification.evidence;
}

function hasVerifiedStatus(response: unknown, taskID: string): boolean {
  if (
    !isRecord(response) ||
    response.error != null ||
    !isRecord(response.data) ||
    Object.hasOwn(response.data, 'type') ||
    Object.hasOwn(response.data, 'status')
  )
    return false;
  const row = response.data[taskID];
  return (
    row === undefined ||
    (isRecord(row) &&
      (row.type === 'busy' || row.type === 'retry' || row.type === 'idle'))
  );
}

function inputResumeEvidence(
  input: PluginInput,
): SameProcessResumeEvidenceBroker | undefined {
  const extended = input as PluginInput & {
    experimental_v2?: {
      sameProcessResumeEvidence?: SameProcessResumeEvidenceBroker;
    };
  };
  return extended.experimental_v2?.sameProcessResumeEvidence;
}

function isReservedIdentity(
  value: unknown,
  parentSessionID: string,
  taskID: string,
  agent: string,
  directory: string,
  prefix: string,
): value is BackgroundJobIdentity {
  return (
    isRecord(value) &&
    value.parentSessionID === parentSessionID &&
    value.taskID === taskID &&
    value.agent === agent &&
    value.directory === directory &&
    typeof value.alias === 'string' &&
    new RegExp(`^${prefix}-[1-9]\\d*$`).test(value.alias) &&
    value.alias !== taskID
  );
}

type RecoveryAttempt = {
  active: boolean;
  timedOut: boolean;
};

function recoveryTimeoutMs(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? value
    : DEFAULT_RECOVERY_TIMEOUT_MS;
}

function baselineReadTimeoutMs(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? value
    : DEFAULT_BASELINE_READ_TIMEOUT_MS;
}

function timedOutTarget(
  requested: string,
  identity: BackgroundJobIdentity | undefined,
  agent: string | undefined,
  timeoutMs: number,
): Extract<TaskControlRecoveryTarget, { kind: 'orphan' }> {
  const taskID = identity?.taskID ?? requested;
  const reason = `recovery timed out after ${timeoutMs}ms`;
  return {
    kind: 'orphan',
    requested,
    taskID,
    classification: {
      kind: 'uncertain',
      taskID,
      alias: identity?.alias,
      agent,
      reason,
    },
    reason,
  };
}

export function createTaskControlRecovery(
  options: TaskControlRecoveryOptions,
): TaskControlRecovery {
  const readers = makeDefaultReaders(options);
  const directory = options.input.directory;
  const sameProcessResumeEvidence =
    options.sameProcessResumeEvidence ?? inputResumeEvidence(options.input);

  const resumeEvidenceContextFor = (
    taskID: string,
  ): SameProcessResumeEvidenceContext | undefined => {
    try {
      const supplied = options.sameProcessResumeEvidenceContextFor?.(taskID);
      if (supplied) return supplied;
    } catch {
      return undefined;
    }
    const boardJob = options.backgroundJobBoard.get(taskID);
    return boardJob
      ? {
          generation: boardJob.generation,
          terminalRevision: boardJob.terminalRevision,
        }
      : undefined;
  };

  const recovery: TaskControlRecovery = {
    async resolve(parentSessionID, requested) {
      const key = requested.trim();
      const boardJob = options.backgroundJobBoard.resolve(parentSessionID, key);
      if (boardJob) {
        try {
          const persisted = options.identityIndex?.lookup(parentSessionID, key);
          if (
            persisted &&
            (persisted.taskID !== boardJob.taskID ||
              persisted.parentSessionID !== boardJob.parentSessionID ||
              persisted.agent !== boardJob.agent ||
              persisted.alias !== boardJob.alias ||
              persisted.directory !== directory)
          ) {
            return {
              kind: 'unknown',
              requested: key,
              reason: 'board and durable identity mappings conflict',
            };
          }
        } catch {
          // Preserve same-process board behavior. The durable index is only
          // needed to recover an orphan; a tracked board record is authoritative.
        }
        return { kind: 'board', requested: key, job: boardJob };
      }
      const foreignBoardJob =
        options.backgroundJobBoard.get(key) ??
        options.backgroundJobBoard.list().find((job) => job.alias === key);
      if (
        foreignBoardJob &&
        foreignBoardJob.parentSessionID !== parentSessionID
      )
        return {
          kind: 'unknown',
          requested: key,
          reason: 'task belongs to a different parent session',
        };

      let identity: BackgroundJobIdentity | undefined;
      try {
        identity = options.identityIndex?.lookup(parentSessionID, key);
      } catch {
        if (SESSION_ID_PATTERN.test(key)) {
          const reason = 'identity index unreadable';
          return {
            kind: 'orphan',
            requested: key,
            taskID: key,
            classification: { kind: 'uncertain', taskID: key, reason },
            reason,
          };
        }
        return {
          kind: 'unknown',
          requested: key,
          reason: 'identity index unreadable',
        };
      }
      if (identity) {
        if (
          identity.parentSessionID !== parentSessionID ||
          identity.directory !== directory ||
          (identity.taskID !== key && identity.alias !== key)
        ) {
          return {
            kind: 'unknown',
            requested: key,
            reason: 'persisted identity does not match the request',
          };
        }
      } else if (!SESSION_ID_PATTERN.test(key)) {
        return {
          kind: 'unknown',
          requested: key,
          reason: 'alias has no durable mapping',
        };
      }

      let agent = identity?.agent;
      const timeoutMs = recoveryTimeoutMs(options.timeoutMs);
      const attempt: RecoveryAttempt = { active: true, timedOut: false };
      const timeoutTimer = setTimeout(() => {
        attempt.timedOut = true;
        attempt.active = false;
      }, timeoutMs);
      timeoutTimer.unref?.();
      const resolveCore = async (): Promise<TaskControlRecoveryTarget> => {
        let delegation:
          | Awaited<ReturnType<typeof findStructuredParentTaskDelegation>>
          | undefined;
        const session = hostSession(options.input, options.hostClient);
        const messages =
          typeof session?.messages === 'function'
            ? session.messages.bind(session)
            : undefined;
        const parentReader =
          readers.readParentTranscript ??
          (messages
            ? () =>
                messages({
                  path: { id: parentSessionID },
                  query: { directory },
                })
            : undefined);
        let parentResponse: unknown;
        let parentReadSucceeded = false;
        if (parentReader) {
          try {
            parentResponse = await parentReader();
            if (!attempt.active)
              return timedOutTarget(key, identity, agent, timeoutMs);
            parentReadSucceeded = true;
            delegation = findStructuredParentTaskDelegation(
              parentResponse,
              parentSessionID,
              identity?.taskID ?? key,
            );
          } catch {
            delegation = undefined;
          }
        }
        if (!agent && delegation && delegation !== 'conflict')
          agent = delegation.agent;
        if (!agent || delegation === 'conflict') {
          return {
            kind: 'orphan',
            requested: key,
            taskID: identity?.taskID ?? key,
            classification: {
              kind: 'uncertain',
              taskID: identity?.taskID ?? key,
              alias: identity?.alias,
              agent,
              reason:
                delegation === 'conflict'
                  ? 'parent delegation conflicts with identity'
                  : 'exact session lacks a structured parent delegation',
            },
            reason:
              delegation === 'conflict'
                ? 'parent delegation conflicts with identity'
                : 'exact session lacks a structured parent delegation',
          };
        }

        let statusVerified = false;
        const statusReader = readers.probeStatus;
        const probeStatus = statusReader
          ? async (taskID: string, taskDirectory: string) => {
              const response = await statusReader(taskID, taskDirectory);
              if (attempt.active)
                statusVerified = hasVerifiedStatus(response, taskID);
              return response;
            }
          : undefined;

        const classification = await classifySessionRecovery({
          requested: identity ? { alias: identity.alias } : { sessionID: key },
          parentSessionID,
          agent,
          directory,
          identityIndex: options.identityIndex,
          readParentTranscript: parentReadSucceeded
            ? async () => parentResponse
            : undefined,
          readChildTranscript: readers.readChildTranscript,
          getSession: readers.getSession,
          probeStatus,
          sameProcessResumeEvidence,
          sameProcessResumeEvidenceContext: resumeEvidenceContextFor(
            identity?.taskID ?? key,
          ),
          now: options.now,
        });

        if (!attempt.active)
          return timedOutTarget(key, identity, agent, timeoutMs);
        if (!isAdoptionResult(classification)) {
          return {
            kind: 'orphan',
            requested: key,
            taskID: classification.taskID ?? identity?.taskID ?? key,
            classification,
            reason: classification.reason,
          };
        }
        const sameProcessResumeAuthorized =
          classification.kind === 'reusable' &&
          classification.evidence.resumeToken !== undefined;
        if (!statusVerified && !sameProcessResumeAuthorized) {
          return {
            kind: 'orphan',
            requested: key,
            taskID: classification.taskID ?? key,
            classification,
            reason:
              'fresh host status evidence is unavailable for safe adoption',
          };
        }
        const taskID = identity?.taskID ?? classification.taskID ?? key;
        let adoptedIdentity = identity;
        if (!adoptedIdentity && SESSION_ID_PATTERN.test(key)) {
          const reserve = options.identityIndex?.reserve;
          if (!reserve) {
            const reason =
              'verified host evidence exists, but the durable identity index is unavailable for safe adoption';
            return {
              kind: 'orphan',
              requested: key,
              taskID,
              classification,
              reason,
            };
          }
          try {
            const minimumCounter = Math.max(
              0,
              ...options.backgroundJobBoard
                .list(parentSessionID)
                .map((job) => Number(/-([1-9]\d*)$/.exec(job.alias)?.[1] ?? 0)),
            );
            const reserved = reserve(
              parentSessionID,
              taskID,
              agent,
              aliasPrefix(agent),
              minimumCounter,
            );
            if (
              !isReservedIdentity(
                reserved,
                parentSessionID,
                taskID,
                agent,
                directory,
                aliasPrefix(agent),
              )
            )
              throw new Error('identity reservation returned an invalid tuple');
            adoptedIdentity = reserved;
            if (!attempt.active)
              return timedOutTarget(key, adoptedIdentity, agent, timeoutMs);
          } catch (error) {
            return {
              kind: 'orphan',
              requested: key,
              taskID,
              classification,
              reason: `safe identity reservation failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            };
          }
        }
        const alias = adoptedIdentity?.alias;
        if (!alias) {
          return {
            kind: 'orphan',
            requested: key,
            taskID,
            classification,
            reason:
              'verified host evidence exists, but no durable alias mapping is available for safe adoption',
          };
        }
        try {
          const job = options.backgroundJobBoard.adoptExistingSession(
            {
              parentSessionID,
              taskID,
              agent,
              alias,
              description: classification.description,
              background: true,
            },
            adoptionEvidence(classification),
          );
          return { kind: 'recovered', requested: key, job, classification };
        } catch (error) {
          return {
            kind: 'orphan',
            requested: key,
            taskID,
            classification,
            reason: `safe adoption failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      };
      try {
        return await withTimeout(
          resolveCore(),
          timeoutMs,
          `Task recovery timed out after ${timeoutMs}ms`,
        );
      } catch (error) {
        if (attempt.timedOut || error instanceof OperationTimeoutError)
          return timedOutTarget(key, identity, agent, timeoutMs);
        throw error;
      } finally {
        clearTimeout(timeoutTimer);
        if (!attempt.timedOut) attempt.active = false;
      }
    },
    hasDurableOperationClaims() {
      return (
        typeof options.identityIndex?.claimOperation === 'function' &&
        typeof options.identityIndex?.settleOperation === 'function'
      );
    },
    async readLatestChildUser(taskID) {
      if (!readers.readChildTranscript) return undefined;
      let response: unknown;
      try {
        const timeoutMs = baselineReadTimeoutMs(options.baselineReadTimeoutMs);
        response = await withTimeout(
          readers.readChildTranscript(taskID),
          timeoutMs,
          `Child baseline read timed out after ${timeoutMs}ms`,
        );
      } catch {
        return undefined;
      }
      const data = responseData(response);
      if (!Array.isArray(data)) return undefined;
      let latest: ResumeClaimBaseline | undefined;
      const seen = new Set<string>();
      for (const message of data) {
        if (!isRecord(message) || !isRecord(message.info)) return undefined;
        if (
          message.info.sessionID !== undefined &&
          message.info.sessionID !== taskID
        )
          return undefined;
        if (message.info.role !== 'user') continue;
        if (message.info.synthetic === true) return undefined;
        if (
          typeof message.info.id !== 'string' ||
          !message.info.id.trim() ||
          seen.has(message.info.id)
        )
          return undefined;
        const time = isRecord(message.info.time)
          ? message.info.time.created
          : undefined;
        if (
          time !== undefined &&
          (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0)
        )
          return undefined;
        seen.add(message.info.id);
        latest = {
          childLatestUserID: message.info.id,
          ...(time === undefined ? {} : { childLatestUserCreatedAt: time }),
        };
      }
      return latest;
    },
    claimOperation(parentSessionID, taskID, operation, baseline) {
      if (!options.identityIndex?.claimOperation) return undefined;
      return options.identityIndex.claimOperation(
        parentSessionID,
        taskID,
        operation,
        baseline,
      );
    },
    markOperationSent(parentSessionID, taskID, operation, token) {
      const result = options.identityIndex?.markOperationSent?.(
        parentSessionID,
        taskID,
        operation,
        token,
      );
      return typeof result === 'boolean' ? result : undefined;
    },
    markOperationAccepted(parentSessionID, taskID, operation, token) {
      const result = options.identityIndex?.markOperationAccepted?.(
        parentSessionID,
        taskID,
        operation,
        token,
      );
      return typeof result === 'boolean' ? result : undefined;
    },
    beginOperationCompensation(parentSessionID, taskID, operation, token) {
      const result = options.identityIndex?.beginOperationCompensation?.(
        parentSessionID,
        taskID,
        operation,
        token,
      );
      return typeof result === 'boolean' ? result : undefined;
    },
    settleOperation(parentSessionID, taskID, operation, token, resolution) {
      const result =
        resolution === undefined
          ? options.identityIndex?.settleOperation?.(
              parentSessionID,
              taskID,
              operation,
              token,
            )
          : options.identityIndex?.settleOperation?.(
              parentSessionID,
              taskID,
              operation,
              token,
              resolution,
            );
      return typeof result === 'boolean' ? result : undefined;
    },
  };
  return recovery;
}
