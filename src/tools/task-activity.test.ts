import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../background-jobs';
import {
  applyActivityEvent,
  resolveEventSessionID,
  TaskActivityTracker,
} from './task-activity';
import { summarizeTaskStatus } from './task-policy';

describe('resolveEventSessionID', () => {
  test('keys message.updated by info.sessionID, not the message id', () => {
    expect(
      resolveEventSessionID({
        type: 'message.updated',
        properties: { info: { id: 'msg_123', sessionID: 'ses_child1' } },
      }),
    ).toBe('ses_child1');
  });

  test('keys step-finish by info.sessionID, not the step/message id', () => {
    expect(
      resolveEventSessionID({
        type: 'step-finish',
        properties: { info: { id: 'step_9', sessionID: 'ses_child1' } },
      }),
    ).toBe('ses_child1');
  });

  test('keys session-scoped events by info.id (the session id)', () => {
    expect(
      resolveEventSessionID({
        type: 'session.status',
        properties: { info: { id: 'ses_child1' }, status: { type: 'busy' } },
      }),
    ).toBe('ses_child1');
    expect(
      resolveEventSessionID({
        type: 'session.deleted',
        properties: { info: { id: 'ses_child1' } },
      }),
    ).toBe('ses_child1');
  });

  test('falls back to properties.sessionID', () => {
    expect(
      resolveEventSessionID({
        type: 'session.status',
        properties: { sessionID: 'ses_child1', status: { type: 'retry' } },
      }),
    ).toBe('ses_child1');
  });

  test('returns undefined without any session id', () => {
    expect(
      resolveEventSessionID({
        type: 'message.updated',
        properties: { info: { id: 'msg_1' } },
      }),
    ).toBeUndefined();
  });
});

describe('TaskActivityTracker event integration', () => {
  test('completed message.updated refreshes the child session key, never the message id', () => {
    const tracker = new TaskActivityTracker();
    applyActivityEvent(
      tracker,
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            sessionID: 'ses_child1',
            role: 'assistant',
            time: { completed: 1_000 },
          },
        },
      },
      1_000,
    );
    expect(tracker.lastActivityAt('ses_child1')).toBe(1_000);
    expect(tracker.lastActivityAt('msg_1')).toBeUndefined();
  });

  test('streaming message.updated trickles do not refresh activity', () => {
    const tracker = new TaskActivityTracker();
    applyActivityEvent(
      tracker,
      {
        type: 'session.status',
        properties: { info: { id: 'ses_child1' }, status: { type: 'busy' } },
      },
      1_000,
    );
    // Streaming text with no completed marker: not progress.
    applyActivityEvent(
      tracker,
      {
        type: 'message.updated',
        properties: { info: { id: 'msg_2', sessionID: 'ses_child1' } },
      },
      2_000,
    );
    expect(tracker.lastActivityAt('ses_child1')).toBe(1_000);
  });

  test('step-finish-progress: completed message.updated and step-finish refresh activity', () => {
    const tracker = new TaskActivityTracker();
    applyActivityEvent(
      tracker,
      {
        type: 'session.status',
        properties: { info: { id: 'ses_child1' }, status: { type: 'busy' } },
      },
      1_000,
    );
    expect(tracker.lastActivityAt('ses_child1')).toBe(1_000);

    applyActivityEvent(
      tracker,
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_2',
            sessionID: 'ses_child1',
            role: 'assistant',
            time: { completed: 2_000 },
          },
        },
      },
      2_000,
    );
    expect(tracker.lastActivityAt('ses_child1')).toBe(2_000);

    applyActivityEvent(
      tracker,
      {
        type: 'step-finish',
        properties: { info: { id: 'step_3', sessionID: 'ses_child1' } },
      },
      3_000,
    );
    expect(tracker.lastActivityAt('ses_child1')).toBe(3_000);

    applyActivityEvent(
      tracker,
      {
        type: 'session.status',
        properties: { info: { id: 'ses_child1' }, status: { type: 'retry' } },
      },
      4_000,
    );
    expect(tracker.lastActivityAt('ses_child1')).toBe(4_000);
  });

  test('idle status does not refresh activity; session.deleted forgets it', () => {
    const tracker = new TaskActivityTracker();
    applyActivityEvent(
      tracker,
      {
        type: 'session.status',
        properties: { info: { id: 'ses_child1' }, status: { type: 'busy' } },
      },
      1_000,
    );
    applyActivityEvent(
      tracker,
      {
        type: 'session.status',
        properties: { info: { id: 'ses_child1' }, status: { type: 'idle' } },
      },
      2_000,
    );
    // Idle is not activity: the stuck timer keeps the last busy timestamp.
    expect(tracker.lastActivityAt('ses_child1')).toBe(1_000);

    applyActivityEvent(
      tracker,
      { type: 'session.deleted', properties: { info: { id: 'ses_child1' } } },
      3_000,
    );
    expect(tracker.lastActivityAt('ses_child1')).toBeUndefined();
  });
});

