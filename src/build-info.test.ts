import { describe, expect, test } from 'bun:test';
import pkg from '../package.json';
import { getBuildInfo } from './generated/build-info';

describe('build info', () => {
  test('version equals the package.json version', () => {
    expect(getBuildInfo().version).toBe(pkg.version);
  });

  test('buildTime is an ISO-8601 timestamp string', () => {
    expect(getBuildInfo().buildTime).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });
});
