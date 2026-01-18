import type { PluginInput } from "@opencode-ai/plugin"
import { getCachedVersion, getLocalDevVersion, findPluginEntry, getLatestVersion, updatePinnedVersion, extractChannel } from "./checker"
import { invalidatePackage } from "./cache"
import { PACKAGE_NAME } from "./constants"
import { log } from "../../shared/logger"
import type { AutoUpdateCheckerOptions } from "./types"

export function createAutoUpdateCheckerHook(ctx: PluginInput, options: AutoUpdateCheckerOptions = {}) {
  const { showStartupToast = true, autoUpdate = true } = options

  let hasChecked = false

  return {
    event: ({ event }: { event: { type: string; properties?: unknown } }) => {
      if (event.type !== "session.created") return
      if (hasChecked) return

      const props = event.properties as { info?: { parentID?: string } } | undefined
      if (props?.info?.parentID) return

      hasChecked = true

      setTimeout(async () => {
        const cachedVersion = getCachedVersion()
        const localDevVersion = getLocalDevVersion(ctx.directory)
        const displayVersion = localDevVersion ?? cachedVersion

        if (localDevVersion) {
          if (showStartupToast) {
            showToast(ctx, `OMO-Slim ${displayVersion} (dev)`, "Running in local development mode.", "info")
          }
          log("[auto-update-checker] Local development mode")
          return
        }

        if (showStartupToast) {
          showToast(ctx, `OMO-Slim ${displayVersion ?? "unknown"}`, "oh-my-opencode-slim is active.", "info")
        }

        runBackgroundUpdateCheck(ctx, autoUpdate).catch(err => {
          log("[auto-update-checker] Background update check failed:", err)
        })
      }, 0)
    },
  }
}

async function runBackgroundUpdateCheck(ctx: PluginInput, autoUpdate: boolean): Promise<void> {
  const pluginInfo = findPluginEntry(ctx.directory)
  if (!pluginInfo) {
    log("[auto-update-checker] Plugin not found in config")
    return
  }

  const cachedVersion = getCachedVersion()
  const currentVersion = cachedVersion ?? pluginInfo.pinnedVersion
  if (!currentVersion) {
    log("[auto-update-checker] No version found (cached or pinned)")
    return
  }

  const channel = extractChannel(pluginInfo.pinnedVersion ?? currentVersion)
  const latestVersion = await getLatestVersion(channel)
  if (!latestVersion) {
    log("[auto-update-checker] Failed to fetch latest version for channel:", channel)
    return
  }

  if (currentVersion === latestVersion) {
    log("[auto-update-checker] Already on latest version for channel:", channel)
    return
  }

  log(`[auto-update-checker] Update available (${channel}): ${currentVersion} → ${latestVersion}`)

  if (!autoUpdate) {
    showToast(ctx, `OMO-Slim ${latestVersion}`, `v${latestVersion} available. Restart to apply.`, "info", 8000)
    log("[auto-update-checker] Auto-update disabled, notification only")
    return
  }

  if (pluginInfo.isPinned) {
    const updated = updatePinnedVersion(pluginInfo.configPath, pluginInfo.entry, latestVersion)
    if (!updated) {
      showToast(ctx, `OMO-Slim ${latestVersion}`, `v${latestVersion} available. Restart to apply.`, "info", 8000)
      log("[auto-update-checker] Failed to update pinned version in config")
      return
    }
    log(`[auto-update-checker] Config updated: ${pluginInfo.entry} → ${PACKAGE_NAME}@${latestVersion}`)
  }

  invalidatePackage(PACKAGE_NAME)

  const installSuccess = await runBunInstallSafe(ctx)

  if (installSuccess) {
    showToast(ctx, "OMO-Slim Updated!", `v${currentVersion} → v${latestVersion}\nRestart OpenCode to apply.`, "success", 8000)
    log(`[auto-update-checker] Update installed: ${currentVersion} → ${latestVersion}`)
  } else {
    showToast(ctx, `OMO-Slim ${latestVersion}`, `v${latestVersion} available. Restart to apply.`, "info", 8000)
    log("[auto-update-checker] bun install failed; update not installed")
  }
}

async function runBunInstallSafe(ctx: PluginInput): Promise<boolean> {
  try {
    const proc = Bun.spawn(["bun", "install"], {
      cwd: ctx.directory,
      stdout: "pipe",
      stderr: "pipe",
    })
    
    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 60_000)
    )
    const exitPromise = proc.exited.then(() => "completed" as const)
    const result = await Promise.race([exitPromise, timeoutPromise])
    
    if (result === "timeout") {
      try { proc.kill() } catch { /* empty */ }
      return false
    }
    
    return proc.exitCode === 0
  } catch (err) {
    log("[auto-update-checker] bun install error:", err)
    return false
  }
}

function showToast(
  ctx: PluginInput,
  title: string,
  message: string,
  variant: "info" | "success" | "error" = "info",
  duration = 3000
): void {
  ctx.client.tui.showToast({
    body: { title, message, variant, duration },
  }).catch(() => {})
}

export type { AutoUpdateCheckerOptions } from "./types"
