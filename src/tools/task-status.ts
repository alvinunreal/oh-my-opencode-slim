import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import {
  formatChildInputWaitDetail,
  listChildInputWaits,
} from '../hooks/task-session-manager/child-input-wait';
import { pluginDisposedMessage } from '../hooks/task-session-manager/session-recovery';
import type {
  BackgroundJobBoard,
  BackgroundJobRecord,
} from '../utils/background-job-board';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
  type GateResult,
  runtimeObservationFromSnapshot,
} from '../utils/background-job-terminal-gate';
import {
  DIAGNOSTIC_MAX_BYTES,
  diagnosticExcerptOf,
  diagnosticTail,
  fetchChildTranscript,
} from '../utils/child-transcript';
import { isRecord } from '../utils/guards';
import { getClient } from '../utils/opencode-client';
import { SESSION_ID_PATTERN, withTimeout } from '../utils/session';
import {
  raceEvidenceDeadline,
  readHostSessionInfo,
} from '../utils/session-info-read';
import {
  classifyLiveSession,
  getRuntimeSessionStatusSnapshot,
  type RuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from '../utils/session-runtime-status';
import type { TaskActivityTracker } from './task-activity';
import {
  observationFromSnapshot,
  resolveLastActivity,
  summarizeTaskStatus,
} from './task-policy';
import {
  type CanonicalTaskResolver,
  idParamFor,
  readTaskRef,
  recentTaskHandles,
  resolveTaskRecord,
  taskRefArgs,
  withRecentTaskHandles,
} from './task-ref';
import {
  readUntrackedEvidence,
  verifyUntrackedOwnership,
} from './untracked-task-observation';

const ACTIVE_STATES = new Set(['busy', 'running', 'retry']);
const UNTRACKED_STATE = 'running-or-incomplete';

/** Bound for the shared host session-info read (matches the probe's own). */
const DEFAULT_HOST_INFO_TIMEOUT_MS = 1_500;

/**
 * The running-branch `[guidance]` block, shared byte-for-byte by the tracked
 * and untracked renders.
 */
const RUNNING_GUIDANCE =
  '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.';

/** Push-not-poll guidance: the completion notice is the delivery channel. */
const COMPLETION_NOTICE_NEXT =
  'a completion notice will arrive; continue other work and do not poll task_status.';

/** Uncertain-board-fallback guidance: stop polling, await the notice. */
const UNCONFIRMED_NEXT =
  'state unconfirmed; await the completion notice, do not poll task_status.';

/** Effective state of a possibly-reconciled board record. */
function terminalStateOf(record: BackgroundJobRecord): string {
  return record.state === 'reconciled'
    ? (record.terminalState ?? record.state)
    : record.state;
}

interface TerminalProbeResult {
  classificationKind: 'running' | 'idle' | 'outcome' | 'unknown';
  record?: BackgroundJobRecord;
  gateResult?: GateResult;
}

/**
 * One host-side terminal-outcome probe for a tracked run.
 *
 * The classifier is called exactly once. If it finds a valid host outcome,
 * the observation token is captured only after that await and the evidence is
 * handed to the terminal gate; this helper never calls board.commitTerminal.
 * The board is re-read after classification regardless of its result.
 */
async function probeTerminalOutcome(
  options: {
    input: PluginInput;
    gate: BackgroundJobTerminalGate;
    board: BackgroundJobBoard;
  },
  run: { taskID: string; generation: number },
  snapshot?: RuntimeSessionStatusSnapshot,
  loadHostInfo?: () => Promise<Record<string, unknown> | undefined>,
): Promise<TerminalProbeResult> {
  const hostInfo = loadHostInfo ? await loadHostInfo() : undefined;
  const classification = await classifyLiveSession(options.input, run.taskID, {
    ...(snapshot ? { snapshot } : {}),
    ...(hostInfo !== undefined ? { hostInfo } : {}),
  });
  let gateResult: GateResult | undefined;
  if (classification.kind === 'outcome') {
    const token = options.gate.capture(run);
    if (token) {
      const observed = options.gate.observe(token, {
        kind: 'quiescent',
        origin: 'host-outcome',
        readStartedAt: token.readStartedAt,
        observedAt: classification.idleAt,
        terminalOutcome: classification.outcome,
      });
      if (observed.kind !== 'stale') {
        gateResult = await options.gate.reconcile(run);
      }
    }
  }
  const latest = options.board.get(run.taskID);
  return {
    classificationKind: classification.kind,
    record: latest,
    ...(gateResult ? { gateResult } : {}),
  };
}

/** Terminal status render for a record a successful probe ended. */
function committedStatusOutput(
  record: BackgroundJobRecord,
  lastActivityAt: number,
  now: number,
  activitySource: string,
): string {
  return [
    `Task ${record.alias} (${record.taskID})`,
    `state: ${terminalStateOf(record)}`,
    `agent: ${record.agent}`,
    `last_activity_at: ${new Date(lastActivityAt).toISOString()}`,
    `last_activity_source: ${activitySource}`,
    `idle_for_seconds: ${Math.max(
      0,
      Math.floor((now - (lastActivityAt ?? now)) / 1000),
    )}`,
    'possibly_stuck: false',
  ].join('\n');
}

export function createTaskStatusTool(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobBoard;
  activityTracker?: TaskActivityTracker;
  terminalGate?: BackgroundJobTerminalGate;
  now?: () => number;
  statusTimeoutMs?: number;
  resolveCanonicalTaskRef?: CanonicalTaskResolver;
  isDisposed?: () => boolean;
  readTimeoutMs?: number;
}): Record<'task_status', ToolDefinition> {
  const idParam = idParamFor(options.input);
  const gate =
    options.terminalGate ??
    createBackgroundJobTerminalGate({
      backgroundJobBoard: options.backgroundJobBoard,
      input: options.input,
    });
  const z = tool.schema;
  const task_status = tool({
    description:
      "Inspect a tracked child task without resuming, prompting, or changing it. It accepts its task ID or parent-scoped alias. Pass result: true for a completed task's final text; refuses other terminals. For an untracked session (e.g. after a restart), reports a read-only observed state. An unknown or placeholder task_id enumerates the session's recent task handles, including recently finished sessions.",
    args: {
      ...taskRefArgs(idParam),
      result: z
        .boolean()
        .optional()
        .describe('Return the completed task’s final text.'),
      diagnostic: z
        .boolean()
        .optional()
        .describe(
          'Read a bounded, non-final excerpt for a tracked error, cancelled, or stopped task. Read-only; does not consume or acknowledge.',
        ),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_status requires sessionID');
      const requested = readTaskRef(args, idParam);
      if (!requested) throw new Error(`task_status requires ${idParam}`);
      if (args.result === true && args.diagnostic === true)
        throw new Error(
          'task_status accepts either result or diagnostic, not both',
        );
      if (args.result === true)
        return readTaskResult(
          {
            input: options.input,
            gate,
            board: options.backgroundJobBoard,
            isDisposed: options.isDisposed,
            readTimeoutMs: options.readTimeoutMs,
            resolveCanonicalTaskRef: options.resolveCanonicalTaskRef,
          },
          { parentSessionID, idParam, requested },
        );
      if (args.diagnostic === true) {
        try {
          const output = await readTaskDiagnostic(options, {
            parentSessionID,
            idParam,
            requested,
          });
          const tail = diagnosticTail(output, DIAGNOSTIC_MAX_BYTES);
          if (tail === output) return output;
          const marker = '[... truncated ...]\n';
          return (
            marker +
            diagnosticTail(output, DIAGNOSTIC_MAX_BYTES - marker.length)
          );
        } catch (error) {
          // Resolver/host exceptions are outside this tool's control too.
          throw new Error(
            diagnosticField(
              error instanceof Error ? error.message : 'Diagnostic read failed',
              DIAGNOSTIC_MAX_BYTES - 'Error: '.length,
            ),
          );
        }
      }
      const canonical = options.resolveCanonicalTaskRef
        ? await options.resolveCanonicalTaskRef(parentSessionID, requested)
        : undefined;
      if (canonical?.kind === 'refused')
        throw new Error(
          withRecentTaskHandles(
            canonical.reason,
            recentTaskHandles(options.backgroundJobBoard, parentSessionID),
          ),
        );
      const identity = canonical?.taskID ?? requested;
      const job = canonical
        ? options.backgroundJobBoard.get(identity)
        : options.backgroundJobBoard.resolve(parentSessionID, requested);
      if (!job || job.parentSessionID !== parentSessionID) {
        // Read-only fallback for a session the board lost (e.g. a host or
        // plugin restart emptied the in-memory board): verify ownership
        // like the result mode's untracked path, then report observed
        // evidence. The task is never registered, prompted, or aborted.
        return reportUntrackedTaskStatus(options, {
          requested,
          identity,
          parentSessionID,
        });
      }
      const taskID = job.taskID;

      // Bounded live read: a failed, malformed, or timed-out host status
      // response surfaces as explicit uncertainty instead of a confident
      // board-state fallback.
      const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
        timeoutMs: options.statusTimeoutMs,
      });
      const current = options.backgroundJobBoard.get(taskID) ?? job;
      if (
        current.parentSessionID !== parentSessionID ||
        current.taskID !== taskID
      ) {
        throw new Error(
          withRecentTaskHandles(
            `Unknown task ID or alias: ${taskID}`,
            recentTaskHandles(options.backgroundJobBoard, parentSessionID),
          ),
        );
      }
      const observation = observationFromSnapshot(snapshot, taskID);
      const now = options.now?.() ?? Date.now();
      let renderRecord = current;
      let activity = resolveLastActivity(current, options.activityTracker);
      let lastActivityAt = activity.at;
      let report = summarizeTaskStatus(
        renderRecord,
        observation,
        lastActivityAt,
        now,
      );
      let terminalProbe: TerminalProbeResult | undefined;
      if (report.uncertain) {
        terminalProbe = await probeTerminalOutcome(
          { input: options.input, gate, board: options.backgroundJobBoard },
          { taskID, generation: current.generation },
          snapshot,
        );
        // Render from the board record re-read after the classifier await.
        if (
          terminalProbe.record?.taskID === taskID &&
          terminalProbe.record.generation === current.generation
        ) {
          renderRecord = terminalProbe.record;
          activity = resolveLastActivity(renderRecord, options.activityTracker);
          lastActivityAt = activity.at;
          report = summarizeTaskStatus(
            renderRecord,
            observation,
            lastActivityAt,
            now,
          );
        }
        if (
          terminalProbe.gateResult?.kind === 'committed' &&
          terminalProbe.record?.generation === current.generation
        ) {
          return committedStatusOutput(
            terminalProbe.record,
            lastActivityAt,
            now,
            activity.source,
          );
        }
      }

      const details = [
        `Task ${renderRecord.alias} (${renderRecord.taskID})`,
        `state: ${report.state}${report.uncertain ? ' (unconfirmed)' : ''}`,
        `agent: ${renderRecord.agent}`,
        `last_activity_at: ${new Date(lastActivityAt).toISOString()}`,
        `last_activity_source: ${activity.source}`,
        `idle_for_seconds: ${report.idleSeconds}`,
        `possibly_stuck: ${report.possiblyStuck}`,
      ];
      const waits = listChildInputWaits(taskID);
      const hostFlavor = (options.input as { hostFlavor?: unknown }).hostFlavor;
      for (const wait of waits) {
        details.push(`waiting_input: true (${wait.kind} ${wait.requestID})`);
        details.push(formatChildInputWaitDetail(wait, hostFlavor));
      }
      if (report.uncertain) {
        details.push('status_uncertain: true');
        if (report.lastStatusError) {
          details.push(`last_status_error: ${report.lastStatusError}`);
        }
        details.push(`next: ${UNCONFIRMED_NEXT}`);
      }
      if (
        waits.length === 0 &&
        !report.uncertain &&
        ACTIVE_STATES.has(report.state)
      ) {
        details.push('');
        details.push(RUNNING_GUIDANCE);
      }
      return details.join('\n');
    },
  });

  return { task_status };
}

