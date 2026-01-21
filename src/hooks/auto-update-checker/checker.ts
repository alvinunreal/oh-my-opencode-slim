import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as os from "node:os"
import type { NpmDistTags, OpencodeConfig, PackageJson, PluginEntryInfo } from "./types"
import {
  PACKAGE_NAME,
  NPM_REGISTRY_URL,
  NPM_FETCH_TIMEOUT,
  INSTALLED_PACKAGE_JSON,
  USER_OPENCODE_CONFIG,
  USER_OPENCODE_CONFIG_JSONC,
} from "./constants"
import { log } from "../../shared/logger"
import { stripJsonComments } from "../../cli/config-manager"

/**
 * Checks if a version string indicates a prerelease (contains a hyphen).
 */
function isPrereleaseVersion(version: string): boolean {
  return version.includes("-")
}

/**
 * Checks if a version string is an NPM dist-tag (does not start with a digit).
 */
function isDistTag(version: string): boolean {
  return !/^\d/.test(version)
}

/**
 * Extracts the update channel (latest, alpha, beta, etc.) from a version string.
 * @param version The version or tag to analyze.
 * @returns The channel name.
 */
export function extractChannel(version: string | null): string {
  if (!version) return "latest"

  if (isDistTag(version)) return version

  if (isPrereleaseVersion(version)) {
    const prereleasePart = version.split("-")[1]
    if (prereleasePart) {
      const channelMatch = prereleasePart.match(/^(alpha|beta|rc|canary|next)/)
      if (channelMatch) return channelMatch[1]
    }
  }

  return "latest"
}


/**
 * Generates a list of potential OpenCode configuration file paths.
 * @param directory The current plugin directory to check for local .opencode folders.
 */
function getConfigPaths(directory: string): string[] {
  return [
    path.join(directory, ".opencode", "opencode.json"),
    path.join(directory, ".opencode", "opencode.jsonc"),
    USER_OPENCODE_CONFIG,
    USER_OPENCODE_CONFIG_JSONC,
  ]
}

/**
 * Attempts to find a local development path (file://) for the plugin in configs.
 */
function getLocalDevPath(directory: string): string | null {
  for (const configPath of getConfigPaths(directory)) {
    try {
      if (!fs.existsSync(configPath)) continue
      const content = fs.readFileSync(configPath, "utf-8")
      const config = JSON.parse(stripJsonComments(content)) as OpencodeConfig
      const plugins = config.plugin ?? []

      for (const entry of plugins) {
        if (entry.startsWith("file://") && entry.includes(PACKAGE_NAME)) {
          try {
            return fileURLToPath(entry)
          } catch {
            return entry.replace("file://", "")
          }
        }
      }
    } catch {
      continue
    }
  }
  return null
}

/**
 * Recursively searches upwards for a package.json belonging to this plugin.
 */
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
        } catch { /* empty */ }
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* empty */ }
  return null
}

/**
 * Resolves the version of the plugin when running in local development mode.
 */
export function getLocalDevVersion(directory: string): string | null {
  const localPath = getLocalDevPath(directory)
  if (!localPath) return null

  try {
    const pkgPath = findPackageJsonUp(localPath)
    if (!pkgPath) return null
    const content = fs.readFileSync(pkgPath, "utf-8")
    const pkg = JSON.parse(content) as PackageJson
    return pkg.version ?? null
  } catch {
    return null
  }
}



/**
 * Searches across all config locations to find the current installation entry for this plugin.
 */
export function findPluginEntry(directory: string): PluginEntryInfo | null {
  for (const configPath of getConfigPaths(directory)) {
    try {
      if (!fs.existsSync(configPath)) continue
      const content = fs.readFileSync(configPath, "utf-8")
      const config = JSON.parse(stripJsonComments(content)) as OpencodeConfig
      const plugins = config.plugin ?? []

      for (const entry of plugins) {
        if (entry === PACKAGE_NAME) {
          return { entry, isPinned: false, pinnedVersion: null, configPath }
        }
        if (entry.startsWith(`${PACKAGE_NAME}@`)) {
          const pinnedVersion = entry.slice(PACKAGE_NAME.length + 1)
          const isPinned = pinnedVersion !== "latest"
          return { entry, isPinned, pinnedVersion: isPinned ? pinnedVersion : null, configPath }
        }
      }
    } catch {
      continue
    }
  }
  return null
}

let cachedLocalVersion: string | null = null
let cachedPackageVersion: string | null = null

/**
 * Resolves the installed version from node_modules, with memoization.
 */
export function getCachedVersion(): string | null {
  if (cachedPackageVersion) return cachedPackageVersion

  try {
    if (fs.existsSync(INSTALLED_PACKAGE_JSON)) {
      const content = fs.readFileSync(INSTALLED_PACKAGE_JSON, "utf-8")
      const pkg = JSON.parse(content) as PackageJson
      if (pkg.version) {
        cachedPackageVersion = pkg.version
        return pkg.version
      }
    }
  } catch { /* empty */ }

  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url))
    const pkgPath = findPackageJsonUp(currentDir)
    if (pkgPath) {
      const content = fs.readFileSync(pkgPath, "utf-8")
      const pkg = JSON.parse(content) as PackageJson
      if (pkg.version) {
        cachedPackageVersion = pkg.version
        return pkg.version
      }
    }
  } catch (err) {
    log("[auto-update-checker] Failed to resolve version from current directory:", err)
  }

  return null
}

/**
 * Safely updates a pinned version in the configuration file.
 * It attempts to replace the exact plugin string to preserve comments and formatting.
 */
export function updatePinnedVersion(configPath: string, oldEntry: string, newVersion: string): boolean {
  try {
    if (!fs.existsSync(configPath)) return false

    const content = fs.readFileSync(configPath, "utf-8")
    const newEntry = `${PACKAGE_NAME}@${newVersion}`

    // Check if the old entry actually exists as a quoted string
    const escapedOldEntry = oldEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const entryRegex = new RegExp(`(["'])${escapedOldEntry}\\1`, "g")

    if (!entryRegex.test(content)) {
      log(`[auto-update-checker] Entry "${oldEntry}" not found in ${configPath}`)
      return false
    }

    // Perform the replacement
    const updatedContent = content.replace(entryRegex, `$1${newEntry}$1`)

    if (updatedContent === content) {
      return false
    }

    fs.writeFileSync(configPath, updatedContent, "utf-8")
    log(`[auto-update-checker] Updated ${configPath}: ${oldEntry} → ${newEntry}`)
    return true
  } catch (err) {
    log(`[auto-update-checker] Failed to update config file ${configPath}:`, err)
    return false
  }
}

/**
 * Fetches the latest version for a specific channel from the NPM registry.
 */
export async function getLatestVersion(channel: string = "latest"): Promise<string | null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), NPM_FETCH_TIMEOUT)

  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })

    if (!response.ok) return null

    const data = (await response.json()) as NpmDistTags
    return data[channel] ?? data.latest ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}
