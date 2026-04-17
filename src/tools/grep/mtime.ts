import { stat } from 'node:fs/promises';
import { MAX_MTIME_DISCOVERY_FILES } from './constants';
import {
  executeContentLikeMode,
  executeCountMode,
  executeFilesMode,
} from './direct';
import type { ResolvedGrepCli } from './resolver';
import {
  countOccurrences,
  countVisibleMatches,
  createEmptyResult,
  finalizeMtimeContentResult,
  finalizeMtimeSimpleResult,
} from './result-utils';
import { buildRgCommand } from './rg-args';
import { getAbortKind, isTimedOutAbort, remainingTimeout } from './runtime';
import type {
  GrepFileMatch,
  GrepSearchResult,
  NormalizedGrepInput,
} from './types';

function formatStatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildDiscoveryInput(
  input: NormalizedGrepInput,
): NormalizedGrepInput {
  return {
    ...input,
    outputMode: 'files_with_matches',
    sortBy: 'none',
    sortOrder: 'asc',
    maxResults: MAX_MTIME_DISCOVERY_FILES,
    maxCountPerFile: undefined,
  };
}

async function statWithTimeout(
  filePath: string,
  signal: AbortSignal,
  deadline: number,
): Promise<
  | { status: 'ok'; mtimeMs: number }
  | { status: 'error'; error: string }
  | { status: 'timed_out' }
  | { status: 'cancelled' }
> {
  if (signal.aborted) {
    return { status: isTimedOutAbort(signal) ? 'timed_out' : 'cancelled' };
  }

  const timeoutMs = remainingTimeout(deadline);
  if (timeoutMs <= 1) {
    return { status: 'timed_out' };
  }

  const timeoutSentinel = Symbol('grep-stat-timeout');
  const cancelSentinel = Symbol('grep-stat-cancel');
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortCleanup: (() => void) | undefined;

  try {
    const stats = await Promise.race([
      stat(filePath),
      new Promise<typeof timeoutSentinel>((resolve) => {
        timeoutId = setTimeout(() => resolve(timeoutSentinel), timeoutMs);
      }),
      new Promise<typeof cancelSentinel>((resolve) => {
        const onAbort = () => resolve(cancelSentinel);
        signal.addEventListener('abort', onAbort, { once: true });
        abortCleanup = () => signal.removeEventListener('abort', onAbort);
      }),
    ]);

    if (stats === timeoutSentinel) {
      return { status: 'timed_out' };
    }

    if (stats === cancelSentinel) {
      return { status: isTimedOutAbort(signal) ? 'timed_out' : 'cancelled' };
    }

    return { status: 'ok', mtimeMs: stats.mtimeMs };
  } catch (error) {
    return { status: 'error', error: formatStatError(error) };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    abortCleanup?.();
  }
}