function readonlyTerminalResult(
  requested: string,
  record:
    | {
        state?: string;
        terminalState?: string;
        resultSummary?: string;
      }
    | undefined,
): string {
  const state =
    record?.state === 'reconciled' ? record.terminalState : record?.state;
  const summary = record?.resultSummary?.trim();
  if (state === 'completed' && summary) return summary;
  throw new Error(
    `Task ${requested} result was not consumed. No action was sent.`,
  );
}

function runningResultRefusal(
  idParam: string,
  taskID: string,
  uncertain: boolean,
  status?: 'busy' | 'idle' | 'retry',
  tracked = true,
): string {
  if (status === 'idle')
    return [
      `${idParam}: ${taskID}`,
      'state: pending',
      'message: Task is quiescent; wait for terminal reconciliation before retrieving its result.',
      'next: retry task_status with { result: true } after the terminal notification',
    ].join('\n');
  return [
    `${idParam}: ${taskID}`,
    uncertain
      ? 'state: running (unconfirmed)'
      : `state: ${status === 'retry' ? 'retry' : 'running'}`,
    uncertain
      ? 'message: Live task status is uncertain; no definitive running state is available.'
      : 'message: Task is still running. Wait for its terminal result.',
    `next: ${
      !tracked
        ? 'retry task_status with { result: true } after the task finishes'
        : COMPLETION_NOTICE_NEXT
    }`,
  ].join('\n');
}

