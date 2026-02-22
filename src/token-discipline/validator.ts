import { PACKET_CONSTRAINTS } from './config';
import {
  createContextLeakError,
  type PacketV1,
  PacketV1Schema,
  type ValidatedPacket,
} from './types';

// Non-global regexes: .test() on a global regex advances lastIndex, causing
// every second call to return false even when a match exists. We only need
// presence detection, so no /g flag is required.
const FORBIDDEN_PATTERNS = [
  /```[\s\S]*?```/,
  /https?:\/\/[^\s]+/i,
  /stderr:/i,
  /traceback:/i,
  /npm warn/i,
  /error:/i,
];

export function validatePacketV1(packet: unknown): ValidatedPacket {
  const parsed = PacketV1Schema.parse(packet);
  const serialized = JSON.stringify(parsed);

  if (serialized.length > PACKET_CONSTRAINTS.maxChars) {
    throw new Error(
      `Packet exceeds max chars: ${serialized.length} > ${PACKET_CONSTRAINTS.maxChars}`,
    );
  }

  const violations = detectForbiddenContent(parsed);
  if (violations.length > 0) {
    throw new Error(
      `Packet contains forbidden content: ${violations.join(', ')}`,
    );
  }

  return {
    ...parsed,
    _validated: true,
    charCount: serialized.length,
  };
}

export function detectForbiddenContent(packet: PacketV1): string[] {
  const violations: string[] = [];
  const allText = [
    ...packet.tldr,
    ...packet.evidence,
    packet.recommendation,
    ...packet.next_actions,
    ...(packet.options ?? []),
  ].join('\n');

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(allText)) {
      violations.push(`Pattern ${pattern.source} found in packet`);
    }
  }

  return violations;
}

export function assertNoRawContextLeak(
  packet: ValidatedPacket,
  threadId: string,
  rawDelegateResponse: string,
): void {
  const violations: string[] = [];

  const serialized = JSON.stringify(packet);
  if (serialized.length > PACKET_CONSTRAINTS.maxChars + 500) {
    violations.push(
      `Size violation: ${serialized.length} chars (limit: ${PACKET_CONSTRAINTS.maxChars})`,
    );
  }

  if (rawDelegateResponse.length > 10_000) {
    const hasLeakedOutput = FORBIDDEN_PATTERNS.some((pattern) =>
      pattern.test(serialized),
    );
    if (hasLeakedOutput) {
      violations.push('Raw tool output detected in packet');
    }
  }

  if (violations.length > 0) {
    throw createContextLeakError(threadId, violations);
  }
}

export function autoSummarizeToPacket(
  delegateResponse: string,
  role: string,
): PacketV1 {
  const lines = delegateResponse.split('\n').filter((l) => l.trim());

  const tldr: string[] = [];
  const evidence: string[] = [];
  const next_actions: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (tldr.length < 3) {
        tldr.push(trimmed.slice(2));
      } else if (evidence.length < 5) {
        evidence.push(trimmed.slice(2));
      }
    }
  }

  if (tldr.length === 0 && lines.length > 0) {
    tldr.push(lines[0].trim().slice(0, 200));
  }

  if (evidence.length === 0) {
    evidence.push(`thread:${role}#context`);
  }

  if (next_actions.length === 0) {
    next_actions.push('Review delegate output for actionable items');
  }

  return {
    tldr,
    evidence,
    recommendation: tldr[0] ?? 'Review delegate output',
    next_actions,
  };
}
