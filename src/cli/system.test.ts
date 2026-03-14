/// <reference types="bun-types" />

import { describe, expect, mock, test } from 'bun:test';
import {
  fetchLatestVersion,
  getOpenCodeVersion,
  isOpenCodeInstalled,
  isTmuxInstalled,
} from './system';

describe('system', () => {
  test('isOpenCodeInstalled returns boolean', async () => {
    // We don't necessarily want to depend on the host system
    // but for a basic test we can just check it returns a boolean
    const result = await isOpenCodeInstalled();
    expect(typeof result).toBe('boolean');
  });

  test('isTmuxInstalled returns boolean', async () => {
    const result = await isTmuxInstalled();
    expect(typeof result).toBe('boolean');
  });

  test('fetchLatestVersion returns version string or null', async () => {
    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return {
        ok: true,
        json: async () => ({ version: '1.2.3' }),
      };
    }) as any;

    try {
      const version = await fetchLatestVersion('any-package');
      expect(version).toBe('1.2.3');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchLatestVersion returns null on error', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = mock(async () => {
        return {
          ok: false,
        };
      }) as any;

      const version = await fetchLatestVersion('any-package');
      expect(version).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('getOpenCodeVersion returns string or null', async () => {
    const version = await getOpenCodeVersion();
    if (version !== null) {
      expect(typeof version).toBe('string');
    } else {
      expect(version).toBeNull();
    }
  });
});
