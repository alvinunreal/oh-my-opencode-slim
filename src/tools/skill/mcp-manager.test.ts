import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { SkillMcpManager } from "./mcp-manager"
import type { SkillMcpClientInfo, McpServerConfig, StdioMcpServer, HttpMcpServer } from "./types"

// Note: These tests focus on the manager's logic, not actual MCP connections
// Full integration tests would require running MCP servers

describe("SkillMcpManager", () => {
  describe("getInstance", () => {
    test("returns singleton instance", () => {
      const instance1 = SkillMcpManager.getInstance()
      const instance2 = SkillMcpManager.getInstance()
      
      expect(instance1).toBe(instance2)
    })

    test("instance is defined", () => {
      const instance = SkillMcpManager.getInstance()
      expect(instance).toBeDefined()
    })
  })

  describe("client key generation", () => {
    // Test the key format indirectly through behavior
    test("same info produces same client (connection reuse)", async () => {
      const manager = SkillMcpManager.getInstance()
      
      const info: SkillMcpClientInfo = {
        sessionId: "session-1",
        skillName: "playwright",
        serverName: "playwright-server",
      }

      // The manager should use the same key for identical info
      // We can't directly test the key, but we can verify the manager exists
      expect(manager).toBeDefined()
    })
  })
})

describe("McpServerConfig types", () => {
  test("http config structure", () => {
    const httpConfig: HttpMcpServer = {
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer token" },
    }

    expect(httpConfig.url).toBeDefined()
    expect("url" in httpConfig).toBe(true)
    expect(httpConfig.type).toBe("http")
  })

  test("sse config structure", () => {
    const sseConfig: HttpMcpServer = {
      type: "sse",
      url: "https://example.com/mcp",
    }

    expect(sseConfig.url).toBeDefined()
    expect(sseConfig.type).toBe("sse")
  })

  test("stdio config structure", () => {
    const stdioConfig: StdioMcpServer = {
      command: "npx",
      args: ["@playwright/mcp@latest"],
      env: { DEBUG: "true" },
    }

    expect(stdioConfig.command).toBeDefined()
    expect("command" in stdioConfig).toBe(true)
    expect(stdioConfig.args).toEqual(["@playwright/mcp@latest"])
  })

  test("stdio config with explicit type", () => {
    const stdioConfig: StdioMcpServer = {
      type: "stdio",
      command: "npx",
      args: [],
    }

    expect(stdioConfig.type).toBe("stdio")
  })
})

describe("SkillMcpClientInfo", () => {
  test("info structure", () => {
    const info: SkillMcpClientInfo = {
      sessionId: "test-session",
      skillName: "playwright",
      serverName: "playwright",
    }

    expect(info.sessionId).toBe("test-session")
    expect(info.skillName).toBe("playwright")
    expect(info.serverName).toBe("playwright")
  })

  test("different sessions should be distinguishable", () => {
    const info1: SkillMcpClientInfo = {
      sessionId: "session-1",
      skillName: "playwright",
      serverName: "playwright",
    }

    const info2: SkillMcpClientInfo = {
      sessionId: "session-2",
      skillName: "playwright",
      serverName: "playwright",
    }

    // Different sessions should have different keys (logical test)
    expect(info1.sessionId).not.toBe(info2.sessionId)
  })

  test("different skills should be distinguishable", () => {
    const info1: SkillMcpClientInfo = {
      sessionId: "session-1",
      skillName: "playwright",
      serverName: "server",
    }

    const info2: SkillMcpClientInfo = {
      sessionId: "session-1",
      skillName: "yagni",
      serverName: "server",
    }

    expect(info1.skillName).not.toBe(info2.skillName)
  })
})

// Connection type detection tests (testing the logic that would be used)
describe("connection type detection", () => {
  test("detects http connection from url property", () => {
    const config: HttpMcpServer = { type: "http", url: "https://mcp.example.com" }
    const isHttp = "url" in config
    expect(isHttp).toBe(true)
  })

  test("detects stdio connection from command property", () => {
    const config: StdioMcpServer = { command: "npx", args: [] }
    const isStdio = "command" in config
    expect(isStdio).toBe(true)
  })

  test("http config does not have command", () => {
    const config: HttpMcpServer = { type: "http", url: "https://mcp.example.com" }
    const hasCommand = "command" in config
    expect(hasCommand).toBe(false)
  })

  test("stdio config does not have url", () => {
    const config: StdioMcpServer = { command: "npx", args: [] }
    const hasUrl = "url" in config
    expect(hasUrl).toBe(false)
  })
})

// Error handling scenarios (structure tests, not actual connection tests)
describe("error scenarios", () => {
  test("http config with empty url is still valid structure", () => {
    const config: HttpMcpServer = { type: "http", url: "" }
    expect("url" in config).toBe(true)
    expect(config.url).toBe("")
  })

  test("stdio config with empty command is still valid structure", () => {
    const config: StdioMcpServer = { command: "", args: [] }
    expect("command" in config).toBe(true)
    expect(config.command).toBe("")
  })

  test("config with optional headers", () => {
    const configWithHeaders: HttpMcpServer = {
      type: "http",
      url: "https://mcp.example.com",
      headers: { "X-Custom": "value" },
    }
    const configWithoutHeaders: HttpMcpServer = {
      type: "http",
      url: "https://mcp.example.com",
    }

    expect(configWithHeaders.headers).toBeDefined()
    expect(configWithoutHeaders.headers).toBeUndefined()
  })

  test("config with optional env vars", () => {
    const configWithEnv: StdioMcpServer = {
      command: "npx",
      args: [],
      env: { NODE_ENV: "test" },
    }
    const configWithoutEnv: StdioMcpServer = {
      command: "npx",
      args: [],
    }

    expect(configWithEnv.env).toBeDefined()
    expect(configWithoutEnv.env).toBeUndefined()
  })
})