async function sortFilesByMtime(
  files: GrepFileMatch[],
  input: Pick<NormalizedGrepInput, 'sortOrder'>,
  signal: AbortSignal,
  deadline: number,
): Promise<{
  files: GrepFileMatch[];
  timedOut: boolean;
  cancelled: boolean;
  hadMore: boolean;
  warnings: string[];
}> {
  const entries: Array<{
    file: GrepFileMatch;
    mtimeMs: number;
    statFailed: boolean;
  }> = [];
  const warnings: string[] = [];
  let index = 0;
  let processedCount = 0;
  let timedOut = false;
  let cancelled = false;

  const workers = Array.from(
    { length: Math.max(1, Math.min(16, files.length)) },
    async () => {
      while (true) {
        if (signal.aborted) {
          if (isTimedOutAbort(signal)) {
            timedOut = true;
          } else {
            cancelled = true;
          }
          return;
        }

        if (Date.now() >= deadline) {
          timedOut = true;
          return;
        }

        const current = index;
        index += 1;
        if (current >= files.length) {
          return;
        }

        const file = files[current] as GrepFileMatch;
        if (!file.replayPath) {
          warnings.push(
            `Could not stat ${file.file} for mtime ordering: non-UTF8 paths are not orderable safely.`,
          );
          entries.push({
            file,
            mtimeMs: Number.NEGATIVE_INFINITY,
            statFailed: true,
          });
          processedCount += 1;
          continue;
        }

        const statResult = await statWithTimeout(
          file.replayPath,
          signal,
          deadline,
        );
        if (statResult.status === 'timed_out') {
          timedOut = true;
          return;
        }

        if (statResult.status === 'cancelled') {
          cancelled = true;
          return;
        }

        if (statResult.status === 'error') {
          warnings.push(
            `Could not stat ${file.file} for mtime ordering: ${statResult.error}`,
          );
          entries.push({
            file,
            mtimeMs: Number.NEGATIVE_INFINITY,
            statFailed: true,
          });
          processedCount += 1;
          continue;
        }

        entries.push({ file, mtimeMs: statResult.mtimeMs, statFailed: false });
        processedCount += 1;
      }
    },
  );

  await Promise.all(workers);

  entries.sort((left, right) => {
    if (left.statFailed !== right.statFailed) {
      return left.statFailed ? 1 : -1;
    }

    const delta = left.mtimeMs - right.mtimeMs;
    if (delta !== 0) {
      return input.sortOrder === 'desc' ? -delta : delta;
    }

    return left.file.file.localeCompare(right.file.file);
  });

  return {
    files: entries.map((entry) => entry.file),
    timedOut,
    cancelled,
    hadMore: processedCount < files.length,
    warnings,
  };
}

