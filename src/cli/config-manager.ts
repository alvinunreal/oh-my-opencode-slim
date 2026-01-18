import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ConfigMergeResult, DetectedConfig, InstallConfig } from "./types"

const PACKAGE_NAME = "oh-my-opencode-slim"

function getConfigDir(): string {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
}

function getConfigJson(): string {
  return join(getConfigDir(), "opencode.json")
}

function getConfigJsonc(): string {
  return join(getConfigDir(), "opencode.jsonc")
}

function getLiteConfig(): string {
  return join(getConfigDir(), "oh-my-opencode-slim.json")
}

function ensureConfigDir(): void {
  const configDir = getConfigDir()
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }
}

/**
 * Strip JSON comments (single-line // and multi-line) and trailing commas for JSONC support.
 * Note: When config files are read and written back, any comments will be lost as
 * JSON.stringify produces standard JSON without comments.
 */
export function stripJsonComments(json: string): string {
  // Regex matches three alternatives (in order):
  //   1. \\\" - Escaped quotes (preserve these)
  //   2. \"(?:\\\"|[^\"])*\" - Complete quoted strings (preserve content including // or /*)
  //   3. (\/\/.*|\/\*[\s\S]*?\*\/) - Single-line or multi-line comments (capture group 1 - strip these)
  //
  // The replace callback: if group 1 exists (comment), replace with empty string; otherwise keep match
  const commentPattern = /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g

  // Remove trailing commas before closing braces or brackets
  // Uses same string-aware pattern to avoid corrupting strings containing ,} or ,]
  const trailingCommaPattern = /\\"|"(?:\\"|[^"])*"|(,)(\s*[}\]])/g

  return json
    .replace(commentPattern, (match, commentGroup) => (commentGroup ? "" : match))
    .replace(trailingCommaPattern, (match, comma, closing) =>
      comma ? closing : match
    )
}

interface OpenCodeConfig {
  plugin?: string[]
  provider?: Record<string, unknown>
  [key: string]: unknown
}

function parseConfigFile(path: string): OpenCodeConfig | null {
  try {
    if (!existsSync(path)) return null
    const stat = statSync(path)
    if (stat.size === 0) return null
    const content = readFileSync(path, "utf-8")
    if (content.trim().length === 0) return null
    return JSON.parse(stripJsonComments(content)) as OpenCodeConfig
  } catch {
    return null
  }
}

function parseConfig(path: string): OpenCodeConfig | null {
  const config = parseConfigFile(path)
  if (config) return config

  if (path.endsWith(".json")) {
    const jsoncPath = path.replace(/\.json$/, ".jsonc")
    return parseConfigFile(jsoncPath)
  }
  return null
}

function getExistingConfigPath(): string {
  const jsonPath = getConfigJson()
  if (existsSync(jsonPath)) return jsonPath
  
  const jsoncPath = getConfigJsonc()
  if (existsSync(jsoncPath)) return jsoncPath
  
  return jsonPath
}

/**
 * Write config to file with proper warning if writing to .jsonc file.
 * Note: Comments in JSONC files will be lost as JSON.stringify produces standard JSON.
 */
function writeConfig(configPath: string, config: OpenCodeConfig): void {
  if (configPath.endsWith(".jsonc")) {
    console.warn(
      "[config-manager] Writing to .jsonc file - comments will not be preserved"
    )
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
}

export async function isOpenCodeInstalled(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["opencode", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}

export async function isTmuxInstalled(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "-V"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}

export async function getOpenCodeVersion(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["opencode", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = await new Response(proc.stdout).text()
    await proc.exited
    return proc.exitCode === 0 ? output.trim() : null
  } catch {
    return null
  }
}

export async function fetchLatestVersion(packageName: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`)
    if (!res.ok) return null
    const data = (await res.json()) as { version: string }
    return data.version
  } catch {
    return null
  }
}

export async function addPluginToOpenCodeConfig(): Promise<ConfigMergeResult> {
  try {
    ensureConfigDir()
  } catch (err) {
    return {
      success: false,
      configPath: getConfigDir(),
      error: `Failed to create config directory: ${err}`,
    }
  }

  const configPath = getExistingConfigPath()

  try {
    let config = parseConfig(configPath) ?? {}
    const plugins = config.plugin ?? []

    // Remove existing oh-my-opencode-slim entries
    const filteredPlugins = plugins.filter(
      (p) => p !== PACKAGE_NAME && !p.startsWith(`${PACKAGE_NAME}@`)
    )

    // Add fresh entry
    filteredPlugins.push(PACKAGE_NAME)
    config.plugin = filteredPlugins

    writeConfig(configPath, config)
    return { success: true, configPath }
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to update opencode config: ${err}`,
    }
  }
}

