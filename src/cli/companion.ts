import {
  COMPANION_MANIFEST,
  ensureCompanionVersion,
  getCompanionBinaryPath,
  getCompanionTarget,
} from '../companion/updater';
import type { ConfigMergeResult, InstallConfig } from './types';

export { getCompanionBinaryPath, getCompanionTarget };

export async function installCompanion(
  config: InstallConfig,
): Promise<ConfigMergeResult> {
  const target = getCompanionTarget();
  const finalBinaryPath = getCompanionBinaryPath();

  if (!target) {
    return {
      success: false,
      configPath: finalBinaryPath,
      error: `Unsupported platform/architecture: ${process.platform} ${process.arch}`,
    };
  }

  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
  const archiveName = `oh-my-opencode-slim-companion-v${COMPANION_MANIFEST.version}-${target}.${ext}`;
  const downloadUrl = `https://github.com/${COMPANION_MANIFEST.repo}/releases/download/${COMPANION_MANIFEST.tag}/${archiveName}`;

  if (config.dryRun) {
    console.log(`  [dry-run] Detected companion target: ${target}`);
    console.log(`  [dry-run] Would download archive: ${downloadUrl}`);
    console.log(`  [dry-run] Would extract and install to: ${finalBinaryPath}`);
    return {
      success: true,
      configPath: finalBinaryPath,
    };
  }

  const result = await ensureCompanionVersion({
    config: { enabled: true },
    manifest: COMPANION_MANIFEST,
  });
  if (result.status === 'installed' || result.status === 'current') {
    return {
      success: true,
      configPath: finalBinaryPath,
    };
  }

  return {
    success: false,
    configPath: finalBinaryPath,
    error:
      result.status === 'failed'
        ? result.error
        : `Companion install skipped: ${result.reason}`,
  };
}
