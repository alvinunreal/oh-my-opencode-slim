/**
 * Phase 12: Isolation, capping, and delegate flow tests.
 *
 * Covers:
 * - Tool output capping (airlock hook: bash lines, file bytes)
 * - Context7/websearch MCP restriction (librarian-only)
 * - Packet isolation verification (assertNoRawContextLeak)
 * - Multi-delegate packet merging (mergePackets + packet_context)
 * - Auto-routing via classifyAndRoute
 * - Session-scoped metrics tracking (startTaskTracking called once per session)
 * - agentNameToRole mapping
 * - PacketTaskManager: isAgentAllowed, getAllowedSubagents, tracking guards,
 *   cancel, cleanup
 */

import { describe, expect, test } from 'bun:test';
import { DEFAULT_AGENT_MCPS, getAgentMcpList } from '../config/agent-mcps';
import { createAirlockHook } from '../hooks/airlock';
import { capBytes, capLines } from '../token-discipline/airlock';
import { TOOL_CAPS } from '../token-discipline/config';
import { mergePackets } from '../token-discipline/packet-merger';
import { classifyAndRoute } from '../token-discipline/task-router';
import type { DelegateResult } from '../token-discipline/types';
import {
  assertNoRawContextLeak,
  validatePacketV1,
} from '../token-discipline/validator';
import { agentNameToRole } from './index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidatedPacket(overrides?: {
  tldr?: string[];
  evidence?: string[];
  recommendation?: string;
  next_actions?: string[];
}) {
  return validatePacketV1({
    tldr: overrides?.tldr ?? ['Key finding'],
    evidence: overrides?.evidence ?? ['file:src/index.ts:1'],
    recommendation: overrides?.recommendation ?? 'Do the thing',
    next_actions: overrides?.next_actions ?? ['Step 1'],
  });
}

function makeDelegateResult(
  overrides?: Parameters<typeof makeValidatedPacket>[0] & {
    role?: DelegateResult['role'];
    threadId?: string;
    tokenCount?: number;
  },
): DelegateResult {
  return {
    packet: makeValidatedPacket(overrides),
    threadId: overrides?.threadId ?? 'thread_abc',
    role: overrides?.role ?? 'IMPLEMENTER',
    modelUsed: 'test-model',
    tokenCount: overrides?.tokenCount ?? 100,
  };
}

// ---------------------------------------------------------------------------
// Tool output capping (airlock)
// ---------------------------------------------------------------------------

describe('airlock capping — lines', () => {
  test('bash output over limit is truncated', () => {
    const lines = Array(300).fill('output line').join('\n');
    const capped = capLines(lines, TOOL_CAPS.bash.maxLines);
    const resultLines = capped.split('\n');
    // First N lines preserved plus the truncation notice
    expect(resultLines.length).toBe(TOOL_CAPS.bash.maxLines + 2); // blank + notice
    expect(capped).toContain('truncated');
    expect(capped).toContain(`${300 - TOOL_CAPS.bash.maxLines} lines`);
  });

  test('bash output within limit is not truncated', () => {
    const lines = Array(100).fill('output line').join('\n');
    const capped = capLines(lines, TOOL_CAPS.bash.maxLines);
    expect(capped).not.toContain('truncated');
    expect(capped).toBe(lines);
  });

  test('git_diff cap is 400 lines', () => {
    expect(TOOL_CAPS.git_diff.maxLines).toBe(400);
  });

  test('git_log cap is 100 lines', () => {
    expect(TOOL_CAPS.git_log.maxLines).toBe(100);
  });
});

describe('airlock capping — bytes', () => {
  test('file read over limit is truncated', () => {
    const content = 'x'.repeat(20_000);
    const capped = capBytes(content, TOOL_CAPS.file_read.maxBytes);
    expect(capped.length).toBeLessThanOrEqual(
      TOOL_CAPS.file_read.maxBytes + 200,
    );
    expect(capped).toContain('truncated');
  });

  test('file read within limit is not truncated', () => {
    const content = 'x'.repeat(1_000);
    const capped = capBytes(content, TOOL_CAPS.file_read.maxBytes);
    expect(capped).not.toContain('truncated');
    expect(capped).toBe(content);
  });

  test('file_read cap is 12 KB', () => {
    expect(TOOL_CAPS.file_read.maxBytes).toBe(12_288);
  });
});

