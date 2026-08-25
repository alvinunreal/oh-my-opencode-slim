import type { BackgroundJobLease } from '../../utils/background-job-board';

export interface PendingTaskCall {
  callId: string;
  parentSessionId: string;
  agentType: string;
  label: string;
  /** Untruncated objective text the label was derived from; board comparison
   *  uses this so long exact duplicates are not missed. */
  fullObjective?: string;
  background: boolean;
  /** Deletion epoch observed when this native task call started. */
  lifecycleEpoch: number;
  resumedTaskId?: string;
  relaunchLease?: BackgroundJobLease;
  earlyRegisteredTaskID?: string;
  earlyRegistrationRejected?: boolean;
}

const MAX_PENDING_TASK_CALLS = 100;

export function createPendingCallTracker(
  options: { releaseLease?: (lease: BackgroundJobLease) => boolean } = {},
) {
  const pendingCalls = new Map<string, PendingTaskCall>();
  let anonymousPendingCallId = 0;

  const releaseCallLease = (call: PendingTaskCall): void => {
    if (call.relaunchLease) options.releaseLease?.(call.relaunchLease);
  };

  return {
    add(call: PendingTaskCall) {
      const replaced = pendingCalls.get(call.callId);
      if (replaced) releaseCallLease(replaced);
      pendingCalls.delete(call.callId);
      pendingCalls.set(call.callId, call);
      while (pendingCalls.size > MAX_PENDING_TASK_CALLS) {
        const firstKey = pendingCalls.keys().next().value;
        if (firstKey === undefined) break;
        const evicted = pendingCalls.get(firstKey);
        pendingCalls.delete(firstKey);
        if (evicted) releaseCallLease(evicted);
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

    release(call: PendingTaskCall) {
      releaseCallLease(call);
    },

    /** Peek oldest pending call for a parent without removing it. */
    peekByParent(parentSessionId: string) {
      for (const call of pendingCalls.values()) {
        if (
          call.parentSessionId === parentSessionId &&
          !call.earlyRegisteredTaskID &&
          !call.earlyRegistrationRejected
        ) {
          return call;
        }
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
        if (call.earlyRegisteredTaskID || call.earlyRegistrationRejected) {
          continue;
        }
        if (!fallback) fallback = call;
        if (call.agentType === agentHint) return call;
      }
      return fallback;
    },

    clearSession(sessionId: string) {
      for (const [callId, pending] of pendingCalls.entries()) {
        if (pending.parentSessionId === sessionId) {
          pendingCalls.delete(callId);
          releaseCallLease(pending);
        }
      }
    },

    clearAll() {
      for (const pending of pendingCalls.values()) releaseCallLease(pending);
      pendingCalls.clear();
    },

    pendingCallId(sessionID?: string, callID?: string) {
      return (
        callID ??
        `${sessionID ?? 'unknown'}:anonymous-${++anonymousPendingCallId}`
      );
    },
  };
}
