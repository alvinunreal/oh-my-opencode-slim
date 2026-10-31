import { tool } from '@opencode-ai/plugin';
import type { CanonicalTaskReference } from '../hooks/task-session-manager/session-recovery';
import type {
  BackgroundJobBoard,
  BackgroundJobRecord,
} from '../utils/background-job-board';
import { SESSION_ID_PATTERN } from '../utils/session';
import { controlParamName } from '../v2/adapters';
import { v2ResumeCall } from '../v2/delegation';

export type { CanonicalTaskReference };

const z = tool.schema;

/**
 * The identifier fields a control tool's `args` object accepts, as a
 * plugin-tool raw shape. On v2 the native field is `sessionID` with a
 * deprecated `task_id` alias; on v1/unknown flavors it is only `task_id`.
 */
type TaskRefArgs = Parameters<typeof tool>[0]['args'];

/** Resolve the host's model-visible control-tool identifier parameter. */
export function idParamFor(input: unknown): string {
  return controlParamName(
    (input as { hostFlavor?: string } | undefined)?.hostFlavor,
  );
}

/**
 * Build a control tool's identifier arg fields: `{ sessionID?, task_id? }` on
 * v2, `{ task_id }` on v1. Spread into each control tool's `args` object.
 *
 * Both v2 fields are schema-optional on purpose. `src/v2/setup.ts` derives each
 * tool's JSON Schema with `z.object(def.args)` → `z.toJSONSchema`, so a
 * required `sessionID` would land in the schema's `required` array and the host
 * would reject an alias-only `{ task_id }` call before `execute()`/`readTaskRef`
 * ever run. Requiredness is instead enforced at execution: `readTaskRef`
 * returns '' when neither field is present, and each caller raises its existing
 * `<tool> requires <param>` error.
 */
export function taskRefArgs(
  param: string,
  nativeDescription = 'Tracked task ID or its parent-scoped alias',
): TaskRefArgs {
  const native = z.string().describe(nativeDescription);
  if (param === 'task_id') return { task_id: native };
  return {
    sessionID: native.optional(),
    task_id: z.string().optional().describe('Deprecated alias for sessionID'),
  };
}

/**
 * Read a control tool's identifier from its args, preferring the host's
 * native parameter and falling back to the alias. Returns '' when absent so
 * the caller keeps its existing `<tool> requires <param>` error.
 */
export function readTaskRef(
  args: Record<string, unknown>,
  param: string,
): string {
  const alias = param === 'task_id' ? 'sessionID' : 'task_id';
  const value = args[param] ?? args[alias];
  return typeof value === 'string' ? value.trim() : '';
}

export type CanonicalTaskResolver = (
  parentSessionID: string,
  requested: string,
) => Promise<CanonicalTaskReference>;

/** How many tracked handles an unknown-handle error enumerates. */
export const RECENT_TASK_HANDLE_LIMIT = 5;

/**
 * Parent-scoped enumeration of the most recently launched tracked handles,
 * appended to unknown-handle errors so the model can retry with a live alias
 * instead of guessing one. Alias + agent + effective state only — never
 * objectives; adopted records carry their session ID as the alias. The line
 * is prefixed `recent: ` so the
 * tool-loop-guard's taskID/state parsers (anchored on `task_id:`/
 * `sessionID:`/`Task (`/`state:`) can never capture it.
 */
export function recentTaskHandles(
  board: BackgroundJobBoard,
  parentSessionID: string,
): string | undefined {
  const recent = board.list(parentSessionID).slice(-RECENT_TASK_HANDLE_LIMIT);
  if (recent.length === 0) return undefined;
  return `recent: ${recent
    .map(
      (job) =>
        `${job.alias} ${job.agent} ${
          job.state === 'reconciled'
            ? (job.terminalState ?? job.state)
            : job.state
        }`,
    )
    .join('; ')}`;
}

/** Append the enumeration line to an error message when one exists. */
export function withRecentTaskHandles(
  message: string,
  recent: string | undefined,
): string {
  return recent === undefined ? message : `${message}\n${recent}`;
}

/**
 * The shared board-miss error. A miss proves only that the in-memory board
 * does not track the ref — records are evicted by retention limits or lost
 * on a host restart, so a settled session can still exist on the host — so
 * session-shaped IDs get the settled-session guidance (continue the same
 * session via task_revive; never a duplicate) while board-scoped aliases,
 * which have no host existence, keep the bare unknown error.
 *
 * `recent` (from `recentTaskHandles`) enumerates the parent's live handles
 * so an alias typo is recoverable from the error itself.
 */
export function unknownTaskRefError(
  identity: string,
  resumeParam: string,
  recent?: string,
  hostFlavor?: string,
): Error {
  const continueHint =
    hostFlavor === 'v2'
      ? `continue it with ${v2ResumeCall(identity)}`
      : `continue it with task_revive and ${resumeParam}: "${identity}"`;
  return new Error(
    withRecentTaskHandles(
      SESSION_ID_PATTERN.test(identity)
        ? `Unknown task ID or alias: ${identity} (not tracked: records are evicted by retention limits or lost on a host restart; a settled session can still exist on the host). If it is a settled session you own, ${continueHint}; do not launch a duplicate.`
        : `Unknown task ID or alias: ${identity}`,
      recent,
    ),
  );
}

/**
 * The ref pre-check shared by the control tools: alias authority first,
 * then plugin disposal, then refusal, then the resolved identity and board
 * record. Pure — no host or gate I/O; each kind maps to the caller's own
 * action, and a missing record stays each tool's own concern (guided
 * error, read-only fallback, or adoption).
 *
 * Deliberately NOT used by task_status (it keeps answering read-only
 * while the plugin disposes, so it has no disposed check) and task_cancel
 * (its cancellation lease must be acquired synchronously within the
 * execute call — before any event interleave — so it keeps the inline
 * preamble; the awaited resolution here would open a microtask gap).
 */
export async function resolveTaskRecord(
  options: {
    resolveCanonicalTaskRef?: CanonicalTaskResolver;
    isDisposed?: () => boolean;
    backgroundJobBoard: BackgroundJobBoard;
  },
  parentSessionID: string,
  requested: string,
): Promise<
  | { kind: 'refused'; reason: string }
  | { kind: 'disposed' }
  | {
      kind: 'resolved';
      identity: string;
      /** Whether the alias authority resolved the ref: callers repeat
       *  get-by-identity vs resolve-by-alias on their own re-resolution. */
      canonical: boolean;
      job: BackgroundJobRecord | undefined;
    }
> {
  const canonical = options.resolveCanonicalTaskRef
    ? await options.resolveCanonicalTaskRef(parentSessionID, requested)
    : undefined;
  if (options.isDisposed?.()) return { kind: 'disposed' };
  if (canonical?.kind === 'refused') {
    return { kind: 'refused', reason: canonical.reason };
  }
  const identity = canonical?.taskID ?? requested;
  const job = canonical
    ? options.backgroundJobBoard.get(identity)
    : options.backgroundJobBoard.resolve(parentSessionID, requested);
  return {
    kind: 'resolved',
    identity,
    canonical: canonical !== undefined,
    job,
  };
}
