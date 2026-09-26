import type { BackgroundJobAdoptionEvidence } from '../../utils/background-job-board';
import type { BackgroundJobIdentity } from '../../utils/background-job-identity-index';
import { classifyTerminalEvidence } from '../../utils/child-transcript';
import { isRecord } from '../../utils/guards';
import { INTERNAL_INITIATOR_METADATA_KEY } from '../../utils/internal-initiator';
import type {
  SameProcessResumeEvidenceBroker,
  SameProcessResumeEvidenceToken,
} from '../../utils/same-process-resume-evidence';
import {
  parseTaskIdFromTaskOutput,
  parseTaskStatusOutput,
  type TaskStatusOutput,
} from '../../utils/task';
import {
  isMessageWithParts,
  type MessagePart,
  type MessageWithParts,
} from '../types';

type RecoveryFields = {
  taskID?: string;
  alias?: string;
  agent?: string;
  description?: string;
};

/** Terminal completedAt comes from the v1 child's final assistant turn, a
 * bounded host idle transition, or the v2 native completed tool's end time.
 * pendingAcknowledgement may mean the terminal notice itself is missing. */
export type SessionRecoveryResult = RecoveryFields &
  (
    | {
        kind: 'live';
        evidence: Extract<BackgroundJobAdoptionEvidence, { kind: 'live' }> & {
          status: 'busy' | 'retry';
        };
      }
    | {
        kind: 'reusable';
        resumeToken?: SameProcessResumeEvidenceToken;
        evidence: Extract<
          BackgroundJobAdoptionEvidence,
          { kind: 'terminal' }
        > & {
          acknowledged: true;
          /** Present only when same-process, statusless-v2 evidence was
           * authorized for this exact terminal publication. */
          resumeToken?: SameProcessResumeEvidenceToken;
        };
      }
    | {
        kind: 'stopped';
        evidence: Extract<BackgroundJobAdoptionEvidence, { kind: 'stopped' }>;
      }
    | {
        kind: 'uncertain';
        reason: string;
        /** Child terminal text is known, but parent confirmation is missing.
         * A matching task_result can confirm by itself. A synthetic notice
         * still needs a later completed parent turn. */
        pendingAcknowledgement?: Extract<
          BackgroundJobAdoptionEvidence,
          { kind: 'terminal' }
        > & { acknowledged: false };
      }
    | { kind: 'missing'; reason: string }
  );

export type SameProcessResumeEvidenceContext = Readonly<{
  generation: number;
  terminalRevision: number;
}>;

export type SessionRecoveryRequest = {
  requested: { alias: string } | { sessionID: string };
  parentSessionID: string;
  agent: string;
  directory: string;
  identityIndex?: {
    lookup(
      parentSessionID: string,
      key: string,
    ): BackgroundJobIdentity | undefined;
  };
  readParentTranscript?: () => Promise<unknown>;
  readChildTranscript?: (sessionID: string) => Promise<unknown>;
  getSession?: (sessionID: string, directory: string) => Promise<unknown>;
  /** The SDK session.status response, not an inferred list of idle sessions. */
  probeStatus?: (sessionID: string, directory: string) => Promise<unknown>;
  /** Process-local evidence gate for statusless v2 terminal reuse. */
  sameProcessResumeEvidence?: SameProcessResumeEvidenceBroker;
  /** Board-owned identity for the terminal publication being classified.
   * The classifier only reads this tuple; it never mutates the board. */
  sameProcessResumeEvidenceContext?: SameProcessResumeEvidenceContext;
  now?: () => number;
};

export type StructuredParentTaskDelegation = {
  taskID: string;
  agent: string;
  description?: string;
  messageIndex: number;
};

function notFound(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error._tag === 'Session.NotFoundError' || error.name === 'NotFoundError')
  );
}

type TaskPart = {
  status: TaskStatusOutput;
  description?: string;
  observedAt?: number;
  resultAt?: number;
  messageIndex: number;
};

type ParentDelegation = { part: TaskPart; messages: MessageWithParts[] };

type ParentTaskCandidate = {
  part: TaskPart;
  agent: string;
};

type ParentTaskTranscript = {
  messages: MessageWithParts[];
  candidates: ParentTaskCandidate[];
};