describe('trickle-no-progress advisory consequence', () => {
  test('sustained single-request streaming >120s with no completion reads possibly_stuck (advisory only, no auto-abort)', () => {
    // Accepted consequence of the trickle-no-progress rule: a child that
    // streams one request for minutes without a completed marker or a
    // step-finish keeps its last progress timestamp, so a live-confirmed
    // busy read past the 120s threshold reports possibly_stuck. The flag
    // is advisory — this test pins that no terminal state is produced and
    // a later completion resets the clock.
    const tracker = new TaskActivityTracker();
    const board = new BackgroundJobBoard();
    const job = board.registerLaunch({
      taskID: 'ses_stream',
      parentSessionID: 'parent-1',
      agent: 'oracle',
      description: 'long streaming run',
      background: true,
      now: 0,
    });
    applyActivityEvent(
      tracker,
      {
        type: 'session.status',
        properties: { info: { id: 'ses_stream' }, status: { type: 'busy' } },
      },
      0,
    );
    // 119s of pure trickle: no completed marker, no step-finish.
    for (let t = 1_000; t <= 119_000; t += 10_000) {
      applyActivityEvent(
        tracker,
        {
          type: 'message.updated',
          properties: { info: { id: `msg_${t}`, sessionID: 'ses_stream' } },
        },
        t,
      );
    }
    expect(tracker.lastActivityAt('ses_stream')).toBe(0);
    const before = summarizeTaskStatus(
      job,
      { ok: true, status: 'busy' },
      tracker.lastActivityAt('ses_stream'),
      119_000,
    );
    expect(before.possiblyStuck).toBe(false);

    // Past 120s with still no completion: advisory flag fires, board state
    // stays running, no terminal is published, no deadline is claimed.
    applyActivityEvent(
      tracker,
      {
        type: 'message.updated',
        properties: { info: { id: 'msg_121', sessionID: 'ses_stream' } },
      },
      121_000,
    );
    expect(tracker.lastActivityAt('ses_stream')).toBe(0);
    const stuck = summarizeTaskStatus(
      board.get('ses_stream') ?? job,
      { ok: true, status: 'busy' },
      tracker.lastActivityAt('ses_stream'),
      121_000,
    );
    expect(stuck.possiblyStuck).toBe(true);
    expect(board.get('ses_stream')?.state).toBe('running');
    expect(board.get('ses_stream')?.deadlineExceededAt).toBeUndefined();

    // A completed request resets the clock: flag clears.
    applyActivityEvent(
      tracker,
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_done',
            sessionID: 'ses_stream',
            role: 'assistant',
            time: { completed: 122_000 },
          },
        },
      },
      122_000,
    );
    const recovered = summarizeTaskStatus(
      board.get('ses_stream') ?? job,
      { ok: true, status: 'busy' },
      tracker.lastActivityAt('ses_stream'),
      122_000,
    );
    expect(recovered.possiblyStuck).toBe(false);
  });
});
