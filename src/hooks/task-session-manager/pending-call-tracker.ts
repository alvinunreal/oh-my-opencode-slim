export interface PendingTaskCall {
  callId: string;
  parentSessionId: string;
  agentType: string;
  label: string;
  resumedTaskId?: string;
}

const MAX_PENDING_TASK_CALLS = 100;

export function createPendingCallTracker() {
  const pendingCalls = new Map<string, PendingTaskCall>();
  let anonymousPendingCallId = 0;

  return {
    add(call: PendingTaskCall) {
      pendingCalls.delete(call.callId);
      pendingCalls.set(call.callId, call);
      while (pendingCalls.size > MAX_PENDING_TASK_CALLS) {
        const firstKey = pendingCalls.keys().next().value;
        if (firstKey === undefined) break;
        pendingCalls.delete(firstKey);
      }
    },

    take(callId?: string, parentSessionId?: string) {
      if (!callId && parentSessionId) {
        for (const id of pendingCalls.keys()) {
          const call = pendingCalls.get(id);
          if (call && call.parentSessionId === parentSessionId) {
            callId = id;
            break;
          }
        }
      }
      if (!callId) return undefined;
      const pending = pendingCalls.get(callId);
      pendingCalls.delete(callId);
      return pending;
    },

    /** Peek oldest pending call for a parent without removing it. */
    peekByParent(parentSessionId: string) {
      for (const call of pendingCalls.values()) {
        if (call.parentSessionId === parentSessionId) return call;
      }
      return undefined;
    },

    peek(callId?: string, parentSessionId?: string) {
      if (!callId && parentSessionId) {
        for (const id of pendingCalls.keys()) {
          const call = pendingCalls.get(id);
          if (call && call.parentSessionId === parentSessionId) {
            callId = id;
            break;
          }
        }
      }
      if (!callId) return undefined;
      return pendingCalls.get(callId);
    },

    clearSession(sessionId: string) {
      for (const [callId, pending] of pendingCalls.entries()) {
        if (pending.parentSessionId === sessionId) {
          pendingCalls.delete(callId);
        }
      }
    },

    pendingCallId(sessionID?: string, callID?: string) {
      return (
        callID ??
        `${sessionID ?? 'unknown'}:anonymous-${++anonymousPendingCallId}`
      );
    },
  };
}
