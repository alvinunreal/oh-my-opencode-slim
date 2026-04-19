import { GrepAggregator } from './aggregate';
import {
  consumeNullCountPairsBytes,
  consumeNullItemsBytes,
  consumeRgJsonStream,
  readTextStream,
} from './json-stream';
import { buildPathFromBytes } from './path-utils';
import type { ResolvedGrepCli } from './resolver';
import {
  applySuccessfulStderr,
  createEmptyResult,
  finalizeNonFatalExit,
  hasVisibleResults,
} from './result-utils';
import { buildRgCommand } from './rg-args';
import {
  attachTerminationHandlers,
  createFriendlySpawnError,
  type GrepProcess,
  getAbortKind,
  isTransientFailure,
  isTransientStderr,
  killProcess,
  RetryableRipgrepError,
  spawnRipgrep,
  type TerminationState,
  toErrorMessage,
  waitForExitAndStderr,
} from './runtime';
import type {
  GrepFileMatch,
  GrepSearchResult,
  NormalizedGrepInput,
} from './types';

interface ContentState {
  aggregator: GrepAggregator;
  killedForLimit: boolean;
}

interface CountState {
  files: GrepFileMatch[];
  totalMatches: number;
  limitReached: boolean;
}

interface FilesState {
  files: GrepFileMatch[];
  limitReached: boolean;
  seen: Set<string>;
}

function buildFileMatch(
  filePath: Uint8Array,
  input: Pick<NormalizedGrepInput, 'cwd' | 'worktree'>,
  matchCount: number,
): GrepFileMatch | undefined {
  if (filePath.length === 0) {
    return undefined;
  }

  const pathInfo = buildPathFromBytes(filePath, input.cwd, input.worktree);
  return {
    file: pathInfo.displayPath,
    absolutePath: pathInfo.absolutePath,
    replayPath: pathInfo.replayPath,
    nonUtf8Path: pathInfo.nonUtf8Path,
    pathKey: pathInfo.pathKey,
    matchCount,
    matches: [],
  };
}

function parseCountRecordBytes(
  filePath: Uint8Array,
  countText: string,
  input: Pick<NormalizedGrepInput, 'cwd' | 'worktree'>,
): GrepFileMatch | undefined {
  if (!/^\d+$/.test(countText)) {
    return undefined;
  }

  const count = Number.parseInt(countText, 10);
  if (!Number.isFinite(count)) {
    return undefined;
  }

  return buildFileMatch(filePath, input, count);
}

function buildFileMatchFromBytes(
  filePath: Uint8Array,
  input: Pick<NormalizedGrepInput, 'cwd' | 'worktree'>,
): GrepFileMatch | undefined {
  return buildFileMatch(filePath, input, 1);
}

function simpleIsStopped(
  state: { limitReached: boolean },
  termination: TerminationState,
): boolean {
  return termination.timedOut || termination.cancelled || state.limitReached;
}

async function executeMode<TState>(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
  options: {
    init: () => TState;
    consumeStdout: (
      stdout: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
      proc: GrepProcess,
      state: TState,
    ) => Promise<void>;
    buildResult: (
      baseResult: GrepSearchResult,
      state: TState,
      termination: TerminationState,
      exitCode: number,
      stderr: string,
    ) => GrepSearchResult;
    isStopped: (state: TState, termination: TerminationState) => boolean;
  },
): Promise<GrepSearchResult> {
  const command = buildRgCommand(input, cli.path);
  const baseResult: GrepSearchResult = {
    ...createEmptyResult(input, command),
    backend: 'rg',
  };

  if (signal.aborted) {
    return {
      ...baseResult,
      truncated: true,
      timedOut: getAbortKind(signal) === 'timeout',
      cancelled: getAbortKind(signal) !== 'timeout',
    };
  }

  let proc: GrepProcess;
  try {
    proc = spawnRipgrep(command, input.cwd);
  } catch (error) {
    const friendlyMessage = createFriendlySpawnError(error, cli);
    if (friendlyMessage) {
      return {
        ...baseResult,
        error: friendlyMessage,
      };
    }

    if (isTransientFailure(error)) {
      throw new RetryableRipgrepError(toErrorMessage(error));
    }

    return {
      ...baseResult,
      error:
        error instanceof Error
          ? error.message
          : `Failed to spawn ${cli.backend}`,
    };
  }

  const state = options.init();
  const termination = attachTerminationHandlers(proc, input.timeoutMs, signal);

  try {
    const stdout = proc.proc.stdout ?? undefined;
    const stderrStream = proc.proc.stderr ?? undefined;
    const stdoutPromise = options.consumeStdout(stdout, proc, state);
    const stderrPromise = readTextStream(stderrStream);

    let stdoutError: unknown;
    try {
      await stdoutPromise;
    } catch (error) {
      stdoutError = error;
    }

    const { exitCode, stderr } = await waitForExitAndStderr(
      proc,
      stderrPromise,
    );
    const result = options.buildResult(
      baseResult,
      state,
      termination.state,
      exitCode,
      stderr.trim(),
    );

    if (stdoutError && !options.isStopped(state, termination.state)) {
      if (isTransientFailure(stdoutError)) {
        throw new RetryableRipgrepError(toErrorMessage(stdoutError));
      }

      if (hasVisibleResults(result)) {
        result.truncated = true;
        result.warnings.push(
          `Partial output processing failure: ${toErrorMessage(stdoutError)}`,
        );
        return result;
      }

      result.error =
        stdoutError instanceof Error
          ? stdoutError.message
          : 'Failed to process rg output';
      return result;
    }

    applySuccessfulStderr(result, result.stderr, exitCode);

    if (options.isStopped(state, termination.state)) {
      return result;
    }

    const nonFatal = finalizeNonFatalExit(result, exitCode);
    if (nonFatal) {
      return nonFatal;
    }

    if (isTransientStderr(result.stderr)) {
      throw new RetryableRipgrepError(result.stderr);
    }

    result.error = result.stderr || `rg exited with code ${String(exitCode)}`;
    return result;
  } finally {
    termination.cleanup();
  }
}

