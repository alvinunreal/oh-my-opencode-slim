import { Readable } from 'node:stream';
import { GREP_BINARY } from './constants';
import {
  consumeNullCountPairsBytes,
  consumeNullItemsBytes,
  readTextStream,
} from './json-stream';
import {
  getDisplayPath,
  normalizeDisplayText,
  resolveAbsolutePath,
  stripSingleLineEnding,
} from './path-utils';
import type { ResolvedGrepCli } from './resolver';
import {
  applySuccessfulStderr,
  countOccurrences,
  countVisibleMatches,
  createEmptyResult,
  getMatchKind,
  hasVisibleResults,
  trimFilesToLineLimit,
} from './result-utils';
import { appendContextArgs } from './rg-args';
import {
  attachTerminationHandlers,
  createFriendlySpawnError,
  type GrepProcess,
  getAbortKind,
  isTransientFailure,
  isTransientStderr,
  killProcess,
  spawnRipgrep,
  toErrorMessage,
  waitForExitAndStderr,
} from './runtime';
import type {
  GrepContextLine,
  GrepFileMatch,
  GrepSearchResult,
  NormalizedGrepInput,
} from './types';

interface BuiltGrepCommand {
  command: string[];
  warnings: string[];
}

interface ParsedContentRecord {
  filePath: string;
  lineNumber: number;
  text: string;
  isMatch: boolean;
}

function isSimpleBasenameGlob(glob: string): boolean {
  return !glob.includes('/') && !glob.includes('\\') && !glob.includes('**');
}

interface GnuGrepCheckResult {
  error?: string;
  cacheable: boolean;
}

const GNU_GREP_CACHE = new Map<string, Promise<GnuGrepCheckResult>>();

function isAbortLikeFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.name === 'AbortError' ||
    message.includes('aborted') ||
    message.includes('cancelled') ||
    message.includes('canceled')
  );
}

function shouldCacheGnuGrepFailure(
  error: unknown,
  stderr?: string,
  firstLine?: string,
): boolean {
  if (isTransientFailure(error) || isAbortLikeFailure(error)) {
    return false;
  }

  if (stderr && isTransientStderr(stderr)) {
    return false;
  }

  if (firstLine !== undefined && firstLine.length === 0) {
    return false;
  }

  return true;
}

function toWebReadableStream(
  stream: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
): ReadableStream<Uint8Array> | undefined {
  if (!stream) {
    return undefined;
  }

  if ('getReader' in stream && typeof stream.getReader === 'function') {
    return stream as ReadableStream<Uint8Array>;
  }

  return Readable.toWeb(
    stream as unknown as Readable,
  ) as unknown as ReadableStream<Uint8Array>;
}

function appendGlobArgs(args: string[], input: NormalizedGrepInput): void {
  const includeGlobs = [
    ...(input.include ? [input.include] : []),
    ...input.globs.filter((glob) => !glob.startsWith('!')),
  ].filter(isSimpleBasenameGlob);
  const excludeGlobs = [
    ...input.globs
      .filter((glob) => glob.startsWith('!'))
      .map((glob) => glob.slice(1)),
    ...input.excludeGlobs.map((glob) =>
      glob.startsWith('!') ? glob.slice(1) : glob,
    ),
  ].filter(isSimpleBasenameGlob);

  for (const glob of includeGlobs) {
    args.push('--include', glob);
  }

  for (const glob of excludeGlobs) {
    args.push('--exclude', glob);
  }
}

function shouldUseIgnoreCase(input: NormalizedGrepInput): boolean {
  if (input.smartCase) {
    return !/[A-Z]/.test(input.pattern);
  }

  return !input.caseSensitive;
}

function buildUnsupportedWarnings(input: NormalizedGrepInput): string[] {
  const warnings: string[] = [];

  if (input.multiline || input.multilineDotall) {
    warnings.push(
      'GNU grep fallback does not support multiline matching; results may differ from ripgrep.',
    );
  }

  if (input.pcre2) {
    warnings.push(
      'GNU grep fallback does not support ripgrep PCRE2 mode; using grep regex support instead.',
    );
  }

  if (
    input.fileType ||
    input.fileTypes.length > 0 ||
    input.excludeFileTypes.length > 0
  ) {
    warnings.push(
      'GNU grep fallback ignores ripgrep file type filters; use globs for exact control.',
    );
  }

  if (input.maxFilesize) {
    warnings.push(
      'GNU grep fallback ignores max_filesize; large files may still be searched.',
    );
  }

  const pathAwareGlobs = [
    ...(input.include ? [input.include] : []),
    ...input.globs,
    ...input.excludeGlobs,
  ].filter(
    (glob) =>
      !isSimpleBasenameGlob(glob.startsWith('!') ? glob.slice(1) : glob),
  );

  if (pathAwareGlobs.length > 0) {
    warnings.push(
      'GNU grep fallback ignores path-aware glob patterns; only simple basename globs are supported.',
    );
  }

  if (input.sortBy === 'mtime') {
    warnings.push(
      'GNU grep fallback ignores sort_by=mtime; returning unsorted direct results instead.',
    );
  }

  if (input.outputMode === 'count') {
    warnings.push(
      'GNU grep fallback count mode reports matching lines per file, not ripgrep occurrence counts.',
    );
  }

  return warnings;
}

