/**
 * On-demand v1 recovery of a host child the local board no longer knows.
 *
 * Reads the host session, verifies parent and agent, classifies only the
 * latest delivered round, then imports a terminal cache row. It does not
 * scan at startup, send a prompt, or keep a recovery claim.
 */
import type { PluginInput } from '@opencode-ai/plugin';
import type { BackgroundJobLifecycle } from '../../background-jobs';
import {
  deriveFullObjective,
  deriveTaskSessionLabel,
  type RestoreRetainedSessionInput,
  STOP_CONFIRMATION_GRACE_MS,
} from '../../background-jobs';
import {
  classifyCurrentDeliveredRound,
  classifyV2HistoricalRound,
  fetchChildTranscript,
  responseError,
  stringifyError,
  type TranscriptMessage,
  transcriptOrderKey,
} from '../../utils/child-transcript';
import { isRecord } from '../../utils/guards';
import { getClient } from '../../utils/opencode-client';
import { pendingSessionPrune } from '../../utils/pending-session-prunes';
import { delay } from '../../utils/polling';
import { SESSION_ID_PATTERN, withTimeout } from '../../utils/session';
import {
  getRuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from '../../utils/session-runtime-status';
import {
  isNativeBackgroundLaunchOutput,
  parseTaskIdFromTaskOutput,
  parseTaskStatusOutput,
} from '../../utils/task';

const DEFAULT_STABLE_STOPPED_MS = 300;
/** A hung alias pairing read refuses instead of blocking the tool call. */
const ALIAS_READ_TIMEOUT_MS = 1_500;
/** Exact-ID child reads stay complete; both transcript reads refuse after 5 s.
 * Child plus parent (10 s) fit task_revive/task_cancel's 10 s budgets. */
const TRANSCRIPT_READ_TIMEOUT_MS = 5_000;
// v1 serves all history at once: 240 MB / 7-8 s at 17.6k messages.
const PARENT_READ_WINDOW = 1_000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 150;
/** Bounded wait on a GC prune that the initial host read raced (#1387). */
const PENDING_PRUNE_WAIT_MS = 2_000;

export interface ChildRef {
  parentSessionID: string;
  agent: string;
  alias: string;
  sessionID: string;
}

export type RetainedRecoveryResult =
  | { kind: 'recovered'; taskID: string }
  | { kind: 'existing'; taskID: string }
  | {
      kind: 'adoptable';
      taskID: string;
      agent: string;
      description: string;
      deletionEpoch?: number;
    }
  | {
      kind: 'refused';
      reason: string;
      reasonCode?: 'agent-unavailable' | 'host-missing';
    };

export interface RetainedRecoveryRequest {
  parentSessionID: string;
  requested: string;
  agent?: string;
  purpose?: 'revive';
  /** The upstream v1 exact-ID path, only when no transcript exists. */
  allowExactAdoption?: boolean;
  /** Explicit revive with host support for identity-bound queued inputs. */
  allowQueuedContinuation?: boolean;
}

export interface SessionRecoveryOptions {
  input: PluginInput;
  backgroundJobs: BackgroundJobLifecycle;
  isDisposed?: () => boolean;
  hostFlavor?: string;
  stableStoppedMs?: number;
  stopConfirmationBudgetMs?: number;
  statusPollIntervalMs?: number;
  liveStatusTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function unrecognizedTaskReferenceMessage(requested: string): string {
  const shown = requested.replace(/["\r\n]/g, '');
  return `The local task cache does not recognize this reference. It was not dropped; no new session was created. Call task_revive(task_id: "${shown}", prompt: "...") directly; it verifies the original host session and continues in that same session. This prompt was not sent.`;
}

export function createSessionRecovery(
  options: SessionRecoveryOptions,
): (request: RetainedRecoveryRequest) => Promise<RetainedRecoveryResult> {
  return (request) => recoverRetainedSession(options, request);
}

async function recoverRetainedSession(
  options: SessionRecoveryOptions,
  request: RetainedRecoveryRequest,
): Promise<RetainedRecoveryResult> {
  const parentSessionID = request.parentSessionID;
  const sessionID = request.requested.trim();
  const backgroundJobs = options.backgroundJobs;
  if (options.isDisposed?.()) return refuse('Session recovery was disposed');
  const prefix = `Unknown or unowned background task: ${sessionID}`;
  // Callers resolve aliases first; recovery reads exact host sessions only.
  if (!SESSION_ID_PATTERN.test(sessionID)) {
    return refuse(
      `${prefix}. Aliases do not survive a host restart; retry with the task's session ID from history or notifications, or re-dispatch the work.`,
    );
  }

  const client = getClient(options.input);
  const directory = options.input.directory;
  const { ledger } = backgroundJobs;
  const deletionEpoch = ledger.deletionEpochs.get(sessionID);
  const fenced = (): RetainedRecoveryResult | undefined => {
    if (options.isDisposed?.()) return refuse('Session recovery was disposed');
    if (ledger.deletionEpochs.get(sessionID) === deletionEpoch) return;
    return refuse(
      `Task ${sessionID} was deleted during recovery; no prompt was sent`,
    );
  };
  const appeared = (): RetainedRecoveryResult | undefined => {
    const row = backgroundJobs.get(sessionID);
    if (!row) return;
    if (row.parentSessionID === parentSessionID) {
      return { kind: 'existing', taskID: row.taskID };
    }
    return refuse(
      `Task ${sessionID} belongs to a different parent session; no prompt was sent`,
    );
  };
  let hosted = await readHostSession(client, directory, sessionID);
  if (hosted.kind === 'ok') {
    // A GC prune that this read raced can still be in flight; settling it
    // (bounded) and re-reading keeps adoption from racing the delete. The
    // fence sits before the parent check so cancel and revive both benefit.
    const prune = pendingSessionPrune(sessionID);
    if (prune) {
      try {
        await withTimeout(
          prune,
          PENDING_PRUNE_WAIT_MS,
          'pending session prune timed out',
        );
      } catch {
        return refuse(
          `${prefix}. A host-session prune is in progress for this task; retry task_revive.`,
        );
      }
      hosted = await readHostSession(client, directory, sessionID);
    }
  }
  const generic = `${prefix}. Tracking does not survive a host restart; verify whether the host restored it before re-dispatching.`;
  if (hosted.kind !== 'ok') {
    if (request.purpose !== 'revive') return hosted;
    // Only a confirmed host 404 may touch the tombstone: a transient
    // read failure is no evidence the session is gone, and consuming the
    // one-shot tombstone on it would destroy the only remaining evidence.
    if (hosted.kind !== 'refused' || hosted.reasonCode !== 'host-missing') {
      return refuse(generic);
    }
    // The tombstone carries no parentID, so full-result delivery here
    // would leak a child's result to any raw-ID caller; verify the caller
    // actually delegated this task, then name the ending only and point
    // at this session's transcript (#1387 P2).
    const stop = fenced();
    if (stop) return stop;
    const tombstone = backgroundJobs.suppressionTombstone(sessionID);
    if (tombstone) {
      let transcript: unknown;
      try {
        transcript = await readParentTranscript(
          client,
          directory,
          parentSessionID,
          options.hostFlavor,
        );
      } catch {
        return refuse(generic);
      }
      // Positive evidence only: a pairing visible in the returned window
      // proves this parent delegated, even when an overflowing v1 window
      // or v2 compaction marks the page incomplete. An absent pairing
      // fails closed regardless of completeness — hidesHistory guards
      // uniqueness claims (alias resolution), not existence ones.
      const owned =
        parentDelegation(
          parentTaskParts(transcript),
          parentSessionID,
          sessionID,
        ) !== undefined;
      if (!owned) return refuse(generic);
      backgroundJobs.clearSuppression(sessionID);
      if (tombstone.terminalState !== undefined) {
        const ending =
          tombstone.terminalState === 'completed'
            ? 'completed'
            : `ended in state ${tombstone.terminalState}`;
        return refuse(
          `${prefix}. The session ${ending} and is no longer available on the host; its task record was evicted afterward. Check this session's transcript for its result before re-dispatching.`,
        );
      }
      // No terminal state was recorded (stopped eviction or drop): name
      // only what is known — deliberately untracked and host-absent.
      return refuse(
        `${prefix}. This session is deliberately no longer tracked and is no longer available on the host; its task record was evicted afterward. Check this session's transcript before re-dispatching; no prompt was sent.`,
      );
    }
    return refuse(generic);
  }
  if (hosted.parentID !== parentSessionID) {
    if (request.purpose === 'revive') return refuse(generic);
    return refuse(
      `Task ${sessionID} belongs to a different parent session; no prompt was sent`,
    );
  }
  const raced = fenced() ?? appeared();
  if (raced) return raced;

  // #1388's live gate and persisted-result behavior precede any import.
  if (request.purpose === 'revive' && options.hostFlavor !== 'v2') {
    const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
      timeoutMs: options.liveStatusTimeoutMs ?? 1_500,
    });
    const liveStatus = snapshot.statuses.get(sessionID);
    if (liveStatus === 'busy' || liveStatus === 'retry') {
      return refuse(
        `${prefix}. The host is executing that session (it may have been restored after a restart); its result is still delivered on completion — do not re-dispatch.`,
      );
    }
    if (
      snapshot.error !== undefined ||
      snapshot.malformedSessionIDs.has(sessionID)
    ) {
      return refuse(
        `${prefix}. The host could not confirm the session state (${snapshot.error ?? 'malformed entry'}); retry task_revive.`,
      );
    }
    const stop = fenced();
    if (stop) return stop;
    const tombstone = backgroundJobs.suppressionTombstone(sessionID);
    if (tombstone?.terminalState !== undefined && tombstone.resultSummary) {
      backgroundJobs.clearSuppression(sessionID);
      const ending =
        tombstone.terminalState === 'completed'
          ? 'completed'
          : `ended in state ${tombstone.terminalState}`;
      return refuse(
        `${prefix}. The session ${ending} before the tracking loss; its recorded result: ${tombstone.resultSummary}. Re-dispatch only if this result does not satisfy the objective.`,
      );
    }
  }

  const transcriptSourceAvailable =
    typeof client.session?.messages === 'function';
  const unreadable = (error: unknown) =>
    refuse(
      `Task ${sessionID} transcript could not be read (${stringifyError(error)}); no prompt was sent`,
    );
  let childTranscript: unknown;
  try {
    childTranscript = await withTimeout(
      fetchChildTranscript(client, sessionID, directory),
      TRANSCRIPT_READ_TIMEOUT_MS,
      'child transcript read timed out',
    );
  } catch (error) {
    return unreadable(error);
  }
  // v1 SDK shape of a session without messages (fetch throws on error).
  const noTranscript =
    !transcriptSourceAvailable ||
    (isRecord(childTranscript) &&
      Array.isArray(childTranscript.data) &&
      childTranscript.data.length === 0 &&
      !hidesHistory(childTranscript));
  if (
    noTranscript &&
    request.purpose === 'revive' &&
    request.allowExactAdoption &&
    options.hostFlavor !== 'v2'
  ) {
    // Explicit upstream fallback, never a fallback from an evidence refusal.
    let parentTranscript: unknown;
    try {
      parentTranscript = await readParentTranscript(
        client,
        directory,
        parentSessionID,
        options.hostFlavor,
      );
    } catch (error) {
      return unreadable(error);
    }
    const agent = resolveAgent({
      sessionID,
      sessionAgent: hosted.agent,
      childTranscript,
      parentParts: parentTaskParts(parentTranscript),
      parentSessionID,
    });
    if (agent.kind === 'refused' && agent.reasonCode !== 'agent-unavailable')
      return agent;
    const stop = fenced();
    if (stop) return stop;
    return {
      kind: 'adoptable',
      taskID: sessionID,
      agent: agent.kind === 'ok' ? agent.agent : 'unknown',
      description: hosted.title
        ? `recovered: ${hosted.title}`
        : 'recovered background task',
      deletionEpoch,
    };
  }
  if (childTranscript === undefined) {
    return refuse(
      `Task ${sessionID} transcript could not be read (transcript source unavailable); no prompt was sent`,
    );
  }
  const round =
    options.hostFlavor === 'v2'
      ? classifyV2HistoricalRound(childTranscript)
      : classifyCurrentDeliveredRound(childTranscript);
  if (round.verdict === 'unreadable') {
    return refuse(
      `Task ${sessionID} transcript could not be classified (${round.reason ?? 'unreadable'}); no prompt was sent`,
    );
  }
  const queueContinuation =
    options.hostFlavor === 'v2' &&
    request.purpose === 'revive' &&
    request.allowQueuedContinuation === true;
  if (
    options.hostFlavor === 'v2' &&
    round.verdict === 'incomplete' &&
    !queueContinuation
  ) {
    return refuse(
      `Task ${sessionID} has no verified historical terminal after its latest input. The current round was not imported. No prompt was sent`,
    );
  }

  let parentTranscript: unknown;
  try {
    parentTranscript = await readParentTranscript(
      client,
      directory,
      parentSessionID,
      options.hostFlavor,
    );
  } catch (error) {
    return unreadable(error);
  }
  const parentParts = parentTaskParts(parentTranscript);
  const agent = resolveAgent({
    sessionID,
    sessionAgent: hosted.agent,
    childTranscript,
    parentParts,
    parentSessionID,
  });
  if (agent.kind !== 'ok') return agent;
  if (request.agent && request.agent !== agent.agent) {
    return refuse(
      `Task ${sessionID} agent is ${agent.agent}, not ${request.agent}. No prompt was sent`,
    );
  }

  if (queueContinuation) {
    if (options.isDisposed?.()) return refuse('Session recovery was disposed');
    if (ledger.deletionEpochs.get(sessionID) !== deletionEpoch) {
      return refuse(
        `Task ${sessionID} was deleted during recovery; no prompt was sent`,
      );
    }
    // Historical terminals do not establish live idle. Return verified
    // identity only; task_revive owns the lease and the new input generation.
    return {
      kind: 'adoptable',
      taskID: sessionID,
      agent: agent.agent,
      description: hosted.title
        ? `recovered: ${hosted.title}`
        : `recovered ${agent.agent} session`,
      deletionEpoch,
    };
  }

  const alias = hidesHistory(parentTranscript)
    ? undefined
    : trustedAliasForSession(parentParts, parentSessionID, sessionID);
  const delegation = parentDelegation(parentParts, parentSessionID, sessionID);
  const cancelMatched =
    round.startedAt !== undefined &&
    parentCancelMatchesRound(parentTranscript, sessionID, round.startedAt);

  let state: RestoreRetainedSessionInput['state'];
  if (round.verdict === 'completed' && !cancelMatched) state = 'completed';
  else if (round.verdict === 'error') state = 'error';
  else if (cancelMatched) state = 'cancelled';
  else state = 'stopped';

  const quiescent =
    options.hostFlavor === 'v2'
      ? { kind: 'ok' as const }
      : await confirmQuiescence(options, sessionID, state === 'stopped');
  if (quiescent.kind === 'refused') return quiescent;
  const again = fenced() ?? appeared();
  if (again) return again;

  const descriptionSource = delegation?.description;
  const promptSource = delegation?.prompt;
  const description = deriveTaskSessionLabel({
    description: descriptionSource,
    prompt: promptSource,
    agentType: agent.agent,
  });
  const objective = deriveFullObjective({
    description: descriptionSource,
    prompt: promptSource,
  });
  const launchedAt = round.startedAt ?? hosted.createdAt;
  const restored = backgroundJobs.restoreRetainedSession({
    taskID: sessionID,
    parentSessionID,
    agent: agent.agent,
    description:
      descriptionSource || promptSource
        ? description
        : `recovered ${agent.agent} session`,
    ...(objective !== undefined ? { objective } : {}),
    state,
    background: delegation?.background === true,
    ...(state === 'completed' && round.text !== undefined
      ? { resultSummary: round.text }
      : state === 'error' && round.text !== undefined
        ? { resultSummary: round.text }
        : state === 'cancelled'
          ? { resultSummary: 'cancelled' }
          : {
              resultSummary:
                'Recovered retained session stopped before a terminal result.',
            }),
    ...(alias !== undefined ? { alias } : {}),
    ...(launchedAt !== undefined ? { launchedAt } : {}),
    ...(state === 'completed' && round.completedAt !== undefined
      ? { completedAt: round.completedAt }
      : {}),
  });
  if (!restored) {
    const existing = backgroundJobs.resolve(parentSessionID, sessionID);
    if (existing) return { kind: 'existing', taskID: existing.taskID };
    return refuse(
      `Task ${sessionID} could not be imported without overwriting a newer row or lease; no prompt was sent`,
    );
  }
  return { kind: 'recovered', taskID: restored.taskID };
}

function refuse(reason: string): RetainedRecoveryResult {
  return { kind: 'refused', reason };
}

async function confirmQuiescence(
  options: SessionRecoveryOptions,
  sessionID: string,
  requireStableStop: boolean,
): Promise<{ kind: 'ok' } | RetainedRecoveryResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const stableMs = Math.max(
    0,
    options.stableStoppedMs ?? DEFAULT_STABLE_STOPPED_MS,
  );
  const budget = Math.max(
    0,
    options.stopConfirmationBudgetMs ?? STOP_CONFIRMATION_GRACE_MS,
  );
  const interval = Math.max(
    0,
    options.statusPollIntervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS,
  );
  const deadline = now() + (requireStableStop ? budget : 0);
  let stableSince: number | undefined;
  for (;;) {
    if (options.isDisposed?.()) return refuse('Session recovery was disposed');
    const read = await readLiveStatus(options.input, sessionID);
    if (read.kind !== 'quiescent') return read;
    if (!requireStableStop) return { kind: 'ok' };
    const clock = now();
    stableSince ??= clock;
    if (clock - stableSince >= stableMs) return { kind: 'ok' };
    if (clock >= deadline) {
      return refuse(
        `Task ${sessionID} did not stay stopped long enough to recover; no prompt was sent`,
      );
    }
    await sleep(Math.min(interval, Math.max(0, deadline - clock)));
  }
}

async function readLiveStatus(
  input: PluginInput,
  sessionID: string,
): Promise<{ kind: 'quiescent' } | RetainedRecoveryResult> {
  const snapshot = await getRuntimeSessionStatusSnapshot(input);
  if (
    snapshot.error !== undefined ||
    snapshot.malformedSessionIDs.has(sessionID)
  ) {
    return refuse(
      `Task ${sessionID} could not be verified against the live session map (${snapshot.error ?? 'malformed entry'}); no prompt was sent`,
    );
  }
  const status = runtimeSessionStatus(snapshot, sessionID);
  if (status === 'busy' || status === 'retry') {
    return refuse(
      `Task ${sessionID} is executing at the host (live status: ${status}); it was not imported and no prompt was sent`,
    );
  }
  if (status === 'idle' || status === undefined) return { kind: 'quiescent' };
  return refuse(
    `Task ${sessionID} could not be verified against the live session map (unrecognized status); no prompt was sent`,
  );
}

interface HostSession {
  kind: 'ok';
  parentID: string;
  agent?: string;
  createdAt?: number;
  title?: string;
}

async function readHostSession(
  client: PluginInput['client'],
  directory: string,
  sessionID: string,
): Promise<HostSession | RetainedRecoveryResult> {
  const session = client.session;
  if (typeof session?.get !== 'function') {
    return refuse(
      `Task ${sessionID} could not be read (session.get unavailable); no prompt was sent`,
    );
  }
  try {
    const response = await session.get({
      path: { id: sessionID },
      query: { directory },
    });
    const error = responseError(response);
    if (error !== undefined) return sessionReadRefusal(sessionID, error);
    const rawData = isRecord(response) ? response.data : undefined;
    const data = isRecord(rawData)
      ? (rawData as Record<string, unknown>)
      : undefined;
    const parentID =
      typeof data?.parentID === 'string' ? data.parentID : undefined;
    if (data?.id !== undefined && data.id !== sessionID) {
      return refuse(
        `Task ${sessionID} could not be read (session ID mismatch); no prompt was sent`,
      );
    }
    if (!parentID) {
      return refuse(
        `Task ${sessionID} could not be read (missing parent); no prompt was sent`,
      );
    }
    const agent =
      typeof data?.agent === 'string' ? data.agent.trim() : undefined;
    const createdAt =
      isRecord(data?.time) && typeof data.time.created === 'number'
        ? data.time.created
        : undefined;
    return {
      kind: 'ok',
      parentID,
      ...(agent ? { agent } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(typeof data?.title === 'string' && data.title
        ? { title: data.title }
        : {}),
    };
  } catch (error) {
    return sessionReadRefusal(sessionID, error);
  }
}

/** A not-found/404 is positive evidence the host session is gone
 * (`host-missing`); any other failure is a transient read problem and
 * carries no reason code, so callers never treat it as absence. */
function sessionReadRefusal(
  sessionID: string,
  error: unknown,
): RetainedRecoveryResult {
  const text = stringifyError(error);
  if (/not\s*found|\b404\b/i.test(text)) {
    return {
      kind: 'refused',
      reason: `Task ${sessionID} was not found on the host; no prompt was sent`,
      reasonCode: 'host-missing',
    };
  }
  return refuse(
    `Task ${sessionID} could not be read (${text}); no prompt was sent`,
  );
}

async function readParentTranscript(
  client: PluginInput['client'],
  directory: string,
  parentSessionID: string,
  hostFlavor: string | undefined,
  timeoutMs = TRANSCRIPT_READ_TIMEOUT_MS,
): Promise<unknown> {
  // A failed read is no evidence; a held one rejects at the deadline.
  const limit = hostFlavor === 'v2' ? undefined : PARENT_READ_WINDOW + 1;
  const transcript = await withTimeout(
    fetchChildTranscript(client, parentSessionID, directory, limit).catch(
      () => undefined,
    ),
    timeoutMs,
    'parent transcript read timed out',
  );
  return limit !== undefined &&
    isRecord(transcript) &&
    Array.isArray(transcript.data) &&
    (transcript.data.length > PARENT_READ_WINDOW ||
      (transcript.response as Response | undefined)?.headers?.has?.(
        'x-next-cursor',
      ))
    ? { ...transcript, page: { complete: false } }
    : transcript;
}

interface AgentDecision {
  kind: 'ok';
  agent: string;
}

function resolveAgent(input: {
  sessionID: string;
  sessionAgent?: string;
  childTranscript: unknown;
  parentParts: ParentTaskPart[];
  parentSessionID: string;
}): AgentDecision | RetainedRecoveryResult {
  const child = latestChildUserAgent(input.childTranscript);
  const parent = newestParentAgent(
    input.parentParts,
    input.parentSessionID,
    input.sessionID,
  );
  if (parent === 'conflict') {
    return refuse(
      `Task ${input.sessionID} agent evidence conflicts; no prompt was sent`,
    );
  }
  const chosen = preferNewerAgent(child, parent);
  if (chosen === 'conflict') {
    return refuse(
      `Task ${input.sessionID} agent evidence conflicts; no prompt was sent`,
    );
  }
  const agent = chosen?.agent ?? input.sessionAgent;
  if (!agent) {
    return {
      kind: 'refused',
      reason: `Task ${input.sessionID} agent could not be verified; no prompt was sent`,
      reasonCode: 'agent-unavailable',
    };
  }
  if (input.sessionAgent && input.sessionAgent !== agent) {
    return refuse(
      `Task ${input.sessionID} agent evidence conflicts; no prompt was sent`,
    );
  }
  return { kind: 'ok', agent };
}

interface TimedAgent {
  agent: string;
  at?: number;
}

function preferNewerAgent(
  left: TimedAgent | undefined,
  right: TimedAgent | undefined,
): TimedAgent | 'conflict' | undefined {
  if (!left) return right;
  if (!right) return left;
  if (left.agent === right.agent) {
    return (left.at ?? -1) >= (right.at ?? -1) ? left : right;
  }
  if (left.at === undefined || right.at === undefined || left.at === right.at) {
    return 'conflict';
  }
  return left.at > right.at ? left : right;
}

function latestChildUserAgent(transcript: unknown): TimedAgent | undefined {
  if (!isRecord(transcript) || !Array.isArray(transcript.data))
    return undefined;
  const messages: TranscriptMessage[] = transcript.data.filter(isRecord);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const rawInfo = message ? message.info : undefined;
    if (!isRecord(rawInfo) || rawInfo.role !== 'user') continue;
    const agent = typeof rawInfo.agent === 'string' ? rawInfo.agent.trim() : '';
    if (!agent) return undefined;
    return { agent, at: transcriptOrderKey(message) };
  }
  return undefined;
}

function newestParentAgent(
  parts: ParentTaskPart[],
  parentSessionID: string,
  sessionID: string,
): TimedAgent | 'conflict' | undefined {
  let chosen: TimedAgent | undefined;
  for (const pairing of parts) {
    if (pairing.sessionID !== sessionID || !pairing.agent) continue;
    if (pairing.ref && pairing.ref.parentSessionID !== parentSessionID)
      continue;
    if (pairing.ref && pairing.ref.agent !== pairing.agent) continue;
    const next = { agent: pairing.agent, at: pairing.at };
    const preferred = preferNewerAgent(chosen, next);
    if (preferred === 'conflict') return 'conflict';
    chosen = preferred;
  }
  return chosen;
}

interface ParentTaskPart {
  sessionID: string;
  agent?: string;
  at?: number;
  description?: string;
  prompt?: string;
  background?: boolean;
  ref?: ChildRef;
}

function parentDelegation(
  parts: ParentTaskPart[],
  parentSessionID: string,
  sessionID: string,
): ParentTaskPart | undefined {
  let chosen: ParentTaskPart | undefined;
  for (const pairing of parts) {
    if (pairing.sessionID !== sessionID) continue;
    if (pairing.ref && pairing.ref.parentSessionID !== parentSessionID)
      continue;
    if (!chosen || (pairing.at ?? -1) >= (chosen.at ?? -1)) chosen = pairing;
  }
  return chosen;
}

/** Sessions each marked alias was paired with in this parent's history. */
function aliasTargets(
  parts: ParentTaskPart[],
  parentSessionID: string,
): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  for (const { ref, agent } of parts) {
    if (!ref || ref.parentSessionID !== parentSessionID) continue;
    if (agent && ref.agent !== agent) continue;
    const sessions = targets.get(ref.alias) ?? new Set<string>();
    targets.set(ref.alias, sessions.add(ref.sessionID));
  }
  return targets;
}

