import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import * as logger from '../../utils/logger';
import { createBackgroundDefaultFlipState } from '../../v2/delegation';
import { handleToolExecuteBefore } from './tool-execute-hooks';

const PARENT = 'ses_parent';

/** One flip instance per describe block (disarmed between tests), mirroring
 * one per plugin setup in production. */
const flip = createBackgroundDefaultFlipState();

/** Minimal deps for the background-default flip: the guard chain up to the
 * flip needs a managed session, a board, and a pending-call tracker. */
function deps(hostFlavor?: string, managed = true) {
  return {
    shouldManageSession: () => managed,
    backgroundJobBoard: new BackgroundJobBoard(),
    pendingCallTracker: {
      add() {},
      take: () => undefined,
      pendingCallId: () => 'call_flip',
    },
    taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
    isBackgroundDefaultFlipArmed: flip.isArmed,
    hostFlavor,
  };
}

function call(args: Record<string, unknown>, hostFlavor?: string) {
  const output = { args };
  const promise = handleToolExecuteBefore(
    { tool: 'task', sessionID: PARENT, callID: 'call_flip' },
    output,
    deps(hostFlavor),
  );
  return { output, promise };
}

describe('v2 background-default flip', () => {
  // The mechanism half only runs once the wording half verifiably landed
  // (v2 setup arms it after the description rewrite probe). Arm for the
  // flip tests; the un-armed case is pinned below.
  afterEach(() => {
    flip.disarm();
  });

  test('v2 armed: omitted background is rewritten to true', async () => {
    flip.arm();
    const { output, promise } = call(
      { subagent_type: 'fixer', prompt: 'work' },
      'v2',
    );
    await promise;
    expect(output.args.background).toBe(true);
  });

  test('v2 armed: explicit false passes through untouched', async () => {
    flip.arm();
    const { output, promise } = call(
      { subagent_type: 'fixer', prompt: 'work', background: false },
      'v2',
    );
    await promise;
    expect(output.args.background).toBe(false);
  });

  test('v2 armed: explicit true stays true', async () => {
    flip.arm();
    const { output, promise } = call(
      { subagent_type: 'fixer', prompt: 'work', background: true },
      'v2',
    );
    await promise;
    expect(output.args.background).toBe(true);
  });

  test('not armed: the native omitted default operates (wording/mechanism pairing)', async () => {
    const { output, promise } = call(
      { subagent_type: 'fixer', prompt: 'work' },
      'v2',
    );
    await promise;
    expect(output.args.background).toBeUndefined();
  });

  test('non-v2 hosts keep the native omitted default (no rewrite)', async () => {
    flip.arm();
    const { output, promise } = call({
      subagent_type: 'fixer',
      prompt: 'work',
    });
    await promise;
    expect(output.args.background).toBeUndefined();
  });

  test('unmanaged sessions never reach the flip', async () => {
    flip.arm();
    const output = { args: { subagent_type: 'fixer', prompt: 'work' } };
    await handleToolExecuteBefore(
      { tool: 'task', sessionID: PARENT, callID: 'call_flip' },
      output,
      { ...deps('v2'), shouldManageSession: () => false },
    );
    expect(output.args.background).toBeUndefined();
  });

  test('per-instance state: another setup arming or disarming never crosses locations', async () => {
    // The host loads one plugin instance per project in one process; the
    // armed flag must stay scoped to the setup whose description rewrite
    // landed (Greptile: disposing one project must not disarm the other).
    const flipA = createBackgroundDefaultFlipState();
    const flipB = createBackgroundDefaultFlipState();
    const outputA = { args: { subagent_type: 'fixer', prompt: 'work' } };
    const outputB = { args: { subagent_type: 'fixer', prompt: 'work' } };

    flipA.arm();
    await handleToolExecuteBefore(
      { tool: 'task', sessionID: PARENT, callID: 'c_a' },
      outputA,
      { ...deps('v2'), isBackgroundDefaultFlipArmed: flipA.isArmed },
    );
    await handleToolExecuteBefore(
      { tool: 'task', sessionID: PARENT, callID: 'c_b' },
      outputB,
      { ...deps('v2'), isBackgroundDefaultFlipArmed: flipB.isArmed },
    );
    expect(outputA.args.background).toBe(true);
    expect(outputB.args.background).toBeUndefined();

    flipA.disarm();
    const outputA2 = { args: { subagent_type: 'fixer', prompt: 'work' } };
    await handleToolExecuteBefore(
      { tool: 'task', sessionID: PARENT, callID: 'c_a2' },
      outputA2,
      { ...deps('v2'), isBackgroundDefaultFlipArmed: flipA.isArmed },
    );
    expect(outputA2.args.background).toBeUndefined();
  });
});

describe('v2 background explicit-lane observation', () => {
  afterEach(() => {
    flip.disarm();
  });

  test('explicit false and true each log their raw value (dependent-lane health)', async () => {
    flip.arm();
    const logSpy = spyOn(logger, 'log');
    try {
      const falseLane = {
        args: { subagent_type: 'fixer', prompt: 'w', background: false },
      };
      await handleToolExecuteBefore(
        { tool: 'task', sessionID: PARENT, callID: 'c1' },
        falseLane,
        deps('v2'),
      );
      const trueLane = {
        args: { subagent_type: 'fixer', prompt: 'w', background: true },
      };
      await handleToolExecuteBefore(
        { tool: 'task', sessionID: PARENT, callID: 'c2' },
        trueLane,
        deps('v2'),
      );
      const explicitCalls = logSpy.mock.calls.filter((call) =>
        String(call[0]).includes('background explicit'),
      );
      // Full-suite runs share the logger; assert our two lanes are present
      // with their raw values rather than an exact count.
      const values = explicitCalls
        .map((call) => (call[1] as { background?: unknown }).background)
        .filter((value) => value === false || value === true);
      expect(values).toContain(false);
      expect(values).toContain(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
