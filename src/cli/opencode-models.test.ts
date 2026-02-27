/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import {
  discoverModelCatalog,
  discoverNanoGptModelsByPolicy,
  parseOpenCodeModelsVerboseOutput,
} from './opencode-models';

const SAMPLE_OUTPUT = `
opencode/gpt-5-nano
{
  "id": "gpt-5-nano",
  "providerID": "opencode",
  "name": "GPT 5 Nano",
  "status": "active",
  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },
  "limit": { "context": 400000, "output": 128000 },
  "capabilities": { "reasoning": true, "toolcall": true, "attachment": true }
}
chutes/minimax-m2.1-5000
{
  "id": "minimax-m2.1-5000",
  "providerID": "chutes",
  "name": "MiniMax M2.1 5000 req/day",
  "status": "active",
  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },
  "limit": { "context": 500000, "output": 64000 },
  "capabilities": { "reasoning": true, "toolcall": true, "attachment": false }
}
chutes/qwen3-coder-30b
{
  "id": "qwen3-coder-30b",
  "providerID": "chutes",
  "name": "Qwen3 Coder 30B",
  "status": "active",
  "cost": { "input": 0.4, "output": 0.8, "cache": { "read": 0, "write": 0 } },
  "limit": { "context": 262144, "output": 32768 },
  "capabilities": { "reasoning": true, "toolcall": true, "attachment": false }
}
nano-gpt/minimax/minimax-m2.5
{
  "id": "minimax/minimax-m2.5",
  "providerID": "nano-gpt",
  "name": "MiniMax M2.5",
  "status": "active",
  "cost": { "input": 0.3, "output": 1.2, "cache": { "read": 0, "write": 0 } },
  "limit": { "context": 200000, "output": 32768 },
  "capabilities": { "reasoning": true, "toolcall": true, "attachment": false }
}
`;

