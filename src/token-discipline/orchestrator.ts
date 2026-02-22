import type { AgentRole } from './config';
import { DEFAULT_MODEL_ASSIGNMENTS, getModelForRole } from './config';
import {
  extractPacketFromResponse,
  formatPacketForContext,
} from './context-cleaner';
import { recordDelegateResult, recordPacketRejection } from './metrics';
import type { PointerResolver } from './pointer-resolver';
import { createThreadArchive, finalizeThread } from './thread-manager';
import type {
  DelegateResult,
  MergedPacket,
  PacketV1,
  ValidatedPacket,
} from './types';
import { validatePacketV1 } from './validator';

export interface OrchestratorContext {
  userRequest: string;
  packets: ValidatedPacket[];
  mergedPacket: MergedPacket | null;
  taskPlan: null;
  pointerResolver: PointerResolver;
}

export function buildPacketContext(packets: ValidatedPacket[]): string {
  const sections: string[] = [];

  sections.push('# Delegate Packets\n');
  sections.push(
    'The following packets contain summarized results from specialist delegates.',
  );
  sections.push(
    'Each packet is ≤2,500 chars and contains only high-level insights.\n',
  );

  for (let i = 0; i < packets.length; i++) {
    const packet = packets[i];
    sections.push(`## Packet ${i + 1}\n`);
    sections.push(formatPacketForContext(packet));
    sections.push('');
  }

  return sections.join('\n');
}

export async function processDelegateOutput(
  context: OrchestratorContext,
  role: AgentRole,
  delegateResponse: string,
  conversation: unknown[],
  tokenCount: number,
): Promise<DelegateResult | null> {
  const model = await getModelForRole(role).catch(
    () => DEFAULT_MODEL_ASSIGNMENTS[role],
  );

  const threadId = await createThreadArchive(role, context.userRequest, model);

  let packet: PacketV1;
  try {
    packet = extractPacketFromResponse(delegateResponse) ?? {
      tldr: ['Delegate completed'],
      evidence: [`thread:${threadId}#context`],
      recommendation: 'Review delegate output',
      next_actions: ['Check archived thread for details'],
    };

    const validated = validatePacketV1(packet);

    await finalizeThread(threadId, conversation, validated, tokenCount);

    const result: DelegateResult = {
      packet: validated,
      threadId,
      role,
      modelUsed: model,
      tokenCount,
    };

    recordDelegateResult(result);
    context.packets.push(validated);

    return result;
  } catch (error) {
    recordPacketRejection();

    if (error instanceof Error && error.message.includes('exceeds max chars')) {
      packet = {
        tldr: ['Packet size limit exceeded - output archived'],
        evidence: [`thread:${threadId}#context`],
        recommendation: 'Review archived thread for full details',
        next_actions: ['Access thread archive for complete output'],
      };

      const validated = validatePacketV1(packet);
      await finalizeThread(threadId, conversation, validated, tokenCount);

      const result: DelegateResult = {
        packet: validated,
        threadId,
        role,
        modelUsed: model,
        tokenCount,
      };

      recordDelegateResult(result);
      context.packets.push(validated);

      return result;
    }

    throw error;
  }
}

export const PACKET_FORMAT_INSTRUCTIONS = `
When responding, provide a PACKET_V1 in YAML format:

\`\`\`yaml
tldr:
  - Key insight 1
  - Key insight 2
evidence:
  - file:path:line-range OR thread:id OR URL
  - Supporting evidence pointer
recommendation: Single clear recommendation
next_actions:
  - Actionable step 1
  - Actionable step 2
\`\`\`

Requirements:
- Total packet: ≤2,500 characters
- tldr: 1-3 bullets
- evidence: 1-5 bullets with pointers
- recommendation: 1 bullet
- next_actions: 1-5 bullets
- No raw tool outputs, diffs, or code blocks
- Use pointers (file:path:line, thread:id, cmd:id) for detailed references
`;
