/**
 * Isolation Tests — prove that the token-discipline architecture works end-to-end.
 *
 * These tests validate the requirements from the Token-Discipline Architecture spec:
 * - Tool output capping (airlock)
 * - Packet size enforcement (≤2,500 chars)
 * - Context7/WebSearch restricted to researcher role
 * - Orchestrator receives only packets, never raw outputs
 * - Model assignments read from omoslim.json
 * - Multi-delegate packet merging
 */
import { describe, expect, test } from 'bun:test';
import { capBytes, capLines, capToolOutput, stripNoise } from './airlock';
import {
  DEFAULT_MODEL_ASSIGNMENTS,
  getModelForRole,
  PACKET_CONSTRAINTS,
  TOOL_CAPS,
} from './config';
import {
  extractPacketFromResponse,
  formatPacketForContext,
} from './context-cleaner';
import {
  recordDelegateResult,
  recordPacketRejection,
  setTaskClassification,
  startTaskTracking,
} from './metrics';
import { DEFAULT_MODEL_CONFIG, ROLE_TO_AGENT } from './model-config';
import { buildPacketContext, PACKET_FORMAT_INSTRUCTIONS } from './orchestrator';
import { mergePackets } from './packet-merger';
import { PointerResolver } from './pointer-resolver';
import { classifyAndRoute } from './task-router';
import type { DelegateResult, PacketV1, ValidatedPacket } from './types';
import {
  assertNoRawContextLeak,
  detectForbiddenContent,
  validatePacketV1,
} from './validator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidPacket(overrides: Partial<PacketV1> = {}): PacketV1 {
  return {
    tldr: ['Key finding'],
    evidence: ['file:src/index.ts:42'],
    recommendation: 'Apply the fix',
    next_actions: ['Run tests', 'Deploy'],
    ...overrides,
  };
}

function makeDelegateResult(
  role: DelegateResult['role'],
  packetOverrides: Partial<PacketV1> = {},
): DelegateResult {
  return {
    packet: validatePacketV1(makeValidPacket(packetOverrides)),
    threadId: `thread_${Math.random().toString(36).slice(2, 8)}`,
    role,
    modelUsed: 'test-model',
    tokenCount: 500,
  };
}

// ---------------------------------------------------------------------------
// 1. Tool Output Capping (Airlock)
// ---------------------------------------------------------------------------

describe('airlock — tool output capping', () => {
  test('bash: 1000-line output is capped to 250 lines', () => {
    const thousandLines = Array.from(
      { length: 1000 },
      (_, i) => `line ${i + 1}`,
    ).join('\n');
    const output = capToolOutput('bash', thousandLines);

    const outputLines = output.split('\n').filter((l) => !l.startsWith('...'));
    // Capped output should have ≤250 content lines plus one truncation message
    expect(outputLines.length).toBeLessThanOrEqual(251);
    expect(output).toContain('truncated');
    expect(output).toContain('750 lines');
  });

  test('bash: output ≤250 lines is NOT capped', () => {
    const shortOutput = Array.from({ length: 100 }, (_, i) => `line ${i}`).join(
      '\n',
    );
    const output = capToolOutput('bash', shortOutput);
    expect(output).not.toContain('truncated');
  });

  test('git_diff: output over 400 lines is capped', () => {
    const bigDiff = Array.from({ length: 500 }, (_, i) => `+line ${i}`).join(
      '\n',
    );
    const capped = capLines(bigDiff, TOOL_CAPS.git_diff.maxLines);
    expect(capped).toContain('truncated');
    const lines = capped.split('\n').filter((l) => !l.startsWith('...'));
    expect(lines.length).toBeLessThanOrEqual(401);
  });

  test('git_diff: output ≤400 lines is NOT capped', () => {
    const smallDiff = Array.from({ length: 200 }, () => '+change').join('\n');
    const capped = capLines(smallDiff, TOOL_CAPS.git_diff.maxLines);
    expect(capped).not.toContain('truncated');
  });

  test('file_read: content over 12 KB is capped', () => {
    const bigFile = 'x'.repeat(15_000);
    const capped = capBytes(bigFile, TOOL_CAPS.file_read.maxBytes);
    expect(capped).toContain('truncated');
    expect(capped.length).toBeLessThanOrEqual(
      TOOL_CAPS.file_read.maxBytes + 100,
    );
  });

  test('web_fetch: content over 8 KB is capped', () => {
    const bigPage = 'a'.repeat(20_000);
    const capped = capBytes(bigPage, TOOL_CAPS.web_fetch.maxBytes);
    expect(capped).toContain('truncated');
    expect(capped.length).toBeLessThanOrEqual(
      TOOL_CAPS.web_fetch.maxBytes + 100,
    );
  });

  test('context7: doc content over 16 KB is capped', () => {
    const bigDoc = 'b'.repeat(40_000);
    const capped = capBytes(bigDoc, TOOL_CAPS.context7.maxBytes);
    expect(capped).toContain('truncated');
    expect(capped.length).toBeLessThanOrEqual(
      TOOL_CAPS.context7.maxBytes + 100,
    );
  });

  test('capToolOutput caps and strips noise', () => {
    const output =
      'npm WARN deprecated pkg\n' +
      Array.from({ length: 300 }, () => 'line').join('\n');
    const result = capToolOutput('bash', output);
    expect(result).toContain('truncated');
    expect(result).not.toContain('npm WARN');
  });

  test('noise stripping removes npm warnings before capping', () => {
    const noisy = [
      'npm WARN deprecated old-package',
      'npm notice update available',
      'yarn warning some yarn warning',
      'actual build output line 1',
      'actual build output line 2',
    ].join('\n');
    const cleaned = stripNoise(noisy);
    expect(cleaned).not.toContain('npm WARN');
    expect(cleaned).not.toContain('npm notice');
    expect(cleaned).not.toContain('yarn warning');
    expect(cleaned).toContain('actual build output');
  });
});

