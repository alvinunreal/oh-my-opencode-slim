/**
 * Background Task Manager
 *
 * Manages long-running AI agent tasks that execute in separate sessions.
 * Background tasks run independently from the main conversation flow, allowing
 * the user to continue working while tasks complete asynchronously.
 *
 * Key features:
 * - Fire-and-forget launch (returns task_id immediately)
 * - Creates isolated sessions for background work
 * - Event-driven completion detection via session.status
 * - Start queue with configurable concurrency limit
 * - Supports task cancellation and result retrieval
 */

import type { PluginInput } from '@opencode-ai/plugin';
import type { BackgroundTaskConfig, PluginConfig } from '../config';
import type { TmuxConfig } from '../config/schema';
import { applyAgentVariant, resolveAgentVariant } from '../utils';
import { log } from '../utils/logger';

type PromptBody = {
  messageID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  noReply?: boolean;
  system?: string;
  tools?: { [key: string]: boolean };
  parts: Array<{ type: 'text'; text: string }>;
  variant?: string;
};

type OpencodeClient = PluginInput['client'];

/**
 * Represents a background task running in an isolated session.
 * Tasks are tracked from creation through completion or failure.
 */
export interface BackgroundTask {
  id: string; // Unique task identifier (e.g., "bg_abc123")
  sessionId?: string; // OpenCode session ID (set when starting)
  description: string; // Human-readable task description
  agent: string; // Agent name handling the task
  status:
    | 'pending'
    | 'starting'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled';
  result?: string; // Final output from the agent (when completed)
  error?: string; // Error message (when failed)
  config: BackgroundTaskConfig; // Task configuration
  parentSessionId: string; // Parent session ID for notifications
  startedAt: Date; // Task creation timestamp
  completedAt?: Date; // Task completion/failure timestamp
  prompt: string; // Initial prompt
}

/**
 * Options for launching a new background task.
 */
export interface LaunchOptions {
  agent: string; // Agent to handle the task
  prompt: string; // Initial prompt to send to the agent
  description: string; // Human-readable task description
  parentSessionId: string; // Parent session ID for task hierarchy
}

function generateTaskId(): string {
  return `bg_${Math.random().toString(36).substring(2, 10)}`;
}

export class BackgroundTaskManager {
  private tasks = new Map<string, BackgroundTask>();
  private tasksBySessionId = new Map<string, string>();
  private client: OpencodeClient;
  private directory: string;
  private tmuxEnabled: boolean;
  private config?: PluginConfig;
  private backgroundConfig: BackgroundTaskConfig;

  // Start queue
  private startQueue: BackgroundTask[] = [];
  private activeStarts = 0;
  private maxConcurrentStarts: number;

  // Completion waiting
  private completionResolvers = new Map<
    string,
    (task: BackgroundTask) => void
  >();

  constructor(
    ctx: PluginInput,
    tmuxConfig?: TmuxConfig,
    config?: PluginConfig,
  ) {
    this.client = ctx.client;
    this.directory = ctx.directory;
    this.tmuxEnabled = tmuxConfig?.enabled ?? false;
    this.config = config;
    this.backgroundConfig = config?.background ?? {
      maxConcurrentStarts: 10,
    };
    this.maxConcurrentStarts = this.backgroundConfig.maxConcurrentStarts;
  }

  /**
   * Launch a new background task (fire-and-forget).
   *
   * Phase A (sync): Creates task record and returns immediately.
   * Phase B (async): Session creation and prompt sending happen in background.
   *
   * @param opts - Task configuration options
   * @returns The created background task with pending status
   */
  launch(opts: LaunchOptions): BackgroundTask {
    const task: BackgroundTask = {
      id: generateTaskId(),
      sessionId: undefined,
      description: opts.description,
      agent: opts.agent,
      status: 'pending',
      startedAt: new Date(),
      config: {
        maxConcurrentStarts: this.maxConcurrentStarts,
      },
      parentSessionId: opts.parentSessionId,
      prompt: opts.prompt,
    };

    this.tasks.set(task.id, task);

    // Queue task for background start
    this.enqueueStart(task);

    log(`[background-manager] task launched: ${task.id}`, {
      agent: opts.agent,
      description: opts.description,
    });

    return task;
  }

  /**
   * Enqueue task for background start.
   */
  private enqueueStart(task: BackgroundTask): void {
    this.startQueue.push(task);
    this.processQueue();
  }