export function buildGrepCommand(
  input: NormalizedGrepInput,
  binaryPath = GREP_BINARY,
): BuiltGrepCommand {
  const args: string[] = [input.followSymlinks ? '-R' : '-r', '--color=never'];
  const warnings = buildUnsupportedWarnings(input);

  if (input.outputMode === 'content') {
    args.push('-Z', '-H', '-n');
  } else if (input.outputMode === 'files_with_matches') {
    args.push('-Z', '-l');
  } else {
    args.push('-Z', '-H', '-c');
  }

  if (!input.hidden) {
    args.push('--exclude=.*', '--exclude-dir=.*');
  }

  if (shouldUseIgnoreCase(input)) {
    args.push('-i');
  }

  if (input.wordRegexp) {
    args.push('-w');
  }

  if (input.fixedStrings) {
    args.push('-F');
  }

  if (input.invertMatch) {
    args.push('-v');
  }

  if (input.maxCountPerFile) {
    args.push('-m', String(input.maxCountPerFile));
  }

  appendContextArgs(args, input);
  appendGlobArgs(args, input);
  args.push(
    '-e',
    input.pattern,
    ...(input.searchTargets ?? [input.searchPath]),
  );

  return {
    command: [binaryPath, ...args],
    warnings,
  };
}

function ensureFileMatch(
  files: Map<string, GrepFileMatch>,
  rawPath: string,
  input: Pick<NormalizedGrepInput, 'cwd' | 'worktree'>,
): GrepFileMatch {
  const absolutePath = resolveAbsolutePath(rawPath, input.cwd);
  const existing = files.get(absolutePath);
  if (existing) {
    return existing;
  }

  const created: GrepFileMatch = {
    file: getDisplayPath(absolutePath, input.worktree),
    absolutePath,
    replayPath: absolutePath,
    pathKey: absolutePath,
    matchCount: 0,
    matches: [],
  };
  files.set(absolutePath, created);
  return created;
}

function parseContentLine(
  filePath: string,
  line: string,
  withContext: boolean,
): ParsedContentRecord | null {
  const match = withContext
    ? line.match(/^(\d+)([:-])(.*)$/)
    : line.match(/^(\d+):(.*)$/);

  if (!match) {
    return null;
  }

  if (withContext) {
    const [, lineNumberText, separator, text] = match;
    return {
      filePath,
      lineNumber: Number.parseInt(lineNumberText, 10),
      text: normalizeDisplayText(stripSingleLineEnding(text)),
      isMatch: separator === ':',
    };
  }

  const [, lineNumberText, text] = match;
  return {
    filePath,
    lineNumber: Number.parseInt(lineNumberText, 10),
    text: normalizeDisplayText(stripSingleLineEnding(text)),
    isMatch: true,
  };
}

function toContextLine(record: ParsedContentRecord): GrepContextLine {
  return {
    lineNumber: record.lineNumber,
    text: record.text,
  };
}

function appendContentGroup(
  files: Map<string, GrepFileMatch>,
  records: ParsedContentRecord[],
  input: Pick<NormalizedGrepInput, 'cwd' | 'worktree'>,
): void {
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as ParsedContentRecord;
    if (!record.isMatch) {
      continue;
    }

    const before: GrepContextLine[] = [];
    const after: GrepContextLine[] = [];

    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const entry = records[cursor] as ParsedContentRecord;
      if (entry.isMatch || entry.filePath !== record.filePath) {
        break;
      }
      before.unshift(toContextLine(entry));
    }

    for (let cursor = index + 1; cursor < records.length; cursor += 1) {
      const entry = records[cursor] as ParsedContentRecord;
      if (entry.isMatch || entry.filePath !== record.filePath) {
        break;
      }
      after.push(toContextLine(entry));
    }

    const file = ensureFileMatch(files, record.filePath, input);
    file.matchCount += 1;
    file.matches.push({
      lineNumber: record.lineNumber,
      lineText: record.text,
      submatches: [],
      before,
      after,
    });
  }
}

