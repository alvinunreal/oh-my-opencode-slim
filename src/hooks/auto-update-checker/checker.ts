import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as os from "node:os"
import { log } from "../../shared/logger"
import { stripJsonComments } from "../../cli/config-manager"

// --- Types ---

export interface NpmDistTags {
  latest: string
  [key: string]: string
}

export interface OpencodeConfig {
  plugin?: string[]
  [key: string]: unknown
}

export interface PackageJson {
  version: string
  name?: string
  [key: string]: unknown
}

export interface AutoUpdateCheckerOptions {
  showStartupToast?: boolean
  autoUpdate?: boolean
}

export interface PluginEntryInfo {
  entry: string
  isPinned: boolean
  pinnedVersion: string | null
  configPath: string
}

interface BunLockfile {
  workspaces?: {
    ""?: {
      dependencies?: Record<string, string>
    }
  }
  packages?: Record<string, unknown>
}

// --- Constants ---

export const PACKAGE_NAME = "oh-my-opencode-slim"
export const NPM_REGISTRY_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`
export const NPM_FETCH_TIMEOUT = 5000

function getCacheDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "opencode")
  }
  return path.join(os.homedir(), ".cache", "opencode")
}

export const CACHE_DIR = getCacheDir()
export const INSTALLED_PACKAGE_JSON = path.join(CACHE_DIR, "node_modules", PACKAGE_NAME, "package.json")

function getUserConfigDir(): string {
  if (process.platform === "win32") {
    const crossPlatformDir = path.join(os.homedir(), ".config")
    const appdataDir = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
    
    const crossPlatformConfig = path.join(crossPlatformDir, "opencode", "opencode.json")
    const crossPlatformConfigJsonc = path.join(crossPlatformDir, "opencode", "opencode.jsonc")
    
    if (fs.existsSync(crossPlatformConfig) || fs.existsSync(crossPlatformConfigJsonc)) {
      return crossPlatformDir
    }
    return appdataDir
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
}

export const USER_CONFIG_DIR = getUserConfigDir()
export const USER_OPENCODE_CONFIG = path.join(USER_CONFIG_DIR, "opencode", "opencode.json")
export const USER_OPENCODE_CONFIG_JSONC = path.join(USER_CONFIG_DIR, "opencode", "opencode.jsonc")

// --- Logic ---

export function extractChannel(version: string | null): string {
  if (!version) return "latest"
  if (!/^\d/.test(version)) return version // Dist tag
  
  if (version.includes("-")) {
    const prereleasePart = version.split("-")[1]
    if (prereleasePart) {
      const channelMatch = prereleasePart.match(/^(alpha|beta|rc|canary|next)/)
      if (channelMatch) return channelMatch[1]
    }
  }
  return "latest"
}

function getConfigPaths(directory: string): string[] {
  const paths = [
    path.join(directory, ".opencode", "opencode.json"),
    path.join(directory, ".opencode", "opencode.jsonc"),
    USER_OPENCODE_CONFIG,
    USER_OPENCODE_CONFIG_JSONC,
  ]
  
  if (process.platform === "win32") {
    const crossPlatformDir = path.join(os.homedir(), ".config")
    const appdataDir = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
    if (appdataDir) {
      const alternateDir = USER_CONFIG_DIR === crossPlatformDir ? appdataDir : crossPlatformDir
      const altJson = path.join(alternateDir, "opencode", "opencode.json")
      const altJsonc = path.join(alternateDir, "opencode", "opencode.jsonc")
      if (!paths.includes(altJson)) paths.push(altJson)
      if (!paths.includes(altJsonc)) paths.push(altJsonc)
    }
  }
  return paths
}

function findPackageJsonUp(startPath: string): string | null {
  try {
    const stat = fs.statSync(startPath)
    let dir = stat.isDirectory() ? startPath : path.dirname(startPath)
    
    for (let i = 0; i < 10; i++) {
      const pkgPath = path.join(dir, "package.json")
      if (fs.existsSync(pkgPath)) {
        try {
          const content = fs.readFileSync(pkgPath, "utf-8")
          const pkg = JSON.parse(content) as PackageJson
          if (pkg.name === PACKAGE_NAME) return pkgPath
        } catch { /* ignore */ }
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* ignore */ }
  return null
}

export function getLocalDevVersion(directory: string): string | null {
  for (const configPath of getConfigPaths(directory)) {
    try {
      if (!fs.existsSync(configPath)) continue
      const config = JSON.parse(stripJsonComments(fs.readFileSync(configPath, "utf-8"))) as OpencodeConfig
      for (const entry of (config.plugin ?? [])) {
        if (entry.startsWith("file://") && entry.includes(PACKAGE_NAME)) {
          const localPath = entry.startsWith("file://") ? fileURLToPath(entry) : entry.replace("file://", "")
          const pkgPath = findPackageJsonUp(localPath)
          if (pkgPath) return (JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as PackageJson).version ?? null
        }
      }
    } catch { continue }
  }
  return null
}

export function findPluginEntry(directory: string): PluginEntryInfo | null {
  for (const configPath of getConfigPaths(directory)) {
    try {
      if (!fs.existsSync(configPath)) continue
      const config = JSON.parse(stripJsonComments(fs.readFileSync(configPath, "utf-8"))) as OpencodeConfig
      for (const entry of (config.plugin ?? [])) {
        if (entry === PACKAGE_NAME) return { entry, isPinned: false, pinnedVersion: null, configPath }
        if (entry.startsWith(`${PACKAGE_NAME}@`)) {
          const pinnedVersion = entry.slice(PACKAGE_NAME.length + 1)
          const isPinned = pinnedVersion !== "latest"
          return { entry, isPinned, pinnedVersion: isPinned ? pinnedVersion : null, configPath }
        }
      }
    } catch { continue }
  }
  return null
}

export function getCachedVersion(): string | null {
  try {
    if (fs.existsSync(INSTALLED_PACKAGE_JSON)) {
      return (JSON.parse(fs.readFileSync(INSTALLED_PACKAGE_JSON, "utf-8")) as PackageJson).version
    }
    const currentDir = path.dirname(fileURLToPath(import.meta.url))
    const pkgPath = findPackageJsonUp(currentDir)
    if (pkgPath) return (JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as PackageJson).version
  } catch { /* ignore */ }
  return null
}

export function updatePinnedVersion(configPath: string, oldEntry: string, newVersion: string): boolean {
  try {
    const content = fs.readFileSync(configPath, "utf-8")
    const newEntry = `${PACKAGE_NAME}@${newVersion}`
    const pluginMatch = content.match(/"plugin"\s*:\s*\[/)
    if (!pluginMatch || pluginMatch.index === undefined) return false
    
    const startIdx = pluginMatch.index + pluginMatch[0].length
    let bracketCount = 1, endIdx = startIdx
    for (let i = startIdx; i < content.length && bracketCount > 0; i++) {
      if (content[i] === "[") bracketCount++
      else if (content[i] === "]") bracketCount--
      endIdx = i
    }
    
    const pluginArrayContent = content.slice(startIdx, endIdx)
    const escapedOldEntry = oldEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const regex = new RegExp(`["']${escapedOldEntry}["']`)
    
    if (!regex.test(pluginArrayContent)) return false
    const updatedContent = content.slice(0, startIdx) + pluginArrayContent.replace(regex, `"${newEntry}"`) + content.slice(endIdx)
    
    if (updatedContent !== content) {
      fs.writeFileSync(configPath, updatedContent, "utf-8")
      log(`[auto-update] Updated ${configPath}: ${oldEntry} → ${newEntry}`)
      return true
    }
  } catch (err) {
    log(`[auto-update] Update failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return false
}

export async function getLatestVersion(channel: string = "latest"): Promise<string | null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), NPM_FETCH_TIMEOUT)
  try {
    const response = await fetch(NPM_REGISTRY_URL, { signal: controller.signal, headers: { Accept: "application/json" } })
    if (!response.ok) return null
    const data = (await response.json()) as NpmDistTags
    return data[channel] ?? data.latest ?? null
  } catch (err) {
    log(`[auto-update] fetch failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  } finally { clearTimeout(timeoutId) }
}

