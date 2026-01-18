import { describe, expect, test } from "bun:test"
import { SkillMcpManager } from "./mcp-manager"

describe("SkillMcpManager", () => {
  test("returns singleton instance", () => {
    const instance1 = SkillMcpManager.getInstance()
    const instance2 = SkillMcpManager.getInstance()
    
    expect(instance1).toBe(instance2)
    expect(instance1).toBeDefined()
  })
})

// Note: Connection and tool-calling tests require actual MCP servers
// and are better suited for integration tests, not unit tests.
