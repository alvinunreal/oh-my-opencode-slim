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

    // The title matches pending b, but the child's agent is fixer: the
    // oracle pending must not be claimed across agents.
    const hit = tracker.peekByParentAndAgent('parent-1', 'fixer', 'L2');

    expect(hit).toBeUndefined();
  });

  test('stale no-title claim is rejected after a same-agent call was consumed', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a' }));
    tracker.add(pending({ callId: 'b' }));

    // call a's after-hook consumed its pending; a late no-title
    // session.created may be a's stale child and must not claim b.
    tracker.take('a');

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

    tracker.take('a');

    // The consumed oracle call cannot explain a fixer child.
    const hit = tracker.peekByParentAndAgent('parent-1', 'fixer');

    expect(hit?.callId).toBe('b');
  });
});

describe('take', () => {
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

    // A before-hook admission error rolls its own pending back without
    // recording consumption (tool.execute.before catch path).
    const rolledBack = tracker.take('a', undefined, undefined, {
      recordConsumed: false,
    });
    expect(rolledBack?.callId).toBe('a');
    expect(tracker.hasConsumedCall('parent-1')).toBe(false);

    // A later no-title same-agent child is still claimable: the
    // staleness guard was not poisoned by the rollback.
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

    // The sole survivor is fenced for another board generation: the
    // no-callId take refuses WITHOUT consuming — the armed window must
    // not stain the still-tracked pending.
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
    expect(tracker.take('b')?.callId).toBe('b');
  });

  test('returns undefined when no pending is claimed for the task ID', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', earlyRegisteredTaskID: 'ses_x' }));

    expect(tracker.takeByTaskID('parent-1', 'ses_y')).toBeUndefined();
    expect(tracker.take('a')?.callId).toBe('a');
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

    // A different board generation's after-hook must not steal the
    // pending claimed under another generation.
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
    // Consumption is recorded like take(): a later no-title child of
    // the same agent is treated as possibly stale.
    expect(tracker.hasConsumedCall('parent-1', 'oracle')).toBe(true);
    expect(tracker.take('b')?.callId).toBe('b');
  });

  test('constrains by agent when the child agent is known', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'f1', agentType: 'fixer' }));
    tracker.add(pending({ callId: 'o1', agentType: 'oracle' }));

    // The output belongs to an oracle child: the older fixer pending
    // is not consumed.
    const taken = tracker.takeUnresolvedFirstMatch('parent-1', {
      identityTaskID: 'ses_x',
      agentType: 'oracle',
    });

    expect(taken?.callId).toBe('o1');
    expect(tracker.take('f1')?.callId).toBe('f1');
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
    expect(tracker.take('f1')?.callId).toBe('f1');
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

    // 'a' is a relaunch of ses_old; an output carrying ses_new cannot
    // belong to it, so the drain skips to the next candidate.
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

    // Window-shift propagation: the later no-callId sole take for the
    // same parent is flagged too — "sole survivor" no longer proves
    // identity once an unresolved drain shifted the ordering argument.
    const sole = tracker.take(undefined, 'parent-1');
    expect(sole?.callId).toBe('b');
    expect(sole?.identityUnresolved).toBe(true);
  });

  test('armed window never flags a claim-verified takeByTaskID take', () => {
    const tracker = createPendingCallTracker();
    tracker.add(pending({ callId: 'a', earlyRegisteredTaskID: 'ses_claimed' }));
    tracker.add(pending({ callId: 'b' }));

    // Drain the unmarked pending (a is fenced by its early-registration
    // claim), arming the parent's unresolved window.
    expect(
      tracker.takeUnresolvedFirstMatch('parent-1', {
        identityTaskID: 'ses_x',
      })?.callId,
    ).toBe('b');

    // A takeByTaskID take is identity-verified by the early
    // registration's claim: no unresolved flag.
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

    // A flagged pending never paints its label: the adopted record
    // falls back to the board's generic default description.
    expect(newBoard.get('ses_flagged')?.description).toBe(
      'background oracle task',
    );
    // A resolved pending keeps its verified label.
    expect(newBoard.get('ses_clean')?.description).toBe('Clean label');
  });
});