export function invalidatePackage(packageName: string = PACKAGE_NAME): boolean {
  try {
    const pkgDir = path.join(CACHE_DIR, "node_modules", packageName)
    const pkgJsonPath = path.join(CACHE_DIR, "package.json")
    let modified = false

    if (fs.existsSync(pkgDir)) {
      fs.rmSync(pkgDir, { recursive: true, force: true })
      modified = true
    }

    if (fs.existsSync(pkgJsonPath)) {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"))
      if (pkgJson.dependencies?.[packageName]) {
        delete pkgJson.dependencies[packageName]
        fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2))
        modified = true
      }
    }

    const lockPath = path.join(CACHE_DIR, "bun.lock")
    if (fs.existsSync(lockPath)) {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8").replace(/,(\s*[}\]])/g, "$1")) as BunLockfile
      let lockModified = false
      if (lock.workspaces?.[""]?.dependencies?.[packageName]) {
        delete lock.workspaces[""].dependencies[packageName]
        lockModified = true
      }
      if (lock.packages?.[packageName]) {
        delete lock.packages[packageName]
        lockModified = true
      }
      if (lockModified) {
        fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2))
        modified = true
      }
    }
    return modified
  } catch (err) {
    log("[auto-update] Invalidation failed:", err)
    return false
  }
}
