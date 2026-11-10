import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from './background-job-board';

// The event fence skips its wait only for a generation with host launch
// evidence. The proof is caller-supplied: a launch path that omits the flag
// stays fenced (issue #1822 follow-up).

const base = {
  taskID: 'ses_child',
  parentSessionID: 'parent-1',
  agent: 'explorer',
  background: true,
  now: 100,
};

function proofOf(register: (board: BackgroundJobBoard) => void): unknown {
  const board = new BackgroundJobBoard();
  register(board);
  return board.get('ses_child')?.resumedRunProven;
}

describe('launch activity proof', () => {
  test('a resume the host already ran is proven', () => {
    expect(
      proofOf((board) =>
        board.registerLaunch({ ...base, resumedRunProven: true }),
      ),
    ).toBe(true);
  });

  test('a validated relaunch lease alone is not proof', () => {
    // The lease is acquired before the host write, so it exists while a late
    // event from the previous run could still be attributed to the new one.
    expect(
      proofOf((board) => {
        board.registerLaunch({ ...base });
        const lease = board.acquireLease('ses_child', 1, 'relaunch');
        if (!lease) throw new Error('lease unavailable');
        board.registerLaunch({ ...base, relaunchLease: lease });
      }),
    ).toBeUndefined();
  });
});
