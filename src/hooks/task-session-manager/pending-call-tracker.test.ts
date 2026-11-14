import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import {
  createPendingCallTracker,
  type PendingTaskCall,
} from './pending-call-tracker';

function pending(overrides: Partial<PendingTaskCall>): PendingTaskCall {
  return {
    callId: 'call-1',
    parentSessionId: 'parent-1',
    agentType: 'oracle',
    label: 'Review thing',
    background: true,
    lifecycleEpoch: 0,
    ...overrides,
  };
}

describe('peekByParentAndAgent', () => {
  test('title match wins among same-agent parallel pendings', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', label: 'L1' }));
    tracker.add(pending({ callId: 'b', label: 'L2' }));
    tracker.add(pending({ callId: 'c', label: 'L3' }));

    const hit = tracker.peekByParentAndAgent('parent-1', 'oracle', 'L2');

    expect(hit?.callId).toBe('b');
  });

  test('title present but no label match refuses instead of falling back to agent', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', label: 'L1' }));

    const hit = tracker.peekByParentAndAgent('parent-1', 'oracle', 'L9');

    expect(hit).toBeUndefined();
  });

  test('duplicate labels with matching title refuse', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', label: 'L1' }));
    tracker.add(pending({ callId: 'b', label: 'L1' }));

    const hit = tracker.peekByParentAndAgent('parent-1', 'oracle', 'L1');

    expect(hit).toBeUndefined();
  });

  test('unique agent match still wins without title (council reviewers)', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', agentType: 'fixer' }));
    tracker.add(pending({ callId: 'b', agentType: 'oracle' }));

    const hit = tracker.peekByParentAndAgent('parent-1', 'oracle');

    expect(hit?.callId).toBe('b');
  });

  test('multiple same-agent pendings without title refuse (incident case)', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a' }));
    tracker.add(pending({ callId: 'b' }));
    tracker.add(pending({ callId: 'c' }));

    expect(tracker.peekByParentAndAgent('parent-1', 'oracle')).toBeUndefined();
  });

  test('skips pendings that are early-registered or fenced', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', earlyRegisteredTaskID: 'ses_x' }));
    tracker.add(pending({ callId: 'b', earlyRegistrationRejected: true }));

    expect(tracker.peekByParentAndAgent('parent-1', 'oracle')).toBeUndefined();
  });

  test('single unmarked pending without agent hint is returned', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', agentType: 'fixer' }));

    const hit = tracker.peekByParentAndAgent('parent-1');

    expect(hit?.callId).toBe('a');
  });

  test('title match is constrained by the agent hint', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', agentType: 'fixer', label: 'L1' }));
    tracker.add(pending({ callId: 'b', agentType: 'oracle', label: 'L2' }));

    // The title matches b but the child's agent is fixer: no cross-agent claim.
    const hit = tracker.peekByParentAndAgent('parent-1', 'fixer', 'L2');

    expect(hit).toBeUndefined();
  });

  test('stale no-title claim is rejected after a same-agent call was consumed', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a' }));
    tracker.add(pending({ callId: 'b' }));

    // call a's pending was consumed; a late no-title child may be its stale one.
    tracker.take('a', 'parent-1');

    expect(tracker.peekByParentAndAgent('parent-1', 'oracle')).toBeUndefined();
  });

  test('no-title unique-agent claim still works before any consumption', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', agentType: 'oracle' }));
    tracker.add(pending({ callId: 'b', agentType: 'fixer' }));

    const hit = tracker.peekByParentAndAgent('parent-1', 'oracle');

    expect(hit?.callId).toBe('a');
  });

  test('consumed-call staleness guard is scoped by agent', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', agentType: 'oracle' }));
    tracker.add(pending({ callId: 'b', agentType: 'fixer' }));

    tracker.take('a', 'parent-1');

    // The consumed oracle call cannot explain a fixer child.
    const hit = tracker.peekByParentAndAgent('parent-1', 'fixer');

    expect(hit?.callId).toBe('b');
  });
});

