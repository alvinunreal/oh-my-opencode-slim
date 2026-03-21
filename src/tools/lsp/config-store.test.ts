import { beforeEach, describe, expect, test } from 'bun:test';
import {
  getAllUserLspConfigs,
  getUserLspConfig,
  hasUserLspConfig,
  setUserLspConfig,
} from './config-store';

describe('config-store', () => {
  beforeEach(() => {
    // Clear config before each test
    setUserLspConfig(undefined);
  });

  describe('setUserLspConfig', () => {
    test('stores empty config', () => {
      setUserLspConfig(undefined);
      expect(hasUserLspConfig()).toBe(false);
    });

    test('stores single server config', () => {
      setUserLspConfig({
        pyright: { disabled: true },
      });

      expect(hasUserLspConfig()).toBe(true);
      const config = getUserLspConfig('pyright');
      expect(config).toEqual({
        id: 'pyright',
        disabled: true,
      });
    });

    test('stores multiple server configs', () => {
      setUserLspConfig({
        pyright: { disabled: true },
        ty: {
          command: ['uvx', 'ty', 'server'],
          extensions: ['.py', '.pyi'],
        },
      });

      expect(getUserLspConfig('pyright')).toEqual({
        id: 'pyright',
        disabled: true,
      });
      expect(getUserLspConfig('ty')).toEqual({
        id: 'ty',
        command: ['uvx', 'ty', 'server'],
        extensions: ['.py', '.pyi'],
      });
    });

    test('handles config with env and initialization', () => {
      setUserLspConfig({
        rust: {
          command: ['rust-analyzer'],
          extensions: ['.rs'],
          env: { RUST_LOG: 'debug' },
          initialization: { cargo: { buildScripts: true } },
        },
      });

      const config = getUserLspConfig('rust');
      expect(config).toEqual({
        id: 'rust',
        command: ['rust-analyzer'],
        extensions: ['.rs'],
        env: { RUST_LOG: 'debug' },
        initialization: { cargo: { buildScripts: true } },
      });
    });

    test('overwrites previous config', () => {
      setUserLspConfig({
        ts: { command: ['tsserver'], extensions: ['.ts'] },
      });
      setUserLspConfig({
        py: { command: ['pyright'], extensions: ['.py'] },
      });

      expect(getUserLspConfig('ts')).toBeUndefined();
      expect(getUserLspConfig('py')).toEqual({
        id: 'py',
        command: ['pyright'],
        extensions: ['.py'],
      });
    });

    test('handles empty object', () => {
      setUserLspConfig({});
      expect(hasUserLspConfig()).toBe(false);
    });
  });

  describe('getAllUserLspConfigs', () => {
    test('returns empty map when no config', () => {
      const all = getAllUserLspConfigs();
      expect(all.size).toBe(0);
    });

    test('returns all configured servers', () => {
      setUserLspConfig({
        server1: { command: ['cmd1'], extensions: ['.ext1'] },
        server2: { command: ['cmd2'], extensions: ['.ext2'] },
      });

      const all = getAllUserLspConfigs();
      expect(all.size).toBe(2);
      expect(all.has('server1')).toBe(true);
      expect(all.has('server2')).toBe(true);
    });

    test('returns a copy, not the original map', () => {
      setUserLspConfig({
        test: { command: ['test'], extensions: ['.test'] },
      });

      const all = getAllUserLspConfigs();
      all.delete('test'); // Modify the copy

      expect(getUserLspConfig('test')).toBeDefined(); // Original unchanged
    });
  });

  describe('hasUserLspConfig', () => {
    test('returns false when no config', () => {
      expect(hasUserLspConfig()).toBe(false);
    });

    test('returns true when config exists', () => {
      setUserLspConfig({ server: { command: ['cmd'] } });
      expect(hasUserLspConfig()).toBe(true);
    });
  });

  describe('getUserLspConfig', () => {
    test('returns undefined for non-existent server', () => {
      setUserLspConfig({ existing: { command: ['cmd'] } });
      expect(getUserLspConfig('nonexistent')).toBeUndefined();
    });

    test('returns undefined after clearing config', () => {
      setUserLspConfig({ server: { command: ['cmd'] } });
      setUserLspConfig(undefined);
      expect(getUserLspConfig('server')).toBeUndefined();
    });
  });
});
