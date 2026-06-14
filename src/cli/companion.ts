import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ConfigMergeResult, InstallConfig } from './types';

const COMPANION_VERSION = '0.1.1';
const COMPANION_TAG = 'companion-v0.1.1';
const GITHUB_REPO = 'alvinunreal/oh-my-opencode-slim';

export function getCompanionTarget(): string | null {
  const p = process.platform;
  const a = process.arch;
  if (p === 'darwin') {
    if (a === 'arm64') return 'aarch64-apple-darwin';
    if (a === 'x64') return 'x86_64-apple-darwin';
  } else if (p === 'linux') {
    if (a === 'x64') return 'x86_64-unknown-linux-gnu';
    if (a === 'arm64') return 'aarch64-unknown-linux-gnu';
  } else if (p === 'win32') {
    if (a === 'x64') return 'x86_64-pc-windows-msvc';
  }
  return null;
}

export function getCompanionBinaryPath(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base =
    xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), '.local', 'share');
  return path.join(
    base,
    'opencode',
    'storage',
    'oh-my-opencode-slim',
    'bin',
    process.platform === 'win32'
      ? 'oh-my-opencode-slim-companion.exe'
      : 'oh-my-opencode-slim-companion',
  );
}

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

  const isWindows = process.platform === 'win32';
  const ext = isWindows ? 'zip' : 'tar.gz';
  const archiveName = `oh-my-opencode-slim-companion-v${COMPANION_VERSION}-${target}.${ext}`;
  const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/${COMPANION_TAG}/${archiveName}`;

  if (config.dryRun) {
    console.log(`  [dry-run] Detected companion target: ${target}`);
    console.log(`  [dry-run] Would download archive: ${downloadUrl}`);
    console.log(`  [dry-run] Would extract and install to: ${finalBinaryPath}`);
    return {
      success: true,
      configPath: finalBinaryPath,
    };
  }

  let buffer: ArrayBuffer;
  try {
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      return {
        success: false,
        configPath: finalBinaryPath,
        error: `Failed to download companion binary (HTTP ${res.status}): ${res.statusText}`,
      };
    }
    buffer = await res.arrayBuffer();
  } catch (err) {
    return {
      success: false,
      configPath: finalBinaryPath,
      error: `Failed to fetch companion archive: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let tempDir = '';
  try {
    tempDir = mkdtempSync(path.join(tmpdir(), 'companion-install-'));
    const archivePath = path.join(tempDir, archiveName);
    writeFileSync(archivePath, Buffer.from(buffer));

    const extractedDir = path.join(tempDir, 'extracted');
    mkdirSync(extractedDir, { recursive: true });

    if (isWindows) {
      const { extractZip } = await import('../utils/zip-extractor');
      await extractZip(archivePath, extractedDir);
    } else {
      const { crossSpawn } = await import('../utils/compat');
      const proc = crossSpawn(['tar', '-xzf', archivePath, '-C', extractedDir]);
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await proc.stderr();
        return {
          success: false,
          configPath: finalBinaryPath,
          error: `Archive extraction failed (tar exited with ${exitCode}): ${stderr}`,
        };
      }
    }

    const binaryName = isWindows
      ? 'oh-my-opencode-slim-companion.exe'
      : 'oh-my-opencode-slim-companion';
    const extractedBinaryPath = path.join(extractedDir, binaryName);

    if (!existsSync(extractedBinaryPath)) {
      return {
        success: false,
        configPath: finalBinaryPath,
        error: `Binary ${binaryName} not found in extracted archive`,
      };
    }

    const binDir = path.dirname(finalBinaryPath);
    mkdirSync(binDir, { recursive: true });

    const tmpFinalPath = `${finalBinaryPath}.tmp`;
    copyFileSync(extractedBinaryPath, tmpFinalPath);

    if (!isWindows) {
      chmodSync(tmpFinalPath, 0o755);
    }

    renameSync(tmpFinalPath, finalBinaryPath);

    return {
      success: true,
      configPath: finalBinaryPath,
    };
  } catch (err) {
    return {
      success: false,
      configPath: finalBinaryPath,
      error: `Failed to install companion: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }
}
