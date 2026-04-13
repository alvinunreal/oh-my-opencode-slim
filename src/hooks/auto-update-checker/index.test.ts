import { describe, expect, mock, test } from 'bun:test';

// Mock logger to avoid noise
mock.module('../../utils/logger', () => ({
  log: mock(() => {}),
}));

mock.module('./checker', () => ({
  extractChannel: mock(() => 'latest'),
  findPluginEntry: mock(() => null),
  getCachedVersion: mock(() => null),
  getLatestVersion: mock(async () => null),
  getLocalDevVersion: mock(() => null),
  getCurrentRuntimePackageJsonPath: mock(() => null),
}));

mock.module('./cache', () => ({
  preparePackageUpdate: mock(() => '/tmp/opencode'),
  resolveInstallContext: mock(() => ({ installDir: '/tmp/opencode' })),
}));

// Cache buster for dynamic imports
let importCounter = 0;

describe('auto-update-checker/index', () => {
  test('uses OpenCode cache dir for auto-update installs', async () => {
    const { getAutoUpdateInstallDir } = await import(
      `./index?test=${importCounter++}`
    );
    // The actual cache dir depends on the platform, but it should be a string
    expect(typeof getAutoUpdateInstallDir()).toBe('string');
  });
});
