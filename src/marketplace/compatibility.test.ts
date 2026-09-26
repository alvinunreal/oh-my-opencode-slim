import { describe, expect, test } from 'bun:test';
import { satisfiesPluginCompatibility } from './compatibility';

describe('marketplace plugin compatibility predicate', () => {
  test('checks an explicit version against a valid range', () => {
    expect(satisfiesPluginCompatibility('3.0.0', '^3.0.0')).toBe(true);
    expect(satisfiesPluginCompatibility('4.0.0', '^3.0.0')).toBe(false);
  });

  test('uses semver prerelease range semantics', () => {
    expect(
      satisfiesPluginCompatibility('3.0.0-beta.4', '>=3.0.0-beta.3 <4.0.0'),
    ).toBe(true);
    expect(satisfiesPluginCompatibility('3.0.0-beta.2', '^3.0.0-beta.3')).toBe(
      false,
    );
    expect(satisfiesPluginCompatibility('3.0.0-beta.4', '^3.0.0')).toBe(false);
  });

  test('returns false for invalid versions and ranges', () => {
    expect(satisfiesPluginCompatibility('not-semver', '^3.0.0')).toBe(false);
    expect(satisfiesPluginCompatibility('3.0.0', '>=wat')).toBe(false);
  });
});