/** v2 compaction or an overflowing v1 window can hide older pairings,
 * so no visible pairing proves an alias unique. */
function hidesHistory(transcript: unknown): boolean {
  return (
    isRecord(transcript) &&
    isRecord(transcript.page) &&
    transcript.page.complete === false
  );
}

/** The one alias paired only with this session, if any. */
function trustedAliasForSession(
  parts: ParentTaskPart[],
  parentSessionID: string,
  sessionID: string,
): string | undefined {
  const owned = [...aliasTargets(parts, parentSessionID)].filter(
    ([, sessions]) => sessions.has(sessionID),
  );
  const [alias, sessions] = owned[0] ?? [];
  return owned.length === 1 && sessions?.size === 1 ? alias : undefined;
}

function parentCancelMatchesRound(
  transcript: unknown,
  sessionID: string,
  roundStartedAt: number,
): boolean {
  if (!isRecord(transcript) || !Array.isArray(transcript.data)) return false;
  for (const message of transcript.data) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isRecord(part) || part.type !== 'tool') continue;
      if (delegationToolName(part) !== 'task_cancel') continue;
      const state = isRecord(part.state) ? part.state : undefined;
      // The argument may be an alias; the output header names the task.
      const result = parseTaskStatusOutput(toolResultText(state));
      if (result?.taskID !== sessionID || result.state !== 'cancelled')
        continue;
      const at =
        partEvidenceTime(part, state) ??
        transcriptOrderKey(message as TranscriptMessage);
      if (at !== undefined && at >= roundStartedAt) return true;
    }
  }
  return false;
}