interface TaskResultReadOptions {
  input: PluginInput;
  gate: BackgroundJobTerminalGate;
  board: BackgroundJobBoard;
  isDisposed?: () => boolean;
  readTimeoutMs?: number;
  resolveCanonicalTaskRef?: CanonicalTaskResolver;
}

interface TaskResultReadRef {
  parentSessionID: string;
  idParam: string;
  requested: string;
}

/** Result-mode read. Completed-only; never re-runs or re-prompts. */
async function readTaskResult(
  options: TaskResultReadOptions,
  ref: TaskResultReadRef,
): Promise<string> {
  const { parentSessionID, idParam, requested } = ref;
  const board = options.board;
  const gate = options.gate;
  const resolution = await resolveTaskRecord(
    {
      resolveCanonicalTaskRef: options.resolveCanonicalTaskRef,
      isDisposed: options.isDisposed,
      backgroundJobBoard: options.board,
    },
    parentSessionID,
    requested,
  );
  if (resolution.kind === 'disposed') throw new Error(pluginDisposedMessage());
  if (resolution.kind === 'refused')
    throw new Error(
      withRecentTaskHandles(
        resolution.reason,
        recentTaskHandles(options.board, parentSessionID),
      ),
    );
  const { identity, canonical, job: tracked } = resolution;
  if (tracked && tracked.parentSessionID !== parentSessionID) {
    throw new Error(`Task ${identity} does not belong to this session`);
  }
  const taskID = tracked?.taskID ?? identity;
  if (!SESSION_ID_PATTERN.test(taskID))
    throw new Error(`Unknown task ID or alias: ${requested}`);

  // Inspect every retained state BEFORE rejection, acknowledgement or text
  // retrieval. Busy retracts even a consumed or timed-out publication.
  let snapshot: RuntimeSessionStatusSnapshot | undefined;
  if (
    tracked &&
    typeof getClient(options.input).session?.status === 'function'
  ) {
    const observation = gate.capture(tracked);
    if (observation) {
      snapshot = await getRuntimeSessionStatusSnapshot(options.input);
      if (options.isDisposed?.()) throw new Error(pluginDisposedMessage());
      gate.observe(
        observation,
        runtimeObservationFromSnapshot(
          snapshot,
          taskID,
          observation.readStartedAt,
        ),
      );
    }
  }
  if (options.isDisposed?.()) throw new Error(pluginDisposedMessage());
  let result = tracked ? await gate.reconcile(tracked) : undefined;
  if (options.isDisposed?.()) {
    return readonlyTerminalResult(requested, tracked);
  }
  let current = canonical
    ? board.get(taskID)
    : board.resolve(parentSessionID, requested);
  if (current && current.parentSessionID !== parentSessionID) {
    throw new Error(`Task ${identity} does not belong to this session`);
  }
  if (
    tracked &&
    (!current ||
      current.generation !== tracked.generation ||
      result?.kind === 'stale')
  ) {
    throw new Error(
      `Task ${requested} changed generation while its result was being retrieved`,
    );
  }
  let terminalProbe: TerminalProbeResult | undefined;
  const client = getClient(options.input);
  let hostInfo: Record<string, unknown> | undefined;
  let hostInfoRead = false;
  let hostInfoError: unknown;
  // One host session-info read per query, sharing the terminal gate's raw
  // in-flight read: the probe classifies from it and the ownership gate
  // below reuses it instead of re-reading. A deadline or failed read
  // degrades the probe to its bounded path (unknown, never a hang) and the
  // ownership gate below fails closed for untracked ids.
  const readIdentity =
    current === undefined
      ? `untracked:${parentSessionID}:${taskID}`
      : `tracked:${current.generation}`;
  const readHostInfoOnce = async (): Promise<void> => {
    if (hostInfoRead) return;
    hostInfoRead = true;
    if (typeof client.session.get !== 'function') return;
    try {
      const tagged = readHostSessionInfo(options.input, {
        taskID,
        identity: readIdentity,
      }).then(
        (value) => ({ value, failed: false as const }),
        (error) => ({ error, failed: true as const }),
      );
      const raced = await raceEvidenceDeadline(
        tagged,
        options.readTimeoutMs ?? DEFAULT_HOST_INFO_TIMEOUT_MS,
      );
      if (raced === undefined) {
        hostInfoError = new Error('session info read timed out');
        return;
      }
      if (raced.failed) {
        hostInfoError = raced.error;
        return;
      }
      const response = raced.value;
      hostInfo =
        isRecord(response) && isRecord(response.data)
          ? response.data
          : isRecord(response)
            ? response
            : undefined;
    } catch (error) {
      hostInfoError = error;
    }
  };
  const loadHostInfo = async (): Promise<
    Record<string, unknown> | undefined
  > => {
    await readHostInfoOnce();
    return hostInfo;
  };
  if (current?.state === 'running') {
    terminalProbe = await probeTerminalOutcome(
      { input: options.input, gate, board },
      { taskID, generation: current.generation },
      snapshot,
      loadHostInfo,
    );
    if (
      terminalProbe.record &&
      terminalProbe.record.generation === current.generation
    ) {
      current = terminalProbe.record;
    }
    if (
      terminalProbe.gateResult?.kind === 'committed' &&
      terminalProbe.record
    ) {
      result = terminalProbe.gateResult;
    }
    if (current.state === 'running')
      return runningResultRefusal(
        idParam,
        taskID,
        current.statusUncertain,
        snapshot && runtimeSessionStatus(snapshot, taskID),
      );
  }

  const token = current ? gate.capture(current) : undefined;
  await readHostInfoOnce();
  if (typeof client.session.get !== 'function' && !current)
    throw new Error(
      `Task ${requested} is not tracked by this session and cannot be verified`,
    );
  if (hostInfoError !== undefined) {
    if (!current)
      throw new Error(
        `Task ${requested} is not tracked by this session and cannot be verified`,
      );
  } else if (typeof client.session.get === 'function') {
    // Ownership gate: a readable projection must name this parent.
    if (hostInfo?.parentID !== parentSessionID)
      throw new Error(`Task ${requested} does not belong to this session`);
  }

  if (current) {
    const latest = board.get(taskID);
    const after = gate.capture(current);
    if (
      options.isDisposed?.() ||
      (token === undefined && after === undefined)
    ) {
      return readonlyTerminalResult(requested, current);
    }
    if (
      latest?.generation !== current.generation ||
      latest.terminalRevision !== current.terminalRevision ||
      after?.activityRevision !== token?.activityRevision ||
      after?.attemptRevision !== token?.attemptRevision ||
      after?.episode !== token?.episode
    ) {
      throw new Error(
        `Task ${requested} changed generation or publication while its result was being retrieved; wait for its current terminal result instead of retrieving it.`,
      );
    }
    let state =
      current.state === 'reconciled' ? current.terminalState : current.state;
    if (state === 'completed' && result?.kind !== 'committed') {
      if (!terminalProbe) {
        terminalProbe = await probeTerminalOutcome(
          { input: options.input, gate, board },
          { taskID, generation: current.generation },
          snapshot,
          loadHostInfo,
        );
        if (terminalProbe.record?.generation !== current.generation) {
          throw new Error(
            `Task ${requested} changed generation while its result was being retrieved`,
          );
        }
        current = terminalProbe.record;
      }
      if (terminalProbe.gateResult?.kind === 'committed')
        result = terminalProbe.gateResult;
      const latestState =
        current.state === 'reconciled' ? current.terminalState : current.state;
      state = latestState;
      if (latestState === 'completed' && result?.kind !== 'committed')
        return runningResultRefusal(idParam, taskID, true);
    }
    if (state === 'error') {
      board.markUsed(parentSessionID, taskID);
      throw new Error(
        `Task ${requested} ended in error: ${current.lastStatusError ?? current.resultSummary ?? 'no error details available'}`,
      );
    }
    if (state === 'cancelled') {
      board.markUsed(parentSessionID, taskID);
      throw new Error(
        `Task ${requested} was cancelled: ${current.resultSummary?.replace(/^cancelled:\s*/i, '') ?? 'cancelled'}`,
      );
    }
    if (state !== 'completed' || !current.resultSummary?.trim())
      throw new Error(`Task ${requested} has no confirmed completed result`);
    board.markUsed(parentSessionID, taskID);
    return current.resultSummary;
  }

  // Untracked fallback: rendered from the same single read that the
  // status fallback uses. Ownership is already verified above (the
  // session.get parentID gate), so only the live probe and transcript
  // classification run here.
  const read = await readUntrackedEvidence(
    { input: options.input, readTimeoutMs: options.readTimeoutMs },
    taskID,
    hostInfo,
  );
  if (read.live.status === 'busy' || read.live.status === 'retry')
    return runningResultRefusal(
      idParam,
      taskID,
      false,
      read.live.status,
      false,
    );
  if (read.live.status === 'unknown')
    return runningResultRefusal(idParam, taskID, true, undefined, false);
  if (read.roundError) throw read.roundError;
  const evidence = read.round;
  if (!evidence || evidence.verdict === 'incomplete')
    return runningResultRefusal(idParam, taskID, true, undefined, false);
  if (evidence.verdict === 'error')
    throw new Error(
      `Task ${requested} ended in error: ${evidence.text ?? 'no error details available'}`,
    );
  const completedText =
    evidence.verdict === 'completed' && 'text' in evidence
      ? evidence.text
      : undefined;
  if (!completedText)
    throw new Error(
      `Task ${requested} shows no terminal evidence of completion; refusing to present partial output as its final result`,
    );
  return completedText;
}