describe('airlock hook — createAirlockHook', () => {
  test('hook truncates bash output over 250 lines', async () => {
    const hook = createAirlockHook();
    const handler = hook['tool.execute.after'];
    const longOutput = Array(300).fill('line').join('\n');
    const output = { title: 'bash', output: longOutput, metadata: {} };
    await handler({ tool: 'bash' }, output);
    expect(output.output).toContain('truncated');
  });

  test('hook does not truncate bash output under 250 lines', async () => {
    const hook = createAirlockHook();
    const handler = hook['tool.execute.after'];
    const shortOutput = Array(100).fill('line').join('\n');
    const output = { title: 'bash', output: shortOutput, metadata: {} };
    await handler({ tool: 'bash' }, output);
    expect(output.output).not.toContain('truncated');
  });

  test('hook truncates read output over 12 KB', async () => {
    const hook = createAirlockHook();
    const handler = hook['tool.execute.after'];
    const bigContent = 'x'.repeat(20_000);
    const output = { title: 'read', output: bigContent, metadata: {} };
    await handler({ tool: 'read' }, output);
    expect(output.output).toContain('truncated');
  });

  test('hook is a no-op for unknown tools', async () => {
    const hook = createAirlockHook();
    const handler = hook['tool.execute.after'];
    const content = Array(500).fill('line').join('\n');
    const output = { title: 'unknown_tool', output: content, metadata: {} };
    await handler({ tool: 'unknown_tool' }, output);
    // Output must be unchanged
    expect(output.output).toBe(content);
  });

  test('run-command is treated same as bash', async () => {
    const hook = createAirlockHook();
    const handler = hook['tool.execute.after'];
    const longOutput = Array(300).fill('line').join('\n');
    const output = { title: 'run-command', output: longOutput, metadata: {} };
    await handler({ tool: 'run-command' }, output);
    expect(output.output).toContain('truncated');
  });
});

// ---------------------------------------------------------------------------
// MCP restriction — context7 / websearch limited to librarian only
// ---------------------------------------------------------------------------

describe('MCP restriction', () => {
  test('librarian has websearch, context7, grep_app', () => {
    const mcps = DEFAULT_AGENT_MCPS.librarian;
    expect(mcps).toContain('websearch');
    expect(mcps).toContain('context7');
    expect(mcps).toContain('grep_app');
  });

  test('orchestrator has no MCPs', () => {
    expect(DEFAULT_AGENT_MCPS.orchestrator).toHaveLength(0);
  });

  test('explorer has no MCPs', () => {
    expect(DEFAULT_AGENT_MCPS.explorer).toHaveLength(0);
  });

  test('fixer has no MCPs', () => {
    expect(DEFAULT_AGENT_MCPS.fixer).toHaveLength(0);
  });

  test('oracle has no MCPs', () => {
    expect(DEFAULT_AGENT_MCPS.oracle).toHaveLength(0);
  });

  test('designer has no MCPs', () => {
    expect(DEFAULT_AGENT_MCPS.designer).toHaveLength(0);
  });

  test('summarizer has no MCPs', () => {
    expect(DEFAULT_AGENT_MCPS.summarizer).toHaveLength(0);
  });

  test('getAgentMcpList returns librarian MCPs without config', () => {
    const mcps = getAgentMcpList('librarian');
    expect(mcps).toContain('websearch');
    expect(mcps).toContain('context7');
  });

  test('getAgentMcpList returns empty for orchestrator without config', () => {
    const mcps = getAgentMcpList('orchestrator');
    expect(mcps).toHaveLength(0);
  });

  test('getAgentMcpList respects config override', () => {
    const config = {
      agents: {
        orchestrator: { mcps: ['websearch'] },
      },
    } as Parameters<typeof getAgentMcpList>[1];
    const mcps = getAgentMcpList('orchestrator', config);
    expect(mcps).toContain('websearch');
  });
});

// ---------------------------------------------------------------------------
// Packet isolation — assertNoRawContextLeak
// ---------------------------------------------------------------------------

