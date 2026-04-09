import { describe, expect, mock, test } from 'bun:test';

mock.module('./constants', () => ({
  CACHE_DIR: '/mock/cache/opencode',
  PACKAGE_NAME: 'oh-my-opencode-slim',
}));

mock.module('./checker', () => ({
  extractChannel: mock(() => 'latest'),
  findPluginEntry: mock(() => null),
  getCachedVersion: mock(() => null),
  getLatestVersion: mock(async () => null),
  getLocalDevVersion: mock(() => null),
}));

mock.module('./cache', () => ({
  invalidatePackage: mock(() => false),
}));

mock.module('../../utils/logger', () => ({
  log: mock(() => {}),
}));

import { getAutoUpdateInstallDir } from './index';

describe('auto-update-checker/index', () => {
  test('uses OpenCode cache dir for auto-update installs', () => {
    expect(getAutoUpdateInstallDir()).toBe('/mock/cache/opencode');
  });
});
