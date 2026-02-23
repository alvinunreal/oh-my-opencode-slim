import { describe, expect, test } from 'bun:test';
import { capBytes, capLines, capToolOutput, stripNoise } from './airlock';
import { PACKET_CONSTRAINTS, ROLE_PRIORITY } from './config';
import { mergePackets } from './packet-merger';
import { PointerResolver } from './pointer-resolver';
import { classifyAndRoute } from './task-router';
import type { PacketV1 } from './types';
import { validatePacketV1 } from './validator';

describe('config', () => {
  test('PACKET_CONSTRAINTS has correct limits', () => {
    expect(PACKET_CONSTRAINTS.maxChars).toBe(2500);
    expect(PACKET_CONSTRAINTS.maxTldrBullets).toBe(3);
    expect(PACKET_CONSTRAINTS.maxEvidenceBullets).toBe(5);
    expect(PACKET_CONSTRAINTS.maxActions).toBe(5);
  });

  test('ROLE_PRIORITY has correct ordering', () => {
    expect(ROLE_PRIORITY.VALIDATOR).toBeGreaterThan(ROLE_PRIORITY.IMPLEMENTER);
    expect(ROLE_PRIORITY.IMPLEMENTER).toBeGreaterThan(ROLE_PRIORITY.RESEARCHER);
    expect(ROLE_PRIORITY.ORCHESTRATOR).toBeGreaterThan(ROLE_PRIORITY.VALIDATOR);
  });
});

describe('validator', () => {
  test('validates a correct packet', () => {
    const packet: PacketV1 = {
      tldr: ['Key finding 1', 'Key finding 2'],
      evidence: ['file:src/index.ts:42', 'thread:abc123'],
      recommendation: 'Use the new pattern',
      next_actions: ['Update imports', 'Run tests'],
    };

    const result = validatePacketV1(packet);
    expect(result._validated).toBe(true);
    expect(result.charCount).toBeGreaterThan(0);
  });

  test('rejects packet with too many tldr bullets', () => {
    const packet: PacketV1 = {
      tldr: ['1', '2', '3', '4'],
      evidence: ['evidence'],
      recommendation: 'rec',
      next_actions: ['action'],
    };

    expect(() => validatePacketV1(packet)).toThrow();
  });

  test('rejects packet exceeding max chars', () => {
    const packet: PacketV1 = {
      tldr: ['x'.repeat(3000)],
      evidence: ['evidence'],
      recommendation: 'rec',
      next_actions: ['action'],
    };

    expect(() => validatePacketV1(packet)).toThrow();
  });
});

describe('airlock', () => {
  test('stripNoise removes npm warnings', () => {
    const output =
      'npm WARN deprecated package\nactual output\nnpm notice message';
    const cleaned = stripNoise(output);
    expect(cleaned).not.toContain('npm WARN');
    expect(cleaned).not.toContain('npm notice');
    expect(cleaned).toContain('actual output');
  });

  test('stripNoise removes progress bars', () => {
    const output = '[=====>    ] Processing\nDone';
    const cleaned = stripNoise(output);
    expect(cleaned).not.toContain('[=====');
  });

  test('capLines truncates long output', () => {
    const lines = Array(300).fill('line').join('\n');
    const capped = capLines(lines, 250);
    expect(capped).toContain('truncated');
  });

  test('capBytes truncates long output', () => {
    const content = 'x'.repeat(15000);
    const capped = capBytes(content, 12288);
    expect(capped.length).toBeLessThanOrEqual(12500);
    expect(capped).toContain('truncated');
  });

  test('capToolOutput strips noise and applies caps', () => {
    const output =
      'npm WARN deprecated pkg\n' + Array(300).fill('line').join('\n');
    const result = capToolOutput('bash', output);
    expect(result).toContain('truncated');
    expect(result).not.toContain('npm WARN');
  });
});

describe('task-router', () => {
  test('identifies non-trivial tasks requiring research', () => {
    const plan = classifyAndRoute(
      'Research React state management best practices',
    );
    expect(plan.isTrivial).toBe(false);
    expect(plan.delegates.some((d) => d.role === 'RESEARCHER')).toBe(true);
  });

  test('identifies research tasks', () => {
    const plan = classifyAndRoute(
      'Research best practices for React state management',
    );
    expect(plan.isTrivial).toBe(false);
    expect(plan.delegates.some((d) => d.role === 'RESEARCHER')).toBe(true);
  });

  test('identifies validation tasks', () => {
    const plan = classifyAndRoute('Implement auth and test it');
    expect(plan.delegates.some((d) => d.role === 'VALIDATOR')).toBe(true);
  });

  test('identifies codebase analysis tasks', () => {
    const plan = classifyAndRoute('Find all files matching the pattern');
    expect(plan.delegates.some((d) => d.role === 'REPO_SCOUT')).toBe(true);
  });
});

describe('packet-merger', () => {
  test('merges single packet', () => {
    const results = [
      {
        packet: validatePacketV1({
          tldr: ['Finding 1'],
          evidence: ['file:a.ts'],
          recommendation: 'Do X',
          next_actions: ['Action 1'],
        }),
        threadId: 't1',
        role: 'IMPLEMENTER' as const,
        modelUsed: 'model',
        tokenCount: 100,
      },
    ];

    const merged = mergePackets(results);
    expect(merged.tldr).toHaveLength(1);
    expect(merged.recommendation).toBe('Do X');
  });

  test('prioritizes by role', () => {
    const results = [
      {
        packet: validatePacketV1({
          tldr: ['Research finding'],
          evidence: ['thread:abc123'],
          recommendation: 'Research says X',
          next_actions: ['Research action'],
        }),
        threadId: 't1',
        role: 'RESEARCHER' as const,
        modelUsed: 'model',
        tokenCount: 100,
      },
      {
        packet: validatePacketV1({
          tldr: ['Implementation finding'],
          evidence: ['file:b.ts:10'],
          recommendation: 'Implementation says Y',
          next_actions: ['Implementation action'],
        }),
        threadId: 't2',
        role: 'IMPLEMENTER' as const,
        modelUsed: 'model',
        tokenCount: 200,
      },
    ];

    const merged = mergePackets(results);
    expect(merged.recommendation).toBe('Implementation says Y');
  });
});

describe('PointerResolver', () => {
  test('respects quota', () => {
    const resolver = new PointerResolver(2);
    expect(resolver.canResolve()).toBe(true);
    expect(resolver.remaining()).toBe(2);
  });

  test('resets counter', () => {
    const resolver = new PointerResolver(1);
    expect(resolver.remaining()).toBe(1);
    resolver.reset();
    expect(resolver.remaining()).toBe(1);
  });

  test('parsePointer returns null for invalid format', async () => {
    const resolver = new PointerResolver();
    const result = await resolver.resolve('invalid-pointer');
    expect(result).toContain('Invalid pointer format');
  });
});
