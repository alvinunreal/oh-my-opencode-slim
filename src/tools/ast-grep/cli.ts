import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type CrossSpawnResult, crossSpawn } from '../../utils/compat';
import { applyRewrites } from './apply-rewrites';
import {
  DEFAULT_MAX_MATCHES,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  findSgCliPathSync,
  getSgCliPath,
  setSgCliPath,
} from './constants';
import { ensureAstGrepBinary, getBinaryName, getCacheDir } from './downloader';
import type { CliLanguage, CliMatch, SgResult } from './types';

export interface RunOptions {
  pattern: string;
  lang: CliLanguage;
  paths?: string[];
  globs?: string[];
  rewrite?: string;
  context?: number;
  updateAll?: boolean;
}

type SearchProcess = Pick<
  CrossSpawnResult,
  'stdout' | 'stderr' | 'exited' | 'kill'
>;
type TimerHandle = ReturnType<typeof setTimeout> | number;

interface RunDependencies {
  spawn?: (...args: Parameters<typeof crossSpawn>) => SearchProcess;
  ensureBinary?: typeof ensureAstGrepBinary;
  findBinary?: typeof findSgCliPathSync;
  setTimeout?: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
}

async function executeSg(
  cliPath: string,
  args: string[],
  dependencies: RunDependencies,
): Promise<[string, string, number]> {
  const spawn = dependencies.spawn ?? crossSpawn;
  const setTimer = dependencies.setTimeout ?? setTimeout;
  const clearTimer = dependencies.clearTimeout ?? clearTimeout;
  let timer: TimerHandle | undefined;
  let proc: SearchProcess | undefined;

  try {
    proc = spawn([cliPath, 'run', '--json=compact', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimer(() => {
        reject(new Error(`Search timeout after ${DEFAULT_TIMEOUT_MS}ms`));
      }, DEFAULT_TIMEOUT_MS);
    });
    // Observe exit rejection immediately, even if a stream never settles.
    return await Promise.race([
      Promise.all([proc.stdout(), proc.stderr(), proc.exited]),
      timeoutPromise,
    ]);
  } catch (error) {
    proc?.kill();
    throw error;
  } finally {
    if (timer !== undefined) clearTimer(timer);
  }
}

// Share initialization and recovery so callers cannot overwrite one download.
let initPromise: Promise<string | null> | null = null;

function initializeAstGrep(
  dependencies: RunDependencies = {},
  failedPath?: string,
): Promise<string | null> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const findBinary = dependencies.findBinary ?? findSgCliPathSync;
    const ensureBinary = dependencies.ensureBinary ?? ensureAstGrepBinary;
    // A stale path may have an installed replacement; try it offline.
    // Do not rediscover an existing binary that already failed to execute.
    const syncPath =
      !failedPath || !existsSync(failedPath) ? findBinary() : null;
    const recoveredPath =
      syncPath && existsSync(syncPath)
        ? syncPath
        : await ensureBinary(failedPath);
    if (recoveredPath) setSgCliPath(recoveredPath);
    return recoveredPath;
  })().finally(() => {
    initPromise = null;
  });

  return initPromise;
}

export async function getAstGrepPath(): Promise<string | null> {
  if (initPromise) return initPromise;

  const currentPath = getSgCliPath();
  if (currentPath !== 'sg' && existsSync(currentPath)) {
    return currentPath;
  }

  return initializeAstGrep();
}

function startBackgroundInit(): void {
  if (!initPromise) {
    getAstGrepPath().catch((err) => {
      console.warn(
        '[ast-grep] Background initialization failed:',
        err?.message ?? err,
      );
    });
  }
}

