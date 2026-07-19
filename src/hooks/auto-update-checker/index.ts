import * as path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  ensureCompanionVersion,
  loadCompanionManifestFromPackageRoot,
} from '../../companion/updater';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import {
  discardPreparedPackageUpdate,
  preparePackageUpdate,
  publishPackageUpdate,
  resolveInstallContext,
  verifyInstalledPackage,
} from './cache';
import {
  extractChannel,
  findPluginEntry,
  getCachedVersion,
  getCurrentRuntimePackageJsonPath,
  getLatestCompatibleVersion,
  getLocalDevVersion,
  updateInstallerManagedVersions,
} from './checker';
import { CACHE_DIR, PACKAGE_NAME } from './constants';
import { syncBundledSkillsFromPackage } from './skill-sync';
import type { AutoUpdateCheckerOptions } from './types';

/**
 * Creates an OpenCode hook that checks for plugin updates when a new session is created.
 * @param ctx The plugin input context.
 * @param options Configuration options for the update checker.
 * @returns A hook object for the session.created event.
 */
export function createAutoUpdateCheckerHook(
  ctx: PluginInput,
  options: AutoUpdateCheckerOptions = {},
) {
  const { autoUpdate = true, companion } = options;

  let hasChecked = false;

  return {
    event: ({ event }: { event: { type: string; properties?: unknown } }) => {
      if (event.type !== 'session.created') return;
      if (hasChecked) return;

      const props = event.properties as
        | { info?: { parentID?: string } }
        | undefined;
      if (props?.info?.parentID) return;

      hasChecked = true;

      setTimeout(async () => {
        const localDevVersion = getLocalDevVersion(ctx.directory);

        if (localDevVersion) {
          log('[auto-update-checker] Local development mode');
          return;
        }

        runBackgroundUpdateCheck(ctx, autoUpdate, companion).catch((err) => {
          log('[auto-update-checker] Background update check failed:', err);
        });
      }, 0);
    },
  };
}

let hasReconciledAtStartup = false;

/**
 * Orchestrates the version comparison and update process in the background.
 * @param ctx The plugin input context.
 * @param autoUpdate Whether to automatically install updates.
 */
