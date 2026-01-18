import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { loadPluginConfig } from "./loader"

// Test deepMerge indirectly through loadPluginConfig behavior
// since deepMerge is not exported

describe("loadPluginConfig", () => {
  let tempDir: string
  let userConfigDir: string
  let originalEnv: typeof process.env

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "loader-test-"))
    userConfigDir = path.join(tempDir, "user-config")
    originalEnv = { ...process.env }
    // Isolate from real user config
    process.env.XDG_CONFIG_HOME = userConfigDir
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
    process.env = originalEnv
  })

  test("returns empty config when no config files exist", () => {
    const projectDir = path.join(tempDir, "project")
    fs.mkdirSync(projectDir, { recursive: true })
    const config = loadPluginConfig(projectDir)
    expect(config).toEqual({})
  })

  test("loads project config from .opencode directory", () => {
    const projectDir = path.join(tempDir, "project")
    const projectConfigDir = path.join(projectDir, ".opencode")
    fs.mkdirSync(projectConfigDir, { recursive: true })
    fs.writeFileSync(
      path.join(projectConfigDir, "oh-my-opencode-slim.json"),
      JSON.stringify({
        disabled_agents: ["explorer"],
        agents: {
          oracle: { model: "test/model" },
        },
      })
    )

    const config = loadPluginConfig(projectDir)
    expect(config.disabled_agents).toEqual(["explorer"])
    expect(config.agents?.oracle?.model).toBe("test/model")
  })

  test("ignores invalid config (schema violation or malformed JSON)", () => {
    const projectDir = path.join(tempDir, "project")
    const projectConfigDir = path.join(projectDir, ".opencode")
    fs.mkdirSync(projectConfigDir, { recursive: true })
    
    // Test 1: Invalid temperature (out of range)
    fs.writeFileSync(
      path.join(projectConfigDir, "oh-my-opencode-slim.json"),
      JSON.stringify({ agents: { oracle: { temperature: 5 } } })
    )
    expect(loadPluginConfig(projectDir)).toEqual({})

    // Test 2: Malformed JSON
    fs.writeFileSync(
      path.join(projectConfigDir, "oh-my-opencode-slim.json"),
      "{ invalid json }"
    )
    expect(loadPluginConfig(projectDir)).toEqual({})
  })
})