describe('take', () => {
  test('identical call IDs in different parents retain separate ownership', () => {
    const tracker = createPendingCallTracker();
    const first = pending({ parentSessionId: 'parent-1' });
    const second = pending({ parentSessionId: 'parent-2' });
    tracker.add(first);
    tracker.add(second);

    expect(tracker.peekByCallId('call-1', 'parent-3')).toBeUndefined();
    expect(tracker.take('call-1', 'wrong-parent')).toBeUndefined();
    expect(tracker.peekByCallId('call-1', 'parent-1')).toBe(first);
    expect(tracker.peekByCallId('call-1', 'parent-2')).toBe(second);
    expect(tracker.take('call-1', 'parent-1')).toBe(first);
    expect(tracker.hasConsumedCall('parent-1')).toBe(true);
    expect(tracker.hasConsumedCall('parent-2')).toBe(false);
    expect(tracker.take('call-1', 'parent-2')).toBe(second);
  });

  test('without callID, refuses when multiple pendings match the parent', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a' }));
    tracker.add(pending({ callId: 'b' }));

    expect(tracker.take(undefined, 'parent-1')).toBeUndefined();
    // Nothing was consumed by the refused take.
    expect(tracker.hasConsumedCall('parent-1')).toBe(false);
  });

  test('without callID, takes the sole pending for the parent', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a' }));

    const taken = tracker.take(undefined, 'parent-1');

    expect(taken?.callId).toBe('a');
  });

  test('recordConsumed:false rollback does not arm the staleness guard', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a' }));
    tracker.add(pending({ callId: 'b' }));

    // A before-hook admission error rolls back without recording consumption.
    const rolledBack = tracker.take('a', 'parent-1', undefined, {
      recordConsumed: false,
    });
    expect(rolledBack?.callId).toBe('a');
    expect(tracker.hasConsumedCall('parent-1')).toBe(false);

    // A later no-title same-agent child is still claimable (not poisoned).
    const hit = tracker.peekByParentAndAgent('parent-1', 'oracle');
    expect(hit?.callId).toBe('b');
  });

  test('fenced sole-survivor take does not stain the unconsumed pending', () => {
    const tracker = createPendingCallTracker();
    const ownerBoard = new BackgroundJobBoard();
    const otherBoard = new BackgroundJobBoard();
    tracker.add(
      pending({
        callId: 'a',
        earlyRegisteredTaskID: 'ses_x',
        earlyRegistration: {
          taskID: 'ses_x',
          generation: 1,
          backgroundJobBoard: ownerBoard,
        },
      }),
    );
    tracker.add(pending({ callId: 'b' }));
    // Arm the parent's unresolved window via a drain (the flagged
    // early-registered pending is skipped; 'b' is consumed).
    tracker.takeUnresolvedFirstMatch('parent-1', { identityTaskID: 'ses_y' });

    // Another board generation refuses the no-callId take without consuming.
    expect(tracker.take(undefined, 'parent-1', otherBoard)).toBeUndefined();

    // The owning generation resolves it by claim, unflagged.
    const claimed = tracker.takeByTaskID('parent-1', 'ses_x', ownerBoard);
    expect(claimed?.callId).toBe('a');
    expect(claimed?.identityUnresolved).toBeUndefined();
  });
});

describe('takeByTaskID', () => {
  test('removes and returns the pending claimed for that task ID', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', earlyRegisteredTaskID: 'ses_x' }));
    tracker.add(pending({ callId: 'b' }));

    const taken = tracker.takeByTaskID('parent-1', 'ses_x');

    expect(taken?.callId).toBe('a');
    // The other pending is untouched.
    expect(tracker.take('b', 'parent-1')?.callId).toBe('b');
  });

  test('returns undefined when no pending is claimed for the task ID', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', earlyRegisteredTaskID: 'ses_x' }));

    expect(tracker.takeByTaskID('parent-1', 'ses_y')).toBeUndefined();
    expect(tracker.take('a', 'parent-1')?.callId).toBe('a');
  });

  test('leaves a pending owned by another board instance untouched', () => {
    const tracker = createPendingCallTracker();
    const ownerBoard = new BackgroundJobBoard();
    const otherBoard = new BackgroundJobBoard();
    tracker.add(
      pending({
        callId: 'a',
        earlyRegisteredTaskID: 'ses_x',
        earlyRegistration: {
          taskID: 'ses_x',
          generation: 1,
          backgroundJobBoard: otherBoard,
        },
      }),
    );

    // Another board generation's after-hook must not steal the pending.
    expect(
      tracker.takeByTaskID('parent-1', 'ses_x', ownerBoard),
    ).toBeUndefined();

    // The owning board generation can still resolve it.
    const taken = tracker.takeByTaskID('parent-1', 'ses_x', otherBoard);
    expect(taken?.callId).toBe('a');
  });
});

