import type { TimerHandle, TimerSeamOptions } from '../../utils/timer-seam';

export function autoAnswerText(timeoutMs: number): string {
  const minutes = Math.round(timeoutMs / 60_000);
  return `No user response within ${minutes} minute${minutes === 1 ? '' : 's'}; decide yourself and continue.`;
}

export function createQuestionTimeout<Payload>(
  options: TimerSeamOptions & {
    timeoutMs: number;
    reply: (
      requestID: string,
      sessionID: string,
      payload: Payload,
    ) => Promise<unknown>;
    log?: (message: string, details?: unknown) => void;
  },
) {
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const pending = new Map<string, { sessionID: string; timer: TimerHandle }>();
  let disposed = false;

  function settled(requestID: string): void {
    const entry = pending.get(requestID);
    if (!entry) return;
    pending.delete(requestID);
    clearTimer(entry.timer);
  }

  function sessionGone(sessionID: string): void {
    for (const [requestID, entry] of pending) {
      if (entry.sessionID === sessionID) settled(requestID);
    }
  }

  function dispose(): void {
    disposed = true;
    for (const requestID of pending.keys()) settled(requestID);
  }

  function asked(requestID: string, sessionID: string, payload: Payload): void {
    if (disposed || pending.has(requestID)) return;
    const timer = setTimer(() => {
      pending.delete(requestID);
      void (async () => {
        try {
          await options.reply(requestID, sessionID, payload);
          options.log?.('[question-timeout] auto-answered', {
            requestID,
            sessionID,
          });
        } catch (error) {
          options.log?.(
            '[question-timeout] reply failed (possibly already settled)',
            { requestID, sessionID, error: String(error) },
          );
        }
      })();
    }, options.timeoutMs);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    pending.set(requestID, { sessionID, timer });
    options.log?.('[question-timeout] armed', { requestID, sessionID });
  }

  return { asked, settled, sessionGone, dispose };
}