async function runBackgroundUpdateCheck(
  ctx: PluginInput,
  autoUpdate: boolean,
  companion: AutoUpdateCheckerOptions['companion'],
): Promise<void> {
  const stagedSkillsThisUpdate = new Set<string>();

  // Startup reconciliation (run once per top-level startup)
  if (!hasReconciledAtStartup) {
    try {
      const runtimePackageJsonPath = getCurrentRuntimePackageJsonPath();
      if (runtimePackageJsonPath) {
        hasReconciledAtStartup = true;
        const packageRoot = path.dirname(runtimePackageJsonPath);
        log('[auto-update-checker] Running startup skill reconciliation');
        const syncResult = syncBundledSkillsFromPackage(packageRoot);
        for (const skill of syncResult.stagedThisSync) {
          stagedSkillsThisUpdate.add(skill);
        }
        if (syncResult.installed.length > 0) {
          log(
            `[auto-update-checker] Startup skill sync installed: ${syncResult.installed.join(', ')}`,
          );
        }
        if (syncResult.failed.length > 0) {
          log(
            `[auto-update-checker] Startup skill sync failures: ${syncResult.failed.join(', ')}`,
          );
        }
        if (syncResult.staged.length > 0) {
          log(
            `[auto-update-checker] Startup skill sync staged: ${syncResult.staged.join(', ')}`,
          );
        }
        if (syncResult.customized.length > 0) {
          log(
            `[auto-update-checker] Startup skill sync customized: ${syncResult.customized.join(', ')}`,
          );
        }
      } else {
        log(
          '[auto-update-checker] Could not resolve runtime package path for startup skill reconciliation',
        );
      }
    } catch (err) {
      log('[auto-update-checker] Startup skill reconciliation failed:', err);
    }
  }

  const pluginInfo = findPluginEntry(ctx.directory);
  if (!pluginInfo) {
    log('[auto-update-checker] Plugin not found in config');
    showStagedSkillsReviewToast(ctx, stagedSkillsThisUpdate);
    return;
  }

  const cachedVersion = getCachedVersion();
  const currentVersion = cachedVersion ?? pluginInfo.pinnedVersion;
  if (!currentVersion) {
    log('[auto-update-checker] No version found (cached or pinned)');
    showStagedSkillsReviewToast(ctx, stagedSkillsThisUpdate);
    return;
  }

  const channel = extractChannel(pluginInfo.pinnedVersion ?? currentVersion);
  const latestInfo = await getLatestCompatibleVersion(currentVersion, channel);
  if (latestInfo.unsafeReason === 'unparseable-current-version') {
    log(
      `[auto-update-checker] Current version is not semver; skipping auto-update: ${currentVersion}`,
    );
    if (latestInfo.latestMajorVersion) {
      showToast(
        ctx,
        `OMO-Slim ${latestInfo.latestMajorVersion}`,
        `v${latestInfo.latestMajorVersion} available. Auto-update skipped because the current version could not be compared safely.`,
        'info',
        8000,
      );
    }
    showStagedSkillsReviewToast(ctx, stagedSkillsThisUpdate);
    return;
  }

  if (latestInfo.blockedByMajor && latestInfo.latestMajorVersion) {
    showMajorUpgradeToast(ctx, latestInfo.latestMajorVersion);
    log(
      `[auto-update-checker] Major update available; skipping auto-update: ${latestInfo.latestMajorVersion}`,
    );
    showStagedSkillsReviewToast(ctx, stagedSkillsThisUpdate);
    return;
  }

  const latestVersion = latestInfo.latestVersion;
  if (!latestVersion) {
    log(
      '[auto-update-checker] Failed to fetch latest version for channel:',
      channel,
    );
    showStagedSkillsReviewToast(ctx, stagedSkillsThisUpdate);
    return;
  }

  if (currentVersion === latestVersion) {
    log(
      '[auto-update-checker] Already on latest version for channel:',
      channel,
    );
    showStagedSkillsReviewToast(ctx, stagedSkillsThisUpdate);
    return;
  }

  log(
    `[auto-update-checker] Update available (${channel}): ${currentVersion} → ${latestVersion}`,
  );

  if (pluginInfo.isPinned) {
    showToast(
      ctx,
      `OMO-Slim ${latestVersion}`,
      `v${latestVersion} available.\nVersion is pinned. Update your plugin config to apply.`,
      'info',
      8000,
    );
    log(`[auto-update-checker] Version is pinned; skipping auto-update.`);
    showStagedSkillsReviewToast(ctx, stagedSkillsThisUpdate);
    return;
  }

  if (!autoUpdate) {
    showToast(
      ctx,
      `OMO-Slim ${latestVersion}`,
      `v${latestVersion} available. Auto-update is disabled.`,
      'info',
      8000,
    );
    log('[auto-update-checker] Auto-update disabled, notification only');
    showStagedSkillsReviewToast(ctx, stagedSkillsThisUpdate);
    return;
  }

  const cacheIdentity = pluginInfo.isInstallerManaged
    ? latestVersion
    : 'latest';
  const prepared = preparePackageUpdate(
    latestVersion,
    PACKAGE_NAME,
    undefined,
    cacheIdentity,
  );
  if (!prepared) {
    showToast(
      ctx,
      `OMO-Slim ${latestVersion}`,
      `v${latestVersion} available. Auto-update could not prepare the active install.`,
      'info',
      8000,
    );
    log('[auto-update-checker] Failed to prepare install root for auto-update');
    showStagedSkillsReviewToast(ctx, stagedSkillsThisUpdate);
    return;
  }

  const installSuccess =
    (await runBunInstallSafe(prepared.stagingDir)) &&
    verifyInstalledPackage(prepared.stagingDir, latestVersion);
  const installDir = installSuccess
    ? publishPackageUpdate(prepared, latestVersion)
    : null;
  if (!installSuccess) discardPreparedPackageUpdate(prepared);

  if (installDir) {
    if (
      pluginInfo.isInstallerManaged &&
      !updateInstallerManagedVersions(ctx.directory, latestVersion)
    ) {
      showToast(
        ctx,
        `OMO-Slim ${latestVersion}`,
        'Update installed in cache, but plugin configuration could not be updated.',
        'error',
        8000,
      );
      return;
    }
    let installedSkills: string[] = [];
    let companionUpdated = false;
    let companionWillRetry = false;
    const packageRoot = path.join(installDir, 'node_modules', PACKAGE_NAME);
    try {
      const syncResult = syncBundledSkillsFromPackage(packageRoot);
      installedSkills = syncResult.installed;
      for (const skill of syncResult.stagedThisSync) {
        stagedSkillsThisUpdate.add(skill);
      }
      for (const skill of [...syncResult.installed, ...syncResult.adopted]) {
        stagedSkillsThisUpdate.delete(skill);
      }
      if (syncResult.failed.length > 0) {
        log(
          `[auto-update-checker] Skill sync warnings/failures: ${syncResult.failed.join(', ')}`,
        );
      }
      if (syncResult.skippedExisting.length > 0) {
        log(
          `[auto-update-checker] Skill sync skipped existing: ${syncResult.skippedExisting.join(', ')}`,
        );
      }
    } catch (err) {
      log('[auto-update-checker] Skill sync failed silently:', err);
    }

    if (companion?.enabled === true) {
      try {
        const manifest = loadCompanionManifestFromPackageRoot(packageRoot);
        const companionResult = await ensureCompanionVersion({
          config: companion,
          manifest: manifest ?? undefined,
        });
        if (companionResult.status === 'installed') {
          companionUpdated = true;
        } else if (companionResult.status === 'failed') {
          companionWillRetry = true;
          log(
            '[auto-update-checker] Companion update failed; will retry on restart:',
            companionResult.error,
          );
        } else if (companionResult.status === 'skipped') {
          log(
            '[auto-update-checker] Companion update skipped:',
            companionResult.reason,
          );
        }
      } catch (err) {
        companionWillRetry = true;
        log(
          '[auto-update-checker] Companion update failed silently; will retry on restart:',
          err,
        );
      }
    }

    const messageLines = [`v${currentVersion} → v${latestVersion}`];
    if (installedSkills.length > 0) {
      messageLines.push(`Added bundled skills: ${installedSkills.join(', ')}`);
    }
    if (stagedSkillsThisUpdate.size > 0) {
      messageLines.push(
        `Staged skill updates require manual review: ${[...stagedSkillsThisUpdate].join(', ')}`,
      );
    }
    if (companionUpdated) {
      messageLines.push('Companion updated.');
    } else if (companionWillRetry) {
      messageLines.push('Companion update will retry on restart.');
    }
    messageLines.push('Restart OpenCode to apply the plugin update.');

    showToast(
      ctx,
      'OMO-Slim Updated!',
      messageLines.join('\n'),
      'success',
      8000,
    );
    log(
      `[auto-update-checker] Update installed: ${currentVersion} → ${latestVersion}`,
    );
  } else {
    showToast(
      ctx,
      `OMO-Slim ${latestVersion}`,
      `v${latestVersion} available, but auto-update failed to install it. Check logs or retry manually.`,
      'error',
      8000,
    );
    log('[auto-update-checker] bun install failed; update not installed');
    showStagedSkillsReviewToast(ctx, stagedSkillsThisUpdate);
  }
}

