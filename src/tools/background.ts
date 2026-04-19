import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { getDisabledAgents } from '../agents';
import type { BackgroundTaskManager } from '../background';
import type { PluginConfig } from '../config';
import { SUBAGENT_NAMES } from '../config';
import type { MultiplexerConfig } from '../config/schema';
import { resolveRuntimeAgentName } from '../utils';

const z = tool.schema;

/**
 * Extract session ID from a tool execution context.
 * Returns undefined if context is missing, malformed, or sessionID is not a string.
 */
function getSessionId(toolContext: unknown): string | undefined {
  if (
    !toolContext ||
    typeof toolContext !== 'object' ||
    !('sessionID' in toolContext)
  ) {
    return undefined;
  }
  const id = (toolContext as { sessionID: unknown }).sessionID;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Creates background task management tools for the plugin.
 * @param _ctx - Plugin input context
 * @param manager - Background task manager for launching and tracking tasks
 * @param _multiplexerConfig - Optional multiplexer configuration for session management
 * @param _pluginConfig - Optional plugin configuration for agent variants
 * @returns Object containing background_task, background_output, background_cancel, and ask_orchestrator tools
 */
export function createBackgroundTools(
  _ctx: PluginInput,
  manager: BackgroundTaskManager,
  _multiplexerConfig?: MultiplexerConfig,
  _pluginConfig?: PluginConfig,
): Record<string, ToolDefinition> {
  const disabled = getDisabledAgents(_pluginConfig);
  const agentNames = SUBAGENT_NAMES.filter((n) => !disabled.has(n)).join(', ');

  // Tool for launching agent tasks (fire-and-forget)
  const background_task = tool({
    description: `Launch background agent task. Returns task_id immediately.

Flow: launch → wait for automatic notification when complete.

Key behaviors:
- Fire-and-forget: returns task_id in ~1ms
- Parallel: up to 10 concurrent tasks
- Auto-notify: parent session receives result when task completes`,

    args: {
      description: z
        .string()
        .describe('Short description of the task (5-10 words)'),
      prompt: z.string().describe('The task prompt for the agent'),
      agent: z.string().describe(`Agent to use: ${agentNames}`),
    },
    async execute(args, toolContext) {
      const parentSessionId = getSessionId(toolContext);
      if (!parentSessionId) {
        throw new Error('Invalid toolContext: missing sessionID');
      }

      const agent = resolveRuntimeAgentName(_pluginConfig, String(args.agent));
      const prompt = String(args.prompt);
      const description = String(args.description);

      // Validate agent against delegation rules
      if (!manager.isAgentAllowed(parentSessionId, agent)) {
        const allowed = manager.getAllowedSubagents(parentSessionId);
        return `Agent '${agent}' is not allowed. Allowed agents: ${allowed.join(', ')}`;
      }

      // Fire-and-forget launch
      const task = manager.launch({
        agent,
        prompt,
        description,
        parentSessionId,
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
    description: `Get background task results after completion notification received.

timeout=0: returns status immediately (no wait)
timeout=N: waits up to N ms for completion

Returns: results if completed, error if failed, status if running.`,

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

      // Surface relayed questions if any (capped at MAX_QUESTIONS_PER_TASK)
      if (task.questions.length > 0) {
        output += '\n\n---\n\n**Questions relayed from subagent:**\n';
        for (const q of task.questions) {
          // Sanitize newlines to prevent markdown injection, truncate for safety
          const sanitized = q.replace(/[\r\n]/g, ' ');
          const truncated =
            sanitized.length > 2000
              ? `${sanitized.substring(0, 2000)}... (truncated)`
              : sanitized;
          output += `- ${truncated}\n`;
        }
      }

      return output;
    },
  });

  // Tool for canceling running background tasks
  const background_cancel = tool({
    description: `Cancel background task(s).

task_id: cancel specific task
all=true: cancel all running tasks

Only cancels pending/starting/running tasks.`,
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

  // Non-blocking question relay for background subagents
  const ask_orchestrator = tool({
    description: `Record a question for the orchestrator. NON-BLOCKING — you will NOT receive an answer.

Use this when you need clarification but can proceed with a reasonable assumption.
State your assumption explicitly using [ASSUMED: ...] markers before continuing.

Example: "Should I use REST or GraphQL for this endpoint?" → pick one, mark [ASSUMED: using REST], keep working.`,
    args: {
      question: z
        .string()
        .max(2000)
        .describe(
          'The question you need answered. Be specific so the orchestrator can evaluate your assumption.',
        ),
    },
    async execute(args, toolContext) {
      const sessionId = getSessionId(toolContext);
      const question = args.question;

      // Runtime length guard — Zod schema is descriptive for the LLM's tool-use
      // input generation, but the plugin tool framework does NOT enforce Zod
      // validation at execute time. This runtime check is the actual enforcement.
      if (
        typeof question !== 'string' ||
        question.trim().length === 0 ||
        question.length > 2000
      ) {
        return 'Question must be 1\u20132000 characters. Continue with your best judgment using [ASSUMED: ...] markers.';
      }

      if (!sessionId) {
        return 'Could not record question (no session context). Continue with your best judgment using [ASSUMED: ...] markers.';
      }

      const result = manager.addQuestion(sessionId, question);
      if (result === 'not-found') {
        return 'This tool is only available in active background tasks. Continue with your best judgment using [ASSUMED: ...] markers.';
      }
      if (result === 'terminal') {
        return 'Task has already completed. Continue with your best judgment using [ASSUMED: ...] markers.';
      }
      if (result === 'cap-reached') {
        return 'Question limit reached for this task. Continue with your best judgment using [ASSUMED: ...] markers.';
      }

      return 'Question recorded for orchestrator review. Continue with your best judgment using [ASSUMED: ...] markers.';
    },
  });

  return {
    background_task,
    background_output,
    background_cancel,
    ask_orchestrator,
  };
}