function parentTaskParts(transcript: unknown): ParentTaskPart[] {
  if (!isRecord(transcript) || !Array.isArray(transcript.data)) return [];
  const pairings: ParentTaskPart[] = [];
  for (const message of transcript.data) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isRecord(part) || part.type !== 'tool') continue;
      const toolName = delegationToolName(part);
      if (toolName !== 'task' && toolName !== 'subagent') continue;
      const state = isRecord(part.state) ? part.state : undefined;
      const output = toolResultText(state);
      const outerID = output ? parseTaskIdFromTaskOutput(output) : undefined;
      if (!outerID) continue;
      const taskInput = isRecord(state?.input) ? state.input : undefined;
      const explicitID =
        stringField(taskInput?.task_id) ?? stringField(taskInput?.sessionID);
      if (explicitID && explicitID !== outerID) continue;
      const agent =
        stringField(taskInput?.subagent_type) ?? stringField(taskInput?.agent);
      const ref = output ? readAuthoritativeChildRef(output) : undefined;
      if (ref && ref.sessionID !== outerID) continue;
      pairings.push({
        sessionID: outerID,
        ...(agent ? { agent } : {}),
        ...(ref ? { ref } : {}),
        at:
          partEvidenceTime(part, state) ??
          transcriptOrderKey(message as TranscriptMessage),
        ...(typeof taskInput?.description === 'string'
          ? { description: taskInput.description }
          : {}),
        ...(typeof taskInput?.prompt === 'string'
          ? { prompt: taskInput.prompt }
          : {}),
        ...(taskInput?.background === true ? { background: true } : {}),
      });
    }
  }
  return pairings;
}