function isTaskToolPart(part: MessagePart): boolean {
  return (
    part.type === 'tool' &&
    (part.tool === 'task' ||
      part.name === 'task' ||
      part.tool === 'subagent' ||
      part.name === 'subagent')
  );
}

/** Host SchemaError text, or the object form used in tests. Only a missing
 * description is a pre-dispatch refusal; other schema failures are not. */
function missingDescriptionSchemaError(error: unknown): boolean {
  const text =
    typeof error === 'string'
      ? error
      : isRecord(error) &&
          error.name === 'SchemaError' &&
          typeof error.message === 'string'
        ? `SchemaError ${error.message}`
        : undefined;
  return (
    text !== undefined &&
    /SchemaError/.test(text) &&
    /description/i.test(text) &&
    /(missing|required)/i.test(text)
  );
}

/** A refused resume that did not admit a prompt does not end the
 * acknowledgement turn. Plugin pre-dispatch errors say "no new session
 * was created" or "resume blocked". A missing-description SchemaError is
 * the same class. Any other task()/subagent() call still ends the turn. */
function refusedTaskCreatedNoSession(part: MessagePart): boolean {
  if (!isTaskToolPart(part) || !isRecord(part.state)) return false;
  if (part.state.status !== 'error') return false;
  const error = part.state.error;
  const output = part.state.output;
  const text = `${typeof error === 'string' ? error : ''}\n${
    typeof output === 'string' ? output : ''
  }`.toLowerCase();
  return (
    text.includes('no new session was created') ||
    text.includes('resume blocked') ||
    missingDescriptionSchemaError(error) ||
    missingDescriptionSchemaError(part.error)
  );
}

/** The host writes the call being executed as running or pending before
 * tool.execute.before. That part has not admitted a prompt yet. */
function inFlightTaskPart(part: MessagePart): boolean {
  if (!isTaskToolPart(part) || !isRecord(part.state)) return false;
  return part.state.status === 'running' || part.state.status === 'pending';
}

/** A sibling read, bash, or grep can still be pending while task() starts.
 * It has not failed, so it does not cancel a retrieved result. */
function inFlightOrdinaryTool(part: MessagePart): boolean {
  if (part.type !== 'tool' || isTaskToolPart(part) || !isRecord(part.state))
    return false;
  if (part.error != null || part.state.error != null) return false;
  const status = part.state.status;
  return status === 'pending' || status === 'running';
}

function taskPartEndsTurn(part: MessagePart): boolean {
  return (
    isTaskToolPart(part) &&
    !refusedTaskCreatedNoSession(part) &&
    !inFlightTaskPart(part)
  );
}

function toolOutput(part: MessagePart): string | undefined {
  if (!isRecord(part.state)) return;
  const content = part.state.content;
  return typeof part.state.output === 'string'
    ? part.state.output
    : Array.isArray(content) &&
        content.length === 1 &&
        isRecord(content[0]) &&
        content[0].type === 'text' &&
        typeof content[0].text === 'string'
      ? content[0].text
      : undefined;
}