interface UntrackedStatusOptions {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobBoard;
  now?: () => number;
  statusTimeoutMs?: number;
  isDisposed?: () => boolean;
  readTimeoutMs?: number;
}

const DIAGNOSTIC_TERMINALS = new Set(['error', 'cancelled', 'stopped']);
const DIAGNOSTIC_NEXT =
  'next: treat this as non-final evidence; await or re-delegate, do not mark the task accepted';

/** Cap every variable header field as well as the excerpt. Newlines in host
 * reasons cannot impersonate protocol header lines. */
function diagnosticField(value: string, maxBytes = 512): string {
  const marker = '[... truncated ...] ';
  const tail = diagnosticTail(value, maxBytes).replace(/[\r\n]/g, ' ');
  return tail.length < value.length
    ? marker + diagnosticTail(tail, maxBytes - marker.length)
    : tail;
}

/** Attribution label for a successful excerpt: identity-fenced only when the
 * run recorded its opening input id; otherwise explicitly timestamp-based. */
function diagnosticEvidenceLabel(runInputMessageID: string | undefined) {
  return runInputMessageID === undefined
    ? 'transcript (timestamp)'
    : 'transcript (identity)';
}

/** Longest possible attribution label, for byte budgeting. */
const LONGEST_EVIDENCE = diagnosticEvidenceLabel(undefined);

