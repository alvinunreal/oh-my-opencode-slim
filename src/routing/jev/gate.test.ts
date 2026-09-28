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
  test('records and matches specialist', () => {
    const store = new JevRouteStore();
    store.record('ses_1', {
      status: 'ok',
      specialist: 'fixer',
      confidence: 0.9,
      modelTier: 'max',
      model: { id: 'cmd/strong' },
      recommendation: 'x',
    });
    expect(store.getForSpecialist('ses_1', 'fixer')?.model?.id).toBe(
      'cmd/strong',
    );
    expect(store.getForSpecialist('ses_1', 'oracle')).toBeUndefined();
  });

  test('ignores error status', () => {
    const store = new JevRouteStore();
    store.record('ses_1', {
      status: 'error',
      specialist: 'fixer',
      recommendation: 'x',
    });
    expect(store.getForSpecialist('ses_1', 'fixer')).toBeUndefined();
  });
});

describe('JevRouter.session cache', () => {
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
    await router.route({ state: 'do the thing', sessionID: 'ses_abc' });
    expect(store.getForSpecialist('ses_abc', 'fixer')?.status).toBe('ok');
  });
});
