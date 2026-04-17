import type {
  GrepFileMatch,
  GrepMatchKind,
  GrepSearchResult,
  NormalizedGrepInput,
} from './types';

export function getMatchKind(
  outputMode: NormalizedGrepInput['outputMode'],
): GrepMatchKind {
  if (outputMode === 'files_with_matches') {
    return 'file';
  }

  if (outputMode === 'count') {
    return 'occurrence';
  }

  return 'match';
}

export function createEmptyResult(
  input: NormalizedGrepInput,
  command?: string[],
): GrepSearchResult {
  return {
    files: [],
    totalMatches: 0,
    totalFiles: 0,
    outputMode: input.outputMode,
    matchKind: getMatchKind(input.outputMode),
    truncated: false,
    limitReached: false,
    timedOut: false,
    cancelled: false,
    exitCode: 0,
    retryCount: 0,
    command,
    cwd: input.cwd,
    stderr: '',
    warnings: [],
  };
}

export function hasVisibleResults(
  result: Pick<GrepSearchResult, 'totalFiles' | 'totalMatches'>,
): boolean {
  return result.totalFiles > 0 || result.totalMatches > 0;
}

export function applySuccessfulStderr(
  result: GrepSearchResult,
  stderr: string,
  exitCode: number,
): void {
  if (stderr.length > 0 && exitCode === 0) {
    result.warnings.push(stderr);
    result.stderr = '';
  }
}

export function finalizeNonFatalExit(
  result: GrepSearchResult,
  exitCode: number,
): GrepSearchResult | undefined {
  if (exitCode === 0) {
    return result;
  }

  if (exitCode === 1 && !hasVisibleResults(result)) {
    return result;
  }

  if (hasVisibleResults(result)) {
    const detail = result.stderr || `rg exited with code ${String(exitCode)}`;
    result.truncated = true;
    result.warnings.push(`Partial ripgrep failure: ${detail}`);
    result.stderr = '';
    return result;
  }

  return undefined;
}

export function countVisibleMatches(files: GrepFileMatch[]): number {
  return files.reduce((sum, file) => sum + file.matches.length, 0);
}

export function countOccurrences(files: GrepFileMatch[]): number {
  return files.reduce((sum, file) => sum + file.matchCount, 0);
}

export function trimFilesToLineLimit(
  files: GrepFileMatch[],
  maxResults: number,
): GrepFileMatch[] {
  let remaining = maxResults;
  const trimmed: GrepFileMatch[] = [];

  for (const file of files) {
    if (remaining <= 0) {
      break;
    }

    if (file.matches.length <= remaining) {
      trimmed.push(file);
      remaining -= file.matches.length;
      continue;
    }

    trimmed.push({
      ...file,
      matchCount: Math.min(file.matchCount, remaining),
      matches: file.matches.slice(0, remaining),
    });
    remaining = 0;
  }

  return trimmed;
}

export function finalizeMtimeContentResult(
  input: NormalizedGrepInput,
  files: GrepFileMatch[],
  baseResult: GrepSearchResult,
  moreDueToLimit: boolean,
): GrepSearchResult {
  const limitedFiles = trimFilesToLineLimit(files, input.maxResults);
  const visibleMatches = countVisibleMatches(limitedFiles);
  const hiddenByTrim = files.some((file, index) => {
    const visible = limitedFiles[index];
    return visible ? visible.matches.length < file.matches.length : true;
  });
  const limitReached =
    baseResult.limitReached || moreDueToLimit || hiddenByTrim;

  return {
    ...baseResult,
    files: limitedFiles,
    totalMatches: visibleMatches,
    totalFiles: limitedFiles.length,
    matchKind: 'match',
    truncated: baseResult.truncated || limitReached,
    limitReached,
  };
}

export function finalizeMtimeSimpleResult(
  input: NormalizedGrepInput,
  files: GrepFileMatch[],
  baseResult: GrepSearchResult,
  moreDueToLimit: boolean,
): GrepSearchResult {
  const limitedFiles = files.slice(0, input.maxResults);
  const totalMatches =
    input.outputMode === 'count'
      ? countOccurrences(limitedFiles)
      : limitedFiles.length;
  const limitReached = baseResult.limitReached || moreDueToLimit;

  return {
    ...baseResult,
    files: limitedFiles,
    totalMatches,
    totalFiles: limitedFiles.length,
    matchKind: getMatchKind(input.outputMode),
    truncated: baseResult.truncated || limitReached,
    limitReached,
  };
}
