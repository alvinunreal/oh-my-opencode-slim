import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundTaskManager } from '../background';
import type { PluginConfig } from '../config';
import { SUBAGENT_NAMES } from '../config';
import type { TmuxConfig } from '../config/schema';
import { applyAgentVariant, resolveAgentVariant } from '../utils';
import { log } from '../utils/logger';

const z = tool.schema;

interface SessionMessage {
  info?: { role: string };
  parts?: Array<{ type: string; text?: string }>;
}

/**
 * Creates background task management tools for the plugin.
 * @param ctx - Plugin input context
 * @param manager - Background task manager for launching and tracking tasks
 * @param tmuxConfig - Optional tmux configuration for session management
 * @param pluginConfig - Optional plugin configuration for agent variants
 * @returns Object containing background_task, background_output, and background_cancel tools
 */
export function createBackgroundTools(
  ctx: PluginInput,
  manager: BackgroundTaskManager,
  tmuxConfig?: TmuxConfig,
  pluginConfig?: PluginConfig,
): Record<string, ToolDefinition> {
  const agentNames = SUBAGENT_NAMES.join(', ');

  // Tool for launching agent tasks (fire-and-forget)
  const background_task = tool({
    description: `Run agent task in background. Returns task_id immediately - use \`background_output\` to get results.

Agents: ${agentNames}.

Key behaviors:
- Fire-and-forget: Returns task_id in ~1ms without waiting for session creation
- Multiple tasks launch in parallel (up to 10 concurrent)
- Completion detection via session.status events (no polling)
- Optional: Set notifyOnComplete=true to get notification when task completes`,

    args: {
      description: z
        .string()
        .describe('Short description of the task (5-10 words)'),
      prompt: z.string().describe('The task prompt for the agent'),
      agent: z.string().describe(`Agent to use: ${agentNames}`),
      notifyOnComplete: z
        .boolean()
        .optional()
        .describe('Notify parent session when task completes (default: false)'),
    },
    async execute(args, toolContext) {
      if (
        !toolContext ||
        typeof toolContext !== 'object' ||
        !('sessionID' in toolContext)
      ) {
        throw new Error('Invalid toolContext: missing sessionID');
      }

      const agent = String(args.agent);
      const prompt = String(args.prompt);
      const description = String(args.description);
      const notifyOnComplete = args.notifyOnComplete === true;

      // Fire-and-forget launch
      const task = manager.launch({
        agent,
        prompt,
        description,
        parentSessionId: (toolContext as { sessionID: string }).sessionID,
        notifyOnComplete,
      });

      return `Background task launched.

Task ID: ${task.id}
Agent: ${agent}
Status: ${task.status}

Use \`background_output\` with task_id="${task.id}" to get results.`;
    },
  });

  // Tool for retrieving output from background tasks
  const background_output = tool({
    description:
      'Get output from background task. Returns current state immediately (no blocking).',
    args: {
      task_id: z.string().describe('Task ID from background_task'),
      timeout: z
        .number()
        .optional()
        .describe('Wait for completion (in ms, 0=no wait, default: 0)'),
    },
    async execute(args) {
      const taskId = String(args.task_id);
      const timeout =
        typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : 0;

      let task = manager.getResult(taskId);

      // Wait for completion if timeout specified
      if (
        task &&
        timeout > 0 &&
        task.status !== 'completed' &&
        task.status !== 'failed' &&
        task.status !== 'cancelled'
      ) {
        task = await manager.waitForCompletion(taskId, timeout);
      }

      if (!task) {
        return `Task not found: ${taskId}`;
      }

      // Calculate task duration
      const duration = task.completedAt
        ? `${Math.floor((task.completedAt.getTime() - task.startedAt.getTime()) / 1000)}s`
        : `${Math.floor((Date.now() - task.startedAt.getTime()) / 1000)}s`;

      let output = `Task: ${task.id}
 Description: ${task.description}
 Status: ${task.status}
 Duration: ${duration}

 ---

 `;

      // Include task result or error based on status
      if (task.status === 'completed' && task.result != null) {
        output += task.result;
      } else if (task.status === 'failed') {
        output += `Error: ${task.error}`;
      } else if (task.status === 'cancelled') {
        output += '(Task cancelled)';
      } else {
        output += '(Task still running)';
      }

      return output;
    },
  });

  // Tool for canceling running background tasks
  const background_cancel = tool({
    description:
      'Cancel running background task(s). Use all=true to cancel all.',
    args: {
      task_id: z.string().optional().describe('Specific task to cancel'),
      all: z.boolean().optional().describe('Cancel all running tasks'),
    },
    async execute(args) {
      // Cancel all running tasks if requested
      if (args.all === true) {
        const count = manager.cancel();
        return `Cancelled ${count} task(s).`;
      }

      // Cancel specific task if task_id provided
      if (typeof args.task_id === 'string') {
        const count = manager.cancel(args.task_id);
        return count > 0
          ? `Cancelled task ${args.task_id}.`
          : `Task ${args.task_id} not found or not running.`;
      }

      return 'Specify task_id or use all=true.';
    },
  });

  return { background_task, background_output, background_cancel };
}