/** Validate and collect every structured delegation for one exact child ID. */
function parentTaskTranscript(
  response: unknown,
  parentSessionID: string,
  taskID: string,
): ParentTaskTranscript | 'conflict' | undefined {
  if (
    !isRecord(response) ||
    response.error != null ||
    !Array.isArray(response.data)
  )
    return;
  if (response.data.some((message) => !isMessageWithParts(message)))
    return 'conflict';
  if (
    response.data.some(
      (message) =>
        isMessageWithParts(message) &&
        message.info.sessionID !== undefined &&
        message.info.sessionID !== parentSessionID,
    )
  )
    return 'conflict';

  const candidates: ParentTaskCandidate[] = [];
  for (const [messageIndex, message] of response.data.entries()) {
    if (
      !isMessageWithParts(message) ||
      message.info.role !== 'assistant' ||
      (message.info.sessionID !== undefined &&
        message.info.sessionID !== parentSessionID)
    )
      continue;
    for (const part of message.parts) {
      if (!isTaskToolPart(part) || !isRecord(part.state)) continue;
      const output = toolOutput(part);
      if (output === undefined) continue;
      const outputTaskID = parseTaskIdFromTaskOutput(output);
      if (outputTaskID !== taskID) continue;
      const status = parseTaskStatusOutput(output);
      if (!status || status.taskID !== taskID) return 'conflict';

      const input = part.state.input;
      if (!isRecord(input)) return 'conflict';
      const subagentType = input.subagent_type;
      const inputAgent = input.agent;
      if (
        (subagentType !== undefined && typeof subagentType !== 'string') ||
        (inputAgent !== undefined && typeof inputAgent !== 'string') ||
        (subagentType !== undefined &&
          inputAgent !== undefined &&
          subagentType !== inputAgent)
      )
        return 'conflict';
      const agent = subagentType ?? inputAgent;
      if (
        typeof agent !== 'string' ||
        !agent.trim() ||
        input.background !== true
      )
        return 'conflict';
      candidates.push({
        agent,
        part: {
          status,
          messageIndex,
          observedAt: messageTime(message, 'created'),
          resultAt:
            isRecord(part.state.time) && validTime(part.state.time.end)
              ? part.state.time.end
              : messageTime(message, 'completed'),
          description:
            typeof input.description === 'string'
              ? input.description
              : undefined,
        },
      });
    }
  }

  const first = candidates[0];
  if (first && candidates.some((candidate) => candidate.agent !== first.agent))
    return 'conflict';
  return { messages: response.data, candidates };
}

