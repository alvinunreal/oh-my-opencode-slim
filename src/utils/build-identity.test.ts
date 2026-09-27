import { describe, expect, test } from 'bun:test';
import { BUILD_VERSION } from '../generated/build-info';
import { pluginBuildIdentity } from './build-identity';

describe('pluginBuildIdentity', () => {
  test('carries the build constants and the resolved module entry', () => {
    const identity = pluginBuildIdentity();
    expect(identity.version).toBe(BUILD_VERSION);
    expect(typeof identity.buildTime).toBe('string');
    // The entry is the loaded module's own URL, logged as path segments
    // (the logger's redaction choke point would mask a full 32+ char URL
    // run): in the bundled dist it is the dist file the host resolved
    // (npm cache vs packages install), in source runs it is this module's
    // file. Either way it must be a file URL so "which copy ran" is
    // answerable from the log line alone.
    expect(identity.entry.join('/')).toMatch(/^file:/);
    expect(identity.entry.join('/')).toContain('build-identity');
  });
});