describe("deepMerge behavior", () => {
  let tempDir: string
  let userConfigDir: string
  let originalEnv: typeof process.env

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-"))
    userConfigDir = path.join(tempDir, "user-config")
    originalEnv = { ...process.env }
    
    // Set XDG_CONFIG_HOME to control user config location
    process.env.XDG_CONFIG_HOME = userConfigDir
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
    process.env = originalEnv
  })

  test("merges nested agent configs from user and project", () => {
    // Create user config
    const userOpencodeDir = path.join(userConfigDir, "opencode")
    fs.mkdirSync(userOpencodeDir, { recursive: true })
    fs.writeFileSync(
      path.join(userOpencodeDir, "oh-my-opencode-slim.json"),
      JSON.stringify({
        agents: {
          oracle: { model: "user/oracle-model", temperature: 0.5 },
          explorer: { model: "user/explorer-model" },
        },
      })
    )

    // Create project config (should override/merge with user)
    const projectDir = path.join(tempDir, "project")
    const projectConfigDir = path.join(projectDir, ".opencode")
    fs.mkdirSync(projectConfigDir, { recursive: true })
    fs.writeFileSync(
      path.join(projectConfigDir, "oh-my-opencode-slim.json"),
      JSON.stringify({
        agents: {
          oracle: { temperature: 0.8 }, // Override temperature only
          designer: { model: "project/designer-model" }, // Add new agent
        },
      })
    )

    const config = loadPluginConfig(projectDir)
    
    // oracle: model from user, temperature from project
    expect(config.agents?.oracle?.model).toBe("user/oracle-model")
    expect(config.agents?.oracle?.temperature).toBe(0.8)
    
    // explorer: from user only
    expect(config.agents?.explorer?.model).toBe("user/explorer-model")
    
    // designer: from project only
    expect(config.agents?.designer?.model).toBe("project/designer-model")
  })

  test("merges nested tmux configs", () => {
    const userOpencodeDir = path.join(userConfigDir, "opencode")
    fs.mkdirSync(userOpencodeDir, { recursive: true })
    fs.writeFileSync(
      path.join(userOpencodeDir, "oh-my-opencode-slim.json"),
      JSON.stringify({
        tmux: {
          enabled: true,
          layout: "main-vertical",
          main_pane_size: 60,
        },
      })
    )

    const projectDir = path.join(tempDir, "project")
    const projectConfigDir = path.join(projectDir, ".opencode")
    fs.mkdirSync(projectConfigDir, { recursive: true })
    fs.writeFileSync(
      path.join(projectConfigDir, "oh-my-opencode-slim.json"),
      JSON.stringify({
        tmux: {
          enabled: false, // Override enabled
          layout: "tiled", // Override layout
        },
      })
    )

    const config = loadPluginConfig(projectDir)
    
    expect(config.tmux?.enabled).toBe(false) // From project (override)
    expect(config.tmux?.layout).toBe("tiled") // From project
    expect(config.tmux?.main_pane_size).toBe(60) // From user (preserved)
  })

  test("preserves user tmux.enabled when project doesn't specify", () => {
    const userOpencodeDir = path.join(userConfigDir, "opencode")
    fs.mkdirSync(userOpencodeDir, { recursive: true })
    fs.writeFileSync(
      path.join(userOpencodeDir, "oh-my-opencode-slim.json"),
      JSON.stringify({
        tmux: {
          enabled: true,
          layout: "main-vertical",
        },
      })
    )

    const projectDir = path.join(tempDir, "project")
    const projectConfigDir = path.join(projectDir, ".opencode")
    fs.mkdirSync(projectConfigDir, { recursive: true })
    fs.writeFileSync(
      path.join(projectConfigDir, "oh-my-opencode-slim.json"),
      JSON.stringify({
        agents: { oracle: { model: "test" } }, // No tmux override
      })
    )

    const config = loadPluginConfig(projectDir)
    
    expect(config.tmux?.enabled).toBe(true) // Preserved from user
    expect(config.tmux?.layout).toBe("main-vertical") // Preserved from user
  })

  test("deduplicates disabled_agents arrays", () => {
    const userOpencodeDir = path.join(userConfigDir, "opencode")
    fs.mkdirSync(userOpencodeDir, { recursive: true })
    fs.writeFileSync(
      path.join(userOpencodeDir, "oh-my-opencode-slim.json"),
      JSON.stringify({
        disabled_agents: ["explorer", "oracle"],
      })
    )

    const projectDir = path.join(tempDir, "project")
    const projectConfigDir = path.join(projectDir, ".opencode")
    fs.mkdirSync(projectConfigDir, { recursive: true })
    fs.writeFileSync(
      path.join(projectConfigDir, "oh-my-opencode-slim.json"),
      JSON.stringify({
        disabled_agents: ["oracle", "designer"], // oracle duplicated
      })
    )

    const config = loadPluginConfig(projectDir)
    
    // Should be deduplicated
    expect(config.disabled_agents?.sort()).toEqual(["designer", "explorer", "oracle"])
  })

  test("project config overrides top-level arrays", () => {
    const userOpencodeDir = path.join(userConfigDir, "opencode")
    fs.mkdirSync(userOpencodeDir, { recursive: true })
    fs.writeFileSync(
      path.join(userOpencodeDir, "oh-my-opencode-slim.json"),
      JSON.stringify({
        disabled_mcps: ["websearch"],
      })
    )

    const projectDir = path.join(tempDir, "project")
    const projectConfigDir = path.join(projectDir, ".opencode")
    fs.mkdirSync(projectConfigDir, { recursive: true })
    fs.writeFileSync(
      path.join(projectConfigDir, "oh-my-opencode-slim.json"),
      JSON.stringify({
        disabled_mcps: ["context7"],
      })
    )

    const config = loadPluginConfig(projectDir)
    
    // disabled_mcps should be from project (overwrites, not merges)
    expect(config.disabled_mcps).toEqual(["context7"])
  })

  test("handles missing user config gracefully", () => {
    // Don't create user config, only project
    const projectDir = path.join(tempDir, "project")
    const projectConfigDir = path.join(projectDir, ".opencode")
    fs.mkdirSync(projectConfigDir, { recursive: true })
    fs.writeFileSync(
      path.join(projectConfigDir, "oh-my-opencode-slim.json"),
      JSON.stringify({
        agents: {
          oracle: { model: "project/model" },
        },
      })
    )

    const config = loadPluginConfig(projectDir)
    expect(config.agents?.oracle?.model).toBe("project/model")
  })

  test("handles missing project config gracefully", () => {
    const userOpencodeDir = path.join(userConfigDir, "opencode")
    fs.mkdirSync(userOpencodeDir, { recursive: true })
    fs.writeFileSync(
      path.join(userOpencodeDir, "oh-my-opencode-slim.json"),
      JSON.stringify({
        agents: {
          oracle: { model: "user/model" },
        },
      })
    )

    // No project config
    const projectDir = path.join(tempDir, "project")
    fs.mkdirSync(projectDir, { recursive: true })

    const config = loadPluginConfig(projectDir)
    expect(config.agents?.oracle?.model).toBe("user/model")
  })
})
