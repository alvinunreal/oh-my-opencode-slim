import { getGlobalStore } from '../../utils/global-store';

/**
 * Pending input waits (question / permission) on background child sessions.
 *
 * The per-session `input-wait-tracker` arms a wait for the *asking* session,
 * but a background child's ask does not wake its parent model. Host UIs may
 * surface the request independently; headless orchestration still needs the
 * parent to learn about the parked child.
 *
 * This sidecar closes that hole: it records the open asks of board-tracked
 * RUNNING background children (keyed by taskID + request id, idempotent per
 * ask) for the event router to notify the parent with the ask content.
 * Entries clear on reply/reject, session deletion, or terminal board state.
 * Process-local via globalThis + Symbol.for so independently created hook
 * instances in the same JS process share one store — same pattern as the
 * user-wait gate.
 */

export type ChildInputWaitKind = 'question' | 'permission';

export interface ChildInputWaitQuestion {
  question: string;
  header: string;
  /**
   * The v2 form field key: the host requires form replies keyed by this
   * exact value (`answer[field.key]`). `header` is display text (truncated
   * to 30 chars) and is never a valid key. Absent on v1-native asks.
   */
  key?: string;
  /** v2 multiselect field: the host requires a string[] answer. */
  multiple?: true;
  options: Array<{ label: string; description: string }>;
}

export interface ChildInputWaitRecord {
  taskID: string;
  parentSessionID: string;
  kind: ChildInputWaitKind;
  requestID: string;
  askedAt: number;
  /** Truncated question content (question kind) or permission summary. */
  questions?: ChildInputWaitQuestion[];
  permission?: string;
  patterns?: string[];
}

export interface ChildInputWaitNotification {
  parentSessionID: string;
  taskID: string;
  kind: ChildInputWaitKind;
  requestID: string;
}

type ChildInputWaitStore = {
  waits: Map<string, ChildInputWaitRecord>;
};

const STORE_KEY = 'oh-my-opencode-slim.child-input-wait';

function getStore(): ChildInputWaitStore {
  return getGlobalStore<ChildInputWaitStore>(STORE_KEY, () => ({
    waits: new Map(),
  }));
}

function waitKey(taskID: string, requestID: string): string {
  return `${taskID}:${requestID}`;
}

/**
 * Escape child-supplied text for prompt-visible rendering. Stored records
 * feed both the `<child-input-wait>` wake delta and task_status output, so
 * escaping at the sanitize choke point covers every render path. Same
 * `&`/`<`/`>` precedent as the Background Job Board's promptSafe.
 */
