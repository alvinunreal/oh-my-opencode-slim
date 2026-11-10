import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from './background-job-board';

// The event fence skips its wait only for a generation with host launch
// evidence. The board derives that evidence from the launch kind, so a new
// launch path cannot forget to pass a flag (issue #1822 follow-up).

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
        board.registerLaunch({ ...base, resumedRunProven: true } as never),
      ),
    ).toBe(true);
  });

  test('a validated relaunch lease is proven', () => {
    expect(
      proofOf((board) => {
        board.registerLaunch({ ...base } as never);
        const lease = board.acquireLease('ses_child', 1, 'relaunch');
        if (!lease) throw new Error('lease unavailable');
        board.registerLaunch({ ...base, relaunchLease: lease } as never);
      }),
    ).toBe(true);
  });

  test('a plain relaunch without a lease is not proven', () => {
    expect(
      proofOf((board) => {
        board.registerLaunch({ ...base } as never);
        board.registerLaunch({ ...base } as never);
      }),
    ).toBeUndefined();
  });

  test('a provisional placeholder is not proven', () => {
    expect(
      proofOf((board) =>
        board.registerLaunch({ ...base, provisional: true } as never),
      ),
    ).toBeUndefined();
  });

  test('an adopted observation is not proven', () => {
    expect(
      proofOf((board) =>
        board.registerLaunch({ ...base, adopted: true } as never),
      ),
    ).toBeUndefined();
  });

  test('an adopted observation keeps the run but gains no proof', () => {
    expect(
      proofOf((board) => {
        board.registerLaunch({ ...base } as never);
        board.registerLaunch({
          ...base,
          adopted: true,
          preserveRun: true,
        } as never);
      }),
    ).toBeUndefined();
  });
});
