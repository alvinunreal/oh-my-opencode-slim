import { describe, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';

// Mock logger to avoid noise
mock.module('../../utils/logger', () => ({
  log: mock(() => {}),
}));

mock.module('../../cli/config-manager', () => ({
  stripJsonComments: (s: string) => s,
  getOpenCodeConfigPaths: () => [
    '/mock/config/opencode.json',
    '/mock/config/opencode.jsonc',
  ],
}));

// Cache buster for dynamic imports
let importCounter = 0;

describe('auto-update-checker/checker', () => {
  describe('extractChannel', () => {
    test('returns latest for null or empty', async () => {
      const { extractChannel } = await import(
        `./checker?test=${importCounter++}`
      );
      expect(extractChannel(null)).toBe('latest');
      expect(extractChannel('')).toBe('latest');
    });

    test('returns tag if version starts with non-digit', async () => {
      const { extractChannel } = await import(
        `./checker?test=${importCounter++}`
      );
      expect(extractChannel('beta')).toBe('beta');
      expect(extractChannel('next')).toBe('next');
    });

    test('extracts channel from prerelease version', async () => {
      const { extractChannel } = await import(
        `./checker?test=${importCounter++}`
      );
      expect(extractChannel('1.0.0-alpha.1')).toBe('alpha');
      expect(extractChannel('2.3.4-beta.5')).toBe('beta');
      expect(extractChannel('0.1.0-rc.1')).toBe('rc');
      expect(extractChannel('1.0.0-canary.0')).toBe('canary');
    });

    test('returns latest for standard versions', async () => {
      const { extractChannel } = await import(
        `./checker?test=${importCounter++}`
      );
      expect(extractChannel('1.0.0')).toBe('latest');
    });
  });

  describe('getLocalDevVersion', () => {
    test('returns null if no local dev path in config', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
      const { getLocalDevVersion } = await import(
        `./checker?test=${importCounter++}`
      );

      expect(getLocalDevVersion('/test')).toBeNull();

      existsSpy.mockRestore();
    });

    test('returns version from local package.json if path exists', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation(
        (p: string) => {
          if (p.includes('opencode.json')) return true;
          if (p.includes('package.json')) return true;
          return false;
        },
      );
      const readSpy = spyOn(fs, 'readFileSync').mockImplementation(
        (p: string) => {
          if (p.includes('opencode.json')) {
            return JSON.stringify({
              plugin: ['file:///dev/oh-my-opencode-slim'],
            });
          }
          if (p.includes('package.json')) {
            return JSON.stringify({
              name: 'oh-my-opencode-slim',
              version: '1.2.3-dev',
            });
          }
          return '';
        },
      );

      const { getLocalDevVersion } = await import(
        `./checker?test=${importCounter++}`
      );

      expect(getLocalDevVersion('/test')).toBe('1.2.3-dev');

      existsSpy.mockRestore();
      readSpy.mockRestore();
    });
  });

  describe('findPluginEntry', () => {
    test('detects latest version entry', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation(
        (p: string) => p.includes('opencode.json'),
      );
      const readSpy = spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({
          plugin: ['oh-my-opencode-slim'],
        }),
      );

      const { findPluginEntry } = await import(
        `./checker?test=${importCounter++}`
      );

      const entry = findPluginEntry('/test');
      expect(entry).not.toBeNull();
      expect(entry?.entry).toBe('oh-my-opencode-slim');
      expect(entry?.isPinned).toBe(false);
      expect(entry?.pinnedVersion).toBeNull();

      existsSpy.mockRestore();
      readSpy.mockRestore();
    });

    test('detects pinned version entry', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation(
        (p: string) => p.includes('opencode.json'),
      );
      const readSpy = spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({
          plugin: ['oh-my-opencode-slim@1.0.0'],
        }),
      );

      const { findPluginEntry } = await import(
        `./checker?test=${importCounter++}`
      );

      const entry = findPluginEntry('/test');
      expect(entry).not.toBeNull();
      expect(entry?.isPinned).toBe(true);
      expect(entry?.pinnedVersion).toBe('1.0.0');

      existsSpy.mockRestore();
      readSpy.mockRestore();
    });
  });
});