export async function addAuthPlugins(installConfig: InstallConfig): Promise<ConfigMergeResult> {
  const configPath = getExistingConfigPath()

  try {
    ensureConfigDir()
    let config = parseConfig(configPath) ?? {}
    const plugins = config.plugin ?? []

    if (installConfig.hasAntigravity) {
      const version = await fetchLatestVersion("opencode-antigravity-auth")
      const pluginEntry = version
        ? `opencode-antigravity-auth@${version}`
        : "opencode-antigravity-auth@latest"

      if (!plugins.some((p) => p.startsWith("opencode-antigravity-auth"))) {
        plugins.push(pluginEntry)
      }
    }

    config.plugin = plugins
    writeConfig(configPath, config)
    return { success: true, configPath }
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to add auth plugins: ${err}`,
    }
  }
}

/**
 * Provider configurations for Google models (via Antigravity auth plugin)
 */
const GOOGLE_PROVIDER_CONFIG = {
  google: {
    name: "Google",
    models: {
      "gemini-3-pro-high": {
        name: "Gemini 3 Pro High",
        thinking: true,
        attachment: true,
        limit: { context: 1048576, output: 65535 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      },
      "gemini-3-flash": {
        name: "Gemini 3 Flash",
        attachment: true,
        limit: { context: 1048576, output: 65536 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      },
      "claude-opus-4-5-thinking": {
        name: "Claude Opus 4.5 Thinking",
        attachment: true,
        limit: { context: 200000, output: 32000 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      },
      "claude-sonnet-4-5-thinking": {
        name: "Claude Sonnet 4.5 Thinking",
        attachment: true,
        limit: { context: 200000, output: 32000 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      },
    },
  },
}

export function addProviderConfig(installConfig: InstallConfig): ConfigMergeResult {
  const configPath = getExistingConfigPath()

  try {
    ensureConfigDir()
    let config = parseConfig(configPath) ?? {}

    if (installConfig.hasAntigravity) {
      const providers = (config.provider ?? {}) as Record<string, unknown>
      providers.google = GOOGLE_PROVIDER_CONFIG.google
      config.provider = providers
    }

    writeConfig(configPath, config)
    return { success: true, configPath }
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to add provider config: ${err}`,
    }
  }
}

/**
 * Add server configuration to opencode.json for tmux integration
 */