function diagnosticRefusal(taskID: string, state: string): string {
  return [
    `Task ${diagnosticField(taskID)}`,
    `state: ${state}`,
    'message: Diagnostics are only for finished-but-unsuccessful children (error, cancelled, stopped).',
    state === 'completed'
      ? 'next: retry task_status with { result: true }'
      : `next: ${UNCONFIRMED_NEXT}`,
  ].join('\n');
}

function renderDiagnostic(
  info: {
    taskID: string;
    alias?: string;
    state: string;
    generation: number;
    reason?: string;
    runStartedAt: number;
    completedAt?: number;
    /** Recorded admission id of this run's opening input, when known. */
    runInputMessageID?: string;
    /** Recorded admission id of a same-generation amendment the plugin
     *  delivered, when known. */
    amendmentInputMessageID?: string;
  },
  transcript: unknown,
  unavailable?: string,
): string {
  const headerFor = (reason: string) =>
    [
      `Task ${diagnosticField(info.alias ?? info.taskID)} (${diagnosticField(info.taskID)})`,
      `state: ${info.state}`,
      `generation: ${info.generation}`,
      `terminal_reason: ${diagnosticField(reason)}`,
      'partial_output: true (non-final excerpt; not the task result; read-only)',
    ].join('\n');
  // Reserve the entire envelope, including the longest truncation label and
  // the longer attribution label. The remaining byte budget belongs to the
  // excerpt, not the whole 6 KiB.
  const evidence = diagnosticEvidenceLabel(info.runInputMessageID);
  const footerFor = (label: string) =>
    `\nexcerpt_end\ntruncated: messages,chars\nevidence: ${label}\n${DIAGNOSTIC_NEXT}`;
  const budget =
    DIAGNOSTIC_MAX_BYTES -
    new TextEncoder().encode(
      `${headerFor(info.reason ?? 'x'.repeat(512))}\nexcerpt_begin\n${footerFor(
        LONGEST_EVIDENCE,
      )}`,
    ).byteLength;
  const excerpt = unavailable
    ? { unavailable }
    : diagnosticExcerptOf(transcript, {
        maxBytes: budget,
        runStartedAt: info.runStartedAt,
        completedAt: info.completedAt,
        ...(info.runInputMessageID !== undefined
          ? { inputMessageID: info.runInputMessageID }
          : {}),
        ...(info.amendmentInputMessageID !== undefined
          ? { amendmentMessageID: info.amendmentInputMessageID }
          : {}),
      });
  const header = headerFor(
    info.reason ??
      ('assistantError' in excerpt ? excerpt.assistantError : undefined) ??
      info.state,
  );
  if ('unavailable' in excerpt)
    return `${header}\nexcerpt: none (evidence unavailable)\nevidence: unavailable (${diagnosticField(excerpt.unavailable)})\n${DIAGNOSTIC_NEXT}`;
  return `${header}\nexcerpt_begin\n${excerpt.text}\nexcerpt_end\ntruncated: ${excerpt.truncated}\nevidence: ${evidence}\n${DIAGNOSTIC_NEXT}`;
}