function withSearchTargets(
  input: NormalizedGrepInput,
  searchTargets: string[],
  timeoutMs: number,
  maxResults = input.maxResults,
): NormalizedGrepInput {
  return {
    ...input,
    searchPath: searchTargets[0] ?? input.searchPath,
    requestedPath:
      searchTargets.length === 1
        ? (searchTargets[0] ?? input.requestedPath)
        : input.requestedPath,
    permissionPatterns: searchTargets,
    maxResults,
    timeoutMs: Math.max(1, timeoutMs),
    sortBy: 'none',
    sortOrder: 'asc',
    searchTargets,
  };
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

function reorderFilesByReplayOrder(
  files: GrepFileMatch[],
  orderedTargets: string[],
): GrepFileMatch[] {
  const order = new Map<string, number>();
  orderedTargets.forEach((target, index) => {
    order.set(target, index);
  });

  return [...files].sort((left, right) => {
    const leftOrder =
      order.get(left.replayPath ?? left.absolutePath) ??
      Number.MAX_SAFE_INTEGER;
    const rightOrder =
      order.get(right.replayPath ?? right.absolutePath) ??
      Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
}

async function discoverMatchingFiles(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
): Promise<GrepSearchResult> {
  const discoveryInput = buildDiscoveryInput(input);
  const result = await executeFilesMode(discoveryInput, signal, cli);

  if (result.limitReached) {
    result.truncated = true;
    result.warnings.push(
      `mtime discovery capped at ${MAX_MTIME_DISCOVERY_FILES} matching files; ordering may be partial.`,
    );
  }

  if (result.error && result.totalFiles === 0 && result.totalMatches === 0) {
    throw new Error(result.error);
  }

  if (result.error) {
    result.truncated = true;
    result.warnings.push(`Partial discovery failure: ${result.error}`);
    result.error = undefined;
  }

  return result;
}

export async function executeMtimeMode(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
): Promise<GrepSearchResult> {
  const deadline = Date.now() + input.timeoutMs;
  const discovery = await discoverMatchingFiles(input, signal, cli);
  const discoveryInput = buildDiscoveryInput(input);
  const baseMtimeResult: GrepSearchResult = {
    ...createEmptyResult(input),
    backend: 'rg',
  };
  const strategyMeta = {
    strategy: 'mtime-hybrid' as const,
    discoveryCommand: buildRgCommand(discoveryInput, cli.path),
    discoveredFiles: discovery.files.length,
    mtimeDiscoveryCapped: discovery.limitReached,
  };

  const nonReplayableFiles = discovery.files.filter((file) => !file.replayPath);

  if (nonReplayableFiles.length > 0) {
    const timeoutMs = Math.max(1, remainingTimeout(deadline));
    const fallbackInput: NormalizedGrepInput = {
      ...input,
      sortBy: 'none',
      sortOrder: 'asc',
      timeoutMs,
    };
    const fallback =
      input.outputMode === 'files_with_matches'
        ? await executeFilesMode(fallbackInput, signal, cli)
        : input.outputMode === 'count'
          ? await executeCountMode(fallbackInput, signal, cli)
          : await executeContentLikeMode(fallbackInput, signal, cli);

    return {
      ...fallback,
      strategy: 'mtime-fallback',
      discoveryCommand: strategyMeta.discoveryCommand,
      discoveredFiles: strategyMeta.discoveredFiles,
      mtimeDiscoveryCapped: strategyMeta.mtimeDiscoveryCapped,
      warnings: [
        ...discovery.warnings,
        `mtime ordering disabled: ${nonReplayableFiles.length} non-UTF8 ${nonReplayableFiles.length === 1 ? 'path is' : 'paths are'} not safely orderable; returned direct search results instead.`,
        ...fallback.warnings,
      ],
    };
  }

  const sortedDiscovery = await sortFilesByMtime(
    discovery.files,
    input,
    signal,
    deadline,
  );
  const sortedFiles = sortedDiscovery.files;
  const fullStrategyMeta = {
    ...strategyMeta,
    sortedFiles: sortedFiles.length,
    replayTargetCount: sortedFiles.filter((file) => file.replayPath).length,
  };

  if (input.outputMode === 'files_with_matches') {
    return finalizeMtimeSimpleResult(
      input,
      sortedFiles,
      {
        ...baseMtimeResult,
        ...fullStrategyMeta,
        truncated:
          discovery.truncated ||
          sortedDiscovery.hadMore ||
          sortedDiscovery.timedOut ||
          sortedDiscovery.cancelled,
        timedOut: discovery.timedOut || sortedDiscovery.timedOut,
        cancelled: discovery.cancelled || sortedDiscovery.cancelled,
        stderr: discovery.stderr,
        warnings: [...discovery.warnings, ...sortedDiscovery.warnings],
        retryCount: discovery.retryCount,
        exitCode: discovery.exitCode,
        summary: undefined,
        partialPhase:
          discovery.timedOut || discovery.cancelled
            ? 'discovery'
            : sortedDiscovery.timedOut || sortedDiscovery.cancelled
              ? 'mtime-sort'
              : undefined,
      },
      discovery.files.length > input.maxResults,
    );
  }

  if (
    discovery.timedOut ||
    discovery.cancelled ||
    sortedDiscovery.timedOut ||
    sortedDiscovery.cancelled
  ) {
    const warnings = [...discovery.warnings, ...sortedDiscovery.warnings];
    if (discovery.files.length > 0) {
      warnings.push(
        `mtime ${sortedDiscovery.timedOut || sortedDiscovery.cancelled ? 'sorting' : 'discovery'} stopped after discovering ${discovery.files.length} candidate ${discovery.files.length === 1 ? 'file' : 'files'}.`,
      );
    }

    return {
      ...baseMtimeResult,
      ...fullStrategyMeta,
      truncated: true,
      timedOut: discovery.timedOut || sortedDiscovery.timedOut,
      cancelled: discovery.cancelled || sortedDiscovery.cancelled,
      stderr: discovery.stderr,
      warnings,
      retryCount: discovery.retryCount,
      exitCode: discovery.exitCode,
      summary: undefined,
      partialPhase:
        discovery.timedOut || discovery.cancelled ? 'discovery' : 'mtime-sort',
    };
  }

  const collected: GrepFileMatch[] = [];
  let timedOut = false;
  let cancelled = false;
  let limitReached = false;
  let partialReplayFailure = false;
  let stderr = discovery.stderr;
  const warnings: string[] = [
    ...discovery.warnings,
    ...sortedDiscovery.warnings,
  ];
  let retryCount = discovery.retryCount;
  let exitCode = discovery.exitCode;
  let replayBatchCount = 0;
  let replayedFiles = 0;
  const replayableFiles = sortedFiles.filter((file) => {
    if (file.replayPath) {
      return true;
    }
    partialReplayFailure = true;
    warnings.push(
      `Skipped ${file.file} during mtime replay: non-UTF8 paths are not replayable safely.`,
    );
    return false;
  });

  const replayBatchSize = input.outputMode === 'content' ? 1 : 64;

  for (const batch of chunkArray(replayableFiles, replayBatchSize)) {
    if (signal.aborted) {
      if (getAbortKind(signal) === 'timeout') {
        timedOut = true;
      } else {
        cancelled = true;
      }
      break;
    }

    const timeoutMs = remainingTimeout(deadline);
    if (timeoutMs <= 1) {
      timedOut = true;
      break;
    }

    const orderedTargets = batch
      .map((file) => file.replayPath)
      .filter((value): value is string => Boolean(value));
    if (orderedTargets.length === 0) {
      continue;
    }

    const scopedInput = withSearchTargets(
      input,
      orderedTargets,
      timeoutMs,
      input.outputMode === 'count'
        ? Number.MAX_SAFE_INTEGER
        : Math.max(1, input.maxResults - countVisibleMatches(collected)),
    );
    replayBatchCount += 1;
    const partial =
      input.outputMode === 'count'
        ? await executeCountMode(scopedInput, signal, cli)
        : await executeContentLikeMode(scopedInput, signal, cli);

    retryCount += partial.retryCount;
    exitCode = Math.max(exitCode, partial.exitCode);
    if (partial.stderr) {
      stderr = partial.stderr;
    }
    warnings.push(...partial.warnings);
    if (partial.error) {
      partialReplayFailure = true;
      warnings.push(
        `Skipped mtime replay batch ${replayBatchCount}: ${partial.error}`,
      );
      continue;
    }

    timedOut = timedOut || partial.timedOut;
    cancelled = cancelled || partial.cancelled;
    limitReached = limitReached || partial.limitReached;
    const reordered = reorderFilesByReplayOrder(partial.files, orderedTargets);

    if (input.outputMode === 'count') {
      collected.push(...reordered);
      replayedFiles += reordered.length;

      if (collected.length >= input.maxResults) {
        limitReached = true;
      }

      if (limitReached || timedOut || cancelled) {
        break;
      }

      continue;
    }

    collected.push(...reordered);
    replayedFiles += reordered.length;

    const visibleMatches = countVisibleMatches(collected);
    if (visibleMatches >= input.maxResults) {
      limitReached = true;
    }

    if (limitReached || timedOut || cancelled) {
      break;
    }
  }

  const base = createEmptyResult(input);
  const partialBase: GrepSearchResult = {
    ...base,
    ...fullStrategyMeta,
    files: collected,
    totalMatches:
      input.outputMode === 'count'
        ? countOccurrences(collected)
        : countVisibleMatches(collected),
    totalFiles: collected.length,
    truncated:
      discovery.truncated ||
      sortedDiscovery.timedOut ||
      sortedDiscovery.cancelled ||
      sortedDiscovery.hadMore ||
      timedOut ||
      cancelled ||
      limitReached ||
      partialReplayFailure,
    limitReached,
    timedOut,
    cancelled,
    stderr,
    warnings,
    retryCount,
    exitCode,
    summary: undefined,
    replayBatchCount,
    replayedFiles,
    partialPhase:
      timedOut || cancelled || partialReplayFailure ? 'replay' : undefined,
  };

  if (input.outputMode === 'count') {
    return finalizeMtimeSimpleResult(
      input,
      collected,
      partialBase,
      limitReached || collected.length > input.maxResults,
    );
  }

  return finalizeMtimeContentResult(
    input,
    collected,
    partialBase,
    limitReached,
  );
}
