import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { spawnSync } from "node:child_process"
import { getInstalledRipgrepPath, downloadAndInstallRipgrep } from "./downloader"

export type GrepBackend = "rg"

interface ResolvedCli {
  path: string
  backend: "rg"
}

let cachedCli: ResolvedCli | null = null
let autoInstallAttempted = false

function findExecutable(name: string): string | null {
  const isWindows = process.platform === "win32"
  const cmd = isWindows ? "where" : "which"

  try {
    const result = spawnSync(cmd, [name], { encoding: "utf-8", timeout: 5000 })
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim().split("\n")[0]
    }
  } catch {
    // Command execution failed
  }
  return null
}

function getDataDir(): string {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || process.env.APPDATA || join(process.env.USERPROFILE || ".", "AppData", "Local")
  }
  return process.env.XDG_DATA_HOME || join(process.env.HOME || ".", ".local", "share")
}

function getOpenCodeBundledRg(): string | null {
  const execPath = process.execPath
  const execDir = dirname(execPath)

  const isWindows = process.platform === "win32"
  const rgName = isWindows ? "rg.exe" : "rg"

  const candidates = [
    // OpenCode XDG data path (highest priority - where OpenCode installs rg)
    join(getDataDir(), "opencode", "bin", rgName),
    // Legacy paths relative to execPath
    join(execDir, rgName),
    join(execDir, "bin", rgName),
    join(execDir, "..", "bin", rgName),
    join(execDir, "..", "libexec", rgName),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

export function resolveGrepCli(): ResolvedCli {
  if (cachedCli) return cachedCli

  const bundledRg = getOpenCodeBundledRg()
  if (bundledRg) {
    cachedCli = { path: bundledRg, backend: "rg" }
    return cachedCli
  }

  const systemRg = findExecutable("rg")
  if (systemRg) {
    cachedCli = { path: systemRg, backend: "rg" }
    return cachedCli
  }

  const installedRg = getInstalledRipgrepPath()
  if (installedRg) {
    cachedCli = { path: installedRg, backend: "rg" }
    return cachedCli
  }

  // Fallback to "rg" in PATH even if not found by findExecutable (spawn will fail but it's consistent)
  cachedCli = { path: "rg", backend: "rg" }
  return cachedCli
}

export async function resolveGrepCliWithAutoInstall(): Promise<ResolvedCli> {
  const current = resolveGrepCli()

  // In this version, we always want rg. If not found, try to install.
  // We check if the current path actually exists.
  if (existsSync(current.path)) {
    return current
  }

  if (autoInstallAttempted) {
    return current
  }

  autoInstallAttempted = true

  try {
    const rgPath = await downloadAndInstallRipgrep()
    cachedCli = { path: rgPath, backend: "rg" }
    return cachedCli
  } catch {
    return current
  }
}

export const DEFAULT_MAX_DEPTH = 20
export const DEFAULT_MAX_FILESIZE = "10M"
export const DEFAULT_MAX_COUNT = 500
export const DEFAULT_MAX_COLUMNS = 1000
export const DEFAULT_CONTEXT = 2
export const DEFAULT_TIMEOUT_MS = 300_000
export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024

export const RG_SAFETY_FLAGS = [
  "--no-follow",
  "--color=never",
  "--no-heading",
  "--line-number",
  "--with-filename",
] as const