export function appendChildRefSuffix(output: string, ref: ChildRef): string {
  const existing = readAuthoritativeChildRef(output);
  if (existing) return output;
  return `${output}\n${formatChildRef(ref)}`;
}

export function readAuthoritativeChildRef(
  output: string,
): ChildRef | undefined {
  const close = lastOuterClose(output);
  // Tagged outputs trust the marker right after the outer close tag. A
  // native background launch has no close tag: the marker is trusted only
  // as its final non-empty line. Other untagged outputs (e.g. `Subagent
  // failed (...)`) can end in child-reported text, so they carry none.
  const tail = close
    ? output.slice(close.end).trim()
    : isNativeBackgroundLaunchOutput(output)
      ? lastNonEmptyLine(output)
      : undefined;
  if (tail === undefined) return undefined;
  const match = /^<!-- slim-child-ref:v1 (\{.*\}) -->$/.exec(tail);
  if (!match?.[1]) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  if (!isChildRef(parsed)) return undefined;
  const outerID = parseTaskIdFromTaskOutput(output);
  if (!outerID || outerID !== parsed.sessionID) return undefined;
  return parsed;
}

/** The final non-empty line of `output`, trimmed; undefined when blank. */
function lastNonEmptyLine(output: string): string | undefined {
  const trimmed = output.trimEnd();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(trimmed.lastIndexOf('\n') + 1).trim();
}

