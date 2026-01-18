import { describe, expect, test, beforeEach, mock } from "bun:test"
import { BackgroundTaskManager, type BackgroundTask, type LaunchOptions } from "./background-manager"

// Mock the plugin context
function createMockContext(overrides?: {
  sessionCreateResult?: { data?: { id?: string } }
  sessionStatusResult?: { data?: Record<string, { type: string }> }
  sessionMessagesResult?: { data?: Array<{ info?: { role: string }; parts?: Array<{ type: string; text?: string }> }> }
}) {
  return {
    client: {
      session: {
        create: mock(async () => overrides?.sessionCreateResult ?? { data: { id: "test-session-id" } }),
        status: mock(async () => overrides?.sessionStatusResult ?? { data: {} }),
        messages: mock(async () => overrides?.sessionMessagesResult ?? { data: [] }),
        prompt: mock(async () => ({})),
      },
    },
    directory: "/test/directory",
  } as any
}

describe("BackgroundTaskManager", () => {
  describe("constructor", () => {
    test("creates manager with tmux disabled by default", () => {
      const ctx = createMockContext()
      const manager = new BackgroundTaskManager(ctx)
      // Manager should be created without errors
      expect(manager).toBeDefined()
    })

    test("creates manager with tmux config", () => {
      const ctx = createMockContext()
      const manager = new BackgroundTaskManager(ctx, { enabled: true, layout: "main-vertical", main_pane_size: 60 })
      expect(manager).toBeDefined()
    })
  })

  describe("launch", () => {
    test("creates new session and task", async () => {
      const ctx = createMockContext()
      const manager = new BackgroundTaskManager(ctx)

      const task = await manager.launch({
        agent: "explorer",
        prompt: "Find all test files",
        description: "Test file search",
        parentSessionId: "parent-123",
      })

      expect(task.id).toMatch(/^bg_/)
      expect(task.sessionId).toBe("test-session-id")
      expect(task.agent).toBe("explorer")
      expect(task.description).toBe("Test file search")
      expect(task.status).toBe("running")
      expect(task.startedAt).toBeDefined()
    })

    test("throws when session creation fails", async () => {
      const ctx = createMockContext({ sessionCreateResult: { data: {} } })
      const manager = new BackgroundTaskManager(ctx)

      await expect(
        manager.launch({
          agent: "explorer",
          prompt: "test",
          description: "test",
          parentSessionId: "parent-123",
        })
      ).rejects.toThrow("Failed to create background session")
    })

    test("passes model to prompt when provided", async () => {
      const ctx = createMockContext()
      const manager = new BackgroundTaskManager(ctx)

      await manager.launch({
        agent: "explorer",
        prompt: "test",
        description: "test",
        parentSessionId: "parent-123",
        model: "custom/model",
      })

      expect(ctx.client.session.prompt).toHaveBeenCalled()
    })
  })

  describe("getResult", () => {
    test("returns null for unknown task", async () => {
      const ctx = createMockContext()
      const manager = new BackgroundTaskManager(ctx)

      const result = await manager.getResult("unknown-task-id")
      expect(result).toBeNull()
    })

    test("returns task immediately when not blocking", async () => {
      const ctx = createMockContext()
      const manager = new BackgroundTaskManager(ctx)

      const task = await manager.launch({
        agent: "explorer",
        prompt: "test",
        description: "test",
        parentSessionId: "parent-123",
      })

      const result = await manager.getResult(task.id, false)
      expect(result).toBeDefined()
      expect(result?.id).toBe(task.id)
    })

    test("returns completed task immediately even when blocking", async () => {
      const ctx = createMockContext({
        sessionStatusResult: { data: { "test-session-id": { type: "idle" } } },
        sessionMessagesResult: {
          data: [
            { info: { role: "assistant" }, parts: [{ type: "text", text: "Result text" }] },
          ],
        },
      })
      const manager = new BackgroundTaskManager(ctx)

      const task = await manager.launch({
        agent: "explorer",
        prompt: "test",
        description: "test",
        parentSessionId: "parent-123",
      })

      // Wait a bit for polling to complete the task
      await new Promise(r => setTimeout(r, 100))

      const result = await manager.getResult(task.id, true)
      expect(result).toBeDefined()
    })
  })

  describe("cancel", () => {
    test("cancels specific running task", async () => {
      const ctx = createMockContext()
      const manager = new BackgroundTaskManager(ctx)

      const task = await manager.launch({
        agent: "explorer",
        prompt: "test",
        description: "test",
        parentSessionId: "parent-123",
      })

      const count = manager.cancel(task.id)
      expect(count).toBe(1)

      const result = await manager.getResult(task.id)
      expect(result?.status).toBe("failed")
      expect(result?.error).toBe("Cancelled by user")
    })

    test("returns 0 when cancelling unknown task", () => {
      const ctx = createMockContext()
      const manager = new BackgroundTaskManager(ctx)

      const count = manager.cancel("unknown-task-id")
      expect(count).toBe(0)
    })

    test("cancels all running tasks when no ID provided", async () => {
      const ctx = createMockContext()
      // Make each call return a different session ID
      let callCount = 0
      ctx.client.session.create = mock(async () => {
        callCount++
        return { data: { id: `session-${callCount}` } }
      })
      const manager = new BackgroundTaskManager(ctx)

      await manager.launch({
        agent: "explorer",
        prompt: "test1",
        description: "test1",
        parentSessionId: "parent-123",
      })

      await manager.launch({
        agent: "oracle",
        prompt: "test2",
        description: "test2",
        parentSessionId: "parent-123",
      })

      const count = manager.cancel()
      expect(count).toBe(2)
    })

    test("does not cancel already completed tasks", async () => {
      const ctx = createMockContext({
        sessionStatusResult: { data: { "test-session-id": { type: "idle" } } },
        sessionMessagesResult: {
          data: [
            { info: { role: "assistant" }, parts: [{ type: "text", text: "Done" }] },
          ],
        },
      })
      const manager = new BackgroundTaskManager(ctx)

      const task = await manager.launch({
        agent: "explorer",
        prompt: "test",
        description: "test",
        parentSessionId: "parent-123",
      })

      // Use getResult with block=true to wait for completion 
      // This triggers polling immediately rather than relying on interval
      const result = await manager.getResult(task.id, true, 5000)
      expect(result?.status).toBe("completed")

      // Now try to cancel - should fail since already completed
      const count = manager.cancel(task.id)
      expect(count).toBe(0) // Already completed, so not cancelled
    })
  })
})

describe("BackgroundTask state transitions", () => {
  test("task starts in running state", async () => {
    const ctx = createMockContext()
    const manager = new BackgroundTaskManager(ctx)

    const task = await manager.launch({
      agent: "explorer",
      prompt: "test",
      description: "test",
      parentSessionId: "parent-123",
    })

    expect(task.status).toBe("running")
  })

  test("task has completedAt when cancelled", async () => {
    const ctx = createMockContext()
    const manager = new BackgroundTaskManager(ctx)

    const task = await manager.launch({
      agent: "explorer",
      prompt: "test",
      description: "test",
      parentSessionId: "parent-123",
    })

    manager.cancel(task.id)

    const result = await manager.getResult(task.id)
    expect(result?.completedAt).toBeDefined()
  })
})
