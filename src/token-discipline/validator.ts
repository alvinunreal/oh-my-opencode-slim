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

// Patterns banned everywhere — code blocks, stack traces, build noise.
const UNIVERSAL_FORBIDDEN = [
  /```[\s\S]*?```/,
  /stderr:/i,
  /traceback:/i,
  /npm warn/i,
  /error:/i,
];

// Patterns banned in content fields (tldr, recommendation, next_actions) but
// NOT in evidence — evidence entries are source pointers and may include URLs.
const CONTENT_FORBIDDEN = [/https?:\/\/[^\s]+/i];

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

  // All text across every field — check universal patterns here.
  const allText = [
    ...packet.tldr,
    ...packet.evidence,
    packet.recommendation,
    ...packet.next_actions,
    ...(packet.options ?? []),
  ].join('\n');

  for (const pattern of UNIVERSAL_FORBIDDEN) {
    if (pattern.test(allText)) {
      violations.push(`Pattern ${pattern.source} found in packet`);
    }
  }

  // Content-only fields: URLs are forbidden (must be original synthesis).
  // Evidence is excluded — URLs there are legitimate source pointers.
  const contentOnlyText = [
    ...packet.tldr,
    packet.recommendation,
    ...packet.next_actions,
    ...(packet.options ?? []),
  ].join('\n');

  for (const pattern of CONTENT_FORBIDDEN) {
    if (pattern.test(contentOnlyText)) {
      violations.push(
        `Pattern ${pattern.source} found in content fields (tldr/recommendation/next_actions)`,
      );
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
    const allForbidden = [...UNIVERSAL_FORBIDDEN, ...CONTENT_FORBIDDEN];
    const hasLeakedOutput = allForbidden.some((pattern) =>
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
