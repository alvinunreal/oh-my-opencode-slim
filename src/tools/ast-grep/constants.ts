import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getCachedBinaryPath } from './downloader';
import { CLI_LANGUAGES } from './types';

type Platform = 'darwin' | 'linux' | 'win32' | 'unsupported';

// Minimum expected size for a valid sg binary (filters out stub files)
const MIN_BINARY_SIZE = 10_000;

function isValidBinary(filePath: string): boolean {
  try {
    return statSync(filePath).size > MIN_BINARY_SIZE;
  } catch {
    return false;
  }
}

function getPlatformPackageName(): string | null {
  const platform = process.platform as Platform;
  const arch = process.arch;

  const platformMap: Record<string, string> = {
    'darwin-arm64': '@ast-grep/cli-darwin-arm64',
    'darwin-x64': '@ast-grep/cli-darwin-x64',
    'linux-arm64': '@ast-grep/cli-linux-arm64-gnu',
    'linux-x64': '@ast-grep/cli-linux-x64-gnu',
    'win32-x64': '@ast-grep/cli-win32-x64-msvc',
    'win32-arm64': '@ast-grep/cli-win32-arm64-msvc',
    'win32-ia32': '@ast-grep/cli-win32-ia32-msvc',
  };

  return platformMap[`${platform}-${arch}`] ?? null;
}

// Single source of truth for resolved CLI path
let resolvedCliPath: string | null = null;

export function findSgCliPathSync(): string | null {
  const binaryName = process.platform === 'win32' ? 'sg.exe' : 'sg';

  const cachedPath = getCachedBinaryPath();
  if (cachedPath && isValidBinary(cachedPath)) {
    return cachedPath;
  }

  try {
    const require = createRequire(import.meta.url);
    const cliPkgPath = require.resolve('@ast-grep/cli/package.json');
    const cliDir = dirname(cliPkgPath);
    const sgPath = join(cliDir, binaryName);

    if (existsSync(sgPath) && isValidBinary(sgPath)) {
      return sgPath;
    }
  } catch {
    // @ast-grep/cli not installed
  }

  const platformPkg = getPlatformPackageName();
  if (platformPkg) {
    try {
      const require = createRequire(import.meta.url);
      const pkgPath = require.resolve(`${platformPkg}/package.json`);
      const pkgDir = dirname(pkgPath);
      const astGrepName =
        process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep';
      const binaryPath = join(pkgDir, astGrepName);

      if (existsSync(binaryPath) && isValidBinary(binaryPath)) {
        return binaryPath;
      }
    } catch {
      // Platform-specific package not installed
    }
  }

  if (process.platform === 'darwin') {
    const homebrewPaths = ['/opt/homebrew/bin/sg', '/usr/local/bin/sg'];
    for (const path of homebrewPaths) {
      if (existsSync(path) && isValidBinary(path)) {
        return path;
      }
    }
  }

  return null;
}

export function getSgCliPath(): string {
  if (resolvedCliPath !== null) {
    return resolvedCliPath;
  }

  const syncPath = findSgCliPathSync();
  if (syncPath) {
    resolvedCliPath = syncPath;
    return syncPath;
  }

  return 'sg';
}

export function setSgCliPath(path: string): void {
  resolvedCliPath = path;
}

// Defaults
export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
export const DEFAULT_MAX_MATCHES = 500;

interface EnvironmentCheckResult {
  cli: {
    available: boolean;
    path: string;
    error?: string;
  };
}
