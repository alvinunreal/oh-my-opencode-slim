import { spawnSync } from 'node:child_process';
import { release } from 'node:os';
import { crossSpawn } from './compat';

const WINDOWS_BUILD_WITH_TAR = 17134;

function getWindowsBuildNumber(): number | null {
  if (process.platform !== 'win32') return null;

  const parts = release().split('.');
  if (parts.length >= 3) {
    const build = parseInt(parts[2], 10);
    if (!Number.isNaN(build)) return build;
  }
  return null;
}

function isPwshAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  const result = spawnSync('where', ['pwsh'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

function escapePowerShellPath(path: string): string {
  return path.replace(/'/g, "''");
}

type WindowsZipExtractor = 'tar' | 'pwsh' | 'powershell';

function hasCommand(command: string, args: string[] = ['--version']): boolean {
  try {
    const result = spawnSync(command, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function getWindowsZipExtractor(): WindowsZipExtractor {
  const buildNumber = getWindowsBuildNumber();

  if (buildNumber !== null && buildNumber >= WINDOWS_BUILD_WITH_TAR) {
    return 'tar';
  }

  if (isPwshAvailable()) {
    return 'pwsh';
  }

  return 'powershell';
}

export function getZipExtractionSupportError(): string | undefined {
  if (process.platform === 'win32') {
    const extractor = getWindowsZipExtractor();

    if (extractor === 'tar' && !hasCommand('tar')) {
      return 'ripgrep auto-install requires tar on this Windows host to extract zip archives.';
    }

    if (extractor === 'pwsh' && !hasCommand('pwsh', ['-v'])) {
      return 'ripgrep auto-install requires pwsh to extract zip archives on this Windows host.';
    }

    if (
      extractor === 'powershell' &&
      !hasCommand('powershell', ['-Command', '$PSVersionTable.PSVersion.ToString()'])
    ) {
      return 'ripgrep auto-install requires PowerShell to extract zip archives on this Windows host.';
    }

    return undefined;
  }

  return hasCommand('unzip')
    ? undefined
    : 'ripgrep auto-install requires unzip to extract zip archives.';
}

function createAbortError(): Error {
  const error = new Error('ripgrep auto-install was aborted');
  error.name = 'AbortError';
  return error;
}

export async function extractZip(
  archivePath: string,
  destDir: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError();
  }

  let proc: ReturnType<typeof crossSpawn>;

  if (process.platform === 'win32') {
    const extractor = getWindowsZipExtractor();

    switch (extractor) {
      case 'tar':
        proc = crossSpawn(['tar', '-xf', archivePath, '-C', destDir], {
          stdout: 'ignore',
          stderr: 'pipe',
        });
        break;
      case 'pwsh':
        proc = crossSpawn(
          [
            'pwsh',
            '-Command',
            `Expand-Archive -Path '${escapePowerShellPath(archivePath)}' -DestinationPath '${escapePowerShellPath(destDir)}' -Force`,
          ],
          {
            stdout: 'ignore',
            stderr: 'pipe',
          },
        );
        break;
      default:
        proc = crossSpawn(
          [
            'powershell',
            '-Command',
            `Expand-Archive -Path '${escapePowerShellPath(archivePath)}' -DestinationPath '${escapePowerShellPath(destDir)}' -Force`,
          ],
          {
            stdout: 'ignore',
            stderr: 'pipe',
          },
        );
        break;
    }
  } else {
    proc = crossSpawn(['unzip', '-o', archivePath, '-d', destDir], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
  }

  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      // Process may have already exited.
    }
  };

  signal?.addEventListener('abort', onAbort, { once: true });

  const stderrPromise = proc.stderr();
  const exitCode = await proc.exited;
  signal?.removeEventListener('abort', onAbort);

  if (signal?.aborted) {
    throw createAbortError();
  }

  const stderr = await stderrPromise;
  if (exitCode !== 0) {
    throw new Error(`zip extraction failed (exit ${exitCode}): ${stderr}`);
  }
}
