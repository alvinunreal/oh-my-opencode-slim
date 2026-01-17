import type { InstallArgs, InstallConfig, BooleanArg, DetectedConfig } from "./types"
import * as readline from "readline"
import {
  addPluginToOpenCodeConfig,
  writeLiteConfig,
  isOpenCodeInstalled,
  getOpenCodeVersion,
  addAuthPlugins,
  addProviderConfig,
  detectCurrentConfig,
  isTmuxInstalled,
  generateLiteConfig,
} from "./config-manager"

// Line reader for TUI mode that handles both TTY and piped input
let lineReader: readline.Interface | null = null
let lineBuffer: string[] = []
let lineResolvers: ((line: string) => void)[] = []

function initLineReader(): void {
  if (lineReader) return

  lineReader = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
  })

  lineReader.on("line", (line) => {
    if (lineResolvers.length > 0) {
      const resolve = lineResolvers.shift()!
      resolve(line)
    } else {
      lineBuffer.push(line)
    }
  })

  lineReader.on("close", () => {
    // Resolve any pending readers with empty string
    while (lineResolvers.length > 0) {
      const resolve = lineResolvers.shift()!
      resolve("")
    }
  })
}

async function readLine(): Promise<string> {
  initLineReader()

  if (lineBuffer.length > 0) {
    return lineBuffer.shift()!
  }

  return new Promise((resolve) => {
    lineResolvers.push(resolve)
  })
}

function closeLineReader(): void {
  if (lineReader) {
    lineReader.close()
    lineReader = null
    lineBuffer = []
    lineResolvers = []
  }
}

const GREEN = "\x1b[32m"
const BLUE = "\x1b[34m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

const SYMBOLS = {
  check: `${GREEN}✓${RESET}`,
  cross: `${RED}✗${RESET}`,
  arrow: `${BLUE}→${RESET}`,
  bullet: `${DIM}•${RESET}`,
  info: `${BLUE}ℹ${RESET}`,
  warn: `${YELLOW}⚠${RESET}`,
  star: `${YELLOW}★${RESET}`,
}

function printHeader(isUpdate: boolean): void {
  const mode = isUpdate ? "Update" : "Install"
  console.log()
  console.log(`${BOLD}oh-my-opencode-slim ${mode}${RESET}`)
  console.log("=".repeat(30))
  console.log()
}

function printStep(step: number, total: number, message: string): void {
  console.log(`${DIM}[${step}/${total}]${RESET} ${message}`)
}

function printSuccess(message: string): void {
  console.log(`${SYMBOLS.check} ${message}`)
}

function printError(message: string): void {
  console.log(`${SYMBOLS.cross} ${RED}${message}${RESET}`)
}

function printInfo(message: string): void {
  console.log(`${SYMBOLS.info} ${message}`)
}

function printWarning(message: string): void {
  console.log(`${SYMBOLS.warn} ${YELLOW}${message}${RESET}`)
}

async function checkOpenCodeInstalled(): Promise<{ ok: boolean; version?: string }> {
  const installed = await isOpenCodeInstalled()
  if (!installed) {
    printError("OpenCode is not installed on this system.")
    printInfo("Install it with:")
    console.log(`     ${BLUE}curl -fsSL https://opencode.ai/install | bash${RESET}`)
    return { ok: false }
  }
  const version = await getOpenCodeVersion()
  printSuccess(`OpenCode ${version ?? ""} detected`)
  return { ok: true, version: version ?? undefined }
}

type StepResult = { success: boolean; error?: string; configPath?: string }

function handleStepResult(result: StepResult, successMsg: string): boolean {
  if (!result.success) {
    printError(`Failed: ${result.error}`)
    return false
  }
  printSuccess(`${successMsg} ${SYMBOLS.arrow} ${DIM}${result.configPath}${RESET}`)
  return true
}

function formatConfigSummary(config: InstallConfig): string {
  const lines: string[] = []
  lines.push(`${BOLD}Configuration Summary${RESET}`)
  lines.push("")
  lines.push(`  ${config.hasAntigravity ? SYMBOLS.check : DIM + "○" + RESET} Antigravity`)
  lines.push(`  ${config.hasOpenAI ? SYMBOLS.check : DIM + "○" + RESET} OpenAI`)
  lines.push(`  ${config.hasCerebras ? SYMBOLS.check : DIM + "○" + RESET} Cerebras`)
  lines.push(`  ${config.hasTmux ? SYMBOLS.check : DIM + "○" + RESET} Tmux Integration`)
  return lines.join("\n")
}

