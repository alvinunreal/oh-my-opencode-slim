import type { BackgroundJobLease } from '../../utils/background-job-board';
import type { BackgroundJobStore } from '../../utils/background-job-store';
import type { BackgroundJobSupervisor } from '../../utils/background-job-supervisor';
import type { BackgroundTaskConcurrencyTicket } from '../../utils/background-task-concurrency';

export interface EarlyTaskRegistration {
  taskID: string;
  generation: number;
  backgroundJobBoard: BackgroundJobStore;
  backgroundJobSupervisor?: BackgroundJobSupervisor;
}

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
  /** Board generation that owns the relaunch lease. */
  releaseLease?: (lease: BackgroundJobLease) => boolean;
  concurrencyTicket?: BackgroundTaskConcurrencyTicket;
  earlyRegisteredTaskID?: string;
  earlyRegistration?: EarlyTaskRegistration;
  earlyRegistrationRejected?: boolean;
}

const MAX_PENDING_TASK_CALLS = 100;

export interface PendingCallTracker {
  add(call: PendingTaskCall): void;
  take(
    callId?: string,
    parentSessionId?: string,
    ownerBoard?: BackgroundJobStore,
  ): PendingTaskCall | undefined;
  release(call: PendingTaskCall): void;
  peekByParent(parentSessionId: string): PendingTaskCall | undefined;
  peekByParentAndAgent(
    parentSessionId: string,
    agentHint?: string,
  ): PendingTaskCall | undefined;
  adoptEarlyRegistrations(
    backgroundJobBoard: BackgroundJobStore,
    backgroundJobSupervisor?: BackgroundJobSupervisor,
  ): void;
  clearSession(sessionId: string): void;
  clearAll(): void;
  pendingCallId(sessionID?: string, callID?: string): string;
}

export function createPendingCallTracker(
  options: { releaseLease?: (lease: BackgroundJobLease) => boolean } = {},
) {
  const pendingCalls = new Map<string, PendingTaskCall>();
  let anonymousPendingCallId = 0;

  const releaseCallLease = (call: PendingTaskCall): void => {
    if (call.relaunchLease) {
      (call.releaseLease ?? options.releaseLease)?.(call.relaunchLease);
    }
    call.concurrencyTicket?.releaseIfUnbound();
  };

  const tracker: PendingCallTracker = {
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

    take(
      callId?: string,
      parentSessionId?: string,
      ownerBoard?: BackgroundJobStore,
    ) {
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
      if (
        pending?.earlyRegistration &&
        ownerBoard &&
        pending.earlyRegistration.backgroundJobBoard !== ownerBoard
      ) {
        return undefined;
      }
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

    adoptEarlyRegistrations(
      backgroundJobBoard: BackgroundJobStore,
      backgroundJobSupervisor?: BackgroundJobSupervisor,
    ) {
      for (const pending of pendingCalls.values()) {
        const registration = pending.earlyRegistration;
        if (
          !registration ||
          registration.backgroundJobBoard === backgroundJobBoard
        ) {
          continue;
        }

        const existing = backgroundJobBoard.get(registration.taskID);
        if (
          existing &&
          (existing.parentSessionID !== pending.parentSessionId ||
            existing.agent !== pending.agentType)
        ) {
          continue;
        }

        let adopted = existing;
        if (!adopted) {
          try {
            adopted = backgroundJobBoard.registerLaunch({
              taskID: registration.taskID,
              parentSessionID: pending.parentSessionId,
              agent: pending.agentType,
              description: pending.label,
              objective: pending.fullObjective ?? pending.label,
              background: false,
              preserveRun: true,
            });
          } catch {
            continue;
          }
        }

        registration.backgroundJobBoard.drop(registration.taskID);
        registration.backgroundJobSupervisor?.drop(registration.taskID);
        registration.backgroundJobBoard = backgroundJobBoard;
        registration.backgroundJobSupervisor = backgroundJobSupervisor;
        registration.generation = adopted.generation;
      }
    },

    clearSession(sessionId: string) {
      const removed: PendingTaskCall[] = [];
      for (const [callId, pending] of pendingCalls.entries()) {
        if (pending.parentSessionId !== sessionId) continue;
        pendingCalls.delete(callId);
        removed.push(pending);
      }
      // Release queued tickets before active tickets. Releasing an active
      // ticket pumps the scheduler, so doing it in insertion order could
      // admit a later call just as the parent is being deleted.
      for (const pending of removed.reverse()) {
        releaseCallLease(pending);
      }
    },

    clearAll() {
      const removed = [...pendingCalls.values()].reverse();
      pendingCalls.clear();
      for (const pending of removed) releaseCallLease(pending);
    },

    pendingCallId(sessionID?: string, callID?: string) {
      return (
        callID ??
        `${sessionID ?? 'unknown'}:anonymous-${++anonymousPendingCallId}`
      );
    },
  };

  return tracker;
}
