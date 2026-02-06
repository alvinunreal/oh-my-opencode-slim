/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { parseOpenCodeModelsVerboseOutput } from './opencode-models';

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
`;

describe('opencode-models parser', () => {
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
});
