import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import type { PluginConfig, TmuxConfig } from '../config';
import { SUBAGENT_DELEGATION_RULES } from '../config/constants';
import type { AgentRole } from '../token-discipline/config';
import {
  DEFAULT_MODEL_ASSIGNMENTS,
  getModelForRole,
  PACKET_CONSTRAINTS,
} from '../token-discipline/config';
import {
  finalizeTaskTracking,
  getAlerts,
  recordDelegateResult,
  recordIsolationViolation,
  recordPacketRejection,
  setOrchestratorTokens,
  setTaskClassification,
  startTaskTracking,
} from '../token-discipline/metrics';
import {
  buildPacketContext,
  PACKET_FORMAT_INSTRUCTIONS,
  processDelegateOutput,
} from '../token-discipline/orchestrator';
import { mergePackets } from '../token-discipline/packet-merger';
import { PointerResolver } from '../token-discipline/pointer-resolver';
import { classifyAndRoute } from '../token-discipline/task-router';
import type {
  DelegateResult,
  PacketV1,
  ValidatedPacket,
} from '../token-discipline/types';
import { assertNoRawContextLeak } from '../token-discipline/validator';
import {
  applyAgentVariant,
  parseModelReference,
  resolveAgentVariant,
} from '../utils';
import { log } from '../utils/logger';
import type { PromptBody } from '../utils/session';

const z = tool.schema;

type OpencodeClient = PluginInput['client'];

export interface PacketTask {
  id: string;
  sessionId?: string;
  description: string;
  agent: string;
  role: AgentRole;
  status:
    | 'pending'
    | 'starting'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled';
  result?: string;
  packet?: ValidatedPacket;
  delegateResult?: DelegateResult;
  error?: string;
  parentSessionId: string;
  startedAt: Date;
  completedAt?: Date;
  prompt: string;
  tokenCount: number;
  modelUsed?: string;
}

export interface LaunchOptions {
  agent: string;
  prompt: string;
  description: string;
  parentSessionId: string;
}

function generateTaskId(): string {
  return `pkt_${Math.random().toString(36).substring(2, 10)}`;
}

export function agentNameToRole(agentName: string): AgentRole {
  const mapping: Record<string, AgentRole> = {
    librarian: 'RESEARCHER',
    explorer: 'REPO_SCOUT',
    fixer: 'IMPLEMENTER',
    oracle: 'VALIDATOR',
    designer: 'DESIGNER',
    summarizer: 'SUMMARIZER',
    orchestrator: 'ORCHESTRATOR',
  };
  return mapping[agentName] ?? 'IMPLEMENTER';
}

export class PacketTaskManager {
  private tasks = new Map<string, PacketTask>();
  private tasksBySessionId = new Map<string, string>();
  private agentBySessionId = new Map<string, string>();
  private client: OpencodeClient;
  private directory: string;
  private tmuxEnabled: boolean;
  private config?: PluginConfig;

  private startQueue: PacketTask[] = [];
  private activeStarts = 0;
  private maxConcurrentStarts = 10;

  private completionResolvers = new Map<string, (task: PacketTask) => void>();

  /** Pointer resolver — one per plugin lifetime, quota reset per user request. */
  readonly pointerResolver = new PointerResolver();

  /** Bypass the readonly union to set task status internally. */
  private setTaskStatus(task: PacketTask, status: PacketTask['status']): void {
    (task as { status: PacketTask['status'] }).status = status;
  }

  // Phase 11: track whether metrics tracking has been started for the current
  // orchestrator session. Keyed by parentSessionId so parallel sessions don't
  // clobber each other's module-level metrics state.
  private trackingStartedBySessions = new Set<string>();

  constructor(
    ctx: PluginInput,
    tmuxConfig?: TmuxConfig,
    config?: PluginConfig,
  ) {
    this.client = ctx.client;
    this.directory = ctx.directory;
    this.tmuxEnabled = tmuxConfig?.enabled ?? false;
    this.config = config;
  }