  /**
   * Process start queue with concurrency limit.
   */
  private processQueue(): void {
    while (
      this.activeStarts < this.maxConcurrentStarts &&
      this.startQueue.length > 0
    ) {
      const task = this.startQueue.shift();
      if (!task) break;
      this.startTask(task);
    }
  }

  /**
   * Start a task in the background (Phase B).
   */
  private async startTask(task: BackgroundTask): Promise<void> {
    task.status = 'starting';
    this.activeStarts++;

    // Check if cancelled after incrementing activeStarts (to catch race)
    // Use type assertion since cancel() can change status during race condition
    if ((task as BackgroundTask & { status: string }).status === 'cancelled') {
      this.completeTask(task, 'cancelled', 'Task cancelled before start');
      return;
    }

    try {
      // Create session
      const session = await this.client.session.create({
        body: {
          parentID: task.parentSessionId,
          title: `Background: ${task.description}`,
        },
        query: { directory: this.directory },
      });

      if (!session.data?.id) {
        throw new Error('Failed to create background session');
      }

      task.sessionId = session.data.id;
      this.tasksBySessionId.set(session.data.id, task.id);
      task.status = 'running';

      // Give TmuxSessionManager time to spawn the pane
      if (this.tmuxEnabled) {
        await new Promise((r) => setTimeout(r, 500));
      }

      // Send prompt
      const promptQuery: Record<string, string> = { directory: this.directory };
      const resolvedVariant = resolveAgentVariant(this.config, task.agent);
      const promptBody = applyAgentVariant(resolvedVariant, {
        agent: task.agent,
        tools: { background_task: false, task: false },
        parts: [{ type: 'text' as const, text: task.prompt }],
      } as PromptBody) as unknown as PromptBody;

      await this.client.session.prompt({
        path: { id: session.data.id },
        body: promptBody,
        query: promptQuery,
      });

      log(`[background-manager] task started: ${task.id}`, {
        sessionId: session.data.id,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.completeTask(task, 'failed', errorMessage);
    } finally {
      this.activeStarts--;
      this.processQueue();
    }
  }

  /**
   * Handle session.status events for completion detection.
   * Uses session.status instead of deprecated session.idle.
   */
  async handleSessionStatus(event: {
    type: string;
    properties?: { sessionID?: string; status?: { type: string } };
  }): Promise<void> {
    if (event.type !== 'session.status') return;

    const sessionId = event.properties?.sessionID;
    if (!sessionId) return;

    const taskId = this.tasksBySessionId.get(sessionId);
    if (!taskId) return;

    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;

    // Check if session is idle (completed)
    if (event.properties?.status?.type === 'idle') {
      await this.extractAndCompleteTask(task);
    }
  }

  /**
   * Extract task result and mark complete.
   */
  private async extractAndCompleteTask(task: BackgroundTask): Promise<void> {
    if (!task.sessionId) return;

    try {
      const messagesResult = await this.client.session.messages({
        path: { id: task.sessionId },
      });
      const messages = (messagesResult.data ?? []) as Array<{
        info?: { role: string };
        parts?: Array<{ type: string; text?: string }>;
      }>;
      const assistantMessages = messages.filter(
        (m) => m.info?.role === 'assistant',
      );

      const extractedContent: string[] = [];
      for (const message of assistantMessages) {
        for (const part of message.parts ?? []) {
          if (
            (part.type === 'text' || part.type === 'reasoning') &&
            part.text
          ) {
            extractedContent.push(part.text);
          }
        }
      }

      const responseText = extractedContent
        .filter((t) => t.length > 0)
        .join('\n\n');

      if (responseText) {
        this.completeTask(task, 'completed', responseText);
      } else {
        this.completeTask(task, 'completed', '(No output)');
      }
    } catch (error) {
      this.completeTask(
        task,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Complete a task and notify waiting callers.
   */
  private completeTask(
    task: BackgroundTask,
    status: 'completed' | 'failed' | 'cancelled',
    resultOrError: string,
  ): void {
    // Don't check for 'cancelled' here - cancel() may set status before calling
    if (task.status === 'completed' || task.status === 'failed') {
      return; // Already completed
    }

    task.status = status;
    task.completedAt = new Date();

    if (status === 'completed') {
      task.result = resultOrError;
    } else {
      task.error = resultOrError;
    }

    // Clean up tasksBySessionId map to prevent memory leak
    if (task.sessionId) {
      this.tasksBySessionId.delete(task.sessionId);
    }

    // Send notification to parent session
    if (task.parentSessionId) {
      this.sendCompletionNotification(task).catch((err) => {
        log(`[background-manager] notification failed: ${err}`);
      });
    }

    // Resolve waiting callers
    const resolver = this.completionResolvers.get(task.id);
    if (resolver) {
      resolver(task);
      this.completionResolvers.delete(task.id);
    }

    log(`[background-manager] task ${status}: ${task.id}`, {
      description: task.description,
    });
  }

  /**
   * Send completion notification to parent session.
   */
  private async sendCompletionNotification(
    task: BackgroundTask,
  ): Promise<void> {
    const message =
      task.status === 'completed'
        ? `[Background task "${task.description}" completed]`
        : `[Background task "${task.description}" failed: ${task.error}]`;

    await this.client.session.prompt({
      path: { id: task.parentSessionId },
      body: {
        parts: [{ type: 'text' as const, text: message }],
      },
    });
  }

  /**
   * Retrieve the current state of a background task.
   *
   * @param taskId - The task ID to retrieve
   * @returns The task object, or null if not found
   */
  getResult(taskId: string): BackgroundTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  /**
   * Wait for a task to complete.
   *
   * @param taskId - The task ID to wait for
   * @param timeout - Maximum time to wait in milliseconds (0 = no timeout)
   * @returns The completed task, or null if not found/timeout
   */
  async waitForCompletion(
    taskId: string,
    timeout = 0,
  ): Promise<BackgroundTask | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    if (
      task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'cancelled'
    ) {
      return task;
    }

    return new Promise((resolve) => {
      const resolver = (t: BackgroundTask) => resolve(t);
      this.completionResolvers.set(taskId, resolver);

      if (timeout > 0) {
        setTimeout(() => {
          this.completionResolvers.delete(taskId);
          resolve(this.tasks.get(taskId) ?? null);
        }, timeout);
      }
    });
  }

  /**
   * Cancel one or all running background tasks.
   *
   * @param taskId - Optional task ID to cancel. If omitted, cancels all pending/running tasks.
   * @returns Number of tasks cancelled
   */
  cancel(taskId?: string): number {
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (
        task &&
        (task.status === 'pending' ||
          task.status === 'starting' ||
          task.status === 'running')
      ) {
        // Clean up any waiting resolver
        this.completionResolvers.delete(taskId);

        // Check if in start queue (must check before marking cancelled)
        const inStartQueue = task.status === 'pending';

        // Mark as cancelled FIRST to prevent race with startTask
        // Use type assertion since we're deliberately changing status before completeTask
        (task as BackgroundTask & { status: string }).status = 'cancelled';

        // Remove from start queue if pending
        if (inStartQueue) {
          const idx = this.startQueue.findIndex((t) => t.id === taskId);
          if (idx >= 0) {
            this.startQueue.splice(idx, 1);
          }
        }

        this.completeTask(task, 'cancelled', 'Cancelled by user');
        return 1;
      }
      return 0;
    }

    let count = 0;
    for (const task of this.tasks.values()) {
      if (
        task.status === 'pending' ||
        task.status === 'starting' ||
        task.status === 'running'
      ) {
        // Clean up any waiting resolver
        this.completionResolvers.delete(task.id);

        // Check if in start queue (must check before marking cancelled)
        const inStartQueue = task.status === 'pending';

        // Mark as cancelled FIRST to prevent race with startTask
        // Use type assertion since we're deliberately changing status before completeTask
        (task as BackgroundTask & { status: string }).status = 'cancelled';

        // Remove from start queue if pending
        if (inStartQueue) {
          const idx = this.startQueue.findIndex((t) => t.id === task.id);
          if (idx >= 0) {
            this.startQueue.splice(idx, 1);
          }
        }

        this.completeTask(task, 'cancelled', 'Cancelled by user');
        count++;
      }
    }
    return count;
  }

  /**
   * Clean up all tasks.
   */
  cleanup(): void {
    this.startQueue = [];
    this.completionResolvers.clear();
    this.tasks.clear();
    this.tasksBySessionId.clear();
  }
}
