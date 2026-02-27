/// <reference types="bun-types" />

import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractUsageCountersFromPayload,
  fetchChutesDailyUsage,
  fetchProviderUsageSnapshot,
  resolveNanoGptApiKeyFromOpenCodeFiles,
} from './provider-usage';

describe('provider-usage', () => {
  test('extracts NanoGPT daily/monthly counters from subscription payload', () => {
    const counters = extractUsageCountersFromPayload({
      active: true,
      limits: { daily: 5000, monthly: 60000 },
      daily: {
        used: 120,
        remaining: 4880,
      },
      monthly: {
        used: 2300,
        remaining: 57700,
      },
    });

    expect(counters.dailyUsed).toBe(120);
    expect(counters.dailyRemaining).toBe(4880);
    expect(counters.monthlyUsed).toBe(2300);
    expect(counters.monthlyRemaining).toBe(57700);
  });

  test('extracts snake_case counters and can infer monthly used', () => {
    const counters = extractUsageCountersFromPayload({
      usage: {
        monthly_limit: 1000,
        monthly_remaining: 240,
      },
    });

    expect(counters.monthlyLimit).toBe(1000);
    expect(counters.monthlyRemaining).toBe(240);
  });

  test('extracts NanoGPT weeklyInputTokens counters and maps to pacing fields', () => {
    const counters = extractUsageCountersFromPayload({
      active: true,
      limits: {
        weeklyInputTokens: 60000000,
        dailyInputTokens: null,
      },
      weeklyInputTokens: {
        used: 123456,
        remaining: 59876544,
        percentUsed: 0.21,
      },
    });

    expect(counters.weeklyUsed).toBe(123456);
    expect(counters.weeklyRemaining).toBe(59876544);
    expect(counters.weeklyLimit).toBe(60000000);
    expect(counters.dailyUsed).toBe(123456);
    expect(counters.dailyRemaining).toBe(59876544);
    expect(counters.monthlyUsed).toBe(123456);
    expect(counters.monthlyRemaining).toBe(59876544);
    expect(counters.monthlyLimit).toBe(60000000);
  });

  test('fetchProviderUsageSnapshot parses NanoGPT and Chutes responses', async () => {
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = mock(async (url: string | URL) => {
        const href = String(url);
        if (href.includes('nanogpt.example')) {
          return {
            ok: true,
            json: async () => ({
              limits: { daily: 5000, monthly: 60000 },
              daily: { used: 250, remaining: 4750 },
              monthly: { used: 4200, remaining: 55800 },
            }),
          };
        }

        if (href.includes('chutes.example')) {
          return {
            ok: true,
            json: async () => ({
              usage: {
                monthly_used: 800,
                monthly_limit: 2000,
              },
            }),
          };
        }

        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
        };
      }) as unknown as typeof fetch;

      const output = await fetchProviderUsageSnapshot({
        nanogptApiKey: 'nano-key',
        chutesApiKey: 'chutes-key',
        nanogptUsageUrl: 'https://nanogpt.example/usage',
        chutesUsageUrl: 'https://chutes.example/usage',
      });

      expect(output.warnings).toHaveLength(0);
      expect(output.usage.nanogpt?.dailyRemaining).toBe(4750);
      expect(output.usage.nanogpt?.monthlyUsed).toBe(4200);
      expect(output.usage.nanogpt?.monthlyLimit).toBe(60000);
      expect(output.usage.chutes?.monthlyUsed).toBe(800);
      expect(output.usage.chutes?.monthlyLimit).toBe(2000);
      expect(output.usage.chutes?.monthlyRemaining).toBe(1200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('resolves NanoGPT key from auth.json before environment key', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omos-nanogpt-auth-'));
    const originalEnv = process.env.NANOGPT_API_KEY;

    try {
      writeFileSync(
        join(tmp, 'auth.json'),
        JSON.stringify({
          providers: {
            nanogpt: {
              apiKey: 'file-key-abcdef123456',
            },
          },
        }),
      );
      process.env.NANOGPT_API_KEY = 'env-key-should-not-win';

      const key = resolveNanoGptApiKeyFromOpenCodeFiles({
        openCodeConfigDir: tmp,
        openCodeDataDir: tmp,
      });
      expect(key).toBe('file-key-abcdef123456');
    } finally {
      if (typeof originalEnv === 'string') {
        process.env.NANOGPT_API_KEY = originalEnv;
      } else {
        delete process.env.NANOGPT_API_KEY;
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('resolves NanoGPT key from data-dir auth.json', () => {
    const configTmp = mkdtempSync(join(tmpdir(), 'omos-nanogpt-config-'));
    const dataTmp = mkdtempSync(join(tmpdir(), 'omos-nanogpt-data-'));

    try {
      writeFileSync(
        join(dataTmp, 'auth.json'),
        JSON.stringify({
          'nano-gpt': {
            type: 'api',
            key: 'data-file-key-12345678',
          },
        }),
      );

      const key = resolveNanoGptApiKeyFromOpenCodeFiles({
        openCodeConfigDir: configTmp,
        openCodeDataDir: dataTmp,
      });
      expect(key).toBe('data-file-key-12345678');
    } finally {
      rmSync(configTmp, { recursive: true, force: true });
      rmSync(dataTmp, { recursive: true, force: true });
    }
  });

  test('uses pinned NanoGPT subscription usage endpoint by default', async () => {
    const originalFetch = globalThis.fetch;
    const originalEnv = process.env.NANOGPT_API_KEY;
    const calls: Array<{ url: string; authorization?: string }> = [];
    const tmp = mkdtempSync(join(tmpdir(), 'omos-nanogpt-fetch-'));

    try {
      writeFileSync(
        join(tmp, 'auth.json'),
        JSON.stringify({
          nanogpt: {
            token: 'file-nano-key-xyz12345',
          },
        }),
      );
      process.env.NANOGPT_API_KEY = 'env-key-should-not-win';

      globalThis.fetch = mock(
        async (url: string | URL, init?: RequestInit): Promise<Response> => {
          const href = String(url);
          const headers = (init?.headers ?? {}) as Record<string, string>;
          calls.push({
            url: href,
            authorization: headers.Authorization,
          });

          if (
            href === 'https://nano-gpt.com/api/subscription/v1/usage' &&
            headers.Authorization === 'Bearer file-nano-key-xyz12345'
          ) {
            return {
              ok: true,
              json: async () => ({
                limits: { daily: 5000, monthly: 60000 },
                daily: { used: 10, remaining: 4990 },
                monthly: { used: 140, remaining: 59860 },
              }),
            } as unknown as Response;
          }

          return {
            ok: false,
            status: 404,
            statusText: 'Not Found',
          } as unknown as Response;
        },
      ) as unknown as typeof fetch;

      const output = await fetchProviderUsageSnapshot({
        includeChutes: false,
        openCodeConfigDir: tmp,
        openCodeDataDir: tmp,
      });

      expect(output.usage.nanogpt?.monthlyUsed).toBe(140);
      expect(output.usage.nanogpt?.monthlyLimit).toBe(60000);
      expect(output.warnings).toHaveLength(0);

      expect(calls.length).toBe(1);
      expect(calls[0]?.url).toBe(
        'https://nano-gpt.com/api/subscription/v1/usage',
      );
      expect(calls[0]?.authorization).toBe('Bearer file-nano-key-xyz12345');
    } finally {
      globalThis.fetch = originalFetch;
      if (typeof originalEnv === 'string') {
        process.env.NANOGPT_API_KEY = originalEnv;
      } else {
        delete process.env.NANOGPT_API_KEY;
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('uses pinned Chutes quotas endpoint with authorization api key header', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; authorization?: string }> = [];

    try {
      globalThis.fetch = mock(
        async (url: string | URL, init?: RequestInit): Promise<Response> => {
          const href = String(url);
          const headers = (init?.headers ?? {}) as Record<string, string>;
          calls.push({
            url: href,
            authorization: headers.Authorization,
          });

          if (
            href === 'https://api.chutes.ai/users/me/quotas' &&
            headers.Authorization === 'chutes-key'
          ) {
            return {
              ok: true,
              json: async () => [
                {
                  quota: 300,
                  user_id: 'user-1',
                },
              ],
            } as unknown as Response;
          }

          return {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
          } as unknown as Response;
        },
      ) as unknown as typeof fetch;

      const output = await fetchProviderUsageSnapshot({
        chutesApiKey: 'chutes-key',
      });

      expect(output.usage.chutes?.monthlyUsed).toBeUndefined();
      expect(output.usage.chutes?.monthlyLimit).toBe(300);
      expect(output.warnings.some((w) => w.includes('NanoGPT'))).toBe(true);

      const chutesCalls = calls.filter((call) =>
        call.url.includes('api.chutes.ai/users/me/quotas'),
      );
      expect(chutesCalls.length).toBe(1);
      expect(chutesCalls[0]?.authorization).toBe('chutes-key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetches and aggregates Chutes daily usage from paginated usage endpoint', async () => {
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = mock(
        async (url: string | URL, init?: RequestInit): Promise<Response> => {
          const href = String(url);
          const headers = (init?.headers ?? {}) as Record<string, string>;

          if (
            href === 'https://api.chutes.ai/users/me/quotas' &&
            headers.Authorization === 'chutes-key'
          ) {
            return {
              ok: true,
              json: async () => [
                {
                  user_id: 'user-1',
                  quota: 300,
                },
              ],
            } as unknown as Response;
          }

          if (href.includes('/users/user-1/usage?page=0&limit=24')) {
            return {
              ok: true,
              json: async () => ({
                total: 30,
                page: 0,
                limit: 24,
                items: [
                  {
                    bucket: '2026-02-16T10:00:00',
                    count: 2,
                    input_tokens: 100,
                    output_tokens: 200,
                    amount: 0.5,
                  },
                  {
                    bucket: '2026-02-15T09:00:00',
                    count: 9,
                    input_tokens: 900,
                    output_tokens: 900,
                    amount: 2,
                  },
                ],
              }),
            } as unknown as Response;
          }

          if (href.includes('/users/user-1/usage?page=1&limit=24')) {
            return {
              ok: true,
              json: async () => ({
                total: 30,
                page: 1,
                limit: 24,
                items: [
                  {
                    bucket: '2026-02-16T11:00:00',
                    count: 3,
                    input_tokens: 300,
                    output_tokens: 400,
                    amount: 0.75,
                  },
                ],
              }),
            } as unknown as Response;
          }

          return {
            ok: false,
            status: 404,
            statusText: 'Not Found',
          } as unknown as Response;
        },
      ) as unknown as typeof fetch;

      const output = await fetchChutesDailyUsage({
        apiKey: 'chutes-key',
        dayUtc: new Date('2026-02-16T12:00:00Z'),
      });

      expect(output.warning).toBeUndefined();
      expect(output.usage?.date).toBe('2026-02-16');
      expect(output.usage?.requests).toBe(5);
      expect(output.usage?.inputTokens).toBe(400);
      expect(output.usage?.outputTokens).toBe(600);
      expect(output.usage?.amount).toBe(1.25);
      expect(output.usage?.buckets).toHaveLength(2);
      expect(output.usage?.monthRequests).toBe(14);
      expect(output.usage?.monthInputTokens).toBe(1300);
      expect(output.usage?.monthOutputTokens).toBe(1500);
      expect(output.usage?.monthAmount).toBe(3.25);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
