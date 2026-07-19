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

    /**
     * Peek a pending call for a parent, preferring one whose agentType
     * matches `agentHint`. Used by session.created early registration:
     * when a parent launches several parallel task tools with different
     * subagent types (e.g. council reviewers), `info.agent` on the
     * child session identifies which subagent started it, so we can
     * avoid attributing the child to the wrong pending call.
     * Falls back to the oldest pending call for the parent when no
     * agent match is found (preserves prior behavior).
     */
    peekByParentAndAgent(parentSessionId: string, agentHint?: string) {
      if (!agentHint) return this.peekByParent(parentSessionId);
      let fallback: PendingTaskCall | undefined;
      for (const call of pendingCalls.values()) {
        if (call.parentSessionId !== parentSessionId) continue;
        if (!fallback) fallback = call;
        if (call.agentType === agentHint) return call;
      }
      return fallback;
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
