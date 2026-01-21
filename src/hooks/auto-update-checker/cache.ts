import * as fs from "node:fs"
import * as path from "node:path"
import { CACHE_DIR, PACKAGE_NAME } from "./constants"
import { log } from "../../shared/logger"
import { stripJsonComments } from "../../cli/config-manager"

interface BunLockfile {
  workspaces?: {
    ""?: {
      dependencies?: Record<string, string>
    }
  }
  packages?: Record<string, unknown>
}

/**
 * Removes a package from the bun.lock file if it's in JSON format.
 * Note: Newer Bun versions (1.1+) use a custom text format for bun.lock.
 * This function handles JSON-based lockfiles gracefully.
 */
function removeFromBunLock(packageName: string): boolean {
  const lockPath = path.join(CACHE_DIR, "bun.lock")
  if (!fs.existsSync(lockPath)) return false

  try {
    const content = fs.readFileSync(lockPath, "utf-8")
    let lock: BunLockfile

    try {
      lock = JSON.parse(stripJsonComments(content)) as BunLockfile
    } catch {
      // If it's not valid JSON(C), it might be the new Bun text format or binary format.
      // For now, we only support JSON-based lockfile manipulation.
      return false
    }

    let modified = false

    if (lock.workspaces?.[""]?.dependencies?.[packageName]) {
      delete lock.workspaces[""].dependencies[packageName]
      modified = true
    }

    if (lock.packages?.[packageName]) {
      delete lock.packages[packageName]
      modified = true
    }

    if (modified) {
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2))
      log(`[auto-update-checker] Removed from bun.lock: ${packageName}`)
    }

    return modified
  } catch (err) {
    log(`[auto-update-checker] Failed to process bun.lock:`, err)
    return false
  }
}

/**
 * Invalidates the current package by removing its directory and dependency entries.
 * This forces a clean state before running a fresh install.
 * @param packageName The name of the package to invalidate.
 */
export function invalidatePackage(packageName: string = PACKAGE_NAME): boolean {
  try {
    const pkgDir = path.join(CACHE_DIR, "node_modules", packageName)
    const pkgJsonPath = path.join(CACHE_DIR, "package.json")

    let packageRemoved = false
    let dependencyRemoved = false
    let lockRemoved = false

    if (fs.existsSync(pkgDir)) {
      fs.rmSync(pkgDir, { recursive: true, force: true })
      log(`[auto-update-checker] Package removed: ${pkgDir}`)
      packageRemoved = true
    }

    if (fs.existsSync(pkgJsonPath)) {
      try {
        const content = fs.readFileSync(pkgJsonPath, "utf-8")
        const pkgJson = JSON.parse(stripJsonComments(content))
        if (pkgJson.dependencies?.[packageName]) {
          delete pkgJson.dependencies[packageName]
          fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2))
          log(`[auto-update-checker] Dependency removed from package.json: ${packageName}`)
          dependencyRemoved = true
        }
      } catch (err) {
        log(`[auto-update-checker] Failed to update package.json for invalidation:`, err)
      }
    }

    lockRemoved = removeFromBunLock(packageName)

    if (!packageRemoved && !dependencyRemoved && !lockRemoved) {
      log(`[auto-update-checker] Package not found, nothing to invalidate: ${packageName}`)
      return false
    }

    return true
  } catch (err) {
    log("[auto-update-checker] Failed to invalidate package:", err)
    return false
  }
}
