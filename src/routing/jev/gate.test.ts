import { describe, expect, test } from 'bun:test';
import { isJevRoutingActive, JevRouter, JevRouteStore } from './index';
import type { JevConfig } from '../config/schema';

const base: JevConfig = {
  enabled: true,
  baseUrl: 'https://api.example/v1',
  model: 'typesafe/jev',
  apiKey: 'k',
  apiKeyEnv: 'TYPESAFE_API_KEY',
  timeoutMs: 1000,
  acceptConfidence: 0.75,
  escalateConfidence: 0.5,
  maxStateChars: 4000,
};

describe('isJevRoutingActive', () => {
  test('off when no config', () => {
    expect(isJevRoutingActive(undefined)).toBe(false);
  });

  test('off when enabled=false', () => {
    expect(isJevRoutingActive({ ...base, enabled: false })).toBe(false);
  });

  test('off when model is empty (activation token unset)', () => {
    expect(isJevRoutingActive({ ...base, model: '' })).toBe(false);
    expect(isJevRoutingActive({ ...base, model: '   ' })).toBe(false);
  });

  test('off when no API key resolves', () => {
    expect(
      isJevRoutingActive(
        { ...base, apiKey: undefined, apiKeyEnv: 'NO_SUCH' },
        { env: {} },
      ),
    ).toBe(false);
  });

  test('on when enabled + model + key', () => {
    expect(isJevRoutingActive(base)).toBe(true);
    expect(
      isJevRoutingActive(
        { ...base, apiKey: undefined, apiKeyEnv: 'MY_KEY' },
        { env: { MY_KEY: 'x' } },
      ),
    ).toBe(true);
  });
});

describe('JevRouteStore', () => {
  test('records per-task keys so parallel lanes do not clobber', () => {
    const store = new JevRouteStore();
    store.record('ses_1', 'fix bugs', {
      status: 'ok',
      specialist: 'fixer',
      confidence: 0.9,
      modelTier: 'max',
      model: { id: 'cmd/strong' },
      recommendation: 'x',
    });
    store.record('ses_1', 'read docs', {
      status: 'ok',
      specialist: 'librarian',
      confidence: 0.9,
      modelTier: 'fast',
      model: { id: 'cmd/fast' },
      recommendation: 'x',
    });
    expect(
      store.getForSpecialist('ses_1', 'fixer', {
        requireOk: true,
        taskKey: 'fix bugs',
      })?.model?.id,
    ).toBe('cmd/strong');
    expect(
      store.getForSpecialist('ses_1', 'librarian', {
        requireOk: true,
        taskKey: 'read docs',
      })?.model?.id,
    ).toBe('cmd/fast');
  });

  test('ignores error status', () => {
    const store = new JevRouteStore();
    store.record('ses_1', 'task', {
      status: 'error',
      specialist: 'fixer',
      recommendation: 'x',
    });
    expect(
      store.getForSpecialist('ses_1', 'fixer', {
        requireOk: true,
        taskKey: 'task',
      }),
    ).toBeUndefined();
  });

  test('clear(sessionID) drops only that session', () => {
    const store = new JevRouteStore();
    store.record('ses_1', 'a', {
      status: 'low_confidence',
      specialist: 'fixer',
      recommendation: 'x',
    });
    store.record('ses_2', 'b', {
      status: 'ok',
      specialist: 'fixer',
      recommendation: 'x',
    });
    store.clear('ses_1');
    expect(
      store.getForSpecialist('ses_1', 'fixer', { taskKey: 'a' }),
    ).toBeUndefined();
  });
});

describe('JevRouter.session cache', () => {
  test('failed route clears earlier decisions', async () => {
    const store = new JevRouteStore();
    store.record('ses_fail', 'old task', {
      status: 'ok',
      specialist: 'fixer',
      confidence: 0.9,
      modelTier: 'max',
      model: { id: 'cmd/stale' },
      recommendation: 'x',
    });
    const router = new JevRouter({
      config: { ...base, apiKey: undefined, apiKeyEnv: 'NO_SUCH_KEY' },
      agents: () => ({}),
      store,
      env: {},
    });
    const result = await router.route({
      state: 'new task',
      sessionID: 'ses_fail',
      taskKey: 'new task',
    });
    expect(result.status).toBe('error');
    expect(
      store.getForSpecialist('ses_fail', 'fixer', {
        taskKey: 'old task',
      }),
    ).toBeUndefined();
  });

  test('route() records into store', async () => {
    const store = new JevRouteStore();
    const router = new JevRouter({
      config: base,
      agents: () => ({ fixer: { model: 'cmd/mid' } }),
      store,
      env: {},
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            model: 'j',
            answers: {
              specialist: {
                type: 'choice',
                choice: 'fixer',
                confidence: 0.9,
                probabilities: { fixer: 0.9 },
              },
              complexity: {
                type: 'score',
                score: 1,
                legend: {},
                probabilities: {},
                confidence: 0.9,
              },
              risk: {
                type: 'score',
                score: 1,
                legend: {},
                probabilities: {},
                confidence: 0.9,
              },
            },
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    await router.route({
      state: 'do the thing',
      sessionID: 'ses_abc',
      taskKey: 'do the thing',
    });
    expect(
      store.getForSpecialist('ses_abc', 'fixer', {
        requireOk: true,
        taskKey: 'do the thing',
      })?.status,
    ).toBe('ok');
  });
});