function printAgentModels(config: InstallConfig): void {
  const liteConfig = generateLiteConfig(config)
  const agents = liteConfig.agents as Record<string, { model: string }>
  
  if (!agents || Object.keys(agents).length === 0) return

  console.log(`${BOLD}Agent Model Configuration:${RESET}`)
  console.log()
  
  const maxAgentLen = Math.max(...Object.keys(agents).map(a => a.length))
  
  for (const [agent, info] of Object.entries(agents)) {
    const padding = " ".repeat(maxAgentLen - agent.length)
    console.log(`  ${DIM}${agent}${RESET}${padding} ${SYMBOLS.arrow} ${BLUE}${info.model}${RESET}`)
  }
  console.log()
}

function validateNonTuiArgs(args: InstallArgs): { valid: boolean; errors: string[] } {
  const requiredArgs = ["antigravity", "openai", "cerebras", "tmux"] as const
  const errors = requiredArgs.flatMap((key) => {
    const value = args[key]
    if (value === undefined) return [`--${key} is required (values: yes, no)`]
    if (!["yes", "no"].includes(value)) return [`Invalid --${key} value: ${value} (expected: yes, no)`]
    return []
  })
  return { valid: errors.length === 0, errors }
}

function argsToConfig(args: InstallArgs): InstallConfig {
  return {
    hasAntigravity: args.antigravity === "yes",
    hasOpenAI: args.openai === "yes",
    hasCerebras: args.cerebras === "yes",
    hasTmux: args.tmux === "yes",
  }
}

function detectedToInitialValues(detected: DetectedConfig): {
  antigravity: BooleanArg
  openai: BooleanArg
  cerebras: BooleanArg
  tmux: BooleanArg
} {
  return {
    antigravity: detected.hasAntigravity ? "yes" : "yes", // Default to yes for antigravity as requested
    openai: detected.hasOpenAI ? "yes" : "no",
    cerebras: detected.hasCerebras ? "yes" : "no",
    tmux: detected.hasTmux ? "yes" : "no",
  }
}

async function askYesNo(promptText: string, defaultValue: BooleanArg = "no"): Promise<BooleanArg> {
  const defaultHint = defaultValue === "yes" ? "[Y/n]" : "[y/N]"
  const fullPrompt = `${BLUE}${promptText}${RESET} ${defaultHint}: `

  process.stdout.write(fullPrompt)
  const answer = (await readLine()).trim().toLowerCase()

  if (answer === "") return defaultValue
  if (answer === "y" || answer === "yes") return "yes"
  if (answer === "n" || answer === "no") return "no"
  return defaultValue
}

async function runTuiMode(detected: DetectedConfig): Promise<InstallConfig | null> {
  const initial = detectedToInitialValues(detected)
  const tmuxInstalled = await isTmuxInstalled()

  console.log(`${BOLD}Question 1/${tmuxInstalled ? "4" : "3"}:${RESET}`)
  printInfo(`The Pantheon is tuned for Antigravity's model routing. Other models work, but results may vary.`)
  const antigravity = await askYesNo(
    "Do you have an Antigravity subscription?",
    initial.antigravity
  )
  console.log()

  console.log(`${BOLD}Question 2/${tmuxInstalled ? "4" : "3"}:${RESET}`)
  const openai = await askYesNo("Do you have access to OpenAI API?", initial.openai)
  console.log()

  console.log(`${BOLD}Question 3/${tmuxInstalled ? "4" : "3"}:${RESET}`)
  const cerebras = await askYesNo("Do you have access to Cerebras API?", initial.cerebras)
  console.log()

  let tmux: BooleanArg = "no"
  if (tmuxInstalled) {
    console.log(`${BOLD}Question 4/4:${RESET}`)
    printInfo(`${BOLD}Tmux detected!${RESET} We can enable tmux integration for you.`)
    printInfo(`This will spawn new panes for sub-agents, letting you watch them work in real-time.`)
    tmux = await askYesNo("Enable tmux integration?", initial.tmux)
    console.log()
  }

  closeLineReader()

  return {
    hasAntigravity: antigravity === "yes",
    hasOpenAI: openai === "yes",
    hasCerebras: cerebras === "yes",
    hasTmux: tmux === "yes",
  }
}

