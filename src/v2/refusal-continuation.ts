/**
 * v2-only refusal continuation for the native `subagent` tool.
 *
 * OpenCode 2.2.x does not call `session.retry` after a content-filter finish,
 * so Slim switches the child model in place. A foreground child is still
 * awaited by the parent's `subagent` call: retry that call once with the
 * child's exact session ID and the internal continuation prompt, as the
 * retired managed wrapper did. Background children return a handle first and
 * are continued by the fallback manager itself.
 */
import type { ForegroundFallbackManager } from '../hooks/foreground-fallback';
import {
  NO_ROUTE_CONTINUATION,
  REFUSAL_CONTINUATION,
} from '../hooks/foreground-fallback';
import { isRecord } from '../utils/guards';
import { log } from '../utils/logger';
import { withTimeout } from '../utils/session';
import { isNoRouteAnchor, isNoRouteFailureMessage } from './terminal-fallback';

const HOST_CALL_TIMEOUT_MS = 2_000;
const HOST_FAILURE_MESSAGE_PATTERN =
  /\bSubagent (failed|cancelled) \(sessionID:\s*([^)\s]+)\)/i;

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Read the refused child's transcript and wait for its model switch. */
async function refusalOutcome(
  context: NonNullable<SubagentRefusalContinuationOptions['context']>,
  outcome: ForegroundFallbackManager['refusedChildOutcome'],
  sessionID: string,
  text?: string,
) {
  try {
    const history = await withTimeout(
      context(sessionID),
      HOST_CALL_TIMEOUT_MS,
      '[v2] refused child context lookup timed out',
    );
    if (text && isNoRouteFailureMessage(text)) {
      const input = Array.isArray(history)
        ? history.findLast((entry) => isNoRouteAnchor(entry.type, entry.status))
        : undefined;
      if (!input || typeof input.id !== 'string') return;
      return outcome(sessionID, {
        ...input,
        baselineMessageID: input.id,
        type: 'no-route',
        error: { type: 'provider.no-route', message: text },
      });
    }
    const last = Array.isArray(history)
      ? history.findLast((entry) => {
          if (entry.type !== 'assistant' || entry.finish !== 'content-filter')
            return false;
          if (text === undefined) return true;
          return isRecord(entry.error) && entry.error.message === text;
        })
      : undefined;
    if (!last || typeof last.id !== 'string') return;
    return outcome(sessionID, last);
  } catch (error) {
    log('[v2] refused child context lookup failed', String(error));
    return;
  }
}

export interface SubagentRefusalContinuationOptions {
  context: (
    sessionID: string,
  ) => Promise<Array<Record<string, unknown>> | undefined>;
  refusalOutcome: ForegroundFallbackManager['refusedChildOutcome'];
  /** Marks a child as awaited by a foreground `subagent` call. */
  onForegroundChild?: (sessionID: string, active: boolean) => void;
}

export function createSubagentRefusalContinuation(
  options: SubagentRefusalContinuationOptions,
) {
  return {
    wrap(original: unknown) {
      if (typeof original !== 'function') {
        throw new Error('subagent executor is not a function');
      }
      const run = original as (input: unknown, context: unknown) => unknown;
      return async (input: unknown, context: unknown) => {
        const native = isRecord(context) ? context : undefined;
        const progress = native?.progress;
        let childID: string | undefined;
        if (native && typeof progress === 'function') {
          context = {
            ...native,
            progress: async (update: unknown) => {
              await progress.call(native, update);
              if (
                isRecord(update) &&
                update.status === 'running' &&
                typeof update.sessionID === 'string' &&
                !(isRecord(input) && input.background === true)
              ) {
                childID = update.sessionID;
                options.onForegroundChild?.(childID, true);
              }
            },
          };
        }
        const retried = new Set<string>();
        let currentInput = input;
        while (true) {
          try {
            const result = await run(currentInput, context);
            if (childID) options.onForegroundChild?.(childID, false);
            return result;
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : typeof error === 'string'
                  ? error
                  : '';
            const launch = HOST_FAILURE_MESSAGE_PATTERN.exec(message);
            const failedChild = readString(launch?.[2]) ?? childID;
            if (
              launch?.[1]?.toLowerCase() === 'failed' &&
              failedChild &&
              !retried.has(failedChild) &&
              isRecord(currentInput) &&
              currentInput.background !== true
            ) {
              const failure = message
                .replace(HOST_FAILURE_MESSAGE_PATTERN, '')
                .replace(/^:\s*/, '');
              const noRoute = isNoRouteFailureMessage(failure);
              const recovery = await refusalOutcome(
                options.context,
                options.refusalOutcome,
                failedChild,
                noRoute ? failure : undefined,
              );
              if (recovery) {
                retried.add(failedChild);
                const next: Record<string, unknown> = {
                  ...(currentInput as Record<string, unknown>),
                  sessionID: failedChild,
                  prompt: noRoute
                    ? NO_ROUTE_CONTINUATION
                    : REFUSAL_CONTINUATION,
                };
                delete next.model;
                currentInput = next;
                continue;
              }
            }
            if (childID) options.onForegroundChild?.(childID, false);
            throw error;
          }
        }
      };
    },
  };
}