function formatChildRef(ref: ChildRef): string {
  return `<!-- slim-child-ref:v1 ${JSON.stringify({
    parentSessionID: ref.parentSessionID,
    agent: ref.agent,
    alias: ref.alias,
    sessionID: ref.sessionID,
  })} -->`;
}

function isChildRef(value: unknown): value is ChildRef {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'agent,alias,parentSessionID,sessionID') return false;
  return [
    value.parentSessionID,
    value.agent,
    value.alias,
    value.sessionID,
  ].every((field) => stringField(field) !== undefined);
}

/** Start and end of the last outer close tag. */
function lastOuterClose(
  output: string,
): { start: number; end: number } | undefined {
  // ASCII only: full lowercasing can change length (İ) and shift offsets.
  const lower = output.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());
  let close: { start: number; end: number } | undefined;
  for (const tag of [
    '</task>',
    '</subagent>',
    '</task_result>',
    '</task_error>',
  ]) {
    const start = lower.lastIndexOf(tag);
    const end = start + tag.length;
    if (start >= 0 && end > (close?.end ?? -1)) close = { start, end };
  }
  return close;
}

function delegationToolName(part: Record<string, unknown>): string | undefined {
  return stringField(part.tool) ?? stringField(part.name);
}

function toolResultText(state: Record<string, unknown> | undefined): string {
  if (!state) return '';
  if (typeof state.output === 'string' && state.output.length > 0) {
    return state.output;
  }
  if (!Array.isArray(state.content)) return '';
  return state.content
    .filter(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) &&
        entry.type === 'text' &&
        typeof entry.text === 'string',
    )
    .map((entry) => entry.text as string)
    .join('');
}

