import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { MultiplexerSessionManager } from './multiplexer';

let taskSessionEventCalls = 0;
let cleanupStarted = false;
let nudgeWouldBePermitted = false;
let notifyCleanupStarted = (): void => {};
let cleanupStartedPromise = Promise.resolve();
let releaseCleanup = (): void => {
  throw new Error('disposal cleanup did not start');
};

function resetCleanupSignals(): void {
  cleanupStarted = false;
  nudgeWouldBePermitted = false;
  cleanupStartedPromise = new Promise<void>((resolve) => {
    notifyCleanupStarted = resolve;
  });
  releaseCleanup = () => {
    throw new Error('disposal cleanup did not start');
  };
}

const asyncNoop = async (): Promise<void> => {};
const passiveHook = {
  'experimental.chat.messages.transform': asyncNoop,
  'tool.execute.after': asyncNoop,
};

mock.module('./hooks', () => ({
  createApplyPatchHook: () => ({ 'tool.execute.before': asyncNoop }),
  createAutoUpdateCheckerHook: () => ({ event: asyncNoop }),
  createChatHeadersHook: () => ({ 'chat.headers': asyncNoop }),
  createDeepworkCommandHook: () => ({ registerCommand: () => {} }),
  createDelegateTaskRetryHook: () => passiveHook,
  createFilterAvailableSkillsHook: () => passiveHook,
  createJsonErrorRecoveryHook: () => passiveHook,
  createLoopCommandHook: () => ({ registerCommand: () => {} }),
  createPhaseReminderHook: () => passiveHook,
  createPostFileToolNudgeHook: () => passiveHook,
  createReflectCommandHook: () => ({ registerCommand: () => {} }),
  createTaskSessionManagerHook: () => ({
    event: async () => {
      taskSessionEventCalls++;
    },
    observeChatMessage: () => {},
    'experimental.chat.messages.transform': asyncNoop,
    'tool.execute.after': asyncNoop,
    'tool.execute.before': asyncNoop,
  }),
  ForegroundFallbackManager: class {
    disableChain() {}
    handleEvent = asyncNoop;
    isFallbackInProgress() {
      return false;
    }
    registerSessionAgent() {}
  },
  SessionLifecycle: class {
    dispatchSessionDeleted() {}
  },
}));

const { default: plugin } = await import('./index');
mock.restore();

const cleanupOnInstanceDisposed = spyOn(
  MultiplexerSessionManager.prototype,
  'cleanupOnInstanceDisposed',
).mockImplementation(async () => {
  cleanupStarted = true;
  nudgeWouldBePermitted = taskSessionEventCalls === 0;
  notifyCleanupStarted();
  await new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
});

afterAll(() => {
  cleanupOnInstanceDisposed.mockRestore();
});

describe('plugin disposal event ordering', () => {
  test('invalidates task continuations before awaited disposal cleanup', async () => {
    taskSessionEventCalls = 0;
    resetCleanupSignals();

    const hooks = await plugin({
      directory: process.cwd(),
      client: { app: { log: asyncNoop } },
    } as unknown as Parameters<typeof plugin>[0]);

    const eventPromise = hooks.event?.({
      event: { type: 'server.instance.disposed' },
    } as never);

    await cleanupStartedPromise;

    expect(taskSessionEventCalls).toBe(1);
    expect(cleanupStarted).toBeTrue();
    expect(nudgeWouldBePermitted).toBeFalse();

    releaseCleanup();
    await eventPromise;

    expect(taskSessionEventCalls).toBe(1);
  });
});