// ---------------------------------------------------------------------------
// 2. Packet Validation
// ---------------------------------------------------------------------------

describe('packet validation — size and schema enforcement', () => {
  test('validates a conforming packet', () => {
    const packet = makeValidPacket();
    const validated = validatePacketV1(packet);
    expect(validated._validated).toBe(true);
    expect(validated.charCount).toBeLessThanOrEqual(
      PACKET_CONSTRAINTS.maxChars,
    );
  });

  test('rejects packet exceeding 2500 chars', () => {
    const bigPacket = makeValidPacket({ tldr: ['x'.repeat(3000)] });
    expect(() => validatePacketV1(bigPacket)).toThrow(/exceeds max chars/);
  });

  test('rejects packet with >3 tldr bullets', () => {
    const packet = makeValidPacket({ tldr: ['1', '2', '3', '4'] });
    expect(() => validatePacketV1(packet)).toThrow();
  });

  test('rejects packet with >5 evidence bullets', () => {
    const packet = makeValidPacket({
      evidence: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'],
    });
    expect(() => validatePacketV1(packet)).toThrow();
  });

  test('rejects packet with >5 next_actions', () => {
    const packet = makeValidPacket({
      next_actions: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'],
    });
    expect(() => validatePacketV1(packet)).toThrow();
  });

  test('forbidden content detection — URL in evidence is NOT flagged (evidence pointers are allowed)', () => {
    const packet = makeValidPacket({
      evidence: ['https://example.com/some-api-doc'],
    });
    const violations = detectForbiddenContent(packet);
    // URLs are valid source pointers in evidence — must not produce a violation
    expect(violations.filter((v) => v.includes('https'))).toHaveLength(0);
  });

  test('forbidden content detection — URL in tldr IS flagged', () => {
    const packet = makeValidPacket({
      tldr: ['See https://example.com/docs for details'],
    });
    const violations = detectForbiddenContent(packet);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('https'))).toBe(true);
  });

  test('forbidden content detection — URL in recommendation IS flagged', () => {
    const packet = makeValidPacket({
      recommendation: 'Read https://example.com/guide and follow it',
    });
    const violations = detectForbiddenContent(packet);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes('https'))).toBe(true);
  });

  test('forbidden content detection — code blocks flagged', () => {
    const packet = makeValidPacket({
      tldr: ['```js\nconsole.log("hi")\n```'],
    });
    const violations = detectForbiddenContent(packet);
    expect(violations.length).toBeGreaterThan(0);
  });

  test('forbidden content detection is not stateful (regex bug check)', () => {
    // Run detectForbiddenContent twice on the SAME packet to prove the regex
    // fix works — stateful /g regexes would return empty on the second call.
    // Use a URL in tldr (content field) which IS forbidden, so violations > 0.
    const packet = makeValidPacket({
      tldr: ['See https://example.com/api for details'],
    });
    const first = detectForbiddenContent(packet);
    const second = detectForbiddenContent(packet);
    expect(first.length).toBe(second.length);
    expect(second.length).toBeGreaterThan(0);
  });

  test('assertNoRawContextLeak accepts clean packet', () => {
    const validated = validatePacketV1(makeValidPacket());
    // Should not throw for a clean packet
    expect(() =>
      assertNoRawContextLeak(validated, 'thread_test', 'short response'),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Thread Isolation — Orchestrator receives only packets
// ---------------------------------------------------------------------------

describe('thread isolation — orchestrator context', () => {
  test('buildPacketContext produces compact output ≤ packet * count', () => {
    const packets: ValidatedPacket[] = [
      validatePacketV1(makeValidPacket({ tldr: ['Finding A'] })),
      validatePacketV1(
        makeValidPacket({ tldr: ['Finding B'], evidence: ['thread:abc'] }),
      ),
    ];
    const ctx = buildPacketContext(packets);

    // Must not contain raw diff output or noise
    expect(ctx).not.toContain('diff --git');
    expect(ctx).not.toContain('npm WARN');

    // Context should be compact — not exponentially large
    expect(ctx.length).toBeLessThan(10_000);
  });

  test('buildPacketContext contains tldr and recommendation', () => {
    const packets = [
      validatePacketV1(
        makeValidPacket({
          tldr: ['Important insight'],
          recommendation: 'Do the thing',
        }),
      ),
    ];
    const ctx = buildPacketContext(packets);
    expect(ctx).toContain('Important insight');
    expect(ctx).toContain('Do the thing');
  });

  test('formatPacketForContext includes all required sections', () => {
    const validated = validatePacketV1(makeValidPacket());
    const formatted = formatPacketForContext(validated);
    expect(formatted).toContain('TLDR');
    expect(formatted).toContain('Evidence');
    expect(formatted).toContain('Recommendation');
    expect(formatted).toContain('Next Actions');
  });

  test('multi-delegate flow: orchestrator context stays under 18 KB', () => {
    // Simulate 5 delegate packets
    const results = [
      makeDelegateResult('RESEARCHER'),
      makeDelegateResult('REPO_SCOUT'),
      makeDelegateResult('IMPLEMENTER'),
      makeDelegateResult('VALIDATOR'),
      makeDelegateResult('DESIGNER'),
    ];

    const packets = results.map((r) => r.packet);
    const ctx = buildPacketContext(packets);

    // 18 KB limit for orchestrator context
    expect(ctx.length).toBeLessThan(18_432);
  });

  test('PACKET_FORMAT_INSTRUCTIONS is present and not empty', () => {
    expect(PACKET_FORMAT_INSTRUCTIONS).toBeTruthy();
    expect(PACKET_FORMAT_INSTRUCTIONS).toContain('PACKET_V1');
    expect(PACKET_FORMAT_INSTRUCTIONS).toContain('tldr');
    expect(PACKET_FORMAT_INSTRUCTIONS).toContain('evidence');
  });
});

// ---------------------------------------------------------------------------
// 4. Packet Merging
// ---------------------------------------------------------------------------

describe('packet merger — multi-delegate results', () => {
  test('merges two packets deduplicating overlapping tldr', () => {
    const results = [
      makeDelegateResult('RESEARCHER', { tldr: ['Finding from research'] }),
      makeDelegateResult('IMPLEMENTER', { tldr: ['Finding from research'] }), // same
    ];
    const merged = mergePackets(results);
    // Deduplicated — only one copy
    expect(
      merged.tldr.filter((b) =>
        b.toLowerCase().includes('finding from research'),
      ),
    ).toHaveLength(1);
  });

  test('uses highest-priority role recommendation', () => {
    const results = [
      makeDelegateResult('RESEARCHER', { recommendation: 'Research says A' }),
      makeDelegateResult('VALIDATOR', { recommendation: 'Validator says B' }),
      makeDelegateResult('IMPLEMENTER', {
        recommendation: 'Implementer says C',
      }),
    ];
    const merged = mergePackets(results);
    // VALIDATOR > IMPLEMENTER > RESEARCHER
    expect(merged.recommendation).toBe('Validator says B');
  });

  test('detects conflicting recommendations', () => {
    const results = [
      makeDelegateResult('RESEARCHER', { recommendation: 'Use approach X' }),
      makeDelegateResult('IMPLEMENTER', { recommendation: 'Use approach Y' }),
    ];
    const merged = mergePackets(results);
    expect(merged.conflicts).toBeDefined();
    expect(merged.conflicts?.length).toBeGreaterThan(0);
  });

  test('sources array tracks all contributing roles', () => {
    const results = [
      makeDelegateResult('RESEARCHER'),
      makeDelegateResult('IMPLEMENTER'),
    ];
    const merged = mergePackets(results);
    expect(merged.sources).toHaveLength(2);
    const roles = merged.sources.map((s) => s.role);
    expect(roles).toContain('RESEARCHER');
    expect(roles).toContain('IMPLEMENTER');
  });
});

// ---------------------------------------------------------------------------
// 5. Task Routing
// ---------------------------------------------------------------------------

describe('task router — smart classification', () => {
  test('research keywords → RESEARCHER delegate', () => {
    const plan = classifyAndRoute('Research how to use the Bun test runner');
    expect(plan.delegates.some((d) => d.role === 'RESEARCHER')).toBe(true);
  });

  test('codebase keywords → REPO_SCOUT delegate', () => {
    const plan = classifyAndRoute(
      'Find all files matching the *.test.ts pattern',
    );
    expect(plan.delegates.some((d) => d.role === 'REPO_SCOUT')).toBe(true);
  });

  test('validation keywords → VALIDATOR delegate', () => {
    const plan = classifyAndRoute('Implement auth flow and test it');
    expect(plan.delegates.some((d) => d.role === 'VALIDATOR')).toBe(true);
  });

  test('non-trivial task includes IMPLEMENTER', () => {
    const plan = classifyAndRoute('Add a new endpoint for user management');
    expect(plan.delegates.some((d) => d.role === 'IMPLEMENTER')).toBe(true);
  });

  test('delegates array is never empty', () => {
    const plan = classifyAndRoute('Do something vague');
    expect(plan.delegates.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Model Config — omoslim.json assignments
// ---------------------------------------------------------------------------

describe('model config — defaults', () => {
  test('DEFAULT_MODEL_CONFIG has all 7 required role assignments', () => {
    const requiredRoles = [
      'orchestrator',
      'researcher',
      'repo_scout',
      'implementer',
      'validator',
      'designer',
      'summarizer',
    ];
    for (const role of requiredRoles) {
      expect(DEFAULT_MODEL_CONFIG.model_assignments[role]).toBeDefined();
      expect(DEFAULT_MODEL_CONFIG.model_assignments[role].model).toBeTruthy();
    }
  });

  test('DEFAULT_MODEL_ASSIGNMENTS covers all AgentRole values', () => {
    const roles: Array<keyof typeof DEFAULT_MODEL_ASSIGNMENTS> = [
      'ORCHESTRATOR',
      'RESEARCHER',
      'REPO_SCOUT',
      'IMPLEMENTER',
      'VALIDATOR',
      'DESIGNER',
      'SUMMARIZER',
    ];
    for (const role of roles) {
      expect(DEFAULT_MODEL_ASSIGNMENTS[role]).toBeTruthy();
    }
  });

  test('ROLE_TO_AGENT maps all 7 roles to agent names', () => {
    const roles = [
      'ORCHESTRATOR',
      'RESEARCHER',
      'REPO_SCOUT',
      'IMPLEMENTER',
      'VALIDATOR',
      'DESIGNER',
      'SUMMARIZER',
    ];
    for (const role of roles) {
      expect(ROLE_TO_AGENT[role]).toBeTruthy();
    }
  });

  test('getModelForRole returns default model', async () => {
    const model = await getModelForRole('ORCHESTRATOR');
    expect(model).toBeTruthy();
    expect(typeof model).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 7. Context7 / WebSearch — librarian-only restriction
// ---------------------------------------------------------------------------

describe('MCP access restriction — researcher/librarian only', () => {
  test('DEFAULT_AGENT_MCPS gives librarian context7 and websearch', async () => {
    // Dynamically import to avoid circular deps in test context
    const { DEFAULT_AGENT_MCPS } = await import('../config/agent-mcps');
    expect(DEFAULT_AGENT_MCPS.librarian).toContain('context7');
    expect(DEFAULT_AGENT_MCPS.librarian).toContain('websearch');
  });

  test('DEFAULT_AGENT_MCPS gives orchestrator no MCPs by default', async () => {
    const { DEFAULT_AGENT_MCPS } = await import('../config/agent-mcps');
    expect(DEFAULT_AGENT_MCPS.orchestrator).toHaveLength(0);
  });

  test('DEFAULT_AGENT_MCPS gives explorer no MCPs', async () => {
    const { DEFAULT_AGENT_MCPS } = await import('../config/agent-mcps');
    expect(DEFAULT_AGENT_MCPS.explorer).toHaveLength(0);
  });

  test('DEFAULT_AGENT_MCPS gives fixer no MCPs', async () => {
    const { DEFAULT_AGENT_MCPS } = await import('../config/agent-mcps');
    expect(DEFAULT_AGENT_MCPS.fixer).toHaveLength(0);
  });

  test('DEFAULT_AGENT_MCPS gives oracle no MCPs', async () => {
    const { DEFAULT_AGENT_MCPS } = await import('../config/agent-mcps');
    expect(DEFAULT_AGENT_MCPS.oracle).toHaveLength(0);
  });

  test('getAgentMcpList respects the default for librarian', async () => {
    const { getAgentMcpList } = await import('../config/agent-mcps');
    const mcps = getAgentMcpList('librarian');
    expect(mcps).toContain('context7');
    expect(mcps).toContain('websearch');
  });

  test('getAgentMcpList returns empty for non-researcher agents', async () => {
    const { getAgentMcpList } = await import('../config/agent-mcps');
    for (const agent of [
      'orchestrator',
      'explorer',
      'fixer',
      'oracle',
      'designer',
    ]) {
      const mcps = getAgentMcpList(agent);
      expect(mcps).not.toContain('context7');
      expect(mcps).not.toContain('websearch');
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Pointer Resolution
// ---------------------------------------------------------------------------

describe('pointer resolver — on-demand retrieval', () => {
  test('respects max resolutions quota', () => {
    const resolver = new PointerResolver(3);
    expect(resolver.canResolve()).toBe(true);
    expect(resolver.remaining()).toBe(3);
  });

  test('reset restores quota', () => {
    const resolver = new PointerResolver(2);
    resolver.reset();
    expect(resolver.remaining()).toBe(2);
  });

  test('invalid pointer format returns error string', async () => {
    const resolver = new PointerResolver(3);
    const result = await resolver.resolve('not-a-valid-pointer');
    expect(result).toContain('Invalid pointer format');
  });

  test('valid file: pointer for nonexistent file returns not-found message', async () => {
    const resolver = new PointerResolver(3);
    const result = await resolver.resolve('file:/nonexistent/file.ts:1-5');
    expect(result).toContain('not found');
  });

  test('valid thread: pointer for nonexistent thread returns not-found message', async () => {
    const resolver = new PointerResolver(3);
    const result = await resolver.resolve('thread:nonexistent_thread_id');
    expect(result).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// 9. Packet Extraction from Delegate Response
// ---------------------------------------------------------------------------

describe('context cleaner — packet extraction', () => {
  test('extracts packet from yaml code block', () => {
    const response = `
I analyzed the codebase and found several issues.

\`\`\`yaml
tldr:
  - Found 3 broken imports
  - Tests are failing in CI
evidence:
  - file:src/index.ts:42
  - file:src/utils.ts:15
recommendation: Fix imports before deploying
next_actions:
  - Update import paths
  - Run full test suite
\`\`\`

Let me know if you need more details.
    `;

    const packet = extractPacketFromResponse(response);
    expect(packet).not.toBeNull();
    expect(packet?.tldr).toHaveLength(2);
    expect(packet?.evidence).toHaveLength(2);
    expect(packet?.recommendation).toBe('Fix imports before deploying');
    expect(packet?.next_actions).toHaveLength(2);
  });

  test('extracts packet from packet code block', () => {
    const response = `
Done with analysis.

\`\`\`packet
tldr:
  - Key insight
evidence:
  - thread:abc123
recommendation: Do the thing
next_actions:
  - Next step
\`\`\`
    `;

    const packet = extractPacketFromResponse(response);
    expect(packet).not.toBeNull();
    expect(packet?.tldr[0]).toBe('Key insight');
  });

  test('returns null for response with no packet block', () => {
    const response = 'Just a plain text response without any packet.';
    const packet = extractPacketFromResponse(response);
    expect(packet).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10. Metrics Tracking
// ---------------------------------------------------------------------------

describe('metrics — token tracking and observability', () => {
  test('startTaskTracking and recordDelegateResult do not throw', () => {
    startTaskTracking('Test task');
    const result = makeDelegateResult('IMPLEMENTER');
    expect(() => recordDelegateResult(result)).not.toThrow();
  });

  test('recordPacketRejection does not throw', () => {
    startTaskTracking('Test task 2');
    expect(() => recordPacketRejection()).not.toThrow();
  });

  test('setTaskClassification does not throw', () => {
    startTaskTracking('Test task 3');
    expect(() => setTaskClassification(true)).not.toThrow();
  });
});