function showMajorUpgradeToast(ctx: PluginInput, version: string): void {
  showToast(
    ctx,
    `oh-my-opencode-slim v${version} is available.`,
    'It requires OpenCode background subagents.\nRun: bunx oh-my-opencode-slim@latest install',
    'info',
    12_000,
  );
}

function showStagedSkillsReviewToast(
  ctx: PluginInput,
  stagedSkills: ReadonlySet<string>,
): void {
  if (stagedSkills.size === 0) return;

  showToast(
    ctx,
    'Skill updates need review',
    `Manual review required: ${[...stagedSkills].join(', ')}`,
    'info',
    8000,
  );
}

export function getAutoUpdateInstallDir(): string {
  return resolveInstallContext()?.installDir ?? CACHE_DIR;
}

/**
 * Spawns a background process to run 'bun install'.
 * Includes a 60-second timeout to prevent stalling OpenCode.
 * @param installDir The directory whose package manager context should be refreshed.
 * @returns True if the installation succeeded within the timeout.
 */
async function runBunInstallSafe(installDir: string): Promise<boolean> {
  try {
    const proc = crossSpawn(['bun', 'install'], {
      cwd: installDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 60_000),
    );
    const exitPromise = proc.exited.then(() => 'completed' as const);
    const result = await Promise.race([exitPromise, timeoutPromise]);

    if (result === 'timeout') {
      try {
        proc.kill();
      } catch {
        /* empty */
      }
      return false;
    }

    return proc.exitCode === 0;
  } catch (err) {
    log('[auto-update-checker] bun install error:', err);
    return false;
  }
}

/**
 * Helper to display a toast notification in the OpenCode TUI.
 * @param ctx The plugin input context.
 * @param title The toast title.
 * @param message The toast message.
 * @param variant The visual style of the toast.
 * @param duration How long to show the toast in milliseconds.
 */
function showToast(
  ctx: PluginInput,
  title: string,
  message: string,
  variant: 'info' | 'success' | 'error' = 'info',
  duration = 3000,
): void {
  ctx.client.tui
    .showToast({
      body: { title, message, variant, duration },
    })
    .catch(() => {});
}

export type { AutoUpdateCheckerOptions } from './types';
