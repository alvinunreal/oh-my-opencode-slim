/**
 * Periodic orchestrator wake scheduler.
 *
 * After continuous parent-idle time, capability-gated host session APIs may
 * receive a static internal wake prompt when incomplete todos remain. Active
 * children suppress periodic wakes. Host responses are authoritative; the local
 * job board is never consulted. Progress/reservation state is process-global
 * so independently created hook instances share one-flight and the two-wake
 * no-progress cap.
 *
 * v2 hosts (hostFlavor 'v2', stamped by the client shim) have no todo/
 * children/status surfaces, so the scheduler runs there in a children-driven
 * degraded mode: children are enumerated via `session.list({parentID})`
 * (event-tracked fallback when the listing is unavailable), the wake
 * condition is "children without a terminal outcome" plus stopped-job
 * recovery, and the wake prompt is delivered with `delivery: 'queue'`
 * (v1 prompt_async queued; v2 steer would hijack an in-flight run). All new
 * children-mode behavior is behind the host-flavor/capability probe; the
 * reservation and retry gate is shared with v1.
 */
import type { PluginInput } from '@opencode-ai/plugin';
import type { OpencodeClient } from '@opencode-ai/sdk';
import {
  createInternalAgentTextPart,
  isInternalInitiatorPart,
} from '../../utils';
import { stringifyError } from '../../utils/child-transcript';
import { isRecord as isObjectRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import type { SessionSelection } from '../../utils/session-selection';
import type { SessionLifecycle } from '../session-lifecycle';
import {
  type ContinuationModelSelection,
  parseContinuationModelSelection,
} from '../task-session-manager/continuation-model-selection';
import { isActiveStatus } from '../task-session-manager/status-utils';
import {
  claimWakeSession,
  clearExpectingWakeBusy,
  clearWakeSession,
  commitWakeReservation,
  getObservedWakeModel,
  getSuppressedDuplicateWakes,
  getWakeProgress,
  isExpectingWakeBusy,
  noteHostProgress,
  rearmWakeProgress,
  releaseWakeEvaluation,
  releaseWakeSessionHolder,
  reserveWakeBodyOccurrence,
  retryAfterWakeEvaluation,
  rollbackWakeBodyOccurrence,
  rollbackWakeReservation,
  setObservedWakeModel,
  tryBeginWakeEvaluation,
} from './wake-gate';

export const ORCHESTRATOR_WAKE_TEXT =
  '<system-reminder>\nFinish any incomplete TODOs. Await running agents; if one appears stuck, assess it and cancel/respawn only when justified. Do not respond to this reminder.\n</system-reminder>';

export const ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT =
  '<system-reminder>\nA background job stopped without a terminal result. Consult the Background Job Board, recover or reroute the work as needed, and do not wait for that job as if it were still running. Do not respond to this reminder.\n</system-reminder>';

/** Board-injection-off variant: the board never appears in prompts, so the
 * wake points at the pull channel that carries the same facts. */
export const ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT_NO_BOARD =
  '<system-reminder>\nA background job stopped without a terminal result. Check `task_status` for the stopped task, recover or reroute the work as needed, and do not wait for that job as if it were still running. Do not respond to this reminder.\n</system-reminder>';

/**
 * True only for a genuine external operator message. Plugin-injected nudges
 * must never rearm the no-progress cap or clear wait state:
 * - synthetic parts (board tails, phase reminders, revived-run terminal
 *   notifications, internal-initiator wake replays) are host/internal, not
 *   operator input;
 * - `noReply` prompts (task_message child nudges, interview URL
 *   notifications) never expect an operator turn;
 * - v2 command-marker submits (`ctx.session.prompt` text-only submits) carry
 *   no chat.message messageID identity, so they fail the operator-identity
 *   gate below.
 *
 * Exported for unit tests and shared with task-session-manager (single
 * source of truth for the genuine-operator verdict).
 */
export function isGenuineOperatorMessage(
  inputMessage: Record<string, unknown> | undefined,
  outputMessage: Record<string, unknown> | undefined,
  parts: unknown,
): boolean {
  if (!Array.isArray(parts) || parts.length === 0) return false;
  for (const part of parts) {
    if (!isObjectRecord(part)) continue;
    // Any synthetic or internal-initiator part vetoes the whole message:
    // a single plugin-injected part marks the turn as plugin-injected even
    // when it rides alongside genuine operator text (e.g. a wake replay
    // appended to an operator turn). Fail closed toward no-rearm.
    if (part.synthetic === true || isInternalInitiatorPart(part)) return false;
    // Non-text/non-file/non-image parts (e.g. step-start markers) carry no
    // operator content.
    if (
      !(
        (part.type === 'text' && typeof part.text === 'string') ||
        part.type === 'file' ||
        part.type === 'image'
      )
    ) {
      continue;
    }
    // Tagged synthetic-adjacent injections (board/phase metadata keys) that
    // survived without the synthetic flag are still not operator input.
    if (isObjectRecord(part.metadata)) {
      const metadata = part.metadata as Record<string, unknown>;
      if (
        metadata['oh-my-opencode-slim.backgroundJobBoard'] === true ||
        metadata['oh-my-opencode-slim.phaseReminder'] === true ||
        metadata['oh-my-opencode-slim.deepworkGoal'] === true ||
        metadata['oh-my-opencode-slim.internalInitiator'] === true
      ) {
        return false;
      }
    }
  }
  // Operator identity: the host assigns a messageID to real chat.message
  // turns. v2 command submits and bare notify injections arrive without one.
  // Upstream's messageIdentity seam (input.messageID → output.message.id →
  // same-process output.message object, fail closed) is the identity half
  // of this verdict; the checks above are the genuineness half. Both must
  // pass: callers keep their own messageIdentity computation and additionally
  // require this helper, so neither seam can pass an injection alone.
  const inputMessageID = inputMessage?.messageID;
  const outputMessageID = outputMessage?.id;
  const hasOperatorIdentity =
    (typeof inputMessageID === 'string' && inputMessageID.length > 0) ||
    (typeof outputMessageID === 'string' && outputMessageID.length > 0);
  if (!hasOperatorIdentity) return false;
  // noReply injections never expect an operator turn.
  if (inputMessage?.noReply === true || outputMessage?.noReply === true) {
    return false;
  }
  return true;
}

/** Self-contained terminal delta appended to the stopped-job recovery wake.
 * The board snapshot path cannot serve this wake: under the
 * `checkpoint-compatible` injection strategy, internal-initiator messages
 * (which this wake is) are excluded from creating a board snapshot, so the
 * first snapshot the parent sees after the wake reflects a board state from
 * BEFORE the job stopped. A wake that says "check the board" with no board
 * entry behind it leaves the parent guessing. The delta carries the facts
 * of the triggering stop inline: alias, task id, run generation, state, and
 * why it stopped. Deduplicated per execution by the caller. */
export function formatStoppedJobDelta(record: {
  alias: string;
  taskID: string;
  generation: number;
  state: string;
  reason: string;
}): string {
  return `<stopped-job>\nalias: ${record.alias}\ntask: ${record.taskID}\ngeneration: ${record.generation}\nstate: ${record.state}\nreason: ${record.reason}\n</stopped-job>`;
}

/** Reason line for a stopped-job recovery delta. A stop committed from a
 * host-attributed interruption/cancellation DOES carry a terminal result
 * (the host's own outcome report); blaming a missing result misinforms
 * the woken parent about what recovery means here. */
export function stoppedJobRecoveryReason(record: {
  timedOut: boolean;
  statusUncertain: boolean;
  resultSummary?: string;
}): string {
  if (record.timedOut) return 'wall-clock deadline exceeded';
  if (record.statusUncertain) return 'runtime status uncertain';
  const attributed = /^Host reported outcome: (interrupted|cancelled)\./.exec(
    record.resultSummary ?? '',
  );
  if (attributed) {
    const kind =
      attributed[1] === 'interrupted' ? 'interruption' : 'cancellation';
    return `host-attributed ${kind} (terminal result present)`;
  }
  return 'stopped without a terminal result';
}

/** Wake text for a background child blocked on an open question/permission.
 * The child parks with no tokens moving and never finishes on its own; the
 * parent's turn already ended, so without this wake nobody ever answers. */
export const ORCHESTRATOR_CHILD_INPUT_WAKE_TEXT =
  '<system-reminder>\nA background child task is waiting for input and cannot proceed until the pending request is handled. Review the pending request below. Use task_reply for permission requests and for question requests only when the host exposes a supported question reply API. On OpenCode v2, form-created question requests are observable but not answerable through the pinned plugin context; answer/cancel them in the host UI if available, otherwise leave the child waiting or cancel the task. Do not respond to this reminder.\n</system-reminder>';

/** Self-contained delta for a child input-wait wake (same rationale as
 * formatStoppedJobDelta: the wake carries the facts inline). Deduplicated
 * per (taskID, requestID) by the caller. */
export function formatChildInputWaitDelta(record: {
  alias: string;
  taskID: string;
  kind: 'question' | 'permission';
  requestID: string;
  detail: string;
}): string {
  return `<child-input-wait>\nalias: ${record.alias}\ntask: ${record.taskID}\nkind: ${record.kind}\nrequest: ${record.requestID}\n${record.detail}</child-input-wait>`;
}

/** Max child-input deltas queued per parent. Same bounding policy as the
 * stopped-job recovery queue: oldest entries are dropped when a new
 * distinct ask would exceed the cap, so a busy/waiting parent cannot grow
 * an unbounded prompt. */
export const CHILD_INPUT_QUEUE_CAP = 32;

/** Max child-input deltas appended to one wake. */
export const CHILD_INPUT_WAKE_CHUNK = 4;

/** Give host/UI auto-repliers time to settle an ask before waking the parent. */
export const CHILD_INPUT_WAKE_SETTLE_MS = 250;

/** Asks that overflow the bounded child-input queue still produce a
 * durable, actionable signal. The parent runs task_status for the remaining
 * open requests whose inline details were coalesced. Same overflow-marker
 * discipline as the stopped-job recovery queue. */
export const CHILD_INPUT_OVERFLOW_TEXT =
  '<child-input-wait-overflow>\nAdditional background child input requests were queued beyond the inline detail limit. Run task_status for the remaining open requests and follow its request-specific reply guidance.\n</child-input-wait-overflow>';

/** Children-mode variant (v2 degraded mode): watchdog over background
 * children and unreconciled jobs instead of the todo list. */
export const ORCHESTRATOR_CHILDREN_WAKE_TEXT =
  '<system-reminder>\nCheck on unfinished background child sessions and unreconciled jobs. Await running agents; if one appears stuck, assess it and cancel/respawn only when justified. Do not respond to this reminder.\n</system-reminder>';

/** #1411: short core per delta-less wake template, used to build the
 * non-identical repeat marker when the same body was already delivered in
 * the session. Unmapped delta-less texts keep the full template. The
 * static wake texts themselves are never modified. Exported for unit tests
 * (marker length assertions). */
export const WAKE_REPEAT_CORES: ReadonlyMap<string, string> = new Map([
  [
    ORCHESTRATOR_WAKE_TEXT,
    'Finish any incomplete TODOs; await running agents.',
  ],
  [
    ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT,
    'A background job stopped without a terminal result; consult the Background Job Board and recover or reroute the work as needed.',
  ],
  [
    ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT_NO_BOARD,
    'A background job stopped without a terminal result; check task_status for the stopped task and recover or reroute the work as needed.',
  ],
  [
    ORCHESTRATOR_CHILDREN_WAKE_TEXT,
    'Check on unfinished background child sessions and unreconciled jobs; await running agents; assess a stuck agent before canceling or respawning.',
  ],
]);

export function wakeRepeatMarker(core: string, occurrence: number): string {
  return `<system-reminder>\nRepeat wake #${occurrence}: ${core} Do not respond to this reminder.\n</system-reminder>`;
}

/** After this many successful wakes with an unchanged fingerprint, stop. */
export const ORCHESTRATOR_WAKE_UNCHANGED_CAP = 2;

/**
 * Default per-parent throttle window for terminal-publication wakes
 * (`orchestratorWake.publicationWakeMinIntervalMs`). Bounds how often a
 * publication burst (several children finishing together) may wake one
 * idle parent; the first eligible publication wins and later ones inside
 * the window are dropped (their results ride the next board snapshot).
 */
export const DEFAULT_PUBLICATION_WAKE_MIN_INTERVAL_MS = 30_000;

/** Max stopped-job deltas queued per parent. Oldest entries are dropped
 * when a new distinct stop would exceed the cap, so a busy/waiting parent
 * cannot grow an unbounded recovery prompt. */
export const STOPPED_RECOVERY_QUEUE_CAP = 32;

/** Max deltas appended to one recovery wake. Remaining entries stay queued
 * for the next wake so a failed oversized join cannot wedge the batch. */
export const STOPPED_RECOVERY_WAKE_CHUNK = 8;

/** Recovery facts that overflow the bounded detail queue still produce a
 * durable, actionable signal. The parent can consult the board for the facts
 * whose inline details were coalesced. */
export const STOPPED_RECOVERY_OVERFLOW_TEXT =
  '<stopped-job-overflow>\nAdditional stopped-job recovery facts were queued beyond the inline detail limit. Consult the Background Job Board for all unreconciled stopped jobs.\n</stopped-job-overflow>';

/** Board-injection-off variant: overflow facts are pulled, not displayed.
 * The retained overflowed task identifiers are appended by the caller —
 * this notice alone cannot make the stops discoverable. */
export const STOPPED_RECOVERY_OVERFLOW_TEXT_NO_BOARD =
  '<stopped-job-overflow>\nAdditional stopped-job recovery facts were queued beyond the inline detail limit. The retained overflowed stopped task IDs are listed below; check `task_status` for each to see its facts.\n</stopped-job-overflow>';

/** Upper bound on task identifiers inlined in the board-less overflow
 * notice: keeps the wake prompt bounded under pathological stop floods;
 * evictions beyond the cap are reported as a count, not listed. */
export const STOPPED_RECOVERY_OVERFLOW_ID_CAP = 64;

/** Format the overflowed stopped-job keys (`taskID:generation`) as a
 * bounded identifier block for the board-less overflow notice.
 * `totalOverflowCount` is the batch's durable eviction count: it exceeds
 * the retained key list once evictions outgrow the identifier cap, and
 * the notice must report that gap honestly instead of implying full
 * coverage. */
function overflowedStoppedTaskIDs(
  keys: string[],
  totalOverflowCount: number,
): string {
  const ids = [
    ...new Set(
      keys
        .map((key) => parseRecoveryKey(key)?.taskID)
        .filter((taskID): taskID is string => typeof taskID === 'string'),
    ),
  ];
  if (ids.length === 0) {
    return `<stopped-job-overflow-ids>\nTask identifiers for the ${totalOverflowCount} overflowed stopped jobs were not retained.\n</stopped-job-overflow-ids>`;
  }
  // Retention is capped at STOPPED_RECOVERY_OVERFLOW_ID_CAP on the queue
  // side, so ids never exceed it; the honest gap is between the durable
  // eviction count and what was retained. (Multiple evictions can share
  // one taskID across generations, so report entries, not IDs.)
  const omitted = Math.max(0, totalOverflowCount - keys.length);
  return `<stopped-job-overflow-ids>\n${ids.join('\n')}${
    omitted > 0
      ? `\n(+${omitted} more overflowed entries were not retained)`
      : ''
  }\n</stopped-job-overflow-ids>`;
}

/**
 * Children-driven mode: a child with `outcome === undefined` counts as
 * inactive once its newest update evidence (host `time.updated` or a
 * tracked status change) is older than this multiple of the wake interval.
 * Bounds wakes when a child crashes mid-run without recording an outcome;
 * stopped-job recovery remains the explicit path for such children.
 */
export const CHILD_STALENESS_INTERVALS = 3;

const SUPPORTED_TODO_STATUSES = new Set([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]);

type SessionClient = OpencodeClient['session'];

/** Todo-mode host snapshot (v1): todos + children + live status map. */
type TodoModeSnapshot = {
  kind: 'todo';
  todos: Array<Record<string, unknown>>;
  children: Array<Record<string, unknown>>;
  status: Record<string, unknown>;
  model?: ContinuationModelSelection;
  archiveState?: boolean;
};

/** Children-mode snapshot (v2 degraded mode / explicit 'children'). */
type ChildrenModeSnapshot = {
  kind: 'children';
  children: Array<WakeChildInfo>;
  /** v1 status-map parent activity (v2 has no status map; the event-tracked
   * race guard covers it). */
  hostParentActive: boolean;
  model?: ContinuationModelSelection;
  archiveState?: boolean;
};

type WakeSnapshot = TodoModeSnapshot | ChildrenModeSnapshot;

/** Checkpoint verdict shared by both wake modes. */
type SnapshotVerdict = 'parent-active' | 'children-active' | 'no-work' | 'wake';

type LocalSessionState = {
  /** Invalidates local timers/async work for this hook instance. */
  generation: symbol;
  timer: ReturnType<typeof setTimeout> | undefined;
  continuousIdle: boolean;
  archived: boolean;
  /** Retry a failed forced wake with its original classification. */
  retryReason?: WakeReason;
};

/** Why an evaluation is running. 'periodic' is the interval timer;
 * 'recovery' is the stopped-job path; 'publication' is a terminal
 * completed/error publication reaching an idle parent. */
type WakeReason = 'periodic' | 'recovery' | 'publication';

export type OrchestratorWakeConfig = {
  enabled: boolean;
  intervalMs: number;
  /** Wake-condition source; resolved against host capabilities (see
   * `resolveWakeMode`). Optional for callers built before the field
   * existed — absent means 'auto'. */
  mode?: 'auto' | 'todo' | 'children';
  /** Feature flag for terminal-publication wakes: waking an idle parent
   * when the terminal gate publishes a completed/error outcome. Optional
   * for callers built before the field existed — absent means enabled. */
  wakeOnTerminalPublication?: boolean;
  /** Gate for the PERIODIC idle evaluation only. Event-driven wakes
   * (stopped-job recovery, rev>1 terminal publications, child-input asks)
   * are unaffected, and their SDK-error retry path keeps riding the timer
   * via `retryReason`. Optional for callers built before the field
   * existed — absent means enabled. */
  periodicWakeEnabled?: boolean;
  /** Per-parent minimum spacing between terminal-publication wakes
   * (1,000–2,147,483,647ms; 0 is invalid at the config layer, so the
   * throttle cannot be disabled via config — 0 exists only as a
   * test-only runtime path). Absent means
   * `DEFAULT_PUBLICATION_WAKE_MIN_INTERVAL_MS`. */
  publicationWakeMinIntervalMs?: number;
};

export type OrchestratorWakeOptions = {
  config: OrchestratorWakeConfig;
  shouldManageSession: (sessionID: string) => boolean;
  hasInputWait: (sessionID: string) => boolean;
  isFallbackInProgress?: (sessionID: string) => boolean;
  coordinator?: SessionLifecycle;
  /** Revalidate a queued stop immediately before delivering its recovery wake.
   * The callback must check both the task generation and that the current
   * record is still stopped and terminal-unreconciled. */
  isStoppedJobRecoveryCurrent?: (taskID: string, generation: number) => boolean;
  /** Revalidate a queued child input wait immediately before delivering its
   * wake. The callback must check the ask is still open for the current run
   * of the child task. */
  isChildInputWaitCurrent?: (taskID: string, requestID: string) => boolean;
  /** Resolve the session's CURRENT agent/model selection at send time
   * (#1079): a lifecycle wake must continue the parent in the mode the
   * session uses now, never a hardcoded `orchestrator`. When absent or
   * unresolved, behavior falls back to the historical orchestrator wake. */
  resolveSelection?: (sessionID: string) => Promise<SessionSelection>;
  /** True when the parent session has delegated work pending: live
   * children or terminal-unreconciled records (#1079). In that state a
   * lifecycle wake stays eligible even when the user switched the
   * session to a non-orchestrator agent — the wake continues in the
   * CURRENT selection instead of forcing `orchestrator`. */
  hasPendingDelegatedWork?: (sessionID: string) => boolean;
  /** Test seam: override interval without changing config validation. */
  intervalMs?: number;
  /** Whether the Background Job Board is injected into orchestrator
   * prompts. Stopped-recovery and overflow wake texts reference the board
   * only when it is actually visible to the model; otherwise they point at
   * `task_status` instead. Absent means enabled (v1 parity). */
  boardInjectionEnabled?: boolean;
};

/**
 * Capability record for the host session surface. The v1 branch keeps
 * exactly the historical probe set (get/todo/children/status/promptAsync);
 * the v2 branch (hostFlavor 'v2', stamped by the client shim) requires only
 * list+promptAsync — `get` is optional enrichment and todo/children/status
 * have no v2 equivalent (children-driven degraded mode covers them).
 */
export type WakeSessionApis = {
  flavor: 'v1' | 'v2';
  hasGet: boolean;
  hasTodo: boolean;
  hasChildren: boolean;
  hasStatus: boolean;
  hasList: boolean;
  hasPromptAsync: boolean;
  /** True when the scheduler can operate against this host surface. */
  ready: boolean;
};

function probeSessionApis(
  session: SessionClient | undefined,
  hostFlavor: string | undefined,
): WakeSessionApis {
  const flavor = hostFlavor === 'v2' ? ('v2' as const) : ('v1' as const);
  const caps = {
    flavor,
    hasGet: typeof session?.get === 'function',
    hasTodo: typeof session?.todo === 'function',
    hasChildren: typeof session?.children === 'function',
    hasStatus: typeof session?.status === 'function',
    hasList: typeof session?.list === 'function',
    hasPromptAsync: typeof session?.promptAsync === 'function',
  } as WakeSessionApis;
  caps.ready =
    flavor === 'v2'
      ? caps.hasList && caps.hasPromptAsync
      : caps.hasGet &&
        caps.hasTodo &&
        caps.hasChildren &&
        caps.hasStatus &&
        caps.hasPromptAsync;
  return caps;
}

export type ResolvedWakeMode = 'todo' | 'children';

/**
 * Resolve the configured wake mode against host capabilities: 'auto' uses
 * todo-gating on v1 and children-driven degraded mode on v2; an explicit
 * 'todo' degrades to children on hosts without the todo API (v2).
 */
export function resolveWakeMode(
  configured: 'auto' | 'todo' | 'children' | undefined,
  caps: Pick<WakeSessionApis, 'flavor' | 'hasTodo'>,
): ResolvedWakeMode {
  if (configured === 'children') return 'children';
  if (configured === 'todo') {
    return caps.flavor === 'v2' || !caps.hasTodo ? 'children' : 'todo';
  }
  return caps.flavor === 'v2' ? 'children' : 'todo';
}

/** Normalized child view for children-driven wake decisions. */
export type WakeChildInfo = {
  id: string;
  /** v2 Session.Info.outcome — present only on terminal transition
   * (succeeded|failed|interrupted). */
  outcome?: string;
  /** Workspace directory when the host reports it (scope filter). */
  directory?: string;
  /** Newest update-evidence timestamp (epoch ms) when known. */
  evidenceAt?: number;
};

/** Event-tracked session status (busy-set + parent-active race guard). */
export type TrackedSessionStatus = { status: 'busy' | 'idle'; at: number };

/** Numeric variant of the update-evidence cascade (staleness bound). */
export function childUpdateEvidenceMs(
  child: Record<string, unknown>,
): number | undefined {
  const time = isObjectRecord(child.time) ? child.time : undefined;
  const candidates = [
    time?.updated,
    time?.completed,
    child.updatedAt,
    child.updated,
    time?.created,
    child.createdAt,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

/** Map one host child/list entry to the normalized children-mode view. */
export function mapWakeChild(
  child: Record<string, unknown>,
): WakeChildInfo | undefined {
  if (typeof child.id !== 'string' || !child.id) return undefined;
  const info: WakeChildInfo = { id: child.id };
  if (typeof child.outcome === 'string' && child.outcome) {
    info.outcome = child.outcome;
  }
  if (typeof child.directory === 'string' && child.directory) {
    info.directory = child.directory;
  }
  const evidence = childUpdateEvidenceMs(child);
  if (evidence !== undefined) {
    info.evidenceAt = evidence;
  }
  return info;
}

/**
 * Active-child determination for children-driven mode: a terminal outcome
 * always wins; otherwise the child is active while its newest evidence —
 * host update time OR tracked status change (the event busy-set) — is
 * fresher than the staleness bound. Children with no evidence at all are
 * inactive (cannot be proven active).
 */
export function isWakeChildActive(
  child: WakeChildInfo,
  tracked: TrackedSessionStatus | undefined,
  now: number,
  stalenessMs: number,
): boolean {
  if (child.outcome !== undefined) return false;
  const evidenceAt = Math.max(child.evidenceAt ?? 0, tracked?.at ?? 0);
  if (evidenceAt <= 0) return false;
  return now - evidenceAt <= stalenessMs;
}

/** Children-mode fingerprint: id + outcome + tracked status + evidence. */
export function buildChildrenWakeFingerprint(
  children: Array<WakeChildInfo>,
  trackedStatuses: ReadonlyMap<string, TrackedSessionStatus>,
): string {
  return children
    .map((child) => {
      const tracked = trackedStatuses.get(child.id);
      return [
        child.id,
        child.outcome ?? '',
        tracked?.status ?? '',
        String(child.evidenceAt ?? ''),
      ].join(':');
    })
    .sort()
    .join('\n');
}

function isIncompleteTodoStatus(status: string): boolean {
  return status === 'pending' || status === 'in_progress';
}

function todosHaveValidStatuses(
  todos: Array<Record<string, unknown>>,
): boolean {
  return todos.every(
    (todo) =>
      typeof todo.status === 'string' &&
      SUPPORTED_TODO_STATUSES.has(todo.status),
  );
}

function hasIncompleteTodos(todos: Array<Record<string, unknown>>): boolean {
  return todos.some(
    (todo) =>
      typeof todo.status === 'string' && isIncompleteTodoStatus(todo.status),
  );
}

function hasActiveChild(
  children: Array<Record<string, unknown>>,
  status: Record<string, unknown>,
): boolean {
  return children.some(
    (child) => typeof child.id === 'string' && isActiveStatus(status, child.id),
  );
}

function todoFingerprint(todos: Array<Record<string, unknown>>): string {
  return todos
    .map((todo) => {
      const id =
        typeof todo.id === 'string'
          ? todo.id
          : typeof todo.content === 'string'
            ? todo.content
            : '';
      return `${id}:${String(todo.status)}`;
    })
    .sort()
    .join('\n');
}

function childUpdateEvidence(child: Record<string, unknown>): string {
  const time = isObjectRecord(child.time) ? child.time : undefined;
  const candidates = [
    time?.updated,
    time?.completed,
    child.updatedAt,
    child.updated,
    time?.created,
    child.createdAt,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' || typeof value === 'string') {
      return String(value);
    }
  }
  return '';
}

function childStatusEvidence(
  childID: string,
  status: Record<string, unknown>,
): string {
  if (!Object.hasOwn(status, childID)) return 'absent';
  const entry = status[childID];
  if (!isObjectRecord(entry)) return 'malformed';
  return typeof entry.type === 'string' ? entry.type : 'active';
}

function childrenFingerprint(
  children: Array<Record<string, unknown>>,
  status: Record<string, unknown>,
): string {
  return children
    .map((child) => {
      const id = String(child.id);
      return `${id}:${childStatusEvidence(id, status)}:${childUpdateEvidence(child)}`;
    })
    .sort()
    .join('\n');
}

export function buildOrchestratorWakeFingerprint(
  todos: Array<Record<string, unknown>>,
  children: Array<Record<string, unknown>>,
  status: Record<string, unknown>,
): string {
  return `${todoFingerprint(todos)}\n--\n${childrenFingerprint(children, status)}`;
}

function extractSessionID(event: {
  properties?: unknown;
  data?: unknown;
}): string | undefined {
  const payload = isObjectRecord(event.data)
    ? event.data
    : isObjectRecord(event.properties)
      ? event.properties
      : undefined;
  const info = isObjectRecord(payload?.info) ? payload.info : payload;
  if (typeof info?.id === 'string' && info.id) return info.id;
  if (typeof payload?.sessionID === 'string' && payload.sessionID) {
    return payload.sessionID;
  }
  return undefined;
}

function readSessionArchiveState(session: unknown): boolean | undefined {
  if (
    !isObjectRecord(session) ||
    Array.isArray(session) ||
    !isObjectRecord(session.time) ||
    Array.isArray(session.time)
  ) {
    return undefined;
  }
  const archived = session.time.archived;
  if (archived === undefined || archived === null) return false;
  return typeof archived === 'number' && Number.isFinite(archived)
    ? true
    : undefined;
}

function readEventArchiveState(event: {
  properties?: unknown;
  data?: unknown;
}): boolean | undefined {
  const payload = isObjectRecord(event.data)
    ? event.data
    : isObjectRecord(event.properties)
      ? event.properties
      : undefined;
  const info = isObjectRecord(payload?.info) ? payload.info : payload;
  return readSessionArchiveState(info);
}

function isIdleEvent(
  type: string,
  properties?: { status?: { type?: string } },
) {
  return (
    type === 'session.idle' ||
    (type === 'session.status' && properties?.status?.type === 'idle')
  );
}

function isBusyEvent(
  type: string,
  properties?: { status?: { type?: string } },
): boolean {
  return type === 'session.status' && properties?.status?.type === 'busy';
}

function isInputWaitAskEvent(type: string): boolean {
  return type === 'permission.asked' || type === 'question.asked';
}

/** One wake kind's queued deltas for one parent session. */
type DeltaBatch = {
  deltas: Map<string, string>;
  /** Number of detail entries coalesced beyond the bounded queue. */
  overflowCount: number;
  /** Keys of entries dropped by the cap, newest-first-drop order. The
   * board-less overflow notice inlines these task identifiers so the
   * parent can still discover every overflowed stop (the board is not a
   * fallback there and `task_status` needs a known id). */
  overflowedKeys: string[];
};

type DeltaQueuePolicy = {
  /** Max deltas per parent; the oldest is dropped with an overflow bump. */
  cap: number;
  /** scheduleBlocker trigger name used when this queue's wake is blocked. */
  blockerTrigger: 'stopped-job-recovery' | 'child-input';
  /** Whether a queued delta is still actionable (unparseable keys are not). */
  isCurrent?: (key: string) => boolean;
};

type DeltaQueue = DeltaQueuePolicy & {
  batches: Map<string, DeltaBatch>;
  add: (sessionID: string, delta: string, dedupeKey?: string) => void;
  prune: (batch: DeltaBatch | undefined) => boolean;
};

/** A bounded, deduplicated delta queue feeding one delta wake kind. Both
 * wake queues (stopped-job recovery, child-input) share one shape:
 * per-parent batches, overflow expressed as a durable count plus an inline
 * signal, and retire-only-what-was-sent on delivery. Differences (cap,
 * blocker trigger, actionability predicate) are construction-time policy;
 * the shared body stays branch-free. */
function makeDeltaQueue(policy: DeltaQueuePolicy): DeltaQueue {
  const batches = new Map<string, DeltaBatch>();

  /** Queue a delta for the session's next wake of this kind. */
  const add = (sessionID: string, delta: string, dedupeKey?: string): void => {
    let batch = batches.get(sessionID);
    if (!batch) {
      batch = { deltas: new Map(), overflowCount: 0, overflowedKeys: [] };
      batches.set(sessionID, batch);
    }
    const key = dedupeKey ?? delta;
    if (batch.deltas.has(key)) {
      batch.deltas.set(key, delta);
      return;
    }
    while (batch.deltas.size >= policy.cap) {
      const oldest = batch.deltas.keys().next().value;
      if (oldest === undefined) break;
      batch.deltas.delete(oldest);
      batch.overflowCount += 1;
      // Bound the retained identifiers (see STOPPED_RECOVERY_OVERFLOW_ID_CAP):
      // under a pathological stop flood the notice stays honest about how
      // many overflowed without growing without limit in memory.
      if (batch.overflowedKeys.length < STOPPED_RECOVERY_OVERFLOW_ID_CAP) {
        batch.overflowedKeys.push(oldest);
      }
    }
    batch.deltas.set(key, delta);
  };

  /** Drop deltas that are no longer current. Repeat after every await so a
   * delta answered or revived during selection resolve is not sent. Returns
   * whether the batch held any details before pruning. */
  const prune = (batch: DeltaBatch | undefined): boolean => {
    if (!batch) return false;
    const hadDetails = batch.deltas.size > 0;
    if (policy.isCurrent) {
      for (const key of batch.deltas.keys()) {
        let current = false;
        try {
          current = policy.isCurrent(key);
        } catch {
          current = false;
        }
        if (!current) batch.deltas.delete(key);
      }
    }
    return hadDetails;
  };

  return { ...policy, batches, add, prune };
}

/** Prune a batch and report whether its pruned details ran completely dry.
 * Callers decide deletion and wake-end; an overflow marker keeps a batch
 * alive even when every retained detail has gone stale. */
function prunedToEmpty(queue: DeltaQueue, batch: DeltaBatch): boolean {
  const hadDetails = queue.prune(batch);
  return hadDetails && batch.deltas.size === 0 && batch.overflowCount === 0;
}

function parseChildInputKey(
  key: string,
): { taskID: string; requestID: string } | undefined {
  const separator = key.indexOf(':');
  if (separator <= 0) return undefined;
  const taskID = key.slice(0, separator);
  const requestID = key.slice(separator + 1);
  return taskID && requestID ? { taskID, requestID } : undefined;
}

function parseRecoveryKey(
  key: string,
): { taskID: string; generation: number } | undefined {
  const separator = key.lastIndexOf(':');
  if (separator <= 0) return undefined;
  const taskID = key.slice(0, separator);
  const generation = Number(key.slice(separator + 1));
  return taskID && Number.isSafeInteger(generation) && generation >= 0
    ? { taskID, generation }
    : undefined;
}

export function createOrchestratorWakeScheduler(
  ctx: PluginInput,
  options: OrchestratorWakeOptions,
) {
  const intervalMs = options.intervalMs ?? options.config.intervalMs;
  const enabled = options.config.enabled === true;
  const periodicWakeEnabled = options.config.periodicWakeEnabled ?? true;
  const boardInjectionEnabled = options.boardInjectionEnabled ?? true;
  const wakeOnTerminalPublication =
    options.config.wakeOnTerminalPublication ?? true;
  const publicationWakeMinIntervalMs =
    options.config.publicationWakeMinIntervalMs ??
    DEFAULT_PUBLICATION_WAKE_MIN_INTERVAL_MS;
  const directory = ctx.directory;
  const sessionSdk = (ctx.client as OpencodeClient).session;

  /** Static host-surface capability record (the client never changes). */
  const capabilities = probeSessionApis(
    sessionSdk,
    (ctx as PluginInput & { hostFlavor?: string }).hostFlavor,
  );
  const wakeMode = resolveWakeMode(options.config.mode, capabilities);
  if (enabled && capabilities.flavor === 'v2' && !capabilities.hasTodo) {
    log(
      '[orchestrator-wake] host provides no session todo API; running in children-driven degraded mode',
      { directory },
    );
  }

  /** Local timer/generation state only; progress lives in the process gate. */
  const localSessions = new Map<string, LocalSessionState>();
  /** Bound repeated idle diagnostics (v2 delivers both idle event shapes). */
  const reportedScheduleBlockers = new Map<string, Set<string>>();
  /** Reservations this hook owns and must release when it is disposed. */
  const localWakeOwners = new Map<string, symbol>();
  /** This hook's token in the process-global wake gate: its disposal drops
   * the gate state of sessions no other live hook serves. */
  const gateHolder = Symbol('orchestrator-wake-hook');
  function noteGateSession(sessionID: string): void {
    claimWakeSession(sessionID, gateHolder);
  }
  const recoveryCurrent = options.isStoppedJobRecoveryCurrent;
  /** Sessions with a stopped job awaiting a recovery wake, carrying the
   * self-contained terminal deltas of the triggering stops (see
   * `formatStoppedJobDelta`), deduplicated per execution by
   * `(taskID, generation)`. Bounded per parent (`STOPPED_RECOVERY_QUEUE_CAP`);
   * each wake sends at most `STOPPED_RECOVERY_WAKE_CHUNK` entries. Overflow
   * is represented by a durable count and an inline signal rather than being
   * silently discarded. Deltas that arrive while a recovery wake is in flight
   * must survive its confirmation: only the keys actually sent are retired on
   * delivery. */
  const stoppedRecoveryQueue = makeDeltaQueue({
    cap: STOPPED_RECOVERY_QUEUE_CAP,
    blockerTrigger: 'stopped-job-recovery',
    isCurrent: recoveryCurrent
      ? (key) => {
          const parsed = parseRecoveryKey(key);
          return parsed
            ? recoveryCurrent(parsed.taskID, parsed.generation)
            : false;
        }
      : undefined,
  });
  const pendingStoppedRecoveries = stoppedRecoveryQueue.batches;

  /** Last delivered publication wake per parent (epoch ms), for the
   * `publicationWakeMinIntervalMs` throttle. Direct, timer and waiter
   * deliveries all consume the window; failed attempts do not. */
  const lastPublicationWakeAt = new Map<string, number>();

  const childInputCurrent = options.isChildInputWaitCurrent;
  /** Sessions with a background child awaiting an input-wait wake, carrying
   * the self-contained ask deltas (see `formatChildInputWaitDelta`),
   * deduplicated per `(taskID, requestID)`. Bounded per parent
   * (`CHILD_INPUT_QUEUE_CAP`); each wake sends at most
   * `CHILD_INPUT_WAKE_CHUNK` entries. Overflow is represented by a durable
   * count and an inline signal rather than being silently discarded. Same
   * retire-only-what-was-sent discipline as the stopped-job queue. */
  const childInputQueue = makeDeltaQueue({
    cap: CHILD_INPUT_QUEUE_CAP,
    blockerTrigger: 'child-input',
    isCurrent: childInputCurrent
      ? (key) => {
          const parsed = parseChildInputKey(key);
          return parsed
            ? childInputCurrent(parsed.taskID, parsed.requestID)
            : false;
        }
      : undefined,
  });
  const pendingChildInputWakes = childInputQueue.batches;
  const childInputTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearChildInputTimer(sessionID: string): void {
    const timer = childInputTimers.get(sessionID);
    if (timer === undefined) return;
    clearTimeout(timer);
    childInputTimers.delete(sessionID);
  }

  /** Event-tracked session statuses (busy-set + parent race guard). */
  const lastStatusBySession = new Map<string, TrackedSessionStatus>();
  /** parentID → child session ids observed via session.created events. */
  const childSessions = new Map<string, Set<string>>();
  /** Newest event evidence (created/status change) per child, epoch ms. */
  const childEvidence = new Map<string, number>();
  let disposed = false;

  /** Bound for the event-tracked bookkeeping maps (FIFO eviction). */
  const MAX_EVENT_TRACKED_SESSIONS = 512;

  function boundTrackedMap<T>(map: Map<string, T>): void {
    while (map.size > MAX_EVENT_TRACKED_SESSIONS) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  function recordTrackedStatus(
    sessionID: string,
    status: 'busy' | 'idle',
  ): void {
    const now = Date.now();
    lastStatusBySession.set(sessionID, { status, at: now });
    boundTrackedMap(lastStatusBySession);
    if (childEvidence.has(sessionID)) {
      childEvidence.set(sessionID, now);
      boundTrackedMap(childEvidence);
    }
  }

  function recordChildSession(parentID: string, childID: string): void {
    let kids = childSessions.get(parentID);
    if (!kids) {
      kids = new Set();
      childSessions.set(parentID, kids);
      boundTrackedMap(childSessions);
    }
    kids.add(childID);
    childEvidence.set(childID, Date.now());
    boundTrackedMap(childEvidence);
  }

  function forgetSessionEvents(sessionID: string): void {
    lastStatusBySession.delete(sessionID);
    childEvidence.delete(sessionID);
    childSessions.delete(sessionID);
    for (const kids of childSessions.values()) {
      kids.delete(sessionID);
    }
  }

  function isParentActiveByEvents(sessionID: string): boolean {
    return lastStatusBySession.get(sessionID)?.status === 'busy';
  }

  function touchLocal(sessionID: string): LocalSessionState {
    noteGateSession(sessionID);
    const existing = localSessions.get(sessionID);
    if (existing) return existing;
    const created: LocalSessionState = {
      generation: Symbol(sessionID),
      timer: undefined,
      continuousIdle: false,
      archived: false,
    };
    localSessions.set(sessionID, created);
    return created;
  }

  function clearTimer(state: LocalSessionState): void {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  }

  function bumpGeneration(state: LocalSessionState): void {
    state.generation = Symbol('wake-generation');
    state.retryReason = undefined;
  }

  function clearLocalSession(sessionID: string): void {
    const state = localSessions.get(sessionID);
    if (!state) return;
    clearTimer(state);
    bumpGeneration(state);
    localSessions.delete(sessionID);
  }

  function releaseLocalWakeOwner(sessionID: string): void {
    const owner = localWakeOwners.get(sessionID);
    if (!owner) return;
    localWakeOwners.delete(sessionID);
    releaseWakeEvaluation(sessionID, owner);
  }

  function clearSession(sessionID: string): void {
    clearChildInputTimer(sessionID);
    releaseLocalWakeOwner(sessionID);
    clearLocalSession(sessionID);
    clearWakeSession(sessionID);
    pendingStoppedRecoveries.delete(sessionID);
    lastPublicationWakeAt.delete(sessionID);
    pendingChildInputWakes.delete(sessionID);
    reportedScheduleBlockers.delete(sessionID);
  }

  function suppressArchivedSession(sessionID: string): void {
    clearChildInputTimer(sessionID);
    const state = touchLocal(sessionID);
    clearTimer(state);
    bumpGeneration(state);
    state.continuousIdle = false;
    state.archived = true;
    releaseLocalWakeOwner(sessionID);
  }

  function restoreArchivedSession(sessionID: string): void {
    const state = localSessions.get(sessionID);
    if (!state?.archived) return;
    clearTimer(state);
    bumpGeneration(state);
    state.continuousIdle = false;
    state.archived = false;
    releaseLocalWakeOwner(sessionID);
    rearmWakeProgress(sessionID);
  }

  /**
   * Suppress scheduling without dropping process-global progress.
   * Used for input waits and temporary blocks.
   */
  function suppress(sessionID: string): void {
    clearChildInputTimer(sessionID);
    const state = localSessions.get(sessionID);
    if (!state) return;
    clearTimer(state);
    bumpGeneration(state);
    state.continuousIdle = false;
    releaseLocalWakeOwner(sessionID);
  }

  /**
   * End a continuous idle spell. When `rearmProgress` is true, reset the
   * process-global no-progress cap (external busy / lifecycle). Wake-initiated
   * busy must pass false so the two-wake cap survives busy→idle.
   */
  function endIdleSpell(sessionID: string, rearmProgress: boolean): void {
    const state = localSessions.get(sessionID);
    if (state) {
      clearTimer(state);
      bumpGeneration(state);
      state.continuousIdle = false;
    }
    releaseLocalWakeOwner(sessionID);
    reportedScheduleBlockers.delete(sessionID);
    if (rearmProgress) rearmWakeProgress(sessionID);
  }

  /** #1079: a parent with delegated work pending stays wake-eligible
   * even after the user switched it to a non-orchestrator agent — the
   * wake then continues in the CURRENT selection (resolveSelection)
   * instead of being dropped or forcing `orchestrator`. Without
   * pending delegated work, only orchestrator sessions schedule wakes
   * (a random Plan/Build TODO must not become a wake reason). */
  function canObserveSelection(sessionID: string): boolean {
    return (
      options.shouldManageSession(sessionID) ||
      (options.hasPendingDelegatedWork?.(sessionID) ?? false)
    );
  }

  function scheduleBlocker(
    sessionID: string,
    scheduleOptions?: { ignoreProgressCap?: boolean },
  ): string | undefined {
    if (!enabled) return 'disabled';
    if (!capabilities.ready) return 'host-apis-unavailable';
    if (!canObserveSelection(sessionID)) return 'unmanaged';
    if (localSessions.get(sessionID)?.archived) return 'archived';
    if (options.hasInputWait(sessionID)) return 'input-wait';
    if (options.isFallbackInProgress?.(sessionID))
      return 'fallback-in-progress';
    // The no-progress cap normally blocks re-entry after two unchanged
    // wakes. A terminal-publication wake deliberately bypasses ONLY this
    // clause: the in-evaluation fingerprint comparison is the authoritative
    // progress test there (a publication changes the children fingerprint,
    // so noteHostProgress un-stops a genuinely progressed session, while an
    // unchanged fingerprint keeps the cap tripped).
    if (
      !scheduleOptions?.ignoreProgressCap &&
      getWakeProgress(sessionID).stopped
    )
      return 'progress-cap';
    return undefined;
  }

  function reportScheduleBlocker(
    sessionID: string,
    reason: string,
    trigger?: 'stopped-job-recovery' | 'child-input',
  ): void {
    let reasons = reportedScheduleBlockers.get(sessionID);
    if (!reasons) {
      reasons = new Set();
      reportedScheduleBlockers.set(sessionID, reasons);
      if (reportedScheduleBlockers.size > MAX_EVENT_TRACKED_SESSIONS) {
        const oldest = reportedScheduleBlockers.keys().next().value;
        if (oldest !== undefined) reportedScheduleBlockers.delete(oldest);
      }
    }
    const key = trigger ? `${trigger}:${reason}` : reason;
    if (reasons.has(key)) return;
    reasons.add(key);
    if (trigger) {
      log('[orchestrator-wake] forced wake blocked', {
        sessionID,
        trigger,
        reason,
      });
    } else {
      log('[orchestrator-wake] backstop not armed', { sessionID, reason });
    }
  }

  function schedule(sessionID: string): void {
    const blocker = scheduleBlocker(sessionID);
    if (blocker) {
      reportScheduleBlocker(sessionID, blocker);
      return;
    }
    const state = touchLocal(sessionID);
    if (!state.continuousIdle || state.timer !== undefined) return;
    if (getWakeProgress(sessionID).stopped) return;

    const generation = state.generation;
    const timer = setTimeout(() => {
      state.timer = undefined;
      if (state.generation !== generation) return;
      const reason = state.retryReason ?? 'periodic';
      // Periodic-arm gate only: recovery/publication wakes that failed on
      // an SDK error ride this same timer through `retryReason` and must
      // still deliver while the periodic evaluation is disabled.
      if (reason === 'periodic' && !periodicWakeEnabled) return;
      void evaluate(sessionID, generation, reason);
    }, intervalMs);
    timer.unref?.();
    state.timer = timer;
    log('[orchestrator-wake] backstop armed', { sessionID, intervalMs });
    reportedScheduleBlockers.delete(sessionID);
  }

  function beginContinuousIdle(sessionID: string): void {
    const state = localSessions.get(sessionID);
    if (state?.archived) {
      if (
        enabled &&
        capabilities.ready &&
        typeof sessionSdk.get === 'function'
      ) {
        void refreshArchivedSession(sessionID, state.generation);
      }
      return;
    }
    const blocker = scheduleBlocker(sessionID);
    if (blocker) {
      reportScheduleBlocker(sessionID, blocker);
      return;
    }
    const idleState = touchLocal(sessionID);
    if (idleState.continuousIdle && idleState.timer !== undefined) return;
    idleState.continuousIdle = true;
    if (getWakeProgress(sessionID).stopped) return;
    if (idleState.timer === undefined) schedule(sessionID);
  }

  type SessionMetadata = {
    model?: ContinuationModelSelection;
    archiveState?: boolean;
  };

  /** Fail-soft session-model and archive-state enrichment. */
  async function readSessionModel(sessionID: string): Promise<SessionMetadata> {
    if (typeof sessionSdk?.get !== 'function') return {};
    try {
      const sessionResponse = await sessionSdk.get({
        path: { id: sessionID },
        query: { directory },
        throwOnError: true,
      });
      // Session.model is version-dependent; read via record shape.
      const session = isObjectRecord(sessionResponse?.data)
        ? sessionResponse.data
        : undefined;
      return {
        model: parseContinuationModelSelection(
          session ? (session as Record<string, unknown>).model : undefined,
        ),
        archiveState: readSessionArchiveState(session),
      };
    } catch {
      // Model and archive enrichment are fail-soft; lifecycle events remain
      // the v2 source when session.get is unavailable or fails.
      return {};
    }
  }

  async function refreshArchivedSession(
    sessionID: string,
    generation: symbol,
  ): Promise<void> {
    const { archiveState } = await readSessionModel(sessionID);
    const state = localSessions.get(sessionID);
    if (
      !state ||
      state.generation !== generation ||
      !state.archived ||
      archiveState !== false
    ) {
      return;
    }
    restoreArchivedSession(sessionID);
  }

  function applyArchiveState(
    sessionID: string,
    state: LocalSessionState,
    archiveState: boolean | undefined,
  ): boolean {
    if (state.archived) {
      if (archiveState === false) {
        restoreArchivedSession(sessionID);
      } else {
        suppressArchivedSession(sessionID);
      }
      return true;
    }
    if (archiveState === true) {
      suppressArchivedSession(sessionID);
      return true;
    }
    return false;
  }

  async function readHostSnapshot(
    sessionID: string,
  ): Promise<TodoModeSnapshot | undefined> {
    if (!capabilities.ready) return undefined;

    const dirQuery = { directory };
    const [todoResponse, childrenResponse, statusResponse] = await Promise.all([
      sessionSdk.todo({
        path: { id: sessionID },
        query: dirQuery,
        throwOnError: true,
      }),
      sessionSdk.children({
        path: { id: sessionID },
        query: dirQuery,
        throwOnError: true,
      }),
      sessionSdk.status({
        query: dirQuery,
        throwOnError: true,
      }),
    ]);

    if (
      !Array.isArray(todoResponse.data) ||
      !Array.isArray(childrenResponse.data) ||
      !isObjectRecord(statusResponse.data)
    ) {
      return undefined;
    }

    const todos = todoResponse.data;
    const children = childrenResponse.data;
    const status = statusResponse.data;

    if (
      !todos.every(
        (todo) => isObjectRecord(todo) && typeof todo.status === 'string',
      ) ||
      !todosHaveValidStatuses(todos as Array<Record<string, unknown>>) ||
      !children.every(
        (child) => isObjectRecord(child) && typeof child.id === 'string',
      )
    ) {
      return undefined;
    }

    const { model, archiveState } = await readSessionModel(sessionID);

    return {
      kind: 'todo',
      todos: todos as Array<Record<string, unknown>>,
      children: children as Array<Record<string, unknown>>,
      status,
      model,
      archiveState,
    };
  }

  /**
   * Children-driven degraded mode snapshot (v2, or explicit 'children' on
   * v1). Children are enumerated via `session.list({parentID})` through the
   * shim; when the listing is unavailable (missing/erroring/empty) the
   * event-tracked bookkeeping (session.created parentID links + tracked
   * statuses) is the fallback. Results are scoped to this workspace and
   * enriched with the session model (fail-soft).
   */
  async function readChildrenSnapshot(
    sessionID: string,
  ): Promise<ChildrenModeSnapshot | undefined> {
    if (!capabilities.ready) return undefined;

    let children: Array<WakeChildInfo> | undefined;
    let hostParentActive = false;

    if (capabilities.flavor === 'v2') {
      try {
        const response = (await sessionSdk.list({
          query: { parentID: sessionID, directory },
        } as Parameters<SessionClient['list']>[0])) as { data?: unknown };
        if (Array.isArray(response?.data)) {
          children = response.data
            .filter(isObjectRecord)
            .map(mapWakeChild)
            .filter((child): child is WakeChildInfo => child !== undefined);
        }
      } catch (error) {
        log(
          '[orchestrator-wake] session.list child enumeration failed; using event-tracked fallback',
          {
            sessionID,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    } else {
      const dirQuery = { directory };
      const [childrenResponse, statusResponse] = await Promise.all([
        sessionSdk.children({
          path: { id: sessionID },
          query: dirQuery,
          throwOnError: true,
        }),
        sessionSdk.status({
          query: dirQuery,
          throwOnError: true,
        }),
      ]);
      if (
        !Array.isArray(childrenResponse.data) ||
        !isObjectRecord(statusResponse.data)
      ) {
        return undefined;
      }
      if (
        !childrenResponse.data.every(
          (child) => isObjectRecord(child) && typeof child.id === 'string',
        )
      ) {
        return undefined;
      }
      children = childrenResponse.data
        .filter(isObjectRecord)
        .map(mapWakeChild)
        .filter((child): child is WakeChildInfo => child !== undefined);
      hostParentActive = isActiveStatus(statusResponse.data, sessionID);
    }

    if (children === undefined || children.length === 0) {
      const trackedKids = childSessions.get(sessionID);
      children = trackedKids
        ? [...trackedKids].map((id) => {
            const evidenceAt = childEvidence.get(id);
            return evidenceAt === undefined ? { id } : { id, evidenceAt };
          })
        : [];

      // Event-tracked children carry no `outcome` and their local evidence
      // can go stale while the child is still running. The host is
      // authoritative on every evaluation, so refresh EVERY fallback child
      // via session.get: a live child never drops out of the watchdog on
      // stale local evidence, and a discovered terminal outcome stays in the
      // snapshot so the wake fingerprint does not flip between terminal and
      // unknown (which would spuriously rearm the no-progress cap). Fail-soft
      // per child; extra calls are bounded by the tracked-children set and
      // the evaluation cadence.
      const getSession = sessionSdk.get;
      if (
        capabilities.flavor === 'v2' &&
        typeof getSession === 'function' &&
        children.length > 0
      ) {
        children = await Promise.all(
          children.map(async (child) => {
            try {
              const response = (await getSession({
                path: { id: child.id },
                query: { directory },
                throwOnError: true,
              })) as { data?: unknown };
              const session = isObjectRecord(response?.data)
                ? response.data
                : undefined;
              if (!session) return child;
              const outcome =
                typeof session.outcome === 'string' && session.outcome
                  ? session.outcome
                  : undefined;
              const evidence = childUpdateEvidenceMs(session);
              const enriched: WakeChildInfo = { ...child };
              if (outcome) enriched.outcome = outcome;
              if (
                evidence !== undefined &&
                (child.evidenceAt === undefined || evidence > child.evidenceAt)
              ) {
                enriched.evidenceAt = evidence;
              }
              return enriched;
            } catch {
              return child;
            }
          }),
        );
      }
    }

    // Workspace scoping: drop children the host reports under another
    // directory (only when the info is available).
    children = children.filter(
      (child) => child.directory === undefined || child.directory === directory,
    );

    const { model, archiveState } = await readSessionModel(sessionID);

    return {
      kind: 'children',
      children,
      hostParentActive,
      model,
      archiveState,
    };
  }

  /** Active-child check for children-driven mode (see isWakeChildActive). */
  function hasActiveWakeChild(children: Array<WakeChildInfo>): boolean {
    const now = Date.now();
    const stalenessMs = intervalMs * CHILD_STALENESS_INTERVALS;
    return children.some((child) =>
      isWakeChildActive(
        child,
        lastStatusBySession.get(child.id),
        now,
        stalenessMs,
      ),
    );
  }

  /**
   * Classify a snapshot at a wake checkpoint. The todo branch is the exact
   * v1 check sequence (host status map → active-child suppression →
   * incomplete-todo condition); children mode replaces the status-map
   * lookups with the event-tracked parent guard and the outcome-based child
   * check (active children are inspected for periodic progress before a wake;
   * recovery and terminal-publication wakes bypass that check, as on v1).
   *
   * `forceWake` covers both non-periodic reasons (stopped-job recovery and
   * terminal publication): each is externally evidenced work whose wake
   * condition is the event itself, not the snapshot's summary of remaining
   * work. Without the flag an idle parent with no active children (and no
   * incomplete todos) classifies 'no-work' and the wake silently no-ops.
   */
  function classifyTodoSnapshot(
    snapshot: TodoModeSnapshot,
    sessionID: string,
    forceWake: boolean,
  ): SnapshotVerdict {
    if (isActiveStatus(snapshot.status, sessionID)) return 'parent-active';
    if (!forceWake && hasActiveChild(snapshot.children, snapshot.status)) {
      return 'children-active';
    }
    if (!forceWake && !hasIncompleteTodos(snapshot.todos)) {
      return 'no-work';
    }
    return 'wake';
  }

  function classifyChildrenSnapshot(
    snapshot: ChildrenModeSnapshot,
    sessionID: string,
    forceWake: boolean,
  ): SnapshotVerdict {
    if (snapshot.hostParentActive || isParentActiveByEvents(sessionID)) {
      return 'parent-active';
    }
    if (!forceWake && !hasActiveWakeChild(snapshot.children)) {
      return 'no-work';
    }
    return 'wake';
  }

  function classifySnapshot(
    snapshot: WakeSnapshot,
    sessionID: string,
    forceWake: boolean,
    checkpoint: 'initial' | 'recheck',
    trigger: WakeReason,
  ): SnapshotVerdict {
    const verdict =
      snapshot.kind === 'children'
        ? classifyChildrenSnapshot(snapshot, sessionID, forceWake)
        : classifyTodoSnapshot(snapshot, sessionID, forceWake);
    // Observation only: every checkpoint classification lands in the log
    // so a wake that is starved or wedged stays diagnosable.
    log('[orchestrator-wake] evaluate verdict', {
      sessionID,
      verdict,
      mode: snapshot.kind,
      checkpoint,
      recoveryWake: trigger === 'recovery',
      trigger,
      childCount: snapshot.children.length,
    });
    return verdict;
  }

  function buildSnapshotFingerprint(snapshot: WakeSnapshot): string {
    return snapshot.kind === 'children'
      ? buildChildrenWakeFingerprint(snapshot.children, lastStatusBySession)
      : buildOrchestratorWakeFingerprint(
          snapshot.todos,
          snapshot.children,
          snapshot.status,
        );
  }

  /**
   * Periodic wakes are a pure stalled-child watchdog. Normal progress is
   * not actionable, and neither is the first baseline observation: the
   * parent just dispatched its children and knows they are running, and
   * every real delta arrives through forced event paths (terminal
   * publication, stopped-job recovery, child input). Only a stable
   * fingerprint — no evidence change since the previous checkpoint —
   * keeps the wake, so the existing unchanged cap bounds the probes.
   */
  function deferPeriodicProgressWake(
    sessionID: string,
    reason: WakeReason,
    checkpoint: 'initial' | 'recheck',
    verdict: SnapshotVerdict,
    fingerprint: string,
  ): SnapshotVerdict {
    if (
      reason !== 'periodic' ||
      wakeMode !== 'children' ||
      verdict !== 'wake'
    ) {
      return verdict;
    }

    const progress = getWakeProgress(sessionID);
    if (progress.lastFingerprint === fingerprint) {
      return verdict;
    }

    const firstBaseline = progress.lastFingerprint === undefined;
    noteHostProgress(sessionID, fingerprint);
    log('[orchestrator-wake] periodic wake deferred', {
      sessionID,
      trigger: reason,
      checkpoint,
      reason: firstBaseline ? 'baseline-established' : 'child-progress',
    });
    return 'children-active';
  }

  /** Apply a checkpoint verdict; false means the evaluation ended. */
  function applySnapshotVerdict(
    sessionID: string,
    verdict: SnapshotVerdict,
    checkpoint: 'initial' | 'recheck',
    trigger: WakeReason,
  ): boolean {
    if (verdict !== 'wake') {
      log(
        verdict === 'children-active'
          ? '[orchestrator-wake] evaluate deferred'
          : '[orchestrator-wake] evaluate aborted',
        { sessionID, trigger, checkpoint, reason: verdict },
      );
    }
    if (verdict === 'parent-active') {
      endIdleSpell(sessionID, true);
      return false;
    }
    if (verdict === 'children-active') {
      schedule(sessionID);
      return false;
    }
    if (verdict === 'no-work') {
      // No incomplete work: end the spell; do not keep polling.
      endIdleSpell(sessionID, false);
      return false;
    }
    return true;
  }

  /** Evaluate one wake for `sessionID`. Resolves to true ONLY when this
   * evaluation actually queued/delivered a wake admission (the
   * promptAsync success path); every vetoed, stale, suppressed, or
   * errored exit resolves false so callers that gate side effects on
   * delivery burn nothing on a no-delivery evaluation. The publication
   * throttle is stamped here so timer and one-flight waiter deliveries
   * count even when the original trigger returned undelivered. */
  async function evaluate(
    sessionID: string,
    generation: symbol,
    reason: WakeReason = 'periodic',
  ): Promise<boolean> {
    const recoveryWake = reason === 'recovery';
    // Idle/retry paths must not bypass the settling window. Stopped-job
    // recoveries still run immediately, without carrying unsettled asks.
    if (
      recoveryWake &&
      childInputTimers.has(sessionID) &&
      !pendingStoppedRecoveries.has(sessionID)
    ) {
      return false;
    }
    const scheduleOptions = {
      ignoreProgressCap: reason === 'publication',
    };
    const state = localSessions.get(sessionID);
    if (!state || state.generation !== generation) return false;
    if (!state.continuousIdle) return false;
    if (state.archived) return false;
    const startBlocker = scheduleBlocker(sessionID, scheduleOptions);
    if (startBlocker) {
      log('[orchestrator-wake] evaluate aborted', {
        sessionID,
        trigger: reason,
        checkpoint: 'start',
        reason: startBlocker,
      });
      suppress(sessionID);
      return false;
    }

    const owner = tryBeginWakeEvaluation(sessionID);
    if (!owner) {
      retryAfterWakeEvaluation(sessionID, () => {
        const current = localSessions.get(sessionID);
        if (
          current === state &&
          current.generation === generation &&
          current.continuousIdle
        ) {
          void evaluate(sessionID, generation, reason);
        }
      });
      return false;
    }
    localWakeOwners.set(sessionID, owner);

    // #1411: the delta-less wake body reserved by this attempt, if any. Kept
    // outside the try so a failed send can roll the reservation back. The
    // reservation map is part of the handle so a rollback cannot undo a
    // newer wake's reservation after the session's map was replaced.
    let reservedBody:
      | {
          wakeText: string;
          occurrence: number;
          reservation: Map<string, number>;
        }
      | undefined;

    try {
      const snapshot =
        wakeMode === 'children'
          ? await readChildrenSnapshot(sessionID)
          : await readHostSnapshot(sessionID);
      if (!snapshot || state.generation !== generation) return false;
      if (!state.continuousIdle) return false;
      if (applyArchiveState(sessionID, state, snapshot.archiveState))
        return false;
      const initialBlocker = scheduleBlocker(sessionID, scheduleOptions);
      if (initialBlocker) {
        log('[orchestrator-wake] evaluate aborted', {
          sessionID,
          trigger: reason,
          checkpoint: 'initial',
          reason: initialBlocker,
        });
        suppress(sessionID);
        return false;
      }

      const fingerprint = buildSnapshotFingerprint(snapshot);
      const verdict = deferPeriodicProgressWake(
        sessionID,
        reason,
        'initial',
        classifySnapshot(
          snapshot,
          sessionID,
          reason !== 'periodic',
          'initial',
          reason,
        ),
        fingerprint,
      );
      if (!applySnapshotVerdict(sessionID, verdict, 'initial', reason)) {
        return false;
      }

      noteHostProgress(sessionID, fingerprint);

      const progress = getWakeProgress(sessionID);
      if (
        progress.stopped ||
        (progress.lastFingerprint === fingerprint &&
          progress.unchangedWakeCount >= ORCHESTRATOR_WAKE_UNCHANGED_CAP)
      ) {
        log('[orchestrator-wake] evaluate aborted', {
          sessionID,
          trigger: reason,
          checkpoint: 'initial',
          reason: 'progress-cap',
        });
        progress.stopped = true;
        state.continuousIdle = false;
        return false;
      }

      // Recheck host status/waits immediately before promptAsync.
      const latest =
        wakeMode === 'children'
          ? await readChildrenSnapshot(sessionID)
          : await readHostSnapshot(sessionID);
      if (!latest || state.generation !== generation) return false;
      if (!state.continuousIdle) return false;
      if (applyArchiveState(sessionID, state, latest.archiveState))
        return false;
      const recheckBlocker = scheduleBlocker(sessionID, scheduleOptions);
      if (recheckBlocker) {
        log('[orchestrator-wake] evaluate aborted', {
          sessionID,
          trigger: reason,
          checkpoint: 'recheck',
          reason: recheckBlocker,
        });
        suppress(sessionID);
        return false;
      }
      const latestFingerprint = buildSnapshotFingerprint(latest);
      const latestVerdict = deferPeriodicProgressWake(
        sessionID,
        reason,
        'recheck',
        classifySnapshot(
          latest,
          sessionID,
          reason !== 'periodic',
          'recheck',
          reason,
        ),
        latestFingerprint,
      );
      if (!applySnapshotVerdict(sessionID, latestVerdict, 'recheck', reason)) {
        return false;
      }

      noteHostProgress(sessionID, latestFingerprint);

      const latestProgress = getWakeProgress(sessionID);
      if (
        latestProgress.stopped ||
        latestProgress.unchangedWakeCount >= ORCHESTRATOR_WAKE_UNCHANGED_CAP
      ) {
        log('[orchestrator-wake] evaluate aborted', {
          sessionID,
          trigger: reason,
          checkpoint: 'recheck',
          reason: 'progress-cap',
        });
        latestProgress.stopped = true;
        state.continuousIdle = false;
        return false;
      }

      const recoveryBatch = recoveryWake
        ? pendingStoppedRecoveries.get(sessionID)
        : undefined;
      // A resolved ask must not cause an input-wait wake by itself: prune
      // queued ask deltas even when no stopped-job batch is present. When
      // neither evidenced work remains, the wake ends here. An overflow
      // marker remains actionable even when all retained details have
      // since gone stale.
      const childInputDeltas = pendingChildInputWakes.get(sessionID);
      if (
        childInputDeltas &&
        prunedToEmpty(childInputQueue, childInputDeltas)
      ) {
        pendingChildInputWakes.delete(sessionID);
        if (!recoveryBatch) return false;
      }
      // A stale, revived, or already-reconciled detail must not cause a
      // recovery wake by itself. An overflow marker remains actionable even
      // when all retained details have since gone stale.
      if (recoveryBatch && prunedToEmpty(stoppedRecoveryQueue, recoveryBatch)) {
        pendingStoppedRecoveries.delete(sessionID);
        return false;
      }

      const modelSelection =
        latest.model ?? snapshot.model ?? getObservedWakeModel(sessionID);

      // #1079: resolve the session's CURRENT selection at send time. A
      // lifecycle wake continues the parent in the agent/model it uses
      // now; `orchestrator` is only the fallback when nothing else is
      // observable (matching the historical behavior for sessions that
      // always ran orchestrator).
      const selection = options.resolveSelection
        ? await options.resolveSelection(sessionID).catch(() => undefined)
        : undefined;
      // The await above is a new race window: an external message can
      // bump generation / end idle, and a Plan/Build host selection
      // must not ride in on stale orchestrator metadata.
      if (state.generation !== generation) return false;
      if (!state.continuousIdle) return false;
      const selectionBlocker = scheduleBlocker(sessionID, scheduleOptions);
      if (selectionBlocker) {
        log('[orchestrator-wake] evaluate aborted', {
          sessionID,
          trigger: reason,
          checkpoint: 'selection',
          reason: selectionBlocker,
        });
        suppress(sessionID);
        return false;
      }
      const wakeAgent = selection?.agent ?? 'orchestrator';
      if (
        wakeAgent !== 'orchestrator' &&
        !(options.hasPendingDelegatedWork?.(sessionID) ?? false)
      ) {
        return false;
      }
      // Re-prune stop facts after the selection await: a child can leave
      // stopped/unreconciled while parent generation stays put (#1079 r2).
      // Same for asks answered while queued.
      if (recoveryBatch && prunedToEmpty(stoppedRecoveryQueue, recoveryBatch)) {
        pendingStoppedRecoveries.delete(sessionID);
        return false;
      }
      const liveChildInputDeltas = pendingChildInputWakes.get(sessionID);
      if (
        liveChildInputDeltas &&
        prunedToEmpty(childInputQueue, liveChildInputDeltas) &&
        !recoveryBatch
      ) {
        pendingChildInputWakes.delete(sessionID);
        return false;
      }
      // Keep model+variant as one selection. Mixing a new model with a
      // leftover variant from another model produces B/max from A/max.
      const wakeModel = selection?.model ?? modelSelection?.model;
      const wakeVariant = selection?.model
        ? selection.variant
        : modelSelection?.variant;

      // A new ask or duplicate can start another settling timer during
      // either host read or selection resolution without changing generation.
      // A subsequent reply can also remove that timer and the entire batch.
      // Defer child-only recovery before reserving or choosing a stop notice.
      if (
        recoveryWake &&
        !recoveryBatch &&
        (childInputTimers.has(sessionID) || !liveChildInputDeltas)
      ) {
        return false;
      }

      // Reserve before promptAsync so a failed call cannot storm retries and
      // concurrent hook instances cannot double-wake.
      if (!commitWakeReservation(sessionID, owner, latestFingerprint)) {
        return false;
      }

      // Ask wake: when only child-input deltas are queued (no stopped-job
      // batch), the wake names the parked child instead of a stopped job.
      // The live map is re-read (not the pre-await snapshot): an ask
      // answered during selection resolve must not select the ask text.
      const sendInputDeltas = childInputTimers.has(sessionID)
        ? undefined
        : pendingChildInputWakes.get(sessionID);
      const sendInputKeys = sendInputDeltas
        ? [...sendInputDeltas.deltas.keys()].slice(0, CHILD_INPUT_WAKE_CHUNK)
        : [];
      const sentInputOverflowCount = sendInputDeltas?.overflowCount ?? 0;
      const inputDelta = sendInputKeys
        .map((key) => sendInputDeltas?.deltas.get(key))
        .filter((text): text is string => typeof text === 'string')
        .join('\n');
      const wakeText =
        // Negative invariant: child-input ask deltas are ONLY sent in this
        // branch, and this branch always uses ORCHESTRATOR_CHILD_INPUT_WAKE_TEXT,
        // which carries the v2-form caveat (pinned in child-input-wake.test).
        // The recoveryBatch branch never contains child-input asks
        // (stopped-job recovery only). Any new delta-send branch must
        // preserve this or carry the caveat inline.
        sendInputKeys.length > 0 && !recoveryBatch
          ? ORCHESTRATOR_CHILD_INPUT_WAKE_TEXT
          : recoveryWake
            ? boardInjectionEnabled
              ? ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT
              : ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT_NO_BOARD
            : wakeMode === 'children'
              ? ORCHESTRATOR_CHILDREN_WAKE_TEXT
              : ORCHESTRATOR_WAKE_TEXT;
      // Snapshot keys/values at send time. Do not detach the map: a stop
      // arriving during promptAsync lands in the same entry and must survive
      // confirmation. After delivery, retire only the keys that were sent.
      const sentKeys = recoveryBatch
        ? [...recoveryBatch.deltas.keys()].slice(0, STOPPED_RECOVERY_WAKE_CHUNK)
        : [];
      const sentOverflowCount = recoveryBatch?.overflowCount ?? 0;
      const sentOverflowedKeyCount = Math.min(
        recoveryBatch?.overflowedKeys.length ?? 0,
        sentOverflowCount,
      );
      const recoveryDelta = sentKeys
        .map((key) => recoveryBatch?.deltas.get(key))
        .filter((text): text is string => typeof text === 'string')
        .join('\n');
      const overflowDelta =
        recoveryBatch && recoveryBatch.overflowCount > 0
          ? boardInjectionEnabled
            ? STOPPED_RECOVERY_OVERFLOW_TEXT
            : // Board-less overflow has no passive display fallback and
              // `task_status` needs a known id, so the notice carries the
              // retained overflowed task identifiers itself instead of
              // pointing at a channel that cannot list them.
              `${STOPPED_RECOVERY_OVERFLOW_TEXT_NO_BOARD}\n${overflowedStoppedTaskIDs(
                recoveryBatch.overflowedKeys,
                recoveryBatch.overflowCount,
              )}`
          : '';
      const inputOverflowDelta =
        sendInputDeltas && sendInputDeltas.overflowCount > 0
          ? CHILD_INPUT_OVERFLOW_TEXT
          : '';
      const recoveryDetails = [
        overflowDelta,
        recoveryDelta,
        inputOverflowDelta,
        inputDelta,
      ]
        .filter(Boolean)
        .join('\n');
      // #1411: collapse byte-identical delta-less wake bodies into a short
      // repeat marker (child-input wakes are exempt: their caveat template
      // must always travel verbatim). Delta-bearing wakes keep the full
      // template. The occurrence is rolled back on a failed send so the
      // retry delivers the full text rather than a phantom repeat.
      let bodyText = recoveryDetails
        ? `${wakeText}\n${recoveryDetails}`
        : wakeText;
      if (
        recoveryDetails === '' &&
        wakeText !== ORCHESTRATOR_CHILD_INPUT_WAKE_TEXT
      ) {
        const { repeat, occurrence, reservation } = reserveWakeBodyOccurrence(
          sessionID,
          wakeText,
        );
        reservedBody = { wakeText, occurrence, reservation };
        const core = repeat ? WAKE_REPEAT_CORES.get(wakeText) : undefined;
        if (core) {
          bodyText = wakeRepeatMarker(core, occurrence);
          log('[orchestrator-wake] duplicate wake body suppressed', {
            sessionID,
            occurrence,
            suppressedTotal: getSuppressedDuplicateWakes(sessionID),
            charsSaved: wakeText.length - bodyText.length,
          });
        }
      }
      const body = {
        agent: wakeAgent,
        ...(wakeModel ? { model: wakeModel } : {}),
        ...(wakeModel && wakeVariant ? { variant: wakeVariant } : {}),
        parts: [createInternalAgentTextPart(bodyText)],
      };
      if (wakeMode === 'children' && capabilities.flavor === 'v2') {
        // v1 prompt_async queued; 'queue' preserves that on v2 ('steer'
        // would hijack an in-flight run). The shim reads the wake model's
        // variant from the v2-only modelVariant field, not body.variant.
        // Absent variant leaves the call shape unchanged.
        // `modelSelection: 'inherit'` marks this as a lifecycle
        // continuation (#1079): the v2 shim takes the host's persisted
        // selection instead of re-pinning this snapshot model.
        await (
          sessionSdk.promptAsync as (
            args: Record<string, unknown>,
          ) => Promise<unknown>
        )({
          path: { id: sessionID },
          query: { directory },
          body,
          delivery: 'queue',
          modelSelection: 'inherit',
          ...(wakeVariant ? { modelVariant: wakeVariant } : {}),
          throwOnError: true,
        });
      } else {
        // v1 path: the send-time-resolved body model is applied directly
        // by the host (no switchModel, so no stale-pin revert race). The
        // cast drops nothing on v1 — the SDK discards unknown root fields
        // (same RequestInit path as `delivery`, #1192) — while v2 hosts
        // in todo mode read `modelSelection` and get the same
        // lifecycle-inherit semantics as children mode.
        await (
          sessionSdk.promptAsync as (
            args: Record<string, unknown>,
          ) => Promise<unknown>
        )({
          path: { id: sessionID },
          query: { directory },
          body,
          modelSelection: 'inherit',
          throwOnError: true,
        });
      }
      if (recoveryWake) {
        const remaining = pendingStoppedRecoveries.get(sessionID);
        if (remaining) {
          for (const key of sentKeys) remaining.deltas.delete(key);
          remaining.overflowCount = Math.max(
            0,
            remaining.overflowCount - sentOverflowCount,
          );
          // Retire only the overflowed identifiers this wake actually
          // surfaced (bounded by the retained keys and by the count that
          // entered this wake's notice).
          if (sentOverflowedKeyCount > 0) {
            remaining.overflowedKeys.splice(0, sentOverflowedKeyCount);
          }
          if (
            remaining.deltas.size === 0 &&
            remaining.overflowCount === 0 &&
            remaining.overflowedKeys.length === 0
          ) {
            pendingStoppedRecoveries.delete(sessionID);
          } else {
            rearmWakeProgress(sessionID);
          }
        }
        // Retire only the ask keys that were sent (same discipline as
        // stopped-job deltas): an ask arriving during promptAsync survives.
        const remainingInput = pendingChildInputWakes.get(sessionID);
        if (remainingInput) {
          for (const key of sendInputKeys) remainingInput.deltas.delete(key);
          remainingInput.overflowCount = Math.max(
            0,
            remainingInput.overflowCount - sentInputOverflowCount,
          );
          if (sentInputOverflowCount > 0) {
            remainingInput.overflowedKeys.splice(
              0,
              Math.min(
                remainingInput.overflowedKeys.length,
                sentInputOverflowCount,
              ),
            );
          }
          if (
            remainingInput.deltas.size === 0 &&
            remainingInput.overflowCount === 0 &&
            remainingInput.overflowedKeys.length === 0
          ) {
            pendingChildInputWakes.delete(sessionID);
          } else {
            rearmWakeProgress(sessionID);
          }
        }
      }
      // Delivered: the wake admission was queued and accepted above.
      if (state.generation === generation) state.retryReason = undefined;
      if (reason === 'publication') {
        lastPublicationWakeAt.set(sessionID, Date.now());
        boundTrackedMap(lastPublicationWakeAt);
      }
      return true;
    } catch (error) {
      // Only accepted sends consume the cap. Preserve the reservation's
      // committed marker so waiters do not immediately retry; the timer
      // controls cadence. Pending recovery deltas stay queued. A delta-less
      // body occurrence this attempt reserved is undone so the retry sends
      // the full text again.
      rollbackWakeReservation(sessionID, owner);
      if (reservedBody !== undefined) {
        rollbackWakeBodyOccurrence(
          sessionID,
          reservedBody.wakeText,
          reservedBody.occurrence,
          reservedBody.reservation,
        );
      }
      clearExpectingWakeBusy(sessionID);
      if (state.generation === generation && reason !== 'periodic') {
        state.retryReason = reason;
      }
      log('[orchestrator-wake] wake suppressed after SDK error', {
        sessionID,
        error: stringifyError(error),
        trigger: reason,
      });
      return false;
    } finally {
      // Always release ownership — even when suppress/endIdle bumped generation.
      releaseWakeEvaluation(sessionID, owner);
      if (localWakeOwners.get(sessionID) === owner) {
        localWakeOwners.delete(sessionID);
      }

      const current = localSessions.get(sessionID);
      if (
        current?.generation === generation &&
        getWakeProgress(sessionID).stopped
      ) {
        log('[orchestrator-wake] backstop halted', {
          sessionID,
          reason: 'progress-cap',
        });
      }
      if (
        current &&
        current.generation === generation &&
        current.continuousIdle &&
        current.timer === undefined &&
        !getWakeProgress(sessionID).stopped
      ) {
        schedule(sessionID);
      }
    }
  }

  function observeChatMessage(input: unknown, output: unknown): void {
    const inputMessage = isObjectRecord(input) ? input : undefined;
    const outputRecord = isObjectRecord(output) ? output : undefined;
    const outputMessage = isObjectRecord(outputRecord?.message)
      ? outputRecord.message
      : undefined;
    const sessionID =
      typeof outputMessage?.sessionID === 'string'
        ? outputMessage.sessionID
        : typeof inputMessage?.sessionID === 'string'
          ? inputMessage.sessionID
          : undefined;
    const parts = Array.isArray(outputRecord?.parts)
      ? outputRecord.parts
      : inputMessage?.parts;
    if (
      !sessionID ||
      (typeof outputMessage?.role === 'string' &&
        outputMessage.role !== 'user') ||
      !Array.isArray(parts) ||
      parts.some(isInternalInitiatorPart) ||
      // Non-operator nudges (task_message noReply injections, interview
      // URL notifications, v2 command-marker submits, board/phase synthetic
      // tails) arrive as synthetic parts, internal-initiator parts, or
      // unmarked plain-text injections with no operator message identity.
      // Only a genuine external operator message rearms the no-progress
      // cap; injected nudges must not.
      !isGenuineOperatorMessage(inputMessage, outputMessage, parts) ||
      !parts.some(
        (part) =>
          isObjectRecord(part) &&
          part.synthetic !== true &&
          !isInternalInitiatorPart(part) &&
          ((part.type === 'text' && typeof part.text === 'string') ||
            part.type === 'file' ||
            part.type === 'image'),
      ) ||
      // #1079: observe external selections for ANY wake-eligible session
      // (orchestrator OR a parent with pending delegated work). Gating on
      // orchestrator identity alone would leave a Plan/Build parent's
      // observed model stale — and that parent can now be woken in its
      // CURRENT agent.
      !canObserveSelection(sessionID)
    ) {
      return;
    }

    const outputModel = isObjectRecord(outputMessage?.model)
      ? outputMessage.model
      : undefined;
    const variant =
      typeof inputMessage?.variant === 'string'
        ? inputMessage.variant
        : outputModel?.variant;
    const modelSelection =
      parseContinuationModelSelection(inputMessage?.model, variant) ??
      parseContinuationModelSelection(outputModel, variant);

    noteGateSession(sessionID);
    setObservedWakeModel(sessionID, modelSelection);

    const state = touchLocal(sessionID);
    clearTimer(state);
    bumpGeneration(state);
    state.continuousIdle = false;
    // External user activity rearms the process-global no-progress cap.
    rearmWakeProgress(sessionID);
  }

  /**
   * Immediately evaluate an idle orchestrator after a child stops without a
   * native terminal result. This is deliberately separate from the periodic
   * TODO wake: stopped work needs recovery even when its parent has no todo.
   */
  /** Queue a delta (if any) and evaluate the idle parent now. Shared
   * delivery machinery for both delta wake kinds; per-kind policy (cap,
   * blocker trigger, actionability) lives on the queue itself. */
  function triggerDeltaWake(
    queue: DeltaQueue,
    sessionID: string,
    delta?: string,
    dedupeKey?: string,
    settleDelayMs = 0,
  ): void {
    if (
      disposed ||
      !enabled ||
      !capabilities.ready ||
      !canObserveSelection(sessionID)
    ) {
      return;
    }
    noteGateSession(sessionID);
    if (delta) {
      queue.add(sessionID, delta, dedupeKey);
    } else if (!queue.batches.has(sessionID)) {
      queue.batches.set(sessionID, {
        deltas: new Map(),
        overflowCount: 0,
        overflowedKeys: [],
      });
    }
    if (localSessions.get(sessionID)?.archived) {
      return;
    }
    rearmWakeProgress(sessionID);
    const blocker = scheduleBlocker(sessionID);
    if (blocker) {
      reportScheduleBlocker(sessionID, blocker, queue.blockerTrigger);
      return;
    }
    if (settleDelayMs > 0) {
      // Keep the first deadline: duplicates enrich the queued delta, and
      // bursts cannot postpone a genuinely blocked child indefinitely.
      if (childInputTimers.has(sessionID)) return;
      const timer = setTimeout(() => {
        childInputTimers.delete(sessionID);
        const batch = queue.batches.get(sessionID);
        if (!batch) return;
        if (prunedToEmpty(queue, batch)) {
          queue.batches.delete(sessionID);
          return;
        }
        triggerDeltaWake(queue, sessionID);
      }, settleDelayMs);
      childInputTimers.set(sessionID, timer);
      timer.unref?.();
      return;
    }
    const state = touchLocal(sessionID);
    clearTimer(state);
    bumpGeneration(state);
    state.continuousIdle = true;
    void evaluate(sessionID, state.generation, 'recovery');
  }

  function triggerStoppedJobRecovery(
    sessionID: string,
    delta?: string,
    dedupeKey?: string,
  ): void {
    triggerDeltaWake(stoppedRecoveryQueue, sessionID, delta, dedupeKey);
  }

  /**
   * Wake an idle orchestrator after the terminal gate publishes a
   * completed/error host outcome (terminal-publication wake).
   *
   * OpenCode's native notifier delivers a child's FIRST completion to the
   * parent. A publication that lands while the parent sits idle — a child
   * that self-continued and finished again, or a later child's completion —
   * would otherwise wait for the periodic idle evaluation (up to
   * `intervalMs`). This trigger closes that gap under the SAME delivery
   * machinery and wake gate as the periodic scheduler.
   *
   * Suppression, in order:
   * - disabled via config (`wakeOnTerminalPublication`) or the shared
   *   capability/observation gates;
   * - busy parent: the native steer already delivered this completion, so
   *   a queued wake would double-notify;
   * - per-parent throttle (`publicationWakeMinIntervalMs`): a burst of
   *   publications collapses into one wake;
   * - `hasInputWait` / fallback / archived (via scheduleBlocker).
   *
   * The throttle is consumed at publication DELIVERY inside evaluate,
   * including timer retries and one-flight waiters; vetoed or failed
   * attempts burn nothing. The `waking` verdict is written only for a
   * delivery made directly by this trigger (never a retry or waiter).
   *
   * Unlike stopped-job recovery this does NOT rearm the no-progress cap:
   * the publication path enters evaluation past the cap pre-check, and the
   * in-evaluation fingerprint comparison decides — a publication that
   * changed the children fingerprint un-stops the session, an unchanged
   * one keeps the shared cap tripped.
   */
  async function triggerTerminalPublicationWake(
    sessionID: string,
    taskID: string,
    generation: number,
  ): Promise<void> {
    if (
      disposed ||
      !enabled ||
      !wakeOnTerminalPublication ||
      !capabilities.ready ||
      !canObserveSelection(sessionID)
    ) {
      return;
    }
    // Busy parent: native steer already delivered the first completion for
    // this job; a queued wake on top would double-inject.
    if (isParentActiveByEvents(sessionID)) {
      log('[orchestrator-wake] terminal publication wake skipped', {
        sessionID,
        taskID,
        generation,
        trigger: 'terminal-publication',
        verdict: 'skipped',
        reason: 'parent-busy',
      });
      return;
    }
    const now = Date.now();
    const lastWakeAt = lastPublicationWakeAt.get(sessionID);
    if (
      lastWakeAt !== undefined &&
      publicationWakeMinIntervalMs > 0 &&
      now - lastWakeAt < publicationWakeMinIntervalMs
    ) {
      log('[orchestrator-wake] terminal publication wake skipped', {
        sessionID,
        taskID,
        generation,
        trigger: 'terminal-publication',
        verdict: 'skipped',
        reason: 'throttled',
        windowMs: publicationWakeMinIntervalMs,
      });
      return;
    }
    if (localSessions.get(sessionID)?.archived) {
      return;
    }
    const blocker = scheduleBlocker(sessionID, {
      // The fingerprint comparison inside evaluate is the authoritative
      // no-progress test for this path (see the docstring above).
      ignoreProgressCap: true,
    });
    if (blocker) {
      log('[orchestrator-wake] terminal publication wake skipped', {
        sessionID,
        taskID,
        generation,
        trigger: 'terminal-publication',
        verdict: 'skipped',
        reason: blocker,
      });
      return;
    }
    // evaluate consumes the throttle on every publication delivery. A
    // suppressed or failed attempt burns nothing; the one-flight gate
    // deduplicates concurrent evaluations. Only this direct trigger logs
    // `waking` (timer/waiter deliveries have no taskID to log here).
    const state = touchLocal(sessionID);
    clearTimer(state);
    bumpGeneration(state);
    state.continuousIdle = true;
    const delivered = await evaluate(
      sessionID,
      state.generation,
      'publication',
    );
    if (!delivered) return;
    log('[orchestrator-wake] terminal publication wake', {
      sessionID,
      taskID,
      generation,
      trigger: 'terminal-publication',
      verdict: 'waking',
    });
  }

  /**
   * Evaluate an idle orchestrator after a background child asks
   * a question or permission request. Separate from the periodic TODO wake
   * for the same reason as the stopped-job recovery: a parked child needs
   * an answer even when its parent has no todo. The wake carries the ask
   * inline and answers ride the task_reply tool. A short settling window
   * drops asks already answered by host/UI auto-repliers. Delivered with
   * delivery:'queue' when the parent is busy, like every other wake.
   *
   * Ported onto the post-2.2.22 wake: the ask wake enters evaluation with
   * reason 'recovery' (externally evidenced work whose wake condition is
   * the event itself, like stopped-job recovery), so the children-active /
   * no-work deferral does not hold a parked child hostage.
   */
  function triggerChildInputWaitWake(
    sessionID: string,
    delta?: string,
    dedupeKey?: string,
  ): void {
    triggerDeltaWake(
      childInputQueue,
      sessionID,
      delta,
      dedupeKey,
      CHILD_INPUT_WAKE_SETTLE_MS,
    );
  }

  async function event(input: {
    event: {
      type: string;
      properties?: unknown;
      data?: unknown;
    };
  }): Promise<void> {
    const { type } = input.event;
    const properties = (
      isObjectRecord(input.event.data)
        ? input.event.data
        : isObjectRecord(input.event.properties)
          ? input.event.properties
          : {}
    ) as {
      info?: { id?: string; parentID?: string; time?: unknown };
      sessionID?: string;
      parentID?: string;
      status?: { type?: string };
    };

    if (type === 'server.instance.disposed') {
      disposed = true;
      for (const parentID of childInputTimers.keys()) {
        clearChildInputTimer(parentID);
      }
      pendingStoppedRecoveries.clear();
      lastPublicationWakeAt.clear();
      pendingChildInputWakes.clear();
      reportedScheduleBlockers.clear();
      lastStatusBySession.clear();
      childSessions.clear();
      childEvidence.clear();
      for (const sessionID of [...localWakeOwners.keys()]) {
        releaseLocalWakeOwner(sessionID);
      }
      for (const sessionID of [...localSessions.keys()]) {
        clearLocalSession(sessionID);
      }
      // The gate is process-global and outlives this instance. Drop the
      // state of the sessions only this instance served (after releasing its
      // own reservations above): a reloaded generation for this location
      // must not inherit stopped no-progress caps or wake-busy markers while
      // other locations keep the process alive.
      releaseWakeSessionHolder(gateHolder);
      return;
    }

    const sessionID = extractSessionID(input.event);
    if (!sessionID) return;
    noteGateSession(sessionID);

    if (
      type === 'permission.replied' ||
      type === 'question.replied' ||
      type === 'question.v2.replied' ||
      type === 'question.rejected' ||
      type === 'question.v2.rejected' ||
      type === 'session.deleted'
    ) {
      // The task-session-manager clears resolved waits before this hook runs.
      // Cancel a settling batch, but keep other pending asks and overflow.
      // Once evaluation starts, leave pruning to its post-await checks.
      for (const [parentID, batch] of pendingChildInputWakes) {
        if (!childInputTimers.has(parentID)) continue;
        if (!prunedToEmpty(childInputQueue, batch)) continue;
        pendingChildInputWakes.delete(parentID);
        clearChildInputTimer(parentID);
      }
    }

    if (type === 'session.updated') {
      if (canObserveSelection(sessionID)) {
        const archiveState = readEventArchiveState(input.event);
        if (archiveState === true) {
          suppressArchivedSession(sessionID);
        } else if (archiveState === false) {
          restoreArchivedSession(sessionID);
        }
      }
      return;
    }

    // Event bookkeeping (children-driven mode + parent-active race guard).
    // Status tracking covers ALL sessions: child entries feed the busy-set
    // and update evidence, the parent entry is the race guard on hosts
    // without a live status map (v2).
    if (type === 'session.status') {
      const statusType = properties?.status?.type;
      if (statusType === 'busy' || statusType === 'idle') {
        recordTrackedStatus(sessionID, statusType);
      }
    } else if (type === 'session.created') {
      const parentID =
        typeof properties?.info?.parentID === 'string'
          ? properties.info.parentID
          : typeof properties?.parentID === 'string'
            ? properties.parentID
            : undefined;
      if (parentID) recordChildSession(parentID, sessionID);
    }

    if (type === 'session.deleted') {
      forgetSessionEvents(sessionID);
      clearSession(sessionID);
      return;
    }

    if (isInputWaitAskEvent(type)) {
      if (canObserveSelection(sessionID)) {
        suppress(sessionID);
      }
      return;
    }

    if (isIdleEvent(type, properties)) {
      if (canObserveSelection(sessionID)) {
        clearExpectingWakeBusy(sessionID);
        if (pendingStoppedRecoveries.has(sessionID)) {
          if (localSessions.get(sessionID)?.archived) {
            beginContinuousIdle(sessionID);
          } else {
            triggerStoppedJobRecovery(sessionID);
          }
          return;
        }
        if (pendingChildInputWakes.has(sessionID)) {
          if (localSessions.get(sessionID)?.archived) {
            beginContinuousIdle(sessionID);
          } else {
            triggerChildInputWaitWake(sessionID);
          }
          return;
        }
        beginContinuousIdle(sessionID);
      }
      return;
    }

    if (isBusyEvent(type, properties)) {
      if (canObserveSelection(sessionID)) {
        // Wake-initiated busy preserves the no-progress cap; external busy rearms.
        const wakeBusy = isExpectingWakeBusy(sessionID);
        endIdleSpell(sessionID, !wakeBusy);
      }
      return;
    }

    if (
      type === 'session.error' ||
      (type === 'session.status' &&
        properties?.status?.type !== 'idle' &&
        properties?.status?.type !== 'busy')
    ) {
      if (canObserveSelection(sessionID)) {
        // Errors / retry are external lifecycle — rearm.
        clearExpectingWakeBusy(sessionID);
        endIdleSpell(sessionID, true);
      }
    }
  }

  if (options.coordinator) {
    options.coordinator.onSessionDeleted((sessionID) => {
      clearSession(sessionID);
    });
  }

  return {
    event,
    observeChatMessage,
    triggerStoppedJobRecovery,
    triggerTerminalPublicationWake,
    triggerChildInputWaitWake,
    /** Clear timers when wait_for_user or fallback begins. */
    suppress,
    /** Test seam */
    _test: {
      localSessions,
      intervalMs,
      enabled,
      hasRequiredSessionApis: () => capabilities.ready,
      capabilities: () => capabilities,
      wakeMode: () => wakeMode,
      lastStatusBySession,
      childEvidence,
      childSessions,
    },
  };
}
