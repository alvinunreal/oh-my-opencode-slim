/**
 * Checkpoint types for session rollback functionality.
 */

export interface Checkpoint {
  /** Unique identifier for the checkpoint */
  id: string;
  /** User-defined name for the checkpoint */
  name: string;
  /** Optional description of why checkpoint was created */
  description?: string;
  /** Session ID this checkpoint belongs to */
  sessionID: string;
  /** Message ID of the last user message at checkpoint time (the anchor) */
  anchorMessageID: string;
  /** Workspace directory */
  directory: string;
  /** Timestamp when checkpoint was created */
  createdAt: number;
}

export interface CheckpointStore {
  /** Map of checkpoint ID to checkpoint */
  checkpoints: Record<string, Checkpoint>;
  /** Index: sessionID -> checkpoint IDs */
  bySession: Record<string, string[]>;
}
