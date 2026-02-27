/// <reference types="bun-types" />

import { describe, expect, mock, test } from 'bun:test';
import { usage } from './usage';

describe('usage command', () => {
  test('returns NanoGPT JSON with pacing insight', async () => {
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const originalNanoKey = process.env.NANOGPT_API_KEY;
    const output: string[] = [];

    try {
      process.env.NANOGPT_API_KEY = 'nano-key';

      globalThis.fetch = mock(async (url: string | URL) => {
        if (String(url) === 'https://nano-gpt.com/api/subscription/v1/usage') {
          return {
            ok: true,
            json: async () => ({
              limits: { daily: 5000, monthly: 60000 },
              daily: { used: 200, remaining: 4800 },
              monthly: { used: 5000, remaining: 55000 },
            }),
          } as unknown as Response;
        }

        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
        } as unknown as Response;
      }) as unknown as typeof fetch;

      console.log = (...args: unknown[]) => {
        output.push(args.map(String).join(' '));
      };

      const code = await usage(['--provider=nanogpt', '--json']);
      expect(code).toBe(0);

      const parsed = JSON.parse(output.join('\n')) as {
        provider: string;
        nanogpt?: {
          monthlyUsed?: number;
          monthlyLimit?: number;
        };
        insights?: {
          nanogpt?: {
            status?: string;
          };
        };
      };

      expect(parsed.provider).toBe('nanogpt');
      expect(parsed.nanogpt?.monthlyUsed).toBe(5000);
      expect(parsed.nanogpt?.monthlyLimit).toBe(60000);
      expect(parsed.insights?.nanogpt?.status).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
      if (typeof originalNanoKey === 'string') {
        process.env.NANOGPT_API_KEY = originalNanoKey;
      } else {
        delete process.env.NANOGPT_API_KEY;
      }
    }
  });
});
