import { MAX_LINE_LENGTH } from './constants';
import {
  escapeControlChars,
  escapeControlCharsPreservingNewlines,
} from './path-utils';
import { buildLimitNote, buildPrimarySummary, pluralize } from './summary';
import type { GrepSearchResult, NormalizedGrepInput } from './types';

function formatLine(
  lineNumber: number,
  marker: ':' | '-',
  text: string,
): string {
  const escapedText = escapeControlCharsPreservingNewlines(text);
  const visibleText =
    escapedText.length > MAX_LINE_LENGTH
      ? `${escapedText.slice(0, MAX_LINE_LENGTH)}...`
      : escapedText;
  const parts = visibleText.split('\n');
  if (parts.length <= 1) {
    return `  ${String(lineNumber).padStart(5)}${marker} ${parts[0] ?? ''}`;
  }

  const [first, ...rest] = parts;
  return [
    `  ${String(lineNumber).padStart(5)}${marker} ${first ?? ''}`,
    ...rest.map((line) => `         ${line}`),
  ].join('\n');
}

function trimBlankEdges(lines: string[]): string[] {
  while (lines[0] === '') {
    lines.shift();
  }

  while (lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines;
}

function appendSearchHeader(
  lines: string[],
  input: Pick<
    NormalizedGrepInput,
    'include' | 'requestedPath' | 'resolvedPath' | 'searchPath' | 'pattern'
  >,
): void {
  lines.push(`Pattern: ${escapeControlChars(input.pattern)}`);
  lines.push(`Path: ${escapeControlChars(input.requestedPath)}`);
  if (input.searchPath !== input.resolvedPath) {
    lines.push(`Real path: ${escapeControlChars(input.searchPath)}`);
  }
  if (input.include) {
    lines.push(`Include: ${escapeControlChars(input.include)}`);
  }
}

function formatFilesOnly(result: GrepSearchResult): string[] {
  const lines = [buildPrimarySummary(result), ''];

  for (const file of result.files) {
    lines.push(escapeControlChars(file.file));
  }

  return lines;
}

function formatCountMode(result: GrepSearchResult): string[] {
  const lines = [buildPrimarySummary(result), ''];

  for (const file of result.files) {
    lines.push(
      `  ${String(file.matchCount).padStart(6)}: ${escapeControlChars(file.file)}`,
    );
  }

  return lines;
}

function formatContentMode(result: GrepSearchResult): string[] {
  const lines = [buildPrimarySummary(result), ''];

  result.files.forEach((file, fileIndex) => {
    lines.push(escapeControlChars(file.file));

    file.matches.forEach((match, matchIndex) => {
      for (const before of match.before) {
        lines.push(formatLine(before.lineNumber, '-', before.text));
      }

      lines.push(formatLine(match.lineNumber, ':', match.lineText));

      for (const after of match.after) {
        lines.push(formatLine(after.lineNumber, '-', after.text));
      }

      if (matchIndex < file.matches.length - 1) {
        lines.push('');
      }
    });

    if (fileIndex < result.files.length - 1) {
      lines.push('');
    }
  });

  return lines;
}

function buildNoVisibleResultsMessage(
  input: NormalizedGrepInput,
  result: GrepSearchResult,
): string {
  const discoveredFiles = result.discoveredFiles ?? 0;
  if (result.partialPhase && discoveredFiles > 0) {
    const phase =
      result.partialPhase === 'mtime-sort'
        ? 'sorting'
        : result.partialPhase === 'replay'
          ? 'replay'
          : 'discovery';
    if (!result.timedOut && !result.cancelled) {
      return `mtime ${phase} could not produce visible results after discovering ${discoveredFiles} candidate ${pluralize(discoveredFiles, 'file')}.`;
    }
    return `Search stopped during mtime ${phase} after discovering ${discoveredFiles} candidate ${pluralize(discoveredFiles, 'file')} before replay produced visible results.`;
  }

  if (result.timedOut || result.cancelled) {
    return input.outputMode === 'files_with_matches'
      ? 'No visible files were collected before the search stopped.'
      : 'No visible results were collected before the search stopped.';
  }

  return input.outputMode === 'files_with_matches'
    ? 'No files found.'
    : 'No matches found.';
}

export function formatGrepResult(
  input: NormalizedGrepInput,
  result: GrepSearchResult,
): string {
  const lines: string[] = [];

  if (result.error && result.totalMatches === 0 && result.totalFiles === 0) {
    lines.push('grep search failed.');
    appendSearchHeader(lines, input);
    lines.push('');
    lines.push(`Error: ${escapeControlChars(result.error)}`);
    if (result.stderr.trim()) {
      lines.push('');
      lines.push(escapeControlChars(result.stderr.trim()));
    }
    return lines.join('\n');
  }

  if (result.totalMatches === 0) {
    lines.push(buildNoVisibleResultsMessage(input, result));
    appendSearchHeader(lines, input);
  } else {
    appendSearchHeader(lines, input);
    lines.push('');

    const formattedBody =
      input.outputMode === 'files_with_matches'
        ? formatFilesOnly(result)
        : input.outputMode === 'count'
          ? formatCountMode(result)
          : formatContentMode(result);
    lines.push(...formattedBody);
  }

  const notes: string[] = [];

  if (result.limitReached) {
    notes.push(buildLimitNote(input, result));
  }

  if (result.timedOut) {
    notes.push(
      `Timed out after ${input.timeoutMs}ms; showing partial results.`,
    );
  }

  if (result.cancelled) {
    notes.push('Search was cancelled; showing partial results.');
  }

  if (result.retryCount > 0) {
    notes.push(
      `Retried ${result.retryCount} transient ${pluralize(result.retryCount, 'failure')}.`,
    );
  }

  if (result.error) {
    notes.push(`Partial error: ${escapeControlChars(result.error)}`);
  }

  if (result.strategy !== 'mtime-hybrid' && result.summary?.elapsedTotalHuman) {
    notes.push(`rg elapsed: ${result.summary.elapsedTotalHuman}`);
  }

  for (const warning of result.warnings) {
    notes.push(escapeControlChars(warning));
  }

  const stderr = result.stderr.trim();
  if (stderr.length > 0) {
    notes.push(escapeControlChars(stderr));
  }

  if (notes.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push(...notes);
  }

  return trimBlankEdges(lines).join('\n');
}