describe('takeUnresolvedFirstMatch', () => {
  test('drains the oldest unmarked pending and records consumption', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a' }));
    tracker.add(pending({ callId: 'b' }));

    const taken = tracker.takeUnresolvedFirstMatch('parent-1', {
      identityTaskID: 'ses_new',
    });

    expect(taken?.callId).toBe('a');
    // Consumption is recorded like take(): a later no-title child may be stale.
    expect(tracker.hasConsumedCall('parent-1', 'oracle')).toBe(true);
    expect(tracker.take('b', 'parent-1')?.callId).toBe('b');
  });

  test('constrains by agent when the child agent is known', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'f1', agentType: 'fixer' }));
    tracker.add(pending({ callId: 'o1', agentType: 'oracle' }));

    // The output belongs to an oracle child: the older fixer pending survives.
    const taken = tracker.takeUnresolvedFirstMatch('parent-1', {
      identityTaskID: 'ses_x',
      agentType: 'oracle',
    });

    expect(taken?.callId).toBe('o1');
    expect(tracker.take('f1', 'parent-1')?.callId).toBe('f1');
  });

  test('returns undefined when no pending matches the known agent', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'f1', agentType: 'fixer' }));

    expect(
      tracker.takeUnresolvedFirstMatch('parent-1', {
        identityTaskID: 'ses_x',
        agentType: 'oracle',
      }),
    ).toBeUndefined();
    expect(tracker.take('f1', 'parent-1')?.callId).toBe('f1');
  });

  test('never consumes early-registered or rejected pendings', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', earlyRegisteredTaskID: 'ses_x' }));
    tracker.add(pending({ callId: 'b', earlyRegistrationRejected: true }));
    tracker.add(pending({ callId: 'c' }));

    expect(tracker.takeUnresolvedFirstMatch('parent-1')?.callId).toBe('c');
  });

  test('skips resumed pendings pinned to a different task ID', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', resumedTaskId: 'ses_old' }));
    tracker.add(pending({ callId: 'b' }));

    // A relaunch of ses_old cannot match an output carrying ses_new.
    const taken = tracker.takeUnresolvedFirstMatch('parent-1', {
      identityTaskID: 'ses_new',
    });
    expect(taken?.callId).toBe('b');

    // An output carrying the resumed ID may still drain it.
    const pinned = createPendingCallTracker();
    pinned.add(pending({ callId: 'a', resumedTaskId: 'ses_old' }));
    expect(
      pinned.takeUnresolvedFirstMatch('parent-1', {
        identityTaskID: 'ses_old',
      })?.callId,
    ).toBe('a');
  });

  test('returns undefined for a parent with no pendings', () => {
    const tracker = createPendingCallTracker();

    expect(
      tracker.takeUnresolvedFirstMatch('parent-1', { identityTaskID: 'ses_x' }),
    ).toBeUndefined();
  });

  test('flags the drained call unresolved and arms the parent window', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a' }));
    tracker.add(pending({ callId: 'b' }));

    const taken = tracker.takeUnresolvedFirstMatch('parent-1', {
      identityTaskID: 'ses_x',
    });

    expect(taken?.callId).toBe('a');
    expect(taken?.identityUnresolved).toBe(true);

    // Window-shift propagation also flags the later no-callId sole take.
    const sole = tracker.take(undefined, 'parent-1');
    expect(sole?.callId).toBe('b');
    expect(sole?.identityUnresolved).toBe(true);
  });

  test('armed window never flags a claim-verified takeByTaskID take', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', earlyRegisteredTaskID: 'ses_claimed' }));
    tracker.add(pending({ callId: 'b' }));

    // Drain 'b' (a is fenced by its early-registration claim), arming the window.
    expect(
      tracker.takeUnresolvedFirstMatch('parent-1', {
        identityTaskID: 'ses_x',
      })?.callId,
    ).toBe('b');

    // The early-registration claim verifies identity: no unresolved flag.
    const claimed = tracker.takeByTaskID('parent-1', 'ses_claimed');
    expect(claimed?.callId).toBe('a');
    expect(claimed?.identityUnresolved).toBeUndefined();
  });

  test('clearSession resets the unresolved window for that parent', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a' }));
    tracker.takeUnresolvedFirstMatch('parent-1', { identityTaskID: 'ses_x' });

    tracker.clearSession('parent-1');

    // A fresh pending in the cleared window resolves normally.
    tracker.add(pending({ callId: 'b' }));
    const sole = tracker.take(undefined, 'parent-1');
    expect(sole?.callId).toBe('b');
    expect(sole?.identityUnresolved).toBeUndefined();
  });

  test('clearAll resets every unresolved window', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', parentSessionId: 'parent-1' }));
    tracker.takeUnresolvedFirstMatch('parent-1', { identityTaskID: 'ses_x' });

    tracker.clearAll();

    tracker.add(pending({ callId: 'b', parentSessionId: 'parent-1' }));
    const sole = tracker.take(undefined, 'parent-1');
    expect(sole?.identityUnresolved).toBeUndefined();
  });
});