describe('opencode-models parser', () => {
  test('FR-002 discovers models from verbose output catalog', () => {
    const models = parseOpenCodeModelsVerboseOutput(
      SAMPLE_OUTPUT,
      undefined,
      false,
    );
    expect(models.length).toBeGreaterThanOrEqual(3);
    expect(models.some((entry) => entry.providerID === 'opencode')).toBe(true);
    expect(models.some((entry) => entry.providerID === 'chutes')).toBe(true);
  });

  test('filters by provider and keeps free models', () => {
    const models = parseOpenCodeModelsVerboseOutput(SAMPLE_OUTPUT, 'opencode');
    expect(models.length).toBe(1);
    expect(models[0]?.model).toBe('opencode/gpt-5-nano');
    expect(models[0]?.providerID).toBe('opencode');
  });

  test('extracts chutes daily request limit from model metadata', () => {
    const models = parseOpenCodeModelsVerboseOutput(SAMPLE_OUTPUT, 'chutes');
    expect(models.length).toBe(1);
    expect(models[0]?.model).toBe('chutes/minimax-m2.1-5000');
    expect(models[0]?.dailyRequestLimit).toBe(5000);
  });

  test('includes non-free chutes models when freeOnly is disabled', () => {
    const models = parseOpenCodeModelsVerboseOutput(
      SAMPLE_OUTPUT,
      'chutes',
      false,
    );
    expect(models.length).toBe(2);
    expect(models[1]?.model).toBe('chutes/qwen3-coder-30b');
  });

  test('normalizes nano-gpt provider id to nanogpt', () => {
    const models = parseOpenCodeModelsVerboseOutput(
      SAMPLE_OUTPUT,
      'nanogpt',
      false,
    );
    expect(models.length).toBe(1);
    expect(models[0]?.providerID).toBe('nanogpt');
    expect(models[0]?.model).toBe('nanogpt/minimax/minimax-m2.5');
  });

  test('uses NanoGPT subscription endpoint for subscription-only policy', async () => {
    const encode = new TextEncoder();
    const spawnCommand: typeof Bun.spawn = (() => {
      return {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode.encode(SAMPLE_OUTPUT));
            controller.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode.encode(''));
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
        kill: () => {},
      } as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    const fetchImpl: typeof fetch = (async (url) => {
      const endpoint = typeof url === 'string' ? url : String(url);
      if (endpoint.includes('/api/subscription/v1/models')) {
        return new Response(JSON.stringify([{ id: 'minimax/minimax-m2.5' }]));
      }
      if (endpoint.includes('/api/paid/v1/models')) {
        return new Response(
          JSON.stringify([{ id: 'qwen/qwen3.5-plus-thinking' }]),
        );
      }
      return new Response('[]');
    }) as typeof fetch;

    const discovered = await discoverNanoGptModelsByPolicy(
      'subscription-only',
      {
        spawnCommand,
        fetchImpl,
        nanogptApiKey: 'test-key',
      },
    );

    expect(discovered.models.map((model) => model.model)).toEqual([
      'nanogpt/minimax/minimax-m2.5',
    ]);
    expect(discovered.models[0]?.nanoGptAccess).toBe('subscription');
  });

  test('uses NanoGPT paid endpoint for paygo-only policy', async () => {
    const encode = new TextEncoder();
    const paidSample = `${SAMPLE_OUTPUT}
nano-gpt/qwen/qwen3.5-plus-thinking
{
  "id": "qwen/qwen3.5-plus-thinking",
  "providerID": "nano-gpt",
  "name": "Qwen 3.5 Plus Thinking",
  "status": "active",
  "cost": { "input": 0.4, "output": 2.4, "cache": { "read": 0, "write": 0 } },
  "limit": { "context": 200000, "output": 8192 },
  "capabilities": { "reasoning": true, "toolcall": true, "attachment": false }
}
`;

    const spawnCommand: typeof Bun.spawn = (() => {
      return {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode.encode(paidSample));
            controller.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode.encode(''));
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
        kill: () => {},
      } as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    const fetchImpl: typeof fetch = (async (url) => {
      const endpoint = typeof url === 'string' ? url : String(url);
      if (endpoint.includes('/api/subscription/v1/models')) {
        return new Response(JSON.stringify([{ id: 'minimax/minimax-m2.5' }]));
      }
      if (endpoint.includes('/api/paid/v1/models')) {
        return new Response(
          JSON.stringify([{ id: 'qwen/qwen3.5-plus-thinking' }]),
        );
      }
      return new Response('[]');
    }) as typeof fetch;

    const discovered = await discoverNanoGptModelsByPolicy('paygo-only', {
      spawnCommand,
      fetchImpl,
      nanogptApiKey: 'test-key',
    });

    expect(discovered.models.map((model) => model.model)).toEqual([
      'nanogpt/qwen/qwen3.5-plus-thinking',
    ]);
    expect(discovered.models[0]?.nanoGptAccess).toBe('paid');
  });

  test('returns timeout error when discovery process exceeds timeout', async () => {
    const spawnCommand: typeof Bun.spawn = (() => {
      return {
        stdout: new ReadableStream<Uint8Array>(),
        stderr: new ReadableStream<Uint8Array>(),
        exited: new Promise<number>(() => {}),
        kill: () => {},
      } as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    const discovered = await discoverModelCatalog({
      timeoutMs: 100,
      opencodePath: 'opencode',
      spawnCommand,
    });

    expect(discovered.models).toHaveLength(0);
    expect(discovered.error).toContain('Model discovery timeout after 100ms');
  }, 5_000);

  test('surfaces stderr when discovery command exits non-zero', async () => {
    const encode = new TextEncoder();
    const spawnCommand: typeof Bun.spawn = (() => {
      return {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode.encode(''));
            controller.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode.encode('command failed from stderr'));
            controller.close();
          },
        }),
        exited: Promise.resolve(1),
        kill: () => {},
      } as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    const discovered = await discoverModelCatalog({
      timeoutMs: 500,
      opencodePath: 'opencode',
      spawnCommand,
    });

    expect(discovered.models).toHaveLength(0);
    expect(discovered.error).toBe('command failed from stderr');
  });
});
