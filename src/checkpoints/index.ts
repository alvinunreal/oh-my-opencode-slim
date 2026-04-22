/**
 * Checkpoint module - session rollback functionality.
 *
 * Provides:
 * - /checkpoint save <name> [description] - Save current state
 * - /checkpoint list - Show all checkpoints
 * - /checkpoint delete <name> - Remove a checkpoint
 * - /rollback <name> - Rollback to checkpoint
 * - checkpoint tool - Agent-driven checkpointing
 * - rollback tool - Agent-driven rollback
 */

export { createCheckpointManager, type CheckpointManager } from './manager';
export { createCheckpointTools, type CheckpointTools } from './tool';
export { createCheckpointCommands, type CommandContext, type CommandResult } from './commands';
export { CheckpointStorage } from './store';
export type { Checkpoint, CheckpointStore } from './types';
