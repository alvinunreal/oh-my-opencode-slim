import type { AgentRole } from './config';
import { DEFAULT_MODEL_ASSIGNMENTS, getModelForRole } from './config';
import {
  extractPacketFromResponse,
  formatPacketForContext,
} from './context-cleaner';
import { createThreadArchive, finalizeThread } from './thread-manager';
import type { DelegateResult, PacketV1, ValidatedPacket } from './types';
import { validatePacketV1 } from './validator';

export interface OrchestratorContext {
  userRequest: string;
  packets: ValidatedPacket[];
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
    const extracted = extractPacketFromResponse(delegateResponse);

    if (!extracted) {
      // No packet found in response — produce a fallback pointing to the thread
      packet = {
        tldr: ['Delegate completed without packet'],
        evidence: [
          threadId
            ? `thread:${threadId}#context`
            : 'Delegate output invalid - no thread archive available',
        ],
        options: ['[fallback: extraction error]'],
        recommendation: 'Review archived thread for full details',
        next_actions: [
          'Use resolve_pointer on the thread: evidence pointer, or delegate to @summarizer',
        ],
      };
    } else {
      packet = extracted;
    }

    const validated = validatePacketV1(packet);

    await finalizeThread(threadId, conversation, validated, tokenCount);

    const result: DelegateResult = {
      packet: validated,
      threadId,
      role,
      modelUsed: model,
      tokenCount,
    };

    context.packets.push(validated);

    return result;
  } catch (error) {
    // Any validation failure (size exceeded, forbidden content, schema error)
    // produces a graceful fallback packet pointing to the thread archive rather
    // than surfacing an exception that would mark the task as failed.
    if (error instanceof Error) {
      let fallbackReason: string;
      if (error.message.includes('exceeds max chars')) {
        fallbackReason = '[fallback: size limit exceeded]';
      } else if (error.message.includes('forbidden content')) {
        fallbackReason = '[fallback: forbidden content]';
      } else if (
        error.message.includes('validation') ||
        error.message.includes('parse')
      ) {
        fallbackReason = '[fallback: validation failed]';
      } else {
        fallbackReason = '[fallback: extraction error]';
      }

      const evidencePointer = threadId
        ? `thread:${threadId}#context`
        : 'Delegate output invalid - no thread archive available';

      packet = {
        tldr: ['Delegate output archived — packet could not be extracted'],
        evidence: [evidencePointer],
        options: [fallbackReason],
        recommendation: 'Review archived thread for full details',
        next_actions: [
          'Use resolve_pointer on the thread: evidence pointer for a quick peek',
          'Or delegate to @summarizer for full compression',
        ],
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
  - file:src/main.ts:42-80
  - thread:abc123#context
  - https://docs.example.com/api-reference
recommendation: Single clear recommendation using your own words
next_actions:
  - Actionable step 1
  - Actionable step 2
\`\`\`

Requirements:
- Total packet: ≤2,500 characters
- tldr: 1-3 bullets
- evidence: 1-5 bullets with source pointers
- recommendation: 1 bullet
- next_actions: 1-5 bullets
- No raw tool outputs, diffs, or code blocks

Evidence field accepts source pointers:
  ✓ Files:   file:src/main.ts:42-80
  ✓ Threads: thread:abc123#context
  ✓ URLs:    https://docs.anthropic.com/reference
  ✓ Cmds:    cmd:xyz789#line:50-100

Content fields (tldr, recommendation, next_actions) must use your own words:
  ✗ tldr: "See https://docs.example.com for details"
  ✓ tldr: "Solution uses middleware pattern for auth"
  ✗ recommendation: "Check https://github.com/..."
  ✓ recommendation: "Use NextAuth.js with App Router adapter"
`;
