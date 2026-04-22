/**
 * Checkpoint manager - core logic for saving and restoring checkpoints.
 */

import type { PluginInput } from '@opencode-ai/plugin';
import { log } from '../utils/logger';
import { CheckpointStorage } from './store';
import type { Checkpoint } from './types';

export interface CheckpointManager {
  /** Save a checkpoint for the current session */
  saveCheckpoint(
    sessionID: string,
    name: string,
    description?: string,
  ): Promise<{ success: boolean; checkpoint?: Checkpoint; error?: string }>;

  /** List all checkpoints for a session */
  listCheckpoints(sessionID: string): Promise<Checkpoint[]>;

  /** Delete a checkpoint by name */
  deleteCheckpoint(
    sessionID: string,
    name: string,
  ): Promise<{ success: boolean; error?: string }>;

  /** Rollback to a checkpoint */
  rollback(
    sessionID: string,
    name: string,
  ): Promise<{ success: boolean; message?: string; error?: string }>;

  /** Cleanup all checkpoints for a session */
  cleanupSession(sessionID: string): Promise<number>;
}

interface MessageInfo {
  id: string;
  info?: { role: string; id?: string };
}

export function createCheckpointManager(ctx: PluginInput): CheckpointManager {
  const storage = new CheckpointStorage(ctx.directory);
  const client = ctx.client;

  async function getLastUserMessage(sessionID: string): Promise<string | null> {
    try {
      const result = await client.session.messages({ path: { id: sessionID } });
      const messages = (result.data || []) as MessageInfo[];

      // Find the last user message
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.info?.role === 'user') {
          return messages[i]?.info?.id || messages[i]?.id || null;
        }
      }
      return null;
    } catch (err) {
      log('[checkpoint] Failed to get messages', { error: String(err) });
      return null;
    }
  }

  async function getFirstUserMessageAfter(
    sessionID: string,
    anchorMessageID: string,
  ): Promise<string | null> {
    try {
      const result = await client.session.messages({ path: { id: sessionID } });
      const messages = (result.data || []) as MessageInfo[];

      let foundAnchor = false;
      for (const msg of messages) {
        if (msg.id === anchorMessageID || msg.info?.id === anchorMessageID) {
          foundAnchor = true;
          continue;
        }
        if (foundAnchor && msg.info?.role === 'user') {
          return msg.info?.id || msg.id;
        }
      }
      return null;
    } catch (err) {
      log('[checkpoint] Failed to find message after anchor', { error: String(err) });
      return null;
    }
  }

  async function isSessionBusy(sessionID: string): Promise<boolean> {
    try {
      const status = await client.session.status();
      const sessionStatus = (status.data as Record<string, { type?: string }> | undefined)?.[sessionID];
      return sessionStatus?.type === 'busy';
    } catch {
      return false;
    }
  }

  return {
    async saveCheckpoint(sessionID, name, description) {
      try {
        // Check if checkpoint with this name already exists
        const existing = await storage.getByName(sessionID, name);
        if (existing) {
          return {
            success: false,
            error: `Checkpoint "${name}" already exists. Delete it first or use a different name.`,
          };
        }

        // Get the last user message as anchor
        const anchorMessageID = await getLastUserMessage(sessionID);
        if (!anchorMessageID) {
          return {
            success: false,
            error: 'No user message found to anchor checkpoint. Send a message first.',
          };
        }

        const checkpoint: Checkpoint = {
          id: `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name,
          description,
          sessionID,
          anchorMessageID,
          directory: ctx.directory,
          createdAt: Date.now(),
        };

        await storage.add(checkpoint);
        log('[checkpoint] Saved', { name, sessionID, anchorMessageID });

        return { success: true, checkpoint };
      } catch (err) {
        const error = String(err);
        log('[checkpoint] Failed to save', { error, name, sessionID });
        return { success: false, error };
      }
    },

    async listCheckpoints(sessionID) {
      return storage.listForSession(sessionID);
    },

    async deleteCheckpoint(sessionID, name) {
      try {
        const checkpoint = await storage.getByName(sessionID, name);
        if (!checkpoint) {
          return { success: false, error: `Checkpoint "${name}" not found.` };
        }

        await storage.delete(checkpoint.id);
        log('[checkpoint] Deleted', { name, sessionID });
        return { success: true };
      } catch (err) {
        const error = String(err);
        log('[checkpoint] Failed to delete', { error, name, sessionID });
        return { success: false, error };
      }
    },

    async rollback(sessionID, name) {
      try {
        const checkpoint = await storage.getByName(sessionID, name);
        if (!checkpoint) {
          return { success: false, error: `Checkpoint "${name}" not found.` };
        }

        // Abort if session is busy
        if (await isSessionBusy(sessionID)) {
          try {
            await client.session.abort({ path: { id: sessionID } });
            log('[checkpoint] Aborted busy session before rollback', { sessionID });
          } catch (err) {
            log('[checkpoint] Failed to abort session', { error: String(err) });
          }
        }

        // Find the first user message after the anchor
        const targetMessageID = await getFirstUserMessageAfter(
          sessionID,
          checkpoint.anchorMessageID,
        );

        if (!targetMessageID) {
          return {
            success: false,
            error: 'No messages found after checkpoint anchor. Nothing to rollback.',
          };
        }

        // Call OpenCode's revert API
        await client.session.revert({
          path: { id: sessionID },
          body: { messageID: targetMessageID },
        });

        log('[checkpoint] Rollback complete', { name, sessionID, targetMessageID });
        return {
          success: true,
          message: `Rolled back to checkpoint "${name}". Context pruned to before message ${targetMessageID.slice(0, 8)}...`,
        };
      } catch (err) {
        const error = String(err);
        log('[checkpoint] Rollback failed', { error, name, sessionID });
        return { success: false, error };
      }
    },

    async cleanupSession(sessionID) {
      const count = await storage.deleteForSession(sessionID);
      if (count > 0) {
        log('[checkpoint] Cleaned up session', { sessionID, count });
      }
      return count;
    },
  };
}