function sanitizeText(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value : '';
  const singleLine = text.replace(/\s+/g, ' ').trim();
  const truncated =
    singleLine.length <= maxLength
      ? singleLine
      : `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
  return truncated
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function sanitizeQuestions(value: unknown): ChildInputWaitQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((entry) => {
    const record =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)
        : {};
    const options = Array.isArray(record.options)
      ? record.options.slice(0, 8).map((option) => {
          const optionRecord =
            typeof option === 'object' && option !== null
              ? (option as Record<string, unknown>)
              : {};
          return {
            label: sanitizeText(optionRecord.label, 30),
            description: sanitizeText(optionRecord.description, 160),
          };
        })
      : [];
    return {
      question: sanitizeText(record.question, 500),
      header: sanitizeText(record.header, 30),
      // Stored verbatim (never rendered): the host matches reply keys
      // exactly, so escaping/collapsing/truncating would break the reply.
      ...(typeof record.key === 'string' &&
      record.key.length > 0 &&
      record.key.length <= 200
        ? { key: record.key }
        : {}),
      ...(record.multiple === true ? { multiple: true as const } : {}),
      options,
    };
  });
}

function sanitizePatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .slice(0, 8)
    .map((entry) => sanitizeText(entry, 160));
}

function mergeRicherChildInputWait(
  existing: ChildInputWaitRecord,
  input: {
    kind: ChildInputWaitKind;
    questions?: unknown;
    permission?: unknown;
    patterns?: unknown;
  },
): ChildInputWaitRecord {
  if (existing.kind !== input.kind) return existing;

  if (input.kind === 'question') {
    const questions = sanitizeQuestions(input.questions);
    if ((existing.questions?.length ?? 0) === 0 && questions.length > 0) {
      existing.questions = questions;
    }
    return existing;
  }

  const permission = sanitizeText(input.permission, 160);
  if (!existing.permission && permission) {
    existing.permission = permission;
  }

  const patterns = sanitizePatterns(input.patterns);
  if ((existing.patterns?.length ?? 0) === 0 && patterns.length > 0) {
    existing.patterns = patterns;
  }

  return existing;
}

/**
 * Record a newly opened input wait on a board-tracked running background
 * child. Idempotent per (taskID, requestID): a duplicate ask replays the
 * stored content without re-notifying, but may merge richer fields from a
 * later normalized event. Returns the record, or undefined when there is
 * nothing to track (missing/empty request id).
 */
export function noteChildInputWait(input: {
  taskID: string;
  parentSessionID: string;
  kind: ChildInputWaitKind;
  requestID: string;
  questions?: unknown;
  permission?: unknown;
  patterns?: unknown;
  now?: number;
}): ChildInputWaitRecord | undefined {
  const requestID = input.requestID.trim();
  if (!requestID) return undefined;
  const store = getStore();
  const key = waitKey(input.taskID, requestID);
  const existing = store.waits.get(key);
  if (existing) return mergeRicherChildInputWait(existing, input);
  const record: ChildInputWaitRecord = {
    taskID: input.taskID,
    parentSessionID: input.parentSessionID,
    kind: input.kind,
    requestID,
    askedAt: input.now ?? Date.now(),
  };
  if (input.kind === 'question') {
    record.questions = sanitizeQuestions(input.questions);
  } else {
    record.permission = sanitizeText(input.permission, 160);
    record.patterns = sanitizePatterns(input.patterns);
  }
  store.waits.set(key, record);
  return record;
}

/** Request details and only the guidance applicable to this host/request. */
export function formatChildInputWaitDetail(
  wait: ChildInputWaitRecord,
  hostFlavor: unknown,
): string {
  const lines: string[] = [];
  if (wait.kind === 'permission') {
    lines.push(`permission: ${wait.permission || 'unknown'}`);
    if (wait.patterns?.length) {
      lines.push(`patterns: ${wait.patterns.join(', ')}`);
    }
  } else if (wait.questions?.length) {
    for (const entry of wait.questions) {
      lines.push(
        `question: ${entry.header && entry.question ? `${entry.header}: ` : ''}${entry.question || entry.header}`,
      );
      if (hostFlavor === 'v2') {
        if (entry.options.length) {
          lines.push(
            `options: ${entry.options.map((o) => o.label).join(' / ')}`,
          );
        }
      } else {
        for (const option of entry.options) {
          lines.push(
            `option: ${option.label}${option.description ? ` — ${option.description}` : ''}`,
          );
        }
      }
    }
  } else {
    lines.push('(no question text captured)');
  }
  lines.push(
    wait.kind === 'question' && hostFlavor === 'v2'
      ? 'next: task_reply cannot answer v2 forms; use host UI, wait, or task_cancel.'
      : 'next: task_reply',
  );
  return lines.join('\n');
}

/** Clear the wait for an answered/rejected request. Idempotent. */
export function clearChildInputWait(
  taskID: string,
  requestID: string,
): boolean {
  const id = requestID.trim();
  if (!id) return false;
  return getStore().waits.delete(waitKey(taskID, id));
}

/** Clear every wait for a session (deleted/terminal/drop). Returns the
 * number of entries removed. */
export function clearChildInputWaitsForSession(taskID: string): number {
  const store = getStore();
  let removed = 0;
  for (const key of [...store.waits.keys()]) {
    if (key === taskID || key.startsWith(`${taskID}:`)) {
      store.waits.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/** Look up one pending wait by task session and request id. */
export function getChildInputWait(
  taskID: string,
  requestID: string,
): ChildInputWaitRecord | undefined {
  const id = requestID.trim();
  if (!id) return undefined;
  return getStore().waits.get(waitKey(taskID, id));
}

export function listChildInputWaits(taskID?: string): ChildInputWaitRecord[] {
  const waits = [...getStore().waits.values()];
  const filtered = taskID
    ? waits.filter((wait) => wait.taskID === taskID)
    : waits;
  return filtered.sort((a, b) => a.askedAt - b.askedAt);
}

/** Test seam: wipe process-local state between cases. */
export function resetChildInputWaitForTests(): void {
  const store = getStore();
  store.waits.clear();
}