async function consumeNullPrefixedLinesStream(
  stream: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
  onRecord: (record: string) => boolean | undefined,
): Promise<void> {
  const readable = toWebReadableStream(stream);
  if (!readable) {
    return;
  }

  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    buffer += value
      ? decoder.decode(value, { stream: true })
      : decoder.decode();

    while (true) {
      if (buffer.startsWith('--\n')) {
        buffer = buffer.slice(3);
        if (onRecord('--') === false) {
          await reader.cancel();
          return;
        }
        continue;
      }

      const nullIndex = buffer.indexOf('\0');
      if (nullIndex < 0) {
        break;
      }

      const lineEnd = buffer.indexOf('\n', nullIndex + 1);
      if (lineEnd < 0) {
        break;
      }

      const record = stripSingleLineEnding(buffer.slice(0, lineEnd));
      buffer = buffer.slice(lineEnd + 1);
      if (onRecord(record) === false) {
        await reader.cancel();
        return;
      }
    }

    if (done) {
      break;
    }
  }

  if (buffer.length > 0) {
    onRecord(stripSingleLineEnding(buffer));
  }
}

async function consumeContentOutput(
  stdout: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
  proc: GrepProcess,
  input: Pick<
    NormalizedGrepInput,
    | 'afterContext'
    | 'beforeContext'
    | 'cwd'
    | 'maxResults'
    | 'outputMode'
    | 'worktree'
  >,
): Promise<{
  files: GrepFileMatch[];
  skippedLines: number;
  limitReached: boolean;
}> {
  const files = new Map<string, GrepFileMatch>();
  const withContext = input.beforeContext > 0 || input.afterContext > 0;
  let group: ParsedContentRecord[] = [];
  let skippedLines = 0;
  let visibleMatches = 0;
  let limitReached = false;

  const stopForLimit = async () => {
    limitReached = true;
    killProcess(proc);
  };

  await consumeNullPrefixedLinesStream(stdout, (record) => {
    if (withContext && record === '--') {
      appendContentGroup(files, group, input);
      group = [];
      visibleMatches = countVisibleMatches([...files.values()]);
      if (visibleMatches >= input.maxResults) {
        void stopForLimit();
        return false;
      }
      return true;
    }

    const nulIndex = record.indexOf('\0');
    if (nulIndex < 0) {
      skippedLines += 1;
      return true;
    }

    const filePath = record.slice(0, nulIndex);
    const line = record.slice(nulIndex + 1);
    const parsed = parseContentLine(filePath, line, withContext);
    if (!parsed) {
      skippedLines += 1;
      return true;
    }

    if (withContext) {
      group.push(parsed);
      return true;
    }

    const file = ensureFileMatch(files, parsed.filePath, input);
    file.matchCount += 1;
    file.matches.push({
      lineNumber: parsed.lineNumber,
      lineText: parsed.text,
      submatches: [],
      before: [],
      after: [],
    });
    visibleMatches += 1;
    if (visibleMatches >= input.maxResults) {
      void stopForLimit();
      return false;
    }
    return true;
  });

  if (group.length > 0) {
    appendContentGroup(files, group, input);
    visibleMatches = countVisibleMatches([...files.values()]);
    limitReached = limitReached || visibleMatches >= input.maxResults;
  }

  return {
    files: [...files.values()],
    skippedLines,
    limitReached,
  };
}

async function consumeCountOutput(
  stdout: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
  proc: GrepProcess,
  input: Pick<NormalizedGrepInput, 'cwd' | 'maxResults' | 'worktree'>,
): Promise<{
  files: GrepFileMatch[];
  skippedLines: number;
  limitReached: boolean;
}> {
  const files = new Map<string, GrepFileMatch>();
  let skippedLines = 0;
  let limitReached = false;
  const decoder = new TextDecoder();

  await consumeNullCountPairsBytes(stdout, (filePath, countText) => {
    if (!/^\d+$/.test(countText)) {
      skippedLines += 1;
      return true;
    }

    const file = ensureFileMatch(files, decoder.decode(filePath), input);
    file.matchCount = Number.parseInt(countText, 10);
    if (files.size >= input.maxResults) {
      limitReached = true;
      killProcess(proc);
      return false;
    }

    return true;
  });

  return {
    files: [...files.values()],
    skippedLines,
    limitReached,
  };
}

