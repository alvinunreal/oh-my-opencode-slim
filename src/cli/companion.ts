import { existsSync } from 'node:fs';
import {
  COMPANION_MANIFEST,
  ensureCompanionVersion,
  getCompanionBinaryPath,
  getCompanionTarget,
} from '../companion/updater';
import { mutateJsonFile } from '../config/json-file';
import { getExistingLiteConfigPath } from '../config/paths';
import type { ConfigMergeResult } from './types';

async function installCompanion(config: {
  dryRun?: boolean;
}): Promise<ConfigMergeResult> {
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

export function enableCompanionConfig(configPath: string): ConfigMergeResult {
  try {
    mutateJsonFile(configPath, (current) => {
      const existing =
        current.companion && typeof current.companion === 'object'
          ? (current.companion as Record<string, unknown>)
          : {};
      current.companion = { ...existing, enabled: true };
      return current;
    });
    return { success: true, configPath };
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to enable companion config: ${err}`,
    };
  }
}

function printCompanionHelp(): void {
  console.log(`
Usage:
  bunx oh-my-opencode-slim companion install [--dry-run]

Downloads the desktop companion binary for this platform and sets
"companion": { "enabled": true } in the oh-my-opencode-slim config.
Run "bunx oh-my-opencode-slim install" first.
`);
}

export async function runCompanionCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    printCompanionHelp();
    return subcommand ? 0 : 1;
  }
  if (subcommand !== 'install') {
    console.error(`Unknown companion command: ${subcommand}`);
    printCompanionHelp();
    return 1;
  }

  let dryRun = false;
  for (const arg of rest) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '-h' || arg === '--help') {
      printCompanionHelp();
      return 0;
    } else {
      console.error(`Unknown option: ${arg}`);
      return 1;
    }
  }

  const configPath = getExistingLiteConfigPath();
  if (!existsSync(configPath)) {
    console.error(
      `No oh-my-opencode-slim config found at ${configPath}. ` +
        'Run "bunx oh-my-opencode-slim install" first.',
    );
    return 1;
  }

  const installResult = await installCompanion({ dryRun });
  if (!installResult.success) {
    console.error(`Companion install failed: ${installResult.error}`);
    return 1;
  }
  if (dryRun) {
    console.log(`  [dry-run] Would enable companion in: ${configPath}`);
    return 0;
  }
  console.log(`Companion binary ready: ${installResult.configPath}`);

  const configResult = enableCompanionConfig(configPath);
  if (!configResult.success) {
    console.error(configResult.error);
    return 1;
  }
  console.log(`Companion enabled in: ${configPath}`);
  console.log('Restart OpenCode to launch the companion.');
  return 0;
}