/** Diagnostic reads deliberately bypass snapshots, the gate, and consumption. */
async function readTaskDiagnostic(
  options: UntrackedStatusOptions & {
    resolveCanonicalTaskRef?: CanonicalTaskResolver;
  },
  ref: TaskResultReadRef,
): Promise<string> {
  const { parentSessionID, requested } = ref;
  const board = options.backgroundJobBoard;
  const resolution = await resolveTaskRecord(
    options,
    parentSessionID,
    requested,
  );
  if (resolution.kind === 'disposed') throw new Error(pluginDisposedMessage());
  if (resolution.kind === 'refused')
    throw new Error(
      withRecentTaskHandles(
        diagnosticField(resolution.reason),
        diagnosticField(recentTaskHandles(board, parentSessionID) ?? ''),
      ),
    );
  const { identity } = resolution;
  const job = resolution.job ?? board.get(identity);
  if (job) {
    if (job.parentSessionID !== parentSessionID)
      throw new Error(
        `Task ${diagnosticField(identity)} does not belong to this session`,
      );
    const state = terminalStateOf(job);
    if (!DIAGNOSTIC_TERMINALS.has(state))
      return diagnosticRefusal(job.taskID, state);
    const generation = job.generation;
    const revision = job.terminalRevision;
    const runStartedAt = job.runStartedAt;
    const completedAt = job.completedAt;
    // resultSummary is also a native return/partial-output carrier. Only the
    // gate's fixed host-outcome literals are safe reasons, not arbitrary prose.
    const reason =
      job.lastStatusError ??
      ([
        'Host reported outcome: failed.',
        'Host reported outcome: interrupted.',
        'Host reported outcome: cancelled.',
      ].includes(job.resultSummary ?? '')
        ? job.resultSummary
        : undefined);
    let transcript: unknown;
    let unavailable: string | undefined;
    const controller = new AbortController();
    try {
      transcript = await withTimeout(
        fetchChildTranscript(
          getClient(options.input),
          job.taskID,
          options.input.directory,
          100,
          controller.signal,
        ),
        options.readTimeoutMs ?? 5_000,
        'child transcript read timed out',
      );
    } catch (error) {
      controller.abort();
      unavailable =
        error instanceof Error ? error.message : 'child transcript read failed';
    }
    const latest = board.get(job.taskID);
    if (
      !latest ||
      latest.generation !== generation ||
      latest.terminalRevision !== revision ||
      !DIAGNOSTIC_TERMINALS.has(terminalStateOf(latest))
    )
      throw new Error(
        `Task ${diagnosticField(job.taskID)} changed generation while its diagnostic was being read`,
      );
    return renderDiagnostic(
      {
        taskID: job.taskID,
        alias: job.alias,
        state,
        generation,
        reason,
        runStartedAt,
        completedAt,
        ...(job.runInputMessageID !== undefined
          ? { runInputMessageID: job.runInputMessageID }
          : {}),
        ...(job.amendmentInputMessageID !== undefined
          ? { amendmentInputMessageID: job.amendmentInputMessageID }
          : {}),
      },
      transcript,
      unavailable,
    );
  }
  const status = await reportUntrackedTaskStatus(options, {
    requested,
    identity,
    parentSessionID,
  });
  return `${status}\nmessage: Diagnostics require a tracked task record.`;
}

