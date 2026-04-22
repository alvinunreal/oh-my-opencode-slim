/**
 * Checkpoint tools - exposed to agents for self-checkpointing.
 */

import type { PluginInput } from '@opencode-ai/plugin';
import type { CheckpointManager } from './manager';

export interface CheckpointTools {
  checkpoint: (args: {
    name: string;
    description?: string;
  }) => Promise<{ output: string; metadata?: Record<string, unknown> }>;
  rollback: (args: {
    name: string;
  }) => Promise<{ output: string; metadata?: Record<string, unknown> }>;
}

export function createCheckpointTools(
  ctx: PluginInput,
  manager: CheckpointManager,
  getSessionID: () => string | undefined,
): CheckpointTools {
  return {
    async checkpoint(args) {
      const sessionID = getSessionID();
      if (!sessionID) {
        return {
          output: 'Error: No active session to checkpoint.',
          metadata: { error: 'no_session' },
        };
      }

      if (!args.name || args.name.trim() === '') {
        return {
          output: 'Error: Checkpoint name is required.',
          metadata: { error: 'missing_name' },
        };
      }

      const result = await manager.saveCheckpoint(
        sessionID,
        args.name.trim(),
        args.description,
      );

      if (result.success && result.checkpoint) {
        return {
          output: `Checkpoint "${args.name}" saved. You can rollback to this state later if needed.`,
          metadata: {
            checkpointId: result.checkpoint.id,
            anchorMessageID: result.checkpoint.anchorMessageID,
            createdAt: result.checkpoint.createdAt,
          },
        };
      }

      return {
        output: `Failed to save checkpoint: ${result.error}`,
        metadata: { error: result.error },
      };
    },

    async rollback(args) {
      const sessionID = getSessionID();
      if (!sessionID) {
        return {
          output: 'Error: No active session to rollback.',
          metadata: { error: 'no_session' },
        };
      }

      if (!args.name || args.name.trim() === '') {
        return {
          output: 'Error: Checkpoint name is required.',
          metadata: { error: 'missing_name' },
        };
      }

      const result = await manager.rollback(sessionID, args.name.trim());

      if (result.success) {
        return {
          output: result.message || `Rolled back to checkpoint "${args.name}".`,
          metadata: { success: true },
        };
      }

      return {
        output: `Rollback failed: ${result.error}`,
        metadata: { error: result.error },
      };
    },
  };
}
