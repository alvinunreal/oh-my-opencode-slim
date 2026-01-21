import type { PluginInput } from "@opencode-ai/plugin"
import { 
  getCachedVersion, 
  getLocalDevVersion, 
  findPluginEntry, 
  getLatestVersion, 
  updatePinnedVersion, 
  extractChannel,
  invalidatePackage,
  PACKAGE_NAME,
  type AutoUpdateCheckerOptions
} from "./checker"
import { log } from "../../shared/logger"

export function createAutoUpdateCheckerHook(ctx: PluginInput, options: AutoUpdateCheckerOptions = {}) {
  const { showStartupToast = true, autoUpdate = true } = options
  let hasChecked = false

  return {
    event: ({ event }: { event: { type: string; properties?: unknown } }) => {
      if (event.type !== "session.created" || hasChecked) return
      
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
          log("[auto-update] Local development mode")
          return
        }

        if (showStartupToast) {
          showToast(ctx, `OMO-Slim ${displayVersion ?? "unknown"}`, "oh-my-opencode-slim is active.", "info")
        }

        runBackgroundUpdateCheck(ctx, autoUpdate).catch(err => {
          log("[auto-update] Background update check failed:", err)
        })
      }, 0)
    },
  }
}

async function runBackgroundUpdateCheck(ctx: PluginInput, autoUpdate: boolean): Promise<void> {
  const pluginInfo = findPluginEntry(ctx.directory)
  if (!pluginInfo) return

  const currentVersion = getCachedVersion() ?? pluginInfo.pinnedVersion
  if (!currentVersion) return

  const channel = extractChannel(pluginInfo.pinnedVersion ?? currentVersion)
  const latestVersion = await getLatestVersion(channel)
  
  if (!latestVersion || currentVersion === latestVersion) return

  log(`[auto-update] Update available (${channel}): ${currentVersion} → ${latestVersion}`)

  if (!autoUpdate) {
    showToast(ctx, `OMO-Slim ${latestVersion}`, `v${latestVersion} available. Restart to apply.`, "info", 8000)
    return
  }

  if (pluginInfo.isPinned) {
    if (!updatePinnedVersion(pluginInfo.configPath, pluginInfo.entry, latestVersion)) {
      showToast(ctx, `OMO-Slim ${latestVersion}`, `v${latestVersion} available. Restart to apply.`, "info", 8000)
      return
    }
  }

  invalidatePackage(PACKAGE_NAME)

  if (await runBunInstallSafe(ctx)) {
    showToast(ctx, "OMO-Slim Updated!", `v${currentVersion} → v${latestVersion}\nRestart OpenCode to apply.`, "success", 8000)
    log(`[auto-update] Update installed: ${currentVersion} → ${latestVersion}`)
  } else {
    showToast(ctx, `OMO-Slim ${latestVersion}`, `v${latestVersion} available. Restart to apply.`, "info", 8000)
  }
}

async function runBunInstallSafe(ctx: PluginInput): Promise<boolean> {
  try {
    const proc = Bun.spawn(["bun", "install"], { cwd: ctx.directory })
    const timeout = setTimeout(() => proc.kill(), 60_000)
    await proc.exited
    clearTimeout(timeout)
    return proc.exitCode === 0
  } catch (err) {
    log("[auto-update] bun install error:", err)
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

export type { AutoUpdateCheckerOptions }
