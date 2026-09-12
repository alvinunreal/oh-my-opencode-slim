import { describe, expect, mock, test } from 'bun:test';
import { createV1InterviewSessionRuntime } from './runtime';

describe('v1 interview session runtime', () => {
  test('keeps SDK calls nested under client.session', async () => {
    const session = {
      get: mock(async () => ({ data: { id: 'ses_1' } })),
      messages: mock(async () => ({ data: [{ info: { role: 'user' } }] })),
      prompt: mock(async () => ({})),
      promptAsync: mock(async () => ({})),
      update: mock(async () => ({})),
    };
    const client = { session };
    const runtime = createV1InterviewSessionRuntime({
      client,
    } as never);

    await expect(runtime.messages('ses_1')).resolves.toEqual([
      { info: { role: 'user' } },
    ]);
    await runtime.notify('ses_1', 'ready');
    await runtime.continue('ses_1', 'next', {
      providerID: 'openai',
      modelID: 'gpt-5',
    });
    await runtime.rename('ses_1', 'Interview: app');

    expect(session.messages).toHaveBeenCalledWith({ path: { id: 'ses_1' } });
    // A parentless session with no recorded agent falls back to the
    // orchestrator; the field is never omitted (probe A2: an agent-less body
    // permanently re-homes the session to `build`).
    expect(session.prompt).toHaveBeenCalledWith({
      path: { id: 'ses_1' },
      body: {
        noReply: true,
        parts: [{ type: 'text', text: 'ready' }],
        agent: 'orchestrator',
      },
    });
    expect(session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: 'ses_1' },
        body: expect.objectContaining({
          agent: 'orchestrator',
          model: { providerID: 'openai', modelID: 'gpt-5' },
        }),
      }),
    );
    expect(session.update).toHaveBeenCalledWith({
      path: { id: 'ses_1' },
      body: { title: 'Interview: app' },
    });
  });

  test('notify preserves the agent the session is already running under', async () => {
    const session = {
      get: mock(async () => ({ data: { id: 'ses_1', agent: 'plan' } })),
      messages: mock(async () => ({ data: [] })),
      prompt: mock(async () => ({})),
    };
    const runtime = createV1InterviewSessionRuntime({
      client: { session },
    } as never);

    await runtime.notify('ses_1', 'ready');

    expect(session.prompt).toHaveBeenCalledWith({
      path: { id: 'ses_1' },
      body: {
        noReply: true,
        parts: [{ type: 'text', text: 'ready' }],
        agent: 'plan',
      },
    });
  });

  test('notify derives the agent from the newest user message, not a compaction turn', async () => {
    const session = {
      get: mock(async () => ({ data: { id: 'ses_1' } })),
      messages: mock(async () => ({
        data: [
          { info: { role: 'user', agent: 'orchestrator' } },
          { info: { role: 'assistant', agent: 'compaction' } },
        ],
      })),
      prompt: mock(async () => ({})),
    };
    const runtime = createV1InterviewSessionRuntime({
      client: { session },
    } as never);

    await runtime.notify('ses_1', 'ready');

    // The compaction assistant turn must not become the resolved agent.
    expect(session.prompt).toHaveBeenCalledWith({
      path: { id: 'ses_1' },
      body: {
        noReply: true,
        parts: [{ type: 'text', text: 'ready' }],
        agent: 'orchestrator',
      },
    });
  });

  test('notify never guesses an agent for a child session', async () => {
    const session = {
      get: mock(async () => ({ data: { id: 'ses_2', parentID: 'ses_1' } })),
      messages: mock(async () => ({ data: [] })),
      prompt: mock(async () => ({})),
    };
    const runtime = createV1InterviewSessionRuntime({
      client: { session },
    } as never);

    await runtime.notify('ses_2', 'ready');

    expect(session.prompt).toHaveBeenCalledWith({
      path: { id: 'ses_2' },
      body: { noReply: true, parts: [{ type: 'text', text: 'ready' }] },
    });
  });
});
