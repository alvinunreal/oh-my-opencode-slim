/// <reference types="bun-types" />

import { describe, expect, mock, test } from 'bun:test';
import { parseOpenCodeModelsVerboseOutput } from './opencode-models';
import {
  pickBestCodingOpenCodeModel,
  pickSupportOpenCodeModel,
} from './opencode-selection';
import {
  fetchLatestVersion,
  getOpenCodeVersion,
  isOpenCodeInstalled,
  isTmuxInstalled,
} from './system';

describe('system', () => {
  test('isOpenCodeInstalled returns boolean', async () => {
    // We don't necessarily want to depend on the host system
    // but for a basic test we can just check it returns a boolean
    const result = await isOpenCodeInstalled();
    expect(typeof result).toBe('boolean');
  });

  test('isTmuxInstalled returns boolean', async () => {
    const result = await isTmuxInstalled();
    expect(typeof result).toBe('boolean');
  });

  test('fetchLatestVersion returns version string or null', async () => {
    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return {
        ok: true,
        json: async () => ({ version: '1.2.3' }),
      };
    }) as any;

    try {
      const version = await fetchLatestVersion('any-package');
      expect(version).toBe('1.2.3');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchLatestVersion returns null on error', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = mock(async () => {
        return {
          ok: false,
        };
      }) as any;

      const version = await fetchLatestVersion('any-package');
      expect(version).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('getOpenCodeVersion returns string or null', async () => {
    const version = await getOpenCodeVersion();
    if (version !== null) {
      expect(typeof version).toBe('string');
    } else {
      expect(version).toBeNull();
    }
  });

  test('parseOpenCodeModelsVerboseOutput extracts only opencode free models', () => {
    const output = `opencode/glm-4.7-free
{
  "id": "glm-4.7-free",
  "providerID": "opencode",
  "name": "GLM-4.7 Free",
  "status": "active",
  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },
  "limit": { "context": 204800, "output": 131072 },
  "capabilities": { "reasoning": true, "toolcall": true, "attachment": false }
}

openai/gpt-5.3-codex
{
  "id": "gpt-5.3-codex",
  "providerID": "openai",
  "name": "GPT-5.3 Codex",
  "status": "active",
  "cost": { "input": 1, "output": 1, "cache": { "read": 0, "write": 0 } },
  "limit": { "context": 400000, "output": 128000 },
  "capabilities": { "reasoning": true, "toolcall": true, "attachment": true }
}
`;

    const models = parseOpenCodeModelsVerboseOutput(output);
    expect(models).toHaveLength(1);
    expect(models[0]?.model).toBe('opencode/glm-4.7-free');
  });

  test('pickBestCodingOpenCodeModel prefers stronger coding profile', () => {
    const models = [
      {
        model: 'opencode/gpt-5-nano',
        name: 'GPT-5 Nano',
        status: 'active' as const,
        contextLimit: 400000,
        outputLimit: 128000,
        reasoning: true,
        toolcall: true,
        attachment: true,
      },
      {
        model: 'opencode/trinity-large-preview-free',
        name: 'Trinity Large Preview',
        status: 'active' as const,
        contextLimit: 131072,
        outputLimit: 131072,
        reasoning: false,
        toolcall: true,
        attachment: false,
      },
    ];

    const best = pickBestCodingOpenCodeModel(models);
    expect(best?.model).toBe('opencode/gpt-5-nano');
  });

  test('pickSupportOpenCodeModel picks helper model different from primary', () => {
    const models = [
      {
        model: 'opencode/glm-4.7-free',
        name: 'GLM-4.7 Free',
        status: 'active' as const,
        contextLimit: 204800,
        outputLimit: 131072,
        reasoning: true,
        toolcall: true,
        attachment: false,
      },
      {
        model: 'opencode/gpt-5-nano',
        name: 'GPT-5 Nano',
        status: 'active' as const,
        contextLimit: 400000,
        outputLimit: 128000,
        reasoning: true,
        toolcall: true,
        attachment: true,
      },
    ];

    const support = pickSupportOpenCodeModel(models, 'opencode/glm-4.7-free');
    expect(support?.model).toBe('opencode/gpt-5-nano');
  });
});
