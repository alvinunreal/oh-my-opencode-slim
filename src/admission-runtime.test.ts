import { describe, expect, test } from 'bun:test';
import {
  acquireAdmissionRuntime,
  resetAdmissionRuntimeForTests,
} from './admission-runtime';

const config = {
  defaultConcurrency: 1,
  providerConcurrency: {},
  modelConcurrency: {},
};

describe('admission runtime leases', () => {
  test('keeps state while another owner is alive', async () => {
    resetAdmissionRuntimeForTests();
    const firstOwner = acquireAdmissionRuntime('project', config);
    const secondOwner = acquireAdmissionRuntime('project', config);
    const first = firstOwner.backgroundTaskConcurrency.acquire({
      model: 'openai/fast',
    });
    await first.ready;
    first.bind('first-task');
    const queued = firstOwner.backgroundTaskConcurrency.acquire({
      model: 'openai/fast',
    });

    firstOwner.release();
    await Promise.resolve();
    expect(secondOwner.backgroundTaskConcurrency.snapshot()).toEqual({
      active: 1,
      queued: 1,
    });

    secondOwner.backgroundTaskConcurrency.releaseTask('first-task');
    await queued.ready;
    expect(secondOwner.backgroundTaskConcurrency.snapshot()).toEqual({
      active: 1,
      queued: 0,
    });

    secondOwner.release();
    resetAdmissionRuntimeForTests();
  });

  test('reacquires before the next macrotask without cancelling calls', async () => {
    resetAdmissionRuntimeForTests();
    const firstOwner = acquireAdmissionRuntime('project', config);
    const first = firstOwner.backgroundTaskConcurrency.acquire({
      model: 'openai/fast',
    });
    await first.ready;
    first.bind('first-task');
    const queued = firstOwner.backgroundTaskConcurrency.acquire({
      model: 'openai/fast',
    });

    firstOwner.release();
    const replacement = acquireAdmissionRuntime('project', config);
    expect(replacement.backgroundTaskConcurrency).toBe(
      firstOwner.backgroundTaskConcurrency,
    );
    replacement.backgroundTaskConcurrency.releaseTask('first-task');
    await queued.ready;

    replacement.release();
    resetAdmissionRuntimeForTests();
  });

  test('final teardown cancels pending calls and is idempotent', async () => {
    resetAdmissionRuntimeForTests();
    const owner = acquireAdmissionRuntime('project', config);
    const first = owner.backgroundTaskConcurrency.acquire({
      model: 'openai/fast',
    });
    await first.ready;
    first.bind('first-task');
    const queued = owner.backgroundTaskConcurrency.acquire({
      model: 'openai/fast',
    });
    owner.pendingCallTracker.add({
      callId: 'queued-call',
      parentSessionId: 'parent',
      agentType: 'explorer',
      label: 'queued call',
      background: true,
      lifecycleEpoch: 0,
      concurrencyTicket: queued,
    });

    // Attach the outcome capture BEFORE teardown: the teardown timer
    // rejects `queued.ready` inside its own macrotask, and a handler
    // attached only after the following `await` leaves an
    // unhandled-rejection window that CI runtimes can report as a test
    // failure (seen on the #1194 CI run; the window exists regardless
    // of runner speed).
    const queuedOutcome = queued.ready.then(
      () => 'resolved',
      (error: unknown) => String((error as Error)?.message),
    );

    owner.release();
    owner.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await queuedOutcome).toBe(
      'Background task concurrency queue was cancelled',
    );
    expect(owner.backgroundTaskConcurrency.snapshot()).toEqual({
      active: 0,
      queued: 0,
    });
    resetAdmissionRuntimeForTests();
  });
});
