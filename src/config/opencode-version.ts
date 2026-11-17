import { stripVTControlCharacters } from 'node:util';
import { gte, major, valid } from 'semver';

export const MINIMUM_OPENCODE_VERSION = '2.3.0';

export function parseOpenCodeVersion(output: string): string | null {
  return valid(
    stripVTControlCharacters(output)
      .trim()
      .replace(/^opencode\s+/i, ''),
  );
}

export function classifyOpenCodeVersion(
  output: string,
): 'supported' | 'unsupported' | 'unknown' {
  const version = parseOpenCodeVersion(output);
  if (!version || major(version) === 0) return 'unknown';
  return gte(version, MINIMUM_OPENCODE_VERSION) ? 'supported' : 'unsupported';
}