  private getSubagentRules(agentName: string): readonly string[] {
    return (
      SUBAGENT_DELEGATION_RULES[
        agentName as keyof typeof SUBAGENT_DELEGATION_RULES
      ] ?? ['explorer']
    );
  }

  isTrackingStarted(parentSessionId: string): boolean {
    return this.trackingStartedBySessions.has(parentSessionId);
  }

  markTrackingStarted(parentSessionId: string): void {
    this.trackingStartedBySessions.add(parentSessionId);
  }

  isAgentAllowed(parentSessionId: string, requestedAgent: string): boolean {
    const parentAgentName =
      this.agentBySessionId.get(parentSessionId) ?? 'orchestrator';
    const allowedSubagents = this.getSubagentRules(parentAgentName);
    if (allowedSubagents.length === 0) return false;
    return allowedSubagents.includes(requestedAgent);
  }

  getAllowedSubagents(parentSessionId: string): readonly string[] {
    const parentAgentName =
      this.agentBySessionId.get(parentSessionId) ?? 'orchestrator';
    return this.getSubagentRules(parentAgentName);
  }

  launch(opts: LaunchOptions): PacketTask {
    const task: PacketTask = {
      id: generateTaskId(),
      sessionId: undefined,
      description: opts.description,
      agent: opts.agent,
      role: agentNameToRole(opts.agent),
      status: 'pending',
      startedAt: new Date(),
      parentSessionId: opts.parentSessionId,
      prompt: opts.prompt,
      tokenCount: 0,
    };

    this.tasks.set(task.id, task);
    this.enqueueStart(task);

    log(`[packet-manager] task launched: ${task.id}`, {
      agent: opts.agent,
      role: task.role,
    });

    return task;
  }

