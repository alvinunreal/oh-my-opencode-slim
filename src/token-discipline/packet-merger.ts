import type { AgentRole } from './config';
import { MERGE_CONSTRAINTS, ROLE_PRIORITY } from './config';
import type { DelegateResult, MergedPacket } from './types';

export function mergePackets(results: DelegateResult[]): MergedPacket {
  if (results.length === 0) {
    return {
      tldr: [],
      evidence: [],
      recommendation: '',
      next_actions: [],
      sources: [],
    };
  }

  if (results.length === 1) {
    return singlePacketToMerged(results[0]);
  }

  const sorted = [...results].sort(
    (a, b) => ROLE_PRIORITY[b.role] - ROLE_PRIORITY[a.role],
  );

  const allTldr = collectAndDedupe(
    results,
    (r) => r.packet.tldr,
    MERGE_CONSTRAINTS.maxTldrBullets,
  );

  const allEvidence = collectAndDedupe(
    results,
    (r) => r.packet.evidence,
    MERGE_CONSTRAINTS.maxEvidence,
  );

  const allActions = collectAndDedupe(
    results,
    (r) => r.packet.next_actions,
    MERGE_CONSTRAINTS.maxActions,
  );

  const topResult = sorted[0];
  const conflicts = detectConflicts(results);

  return {
    tldr: allTldr,
    evidence: allEvidence,
    recommendation: topResult.packet.recommendation,
    next_actions: allActions,
    conflicts: conflicts.length > 0 ? conflicts : undefined,
    sources: results.map((r) => ({ role: r.role, threadId: r.threadId })),
  };
}

function singlePacketToMerged(result: DelegateResult): MergedPacket {
  return {
    tldr: result.packet.tldr,
    evidence: result.packet.evidence,
    recommendation: result.packet.recommendation,
    next_actions: result.packet.next_actions,
    sources: [{ role: result.role, threadId: result.threadId }],
  };
}

function collectAndDedupe(
  results: DelegateResult[],
  extractor: (r: DelegateResult) => string[],
  maxItems: number,
): string[] {
  const seen = new Set<string>();
  const items: string[] = [];

  const sorted = [...results].sort(
    (a, b) => ROLE_PRIORITY[b.role] - ROLE_PRIORITY[a.role],
  );

  for (const result of sorted) {
    const extracted = extractor(result);
    for (const item of extracted) {
      const normalized = item.toLowerCase().trim();
      if (!seen.has(normalized) && items.length < maxItems) {
        seen.add(normalized);
        items.push(`[${result.role}] ${item}`);
      }
    }
  }

  return items;
}

function detectConflicts(results: DelegateResult[]): string[] {
  const conflicts: string[] = [];
  const recommendations = new Map<string, AgentRole[]>();

  for (const result of results) {
    const key = result.packet.recommendation.toLowerCase().trim();
    const existing = recommendations.get(key) ?? [];
    existing.push(result.role);
    recommendations.set(key, existing);
  }

  if (recommendations.size > 1) {
    const entries = Array.from(recommendations.entries());
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [rec1, roles1] = entries[i];
        const [rec2, roles2] = entries[j];
        conflicts.push(
          `${roles1.join(',')} says "${rec1.slice(0, 50)}" vs ${roles2.join(',')} says "${rec2.slice(0, 50)}"`,
        );
      }
    }
  }

  return conflicts;
}