describe('isolation — assertNoRawContextLeak', () => {
  test('clean packet with short response passes', () => {
    const packet = makeValidatedPacket();
    // Should not throw
    expect(() =>
      assertNoRawContextLeak(packet, 'thread_001', 'short response'),
    ).not.toThrow();
  });

  test('packet within size limit passes even with long response', () => {
    const packet = makeValidatedPacket();
    const longResponse = 'a'.repeat(15_000); // long but no forbidden patterns
    expect(() =>
      assertNoRawContextLeak(packet, 'thread_002', longResponse),
    ).not.toThrow();
  });

  test('packet with code block in content + long response triggers violation', () => {
    // The validator already forbids code blocks in packet fields, but
    // assertNoRawContextLeak checks the serialized packet. We simulate this
    // by building a packet whose serialized form contains a forbidden pattern.
    // The only way to get here in practice is if a forged ValidatedPacket
    // bypasses validatePacketV1. We construct one directly.
    const forgedPacket = {
      ...makeValidatedPacket(),
      tldr: ['```bash\nrm -rf /\n```'],
    } as ReturnType<typeof makeValidatedPacket>;

    const longResponse = 'x'.repeat(15_000);
    // With a long response the leak check is active and should throw
    expect(() =>
      assertNoRawContextLeak(forgedPacket, 'thread_003', longResponse),
    ).toThrow();
  });

  test('oversized packet serialization triggers violation', () => {
    // Build a packet whose JSON is >3000 chars (maxChars 2500 + 500 tolerance)
    const bigPacket = {
      ...makeValidatedPacket(),
      tldr: ['x'.repeat(1000), 'y'.repeat(1000)],
      evidence: ['e'.repeat(1000)],
      recommendation: 'r'.repeat(600),
      next_actions: ['a'.repeat(600)],
      _validated: true as const,
      charCount: 5000,
    } as ReturnType<typeof makeValidatedPacket>;

    expect(() =>
      assertNoRawContextLeak(bigPacket, 'thread_004', 'short'),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Multi-delegate packet merging
// ---------------------------------------------------------------------------

describe('multi-delegate packet merging', () => {
  test('merges two packets, recommendation taken from higher-priority role', () => {
    const results: DelegateResult[] = [
      makeDelegateResult({
        tldr: ['Research finding A'],
        evidence: ['thread:r1'],
        recommendation: 'Research recommendation',
        next_actions: ['Research action'],
        role: 'RESEARCHER',
        threadId: 'r1',
      }),
      makeDelegateResult({
        tldr: ['Implementation finding B'],
        evidence: ['file:src/foo.ts:10'],
        recommendation: 'Implementation recommendation',
        next_actions: ['Implementation action'],
        role: 'IMPLEMENTER',
        threadId: 'i1',
      }),
    ];

    const merged = mergePackets(results);
    // IMPLEMENTER > RESEARCHER in priority
    expect(merged.recommendation).toBe('Implementation recommendation');
    // Both tldr bullets present (prefixed by role)
    expect(merged.tldr.some((b) => b.includes('Research finding A'))).toBe(
      true,
    );
    expect(
      merged.tldr.some((b) => b.includes('Implementation finding B')),
    ).toBe(true);
    // Sources contain both
    expect(merged.sources).toHaveLength(2);
  });

  test('deduplicates identical bullets across packets', () => {
    const sharedBullet = 'Use the new pattern everywhere';
    const results: DelegateResult[] = [
      makeDelegateResult({
        tldr: [sharedBullet],
        role: 'IMPLEMENTER',
        threadId: 't1',
      }),
      makeDelegateResult({
        tldr: [sharedBullet],
        role: 'VALIDATOR',
        threadId: 't2',
      }),
    ];

    const merged = mergePackets(results);
    // The same bullet (case-insensitive) should appear only once
    const matchCount = merged.tldr.filter((b) =>
      b.toLowerCase().includes(sharedBullet.toLowerCase()),
    ).length;
    expect(matchCount).toBe(1);
  });

  test('detects conflicting recommendations', () => {
    const results: DelegateResult[] = [
      makeDelegateResult({
        recommendation: 'Use approach Alpha',
        role: 'RESEARCHER',
        threadId: 'r1',
      }),
      makeDelegateResult({
        recommendation: 'Use approach Beta',
        role: 'VALIDATOR',
        threadId: 'v1',
      }),
    ];

    const merged = mergePackets(results);
    expect(merged.conflicts).toBeDefined();
    expect(merged.conflicts?.length).toBeGreaterThan(0);
  });

  test('no conflicts when all recommendations match', () => {
    const sameRec = 'Do the same thing';
    const results: DelegateResult[] = [
      makeDelegateResult({
        recommendation: sameRec,
        role: 'RESEARCHER',
        threadId: 'r1',
      }),
      makeDelegateResult({
        recommendation: sameRec,
        role: 'IMPLEMENTER',
        threadId: 'i1',
      }),
    ];

    const merged = mergePackets(results);
    expect(merged.conflicts ?? []).toHaveLength(0);
  });

  test('empty results produce empty merged packet', () => {
    const merged = mergePackets([]);
    expect(merged.tldr).toHaveLength(0);
    expect(merged.evidence).toHaveLength(0);
    expect(merged.recommendation).toBe('');
    expect(merged.sources).toHaveLength(0);
  });

  test('single result passes through as merged packet', () => {
    const result = makeDelegateResult({
      tldr: ['Only finding'],
      recommendation: 'Only rec',
      role: 'VALIDATOR',
      threadId: 'v1',
    });

    const merged = mergePackets([result]);
    expect(merged.recommendation).toBe('Only rec');
    expect(merged.sources).toHaveLength(1);
    expect(merged.sources[0].role).toBe('VALIDATOR');
  });
});

// ---------------------------------------------------------------------------
// Auto-routing via classifyAndRoute
// ---------------------------------------------------------------------------

describe('auto-routing — classifyAndRoute', () => {
  test('research prompt routes to RESEARCHER', () => {
    const plan = classifyAndRoute(
      'Research the best way to handle auth tokens',
    );
    expect(plan.delegates.some((d) => d.role === 'RESEARCHER')).toBe(true);
    expect(plan.isTrivial).toBe(false);
  });

  test('codebase search prompt routes to REPO_SCOUT', () => {
    const plan = classifyAndRoute('Find all files matching the auth pattern');
    expect(plan.delegates.some((d) => d.role === 'REPO_SCOUT')).toBe(true);
  });

  test('implementation + test prompt routes to IMPLEMENTER and VALIDATOR', () => {
    const plan = classifyAndRoute(
      'Implement user login and test it thoroughly',
    );
    expect(plan.delegates.some((d) => d.role === 'IMPLEMENTER')).toBe(true);
    expect(plan.delegates.some((d) => d.role === 'VALIDATOR')).toBe(true);
  });

  test('pure research prompt does not include IMPLEMENTER', () => {
    const plan = classifyAndRoute('How to configure webpack loaders');
    expect(plan.isTrivial).toBe(false);
    // Pure research: no implementation action words → no IMPLEMENTER
    const hasImplementer = plan.delegates.some((d) => d.role === 'IMPLEMENTER');
    // classifyAndRoute only omits IMPLEMENTER when isPureResearch is true
    // (no implement/create/build/write/fix/update/change/modify/add/remove/delete prefix)
    expect(hasImplementer).toBe(false);
  });

  test('always returns at least one delegate', () => {
    const plan = classifyAndRoute('Do something vague');
    expect(plan.delegates.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// agentNameToRole mapping
// ---------------------------------------------------------------------------

describe('agentNameToRole', () => {
  test('librarian maps to RESEARCHER', () => {
    expect(agentNameToRole('librarian')).toBe('RESEARCHER');
  });

  test('explorer maps to REPO_SCOUT', () => {
    expect(agentNameToRole('explorer')).toBe('REPO_SCOUT');
  });

  test('fixer maps to IMPLEMENTER', () => {
    expect(agentNameToRole('fixer')).toBe('IMPLEMENTER');
  });

  test('oracle maps to VALIDATOR', () => {
    expect(agentNameToRole('oracle')).toBe('VALIDATOR');
  });

  test('designer maps to DESIGNER', () => {
    expect(agentNameToRole('designer')).toBe('DESIGNER');
  });

  test('summarizer maps to SUMMARIZER', () => {
    expect(agentNameToRole('summarizer')).toBe('SUMMARIZER');
  });

  test('orchestrator maps to ORCHESTRATOR', () => {
    expect(agentNameToRole('orchestrator')).toBe('ORCHESTRATOR');
  });

  test('unknown agent falls back to IMPLEMENTER', () => {
    expect(agentNameToRole('unknown-agent')).toBe('IMPLEMENTER');
  });
});

// ---------------------------------------------------------------------------
// PacketTaskManager — unit tests (without live client)
// ---------------------------------------------------------------------------

describe('PacketTaskManager — isAgentAllowed', () => {
  // Build a minimal stub that satisfies PluginInput just enough
  // for the constructor (client + directory). No network calls made here.
  function makeManager() {
    const fakeClient = {} as Parameters<
      typeof import('./index').PacketTaskManager.prototype.constructor
    >[0]['client'];
    const fakeCtx = { client: fakeClient, directory: '/tmp' } as Parameters<
      typeof import('./index').PacketTaskManager.prototype.constructor
    >[0];
    const { PacketTaskManager } =
      require('./index') as typeof import('./index');
    return new PacketTaskManager(fakeCtx);
  }

  test('orchestrator (unknown session) can delegate to explorer', () => {
    const mgr = makeManager();
    // Unknown parentSessionId defaults to 'orchestrator' rules
    expect(mgr.isAgentAllowed('sess_unknown', 'explorer')).toBe(true);
  });

  test('orchestrator cannot delegate to itself', () => {
    const mgr = makeManager();
    expect(mgr.isAgentAllowed('sess_unknown', 'orchestrator')).toBe(false);
  });

  test('getAllowedSubagents returns non-empty list for orchestrator', () => {
    const mgr = makeManager();
    const allowed = mgr.getAllowedSubagents('sess_unknown');
    expect(allowed.length).toBeGreaterThan(0);
  });
});

describe('PacketTaskManager — session-scoped metrics tracking guard', () => {
  function makeManager() {
    const fakeCtx = { client: {} as never, directory: '/tmp' } as never;
    const { PacketTaskManager } =
      require('./index') as typeof import('./index');
    return new PacketTaskManager(fakeCtx);
  }

  test('isTrackingStarted returns false before markTrackingStarted', () => {
    const mgr = makeManager();
    expect(mgr.isTrackingStarted('sess_A')).toBe(false);
  });

  test('isTrackingStarted returns true after markTrackingStarted', () => {
    const mgr = makeManager();
    mgr.markTrackingStarted('sess_A');
    expect(mgr.isTrackingStarted('sess_A')).toBe(true);
  });

  test('tracking state is per-session (different sessions independent)', () => {
    const mgr = makeManager();
    mgr.markTrackingStarted('sess_A');
    expect(mgr.isTrackingStarted('sess_A')).toBe(true);
    expect(mgr.isTrackingStarted('sess_B')).toBe(false);
  });

  test('clearTrackingForSession removes only the given session', () => {
    const mgr = makeManager();
    mgr.markTrackingStarted('sess_A');
    mgr.markTrackingStarted('sess_B');
    mgr.clearTrackingForSession('sess_A');
    expect(mgr.isTrackingStarted('sess_A')).toBe(false);
    expect(mgr.isTrackingStarted('sess_B')).toBe(true);
  });

  test('cleanup clears all tracking state', () => {
    const mgr = makeManager();
    mgr.markTrackingStarted('sess_A');
    mgr.markTrackingStarted('sess_B');
    mgr.cleanup();
    expect(mgr.isTrackingStarted('sess_A')).toBe(false);
    expect(mgr.isTrackingStarted('sess_B')).toBe(false);
  });
});

describe('PacketTaskManager — cancel', () => {
  function makeManager() {
    const fakeCtx = { client: {} as never, directory: '/tmp' } as never;
    const { PacketTaskManager } =
      require('./index') as typeof import('./index');
    return new PacketTaskManager(fakeCtx);
  }

  test('cancel with unknown id returns 0', () => {
    const mgr = makeManager();
    expect(mgr.cancel('pkt_notexist')).toBe(0);
  });

  test('cancel with no arg on empty manager returns 0', () => {
    const mgr = makeManager();
    expect(mgr.cancel()).toBe(0);
  });

  test('getResult returns null for unknown task', () => {
    const mgr = makeManager();
    expect(mgr.getResult('pkt_notexist')).toBeNull();
  });
});