describe('adoptEarlyRegistrations', () => {
  test('identity-unresolved pendings adopt with generic metadata', () => {
    const oldBoard = new BackgroundJobBoard();
    const newBoard = new BackgroundJobBoard();
    const tracker = createPendingCallTracker();
    tracker.add(
      pending({
        callId: 'flagged',
        label: 'Flagged label',
        identityUnresolved: true,
        earlyRegisteredTaskID: 'ses_flagged',
        earlyRegistration: {
          taskID: 'ses_flagged',
          generation: 1,
          backgroundJobBoard: oldBoard,
        },
      }),
    );
    tracker.add(
      pending({
        callId: 'clean',
        label: 'Clean label',
        earlyRegisteredTaskID: 'ses_clean',
        earlyRegistration: {
          taskID: 'ses_clean',
          generation: 1,
          backgroundJobBoard: oldBoard,
        },
      }),
    );

    tracker.adoptEarlyRegistrations(newBoard);

    // A flagged pending never paints its label: the board default is used.
    expect(newBoard.get('ses_flagged')?.description).toBe(
      'background oracle task',
    );
    // A resolved pending keeps its verified label.
    expect(newBoard.get('ses_clean')?.description).toBe('Clean label');
  });

  test('adoption over an existing placeholder promotes it', () => {
    const oldBoard = new BackgroundJobBoard();
    const newBoard = new BackgroundJobBoard();
    oldBoard.registerLaunch({
      taskID: 'ses_adopt',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'L1',
      now: 100,
    });
    const placeholder = newBoard.registerLaunch({
      taskID: 'ses_adopt',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      provisional: true,
      now: 100,
    });

    const tracker = createPendingCallTracker();
    tracker.add(
      pending({
        callId: 'a',
        label: 'L1',
        earlyRegisteredTaskID: 'ses_adopt',
        earlyRegistration: {
          taskID: 'ses_adopt',
          generation: oldBoard.get('ses_adopt')?.generation ?? 1,
          backgroundJobBoard: oldBoard,
        },
      }),
    );

    tracker.adoptEarlyRegistrations(newBoard);

    // The destination becomes attributed work; the placeholder promotes.
    expect(newBoard.get('ses_adopt')?.provisional).toBe(false);
    expect(newBoard.get('ses_adopt')?.state).toBe(placeholder.state);
  });
});

