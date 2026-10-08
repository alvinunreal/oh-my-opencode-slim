import { describe, expect, mock, test } from 'bun:test';
import {
  BackgroundJobBoard,
  createBackgroundJobLifecycle,
} from '../../background-jobs';
import { createBackgroundFallbackHandoff } from './fallback-observation-transfer';
import type { RevivedRunTracker } from './revived-run-tracker';

function fakeTracker() {
  const prepared: Array<{
    taskID: string;
    generation: number;
    baselineMessageID?: string;
  }> = [];
  const admitted: Array<{ taskID: string; generation: number }> = [];
  const rejected: Array<{ taskID: string; generation: number }> = [];
  const unresolved: Array<{ taskID: string; generation: number }> = [];
  const tracker = {
    prepareObservation: mock(
      (input: {
        taskID: string;
        generation: number;
        baselineMessageID?: string;
      }) => {
        prepared.push(input);
        return true;
      },
    ),
    admitObservation: mock((taskID: string, generation: number) => {
      admitted.push({ taskID, generation });
      return true;
    }),
    rejectObservation: mock((taskID: string, generation: number) => {
      rejected.push({ taskID, generation });
    }),
    settleObservationUnresolved: mock((taskID: string, generation: number) => {
      unresolved.push({ taskID, generation });
      return true;
    }),
  } as unknown as RevivedRunTracker;
  return { tracker, prepared, admitted, rejected, unresolved };
}

function launchBackground(board: BackgroundJobBoard, taskID = 'ses_child') {
  return board.registerLaunch({
    taskID,
    parentSessionID: 'parent',
    agent: 'explorer',
    description: 'inspect',
    background: true,
  });
}

describe('createBackgroundFallbackHandoff', () => {
  test('prepare arms the deferral; admit and reject delegate to the tracker', () => {
    const board = new BackgroundJobBoard();
    const run = launchBackground(board);
    const { tracker, prepared, admitted, rejected } = fakeTracker();
    const handoff = createBackgroundFallbackHandoff({
      backgroundJobs: createBackgroundJobLifecycle({
        backgroundJobBoard: board,
      }),
      revivedRunTracker: tracker,
    });

    expect(handoff.prepare('ses_child', run.generation, 'm2')).toBe(true);
    expect(prepared).toEqual([
      {
        taskID: 'ses_child',
        generation: run.generation,
        baselineMessageID: 'm2',
        parentSessionID: 'parent',
        description: 'inspect',
      },
    ]);

    handoff.admit('ses_child', run.generation);
    handoff.reject('ses_child', run.generation);
    expect(admitted).toEqual([
      { taskID: 'ses_child', generation: run.generation },
    ]);
    // The immediate probe on admission is the TRACKER's contract (see
    // revived-run-tracker.test.ts); the handoff only delegates.
    expect(rejected).toEqual([
      { taskID: 'ses_child', generation: run.generation },
    ]);
  });

  test('eligibility: only a running background record with the exact generation', () => {
    const board = new BackgroundJobBoard();
    const run = launchBackground(board);
    board.registerLaunch({
      taskID: 'ses_fg',
      parentSessionID: 'parent',
      agent: 'explorer',
      background: false,
    });
    const { tracker, prepared } = fakeTracker();
    const handoff = createBackgroundFallbackHandoff({
      backgroundJobs: createBackgroundJobLifecycle({
        backgroundJobBoard: board,
      }),
      revivedRunTracker: tracker,
    });

    // Background + running + exact generation.
    expect(handoff.prepare('ses_child', run.generation, 'm2')).toBe(true);
    // Foreground record.
    expect(
      handoff.prepare('ses_fg', board.get('ses_fg')?.generation, 'm2'),
    ).toBe(false);
    // Unknown session.
    expect(handoff.prepare('ses_missing', 1, 'm2')).toBe(false);
    // undefined generation is NEVER a wildcard.
    expect(handoff.prepare('ses_fg', undefined, 'm2')).toBe(false);
    // Stale generation for a live record.
    expect(handoff.prepare('ses_child', run.generation + 1, 'm2')).toBe(false);
    expect(prepared).toHaveLength(1);
  });

  test('settleUnresolved delegates to the tracker', () => {
    const board = new BackgroundJobBoard();
    const run = launchBackground(board);
    const { tracker, unresolved } = fakeTracker();
    const handoff = createBackgroundFallbackHandoff({
      backgroundJobs: createBackgroundJobLifecycle({
        backgroundJobBoard: board,
      }),
      revivedRunTracker: tracker,
    });

    handoff.settleUnresolved('ses_child', run.generation);
    expect(unresolved).toEqual([
      { taskID: 'ses_child', generation: run.generation },
    ]);
  });
});
