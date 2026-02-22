import { z } from 'zod';
import type { AgentRole } from './config';

export const PacketV1Schema = z.object({
  tldr: z.array(z.string()).min(1).max(3),
  evidence: z.array(z.string()).min(1).max(5),
  options: z.array(z.string()).max(3).optional(),
  recommendation: z.string(),
  next_actions: z.array(z.string()).min(1).max(5),
  raw_pointers: z.array(z.string()).optional(),
});

export type PacketV1 = z.infer<typeof PacketV1Schema>;

export interface ValidatedPacket extends PacketV1 {
  _validated: true;
  charCount: number;
}

export interface ThreadMetadata {
  id: string;
  role: AgentRole;
  task: string;
  timestamp: number;
  tokens: number;
  model: string;
}

export interface ThreadArchive {
  metadata: ThreadMetadata;
  conversation: unknown[];
  outputs: Map<string, string>;
  packet: PacketV1;
}

export interface DelegateResult {
  packet: ValidatedPacket;
  threadId: string;
  role: AgentRole;
  modelUsed: string;
  tokenCount: number;
}

export interface MergedPacket {
  tldr: string[];
  evidence: string[];
  recommendation: string;
  next_actions: string[];
  conflicts?: string[];
  sources: Array<{ role: AgentRole; threadId: string }>;
}

export interface ToolCapResult {
  capped: boolean;
  output: string;
  pointer: string;
  originalSize: number;
  cappedSize: number;
}

export type PointerType = 'thread' | 'cmd' | 'file';

export interface ParsedPointer {
  type: PointerType;
  id: string;
  detail?: string;
}

export interface ContextLeakError extends Error {
  type: 'CONTEXT_LEAK';
  threadId: string;
  violations: string[];
}

export function createContextLeakError(
  threadId: string,
  violations: string[],
): ContextLeakError {
  const error = new Error(
    `Context leak detected in thread ${threadId}: ${violations.join(', ')}`,
  ) as ContextLeakError;
  error.type = 'CONTEXT_LEAK';
  error.threadId = threadId;
  error.violations = violations;
  return error;
}
