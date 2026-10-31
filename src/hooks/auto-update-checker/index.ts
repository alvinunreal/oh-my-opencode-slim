import * as path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import { TOAST_DURATION_MS } from '../../config/constants';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import { resolvePackageInstallCommand } from '../../utils/package-manager';
import {
  acquirePackageUpdateLock,
  discardPreparedPackageUpdate,
  getTargetInstallContext,
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

/**
 * Ensures the companion binary matches the manifest shipped at
 * `packageRoot`. Idempotent: {@link ensureCompanionVersion} short-circuits
 * to 'current' when the binary is already up to date. Failures are logged
 * here and retried on the next restart (see `companionWillRetry`).
 */
async function ensureCompanionForPackageRoot(
  packageRoot: string,
  companion: AutoUpdateCheckerOptions['companion'],
): Promise<{ companionUpdated: boolean; companionWillRetry: boolean }> {
  let companionUpdated = false;
  let companionWillRetry = false;

  if (companion?.enabled === true) {
    try {
      const { ensureCompanionVersion, loadCompanionManifestFromPackageRoot } =
        await import('../../companion/updater');
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

  return { companionUpdated, companionWillRetry };
}

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
  const pluginInfo = findPluginEntry(ctx.directory);
  if (!pluginInfo) {
    log('[auto-update-checker] Plugin not found in config');
    return;
  }

  const cachedVersion = getCachedVersion();
  const currentVersion = cachedVersion ?? pluginInfo.pinnedVersion;
  if (!currentVersion) {
    log('[auto-update-checker] No version found (cached or pinned)');
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
    return;
  }

  if (latestInfo.blockedByMajor && latestInfo.latestMajorVersion) {
    showMajorUpgradeToast(
      ctx,
      latestInfo.latestMajorVersion,
      currentVersion,
      getCurrentRuntimePackageJsonPath(),
    );
    log(
      `[auto-update-checker] Major update available; skipping auto-update: ${latestInfo.latestMajorVersion}`,
    );
    return;
  }

  const latestVersion = latestInfo.latestVersion;
  if (!latestVersion) {
    log(
      '[auto-update-checker] Failed to fetch latest version for channel:',
      channel,
    );
    return;
  }

  if (currentVersion === latestVersion) {
    log(
      '[auto-update-checker] Already on latest version for channel:',
      channel,
    );
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
    return;
  }

  const installContext = resolveInstallContext();
  if (!installContext) {
    showSkippedUpdateToast(
      ctx,
      currentVersion,
      latestVersion,
      pluginInfo.isInstallerManaged,
    );
    log(
      '[auto-update-checker] Active install is not a v1 packages wrapper; skipping auto-update',
    );
    return;
  }

  const cacheIdentity = pluginInfo.isInstallerManaged
    ? latestVersion
    : 'latest';

  // Only publish when we either refresh the live dir in place or can redirect an
  // installer-managed config entry to the newly installed version. A v2 cache
  // layout cannot be updated by this mechanism, so skip rather than report a
  // false success (and never stage an install we would not publish).
  const targetContext = getTargetInstallContext(installContext, cacheIdentity);
  const isInPlaceRefresh =
    targetContext !== null &&
    targetContext.installDir === installContext.installDir;
  // Skip only when we cannot publish at all: a non-installer-managed config
  // whose wrapper we cannot refresh in place (for example a v2 cache layout)
  // has no publish target. Installer-managed configs are redirected to the
  // newly published version only AFTER the install is verified and published.
  if (!isInPlaceRefresh && !pluginInfo.isInstallerManaged) {
    showSkippedUpdateToast(
      ctx,
      currentVersion,
      latestVersion,
      pluginInfo.isInstallerManaged,
    );
    log(
      '[auto-update-checker] Skipped self-install; the active install root is not updatable in place',
    );
    return;
  }

  // Narrow guard: resolveInstallContext only returns the v1 packages-wrapper
  // layout, whose parent is `packages`, so getTargetInstallContext always
  // derives a target for it.
  if (!targetContext) {
    showSkippedUpdateToast(
      ctx,
      currentVersion,
      latestVersion,
      pluginInfo.isInstallerManaged,
    );
    log(
      '[auto-update-checker] Skipped self-install; the active install root is not updatable in place',
    );
    return;
  }

  // Cross-process mutex: parallel OpenCode server processes share the cache
  // root, so only one may prepare→install→publish a pending version
  // (issue #1279). The wait is async so the server thread is never blocked.
  const releaseInstallLock = await acquirePackageUpdateLock(
    targetContext.installDir,
  );
  if (!releaseInstallLock) {
    log(
      '[auto-update-checker] Another OpenCode process is installing the update; timed out waiting for the install lock, skipping.',
    );
    return;
  }

  // The install phase resolves to one of three outcomes:
  // 'peer' (a peer process installed the version while we waited for the
  // lock), 'installed' (we prepared→installed→published it), or 'failed'.
  // 'peer' and 'installed' both continue to the shared redirect/companion/
  // toast path below, after the lock is released.
  let outcome:
    | { kind: 'peer'; dir: string }
    | { kind: 'installed'; dir: string }
    | { kind: 'failed' };
  try {
    // The version may have been installed by another process while we waited
    // for the lock.
    if (verifyInstalledPackage(targetContext.installDir, latestVersion)) {
      log(
        `[auto-update-checker] v${latestVersion} already installed by another OpenCode process; skipping install.`,
      );
      outcome = { kind: 'peer', dir: targetContext.installDir };
    } else {
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
        log(
          '[auto-update-checker] Failed to prepare install root for auto-update',
        );
        return;
      }

      const installSuccess =
        (await runPackageInstallSafe(prepared.stagingDir)) &&
        verifyInstalledPackage(prepared.stagingDir, latestVersion);
      const published = installSuccess
        ? publishPackageUpdate(prepared, latestVersion)
        : null;
      if (!installSuccess) discardPreparedPackageUpdate(prepared);
      outcome = published
        ? { kind: 'installed', dir: published }
        : { kind: 'failed' };
    }
  } finally {
    releaseInstallLock();
  }

  if (outcome.kind !== 'failed') {
    const installDir = outcome.dir;
    if (
      pluginInfo.isInstallerManaged &&
      updateInstallerManagedVersions(ctx.directory, latestVersion).status ===
        'error'
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

    const packageRoot = path.join(installDir, 'node_modules', PACKAGE_NAME);

    const { companionUpdated, companionWillRetry } =
      await ensureCompanionForPackageRoot(packageRoot, companion);

    const messageLines = [`v${currentVersion} → v${latestVersion}`];
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
      outcome.kind === 'peer'
        ? `[auto-update-checker] Update already installed by another process: ${currentVersion} → ${latestVersion}`
        : `[auto-update-checker] Update installed: ${currentVersion} → ${latestVersion}`,
    );
  } else {
    showToast(
      ctx,
      `OMO-Slim ${latestVersion}`,
      `v${latestVersion} available, but auto-update failed to install it. Check logs or retry manually.`,
      'error',
      8000,
    );
    log('[auto-update-checker] package install failed; update not installed');
  }
}

function showMajorUpgradeToast(
  ctx: PluginInput,
  version: string,
  currentVersion: string,
  runtimePackageJsonPath: string | null,
): void {
  const runningFrom = runtimePackageJsonPath
    ? `Running v${currentVersion} from ${runtimePackageJsonPath}.`
    : `Running v${currentVersion}.`;
  showToast(
    ctx,
    `oh-my-opencode-slim v${version} is available.`,
    `${runningFrom}\nIt requires OpenCode background subagents.\nRefresh the cached copy: \`bunx oh-my-opencode-slim@latest install\``,
    'info',
    12_000,
  );
}

/**
 * Honest notification for updates this plugin cannot self-install (for example,
 * an OpenCode v2 cache layout, or an install this runtime cannot update in
 * place). Points at the command the user must run instead of claiming success.
 */
function showSkippedUpdateToast(
  ctx: PluginInput,
  currentVersion: string,
  latestVersion: string,
  isInstallerManaged: boolean,
): void {
  const command = isInstallerManaged
    ? `bunx oh-my-opencode-slim@${extractChannel(currentVersion) || 'latest'} install`
    : 'opencode plugin update';
  showToast(
    ctx,
    `OMO-Slim ${latestVersion}`,
    `v${currentVersion} → v${latestVersion} available. Run \`${command}\` to apply.`,
    'info',
    8000,
  );
}

/** @public Consumed by tests via cache-busted `?test=N` dynamic imports (invisible to static analysis). */
export function getAutoUpdateInstallDir(): string {
  return resolveInstallContext()?.installDir ?? CACHE_DIR;
}

/**
 * Spawns a background package install (see resolvePackageInstallCommand).
 * Includes a timeout to prevent stalling OpenCode. The install runs in
 * the background and does not block startup, so the limit is generous:
 * a cold bun cache on a slow registry link can exceed a minute.
 * @param installDir The directory whose package manager context should be refreshed.
 * @returns True if the installation succeeded within the timeout.
 */
async function runPackageInstallSafe(installDir: string): Promise<boolean> {
  try {
    const install = resolvePackageInstallCommand();
    if (!install) {
      log('[auto-update-checker] No bun or npm found; cannot install update');
      return false;
    }
    const proc = crossSpawn(install.command, {
      cwd: installDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: install.env,
    });

    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 300_000),
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
    log('[auto-update-checker] package install error:', err);
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
  duration = TOAST_DURATION_MS,
): void {
  ctx.client.tui
    .showToast({
      body: { title, message, variant, duration },
    })
    .catch(() => {});
}

export type { AutoUpdateCheckerOptions } from './types';
