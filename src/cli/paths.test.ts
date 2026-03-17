/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureConfigDir,
  getConfigDir,
  getConfigJson,
  getConfigJsonc,
  getExistingConfigPath,
  getLiteConfig,
  getOpenCodeConfigPaths,
} from './paths';

describe('paths', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('getConfigDir() uses OPENCODE_CONFIG parent dir when set', () => {
    process.env.OPENCODE_CONFIG = '/custom/path/opencode.json';
    delete process.env.XDG_CONFIG_HOME;
    expect(getConfigDir()).toBe('/custom/path');
  });

  test('getConfigDir() prefers OPENCODE_CONFIG over XDG_CONFIG_HOME', () => {
    process.env.OPENCODE_CONFIG = '/custom/path/opencode.json';
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config';
    expect(getConfigDir()).toBe('/custom/path');
  });

  test('getConfigDir() uses XDG_CONFIG_HOME when set', () => {
    delete process.env.OPENCODE_CONFIG;
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config';
    expect(getConfigDir()).toBe('/tmp/xdg-config/opencode');
  });

  test('getConfigDir() falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    delete process.env.OPENCODE_CONFIG;
    delete process.env.XDG_CONFIG_HOME;
    const expected = join(homedir(), '.config', 'opencode');
    expect(getConfigDir()).toBe(expected);
  });

  test('getOpenCodeConfigPaths() returns both json and jsonc paths', () => {
    delete process.env.OPENCODE_CONFIG;
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config';
    expect(getOpenCodeConfigPaths()).toEqual([
      '/tmp/xdg-config/opencode/opencode.json',
      '/tmp/xdg-config/opencode/opencode.jsonc',
    ]);
  });

  test('getOpenCodeConfigPaths() respects OPENCODE_CONFIG', () => {
    process.env.OPENCODE_CONFIG = '/custom/path/opencode.json';
    expect(getOpenCodeConfigPaths()).toEqual([
      '/custom/path/opencode.json',
      '/custom/path/opencode.jsonc',
    ]);
  });

  test('getConfigJson() returns correct path', () => {
    delete process.env.OPENCODE_CONFIG;
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config';
    expect(getConfigJson()).toBe('/tmp/xdg-config/opencode/opencode.json');
  });

  test('getConfigJsonc() returns correct path', () => {
    delete process.env.OPENCODE_CONFIG;
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config';
    expect(getConfigJsonc()).toBe('/tmp/xdg-config/opencode/opencode.jsonc');
  });

  test('getLiteConfig() returns correct path', () => {
    delete process.env.OPENCODE_CONFIG;
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config';
    expect(getLiteConfig()).toBe(
      '/tmp/xdg-config/opencode/oh-my-opencode-slim.json',
    );
  });

  test('getLiteConfig() respects OPENCODE_CONFIG', () => {
    process.env.OPENCODE_CONFIG = '/custom/path/opencode.json';
    expect(getLiteConfig()).toBe('/custom/path/oh-my-opencode-slim.json');
  });

  describe('getExistingConfigPath()', () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir && existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('returns .json if it exists', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'opencode-test-'));
      delete process.env.OPENCODE_CONFIG;
      process.env.XDG_CONFIG_HOME = tmpDir;

      const configDir = join(tmpDir, 'opencode');
      ensureConfigDir();

      const jsonPath = join(configDir, 'opencode.json');
      writeFileSync(jsonPath, '{}');

      expect(getExistingConfigPath()).toBe(jsonPath);
    });

    test("returns .jsonc if .json doesn't exist but .jsonc does", () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'opencode-test-'));
      delete process.env.OPENCODE_CONFIG;
      process.env.XDG_CONFIG_HOME = tmpDir;

      const configDir = join(tmpDir, 'opencode');
      ensureConfigDir();

      const jsoncPath = join(configDir, 'opencode.jsonc');
      writeFileSync(jsoncPath, '{}');

      expect(getExistingConfigPath()).toBe(jsoncPath);
    });

    test('returns default .json if neither exists', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'opencode-test-'));
      delete process.env.OPENCODE_CONFIG;
      process.env.XDG_CONFIG_HOME = tmpDir;

      const jsonPath = join(tmpDir, 'opencode', 'opencode.json');
      expect(getExistingConfigPath()).toBe(jsonPath);
    });
  });

  test("ensureConfigDir() creates directory if it doesn't exist", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'opencode-test-'));
    delete process.env.OPENCODE_CONFIG;
    process.env.XDG_CONFIG_HOME = tmpDir;
    const configDir = join(tmpDir, 'opencode');

    expect(existsSync(configDir)).toBe(false);
    ensureConfigDir();
    expect(existsSync(configDir)).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
