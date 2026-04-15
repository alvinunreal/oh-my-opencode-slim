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
import { getDisabledAgents } from '../agents';
import type { BackgroundTaskConfig, PluginConfig } from '../config';
import {
  FALLBACK_FAILOVER_TIMEOUT_MS,
  SUBAGENT_DELEGATION_RULES,
} from '../config';
import type { MultiplexerConfig } from '../config/schema';
import { getMultiplexer } from '../multiplexer';
import {
  applyAgentVariant,
  createInternalAgentTextPart,
  resolveAgentVariant,
} from '../utils';
import { log } from '../utils/logger';
import {
  extractSessionResult,
  type PromptBody,
  parseModelReference,
  promptWithTimeout,
} from '../utils/session';
import { SubagentDepthTracker } from './subagent-depth';

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
  // Track which agent type owns each session for delegation permission checks
  private agentBySessionId = new Map<string, string>();
  private depthTracker: SubagentDepthTracker;
  private client: OpencodeClient;
  private directory: string;
  private tmuxEnabled: boolean;
  private config?: PluginConfig;
  private backgroundConfig: BackgroundTaskConfig;
  private disabledAgents: Set<string>;

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
    multiplexerConfig?: MultiplexerConfig,
    config?: PluginConfig,
  ) {
    this.client = ctx.client;
    this.directory = ctx.directory;
    // Check if multiplexer is actually available (handles 'auto' type correctly)
    this.tmuxEnabled =
      multiplexerConfig !== undefined &&
      multiplexerConfig.type !== 'none' &&
      multiplexerConfig.type !== undefined &&
      getMultiplexer(multiplexerConfig) !== null;
    this.config = config;
    this.backgroundConfig = config?.background ?? {
      maxConcurrentStarts: 10,
    };
    this.maxConcurrentStarts = this.backgroundConfig.maxConcurrentStarts;
    this.depthTracker = new SubagentDepthTracker();
    this.disabledAgents = getDisabledAgents(config);
  }

  /**
   * Look up the delegation rules for an agent type.
   * Unknown agent types default to explorer-only access, making it easy
   * to add new background agent types without updating SUBAGENT_DELEGATION_RULES.
   */
  private getSubagentRules(agentName: string): readonly string[] {
    return (
      SUBAGENT_DELEGATION_RULES[
        agentName as keyof typeof SUBAGENT_DELEGATION_RULES
      ] ?? ['explorer']
    );
  }

  /**
   * Check if a parent session is allowed to delegate to a specific agent type.
   * @param parentSessionId - The session ID of the parent
   * @param requestedAgent - The agent type being requested
   * @returns true if allowed, false if not
   */
  isAgentAllowed(parentSessionId: string, requestedAgent: string): boolean {
    // Check if the requested agent is disabled
    if (this.disabledAgents.has(requestedAgent)) {
      return false;
    }

    // Untracked sessions are the root orchestrator (created by OpenCode, not by us)
    const parentAgentName =
      this.agentBySessionId.get(parentSessionId) ?? 'orchestrator';

    const allowedSubagents = this.getSubagentRules(parentAgentName);

    if (allowedSubagents.length === 0) return false;

    return allowedSubagents.includes(requestedAgent);
  }

  /**
   * Get the list of allowed subagents for a parent session.
   * @param parentSessionId - The session ID of the parent
   * @returns Array of allowed agent names, empty if none
   */
  getAllowedSubagents(parentSessionId: string): readonly string[] {
    // Untracked sessions are the root orchestrator (created by OpenCode, not by us)
    const parentAgentName =
      this.agentBySessionId.get(parentSessionId) ?? 'orchestrator';

    const allowedSubagents = this.getSubagentRules(parentAgentName);

    // Filter out disabled agents
    return allowedSubagents.filter((name) => !this.disabledAgents.has(name));
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

  private resolveFallbackChain(agentName: string): string[] {
    const fallback = this.config?.fallback;
    const chains = fallback?.chains as
      | Record<string, string[] | undefined>
      | undefined;
    const configuredChain = chains?.[agentName] ?? [];
    const primary = this.config?.agents?.[agentName]?.model;

    const chain: string[] = [];
    const seen = new Set<string>();

    // primary may be a string, an array of string|{id,variant?}, or undefined
    let primaryIds: string[];
    if (Array.isArray(primary)) {
      primaryIds = primary.map((m) => (typeof m === 'string' ? m : m.id));
    } else if (typeof primary === 'string') {
      primaryIds = [primary];
    } else {
      primaryIds = [];
    }
    for (const model of [...primaryIds, ...configuredChain]) {
      if (!model || seen.has(model)) continue;
      seen.add(model);
      chain.push(model);
    }

    return chain;
  }

  /**
   * Calculate tool permissions for a spawned agent based on its own delegation rules.
   * Agents that cannot delegate (leaf nodes) get delegation tools disabled entirely,
   * preventing models from even seeing tools they can never use.
   *
   * @param agentName - The agent type being spawned
   * @returns Tool permissions object with background_task and task enabled/disabled
   */
  private calculateToolPermissions(agentName: string): {
    background_task: boolean;
    task: boolean;
  } {
    const allowedSubagents = this.getSubagentRules(agentName);

    // Leaf agents (no delegation rules) get tools hidden entirely
    if (allowedSubagents.length === 0) {
      return { background_task: false, task: false };
    }

    // Agent can delegate - enable the delegation tools
    // The restriction of WHICH specific subagents are allowed is enforced
    // by the background_task tool via isAgentAllowed()
    return { background_task: true, task: true };
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
      // Check subagent spawn depth BEFORE creating session
      const parentDepth = this.depthTracker.getDepth(task.parentSessionId);
      if (parentDepth + 1 > this.depthTracker.maxDepth) {
        log('[background-manager] spawn blocked: max depth exceeded', {
          parentSessionId: task.parentSessionId,
          parentDepth,
          maxDepth: this.depthTracker.maxDepth,
        });
        this.completeTask(task, 'failed', 'Subagent depth exceeded');
        return;
      }

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
      // Track the agent type for this session for delegation checks
      this.agentBySessionId.set(session.data.id, task.agent);
      task.status = 'running';

      // Register depth after session creation succeeds
      this.depthTracker.registerChild(task.parentSessionId, session.data.id);

      // Give TmuxSessionManager time to spawn the pane
      if (this.tmuxEnabled) {
        await new Promise((r) => setTimeout(r, 500));
      }

      // Calculate tool permissions based on the spawned agent's own delegation rules
      const toolPermissions = this.calculateToolPermissions(task.agent);

      // Send prompt
      const promptQuery: Record<string, string> = { directory: this.directory };
      const resolvedVariant = resolveAgentVariant(this.config, task.agent);
      const basePromptBody = applyAgentVariant(resolvedVariant, {
        agent: task.agent,
        tools: toolPermissions,
        parts: [{ type: 'text' as const, text: task.prompt }],
      } as PromptBody) as unknown as PromptBody;

      const fallbackEnabled = this.config?.fallback?.enabled ?? true;
      const timeoutMs = fallbackEnabled
        ? (this.config?.fallback?.timeoutMs ?? FALLBACK_FAILOVER_TIMEOUT_MS)
        : 0; // 0 = no timeout when fallback disabled
      const retryDelayMs = this.config?.fallback?.retryDelayMs ?? 500;
      const chain = fallbackEnabled
        ? this.resolveFallbackChain(task.agent)
        : [];
      const attemptModels = chain.length > 0 ? chain : [undefined];

      const errors: string[] = [];
      let succeeded = false;
      const sessionId = session.data.id;

      const retryOnEmpty = this.config?.fallback?.retry_on_empty ?? true;

      for (let i = 0; i < attemptModels.length; i++) {
        const model = attemptModels[i];
        const modelLabel = model ?? 'default-model';
        try {
          const body: PromptBody = {
            ...basePromptBody,
            model: undefined,
          };

          if (model) {
            const ref = parseModelReference(model);
            if (!ref) {
              throw new Error(`Invalid fallback model format: ${model}`);
            }
            body.model = ref;
          }

          if (i > 0) {
            log(
              `[background-manager] fallback attempt ${i + 1}/${attemptModels.length}: ${modelLabel}`,
              { taskId: task.id },
            );
          }

          await promptWithTimeout(
            this.client,
            {
              path: { id: sessionId },
              body,
              query: promptQuery,
            },
            timeoutMs,
          );

          // Detect silent empty responses (e.g. provider rate-limited
          // without error). When retry_on_empty is enabled (default),
          // treat as failure so the fallback chain continues.
          const extraction = await extractSessionResult(this.client, sessionId);
          if (retryOnEmpty && extraction.empty) {
            throw new Error('Empty response from provider');
          }

          succeeded = true;
          break;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          errors.push(`${modelLabel}: ${msg}`);
          log(`[background-manager] model failed: ${modelLabel} — ${msg}`, {
            taskId: task.id,
          });

          // Abort the session before trying the next model.
          // The previous prompt may still be running server-side;
          // without aborting, the session stays busy and rejects
          // subsequent prompts, breaking the entire fallback chain.
          if (i < attemptModels.length - 1) {
            try {
              await this.client.session.abort({
                path: { id: sessionId },
              });
              // Allow server time to finalize the abort before
              // the next prompt attempt (matches reference impl).
              await new Promise((r) => setTimeout(r, retryDelayMs));
            } catch {
              // Session may already be idle; safe to ignore.
            }
          }
        }
      }

      if (!succeeded) {
        throw new Error(`All fallback models failed. ${errors.join(' | ')}`);
      }

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
   * Handle session.deleted events for cleanup.
   * When a session is deleted, cancel associated tasks and clean up.
   */
  async handleSessionDeleted(event: {
    type: string;
    properties?: { info?: { id?: string }; sessionID?: string };
  }): Promise<void> {
    if (event.type !== 'session.deleted') return;

    const sessionId = event.properties?.info?.id ?? event.properties?.sessionID;
    if (!sessionId) return;

    const taskId = this.tasksBySessionId.get(sessionId);
    if (!taskId) return;

    const task = this.tasks.get(taskId);
    if (!task) return;

    // Only handle if task is still active
    if (task.status === 'running' || task.status === 'pending') {
      log(`[background-manager] Session deleted, cancelling task: ${task.id}`);

      // Mark as cancelled
      (task as BackgroundTask & { status: string }).status = 'cancelled';
      task.completedAt = new Date();
      task.error = 'Session deleted';

      // Clean up session tracking
      this.tasksBySessionId.delete(sessionId);
      this.agentBySessionId.delete(sessionId);
      this.depthTracker.cleanup(sessionId);

      // Resolve any waiting callers
      const resolver = this.completionResolvers.get(taskId);
      if (resolver) {
        resolver(task);
        this.completionResolvers.delete(taskId);
      }

      log(
        `[background-manager] Task cancelled due to session deletion: ${task.id}`,
      );
    }
  }

  /**
   * Extract task result and mark complete.
   * When retry_on_empty is enabled (default), empty responses are
   * treated as failures so the fallback chain can retry.
   * When disabled, empty responses succeed with an empty string result.
   */
  private async extractAndCompleteTask(task: BackgroundTask): Promise<void> {
    if (!task.sessionId) return;

    const retryOnEmpty = this.config?.fallback?.retry_on_empty ?? true;

    try {
      const extraction = await extractSessionResult(
        this.client,
        task.sessionId,
      );

      if (extraction.empty && retryOnEmpty) {
        this.completeTask(task, 'failed', 'Empty response from provider');
      } else {
        this.completeTask(task, 'completed', extraction.text);
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

    // Clean up session tracking maps as fallback
    // (handleSessionDeleted also does this when session.deleted event fires)
    if (task.sessionId) {
      this.tasksBySessionId.delete(task.sessionId);
      this.agentBySessionId.delete(task.sessionId);
    }

    // Abort session to trigger pane cleanup and free resources
    if (task.sessionId) {
      this.client.session
        .abort({
          path: { id: task.sessionId },
        })
        .catch(() => {});
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
        parts: [createInternalAgentTextPart(message)],
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
    this.agentBySessionId.clear();
    this.depthTracker.cleanupAll();
  }

  /**
   * Get the depth tracker instance for use by other managers.
   */
  getDepthTracker(): SubagentDepthTracker {
    return this.depthTracker;
  }
}