async function consumeFilesOutput(
  stdout: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
  proc: GrepProcess,
  input: Pick<NormalizedGrepInput, 'cwd' | 'maxResults' | 'worktree'>,
): Promise<{
  files: GrepFileMatch[];
  skippedLines: number;
  limitReached: boolean;
}> {
  const files = new Map<string, GrepFileMatch>();
  const decoder = new TextDecoder();
  let limitReached = false;

  await consumeNullItemsBytes(stdout, (filePath) => {
    if (filePath.length === 0) {
      return true;
    }

    const file = ensureFileMatch(files, decoder.decode(filePath), input);
    file.matchCount = 1;
    if (files.size >= input.maxResults) {
      limitReached = true;
      killProcess(proc);
      return false;
    }

    return true;
  });

  return {
    files: [...files.values()],
    skippedLines: 0,
    limitReached,
  };
}

function sortFiles(
  files: GrepFileMatch[],
  input: Pick<NormalizedGrepInput, 'sortBy' | 'sortOrder'>,
): GrepFileMatch[] {
  if (input.sortBy !== 'path') {
    return files;
  }

  return [...files].sort((left, right) => {
    const direction = input.sortOrder === 'desc' ? -1 : 1;
    return left.file.localeCompare(right.file) * direction;
  });
}

function finalizeFiles(
  files: GrepFileMatch[],
  input: Pick<NormalizedGrepInput, 'maxResults' | 'outputMode'>,
): {
  files: GrepFileMatch[];
  totalMatches: number;
  totalFiles: number;
  limitReached: boolean;
} {
  if (input.outputMode === 'content') {
    const trimmed = trimFilesToLineLimit(files, input.maxResults);
    const limitReached = files.some((file, index) => {
      const visible = trimmed[index];
      return visible ? visible.matches.length < file.matches.length : true;
    });

    return {
      files: trimmed,
      totalMatches: countVisibleMatches(trimmed),
      totalFiles: trimmed.length,
      limitReached,
    };
  }

  const trimmed = files.slice(0, input.maxResults);
  return {
    files: trimmed,
    totalMatches:
      input.outputMode === 'count' ? countOccurrences(trimmed) : trimmed.length,
    totalFiles: trimmed.length,
    limitReached: trimmed.length < files.length,
  };
}

async function checkGnuGrep(
  binaryPath: string,
): Promise<GnuGrepCheckResult> {
  let proc: GrepProcess;
  try {
    proc = spawnRipgrep([binaryPath, '--version'], process.cwd());
  } catch (error) {
    return {
      error: toErrorMessage(error),
      cacheable: shouldCacheGnuGrepFailure(error),
    };
  }

  const stdoutPromise = readTextStream(proc.proc.stdout ?? undefined);
  const stderrPromise = readTextStream(proc.proc.stderr ?? undefined);
  const [stdoutResult, exitResult] = await Promise.allSettled([
    stdoutPromise,
    waitForExitAndStderr(proc, stderrPromise),
  ]);

  if (stdoutResult.status === 'rejected') {
    return {
      error: toErrorMessage(stdoutResult.reason),
      cacheable: shouldCacheGnuGrepFailure(stdoutResult.reason),
    };
  }

  if (exitResult.status === 'rejected') {
    return {
      error: toErrorMessage(exitResult.reason),
      cacheable: shouldCacheGnuGrepFailure(exitResult.reason),
    };
  }

  const stdout = stdoutResult.value.trim();
  const { exitCode, stderr } = exitResult.value;

  if (exitCode !== 0) {
    const error = stderr || `grep --version exited with code ${String(exitCode)}`;
    return {
      error,
      cacheable: shouldCacheGnuGrepFailure(undefined, stderr),
    };
  }

  const firstLine = stdout.split(/\r?\n/, 1)[0] ?? '';
  if (!firstLine.includes('GNU grep')) {
    return {
      error:
        firstLine.length > 0
          ? 'System grep fallback requires GNU grep; the detected grep is not GNU grep.'
          : 'System grep fallback could not validate GNU grep version output.',
      cacheable: shouldCacheGnuGrepFailure(undefined, undefined, firstLine),
    };
  }

  return {
    cacheable: true,
  };
}

