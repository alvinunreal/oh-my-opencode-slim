/**
 * Checkpoint slash commands - user-facing interface.
 */

import type { CheckpointManager } from './manager';

export interface CommandContext {
  sessionID: string;
  arguments: string;
}

export interface CommandResult {
  parts: Array<{ type: string; text?: string }>;
}

export function createCheckpointCommands(manager: CheckpointManager) {
  async function handleCheckpointSave(
    ctx: CommandContext,
  ): Promise<CommandResult> {
    const args = ctx.arguments.trim();
    const match = args.match(/^([^\s]+)(?:\s+(.+))?$/);

    if (!match) {
      return {
        parts: [
          {
            type: 'text',
            text: 'Usage: /checkpoint save <name> [description]\nExample: /checkpoint save before-refactor Starting auth refactor',
          },
        ],
      };
    }

    const [, name, description] = match;
    const result = await manager.saveCheckpoint(ctx.sessionID, name, description);

    if (result.success) {
      return {
        parts: [
          {
            type: 'text',
            text: `✓ Checkpoint "${name}" saved.${description ? `\n  Description: ${description}` : ''}`,
          },
        ],
      };
    }

    return {
      parts: [
        {
          type: 'text',
          text: `✗ Failed to save checkpoint: ${result.error}`,
        },
      ],
    };
  }

  async function handleCheckpointList(
    ctx: CommandContext,
  ): Promise<CommandResult> {
    const checkpoints = await manager.listCheckpoints(ctx.sessionID);

    if (checkpoints.length === 0) {
      return {
        parts: [
          {
            type: 'text',
            text: 'No checkpoints saved for this session.\nUse `/checkpoint save <name>` to create one.',
          },
        ],
      };
    }

    const lines = checkpoints.map((cp) => {
      const date = new Date(cp.createdAt).toLocaleString();
      const desc = cp.description ? `\n    ${cp.description}` : '';
      return `  • ${cp.name} (${date})${desc}`;
    });

    return {
      parts: [
        {
          type: 'text',
          text: `Checkpoints for this session:\n${lines.join('\n')}\n\nUse /rollback <name> to restore a checkpoint.`,
        },
      ],
    };
  }

  async function handleCheckpointDelete(
    ctx: CommandContext,
  ): Promise<CommandResult> {
    const name = ctx.arguments.trim();

    if (!name) {
      return {
        parts: [
          {
            type: 'text',
            text: 'Usage: /checkpoint delete <name>\nExample: /checkpoint delete before-refactor',
          },
        ],
      };
    }

    const result = await manager.deleteCheckpoint(ctx.sessionID, name);

    if (result.success) {
      return {
        parts: [
          {
            type: 'text',
            text: `✓ Checkpoint "${name}" deleted.`,
          },
        ],
      };
    }

    return {
      parts: [
        {
          type: 'text',
          text: `✗ Failed to delete checkpoint: ${result.error}`,
        },
      ],
    };
  }

  async function handleRollback(
    ctx: CommandContext,
  ): Promise<CommandResult> {
    const name = ctx.arguments.trim();

    if (!name) {
      return {
        parts: [
          {
            type: 'text',
            text: 'Usage: /rollback <name>\nExample: /rollback before-refactor\n\nAvailable checkpoints:\n' +
              (await manager.listCheckpoints(ctx.sessionID))
                .map((cp) => `  • ${cp.name}`)
                .join('\n') ||
              '  (none)',
          },
        ],
      };
    }

    const result = await manager.rollback(ctx.sessionID, name);

    if (result.success) {
      return {
        parts: [
          {
            type: 'text',
            text: `✓ ${result.message || `Rolled back to checkpoint "${name}".`}`,
          },
        ],
      };
    }

    return {
      parts: [
        {
            type: 'text',
            text: `✗ Rollback failed: ${result.error}`,
          },
        ],
      };
    }
  }

  return {
    handleCheckpointSave,
    handleCheckpointList,
    handleCheckpointDelete,
    handleRollback,
  };
}