  private enqueueStart(task: PacketTask): void {
    this.startQueue.push(task);
    this.processQueue();
  }

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
    for (const model of [primary, ...configuredChain]) {
      if (!model || seen.has(model)) continue;
      seen.add(model);
      chain.push(model);
    }
    return chain;
  }

  private calculateToolPermissions(agentName: string): {
    background_task: boolean;
    task: boolean;
  } {
    const allowedSubagents = this.getSubagentRules(agentName);
    if (allowedSubagents.length === 0) {
      return { background_task: false, task: false };
    }
    return { background_task: true, task: true };
  }

  private async startTask(task: PacketTask): Promise<void> {
    task.status = 'starting';
    this.activeStarts++;

    // Status may have been set to 'cancelled' by a concurrent cancel() call
    // before this async startTask reached this point.
    if ((task.status as string) === 'cancelled') {
      this.completeTask(task, 'cancelled', 'Task cancelled before start');
      return;
    }

    try {
      const session = await this.client.session.create({
        body: {
          parentID: task.parentSessionId,
          title: `Packet: ${task.description}`,
        },
        query: { directory: this.directory },
      });

      if (!session.data?.id) {
        throw new Error('Failed to create packet session');
      }

      task.sessionId = session.data.id;
      this.tasksBySessionId.set(session.data.id, task.id);
      this.agentBySessionId.set(session.data.id, task.agent);
      task.status = 'running';

      if (this.tmuxEnabled) {
        await new Promise((r) => setTimeout(r, 500));
      }

      const toolPermissions = this.calculateToolPermissions(task.agent);

      // Phase 10: model from omoslim.json role assignments, with agent override fallback
      const roleModel = await getModelForRole(task.role).catch(
        () => DEFAULT_MODEL_ASSIGNMENTS[task.role],
      );
      const configModel = this.config?.agents?.[task.agent]?.model;
      const modelToUse = configModel ?? roleModel;
      task.modelUsed = modelToUse;

      // Always append packet format instructions so delegate knows the expected schema
      const packetPrompt = `${task.prompt}\n\n${PACKET_FORMAT_INSTRUCTIONS}`;

      const promptQuery: Record<string, string> = { directory: this.directory };
      const resolvedVariant = resolveAgentVariant(this.config, task.agent);
      const basePromptBody = applyAgentVariant(resolvedVariant, {
        agent: task.agent,
        tools: toolPermissions,
        parts: [{ type: 'text' as const, text: packetPrompt }],
      } as PromptBody) as unknown as PromptBody;

      const fallbackEnabled = this.config?.fallback?.enabled ?? true;
      const timeoutMs = fallbackEnabled
        ? (this.config?.fallback?.timeoutMs ?? 15000)
        : 0;
      const chain = fallbackEnabled
        ? this.resolveFallbackChain(task.agent)
        : [];
      const attemptModels = chain.length > 0 ? chain : [modelToUse];

      const errors: string[] = [];
      let succeeded = false;

      for (const model of attemptModels) {
        try {
          const body: PromptBody = { ...basePromptBody, model: undefined };
          if (model) {
            const ref = parseModelReference(model);
            if (!ref)
              throw new Error(`Invalid fallback model format: ${model}`);
            body.model = ref;
          }

          await this.promptWithTimeout(
            { path: { id: session.data.id }, body, query: promptQuery },
            timeoutMs,
          );

          succeeded = true;
          break;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          errors.push(`${model ?? 'default-model'}: ${msg}`);
        }
      }

      if (!succeeded) {
        throw new Error(`All fallback models failed. ${errors.join(' | ')}`);
      }

      log(`[packet-manager] task started: ${task.id}`, {
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

  private async promptWithTimeout(
    args: Parameters<OpencodeClient['session']['prompt']>[0],
    timeoutMs: number,
  ): Promise<void> {
    if (timeoutMs <= 0) {
      await this.client.session.prompt(args);
      return;
    }
    await Promise.race([
      this.client.session.prompt(args),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Prompt timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  }

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
    if (event.properties?.status?.type === 'idle') {
      await this.extractAndCompleteTask(task);
    }
  }

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
    if (task.status === 'running' || task.status === 'pending') {
      log(`[packet-manager] Session deleted, cancelling task: ${task.id}`);
      this.setTaskStatus(task, 'cancelled');
      task.completedAt = new Date();
      task.error = 'Session deleted';
      this.tasksBySessionId.delete(sessionId);
      this.agentBySessionId.delete(sessionId);
      const resolver = this.completionResolvers.get(taskId);
      if (resolver) {
        resolver(task);
        this.completionResolvers.delete(taskId);
      }
    }
  }

  private async extractAndCompleteTask(task: PacketTask): Promise<void> {
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
      const estimatedTokens = Math.ceil(responseText.length / 4);
      task.tokenCount = estimatedTokens;

      // processDelegateOutput extracts packet, archives thread, validates schema
      const result = await processDelegateOutput(
        {
          userRequest: task.prompt,
          packets: [],
        },
        task.role,
        responseText,
        messages,
        estimatedTokens,
      );

      if (result) {
        // Phase 11: isolation verification — ensure no raw output leaked into packet
        try {
          assertNoRawContextLeak(result.packet, result.threadId, responseText);
        } catch {
          // Record violation but don't fail the task — log and continue
          recordIsolationViolation();
          log(`[packet-manager] isolation violation in task ${task.id}`, {
            threadId: result.threadId,
          });
        }

        task.packet = result.packet;
        task.delegateResult = result;

        // Phase 11: record metrics
        recordDelegateResult(result);

        this.completeTask(task, 'completed', responseText);
      } else {
        // processDelegateOutput returned null — record rejection, complete without packet
        recordPacketRejection();
        this.completeTask(task, 'completed', responseText || '(No output)');
      }
    } catch (error) {
      recordPacketRejection();
      this.completeTask(
        task,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private completeTask(
    task: PacketTask,
    status: 'completed' | 'failed' | 'cancelled',
    resultOrError: string,
  ): void {
    if (task.status === 'completed' || task.status === 'failed') return;

    task.status = status;
    task.completedAt = new Date();

    if (status === 'completed') {
      task.result = resultOrError;
    } else {
      task.error = resultOrError;
    }

    if (task.sessionId) {
      this.tasksBySessionId.delete(task.sessionId);
      this.agentBySessionId.delete(task.sessionId);
      this.client.session
        .abort({ path: { id: task.sessionId } })
        .catch(() => {});
    }

    const resolver = this.completionResolvers.get(task.id);
    if (resolver) {
      resolver(task);
      this.completionResolvers.delete(task.id);
    }

    log(`[packet-manager] task ${status}: ${task.id}`, {
      description: task.description,
      hasPacket: !!task.packet,
    });
  }

  getResult(taskId: string): PacketTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  async waitForCompletion(
    taskId: string,
    timeout = 0,
  ): Promise<PacketTask | null> {
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
      const resolver = (t: PacketTask) => resolve(t);
      this.completionResolvers.set(taskId, resolver);
      if (timeout > 0) {
        setTimeout(() => {
          this.completionResolvers.delete(taskId);
          resolve(this.tasks.get(taskId) ?? null);
        }, timeout);
      }
    });
  }

  cancel(taskId?: string): number {
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (
        task &&
        (task.status === 'pending' ||
          task.status === 'starting' ||
          task.status === 'running')
      ) {
        this.completionResolvers.delete(taskId);
        const inStartQueue = task.status === 'pending';
        this.setTaskStatus(task, 'cancelled');
        if (inStartQueue) {
          const idx = this.startQueue.findIndex((t) => t.id === taskId);
          if (idx >= 0) this.startQueue.splice(idx, 1);
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
        this.completionResolvers.delete(task.id);
        const inStartQueue = task.status === 'pending';
        this.setTaskStatus(task, 'cancelled');
        if (inStartQueue) {
          const idx = this.startQueue.findIndex((t) => t.id === task.id);
          if (idx >= 0) this.startQueue.splice(idx, 1);
        }
        this.completeTask(task, 'cancelled', 'Cancelled by user');
        count++;
      }
    }
    return count;
  }

  clearTrackingForSession(parentSessionId: string): void {
    this.trackingStartedBySessions.delete(parentSessionId);
  }

  cleanup(): void {
    this.startQueue = [];
    this.completionResolvers.clear();
    this.tasks.clear();
    this.tasksBySessionId.clear();
    this.agentBySessionId.clear();
    this.trackingStartedBySessions.clear();
  }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createPacketTools(
  manager: PacketTaskManager,
): Record<string, ToolDefinition> {
  const agentNames = [
    'explorer',
    'librarian',
    'oracle',
    'designer',
    'fixer',
  ].join(', ');

  /**
   * Phase 8: delegate_task routes tasks automatically when a routing hint is
   * present.  The orchestrator can still specify an explicit agent; if omitted
   * the task-router classifies the prompt and picks the most appropriate one.
   *
   * wait=true (default): blocks until the delegate finishes and returns the
   * formatted packet directly — identical to what packet_context returns.
   * wait=false: fires the delegate and returns the task ID immediately. Use
   * this for the parallel launch pattern, then retrieve all results in a
   * single packet_context(task_id="id1,id2,...") call.
   */
  const delegate_task = tool({
    description: `Launch a delegate and get back a compact packet (≤${PACKET_CONSTRAINTS.maxChars} chars).

**Default (wait=true):** blocks until complete, returns packet directly.
**Parallel pattern (wait=false):** returns task ID immediately. Then use
  \`packet_context(task_id="id1,id2,id3", timeout=120000)\` to retrieve all.

Packets contain:
- tldr: 1-3 key insights
- evidence: 1-5 file/thread/cmd/URL pointers
- recommendation: single action to take
- next_actions: 1-5 concrete steps

Available agents: ${agentNames}
Omit \`agent\` to auto-route based on the prompt.`,

    args: {
      description: z.string().describe('Short task description (5-10 words)'),
      prompt: z.string().describe('Full task prompt for the delegate'),
      agent: z
        .string()
        .optional()
        .describe(`Delegate to use: ${agentNames}. Omit to auto-route.`),
      wait: z
        .boolean()
        .optional()
        .describe(
          'If true (default), block until complete and return packet. If false, return task ID immediately for parallel patterns.',
        ),
    },
    async execute(args, toolContext) {
      if (
        !toolContext ||
        typeof toolContext !== 'object' ||
        !('sessionID' in toolContext)
      ) {
        throw new Error('Invalid toolContext: missing sessionID');
      }

      const prompt = String(args.prompt);
      const description = String(args.description);
      const parentSessionId = (toolContext as { sessionID: string }).sessionID;
      // Default wait=true — block unless caller explicitly opts out
      const shouldWait = args.wait !== false;

      // Phase 8 + 11: classify prompt once — used for both auto-routing and
      // metrics classification. Computing it unconditionally avoids a second
      // call inside the tracking guard below.
      const routingPlan = classifyAndRoute(prompt);

      // Phase 8: auto-route when no explicit agent given
      let agent = args.agent ? String(args.agent) : undefined;
      if (!agent) {
        const firstDelegate = routingPlan.delegates[0];
        const roleToAgent: Record<string, string> = {
          RESEARCHER: 'librarian',
          REPO_SCOUT: 'explorer',
          IMPLEMENTER: 'fixer',
          VALIDATOR: 'oracle',
          DESIGNER: 'designer',
          SUMMARIZER: 'summarizer',
          ORCHESTRATOR: 'fixer',
        };
        agent = roleToAgent[firstDelegate?.role ?? 'IMPLEMENTER'] ?? 'fixer';
        log(
          `[packet-manager] auto-routed to ${agent} (role: ${firstDelegate?.role})`,
        );
      }

      if (!manager.isAgentAllowed(parentSessionId, agent)) {
        const allowed = manager.getAllowedSubagents(parentSessionId);
        return `Agent '${agent}' is not allowed from this context. Allowed: ${allowed.join(', ')}`;
      }

      // Phase 11: start metrics tracking once per orchestrator session.
      // Calling startTaskTracking resets the module-level mutable state, so
      // we must not call it again on subsequent delegate launches from the
      // same session — that would wipe already-recorded delegate data.
      // Also reset pointer resolver quota for the new user request.
      if (!manager.isTrackingStarted(parentSessionId)) {
        startTaskTracking(prompt);
        setTaskClassification(routingPlan.isTrivial);
        manager.markTrackingStarted(parentSessionId);
        // Reset pointer resolution quota — 3 resolutions per user request
        manager.pointerResolver.reset();
      }

      const task = manager.launch({
        agent,
        prompt,
        description,
        parentSessionId,
      });

      // wait=false: caller is doing parallel launches and will use packet_context
      if (!shouldWait) {
        return `Delegate task launched.

Task ID: ${task.id}
Agent:   ${agent}
Status:  ${task.status}

Use \`packet_context\` with task_id="${task.id}" (or comma-separated IDs) to retrieve packets.`;
      }

      // wait=true (default): block until the delegate completes and return
      // the formatted packet directly — no separate packet_context call needed.
      const completed = await manager.waitForCompletion(task.id, 120000);
      if (!completed) {
        return `Task ${task.id} timed out or not found`;
      }

      const duration = completed.completedAt
        ? `${Math.floor((completed.completedAt.getTime() - completed.startedAt.getTime()) / 1000)}s`
        : `${Math.floor((Date.now() - completed.startedAt.getTime()) / 1000)}s`;

      if (completed.status === 'completed' && completed.packet) {
        const packet = completed.packet;

        // Finalize metrics after delegate completes
        setOrchestratorTokens(completed.tokenCount);
        finalizeTaskTracking()
          .then((m) => {
            if (!m) return;
            const alerts = getAlerts(m);
            for (const alert of alerts) {
              log(`[packet-metrics] ALERT: ${alert}`);
            }
          })
          .catch(() => {});

        const ctx = buildPacketContext([packet]);
        return `${ctx}
---
Agent: ${completed.agent} | Task: ${completed.id} | Duration: ${duration} | ~${completed.tokenCount} tokens | Packet: ${packet.charCount} chars`;
      }

      if (completed.status === 'completed' && completed.result) {
        return `Task: ${completed.id} | Agent: ${completed.agent} | Duration: ${duration}

${completed.result}`;
      }

      if (completed.status === 'failed') {
        return `Task: ${completed.id} | Agent: ${completed.agent} | Status: FAILED | Duration: ${duration}

Error: ${completed.error}`;
      }

      if (completed.status === 'cancelled') {
        return `Task: ${completed.id} | Status: CANCELLED (${duration})`;
      }

      return `Task: ${completed.id} | Agent: ${completed.agent} | Status: ${completed.status} | Running for ${duration}`;
    },
  });

  /**
   * Phase 7: packet_context returns a formatted packet and also supports
   * merging results when multiple task_ids are provided.
   */
  const packet_context = tool({
    description: `Retrieve packet(s) from one or more delegate tasks.

timeout=0 : return immediately (check status)
timeout=N : wait up to N ms for completion

Supports comma-separated task_ids to merge multiple packets.`,

    args: {
      task_id: z
        .string()
        .describe('Task ID from delegate_task. Comma-separate for multiple.'),
      timeout: z
        .number()
        .optional()
        .describe('Wait timeout in ms (default: 0 = no wait)'),
    },
    async execute(args) {
      const taskIds = String(args.task_id)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const timeout =
        typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : 0;

      // Resolve all tasks, waiting if timeout provided
      const tasks: PacketTask[] = [];
      for (const id of taskIds) {
        let t = manager.getResult(id);
        if (
          t &&
          timeout > 0 &&
          t.status !== 'completed' &&
          t.status !== 'failed' &&
          t.status !== 'cancelled'
        ) {
          t = await manager.waitForCompletion(id, timeout);
        }
        if (t) tasks.push(t);
        else return `Task not found: ${id}`;
      }

      // Phase 7: merge multiple packets if needed
      if (tasks.length > 1) {
        const completedResults: DelegateResult[] = tasks
          .filter((t) => t.status === 'completed' && t.delegateResult)
          .map((t) => t.delegateResult as DelegateResult);

        if (completedResults.length > 0) {
          const merged = mergePackets(completedResults);

          // Phase 11: record orchestrator context size for monitoring
          const orchestratorTokens = Math.ceil(
            JSON.stringify(completedResults.map((r) => r.packet)).length / 4,
          );
          setOrchestratorTokens(orchestratorTokens);
          finalizeTaskTracking()
            .then((m) => {
              if (!m) return;
              const alerts = getAlerts(m);
              for (const alert of alerts) {
                log(`[packet-metrics] ALERT: ${alert}`);
              }
            })
            .catch(() => {});

          const sources = tasks.map((t) => `${t.agent}:${t.id}`).join(', ');
          return `# Merged Packets (${completedResults.length} sources)
Sources: ${sources}

## Summary
${merged.tldr.map((b) => `- ${b}`).join('\n')}

## Evidence
${merged.evidence.map((b) => `- ${b}`).join('\n')}
${merged.conflicts?.length ? `\n## Conflicts\n${merged.conflicts.map((c) => `- ${c}`).join('\n')}` : ''}

## Recommendation
${merged.recommendation}

## Next Actions
${merged.next_actions.map((b) => `- ${b}`).join('\n')}`;
        }
      }

      // Single task response
      const task = tasks[0];
      if (!task) return `Task not found: ${args.task_id}`;

      const duration = task.completedAt
        ? `${Math.floor((task.completedAt.getTime() - task.startedAt.getTime()) / 1000)}s`
        : `${Math.floor((Date.now() - task.startedAt.getTime()) / 1000)}s`;

      if (task.status === 'completed' && task.packet) {
        const packet = task.packet;

        // Phase 11: finalize metrics after single-delegate flow
        setOrchestratorTokens(task.tokenCount);
        finalizeTaskTracking()
          .then((m) => {
            if (!m) return;
            const alerts = getAlerts(m);
            for (const alert of alerts) {
              log(`[packet-metrics] ALERT: ${alert}`);
            }
          })
          .catch(() => {});

        // Build context string using token-discipline's formatter
        const ctx = buildPacketContext([packet]);
        return `${ctx}
---
Agent: ${task.agent} | Task: ${task.id} | Duration: ${duration} | ~${task.tokenCount} tokens | Packet: ${packet.charCount} chars`;
      }

      if (task.status === 'completed' && task.result) {
        return `Task: ${task.id} | Agent: ${task.agent} | Duration: ${duration}

${task.result}`;
      }

      if (task.status === 'failed') {
        return `Task: ${task.id} | Agent: ${task.agent} | Status: FAILED | Duration: ${duration}

Error: ${task.error}`;
      }

      if (task.status === 'cancelled') {
        return `Task: ${task.id} | Status: CANCELLED (${duration})`;
      }

      return `Task: ${task.id} | Agent: ${task.agent} | Status: ${task.status} | Running for ${duration}`;
    },
  });

  /**
   * Part 2 — resolve_pointer: dereference thread:, file:, or cmd: evidence
   * pointers from packets. Backed by the manager's shared PointerResolver
   * (quota of 3 per user request, reset on new orchestrator task boundary).
   *
   * Use surgically — max 3 per user request. Designed for inspecting fallback
   * packets or reading file lines before acting on a recommendation.
   */
  const resolve_pointer = tool({
    description: `Dereference a thread:, file:, or cmd: evidence pointer from a packet.

Returns up to 500 chars of resolved content.
Quota: 3 resolutions per user request (resets on new orchestrator task).

Use cases:
- Inspect a fallback packet: resolve_pointer("thread:abc123#context")
- Read file lines: resolve_pointer("file:src/foo.ts:42-55")

Error cases:
- Thread not found → clear error message
- File not found → clear error message
- Invalid format → error with expected format
- Quota exceeded → error showing usage count`,

    args: {
      pointer: z
        .string()
        .describe(
          'Pointer to resolve. Formats: thread:id#fragment, file:path:lines, cmd:id',
        ),
    },
    async execute(args) {
      const pointer = String(args.pointer).trim();

      if (!manager.pointerResolver.canResolve()) {
        const used = 3 - manager.pointerResolver.remaining();
        return `Error: Pointer resolution quota exceeded (${used}/3 used for this task)`;
      }

      // Validate format before attempting resolution
      const validFormats =
        /^(thread:[^#\s]+(#[^\s]+)?|file:[^:\s]+:\d+(-\d+)?|cmd:[^\s]+(#line:\d+(-\d+)?)?)$/;
      if (!validFormats.test(pointer)) {
        return `Error: Invalid pointer format. Expected: thread:id#fragment, file:path:lines, or cmd:id`;
      }

      const result = await manager.pointerResolver.resolve(pointer);

      if (result === null) {
        // resolve() returned null — pointer parsed but content unavailable
        if (pointer.startsWith('thread:')) {
          const id = pointer.replace(/^thread:/, '').split('#')[0];
          return `Error: Thread '${id}' not found in archive`;
        }
        if (pointer.startsWith('file:')) {
          const path = pointer.replace(/^file:/, '').split(':')[0];
          return `Error: File '${path}' does not exist`;
        }
        return `Error: Could not resolve pointer '${pointer}'`;
      }

      // PointerResolver itself returns error strings for quota / invalid format
      // but we handle those above. Any remaining string is resolved content.
      if (result.startsWith('[Resolution quota exceeded')) {
        const used = 3 - manager.pointerResolver.remaining();
        return `Error: Pointer resolution quota exceeded (${used}/3 used for this task)`;
      }

      if (result.startsWith('[Invalid pointer format')) {
        return `Error: Invalid pointer format. Expected: thread:id#fragment, file:path:lines, or cmd:id`;
      }

      log(`[packet-manager] resolve_pointer: ${pointer}`, {
        remaining: manager.pointerResolver.remaining(),
      });

      return result;
    },
  });

  return { delegate_task, packet_context, resolve_pointer };
}

export type { PacketV1, ValidatedPacket };
