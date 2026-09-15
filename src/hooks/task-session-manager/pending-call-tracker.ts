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
  /** Consumed without verified call identity (no-ID drain fallback or a
   *  window-shifted sole take): the label/objective may belong to a
   *  sibling call and must not be painted onto the board record. */
  identityUnresolved?: boolean;
}

const MAX_PENDING_TASK_CALLS = 100;

export interface PendingCallTracker {
  add(call: PendingTaskCall): void;
  take(
    callId?: string,
    parentSessionId?: string,
    ownerBoard?: BackgroundJobStore,
    options?: { recordConsumed?: boolean },
  ): PendingTaskCall | undefined;
  /** Remove and return the pending call whose early registration claimed
   * `taskID` for this parent — an identity-verified take for hosts that
   * do not supply tool call IDs. When `ownerBoard` is given and the
   * early registration was adopted by a different board generation, the
   * pending is left for that generation (same fence as `take`). */
  takeByTaskID(
    parentSessionId: string,
    taskID: string,
    ownerBoard?: BackgroundJobStore,
  ): PendingTaskCall | undefined;
  /** Guarded drain fallback for no-tool-call-ID hosts: when neither a
   *  call ID nor an early-registration claim could identify the
   *  pending, remove and return the OLDEST unmarked pending for the
   *  parent — constrained to `agentType` when the child's agent is
   *  known, and never a resumed pending pinned to a different
   *  `identityTaskID` (that pending provably belongs to another call).
   *  Pendings claimed by an early registration or fenced for another
   *  board generation are left for their owners. Consumption is
   *  recorded exactly like `take()`. The consumed call is marked
   *  `identityUnresolved` and arms the parent's unresolved window, so
   *  later no-callID sole-survivor takes for the same parent are
   *  flagged too. Returns undefined when no eligible pending exists. */
  takeUnresolvedFirstMatch(
    parentSessionId: string,
    selection?: {
      /** Task ID parsed from the consuming call's own output. */
      identityTaskID?: string;
      /** Agent of the child session that produced that output. */
      agentType?: string;
      /** Board-generation fence, same as take()/takeByTaskID(). */
      ownerBoard?: BackgroundJobStore;
    },
  ): PendingTaskCall | undefined;
  release(call: PendingTaskCall): void;
  peekByParent(parentSessionId: string): PendingTaskCall | undefined;
  peekByParentAndAgent(
    parentSessionId: string,
    agentHint?: string,
    title?: string,
  ): PendingTaskCall | undefined;
  /** True when a pending call for this parent (optionally of the given
   * agent type) was already consumed by its tool.execute.after. A
   * no-title session.created that arrives after such consumption may be
   * a stale child of the consumed call, so claims must be refused. */
  hasConsumedCall(parentSessionId: string, agentType?: string): boolean;
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

  /** Parents where a pending was consumed through the unresolved-identity
   *  drain fallback. The sole-survivor argument for a later no-callID
   *  take only holds while every prior take was resolved; one unresolved
   *  drain shifts the window, so subsequent sole takes are flagged too. */
  const unresolvedDrainParents = new Set<string>();

  /** Calls already consumed by their tool.execute.after, kept briefly so
   * late no-title session.created events can be recognized as possibly
   * stale children of a consumed call instead of claiming an unrelated
   * pending. */
  const consumedCalls = new Map<
    string,
    { parentSessionId: string; agentType: string }
  >();
  const MAX_CONSUMED_CALLS = 200;

  const recordConsumed = (call: PendingTaskCall): void => {
    consumedCalls.set(call.callId, {
      parentSessionId: call.parentSessionId,
      agentType: call.agentType,
    });
    while (consumedCalls.size > MAX_CONSUMED_CALLS) {
      const firstKey = consumedCalls.keys().next().value;
      if (firstKey === undefined) break;
      consumedCalls.delete(firstKey);
    }
  };

  const hasConsumedFor = (
    parentSessionId: string,
    agentType?: string,
  ): boolean => {
    for (const consumed of consumedCalls.values()) {
      if (consumed.parentSessionId !== parentSessionId) continue;
      if (agentType === undefined || consumed.agentType === agentType) {
        return true;
      }
    }
    return false;
  };

