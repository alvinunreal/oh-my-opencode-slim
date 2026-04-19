import { DEFAULT_GREP_RETRY_COUNT } from './constants';
import {
  executeContentLikeMode,
  executeCountMode,
  executeFilesMode,
} from './direct';
import { buildGrepCommand, executeGrepFallback } from './fallback';
import { buildDiscoveryInput, executeMtimeMode } from './mtime';
import {
  type ResolvedGrepCli,
  resolveGrepCli,
  resolveGrepCliWithAutoInstall,
} from './resolver';
import { createEmptyResult } from './result-utils';
import { buildRgCommand } from './rg-args';
import {
  AbortWaitError,
  createGlobalAbortState,
  getRetryBackoffMs,
  RetryableRipgrepError,
  RUNNER_SEMAPHORE,
  remainingTimeout,
  sleepWithSignal,
  toErrorMessage,
} from './runtime';
import type {
  GrepRunner,
  GrepSearchResult,
  NormalizedGrepInput,
} from './types';

function buildFailureMeta(
  input: NormalizedGrepInput,
  cli: ResolvedGrepCli,
): Pick<GrepSearchResult, 'strategy' | 'discoveryCommand'> {
  if (input.sortBy !== 'mtime' || cli.backend === 'grep') {
    return { strategy: 'direct', discoveryCommand: undefined };
  }

  const discoveryInput = buildDiscoveryInput(input);

  return {
    strategy: 'mtime-hybrid',
    discoveryCommand: buildRgCommand(discoveryInput, cli.path),
  };
}

async function executeOnce(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
): Promise<GrepSearchResult> {
  if (cli.backend === 'grep') {
    return executeGrepFallback(input, signal, cli);
  }

  if (input.sortBy === 'mtime') {
    return executeMtimeMode(input, signal, cli);
  }

  if (input.outputMode === 'files_with_matches') {
    return executeFilesMode(input, signal, cli);
  }

  if (input.outputMode === 'count') {
    return executeCountMode(input, signal, cli);
  }

  return executeContentLikeMode(input, signal, cli);
}

function buildPreviewCommand(
  input: NormalizedGrepInput,
  cli: ResolvedGrepCli,
): string[] | undefined {
  if (cli.backend === 'grep') {
    return buildGrepCommand(input, cli.path).command;
  }

  if (input.sortBy === 'mtime') {
    return undefined;
  }

  return buildRgCommand(input, cli.path);
}

async function resolveCliForExecution(
  signal: AbortSignal,
): Promise<ResolvedGrepCli> {
  if (signal.aborted) {
    throw new AbortWaitError('Search was cancelled before execution started.');
  }

  return resolveGrepCliWithAutoInstall({}, signal);
}

export const runRipgrep: GrepRunner = async (input, signal) => {
  const previewCli = resolveGrepCli();
  const command = buildPreviewCommand(input, previewCli);
  const deadline = Date.now() + input.timeoutMs;
  const globalAbort = createGlobalAbortState(signal, input.timeoutMs);

  const createAbortedResult = (
    attempt: number,
    error?: string,
  ): GrepSearchResult => ({
    ...createEmptyResult(input, command),
    ...buildFailureMeta(input, previewCli),
    truncated: globalAbort.getTimedOut() || globalAbort.getCancelled(),
    timedOut: globalAbort.getTimedOut(),
    cancelled: globalAbort.getCancelled(),
    retryCount: attempt,
    ...(error ? { error } : {}),
  });

  try {
    return await RUNNER_SEMAPHORE.use(async () => {
      let attempt = 0;
      let cli: ResolvedGrepCli;

      try {
        cli = await resolveCliForExecution(globalAbort.signal);
      } catch (error) {
        if (error instanceof AbortWaitError || globalAbort.signal.aborted) {
          return createAbortedResult(attempt);
        }

        return {
          ...createAbortedResult(attempt),
          error: toErrorMessage(error),
        };
      }

      if (cli.backend === 'grep') {
        const grepInput: NormalizedGrepInput = {
          ...input,
          timeoutMs: Math.max(1, remainingTimeout(deadline)),
        };
        const result = await executeOnce(grepInput, globalAbort.signal, cli);
        result.retryCount = attempt;
        return result;
      }

      while (true) {
        const remaining = remainingTimeout(deadline);
        if (globalAbort.signal.aborted || remaining <= 1) {
          if (!globalAbort.signal.aborted && remaining <= 1) {
            globalAbort.timeout();
          }
          return createAbortedResult(attempt);
        }

        const scopedInput: NormalizedGrepInput = {
          ...input,
          timeoutMs: remaining,
        };

        try {
          const result = await executeOnce(
            scopedInput,
            globalAbort.signal,
            cli,
          );
          result.retryCount = attempt;
          return result;
        } catch (error) {
          if (error instanceof AbortWaitError || globalAbort.signal.aborted) {
            return createAbortedResult(attempt);
          }

          if (
            !(error instanceof RetryableRipgrepError) ||
            attempt >= DEFAULT_GREP_RETRY_COUNT
          ) {
            return {
              ...createAbortedResult(attempt),
              error: toErrorMessage(error),
            };
          }

          attempt += 1;

          try {
            await sleepWithSignal(
              getRetryBackoffMs(deadline),
              globalAbort.signal,
            );
          } catch {
            return createAbortedResult(attempt);
          }
        }
      }
    }, globalAbort.signal);
  } catch (error) {
    if (error instanceof AbortWaitError || globalAbort.signal.aborted) {
      return createAbortedResult(0);
    }

    return {
      ...createEmptyResult(input, command),
      ...buildFailureMeta(input, previewCli),
      error: toErrorMessage(error),
    };
  } finally {
    globalAbort.cleanup();
  }
};