function partEvidenceTime(
  part: Record<string, unknown>,
  state: Record<string, unknown> | undefined,
): number | undefined {
  return finiteToolTime(part.time) ?? finiteToolTime(state?.time);
}

function finiteToolTime(time: unknown): number | undefined {
  if (!isRecord(time)) return undefined;
  for (const key of ['completed', 'end', 'ran', 'start', 'created'] as const) {
    const value = time[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export type CanonicalTaskReference =
  | { kind: 'exact'; taskID: string }
  | { kind: 'refused'; reason: string };

export interface AliasAuthority {
  resolveCanonical(
    parentSessionID: string,
    requested: string,
  ): Promise<CanonicalTaskReference>;
}

export function aliasUnverifiedMessage(alias: string): string {
  return `Alias ${alias} could not be verified from host history. No action was sent. Use the exact session id.`;
}

export function aliasUnpairedMessage(alias: string): string {
  return `Alias ${alias} has no saved host pairing. No action was sent. Use the exact session id.`;
}

export function aliasMultipleTargetsMessage(
  alias: string,
  sessions: readonly string[],
): string {
  return `Alias ${alias} matches multiple saved targets: ${[...sessions].sort().join(', ')}. No action was sent. Use the exact session id.`;
}

/** Model-visible degrade note. Stays before the outer close so the child-ref tail is unchanged. */
export function noteExactSessionAlias(output: string, taskID: string): string {
  const note = `Refer by the exact session id ${taskID}.`;
  const close = lastOuterClose(output);
  if (!close) return `${output}\n${note}`;
  return `${output.slice(0, close.start)}${note}\n${output.slice(close.start)}`;
}

export function pluginDisposedMessage(): string {
  return 'The plugin instance was disposed. No action was sent.';
}

export function createAliasAuthority(options: {
  input: PluginInput;
  board: BackgroundJobLifecycle;
  isDisposed?: () => boolean;
}): AliasAuthority {
  /** Exact IDs and board aliases resolve locally; otherwise one bounded
   * parent read must pair the alias's marked outputs with one session. */
  async function resolveCanonical(
    parentSessionID: string,
    requested: string,
  ): Promise<CanonicalTaskReference> {
    const alias = requested.trim();
    if (SESSION_ID_PATTERN.test(alias)) {
      return { kind: 'exact', taskID: alias };
    }
    const known = options.board.resolve(parentSessionID, alias);
    if (known) return { kind: 'exact', taskID: known.taskID };
    if (options.isDisposed?.()) {
      return { kind: 'refused', reason: pluginDisposedMessage() };
    }
    const transcript = await readParentTranscript(
      getClient(options.input),
      options.input.directory,
      parentSessionID,
      (options.input as { hostFlavor?: string }).hostFlavor,
      ALIAS_READ_TIMEOUT_MS,
    ).catch(() => undefined);
    if (
      !isRecord(transcript) ||
      !Array.isArray(transcript.data) ||
      hidesHistory(transcript)
    ) {
      return { kind: 'refused', reason: aliasUnverifiedMessage(alias) };
    }
    const parts = parentTaskParts(transcript);
    const sessions = [
      ...(aliasTargets(parts, parentSessionID).get(alias) ?? []),
    ];
    if (sessions.length === 1 && sessions[0]) {
      return { kind: 'exact', taskID: sessions[0] };
    }
    return {
      kind: 'refused',
      reason:
        sessions.length === 0
          ? aliasUnpairedMessage(alias)
          : aliasMultipleTargetsMessage(alias, sessions),
    };
  }

  return { resolveCanonical };
}