  const solePendingIdForParent = (
    parentSessionId: string,
  ): string | undefined => {
    let found: string | undefined;
    for (const [callId, call] of pendingCalls.entries()) {
      if (call.parentSessionId !== parentSessionId) continue;
      if (found !== undefined) return undefined;
      found = callId;
    }
    return found;
  };

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
      takeOptions?: { recordConsumed?: boolean },
    ) {
      // Set for a no-callId sole-survivor take on a parent whose
      // unresolved window is armed; the flag is applied only after the
      // fence checks below confirm this take actually consumes the
      // pending (a fenced take returns without consuming and must not
      // stain the pending for its owning generation).
      let unresolvedWindowTake = false;
      if (!callId && parentSessionId) {
        // Without a tool call ID a take can only be sound when exactly
        // one pending exists for the parent. "A sole survivor belongs
        // to this call" is a sequential argument — it holds when the
        // parent's other after-hooks already consumed their pendings,
        // not during a parallel burst where several after-hooks race.
        // With several candidates, guessing by insertion order would
        // mis-attribute the label and could overwrite an
        // already-correct record, so the take refuses; the caller
        // resolves identity via takeByTaskID (early-registration
        // claim) or, failing that, drains one pending through the
        // guarded takeUnresolvedFirstMatch fallback.
        const sole = solePendingIdForParent(parentSessionId);
        if (!sole) return undefined;
        callId = sole;
        // Window-shift propagation: an unresolved drain earlier in this
        // parent's burst means "sole survivor belongs to this call" no
        // longer proves identity — the consumed pending is flagged
        // unresolved below.
        unresolvedWindowTake = unresolvedDrainParents.has(parentSessionId);
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
      if (pending && unresolvedWindowTake) {
        pending.identityUnresolved = true;
      }
      if (pending && takeOptions?.recordConsumed !== false) {
        recordConsumed(pending);
      }
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
     * Peek a pending call for a parent, only when it can be identified
     * unambiguously. The v2 host stamps the child session title with the
     * tool call's `description` argument, so an exact label match
     * identifies the originating call even among same-agent parallel
     * launches. When a title is known but matches no unique pending, the
     * owning call's pending is already consumed (or labels collide) —
     * refuse rather than guess, because a wrong pairing mis-attributes
     * the child session (see docs/superpowers/plans/2026-09-12-
     * task-session-parallel-pairing.md).
     */
    peekByParentAndAgent(
      parentSessionId: string,
      agentHint?: string,
      title?: string,
    ) {
      const unmarked: PendingTaskCall[] = [];
      for (const call of pendingCalls.values()) {
        if (
          call.parentSessionId === parentSessionId &&
          !call.earlyRegisteredTaskID &&
          !call.earlyRegistrationRejected
        ) {
          unmarked.push(call);
        }
      }
      if (unmarked.length === 0) return undefined;

      if (typeof title === 'string' && title !== '') {
        // Title matching is identity-strong (the host stamps the child
        // title with the call's description argument), but labels can be
        // reused across different agents in one parent turn; never claim
        // a pending whose agent differs from the child session's agent.
        const byTitle = unmarked.filter(
          (call) =>
            call.label === title &&
            (!agentHint || call.agentType === agentHint),
        );
        return byTitle.length === 1 ? byTitle[0] : undefined;
      }

      if (agentHint) {
        const byAgent = unmarked.filter((call) => call.agentType === agentHint);
        if (byAgent.length !== 1) return undefined;
        // A same-agent call that was already consumed (its after-hook
        // ran) may be the true owner of this no-title child — its
        // registration already had its chance, so this event is most
        // likely stale. Refuse; the caller registers a placeholder.
        if (hasConsumedFor(parentSessionId, agentHint)) return undefined;
        return byAgent[0];
      }

      if (unmarked.length === 1) {
        if (hasConsumedFor(parentSessionId)) return undefined;
        return unmarked[0];
      }
      return undefined;
    },

    hasConsumedCall(parentSessionId: string, agentType?: string): boolean {
      return hasConsumedFor(parentSessionId, agentType);
    },

    takeByTaskID(
      parentSessionId: string,
      taskID: string,
      ownerBoard?: BackgroundJobStore,
    ) {
      for (const [callId, call] of pendingCalls.entries()) {
        if (
          call.parentSessionId !== parentSessionId ||
          call.earlyRegisteredTaskID !== taskID
        ) {
          continue;
        }
        if (
          call.earlyRegistration &&
          ownerBoard &&
          call.earlyRegistration.backgroundJobBoard !== ownerBoard
        ) {
          return undefined;
        }
        pendingCalls.delete(callId);
        recordConsumed(call);
        return call;
      }
      return undefined;
    },

    takeUnresolvedFirstMatch(
      parentSessionId: string,
      selection?: {
        identityTaskID?: string;
        agentType?: string;
        ownerBoard?: BackgroundJobStore;
      },
    ) {
      for (const [callId, call] of pendingCalls.entries()) {
        if (call.parentSessionId !== parentSessionId) continue;
        // Only unmarked pendings are eligible: an early-registration
        // claim (or its rejection fence) ties the pending to another
        // resolution path that must keep working.
        if (call.earlyRegisteredTaskID || call.earlyRegistrationRejected) {
          continue;
        }
        // A resumed pending pinned to a different task ID belongs to a
        // call whose own output carries that ID.
        if (
          selection?.identityTaskID !== undefined &&
          call.resumedTaskId !== undefined &&
          call.resumedTaskId !== selection.identityTaskID
        ) {
          continue;
        }
        if (
          selection?.agentType !== undefined &&
          call.agentType !== selection.agentType
        ) {
          continue;
        }
        if (
          call.earlyRegistration &&
          selection?.ownerBoard &&
          call.earlyRegistration.backgroundJobBoard !== selection.ownerBoard
        ) {
          continue;
        }
        pendingCalls.delete(callId);
        recordConsumed(call);
        // Identity was not verified: the consumed pending's metadata may
        // belong to a sibling call, and the parent's sole-survivor
        // window has shifted for any later no-callID take.
        call.identityUnresolved = true;
        unresolvedDrainParents.add(parentSessionId);
        return call;
      }
      return undefined;
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
              // Never paint call-specific metadata from an unresolved
              // identity (mirrors registerTaskOutputLaunch): a flagged
              // pending falls back to the board's generic description.
              ...(pending.identityUnresolved
                ? {}
                : {
                    description: pending.label,
                    objective: pending.fullObjective ?? pending.label,
                  }),
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
      for (const [callId, consumed] of consumedCalls.entries()) {
        if (consumed.parentSessionId === sessionId) {
          consumedCalls.delete(callId);
        }
      }
      unresolvedDrainParents.delete(sessionId);
      // Release queued tickets before active tickets. Releasing an active
      // ticket pumps the scheduler, so doing it in insertion order could
      // admit a later call just as the parent is being deleted.
      for (const pending of removed.reverse()) {
        releaseCallLease(pending);
      }
    },

    clearAll(): void {
      const removed = [...pendingCalls.values()].reverse();
      pendingCalls.clear();
      consumedCalls.clear();
      unresolvedDrainParents.clear();
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
