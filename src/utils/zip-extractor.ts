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

export async function extractZip(
  archivePath: string,
  destDir: string,
): Promise<void> {
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

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await proc.stderr();
    throw new Error(`zip extraction failed (exit ${exitCode}): ${stderr}`);
  }
}
