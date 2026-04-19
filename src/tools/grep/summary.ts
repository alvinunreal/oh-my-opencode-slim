import type { GrepSearchResult, NormalizedGrepInput } from './types';

export function pluralize(
  count: number,
  singular: string,
  plural = singular.endsWith('match') ? `${singular}es` : `${singular}s`,
): string {
  return count === 1 ? singular : plural;
}

export function buildPrimarySummary(result: GrepSearchResult): string {
  switch (result.matchKind) {
    case 'file':
      return `Found ${result.totalMatches} matching ${pluralize(result.totalMatches, 'file')}.`;
    case 'occurrence':
      return `Found ${result.totalMatches} total ${pluralize(result.totalMatches, 'match')} across ${result.totalFiles} ${pluralize(result.totalFiles, 'file')}.`;
    default:
      return `Found ${result.totalMatches} ${pluralize(result.totalMatches, 'match')} across ${result.totalFiles} ${pluralize(result.totalFiles, 'file')}.`;
  }
}

export function buildLimitNote(
  input: NormalizedGrepInput,
  result: GrepSearchResult,
): string {
  if (result.matchKind === 'file' || result.outputMode === 'count') {
    return `Stopped after collecting ${input.maxResults} matching ${pluralize(input.maxResults, 'file')} (global limit).`;
  }

  return `Stopped after collecting ${input.maxResults} ${pluralize(input.maxResults, 'match')} (global limit).`;
}
