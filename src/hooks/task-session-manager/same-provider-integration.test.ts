import { describe, expect, mock, test } from 'bun:test';
import { DEFAULT_MAX_RETAINED_SNAPSHOTS } from '../../config/constants';
import { BackgroundJobBoard, BackgroundTaskConcurrency } from '../../utils';
import { createTaskSessionManagerHook } from './index';

// Route getClient back to _ctx.client so the _ctx.client.session mock works
// through the v2 lookup path (mirrors index.test.ts).
mock.module('../../utils/opencode-client', () => ({
  getClient: (input: { client: unknown }) => input.client as never,
}));

const LM_NEXUS_MODEL = 'lm-nexus/Qwen3.8-27B';
const SATELLITE_MODEL = 'opencode/muse';
const OPENAI_MODEL = 'openai/gpt-5.2';
const POLICY: Record<string, 'foreground'> = { 'lm-nexus': 'foreground' };

type IntegrationHookOptions = {
  backgroundJobBoard?: BackgroundJobBoard;
  backgroundTaskConcurrency?: BackgroundTaskConcurrency;
  getModelForAgent?: (
    agentType: string,
    parentSessionID?: string,
  ) => string | undefined;
  getSessionModel?: (sessionID: string) => string | undefined;
  sameProviderPolicy?: Record<string, 'foreground'>;
};

type TaskSessionManagerHook = ReturnType<typeof createTaskSessionManagerHook>;

function createHook(options?: IntegrationHookOptions) {
  return createTaskSessionManagerHook(
    {
      client: {
        session: {
          status: mock(async () => ({ data: {} })),
        },
      },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      maxSessionsPerAgent: 2,
      maxRetainedSnapshots: DEFAULT_MAX_RETAINED_SNAPSHOTS,
      backgroundJobBoard: options?.backgroundJobBoard,
      backgroundTaskConcurrency: options?.backgroundTaskConcurrency,
      getModelForAgent: options?.getModelForAgent,
      getSessionModel: options?.getSessionModel,
      sameProviderPolicy: options?.sameProviderPolicy,
      shouldManageSession: () => true,
    },
  );
}

function taskArgs(): Record<string, unknown> {
  return {
    subagent_type: 'oracle',
    description: 'same-provider task',
    prompt: 'do work',
    background: true,
  };
}

async function callBefore(
  hook: TaskSessionManagerHook,
  callID: string,
  args: Record<string, unknown>,
): Promise<void> {
  await hook['tool.execute.before'](
    { tool: 'task', sessionID: 'ses_parent', callID },
    { args },
  );
}

