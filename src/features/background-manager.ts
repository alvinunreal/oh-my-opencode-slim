import type { PluginInput } from "@opencode-ai/plugin";
import { POLL_INTERVAL_BACKGROUND_MS, POLL_INTERVAL_SLOW_MS } from "../config";
import type { TmuxConfig } from "../config/schema";
import type { PluginConfig } from "../config";
import { applyAgentVariant, resolveAgentVariant } from "../utils";
import { log } from "../shared/logger";
type PromptBody = {
  messageID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  noReply?: boolean;
  system?: string;
  tools?: { [key: string]: boolean };
  parts: Array<{ type: "text"; text: string }>;
  variant?: string;
};

type OpencodeClient = PluginInput["client"];

export interface BackgroundTask {
  id: string;
  sessionId: string;
  description: string;
  agent: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: string;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
}

export interface LaunchOptions {
  agent: string;
  prompt: string;
  description: string;
  parentSessionId: string;
  model?: string;
}

function generateTaskId(): string {
  return `bg_${Math.random().toString(36).substring(2, 10)}`;
}

export class BackgroundTaskManager {
  private tasks = new Map<string, BackgroundTask>();
  private client: OpencodeClient;
  private directory: string;
  private pollInterval?: ReturnType<typeof setInterval>;
  private tmuxEnabled: boolean;
  private config?: PluginConfig;
  private serverUrl: URL;

  constructor(ctx: PluginInput, tmuxConfig?: TmuxConfig, config?: PluginConfig) {
    this.client = ctx.client;
    this.directory = ctx.directory;
    this.serverUrl = ctx.serverUrl;
    this.tmuxEnabled = tmuxConfig?.enabled ?? false;
    this.config = config;
  }

  async launch(opts: LaunchOptions): Promise<BackgroundTask> {
    const session = await this.client.session.create({
      body: {
        parentID: opts.parentSessionId,
        title: `Background: ${opts.description}`,
      },
      query: { directory: this.directory },
    });

    if (!session.data?.id) {
      throw new Error("Failed to create background session");
    }

    const task: BackgroundTask = {
      id: generateTaskId(),
      sessionId: session.data.id,
      description: opts.description,
      agent: opts.agent,
      status: "running",
      startedAt: new Date(),
    };

    this.tasks.set(task.id, task);
    this.startPolling();

    // Give TmuxSessionManager time to spawn the pane via event hook
    // before we send the prompt (so the TUI can receive streaming updates)
    if (this.tmuxEnabled) {
      await new Promise((r) => setTimeout(r, 500));
    }

    const promptQuery: Record<string, string> = {
      directory: this.directory,
    };
    if (opts.model) {
      promptQuery.model = opts.model;
    }

    log(`[background-manager] launching task for agent="${opts.agent}"`, { description: opts.description });
    const resolvedVariant = resolveAgentVariant(this.config, opts.agent);
    const promptBody = applyAgentVariant(resolvedVariant, {
      agent: opts.agent,
      tools: { background_task: false, task: false },
      parts: [{ type: "text" as const, text: opts.prompt }],
    } as PromptBody) as unknown as {
      messageID?: string;
      model?: { providerID: string; modelID: string };
      agent?: string;
      noReply?: boolean;
      system?: string;
      tools?: { [key: string]: boolean };
      parts: Array<{ type: "text"; text: string }>;
      variant?: string;
    };


    await this.client.session.prompt({
      path: { id: session.data.id },
      body: promptBody,
      query: promptQuery,
    });

    return task;
  }

  async getResult(taskId: string, block = false, timeout = 120000): Promise<BackgroundTask | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    if (!block || task.status === "completed" || task.status === "failed") {
      return task;
    }

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await this.pollTask(task);
      const status = task.status as string;
      if (status === "completed" || status === "failed") {
        return task;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_SLOW_MS));
    }

    return task;
  }

  cancel(taskId?: string): number {
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (task && task.status === "running") {
        task.status = "failed";
        task.error = "Cancelled by user";
        task.completedAt = new Date();
        return 1;
      }
      return 0;
    }

    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        task.status = "failed";
        task.error = "Cancelled by user";
        task.completedAt = new Date();
        count++;
      }
    }
    return count;
  }

  private startPolling() {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => this.pollAllTasks(), POLL_INTERVAL_BACKGROUND_MS);
  }

  private async pollAllTasks() {
    const runningTasks = [...this.tasks.values()].filter((t) => t.status === "running");
    if (runningTasks.length === 0 && this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
      return;
    }

    for (const task of runningTasks) {
      await this.pollTask(task);
    }
  }

  private async pollTask(task: BackgroundTask) {
    try {
      // Check session status first
      const statusResult = await this.client.session.status();
      const allStatuses = (statusResult.data ?? {}) as Record<string, { type: string }>;
      const sessionStatus = allStatuses[task.sessionId];

      // If session is still active (not idle), don't try to read messages yet
      if (sessionStatus && sessionStatus.type !== "idle") {
        return;
      }

      // Get messages using correct API
      const messagesResult = await this.client.session.messages({ path: { id: task.sessionId } });
      const messages = (messagesResult.data ?? messagesResult) as Array<{ info?: { role: string }; parts?: Array<{ type: string; text?: string }> }>;
      const assistantMessages = messages.filter((m) => m.info?.role === "assistant");

      if (assistantMessages.length === 0) {
        return; // No response yet
      }

      // Extract text from all assistant messages
      const extractedContent: string[] = [];
      for (const message of assistantMessages) {
        for (const part of message.parts ?? []) {
          if ((part.type === "text" || part.type === "reasoning") && part.text) {
            extractedContent.push(part.text);
          }
        }
      }

      const responseText = extractedContent.filter((t) => t.length > 0).join("\n\n");
      
      // Even if responseText is empty, if it's idle, it's done.
      // The Global Reaper in index.ts will also catch this, but we handle it here for completeness.
      task.result = responseText || "(No text response)";
      task.status = "completed";
      task.completedAt = new Date();
      
      log(`[background-manager] task completed`, { taskId: task.id, sessionId: task.sessionId });
    } catch (error) {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.completedAt = new Date();
      // Pane closing is handled by TmuxSessionManager via polling
    }
  }
}
