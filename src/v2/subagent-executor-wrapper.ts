/**
 * v2-only executor wrapper around the native `subagent` tool.
 *
 * v2 hosts return the child identity STRUCTURALLY
 * (`result.output.sessionID` / `result.metadata.sessionID`) and the
 * host-confirmed background marker in `result.metadata.background`; the
 * rendered text is prose for the model, not a parsing surface. This wrapper
 * lets the plugin register delegated launches from the structured result
 * instead of scraping the rendered output, and marks the pending
 * handled-by-wrapper so the prose lane in `tool.execute.after` gates its
 * launch branches off (exactly-once registration on v2).
 *
 * v1 keeps the prose lane unchanged: this wrapper is installed only by the v2
 * setup path. The wrapper never reimplements host subagent behavior — it wraps
 * the original executor and always returns its result unchanged.
 */

import { log } from '../utils/logger';

export type SubagentStructuredState =
  | 'running'
  | 'completed'
  | 'error'
  | 'cancelled';

export interface SubagentStructuredLaunch {
  /** Tool.CallID of the wrapped call (`context.id`). */
  callID: string;
  /** Child session/task ID from the structured executor result. */
  childTaskID: string;
  state: SubagentStructuredState;
  /** Host-confirmed background promotion from structured metadata. */
  background: boolean;
  /**
   * The child's final text, passed VERBATIM (never reformatted): the
   * native v2 foreground completion carries the full host-authored
   * `<subagent …>` block in `content`. Omitted when the result carries
   * no text (fail-open). The terminal gate's textless-completion policy
   * needs it so a valid answer is not recorded as an error.
   */
  result?: string;
}

export interface SubagentExecutorWrapperOptions {
  /** Register one structured launch/status. The wrapper never lets a
   *  registration failure reach the tool result. */
  register: (launch: SubagentStructuredLaunch) => Promise<unknown> | unknown;
}

/** Host-authored failure sentence; the ONLY prose the wrapper reads, and only
 *  when the executor threw (a thrown Tool.Error carries no structured
 *  fields). Format drift skips registration; the error still propagates
 *  unchanged. */
export const HOST_FAILURE_MESSAGE_PATTERN =
  /\bSubagent (failed|cancelled) \(sessionID:\s*([^)\s]+)\)/i;

/** Cross-instance replay guard: setup may re-run transforms, and a replayed
 *  draft can still hold a previously wrapped execute. Marking the function
 *  prevents double wrapping (which would double-register). */
const WRAPPED_MARKER = Symbol.for(
  'oh-my-opencode-slim.v2.subagent-executor.wrapped',
);

interface ExecutorResultLike {
  output?: { sessionID?: unknown; status?: unknown; result?: unknown };
  metadata?: {
    sessionID?: unknown;
    status?: unknown;
    background?: unknown;
  };
  /** The host-authored completion prose (the full `<subagent …>` block). */
  content?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function structuredLaunch(
  callID: string,
  result: unknown,
): SubagentStructuredLaunch | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const shaped = result as ExecutorResultLike;
  const childTaskID =
    readString(shaped.output?.sessionID) ??
    readString(shaped.metadata?.sessionID);
  if (!childTaskID) return undefined;
  const rawState =
    readString(shaped.output?.status) ?? readString(shaped.metadata?.status);
  const state: SubagentStructuredState =
    rawState === 'completed' || rawState === 'error' || rawState === 'cancelled'
      ? rawState
      : 'running';
  // The child's final text, verbatim: the native v2 foreground completion
  // carries the full host-authored `<subagent …>` block in `content`.
  // Never reformat it — the terminal gate's textless-completion policy
  // reads this as the run's public answer text.
  const resultText =
    readString(shaped.content) ?? readString(shaped.output?.result);
  return {
    callID,
    childTaskID,
    state,
    background: shaped.metadata?.background === true,
    ...(resultText !== undefined ? { result: resultText } : {}),
  };
}

function threwLaunch(
  callID: string,
  error: unknown,
): SubagentStructuredLaunch | undefined {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const match = HOST_FAILURE_MESSAGE_PATTERN.exec(message);
  if (!match) return undefined;
  const childTaskID = readString(match[2]);
  if (!childTaskID) return undefined;
  return {
    callID,
    childTaskID,
    state: match[1]?.toLowerCase() === 'cancelled' ? 'cancelled' : 'error',
    // A thrown failure never represents a promoted background run: the
    // background lane returns its handle instead of throwing.
    background: false,
    // Failure details preserved: the host error message is the only text a
    // thrown Tool.Error carries.
    ...(message !== '' ? { result: message } : {}),
  };
}

export function createSubagentExecutorWrapper(
  options: SubagentExecutorWrapperOptions,
): {
  wrap: (
    original: unknown,
  ) => (input: unknown, context: unknown) => Promise<unknown>;
  /** True when this plugin already wrapped `execute` (replay guard). */
  owns: (execute: unknown) => boolean;
} {
  const registerSafely = (launch: SubagentStructuredLaunch | undefined) => {
    if (!launch) return;
    try {
      const pending = options.register(launch);
      if (pending && typeof (pending as Promise<unknown>).then === 'function') {
        void (pending as Promise<unknown>).catch((error: unknown) => {
          log('[v2] structured subagent launch registration failed', {
            callID: launch.callID,
            taskID: launch.childTaskID,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      log('[v2] structured subagent launch registration failed', {
        callID: launch.callID,
        taskID: launch.childTaskID,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    owns(execute) {
      return (
        typeof execute === 'function' &&
        (execute as unknown as Record<symbol, unknown>)[WRAPPED_MARKER] === true
      );
    },
    wrap(original) {
      if (typeof original !== 'function') {
        throw new Error('subagent executor is not a function');
      }
      const run = original as (input: unknown, context: unknown) => unknown;
      const wrapped = async (input: unknown, context: unknown) => {
        const callID = readString(
          (context as { id?: unknown } | undefined)?.id,
        );
        try {
          const result = await run(input, context);
          if (callID) registerSafely(structuredLaunch(callID, result));
          return result;
        } catch (error) {
          if (callID) registerSafely(threwLaunch(callID, error));
          throw error;
        }
      };
      Object.defineProperty(wrapped, WRAPPED_MARKER, {
        value: true,
        enumerable: false,
      });
      return wrapped;
    },
  };
}
