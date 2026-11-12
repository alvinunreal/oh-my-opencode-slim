import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  clearAllWakeSessions,
  commitWakeReservation,
  getSuppressedDuplicateWakes,
  getWakeProgress,
  MAX_TRACKED_SESSIONS,
  releaseWakeEvaluation,
  reserveWakeBodyOccurrence,
  resetOrchestratorWakeGateForTests,
  retryAfterWakeEvaluation,
  tryBeginWakeEvaluation,
} from './wake-gate';

const LIVE = 'ses_live';
const EVICTABLE = 'ses_evictable';
const QUIET = 'ses_quiet';

/** Touch `count` distinct sessions the way normal session traffic does. */
function touchSessions(count: number, prefix = 'ses_fill'): void {
  for (let index = 0; index < count; index += 1) {
    getWakeProgress(`${prefix}${index}`);
  }
}

/** Acquire the in-flight slot for `sessionID`, failing the test when refused. */
function claimInFlight(sessionID: string): symbol {
  const owner = tryBeginWakeEvaluation(sessionID);
  if (!owner) throw new Error(`expected the in-flight slot for ${sessionID}`);
  return owner;
}

beforeEach(() => {
  resetOrchestratorWakeGateForTests();
});

afterAll(() => {
  clearAllWakeSessions();
});

describe('in-flight evaluation slot', () => {
  test('a second evaluation is refused while one is in flight', () => {
    expect(tryBeginWakeEvaluation(LIVE)).not.toBeNull();
    expect(tryBeginWakeEvaluation(LIVE)).toBeNull();
  });

  test('only the owner can release the slot', () => {
    const owner = claimInFlight(LIVE);
    releaseWakeEvaluation(LIVE, Symbol('intruder'));
    expect(tryBeginWakeEvaluation(LIVE)).toBeNull();
    releaseWakeEvaluation(LIVE, owner);
    expect(tryBeginWakeEvaluation(LIVE)).not.toBeNull();
  });

  test('LRU eviction does not release a live slot (#1861)', () => {
    claimInFlight(LIVE);
    touchSessions(MAX_TRACKED_SESSIONS);
    expect(tryBeginWakeEvaluation(LIVE)).toBeNull();
  });

  test('LRU eviction preserves the no-progress cap of a live evaluation (#1861)', () => {
    const owner = claimInFlight(LIVE);
    commitWakeReservation(LIVE, owner, 'fingerprint');
    commitWakeReservation(LIVE, owner, 'fingerprint');

    touchSessions(MAX_TRACKED_SESSIONS);

    const progress = getWakeProgress(LIVE);
    expect(progress.unchangedWakeCount).toBe(2);
    expect(progress.stopped).toBe(true);
    expect(progress.expectingWakeBusy).toBe(true);
  });

  test('LRU eviction does not drop a retry queued behind a live evaluation (#1861)', () => {
    const owner = claimInFlight(LIVE);
    let retried = false;
    retryAfterWakeEvaluation(LIVE, () => {
      retried = true;
    });

    touchSessions(MAX_TRACKED_SESSIONS);
    releaseWakeEvaluation(LIVE, owner);

    expect(retried).toBe(true);
  });

  test('LRU eviction preserves delta-less dedupe for a live evaluation (#1861)', () => {
    claimInFlight(LIVE);
    reserveWakeBodyOccurrence(LIVE, 'wake body');

    touchSessions(MAX_TRACKED_SESSIONS);

    expect(reserveWakeBodyOccurrence(LIVE, 'wake body').repeat).toBe(true);
    expect(getSuppressedDuplicateWakes(LIVE)).toBe(1);
  });

  test('LRU eviction still trims sessions no evaluation owns', () => {
    const owner = claimInFlight(EVICTABLE);
    commitWakeReservation(EVICTABLE, owner, 'fingerprint');
    releaseWakeEvaluation(EVICTABLE, owner);
    expect(getWakeProgress(EVICTABLE).lastFingerprint).toBe('fingerprint');

    touchSessions(MAX_TRACKED_SESSIONS);

    expect(getWakeProgress(EVICTABLE).lastFingerprint).toBeUndefined();
  });

  test('LRU eviction never evicts the session being touched (#1861)', () => {
    for (let index = 0; index < MAX_TRACKED_SESSIONS; index += 1) {
      claimInFlight(`ses_live${index}`);
    }

    const first = getWakeProgress(QUIET);
    first.stopped = true;

    const second = getWakeProgress(QUIET);

    // A live row must not be sacrificed to make room for the touched row.
    expect(tryBeginWakeEvaluation('ses_live0')).toBeNull();
    expect(second).toBe(first);
    expect(second.stopped).toBe(true);
  });

  test('eviction resumes after a live owner releases (#1861)', () => {
    const owners = Array.from({ length: MAX_TRACKED_SESSIONS }, (_, index) =>
      claimInFlight(`ses_live${index}`),
    );
    commitWakeReservation('ses_live0', owners[0], 'fingerprint-0');
    commitWakeReservation('ses_live1', owners[1], 'fingerprint-1');
    // Every other row is live, so this touch overshoots the cap.
    getWakeProgress(QUIET);

    releaseWakeEvaluation('ses_live0', owners[0]);
    // The next touch trims again instead of stalling.
    getWakeProgress('ses_new');

    expect(getWakeProgress('ses_live0').lastFingerprint).toBeUndefined();
    expect(getWakeProgress('ses_live1').lastFingerprint).toBe('fingerprint-1');
  });

  test('eviction takes the oldest evictable row, not the newest (#1861)', () => {
    claimInFlight('ses_pinned');
    const oldest = getWakeProgress('ses_oldest');
    const newer = getWakeProgress('ses_newer');
    for (let index = 0; index < MAX_TRACKED_SESSIONS - 3; index += 1) {
      claimInFlight(`ses_fill${index}`);
    }
    // At the cap: pinned (live), then oldest and newer (both evictable).
    getWakeProgress('ses_trigger');

    // Read the newer row first: reading the evicted row recreates it, and that
    // touch trims the cap again by evicting the only other evictable row.
    expect(getWakeProgress('ses_newer')).toBe(newer);
    expect(getWakeProgress('ses_oldest')).not.toBe(oldest);
  });
});
