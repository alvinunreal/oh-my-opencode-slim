/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// Mock process.env and process.platform for testing
const originalPlatform = process.platform;
const originalEnv = { ...process.env };

function mockPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

function mockEnv(env: Partial<Record<string, string>>) {
  Object.assign(process.env, env);
}

function restoreMocks() {
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  });
  process.env = { ...originalEnv };
}

describe('grep constants', () => {
  afterEach(() => {
    restoreMocks();
  });

  describe('getDataDir', () => {
    test('returns LOCALAPPDATA on Windows when set', () => {
      mockPlatform('win32');
      mockEnv({ LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' });

      // Import after mocking to get the mocked behavior
      const { getDataDir } = require('./constants');
      const result = getDataDir();

      expect(result).toBe('C:\\Users\\test\\AppData\\Local');
    });

    test('returns APPDATA on Windows when LOCALAPPDATA not set', () => {
      mockPlatform('win32');
      mockEnv({ APPDATA: 'C:\\Users\\test\\AppData\\Roaming' });

      const { getDataDir } = require('./constants');
      const result = getDataDir();

      expect(result).toBe('C:\\Users\\test\\AppData\\Roaming');
    });

    test('returns USERPROFILE/AppData/Local on Windows when no env vars set', () => {
      mockPlatform('win32');
      mockEnv({ USERPROFILE: 'C:\\Users\\test' });

      const { getDataDir } = require('./constants');
      const result = getDataDir();

      expect(result).toBe(join('C:\\Users\\test', 'AppData', 'Local'));
    });

    test('returns XDG_DATA_HOME on Unix when set', () => {
      mockPlatform('linux');
      mockEnv({ XDG_DATA_HOME: '/home/test/.local/share' });

      const { getDataDir } = require('./constants');
      const result = getDataDir();

      expect(result).toBe('/home/test/.local/share');
    });

    test('returns HOME/.local/share on Unix when XDG_DATA_HOME not set', () => {
      mockPlatform('linux');
      mockEnv({ HOME: '/home/test' });

      const { getDataDir } = require('./constants');
      const result = getDataDir();

      expect(result).toBe(join('/home/test', '.local', 'share'));
    });

    test('returns ./.local/share on Unix when HOME not set', () => {
      mockPlatform('linux');
      // Clear HOME from environment
      delete process.env.HOME;
      delete process.env.XDG_DATA_HOME;

      const { getDataDir } = require('./constants');
      const result = getDataDir();

      expect(result).toBe(join('.', '.local', 'share'));
    });

    test('returns XDG_DATA_HOME on macOS when set', () => {
      mockPlatform('darwin');
      mockEnv({ XDG_DATA_HOME: '/Users/test/.local/share' });

      const { getDataDir } = require('./constants');
      const result = getDataDir();

      expect(result).toBe('/Users/test/.local/share');
    });

    test('returns HOME/.local/share on macOS when XDG_DATA_HOME not set', () => {
      mockPlatform('darwin');
      mockEnv({ HOME: '/Users/test' });

      const { getDataDir } = require('./constants');
      const result = getDataDir();

      expect(result).toBe(join('/Users/test', '.local', 'share'));
    });
  });

  describe('constants', () => {
    test('DEFAULT_MAX_DEPTH is 20', () => {
      const { DEFAULT_MAX_DEPTH } = require('./constants');
      expect(DEFAULT_MAX_DEPTH).toBe(20);
    });

    test('DEFAULT_MAX_FILESIZE is 10M', () => {
      const { DEFAULT_MAX_FILESIZE } = require('./constants');
      expect(DEFAULT_MAX_FILESIZE).toBe('10M');
    });

    test('DEFAULT_MAX_COUNT is 500', () => {
      const { DEFAULT_MAX_COUNT } = require('./constants');
      expect(DEFAULT_MAX_COUNT).toBe(500);
    });

    test('DEFAULT_MAX_COLUMNS is 1000', () => {
      const { DEFAULT_MAX_COLUMNS } = require('./constants');
      expect(DEFAULT_MAX_COLUMNS).toBe(1000);
    });

    test('DEFAULT_CONTEXT is 2', () => {
      const { DEFAULT_CONTEXT } = require('./constants');
      expect(DEFAULT_CONTEXT).toBe(2);
    });

    test('DEFAULT_TIMEOUT_MS is 300000', () => {
      const { DEFAULT_TIMEOUT_MS } = require('./constants');
      expect(DEFAULT_TIMEOUT_MS).toBe(300_000);
    });

    test('DEFAULT_MAX_OUTPUT_BYTES is 10MB', () => {
      const { DEFAULT_MAX_OUTPUT_BYTES } = require('./constants');
      expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(10 * 1024 * 1024);
    });

    test('RG_SAFETY_FLAGS contains expected flags', () => {
      const { RG_SAFETY_FLAGS } = require('./constants');
      expect(RG_SAFETY_FLAGS).toContain('--no-follow');
      expect(RG_SAFETY_FLAGS).toContain('--color=never');
      expect(RG_SAFETY_FLAGS).toContain('--no-heading');
      expect(RG_SAFETY_FLAGS).toContain('--line-number');
      expect(RG_SAFETY_FLAGS).toContain('--with-filename');
    });

    test('GREP_SAFETY_FLAGS contains expected flags', () => {
      const { GREP_SAFETY_FLAGS } = require('./constants');
      expect(GREP_SAFETY_FLAGS).toContain('-n');
      expect(GREP_SAFETY_FLAGS).toContain('-H');
      expect(GREP_SAFETY_FLAGS).toContain('--color=never');
    });
  });
});