async function ensureGnuGrep(binaryPath: string): Promise<string | undefined> {
  const cached = GNU_GREP_CACHE.get(binaryPath);
  if (cached) {
    return (await cached).error;
  }

  const check = checkGnuGrep(binaryPath);

  GNU_GREP_CACHE.set(binaryPath, check);
  void check.then(
    (result) => {
      if (!result.cacheable && GNU_GREP_CACHE.get(binaryPath) === check) {
        GNU_GREP_CACHE.delete(binaryPath);
      }
    },
    () => {
      if (GNU_GREP_CACHE.get(binaryPath) === check) {
        GNU_GREP_CACHE.delete(binaryPath);
      }
    },
  );

  return (await check).error;
}

export async function executeGrepFallback(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
): Promise<GrepSearchResult> {
  const { command, warnings: commandWarnings } = buildGrepCommand(
    input,
    cli.path,
  );
  const baseResult = createEmptyResult(input, command);

  if (signal.aborted) {
    return {
      ...baseResult,
      backend: 'grep',
      truncated: true,
      timedOut: getAbortKind(signal) === 'timeout',
      cancelled: getAbortKind(signal) !== 'timeout',
      warnings: [...commandWarnings],
    };
  }

  const grepError = await ensureGnuGrep(cli.path);
  if (grepError) {
    return {
      ...baseResult,
      backend: 'grep',
      error: grepError,
      warnings: [...commandWarnings],
    };
  }

  let proc: GrepProcess;
  try {
    proc = spawnRipgrep(command, input.cwd);
  } catch (error) {
    const friendlyMessage = createFriendlySpawnError(error, cli);
    return {
      ...baseResult,
      backend: 'grep',
      error: friendlyMessage || toErrorMessage(error),
      warnings: [...commandWarnings],
    };
  }

  const termination = attachTerminationHandlers(proc, input.timeoutMs, signal);

  try {
    const stdoutStream = proc.proc.stdout ?? undefined;
    const stderrStream = proc.proc.stderr ?? undefined;
    const stderrPromise = readTextStream(stderrStream);
    const stdoutPromise =
      input.outputMode === 'content'
        ? consumeContentOutput(stdoutStream, proc, input)
        : input.outputMode === 'count'
          ? consumeCountOutput(stdoutStream, proc, input)
          : consumeFilesOutput(stdoutStream, proc, input);

    const [stdoutResult, exitResult] = await Promise.allSettled([
      stdoutPromise,
      waitForExitAndStderr(proc, stderrPromise),
    ]);
    const exitCode =
      exitResult.status === 'fulfilled' ? exitResult.value.exitCode : 1;
    const stderr =
      exitResult.status === 'fulfilled' ? exitResult.value.stderr.trim() : '';
    const parsed =
      stdoutResult.status === 'fulfilled'
        ? stdoutResult.value
        : {
            files: [] as GrepFileMatch[],
            skippedLines: 0,
            limitReached: false,
          };
    const sortedFiles = sortFiles(parsed.files, input);
    const finalized = finalizeFiles(sortedFiles, input);
    const warnings = [...commandWarnings];

    if (parsed.skippedLines > 0) {
      warnings.push(
        `GNU grep fallback skipped ${String(parsed.skippedLines)} unparsable output line(s); results may be incomplete.`,
      );
    }

    const result: GrepSearchResult = {
      ...baseResult,
      backend: 'grep',
      files: finalized.files,
      totalMatches: finalized.totalMatches,
      totalFiles: finalized.totalFiles,
      matchKind: getMatchKind(input.outputMode),
      truncated:
        parsed.limitReached ||
        finalized.limitReached ||
        termination.state.timedOut ||
        termination.state.cancelled ||
        parsed.skippedLines > 0,
      limitReached: parsed.limitReached || finalized.limitReached,
      timedOut: termination.state.timedOut,
      cancelled: termination.state.cancelled,
      exitCode,
      stderr,
      warnings,
    };

    applySuccessfulStderr(result, stderr, exitCode);

    if (
      parsed.skippedLines > 0 &&
      !hasVisibleResults(result) &&
      exitCode === 0 &&
      !result.timedOut &&
      !result.cancelled
    ) {
      result.error = 'GNU grep fallback produced unparsable output.';
      return result;
    }

    if (termination.state.timedOut || termination.state.cancelled) {
      return result;
    }

    if (result.limitReached) {
      return result;
    }

    if (exitCode === 0 || (exitCode === 1 && !hasVisibleResults(result))) {
      return result;
    }

    result.error = result.stderr || `grep exited with code ${String(exitCode)}`;
    return result;
  } finally {
    termination.cleanup();
  }
}
