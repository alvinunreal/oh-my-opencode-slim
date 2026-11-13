import {
  beginUserWait as beginSharedUserWait,
  hasUserWait,
} from './user-wait-gate';

const IDLESS_INPUT_WAIT = Symbol('idless-input-wait');
const INPUT_WAIT_ASK_EVENTS = {
  'permission.asked': 'permission',
  'question.asked': 'question',
} as const;
const INPUT_WAIT_RESOLUTION_EVENTS = {
  'permission.replied': 'permission',
  'question.replied': 'question',
  'question.rejected': 'question',
} as const;

function isInputWaitAskEvent(
  type: string,
): type is keyof typeof INPUT_WAIT_ASK_EVENTS {
  return Object.hasOwn(INPUT_WAIT_ASK_EVENTS, type);
}

function isInputWaitResolutionEvent(
  type: string,
): type is keyof typeof INPUT_WAIT_RESOLUTION_EVENTS {
  return Object.hasOwn(INPUT_WAIT_RESOLUTION_EVENTS, type);
}

function inputWaitKey(kind: 'permission' | 'question', requestID: string) {
  return `${kind}:${requestID}`;
}

export function createInputWaitTracker(options: {
  shouldManageSession: (sessionID: string) => boolean;
  /** Cancel delayed idle work when an input wait arms. */
  invalidateIdle: (sessionID: string) => void;
}) {
  const inputWaitsByParent = new Map<string, Set<string | symbol>>();

  function hasInputWait(sessionID: string): boolean {
    return (
      hasUserWait(sessionID) ||
      (inputWaitsByParent.get(sessionID)?.size ?? 0) > 0
    );
  }

  function beginUserWait(sessionID: string): void {
    if (!options.shouldManageSession(sessionID)) {
      throw new Error(
        'wait_for_user can only begin in an orchestrator session',
      );
    }
    beginSharedUserWait(sessionID);
    options.invalidateIdle(sessionID);
  }

  function clearInputWaits(sessionID: string): void {
    inputWaitsByParent.delete(sessionID);
  }

  function trackInputWait(event: {
    type: string;
    properties?: {
      id?: string;
      requestID?: string;
      sessionID?: string;
    };
  }): void {
    const sessionID = event.properties?.sessionID;
    if (!sessionID || !options.shouldManageSession(sessionID)) {
      return;
    }

    if (isInputWaitAskEvent(event.type)) {
      const requestID = event.properties?.id;
      const waits =
        inputWaitsByParent.get(sessionID) ?? new Set<string | symbol>();
      if (!requestID) {
        waits.add(IDLESS_INPUT_WAIT);
        inputWaitsByParent.set(sessionID, waits);
        options.invalidateIdle(sessionID);
        return;
      }
      const key = inputWaitKey(INPUT_WAIT_ASK_EVENTS[event.type], requestID);
      waits.add(key);
      inputWaitsByParent.set(sessionID, waits);
      options.invalidateIdle(sessionID);
      return;
    }

    if (!isInputWaitResolutionEvent(event.type)) return;
    const requestID = event.properties?.requestID;
    if (!requestID) return;
    const key = inputWaitKey(
      INPUT_WAIT_RESOLUTION_EVENTS[event.type],
      requestID,
    );
    const waits = inputWaitsByParent.get(sessionID);
    if (!waits) return;
    waits.delete(key);
    if (waits.size === 0) clearInputWaits(sessionID);
  }

  return {
    beginUserWait,
    trackInputWait,
    hasInputWait,
    clearInputWaits,
    // Exposed for consumers not yet migrated (disposed handler, etc.)
    waitsByParent: inputWaitsByParent,
  };
}