export async function executeContentLikeMode(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
): Promise<GrepSearchResult> {
  return executeMode(input, signal, cli, {
    init: (): ContentState => ({
      aggregator: new GrepAggregator({
        cwd: input.cwd,
        worktree: input.worktree,
        maxResults: input.maxResults,
        beforeContext: input.beforeContext,
        afterContext: input.afterContext,
      }),
      killedForLimit: false,
    }),
    consumeStdout: async (stdout, proc, state) =>
      consumeRgJsonStream(stdout, (event) => {
        state.aggregator.consume(event);

        if (state.aggregator.isFull()) {
          state.killedForLimit = true;
          killProcess(proc);
          return false;
        }

        return true;
      }),
    buildResult: (baseResult, state, termination, exitCode, stderr) => {
      const snapshot = state.aggregator.snapshot();
      return {
        ...baseResult,
        ...snapshot,
        truncated:
          snapshot.limitReached ||
          state.killedForLimit ||
          termination.timedOut ||
          termination.cancelled,
        limitReached: snapshot.limitReached || state.killedForLimit,
        timedOut: termination.timedOut,
        cancelled: termination.cancelled,
        exitCode,
        stderr,
        summary: snapshot.summary,
        warnings: [],
      };
    },
    isStopped: (state, termination) =>
      termination.timedOut ||
      termination.cancelled ||
      state.killedForLimit ||
      state.aggregator.snapshot().limitReached,
  });
}

export async function executeCountMode(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
): Promise<GrepSearchResult> {
  return executeMode(input, signal, cli, {
    init: (): CountState => ({
      files: [],
      totalMatches: 0,
      limitReached: false,
    }),
    consumeStdout: async (stdout, proc, state) =>
      consumeNullCountPairsBytes(stdout, (filePath, countText) => {
        const file = parseCountRecordBytes(filePath, countText, input);
        if (!file) {
          return true;
        }

        state.files.push(file);
        state.totalMatches += file.matchCount;

        if (state.files.length >= input.maxResults) {
          state.limitReached = true;
          killProcess(proc);
          return false;
        }

        return true;
      }),
    buildResult: (baseResult, state, termination, exitCode, stderr) => ({
      ...baseResult,
      files: state.files,
      totalMatches: state.totalMatches,
      totalFiles: state.files.length,
      truncated:
        state.limitReached || termination.timedOut || termination.cancelled,
      limitReached: state.limitReached,
      timedOut: termination.timedOut,
      cancelled: termination.cancelled,
      exitCode,
      stderr,
      warnings: [],
    }),
    isStopped: simpleIsStopped,
  });
}

export async function executeFilesMode(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
): Promise<GrepSearchResult> {
  return executeMode(input, signal, cli, {
    init: (): FilesState => ({
      files: [],
      limitReached: false,
      seen: new Set<string>(),
    }),
    consumeStdout: async (stdout, proc, state) =>
      consumeNullItemsBytes(stdout, (filePath) => {
        const file = buildFileMatchFromBytes(filePath, input);
        if (!file) {
          return true;
        }

        const seenKey = file.pathKey ?? file.absolutePath;
        if (state.seen.has(seenKey)) {
          return true;
        }

        state.seen.add(seenKey);
        state.files.push(file);

        if (state.files.length >= input.maxResults) {
          state.limitReached = true;
          killProcess(proc);
          return false;
        }

        return true;
      }),
    buildResult: (baseResult, state, termination, exitCode, stderr) => ({
      ...baseResult,
      files: state.files,
      totalMatches: state.files.length,
      totalFiles: state.files.length,
      truncated:
        state.limitReached || termination.timedOut || termination.cancelled,
      limitReached: state.limitReached,
      timedOut: termination.timedOut,
      cancelled: termination.cancelled,
      exitCode,
      stderr,
      warnings: [],
    }),
    isStopped: simpleIsStopped,
  });
}