export async function runSg(
  options: RunOptions,
  dependencies: RunDependencies = {},
): Promise<SgResult> {
  const args = ['-p', options.pattern, '--lang', options.lang];

  if (options.rewrite) {
    args.push('-r', options.rewrite);
  }

  if (options.context && options.context > 0) {
    args.push('-C', String(options.context));
  }

  if (options.globs) {
    for (const glob of options.globs) {
      args.push('--globs', glob);
    }
  }

  const paths =
    options.paths && options.paths.length > 0 ? options.paths : ['.'];
  args.push(...paths);

  let cliPath = getSgCliPath();

  const timeout = DEFAULT_TIMEOUT_MS;
  let stdout = '';
  let stderr = '';
  let exitCode = 1;

  // One execution plus at most one recovery, including genuinely missing files.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      [stdout, stderr, exitCode] = await executeSg(cliPath, args, dependencies);
      break;
    } catch (e) {
      const error = e as NodeJS.ErrnoException;
      if (error.message?.includes('timeout')) {
        return {
          matches: [],
          totalMatches: 0,
          truncated: true,
          truncatedReason: 'timeout',
          error: error.message,
        };
      }

      if (
        ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code ?? '') ||
        error.message?.includes('ENOENT') ||
        error.message?.includes('not found')
      ) {
        // ENOENT can mean an existing binary has an unavailable ELF loader.
        const present = existsSync(cliPath);
        let recoveryError = '';
        if (attempt === 0) {
          try {
            const recoveredPath = await initializeAstGrep(
              dependencies,
              cliPath,
            );
            if (recoveredPath) {
              cliPath = recoveredPath;
              continue;
            }
          } catch (err) {
            recoveryError = ` ${(err as Error).message}`;
          }
        }
        return {
          matches: [],
          totalMatches: 0,
          truncated: false,
          error:
            (present
              ? `ast-grep CLI binary exists but cannot execute: ${cliPath}.\n`
              : `ast-grep CLI binary not found: ${cliPath}.\n`) +
            `${error.message}${recoveryError}\n\n` +
            `Automatic recovery failed on ${process.platform}-${process.arch}. ` +
            `The binary may require an unavailable loader (e.g. glibc on Alpine/musl).\n` +
            `Install a compatible binary in the plugin cache below, then restart OpenCode. ` +
            `On Alpine/musl, build it locally with cargo install ast-grep --locked:\n` +
            `  ${join(getCacheDir(), getBinaryName())}\n` +
            `Other manual install options:\n` +
            `  bun add -D @ast-grep/cli\n` +
            `  brew install ast-grep`,
        };
      }

      return {
        matches: [],
        totalMatches: 0,
        truncated: false,
        error: `Failed to spawn ast-grep: ${error.message}`,
      };
    }
  }

  if (exitCode !== 0 && stdout.trim() === '') {
    if (stderr.includes('No files found')) {
      return { matches: [], totalMatches: 0, truncated: false };
    }
    if (stderr.trim()) {
      return {
        matches: [],
        totalMatches: 0,
        truncated: false,
        error: stderr.trim(),
      };
    }
    return { matches: [], totalMatches: 0, truncated: false };
  }

  if (!stdout.trim()) {
    return { matches: [], totalMatches: 0, truncated: false };
  }

  // JSON mode reports rewrites but never writes them, even with --update-all.
  // Check the raw report before truncating it: a single match can exceed the
  // entire report budget and leave no parseable matches below.
  let rewritesApplied = false;
  if (
    options.rewrite &&
    options.updateAll &&
    stdout.trimStart().startsWith('[{')
  ) {
    const applyError = await applyRewrites(cliPath, args, timeout);
    if (applyError) {
      return {
        matches: [],
        totalMatches: 0,
        truncated: false,
        error: applyError,
      };
    }
    rewritesApplied = true;
  }

  const outputTruncated = stdout.length >= DEFAULT_MAX_OUTPUT_BYTES;
  const outputToProcess = outputTruncated
    ? stdout.substring(0, DEFAULT_MAX_OUTPUT_BYTES)
    : stdout;

  let matches: CliMatch[] = [];
  try {
    matches = JSON.parse(outputToProcess) as CliMatch[];
  } catch {
    if (outputTruncated) {
      try {
        const lastValidIndex = outputToProcess.lastIndexOf('}');
        if (lastValidIndex > 0) {
          const bracketIndex = outputToProcess.lastIndexOf(
            '},',
            lastValidIndex,
          );
          if (bracketIndex > 0) {
            const truncatedJson = `${outputToProcess.substring(0, bracketIndex + 1)}]`;
            matches = JSON.parse(truncatedJson) as CliMatch[];
          }
        }
      } catch {
        return {
          matches: [],
          totalMatches: 0,
          truncated: true,
          truncatedReason: 'max_output_bytes',
          error: 'Output too large and could not be parsed',
          rewritesApplied,
        };
      }
    } else {
      return { matches: [], totalMatches: 0, truncated: false };
    }
  }

  const totalMatches = matches.length;
  const matchesTruncated = totalMatches > DEFAULT_MAX_MATCHES;
  const finalMatches = matchesTruncated
    ? matches.slice(0, DEFAULT_MAX_MATCHES)
    : matches;

  return {
    matches: finalMatches,
    totalMatches,
    rewritesApplied,
    truncated: outputTruncated || matchesTruncated,
    truncatedReason: outputTruncated
      ? 'max_output_bytes'
      : matchesTruncated
        ? 'max_matches'
        : undefined,
  };
}

function isCliAvailable(): boolean {
  const path = findSgCliPathSync();
  return path !== null && existsSync(path);
}

async function ensureCliAvailable(): Promise<boolean> {
  const path = await getAstGrepPath();
  return path !== null && existsSync(path);
}
