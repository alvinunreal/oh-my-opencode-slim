import { satisfies, valid, validRange } from 'semver';

export function satisfiesPluginCompatibility(
  version: string,
  range: string,
): boolean {
  return (
    valid(version) !== null &&
    validRange(range) !== null &&
    satisfies(version, range)
  );
}
