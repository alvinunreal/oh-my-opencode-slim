import { spawnSync } from 'node:child_process';
import { sync as whichSync } from 'which';
import { log } from '../../utils';
import { GREP_BINARY, RG_BINARY } from './constants';
import {
  getInstalledRipgrepPath,
  installLatestStableRipgrep,
} from './downloader';
import { AbortWaitError } from './runtime';
import type { GrepBackend } from './types';

export interface ResolvedGrepCli {
  path: string;
  backend: GrepBackend;
  source: 'system-rg' | 'managed-rg' | 'system-gnu-grep' | 'missing-rg';
}

interface GrepResolverDependencies {
  findExecutable?: (name: string) => string | null;
  getInstalledRipgrepPath?: () => string | null;
  installLatestStableRipgrep?: (signal?: AbortSignal) => Promise<string>;
  isSupportedGrep?: (path: string) => boolean;
  logger?: (message: string, data?: unknown) => void;
}

let autoInstallPromise: Promise<ResolvedGrepCli> | null = null;

function defaultFindExecutable(name: string): string | null {
  try {
    const resolved = whichSync(name, { nothrow: true });
    return Array.isArray(resolved) ? (resolved[0] ?? null) : (resolved ?? null);
  } catch {
    return null;
  }
}

function buildUnavailableBackendMessage(error?: unknown): string {
  const suffix =
    error instanceof Error && error.message.length > 0
      ? ` Auto-install error: ${error.message}`
      : '';

  return `Neither ripgrep (rg) nor GNU grep is available. Checked system rg, managed rg, ripgrep auto-install, and system grep.${suffix}`;
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof AbortWaitError ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function defaultIsSupportedGrep(binaryPath: string): boolean {
  try {
    const result = spawnSync(binaryPath, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.status !== 0) {
      return false;
    }

    const firstLine = result.stdout?.toString().split(/\r?\n/, 1)[0] ?? '';
    return firstLine.includes('GNU grep');
  } catch {
    return false;
  }
}

function resolveSync(deps: GrepResolverDependencies = {}): ResolvedGrepCli {
  const findExecutable = deps.findExecutable ?? defaultFindExecutable;
  const getManagedRipgrepPath =
    deps.getInstalledRipgrepPath ?? getInstalledRipgrepPath;
  const isSupportedGrep = deps.isSupportedGrep ?? defaultIsSupportedGrep;

  const systemRg = findExecutable(RG_BINARY);
  if (systemRg) {
    return {
      path: systemRg,
      backend: 'rg',
      source: 'system-rg',
    };
  }

  const managedRg = getManagedRipgrepPath();
  if (managedRg) {
    return {
      path: managedRg,
      backend: 'rg',
      source: 'managed-rg',
    };
  }

  const systemGrep = findExecutable(GREP_BINARY);
  if (systemGrep && isSupportedGrep(systemGrep)) {
    return {
      path: systemGrep,
      backend: 'grep',
      source: 'system-gnu-grep',
    };
  }

  return {
    path: RG_BINARY,
    backend: 'rg',
    source: 'missing-rg',
  };
}

export function resolveGrepCli(
  deps: GrepResolverDependencies = {},
): ResolvedGrepCli {
  return resolveSync(deps);
}

function isResolvedRipgrep(cli: ResolvedGrepCli): boolean {
  return cli.backend === 'rg' && cli.source !== 'missing-rg';
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    return Promise.reject(
      new AbortWaitError('Search was cancelled before execution started.'),
    );
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(
        new AbortWaitError('Search was cancelled before execution started.'),
      );
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function resolveGrepCliWithAutoInstall(
  deps: GrepResolverDependencies = {},
  signal?: AbortSignal,
): Promise<ResolvedGrepCli> {
  if (signal?.aborted) {
    throw new AbortWaitError('Search was cancelled before execution started.');
  }

  const current = resolveSync(deps);
  if (isResolvedRipgrep(current)) {
    return current;
  }

  if (autoInstallPromise) {
    return raceWithAbort(autoInstallPromise, signal);
  }

  autoInstallPromise = (async () => {
    const installManagedRipgrep =
      deps.installLatestStableRipgrep ?? installLatestStableRipgrep;

    try {
      const installedPath = await installManagedRipgrep(signal);
      return {
        path: installedPath,
        backend: 'rg' as const,
        source: 'managed-rg' as const,
      };
    } catch (error) {
      if (isAbortLikeError(error) || signal?.aborted) {
        throw new AbortWaitError(
          'Search was cancelled before execution started.',
        );
      }

      const fallback = resolveSync(deps);
      const logger = deps.logger ?? log;

      if (fallback.backend === 'grep') {
        logger('ripgrep auto-install failed; falling back to GNU grep.', {
          error: error instanceof Error ? error.message : String(error),
          grep_path: fallback.path,
        });
        return fallback;
      }

      logger('ripgrep auto-install failed and no GNU grep fallback exists.', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(buildUnavailableBackendMessage(error));
    } finally {
      autoInstallPromise = null;
    }
  })();

  return raceWithAbort(autoInstallPromise, signal);
}

export function resetGrepCliResolverForTests(): void {
  autoInstallPromise = null;
}
