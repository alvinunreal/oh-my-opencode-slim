import { describe, expect, test, beforeEach, mock, spyOn, afterEach } from "bun:test";
import { 
  createBackgroundTools, 
  resolveSessionId, 
  createSession, 
  sendPrompt, 
  pollSession, 
  extractResponseText 
} from "./background.ts";
import { BackgroundTaskManager } from "../features/background-manager";
import type { PluginInput } from "@opencode-ai/plugin";
import { 
  POLL_INTERVAL_MS, 
  MAX_POLL_TIME_MS, 
  STABLE_POLLS_THRESHOLD 
} from "../config";

// Mock the PluginInput context
function createMockContext(overrides: any = {}) {
  return {
    client: {
      session: {
        create: mock(async () => ({ data: { id: "new-session-id" } })),
        get: mock(async () => ({ data: { id: "existing-session-id", directory: "/parent/dir" } })),
        status: mock(async () => ({ data: { "new-session-id": { type: "idle" } } })),
        messages: mock(async () => ({ data: [] })),
        prompt: mock(async () => ({})),
      },
    },
    directory: "/current/dir",
    ...overrides,
  } as unknown as PluginInput;
}

// Mock BackgroundTaskManager
function createMockManager() {
  const tasks = new Map<string, any>();
  return {
    launch: mock(async (opts: any) => {
      const task = {
        id: "bg_123",
        agent: opts.agent,
        prompt: opts.prompt,
        description: opts.description,
        status: "running",
        startedAt: new Date(),
      };
      tasks.set(task.id, task);
      return task;
    }),
    getResult: mock(async (id: string, block?: boolean, timeout?: number) => {
      return tasks.get(id) || null;
    }),
    cancel: mock((id?: string) => {
      if (id) {
        if (tasks.has(id)) {
          tasks.delete(id);
          return 1;
        }
        return 0;
      }
      const count = tasks.size;
      tasks.clear();
      return count;
    }),
  } as unknown as BackgroundTaskManager;
}