async function runInstall(config: InstallConfig): Promise<number> {
  const detected = detectCurrentConfig()
  const isUpdate = detected.isInstalled

  printHeader(isUpdate)

  const totalSteps = config.hasAntigravity ? 5 : 3
  let step = 1

  // Step 1: Check OpenCode
  printStep(step++, totalSteps, "Checking OpenCode installation...")
  const { ok } = await checkOpenCodeInstalled()
  if (!ok) return 1

  // Step 2: Add plugin
  printStep(step++, totalSteps, "Adding oh-my-opencode-slim plugin...")
  const pluginResult = await addPluginToOpenCodeConfig()
  if (!handleStepResult(pluginResult, "Plugin added")) return 1

  // Step 3-4: Auth plugins and provider config (if Antigravity)
  if (config.hasAntigravity) {
    printStep(step++, totalSteps, "Adding auth plugins...")
    const authResult = await addAuthPlugins(config)
    if (!handleStepResult(authResult, "Auth plugins configured")) return 1

    printStep(step++, totalSteps, "Adding provider configurations...")
    const providerResult = addProviderConfig(config)
    if (!handleStepResult(providerResult, "Providers configured")) return 1
  }

  // Step 5: Write lite config
  printStep(step++, totalSteps, "Writing oh-my-opencode-slim configuration...")
  const liteResult = writeLiteConfig(config)
  if (!handleStepResult(liteResult, "Config written")) return 1

  // Summary
  console.log()
  console.log(formatConfigSummary(config))
  console.log()
  
  printAgentModels(config)

  if (!config.hasAntigravity && !config.hasOpenAI && !config.hasCerebras) {
    printWarning("No providers configured. At least one provider is required.")
    return 1
  }

  console.log(`${SYMBOLS.star} ${BOLD}${GREEN}${isUpdate ? "Configuration updated!" : "Installation complete!"}${RESET}`)
  console.log()
  console.log(`${BOLD}Next steps:${RESET}`)
  console.log()
  
  let nextStep = 1
  console.log(`  ${nextStep++}. Authenticate with your providers:`)
  console.log(`     ${BLUE}$ opencode auth login${RESET}`)
  console.log()

  if (config.hasTmux) {
    console.log(`  ${nextStep++}. Enable OpenCode HTTP server for tmux integration:`)
    console.log(`     Add the following to ${DIM}${liteResult.configPath.replace("oh-my-opencode-slim.json", "opencode.json")}${RESET}:`)
    console.log(`     ${BLUE}{ "server": { "port": 4096 } }${RESET}`)
    console.log()
    console.log(`  ${nextStep++}. Run OpenCode inside tmux:`)
    console.log(`     ${BLUE}$ tmux${RESET}`)
    console.log(`     ${BLUE}$ opencode${RESET}`)
    console.log()
  } else {
    console.log(`  ${nextStep++}. Start OpenCode:`)
    console.log(`     ${BLUE}$ opencode${RESET}`)
    console.log()
  }

  return 0
}

export async function install(args: InstallArgs): Promise<number> {
  if (!args.tui) {
    // Non-TUI mode: validate args
    const validation = validateNonTuiArgs(args)
    if (!validation.valid) {
      printHeader(false)
      printError("Validation failed:")
      for (const err of validation.errors) {
        console.log(`  ${SYMBOLS.bullet} ${err}`)
      }
      console.log()
      printInfo(
        "Usage: bunx oh-my-opencode-slim install --no-tui --antigravity=<yes|no> --openai=<yes|no> --cerebras=<yes|no> --tmux=<yes|no>"
      )
      console.log()
      return 1
    }

    const config = argsToConfig(args)
    return runInstall(config)
  }

  // TUI mode
  const detected = detectCurrentConfig()

  printHeader(detected.isInstalled)

  printStep(1, 1, "Checking OpenCode installation...")
  const { ok } = await checkOpenCodeInstalled()
  if (!ok) return 1
  console.log()

  const config = await runTuiMode(detected)
  if (!config) return 1

  return runInstall(config)
}
