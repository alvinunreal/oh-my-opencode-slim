import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRole } from './config';
import { extractPacketFromResponse } from './context-cleaner';
import type { PacketV1, ThreadArchive, ThreadMetadata } from './types';

const ARCHIVE_DIR = join(import.meta.dir, 'thread-archive');

function generateThreadId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function ensureArchiveDir(): Promise<void> {
  try {
    await mkdir(ARCHIVE_DIR, { recursive: true });
  } catch {
    // Directory exists
  }
}

export async function createThreadArchive(
  role: AgentRole,
  task: string,
  model: string,
): Promise<string> {
  await ensureArchiveDir();

  const threadId = generateThreadId();
  const threadDir = join(ARCHIVE_DIR, threadId);

  await mkdir(threadDir, { recursive: true });
  await mkdir(join(threadDir, 'outputs'), { recursive: true });

  const metadata: ThreadMetadata = {
    id: threadId,
    role,
    task,
    timestamp: Date.now(),
    tokens: 0,
    model,
  };

  await writeFile(
    join(threadDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
  );

  await writeFile(join(threadDir, 'conversation.json'), '[]');

  return threadId;
}

export async function storeConversation(
  threadId: string,
  conversation: unknown[],
): Promise<void> {
  const threadDir = join(ARCHIVE_DIR, threadId);
  await writeFile(
    join(threadDir, 'conversation.json'),
    JSON.stringify(conversation, null, 2),
  );
}

export async function storePacket(
  threadId: string,
  packet: PacketV1,
): Promise<void> {
  const threadDir = join(ARCHIVE_DIR, threadId);

  const yamlLines: string[] = ['tldr:'];
  for (const bullet of packet.tldr) {
    yamlLines.push(`  - ${bullet}`);
  }

  yamlLines.push('evidence:');
  for (const bullet of packet.evidence) {
    yamlLines.push(`  - ${bullet}`);
  }

  if (packet.options?.length) {
    yamlLines.push('options:');
    for (const bullet of packet.options) {
      yamlLines.push(`  - ${bullet}`);
    }
  }

  yamlLines.push(`recommendation: ${packet.recommendation}`);

  yamlLines.push('next_actions:');
  for (const bullet of packet.next_actions) {
    yamlLines.push(`  - ${bullet}`);
  }

  if (packet.raw_pointers?.length) {
    yamlLines.push('raw_pointers:');
    for (const bullet of packet.raw_pointers) {
      yamlLines.push(`  - ${bullet}`);
    }
  }

  await writeFile(join(threadDir, 'final_packet.yaml'), yamlLines.join('\n'));
}

export async function updateThreadTokens(
  threadId: string,
  tokens: number,
): Promise<void> {
  const threadDir = join(ARCHIVE_DIR, threadId);
  const metadataPath = join(threadDir, 'metadata.json');

  try {
    const content = await readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(content) as ThreadMetadata;
    metadata.tokens = tokens;
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  } catch {
    // Thread doesn't exist
  }
}

export async function finalizeThread(
  threadId: string,
  conversation: unknown[],
  packet: PacketV1,
  tokenCount: number,
): Promise<void> {
  await storeConversation(threadId, conversation);
  await storePacket(threadId, packet);
  await updateThreadTokens(threadId, tokenCount);
}

export async function loadThreadArchive(
  threadId: string,
): Promise<ThreadArchive | null> {
  const threadDir = join(ARCHIVE_DIR, threadId);

  try {
    const metadataContent = await readFile(
      join(threadDir, 'metadata.json'),
      'utf-8',
    );
    const conversationContent = await readFile(
      join(threadDir, 'conversation.json'),
      'utf-8',
    );
    const packetContent = await readFile(
      join(threadDir, 'final_packet.yaml'),
      'utf-8',
    );

    const metadata = JSON.parse(metadataContent) as ThreadMetadata;
    const conversation = JSON.parse(conversationContent) as unknown[];

    const outputs = new Map<string, string>();
    const outputsDir = join(threadDir, 'outputs');
    try {
      const files = await readdir(outputsDir);
      for (const file of files) {
        if (file.endsWith('.raw')) {
          const content = await readFile(join(outputsDir, file), 'utf-8');
          outputs.set(file.replace('.raw', ''), content);
        }
      }
    } catch {
      // No outputs directory
    }

    const packet = extractPacketFromResponse(packetContent) ?? {
      tldr: [],
      evidence: [],
      recommendation: '',
      next_actions: [],
    };

    return { metadata, conversation, outputs, packet };
  } catch {
    return null;
  }
}