/**
 * Read-only status for a task the board does not track: ownership and
 * evidence both come from the shared untracked-read module — the same
 * single implementation the task_status result mode's untracked path
 * uses. Never registers, prompts, or aborts anything.
 */
async function reportUntrackedTaskStatus(
  options: UntrackedStatusOptions,
  ref: {
    requested: string;
    identity: string;
    parentSessionID: string;
  },
): Promise<string> {
  const { identity, parentSessionID } = ref;
  const unknown = () =>
    new Error(
      withRecentTaskHandles(
        `Unknown task ID or alias: ${identity}`,
        recentTaskHandles(options.backgroundJobBoard, parentSessionID),
      ),
    );
  const ownership = await verifyUntrackedOwnership(
    options,
    identity,
    parentSessionID,
  );
  // Disposed: keep task_status's existing unknown-task contract.
  if (options.isDisposed?.()) throw unknown();
  if (ownership.kind !== 'verified') {
    if (ownership.kind === 'foreign-parent') {
      throw new Error(`Task ${ref.requested} does not belong to this session`);
    }
    throw unknown();
  }

  const details = [
    `Task ${identity} is not tracked by the local background job board (its tracking does not survive a host or plugin restart).`,
    'board: untracked',
    'last_activity_source: unknown',
  ];

  const evidence = await readUntrackedEvidence(
    options,
    identity,
    ownership.hostInfo,
  );
  // v1's live status map is real evidence of execution; v2 has no
  // equivalent (the shim omits `status`), so this probe is v1 only.
  if (evidence.live.status === 'busy' || evidence.live.status === 'retry') {
    details.push(`state: ${evidence.live.status} (live)`);
    details.push(RUNNING_GUIDANCE);
    return details.join('\n');
  }

  let evidenceLine: string;
  if (evidence.live.status === 'unknown') {
    evidenceLine = `state: unknown (uncertain; live status could not be read: ${evidence.live.reason})`;
  } else if (evidence.round) {
    evidenceLine = describeUntrackedEvidence(
      evidence.round,
      evidence.source ??
        (evidence.live.status === 'v2' ? 'host state' : 'history'),
    );
  } else {
    evidenceLine = `state: ${UNTRACKED_STATE} (uncertain; transcript could not be read)`;
  }
  details.push(evidenceLine);
  if (ownership.agent) details.push(`agent: ${ownership.agent}`);
  // The host session's creation time, not its latest activity.
  if (ownership.createdAt !== undefined)
    details.push(`created_at: ${new Date(ownership.createdAt).toISOString()}`);
  details.push(
    evidence.round?.verdict === 'error'
      ? 'next: use task_status with { result: true } for this error; { diagnostic: true } requires a tracked task'
      : "next: use task_status with { result: true } for a completed task's final text",
  );
  return details.join('\n');
}

/** Observed-state line for one transcript classification verdict. */
function describeUntrackedEvidence(
  round: {
    verdict: string;
    reason?: string;
  },
  source: 'history' | 'host state',
): string {
  if (round.verdict === 'completed') {
    return `state: completed (verified from ${source})`;
  }
  if (round.verdict === 'error') {
    return `state: error (verified from ${source})`;
  }
  if (round.verdict === 'interrupted') {
    return `state: stopped (interrupted, verified from ${source})`;
  }
  if (round.verdict === 'unreadable' || round.verdict === 'retry') {
    return `state: ${UNTRACKED_STATE} (uncertain; ${source} ${round.verdict}${round.reason ? `: ${round.reason}` : ''})`;
  }
  if (source === 'host state') {
    return `state: ${UNTRACKED_STATE} (uncertain; no terminal host outcome covers the latest input)`;
  }
  // incomplete / absent: no verified terminal round after the latest
  // input. The session may be running or merely unfinished — do not
  // claim definite running.
  return `state: ${UNTRACKED_STATE} (uncertain; no verified terminal round)`;
}