/** Find a structured background delegation for an exact child session. */
export function findStructuredParentTaskDelegation(
  response: unknown,
  parentSessionID: string,
  taskID: string,
): StructuredParentTaskDelegation | 'conflict' | undefined {
  const transcript = parentTaskTranscript(response, parentSessionID, taskID);
  if (transcript === undefined || transcript === 'conflict') return transcript;
  const latest = transcript.candidates.at(-1);
  if (!latest) return;
  return {
    taskID,
    agent: latest.agent,
    messageIndex: latest.part.messageIndex,
    ...(latest.part.description !== undefined
      ? { description: latest.part.description }
      : {}),
  };
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function messageTime(
  message: unknown,
  key: 'created' | 'completed',
): number | undefined {
  if (!isMessageWithParts(message)) return;
  const info: unknown = message.info;
  if (!isRecord(info) || !isRecord(info.time)) return;
  const value = info.time[key];
  return validTime(value) ? value : undefined;
}

function matchingTaskPart(
  response: unknown,
  parentSessionID: string,
  taskID: string,
  agent: string,
): ParentDelegation | 'conflict' | undefined {
  const transcript = parentTaskTranscript(response, parentSessionID, taskID);
  if (transcript === undefined || transcript === 'conflict') return transcript;
  const latest = transcript.candidates.at(-1);
  if (!latest) return;
  if (latest.agent !== agent) return 'conflict';
  return { part: latest.part, messages: transcript.messages };
}

type ParentNotice = {
  at: number;
  messageIndex: number;
  retrieved?: boolean;
};

/** Text, reasoning, step markers, and a host file-diff patch may sit in
 * the parent turn. They are not acknowledgement by themselves. OpenCode
 * appends `patch` to the same assistant message when that step changes files. */
const PARENT_TURN_ASIDE_TYPES = new Set([
  'text',
  'reasoning',
  'step-start',
  'step-finish',
  'patch',
]);

/** Exit metadata and truncation are not failures. task()/subagent() are
 * never ordinary tools; task_result and task_status still are. */
function parentToolSucceeded(part: MessagePart): boolean {
  if (part.type !== 'tool' || isTaskToolPart(part) || !isRecord(part.state))
    return false;
  return (
    part.state.status === 'completed' &&
    part.state.error == null &&
    part.error == null
  );
}

function parentTurnContinues(message: MessageWithParts): boolean {
  return message.parts.every(
    (part) =>
      PARENT_TURN_ASIDE_TYPES.has(part.type) ||
      parentToolSucceeded(part) ||
      refusedTaskCreatedNoSession(part) ||
      inFlightTaskPart(part) ||
      inFlightOrdinaryTool(part),
  );
}

/** Sibling parts in the task_result message count. A failed tool or an
 * already dispatched task()/subagent() blocks that retrieval. */
function retrievedMessageAllowsAck(
  message: MessageWithParts | undefined,
): boolean {
  if (!message) return false;
  return (
    parentTurnContinues(message) &&
    !message.parts.some((item) => taskPartEndsTurn(item))
  );
}

function parentStopAcknowledgedAt(
  message: MessageWithParts,
  started: number,
  now: number,
): number | undefined {
  const completed = messageTime(message, 'completed');
  const info: unknown = message.info;
  if (
    typeof message.info.id !== 'string' ||
    !message.info.id ||
    !isRecord(info) ||
    info.finish !== 'stop' ||
    completed === undefined ||
    completed < started ||
    completed > now
  )
    return;
  // Non-empty text is required before any later unknown-part rejection.
  // Reasoning cannot stand in for that text.
  if (
    !message.parts.some(
      (part) =>
        part.type === 'text' &&
        typeof part.text === 'string' &&
        part.text.trim(),
    )
  )
    return;
  return completed;
}

/** A completed task_result part is a persisted retrieval, unlike v2 synthetic
 * notifications. Its entire execution must follow this child's final turn. */
function matchingTaskResults(
  parent: ParentDelegation,
  taskID: string,
  alias: string | undefined,
  result: string,
  runStartedAt: number,
  terminalAt: number,
  now: number,
): ParentNotice[] {
  const notices: ParentNotice[] = [];
  for (const [messageIndex, message] of parent.messages.entries()) {
    // A result retrieval from before the latest delegation belongs to an
    // earlier run when the host reuses the same child session ID.
    if (messageIndex <= parent.part.messageIndex) continue;
    if (message.info.role !== 'assistant') continue;
    for (const candidate of message.parts) {
      if (
        candidate.type !== 'tool' ||
        (candidate.tool !== 'task_result' &&
          candidate.name !== 'task_result') ||
        !isRecord(candidate.state) ||
        candidate.state.status !== 'completed' ||
        candidate.state.error != null ||
        candidate.error != null ||
        !isRecord(candidate.state.input)
      )
        continue;
      const requested = candidate.state.input.task_id;
      if (requested !== taskID && (!alias || requested !== alias)) continue;
      const content = candidate.state.content;
      const output =
        typeof candidate.state.output === 'string'
          ? candidate.state.output
          : Array.isArray(content) &&
              content.length === 1 &&
              isRecord(content[0]) &&
              content[0].type === 'text' &&
              typeof content[0].text === 'string'
            ? content[0].text
            : undefined;
      if (output !== result) continue;
      const time = candidate.state.time;
      if (!isRecord(time)) continue;
      const started = time.start;
      const at = time.end;
      const messageStarted = messageTime(message, 'created');
      if (
        !validTime(started) ||
        !validTime(at) ||
        messageStarted === undefined ||
        messageStarted > started ||
        started < terminalAt ||
        started <= runStartedAt ||
        at < started ||
        at <= terminalAt ||
        at > now
      )
        continue;
      notices.push({ at, messageIndex, retrieved: true });
    }
  }
  return notices;
}

/** Only persisted internal notification parts, native completion, or a
 * structured result retrieval are authority; board text and prose are not. */
function parentCompletion(
  parent: ParentDelegation,
  taskID: string,
  alias: string | undefined,
  result: string,
  runStartedAt: number,
  terminalAt: number,
  now: number,
  allowUnversionedNotice: boolean,
): { notifiedAt: number; acknowledgedAt?: number } | undefined {
  const { part, messages } = parent;
  if (part.observedAt === undefined || part.observedAt > runStartedAt) return;
  const matches = (status: TaskStatusOutput | undefined) =>
    status?.taskID === taskID &&
    status.state === 'completed' &&
    status.result?.trim() === result.trim();
  const notices: ParentNotice[] =
    matches(part.status) &&
    part.resultAt !== undefined &&
    part.resultAt >= terminalAt &&
    part.resultAt <= now
      ? [{ at: part.resultAt, messageIndex: part.messageIndex }]
      : [];
  notices.push(
    ...matchingTaskResults(
      parent,
      taskID,
      alias,
      result,
      runStartedAt,
      terminalAt,
      now,
    ),
  );
  // Native notifications carry a task ID but no run/generation ID. After a
  // second admission, a late first-run notice with identical text is ambiguous.
  for (const [messageIndex, message] of (allowUnversionedNotice
    ? messages
    : []
  ).entries()) {
    if (message.info.role !== 'user') continue;
    const at = messageTime(message, 'created');
    if (at === undefined || at < terminalAt || at > now) continue;
    if (
      message.parts.some(
        (candidate) =>
          candidate.type === 'text' &&
          candidate.synthetic === true &&
          isRecord(candidate.metadata) &&
          candidate.metadata[INTERNAL_INITIATOR_METADATA_KEY] === true &&
          typeof candidate.text === 'string' &&
          matches(parseTaskStatusOutput(candidate.text)),
      )
    )
      notices.push({ at, messageIndex });
  }
  notices.sort((left, right) => left.messageIndex - right.messageIndex);
  for (const notice of notices) {
    let blocked = false;
    for (const message of messages.slice(notice.messageIndex + 1)) {
      const started = messageTime(message, 'created');
      // Equal timestamps stay in transcript order. An earlier stamp, a
      // missing time, or a future time still fails closed.
      if (started === undefined || started < notice.at || started > now) {
        blocked = true;
        break;
      }
      if (message.info.role !== 'assistant') {
        // A retrieved result stays confirmed. A synthetic notice does not
        // survive a later user or system message.
        if (notice.retrieved) continue;
        blocked = true;
        break;
      }
      // A dispatched task()/subagent() ends the turn, including a different
      // child or a call with no parseable id. A refusal that explicitly
      // created no session does not.
      if (message.parts.some((part) => taskPartEndsTurn(part))) {
        blocked = true;
        break;
      }
      // A failed tool in the same message blocks even when that message
      // also ends with finish: stop. The stop is not checked first.
      if (!parentTurnContinues(message)) {
        blocked = true;
        break;
      }
      const acknowledgedAt = parentStopAcknowledgedAt(message, started, now);
      if (acknowledgedAt !== undefined)
        return { notifiedAt: notice.at, acknowledgedAt };
    }
    // A matching task_result is the acknowledgement. A later stop is not
    // required. A synthetic notice still is not enough on its own, and a
    // task() already dispatched after the child finished blocks it.
    if (
      !blocked &&
      notice.retrieved &&
      retrievedMessageAllowsAck(messages[notice.messageIndex]) &&
      !messages
        .slice(part.messageIndex + 1, notice.messageIndex)
        .some((message) => message.parts.some((item) => taskPartEndsTurn(item)))
    )
      return { notifiedAt: notice.at, acknowledgedAt: notice.at };
  }
  const lastNotice = notices.at(-1);
  return lastNotice ? { notifiedAt: lastNotice.at } : undefined;
}

type ChildBoundary = {
  startedAt: number;
  previousAdmissionAt?: number;
  completedAt?: number;
  pendingUser: boolean;
  finished: boolean;
  errorBeforeLatestUser: boolean;
};

/** The latest native user admission is the lower bound of the current run. */
function childBoundary(response: unknown): ChildBoundary | undefined {
  if (
    !isRecord(response) ||
    response.error != null ||
    !Array.isArray(response.data)
  )
    return;
  const messages = response.data;
  if (messages.some((message) => !isMessageWithParts(message))) return;
  const lastUser = messages.findLastIndex(
    (message) => message.info.role === 'user',
  );
  if (lastUser < 0) return;
  const user = messages[lastUser];
  const userTime = messageTime(user, 'created');
  const previousUser = messages
    .slice(0, lastUser)
    .filter((message) => message.info.role === 'user')
    .at(-1);
  const previousAdmissionAt = previousUser
    ? messageTime(previousUser, 'created')
    : undefined;
  if (
    typeof user.info.id !== 'string' ||
    !user.info.id ||
    userTime === undefined ||
    (previousUser && previousAdmissionAt === undefined)
  )
    return;
  const trailing = messages
    .slice(lastUser + 1)
    .filter((message) => message.info.role !== 'system');
  const last = trailing.at(-1);
  return {
    startedAt: userTime,
    previousAdmissionAt,
    completedAt: messageTime(last, 'completed'),
    pendingUser: last?.info.role !== 'assistant',
    errorBeforeLatestUser: messages
      .slice(0, lastUser)
      .some(
        (message) =>
          message.info.role === 'assistant' &&
          isRecord(message.info) &&
          message.info.error != null,
      ),
    finished:
      last?.info.role === 'assistant' &&
      isRecord(last.info) &&
      last.info.finish === 'stop',
  };
}

function statusFor(
  response: unknown,
  sessionID: string,
): {
  status?: 'busy' | 'retry' | 'idle';
  validMap: boolean;
} {
  if (!isRecord(response) || response.error != null || !isRecord(response.data))
    return { validMap: false };
  const data = response.data;
  // The status endpoint returns a keyed map. An absent entry is quiescent only
  // when this map itself was read successfully.
  if (Object.hasOwn(data, 'type') || Object.hasOwn(data, 'status'))
    return { validMap: false };
  const row = data[sessionID];
  if (row === undefined) return { validMap: true };
  if (
    !isRecord(row) ||
    (row.type !== 'busy' && row.type !== 'retry' && row.type !== 'idle')
  )
    return { validMap: false };
  return { validMap: true, status: row.type };
}

/** Read-only, fail-closed classification; no board writes or prompts. */
export async function classifySessionRecovery(
  input: SessionRecoveryRequest,
): Promise<SessionRecoveryResult> {
  const key =
    'alias' in input.requested
      ? input.requested.alias
      : input.requested.sessionID;
  const uncertain = (
    evidence: string,
    fields: RecoveryFields = {},
  ): SessionRecoveryResult => ({
    kind: 'uncertain',
    ...fields,
    reason: evidence,
  });
  if (!key || !input.parentSessionID || !input.agent || !input.directory)
    return uncertain('invalid request');

  let identity: BackgroundJobIdentity | undefined;
  try {
    identity = input.identityIndex?.lookup(input.parentSessionID, key);
  } catch {
    return uncertain('identity index unreadable');
  }
  if (
    identity &&
    (identity.parentSessionID !== input.parentSessionID ||
      identity.agent !== input.agent ||
      identity.directory !== input.directory ||
      (identity.taskID !== key && identity.alias !== key))
  )
    return uncertain('identity mismatch');
  if (!identity && 'alias' in input.requested)
    return uncertain('alias has no stored mapping');

  const taskID = identity?.taskID ?? key;
  const fields = { taskID, alias: identity?.alias, agent: input.agent };
  let parent: ParentDelegation | 'conflict' | undefined;
  if (input.readParentTranscript) {
    try {
      parent = matchingTaskPart(
        await input.readParentTranscript(),
        input.parentSessionID,
        taskID,
        input.agent,
      );
    } catch {
      // Persisted identity can still establish ownership; transcript failure
      // cannot supply terminal evidence.
    }
  }
  if (parent === 'conflict')
    return uncertain('parent delegation conflicts with identity', fields);
  if (!identity && !parent)
    return uncertain('session ID lacks a structured parent delegation', fields);
  const part = parent?.part;
  const details = { ...fields, description: part?.description };
  if (!input.getSession) return uncertain('session.get unavailable', details);

  let response: unknown;
  try {
    response = await input.getSession(taskID, input.directory);
  } catch (error) {
    return notFound(error)
      ? { kind: 'missing', ...details, reason: 'session.get NotFound' }
      : uncertain('session.get failed', details);
  }
  if (isRecord(response) && response.error != null)
    return notFound(response.error)
      ? { kind: 'missing', ...details, reason: 'session.get NotFound' }
      : uncertain('session.get error envelope', details);
  const session = isRecord(response) ? response.data : undefined;
  if (
    !isRecord(session) ||
    session.id !== taskID ||
    session.parentID !== input.parentSessionID ||
    (session.agent !== undefined && session.agent !== input.agent) ||
    (session.directory !== undefined &&
      session.directory !== input.directory) ||
    (session.location !== undefined &&
      (!isRecord(session.location) ||
        session.location.directory !== input.directory))
  )
    return uncertain('session.get identity invalid or mismatched', details);
  // v1 session.get omits the child agent. Require the exact structured parent
  // delegation even when the durable identity is present.
  if (session.agent === undefined && !parent)
    return uncertain(
      'v1 session requires structured parent delegation',
      details,
    );

  let status: 'busy' | 'retry' | 'idle' | undefined;
  let validStatusMap = false;
  const statusReadStartedAt = input.now?.() ?? Date.now();
  if (input.probeStatus) {
    try {
      const observed = statusFor(
        await input.probeStatus(taskID, input.directory),
        taskID,
      );
      status = observed.status;
      validStatusMap = observed.validMap;
    } catch {
      // No negative inference from a failed status read.
    }
  }
  const now = input.now?.() ?? Date.now();
  if (status === 'busy' || status === 'retry')
    return {
      kind: 'live',
      ...details,
      evidence: { kind: 'live', observedBusyAt: now, status },
    };

  const outcome =
    session.idleOutcome ?? session.idle_outcome ?? session.outcome;
  const time = isRecord(session.time) ? session.time : undefined;
  const bounded =
    typeof time?.created === 'number' &&
    typeof time.idle === 'number' &&
    Number.isFinite(time.created) &&
    Number.isFinite(time.idle) &&
    time.created >= 0 &&
    time.created < time.idle &&
    time.idle <= now;
  let transcript: ReturnType<typeof classifyTerminalEvidence> | undefined;
  let boundary: ChildBoundary | undefined;
  if (part && input.readChildTranscript) {
    try {
      const child = await input.readChildTranscript(taskID);
      boundary = childBoundary(child);
      transcript = classifyTerminalEvidence(child, {
        runStartedAt: boundary?.startedAt,
        terminalOutcomeConfirmed:
          (bounded && outcome === 'succeeded') ||
          (status === 'idle' &&
            boundary?.finished === true &&
            boundary.completedAt !== undefined &&
            boundary.completedAt <= statusReadStartedAt),
      });
    } catch {
      // Unreadable evidence cannot establish a terminal result or absence.
    }
  }
  const idleAt = validTime(time?.idle) ? time.idle : undefined;
  // A completed native tool part is itself positive host terminal evidence.
  // v2 exposes neither status nor an idle timestamp through the SDK.
  const nativeCompletedAt =
    part?.status.state === 'completed' &&
    part.status.result?.trim() &&
    part.resultAt !== undefined &&
    part.resultAt <= now
      ? part.resultAt
      : undefined;
  const retrieval =
    parent &&
    boundary?.finished &&
    boundary.completedAt !== undefined &&
    transcript?.verdict === 'completed'
      ? matchingTaskResults(
          parent,
          taskID,
          identity?.alias,
          transcript.text,
          boundary.startedAt,
          boundary.completedAt,
          now,
        ).at(-1)
      : undefined;
  const currentNativeCompletedAt =
    nativeCompletedAt !== undefined &&
    boundary?.completedAt !== undefined &&
    nativeCompletedAt >= boundary.completedAt
      ? nativeCompletedAt
      : undefined;
  const quiescentStatus =
    status === 'idle' || (validStatusMap && status === undefined);
  const terminalAt =
    bounded && idleAt !== undefined
      ? idleAt
      : quiescentStatus && boundary?.finished
        ? boundary.completedAt
        : (outcome === undefined || outcome === 'succeeded') &&
            status === undefined
          ? (currentNativeCompletedAt ??
            (retrieval !== undefined ? boundary?.completedAt : undefined))
          : quiescentStatus && boundary
            ? statusReadStartedAt
            : undefined;
  const currentOutcome =
    terminalAt !== undefined &&
    terminalAt <= now &&
    (!quiescentStatus || bounded || terminalAt <= statusReadStartedAt) &&
    boundary &&
    boundary.startedAt < terminalAt &&
    (boundary.previousAdmissionAt === undefined ||
      (part?.observedAt !== undefined &&
        part.observedAt > boundary.previousAdmissionAt) ||
      retrieval !== undefined) &&
    (!boundary.completedAt ||
      (boundary.startedAt <= boundary.completedAt &&
        boundary.completedAt <= terminalAt));
  // v1 has no persisted idle timestamp/outcome. A fresh idle observation plus
  // the latest completed child turn can establish terminality; the original
  // running tool output stays running after a background notification.
  if (
    currentOutcome &&
    boundary?.pendingUser === false &&
    (outcome === 'succeeded' ||
      (outcome === undefined &&
        (quiescentStatus ||
          currentNativeCompletedAt !== undefined ||
          retrieval !== undefined))) &&
    part &&
    (part.status.state === 'running' ||
      (part.status.state === 'completed' && part.status.result?.trim())) &&
    transcript?.verdict === 'completed'
  ) {
    const evidence = {
      kind: 'terminal' as const,
      state: 'completed' as const,
      resultSummary: transcript.text,
      completedAt: terminalAt,
      acknowledged: false as const,
    };
    const notice =
      parent &&
      parentCompletion(
        parent,
        taskID,
        identity?.alias,
        transcript.text,
        boundary.startedAt,
        terminalAt,
        now,
        boundary.previousAdmissionAt === undefined,
      );
    // A final child turn alone is not proof of notification or consumption.
    if (!notice?.acknowledgedAt)
      return {
        kind: 'uncertain',
        ...details,
        reason: notice
          ? 'parent acknowledgement unproven'
          : 'parent terminal notice unproven',
        pendingAcknowledgement: evidence,
      };
    const statuslessV2 =
      status === undefined && !validStatusMap && outcome === undefined;
    let resumeToken: SameProcessResumeEvidenceToken | undefined;
    if (statuslessV2) {
      const context = input.sameProcessResumeEvidenceContext;
      const broker = input.sameProcessResumeEvidence;
      if (
        !broker ||
        !context ||
        !Number.isSafeInteger(context.generation) ||
        context.generation < 0 ||
        !Number.isSafeInteger(context.terminalRevision) ||
        context.terminalRevision < 0
      )
        return uncertain('same-process resume evidence unavailable', details);
      try {
        // Terminal publication is recorded by the same-process owner before
        // classification. Transcript evidence alone never authorizes reuse;
        // this call only asks the broker to release its exact token.
        resumeToken = broker.authorize({
          taskID,
          parentSessionID: input.parentSessionID,
          generation: context.generation,
          terminalRevision: context.terminalRevision,
          resultSummary: transcript.text,
          acknowledgedAt: notice.acknowledgedAt,
        });
      } catch {
        resumeToken = undefined;
      }
      if (!resumeToken)
        return uncertain(
          'same-process resume authorization unavailable',
          details,
        );
    }
    const reusableEvidence = {
      ...evidence,
      acknowledged: true as const,
      ...(resumeToken ? { resumeToken } : {}),
    };
    return {
      kind: 'reusable',
      ...details,
      ...(resumeToken ? { resumeToken } : {}),
      evidence: reusableEvidence,
    };
  }
  if (
    bounded &&
    currentOutcome &&
    (outcome === 'interrupted' || outcome === 'cancelled') &&
    part &&
    part.status.state !== 'completed' &&
    (transcript?.verdict === 'absent' ||
      transcript?.verdict === 'error' ||
      transcript?.verdict === 'aborted')
  )
    return {
      kind: 'stopped',
      ...details,
      evidence: {
        kind: 'stopped',
        completedAt: terminalAt,
        resultSummary: 'Host interrupted before a terminal result.',
      },
    };
  if (
    quiescentStatus &&
    part &&
    part.status.state !== 'completed' &&
    (transcript?.verdict === 'absent' ||
      transcript?.verdict === 'error' ||
      transcript?.verdict === 'aborted') &&
    boundary &&
    boundary.startedAt <= statusReadStartedAt &&
    ((boundary.pendingUser && !boundary.errorBeforeLatestUser) ||
      transcript?.verdict === 'error' ||
      transcript?.verdict === 'aborted')
  )
    return {
      kind: 'stopped',
      ...details,
      evidence: {
        kind: 'stopped',
        completedAt: now,
        resultSummary: 'Session idle without a terminal result.',
      },
    };
  return uncertain(
    'no attributable current terminal or stop evidence',
    details,
  );
}
