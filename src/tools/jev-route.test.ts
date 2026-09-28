import { describe, expect, test } from 'bun:test';
import { JevRouter } from '../routing/jev';
import { createJevRouteTool } from './jev-route';

const jevConfig = {
  enabled: true,
  baseUrl: 'https://api.commandcode.ai/provider/v1',
  model: 'typesafe/jev',
  apiKey: 'test-key',
  apiKeyEnv: 'TYPESAFE_API_KEY',
  timeoutMs: 1000,
  acceptConfidence: 0.75,
  escalateConfidence: 0.5,
  maxStateChars: 4000,
} as const;

function makeRouter(fetchImpl: typeof fetch) {
  return new JevRouter({
    config: jevConfig,
    agents: () => ({
      fixer: { model: 'cmd/mid' },
      explorer: { model: 'cmd/fast' },
      oracle: { model: 'cmd/max' },
      orchestrator: { model: 'cmd/max' },
    }),
    disabledAgents: () => new Set<string>(),
    fetchImpl,
  });
}

describe('jev_route tool', () => {
  test('formats an ok recommendation', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            specialist: {
              type: 'choice',
              choice: 'fixer',
              confidence: 0.9,
              probabilities: { fixer: 0.9, direct: 0.1 },
            },
            complexity: {
              type: 'score',
              score: 1,
              legend: {},
              probabilities: {},
              confidence: 0.8,
            },
            risk: {
              type: 'score',
              score: 1,
              legend: {},
              probabilities: {},
              confidence: 0.8,
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const { jev_route } = createJevRouteTool({
      router: makeRouter(fetchImpl),
      requireOrchestrator: () => true,
    });

    const out = await jev_route.execute(
      { task_summary: 'Implement the login form validation' },
      { sessionID: 'ses_1', agent: 'orchestrator' } as never,
    );
    expect(out).toContain('status: ok');
    expect(out).toContain('specialist: @fixer');
    expect(out).toContain('model: cmd/mid');
    expect(out).toContain('confidence: 0.90');
  });

  test('fail-open on HTTP error', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 500 })) as typeof fetch;
    const { jev_route } = createJevRouteTool({
      router: makeRouter(fetchImpl),
    });
    const out = await jev_route.execute(
      { task_summary: 'x' },
      { sessionID: 'ses_1', agent: 'orchestrator' } as never,
    );
    expect(out).toContain('status: error');
    expect(out).toContain('prompt-based role routing');
  });

  test('missing api key fail-open', async () => {
    const { jev_route } = createJevRouteTool({
      router: new JevRouter({
        config: {
          ...jevConfig,
          apiKey: undefined as unknown as string,
          apiKeyEnv: 'NO_SUCH_JEV_KEY',
        },
        agents: () => ({}),
        env: {},
      }),
    });
    const out = await jev_route.execute(
      { task_summary: 'x' },
      { sessionID: 's', agent: 'orchestrator' } as never,
    );
    expect(out).toContain('status: error');
    expect(out).toContain('API key missing');
  });
});
