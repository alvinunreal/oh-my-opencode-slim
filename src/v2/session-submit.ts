/**
 * Shared v2 session submit + text helpers.
 *
 * One implementation of "submit text as a user prompt on a v2 session" so the
 * generic command bridge (setup.ts) and the interview bridge stay identical;
 * avoids a setup↔interview-bridge import cycle.
 */

import { log } from '../utils/logger';
import type { V2Context } from './types';

/** Function that submits `text` as a user prompt on a v2 session. */
export type V2CommandSubmit = (
  sessionID: string,
  text: string,
) => Promise<void>;

/** Submit marker text as a user prompt via `ctx.session.prompt`. Never
 * throws — the session methods reject on transport errors and command
 * `execute` must not leak that out to the host. */
export function createSessionSubmit(ctx: V2Context): V2CommandSubmit {
  // Reduced hosts may omit the session domain entirely (mirrors
  // interview-bridge.ts); without the ?? {} the probe below would throw a
  // TypeError and be mislogged as a submit failure.
  const session = (ctx.session ?? {}) as V2Context['session'];
  return async (sessionID, text) => {
    try {
      if (typeof session.prompt === 'function') {
        await session.prompt({ sessionID, text });
        return;
      }
      log('[v2] command submit unavailable', { sessionID });
    } catch (err) {
      log('[v2] command submit failed', { sessionID, err: String(err) });
    }
  };
}

/** Join the text parts of a v2 message content array. */
export function textFromContent(
  content: Array<Record<string, unknown>>,
): string {
  return content
    .filter((part) => part.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}