describe('host admission anchors', () => {
  test('first admission wins; later inputs never replace it', () => {
    const tracker = createPendingCallTracker();
    expect(tracker.firstAdmission('ses_child')).toBeUndefined();
    tracker.noteAdmission('ses_child', 'msg_1');
    tracker.noteAdmission('ses_child', 'msg_1');
    expect(tracker.firstAdmission('ses_child')).toBe('msg_1');
    tracker.noteAdmission('ses_child', 'msg_2');
    expect(tracker.firstAdmission('ses_child')).toBe('msg_1');
  });

  test('a unique resumed pending binds the admission input', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', resumedTaskId: 'ses_child' }));

    tracker.noteAdmission('ses_child', 'msg_1');
    expect(tracker.take('a', 'parent-1')?.inputMessageID).toBe('msg_1');
  });

  test('a repeated identical admission leaves the binding unchanged', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', resumedTaskId: 'ses_child' }));

    tracker.noteAdmission('ses_child', 'msg_1');
    tracker.noteAdmission('ses_child', 'msg_1');
    expect(tracker.take('a', 'parent-1')?.inputMessageID).toBe('msg_1');
  });

  test('a different subsequent admission makes the pending permanently ambiguous', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', resumedTaskId: 'ses_child' }));

    tracker.noteAdmission('ses_child', 'msg_1');
    tracker.noteAdmission('ses_child', 'msg_2');
    const taken = tracker.take('a', 'parent-1');
    expect(taken?.inputMessageID).toBeNull();

    // Permanent: a third id does not revive the binding either.
    const later = createPendingCallTracker();
    later.add(pending({ callId: 'b', resumedTaskId: 'ses_child' }));
    later.noteAdmission('ses_child', 'msg_1');
    later.noteAdmission('ses_child', 'msg_2');
    later.noteAdmission('ses_child', 'msg_3');
    expect(later.take('b', 'parent-1')?.inputMessageID).toBeNull();
  });

  test('a replayed first admission never re-binds a live pending', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', resumedTaskId: 'ses_child' }));

    tracker.noteAdmission('ses_child', 'msg_1');
    // Old-context replay of the same first id must not disturb the binding.
    tracker.noteAdmission('ses_child', 'msg_1');
    expect(tracker.take('a', 'parent-1')?.inputMessageID).toBe('msg_1');

    // ...and must not bind an unbound pending from a previous generation.
    tracker.add(pending({ callId: 'b', resumedTaskId: 'ses_child' }));
    tracker.noteAdmission('ses_child', 'msg_1');
    expect(tracker.take('b', 'parent-1')?.inputMessageID).toBeUndefined();
  });

  test('ambiguous resumed targets bind nothing', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', resumedTaskId: 'ses_child' }));
    tracker.add(pending({ callId: 'b', resumedTaskId: 'ses_child' }));

    tracker.noteAdmission('ses_child', 'msg_1');
    // Permanent ambiguity, not merely "unbound": it survives the cousin.
    expect(tracker.peekByCallId('a', 'parent-1')?.inputMessageID).toBeNull();
    expect(tracker.peekByCallId('b', 'parent-1')?.inputMessageID).toBeNull();

    // Consuming the cousin does not clear the ambiguity for the survivor.
    tracker.take('a', 'parent-1');
    tracker.noteAdmission('ses_child', 'msg_2');
    expect(tracker.take('b', 'parent-1')?.inputMessageID).toBeNull();
  });

  test.each([2, 3])(
    'a later admission invalidates all %s matching pendings, not other sessions',
    (count) => {
      const tracker = createPendingCallTracker();
      const calls = Array.from({ length: count }, (_, index) =>
        pending({ callId: `call-${index}`, resumedTaskId: 'ses_child' }),
      );
      tracker.add(calls[0]);
      tracker.noteAdmission('ses_child', 'msg_a');
      expect(calls[0].inputMessageID).toBe('msg_a');
      const other = pending({ callId: 'other', resumedTaskId: 'ses_other' });
      tracker.add(other);
      tracker.noteAdmission('ses_other', 'msg_other');
      for (const call of calls.slice(1)) tracker.add(call);

      tracker.noteAdmission('ses_child', 'msg_b');
      for (const call of calls) expect(call.inputMessageID).toBeNull();
      expect(other.inputMessageID).toBe('msg_other');
      tracker.take(calls[1].callId, 'parent-1');
      tracker.noteAdmission('ses_child', 'msg_c');
      for (const call of calls) expect(call.inputMessageID).toBeNull();
    },
  );

  test('a resumed pending binds its own later admission, not the session map', () => {
    const tracker = createPendingCallTracker();
    // Generation 1: a resume of ses_old admitted msg_1.
    tracker.add(pending({ callId: 'gen1', resumedTaskId: 'ses_old' }));
    tracker.noteAdmission('ses_old', 'msg_1');
    tracker.take('gen1', 'parent-1');

    // Generation 2: the session map still holds msg_1; the pending binds its own.
    tracker.add(pending({ callId: 'gen2', resumedTaskId: 'ses_old' }));
    tracker.noteAdmission('ses_old', 'msg_2');
    const taken = tracker.take('gen2', 'parent-1');
    expect(taken?.inputMessageID).toBe('msg_2');
    expect(tracker.firstAdmission('ses_old')).toBe('msg_1');
  });

  test('fresh pendings (no resumedTaskId) never bind admissions', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a' }));

    tracker.noteAdmission('parent-1', 'msg_1');
    expect(tracker.take('a', 'parent-1')?.inputMessageID).toBeUndefined();
  });

  test('the first-admission map clears with lifecycle state', () => {
    const tracker = createPendingCallTracker();
    tracker.noteAdmission('ses_child', 'msg_1');
    tracker.clearSession('ses_child');
    expect(tracker.firstAdmission('ses_child')).toBeUndefined();
    tracker.noteAdmission('ses_other', 'msg_3');
    tracker.clearAll();
    expect(tracker.firstAdmission('ses_other')).toBeUndefined();
  });

  test('the first-admission map stays bounded at 256 sessions', () => {
    const tracker = createPendingCallTracker();
    for (let i = 0; i < 300; i += 1) {
      tracker.noteAdmission(`ses_${i}`, `msg_${i}`);
    }
    expect(tracker.firstAdmission('ses_0')).toBeUndefined();
    expect(tracker.firstAdmission('ses_299')).toBe('msg_299');
  });
});