export function addServerConfig(installConfig: InstallConfig): ConfigMergeResult {
  const configPath = getExistingConfigPath()

  try {
    ensureConfigDir()
    let config = parseConfig(configPath) ?? {}

    if (installConfig.hasTmux) {
      const server = (config.server ?? {}) as Record<string, unknown>
      // Only set port if not already configured
      if (server.port === undefined) {
        server.port = 4096
      }
      config.server = server
    }

    writeConfig(configPath, config)
    return { success: true, configPath }
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to add server config: ${err}`,
    }
  }
}

// Model mappings by provider priority
const MODEL_MAPPINGS = {
  antigravity: {
    orchestrator: "google/claude-opus-4-5-thinking",
    "code-simplicity-reviewer": "google/claude-opus-4-5-thinking",
    oracle: "google/claude-opus-4-5-thinking",
    librarian: "google/gemini-3-flash",
    explore: "google/gemini-3-flash",
    "frontend-ui-ux-engineer": "google/gemini-3-flash",
    "document-writer": "google/gemini-3-flash",
    "multimodal-looker": "google/gemini-3-flash",
  },
  openai: {
    orchestrator: "openai/gpt-5.2-codex",
    "code-simplicity-reviewer": "openai/gpt-5.2-codex",
    oracle: "openai/gpt-5.2-codex",
    librarian: "openai/gpt-4.1-mini",
    explore: "openai/gpt-4.1-mini",
    "frontend-ui-ux-engineer": "openai/gpt-4.1-mini",
    "document-writer": "openai/gpt-4.1-mini",
    "multimodal-looker": "openai/gpt-4.1-mini",
  },
  cerebras: {
    orchestrator: "cerebras/zai-glm-4.6",
    "code-simplicity-reviewer": "cerebras/zai-glm-4.6",
    oracle: "cerebras/zai-glm-4.6",
    librarian: "cerebras/zai-glm-4.6",
    explore: "cerebras/zai-glm-4.6",
    "frontend-ui-ux-engineer": "cerebras/zai-glm-4.6",
    "document-writer": "cerebras/zai-glm-4.6",
    "multimodal-looker": "cerebras/zai-glm-4.6",
  },
} as const;

export function generateLiteConfig(installConfig: InstallConfig): Record<string, unknown> {
  // Determine base provider
  const baseProvider = installConfig.hasAntigravity
    ? "antigravity"
    : installConfig.hasOpenAI
      ? "openai"
      : installConfig.hasCerebras
        ? "cerebras"
        : null;

  const config: Record<string, unknown> = { agents: {} };

  if (baseProvider) {
    // Start with base provider models
    const agents: Record<string, { model: string }> = Object.fromEntries(
      Object.entries(MODEL_MAPPINGS[baseProvider]).map(([k, v]) => [k, { model: v }])
    );

    // Apply provider-specific overrides for mixed configurations
    if (installConfig.hasAntigravity) {
      if (installConfig.hasOpenAI) {
        agents["oracle"] = { model: "openai/gpt-5.2-codex" };
      }
      if (installConfig.hasCerebras) {
        agents["explore"] = { model: "cerebras/zai-glm-4.6" };
      }
    } else if (installConfig.hasOpenAI && installConfig.hasCerebras) {
      agents["explore"] = { model: "cerebras/zai-glm-4.6" };
    }
    config.agents = agents;
  }

  if (installConfig.hasTmux) {
    config.tmux = {
      enabled: true,
      layout: "main-vertical",
      main_pane_size: 60,
    };
  }

  return config;
}

export function writeLiteConfig(installConfig: InstallConfig): ConfigMergeResult {
  const configPath = getLiteConfig()

  try {
    ensureConfigDir()
    const config = generateLiteConfig(installConfig)
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
    return { success: true, configPath }
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to write lite config: ${err}`,
    }
  }
}

/**
 * Disable OpenCode's default subagents since the plugin provides its own
 */
export function disableDefaultAgents(): ConfigMergeResult {
  const configPath = getExistingConfigPath()

  try {
    ensureConfigDir()
    let config = parseConfig(configPath) ?? {}

    const agent = (config.agent ?? {}) as Record<string, unknown>
    agent.explore = { disable: true }
    agent.general = { disable: true }
    config.agent = agent

    writeConfig(configPath, config)
    return { success: true, configPath }
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to disable default agents: ${err}`,
    }
  }
}

export function detectCurrentConfig(): DetectedConfig {
  const result: DetectedConfig = {
    isInstalled: false,
    hasAntigravity: false,
    hasOpenAI: false,
    hasCerebras: false,
    hasTmux: false,
  }

  const config = parseConfig(getExistingConfigPath())
  if (!config) return result

  const plugins = config.plugin ?? []
  result.isInstalled = plugins.some((p) => p.startsWith(PACKAGE_NAME))
  result.hasAntigravity = plugins.some((p) => p.startsWith("opencode-antigravity-auth"))

  // Try to detect from lite config
  const liteConfig = parseConfig(getLiteConfig())
  if (liteConfig && typeof liteConfig === "object") {
    const configObj = liteConfig as Record<string, any>
    const agents = configObj.agents as Record<string, { model?: string }> | undefined

    if (agents) {
      const models = Object.values(agents)
        .map((a) => a?.model)
        .filter(Boolean)
      result.hasOpenAI = models.some((m) => m?.startsWith("openai/"))
      result.hasCerebras = models.some((m) => m?.startsWith("cerebras/"))
    }

    if (configObj.tmux && typeof configObj.tmux === "object") {
      result.hasTmux = configObj.tmux.enabled === true
    }
  }

  return result
}