/** Resolves 'settled' if the promise settles within the margin, else 'timeout'. */
async function settleWithin(
  promise: Promise<void>,
  marginMs = 50,
): Promise<'settled' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), marginMs);
  });
  try {
    return await Promise.race([
      promise.then(() => 'settled' as const),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('same-provider background-to-foreground conversion (hook level)', () => {
  test('converts a same-provider background task to foreground', async () => {
    const hook = createHook({
      sameProviderPolicy: POLICY,
      getSessionModel: () => LM_NEXUS_MODEL,
      getModelForAgent: () => LM_NEXUS_MODEL,
    });

    const args = taskArgs();
    await callBefore(hook, 'c1', args);
    expect(args.background).toBe(false);
  });

  test('leaves background true when the child resolves to a different (satellite) provider', async () => {
    const hook = createHook({
      sameProviderPolicy: POLICY,
      getSessionModel: () => LM_NEXUS_MODEL,
      getModelForAgent: () => SATELLITE_MODEL,
    });

    const args = taskArgs();
    await callBefore(hook, 'c1', args);
    expect(args.background).toBe(true);
  });

  test('leaves background true when sameProviderPolicy is omitted', async () => {
    const hook = createHook({
      getSessionModel: () => LM_NEXUS_MODEL,
      getModelForAgent: () => LM_NEXUS_MODEL,
    });

    const args = taskArgs();
    await callBefore(hook, 'c1', args);
    expect(args.background).toBe(true);
  });

  test('converted task skips concurrency admission while an unconverted background task waits on the saturated slot', async () => {
    const concurrency = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    // Saturate the single default slot with an in-flight task.
    const inFlight = concurrency.acquire({ model: LM_NEXUS_MODEL });
    await inFlight.ready;
    inFlight.bind('task_in_flight');
    expect(concurrency.snapshot()).toEqual({ active: 1, queued: 0 });

    const hook = createHook({
      sameProviderPolicy: POLICY,
      getSessionModel: () => LM_NEXUS_MODEL,
      getModelForAgent: () => LM_NEXUS_MODEL,
      backgroundTaskConcurrency: concurrency,
    });

    // Converted task: no ticket is taken and the saturated slot is never
    // awaited, so the before hook settles promptly.
    const convertedArgs = taskArgs();
    const convertedOutcome = await settleWithin(
      callBefore(hook, 'c1', convertedArgs),
    );
    expect(convertedOutcome).toBe('settled');
    expect(convertedArgs.background).toBe(false);
    expect(concurrency.snapshot()).toEqual({ active: 1, queued: 0 });

    // Different-provider background task: not converted, admission queues
    // behind the saturated slot and the before hook blocks on the ticket.
    const blockingHook = createHook({
      sameProviderPolicy: POLICY,
      getSessionModel: () => LM_NEXUS_MODEL,
      getModelForAgent: () => SATELLITE_MODEL,
      backgroundTaskConcurrency: concurrency,
    });
    const blockingArgs = taskArgs();
    const blockingCall = callBefore(blockingHook, 'c2', blockingArgs);
    blockingCall.catch(() => {
      // Disposal below rejects the queued ticket's ready promise.
    });
    const blockingOutcome = await settleWithin(blockingCall);
    expect(blockingOutcome).toBe('timeout');
    expect(blockingArgs.background).toBe(true);
    expect(concurrency.snapshot()).toEqual({ active: 1, queued: 1 });
    concurrency.dispose();
  });

  test('converted task follows the existing foreground bookkeeping path to a terminal board record', async () => {
    const board = new BackgroundJobBoard({
      maxReusablePerAgent: 2,
      readContextMinLines: 10,
      readContextMaxFiles: 8,
    });
    const hook = createHook({
      sameProviderPolicy: POLICY,
      getSessionModel: () => LM_NEXUS_MODEL,
      getModelForAgent: () => LM_NEXUS_MODEL,
      backgroundJobBoard: board,
    });

    const args = taskArgs();
    await callBefore(hook, 'c1', args);
    expect(args.background).toBe(false);

    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'ses_parent', callID: 'c1' },
      {
        output: [
          'task_id: task_fg_1',
          'state: completed',
          '',
          '<task_result>',
          'work done',
          '</task_result>',
        ].join('\n'),
      },
    );

    const record = board.get('task_fg_1');
    expect(record).toBeDefined();
    expect(record?.state).toBe('completed');
    expect(record?.background).toBe(false);
    expect(record?.parentSessionID).toBe('ses_parent');
    expect(record?.agent).toBe('oracle');
  });

  test('decision follows the current parent model after a runtime /model switch', async () => {
    let parentModel = LM_NEXUS_MODEL;
    const hook = createHook({
      sameProviderPolicy: POLICY,
      getSessionModel: () => parentModel,
      getModelForAgent: () => LM_NEXUS_MODEL,
    });

    const before = taskArgs();
    await callBefore(hook, 'c1', before);
    expect(before.background).toBe(false);

    // Simulate a runtime /model switch: the parent session's current model
    // now belongs to a different provider, so the same child no longer
    // converts.
    parentModel = OPENAI_MODEL;
    const after = taskArgs();
    await callBefore(hook, 'c2', after);
    expect(after.background).toBe(true);
  });

  test('decision follows the resolved child model after a simulated preset reload', async () => {
    let childModel = LM_NEXUS_MODEL;
    const hook = createHook({
      sameProviderPolicy: POLICY,
      getSessionModel: () => LM_NEXUS_MODEL,
      getModelForAgent: () => childModel,
    });

    const before = taskArgs();
    await callBefore(hook, 'c1', before);
    expect(before.background).toBe(false);

    // Simulate a preset reload: the agent's resolved model now points at a
    // satellite provider, so the decision follows the new value. (This
    // documents resolver freshness, not the preset machinery itself.)
    childModel = SATELLITE_MODEL;
    const after = taskArgs();
    await callBefore(hook, 'c2', after);
    expect(after.background).toBe(true);
  });
});
