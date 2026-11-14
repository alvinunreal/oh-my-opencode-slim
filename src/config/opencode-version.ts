import { gte, valid } from 'semver';

export const MINIMUM_OPENCODE_VERSION = '2.3.0';

export function parseOpenCodeVersion(output: string): string | null {
  return valid(output.trim().replace(/^opencode\s+/i, ''));
}

export function isSupportedOpenCodeVersion(output: string): boolean {
  const version = parseOpenCodeVersion(output);
  return version !== null && gte(version, MINIMUM_OPENCODE_VERSION);
}