describe("Background Tools", () => {
  let ctx: PluginInput;
  let manager: BackgroundTaskManager;
  let tools: any;

  beforeEach(() => {
    ctx = createMockContext();
    manager = createMockManager();
    tools = createBackgroundTools(ctx, manager);
  });

  describe("background_task", () => {
    test("launches a background task in async mode", async () => {
      const result = await tools.background_task.execute(
        {
          agent: "explorer",
          prompt: "find files",
          description: "finding files",
          sync: false,
        },
        { sessionID: "parent-session-id" }
      );

      expect(manager.launch).toHaveBeenCalledWith({
        agent: "explorer",
        prompt: "find files",
        description: "finding files",
        parentSessionId: "parent-session-id",
      });
      expect(result).toContain("Background task launched");
      expect(result).toContain("Task ID: bg_123");
    });

    test("executes a task in sync mode", async () => {
      // Setup mock responses for sync execution
      (ctx.client.session.messages as any).mockImplementation(async () => ({
        data: [
          { info: { role: "assistant" }, parts: [{ type: "text", text: "Task result" }] },
        ],
      }));

      const result = await tools.background_task.execute(
        {
          agent: "explorer",
          prompt: "find files",
          description: "finding files",
          sync: true,
        },
        { sessionID: "parent-session-id", abort: new AbortController().signal }
      );

      expect(ctx.client.session.create).toHaveBeenCalled();
      expect(ctx.client.session.prompt).toHaveBeenCalled();
      expect(result).toContain("Task result");
      expect(result).toContain("session_id: new-session-id");
    });

    test("returns error message if session resolution fails", async () => {
        (ctx.client.session.get as any).mockResolvedValue({ error: "Get failed" });
        const result = await tools.background_task.execute(
          { agent: "explorer", prompt: "test", description: "test", sync: true, session_id: "invalid" },
          { sessionID: "p1" } as any
        );
        expect(result).toContain("Error: Failed to get session: Get failed");
    });

    test("returns error message if prompt sending fails", async () => {
        (ctx.client.session.prompt as any).mockRejectedValue(new Error("Prompt failed"));
        const result = await tools.background_task.execute(
          { agent: "explorer", prompt: "test", description: "test", sync: true },
          { sessionID: "p1", abort: new AbortController().signal } as any
        );
        expect(result).toContain("Error: Failed to send prompt: Prompt failed");
        expect(result).toContain("<task_metadata>");
    });

    test("handles task abort in sync mode", async () => {
        (ctx.client.session.status as any).mockImplementation(async () => {
            return { data: { "new-session-id": { type: "busy" } } };
        });
        const controller = new AbortController();
        
        // Trigger abort after a short delay
        setTimeout(() => controller.abort(), 100);

        const result = await tools.background_task.execute(
            { agent: "explorer", prompt: "test", description: "test", sync: true },
            { sessionID: "p1", abort: controller.signal } as any
        );
        expect(result).toContain("Task aborted.");
    });

    test("handles timeout in sync mode", async () => {
        // Mock pollSession to return timeout
        // We can't easily mock pollSession if we are testing through background_task.execute
        // because it's an internal function. 
        // But since we exported it, we could try to mock it if we use a different approach,
        // or just mock the dependencies of pollSession to force a timeout.
        
        // Actually, we can just mock Date.now inside the test.
        const originalNow = Date.now;
        let calls = 0;
        Date.now = () => {
            calls++;
            if (calls > 5) return originalNow() + MAX_POLL_TIME_MS + 1000;
            return originalNow();
        };

        try {
            const result = await tools.background_task.execute(
                { agent: "explorer", prompt: "test", description: "test", sync: true },
                { sessionID: "p1", abort: new AbortController().signal } as any
            );
            expect(result).toContain("Error: Agent timed out");
        } finally {
            Date.now = originalNow;
        }
    });

    test("returns error if pollSession fails", async () => {
        // Force pollSession to return error by mocking status to fail
        (ctx.client.session.status as any).mockResolvedValue({ error: "Poll failed" });
        const result = await tools.background_task.execute(
          { agent: "explorer", prompt: "test", description: "test", sync: true },
          { sessionID: "p1", abort: new AbortController().signal } as any
        );
        expect(result).toContain("Error: Failed to get session status: Poll failed");
    });

    test("returns error if messages retrieval fails after polling", async () => {
        (ctx.client.session.messages as any).mockResolvedValue({ error: "Messages failed" });
        // First few calls to status/messages in pollSession need to succeed
        let calls = 0;
        (ctx.client.session.messages as any).mockImplementation(async () => {
            calls++;
            if (calls <= STABLE_POLLS_THRESHOLD + 1) return { data: [{}] }; // Stable count for polling
            return { error: "Messages failed" }; // Fail after polling
        });

        const result = await tools.background_task.execute(
          { agent: "explorer", prompt: "test", description: "test", sync: true },
          { sessionID: "p1", abort: new AbortController().signal } as any
        );
        expect(result).toContain("Error: Failed to get messages: Messages failed");
    });

    test("returns error if no response text extracted", async () => {
        // Return only user messages so extractResponseText returns empty
        (ctx.client.session.messages as any).mockResolvedValue({ data: [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }] });
        const result = await tools.background_task.execute(
          { agent: "explorer", prompt: "test", description: "test", sync: true },
          { sessionID: "p1", abort: new AbortController().signal } as any
        );
        expect(result).toContain("Error: No response from agent.");
    });

    test("throws error if sessionID is missing in toolContext", async () => {
        await expect(tools.background_task.execute(
            { agent: "explorer", prompt: "test", description: "test" },
            {} as any
        )).rejects.toThrow("Invalid toolContext: missing sessionID");
    });
  });

  describe("background_output", () => {
    test("returns task output", async () => {
      const task = {
        id: "bg_123",
        description: "test task",
        status: "completed",
        startedAt: new Date(Date.now() - 5000),
        completedAt: new Date(),
        result: "Success!",
      };
      (manager.getResult as any).mockResolvedValue(task);

      const result = await tools.background_output.execute({ task_id: "bg_123" });

      expect(result).toContain("Task: bg_123");
      expect(result).toContain("Status: completed");
      expect(result).toContain("Success!");
    });

    test("returns error if task not found", async () => {
      (manager.getResult as any).mockResolvedValue(null);
      const result = await tools.background_output.execute({ task_id: "non-existent" });
      expect(result).toBe("Task not found: non-existent");
    });

    test("shows running status if not completed", async () => {
        const task = {
            id: "bg_123",
            description: "test task",
            status: "running",
            startedAt: new Date(),
        };
        (manager.getResult as any).mockResolvedValue(task);
  
        const result = await tools.background_output.execute({ task_id: "bg_123" });
        expect(result).toContain("Status: running");
        expect(result).toContain("(Task still running)");
    });

    test("shows error if task failed", async () => {
        const task = {
            id: "bg_123",
            description: "test task",
            status: "failed",
            startedAt: new Date(),
            error: "Something went wrong",
        };
        (manager.getResult as any).mockResolvedValue(task);
  
        const result = await tools.background_output.execute({ task_id: "bg_123" });
        expect(result).toContain("Status: failed");
        expect(result).toContain("Error: Something went wrong");
    });
  });

  describe("background_cancel", () => {
    test("cancels all tasks", async () => {
      (manager.cancel as any).mockReturnValue(5);
      const result = await tools.background_cancel.execute({ all: true });
      expect(result).toBe("Cancelled 5 running task(s).");
      expect(manager.cancel).toHaveBeenCalledWith();
    });

    test("cancels specific task", async () => {
      (manager.cancel as any).mockReturnValue(1);
      const result = await tools.background_cancel.execute({ task_id: "bg_123" });
      expect(result).toBe("Cancelled task bg_123.");
      expect(manager.cancel).toHaveBeenCalledWith("bg_123");
    });

    test("returns not found for specific task", async () => {
        (manager.cancel as any).mockReturnValue(0);
        const result = await tools.background_cancel.execute({ task_id: "bg_123" });
        expect(result).toBe("Task bg_123 not found or not running.");
    });

    test("requires task_id or all", async () => {
        const result = await tools.background_cancel.execute({});
        expect(result).toBe("Specify task_id or use all=true.");
    });
  });

  describe("resolveSessionId", () => {
    test("validates and returns existing session ID", async () => {
      const result = await resolveSessionId(ctx, { sessionID: "p1" } as any, "desc", "agent", undefined, "existing-id");
      expect(ctx.client.session.get).toHaveBeenCalledWith({ path: { id: "existing-id" } });
      expect(result.sessionID).toBe("existing-id");
    });

    test("returns error if existing session not found", async () => {
      (ctx.client.session.get as any).mockResolvedValue({ error: "Not found" });
      const result = await resolveSessionId(ctx, { sessionID: "p1" } as any, "desc", "agent", undefined, "invalid-id");
      expect(result.error).toContain("Failed to get session");
    });

    test("creates new session if no existing ID provided", async () => {
      const result = await resolveSessionId(ctx, { sessionID: "p1" } as any, "desc", "agent");
      expect(ctx.client.session.create).toHaveBeenCalled();
      expect(result.sessionID).toBe("new-session-id");
    });
  });

  describe("createSession", () => {
    test("inherits parent directory", async () => {
      (ctx.client.session.get as any).mockResolvedValue({ data: { directory: "/inherited/dir" } });
      const result = await createSession(ctx, { sessionID: "parent-id" } as any, "desc", "agent");
      
      expect(ctx.client.session.create).toHaveBeenCalledWith(expect.objectContaining({
        query: { directory: "/inherited/dir" }
      }));
      expect(result.sessionID).toBe("new-session-id");
    });

    test("uses default directory if parent lookup fails", async () => {
      (ctx.client.session.get as any).mockRejectedValue(new Error("Fail"));
      const result = await createSession(ctx, { sessionID: "parent-id" } as any, "desc", "agent");
      
      expect(ctx.client.session.create).toHaveBeenCalledWith(expect.objectContaining({
        query: { directory: "/current/dir" }
      }));
    });

    test("respects tmux enabled delay", async () => {
        const start = Date.now();
        await createSession(ctx, { sessionID: "p1" } as any, "desc", "agent", { enabled: true } as any);
        const duration = Date.now() - start;
        expect(duration).toBeGreaterThanOrEqual(500);
    });
  });

  describe("sendPrompt", () => {
    test("sends prompt with variant resolution", async () => {
      const pluginConfig = {
        agents: {
            agent: { variant: "pro" }
        }
      } as any;
      const result = await sendPrompt(ctx, "s1", "my prompt", "agent", pluginConfig);
      expect(ctx.client.session.prompt).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          agent: "agent",
          variant: "pro"
        })
      }));
      expect(result.error).toBeUndefined();
    });

    test("handles prompt errors", async () => {
      (ctx.client.session.prompt as any).mockRejectedValue(new Error("Prompt failed"));
      const result = await sendPrompt(ctx, "s1", "prompt", "agent");
      expect(result.error).toContain("Failed to send prompt: Prompt failed");
    });
  });

  describe("pollSession", () => {
    test("completes when message count is stable", async () => {
      let calls = 0;
      (ctx.client.session.status as any).mockResolvedValue({ data: { "s1": { type: "idle" } } });
      (ctx.client.session.messages as any).mockImplementation(async () => {
        calls++;
        // First 2 calls return 1 message, next calls return 1 message (stable)
        return { data: new Array(1).fill({}) };
      });

      const result = await pollSession(ctx, "s1", new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(result.timeout).toBeUndefined();
    });

    test("resets stability when status is not idle", async () => {
        let statusCalls = 0;
        (ctx.client.session.status as any).mockImplementation(async () => {
            statusCalls++;
            return { data: { "s1": { type: statusCalls === 1 ? "busy" : "idle" } } };
        });
        (ctx.client.session.messages as any).mockResolvedValue({ data: [{}, {}] });

        // This will take a few more polls because of the busy status
        const result = await pollSession(ctx, "s1", new AbortController().signal);
        expect(result.error).toBeUndefined();
    });

    test("handles abort signal", async () => {
        const controller = new AbortController();
        controller.abort();
        const result = await pollSession(ctx, "s1", controller.signal);
        expect(result.aborted).toBe(true);
    });

    test("handles error getting status", async () => {
        (ctx.client.session.status as any).mockResolvedValue({ error: "Status failed" });
        const result = await pollSession(ctx, "s1", new AbortController().signal);
        expect(result.error).toContain("Failed to get session status: Status failed");
    });

    test("handles error getting messages", async () => {
        (ctx.client.session.status as any).mockResolvedValue({ data: { "s1": { type: "idle" } } });
        (ctx.client.session.messages as any).mockResolvedValue({ error: "Messages failed" });
        const result = await pollSession(ctx, "s1", new AbortController().signal);
        expect(result.error).toContain("Failed to check messages: Messages failed");
    });

    test("times out", async () => {
        // Mock Date.now to simulate timeout
        const originalNow = Date.now;
        let now = 1000;
        Date.now = () => {
            now += MAX_POLL_TIME_MS + 1000;
            return now;
        };
        
        try {
            const result = await pollSession(ctx, "s1", new AbortController().signal);
            expect(result.timeout).toBe(true);
        } finally {
            Date.now = originalNow;
        }
    });
  });

  describe("extractResponseText", () => {
    test("filters assistant messages and extracts content", () => {
      const messages = [
        { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
        { info: { role: "assistant" }, parts: [
            { type: "reasoning", text: "thought" },
            { type: "text", text: "hello" }
        ]},
        { info: { role: "assistant" }, parts: [
            { type: "text", text: "world" },
            { type: "text", text: "" }
        ]}
      ];
      const result = extractResponseText(messages as any);
      expect(result).toBe("thought\n\nhello\n\nworld");
    });

    test("returns empty string if no assistant messages", () => {
      const result = extractResponseText([{ info: { role: "user" } }] as any);
      expect(result).toBe("");
    });
  });
});

