import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';

// Mock fs and os BEFORE importing the modules that use them
mock.module('fs', () => ({
  existsSync: mock(() => false),
}));

mock.module('os', () => ({
  homedir: () => '/home/user',
}));

import { existsSync } from 'node:fs';
// Now import the code to test
import { findServerForExtension, isServerInstalled } from './config';
import { setUserLspConfig } from './config-store';

describe('config', () => {
  beforeEach(() => {
    (existsSync as any).mockClear();
    (existsSync as any).mockImplementation(() => false);
    // Clear user LSP config before each test
    setUserLspConfig(undefined);
  });

  describe('isServerInstalled', () => {
    test('should return false if command is empty', () => {
      expect(isServerInstalled([])).toBe(false);
    });

    test('should detect absolute paths', () => {
      (existsSync as any).mockImplementation(
        (path: string) => path === '/usr/bin/lsp-server',
      );
      expect(isServerInstalled(['/usr/bin/lsp-server'])).toBe(true);
      expect(isServerInstalled(['/usr/bin/missing'])).toBe(false);
    });

    test('should detect server in PATH', () => {
      const originalPath = process.env.PATH;
      process.env.PATH = '/usr/local/bin:/usr/bin';

      (existsSync as any).mockImplementation(
        (path: string) =>
          path === join('/usr/bin', 'typescript-language-server'),
      );

      expect(isServerInstalled(['typescript-language-server'])).toBe(true);

      process.env.PATH = originalPath;
    });

    test('should detect server in local node_modules', () => {
      const cwd = process.cwd();
      const localBin = join(
        cwd,
        'node_modules',
        '.bin',
        'typescript-language-server',
      );

      (existsSync as any).mockImplementation(
        (path: string) => path === localBin,
      );

      expect(isServerInstalled(['typescript-language-server'])).toBe(true);
    });

    test('should detect server in global opencode bin', () => {
      const globalBin = join(
        '/home/user',
        '.config',
        'opencode',
        'bin',
        'typescript-language-server',
      );

      (existsSync as any).mockImplementation(
        (path: string) => path === globalBin,
      );

      expect(isServerInstalled(['typescript-language-server'])).toBe(true);
    });
  });

  describe('findServerForExtension', () => {
    test('should return found for .ts extension if installed', () => {
      (existsSync as any).mockReturnValue(true);
      const result = findServerForExtension('.ts');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('typescript');
      }
    });

    test('should return found for .py extension if installed (prefers basedpyright)', () => {
      (existsSync as any).mockReturnValue(true);
      const result = findServerForExtension('.py');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('basedpyright');
      }
    });

    test('should return not_configured for unknown extension', () => {
      const result = findServerForExtension('.unknown');
      expect(result.status).toBe('not_configured');
    });

    test('should return not_installed if server not in PATH', () => {
      (existsSync as any).mockReturnValue(false);
      const result = findServerForExtension('.ts');
      expect(result.status).toBe('not_installed');
      if (result.status === 'not_installed') {
        expect(result.server.id).toBe('typescript');
        expect(result.installHint).toContain(
          'npm install -g typescript-language-server',
        );
      }
    });
  });

  describe('findServerForExtension with user config', () => {
    test('should use user config instead of built-in servers', () => {
      (existsSync as any).mockReturnValue(true);
      setUserLspConfig({
        myserver: {
          command: ['my-language-server'],
          extensions: ['.ts', '.tsx'],
        },
      });

      const result = findServerForExtension('.ts');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('myserver');
        expect(result.server.command).toEqual(['my-language-server']);
      }
    });

    test('should skip disabled user servers', () => {
      (existsSync as any).mockReturnValue(true);
      setUserLspConfig({
        pyright: {
          disabled: true,
          command: ['pyright'],
          extensions: ['.py'],
        },
      });

      // Should fall back to built-in basedpyright
      const result = findServerForExtension('.py');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('basedpyright');
      }
    });

    test('should respect user command over built-in', () => {
      (existsSync as any).mockReturnValue(true);
      setUserLspConfig({
        ty: {
          command: ['uvx', 'ty', 'server'],
          extensions: ['.py', '.pyi'],
        },
      });

      const result = findServerForExtension('.py');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('ty');
        expect(result.server.command).toEqual(['uvx', 'ty', 'server']);
      }
    });

    test('should use user env and initialization options', () => {
      (existsSync as any).mockReturnValue(true);
      setUserLspConfig({
        rust: {
          command: ['rust-analyzer'],
          extensions: ['.rs'],
          env: { RUST_LOG: 'debug' },
          initialization: { cargo: { buildScripts: true } },
        },
      });

      const result = findServerForExtension('.rs');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.env).toEqual({ RUST_LOG: 'debug' });
        expect(result.server.initialization).toEqual({
          cargo: { buildScripts: true },
        });
      }
    });

    test('should return not_installed for user config with missing binary', () => {
      (existsSync as any).mockImplementation((path: string) =>
        path.includes('missing-server') ? false : true,
      );
      setUserLspConfig({
        custom: {
          command: ['missing-server'],
          extensions: ['.custom'],
        },
      });

      const result = findServerForExtension('.custom');
      expect(result.status).toBe('not_installed');
      if (result.status === 'not_installed') {
        expect(result.server.id).toBe('custom');
        expect(result.installHint).toContain('missing-server');
      }
    });

    test('should return not_configured for extension not in user config', () => {
      (existsSync as any).mockReturnValue(true);
      setUserLspConfig({
        typescript: {
          command: ['tsserver'],
          extensions: ['.ts'],
        },
      });

      const result = findServerForExtension('.py');
      // Should fall back to built-in
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('basedpyright');
      }
    });

    test('should handle multiple user servers', () => {
      (existsSync as any).mockReturnValue(true);
      setUserLspConfig({
        ts: { command: ['tsserver'], extensions: ['.ts'] },
        py: { command: ['pyright'], extensions: ['.py'] },
      });

      const tsResult = findServerForExtension('.ts');
      expect(tsResult.status).toBe('found');
      if (tsResult.status === 'found') {
        expect(tsResult.server.id).toBe('ts');
      }

      const pyResult = findServerForExtension('.py');
      expect(pyResult.status).toBe('found');
      if (pyResult.status === 'found') {
        expect(pyResult.server.id).toBe('py');
      }
    });

    test('should clear user config when set to undefined', () => {
      (existsSync as any).mockReturnValue(true);
      setUserLspConfig({
        custom: { command: ['custom'], extensions: ['.ext'] },
      });

      // First verify custom server is found
      const beforeResult = findServerForExtension('.ext');
      expect(beforeResult.status).toBe('found');
      if (beforeResult.status === 'found') {
        expect(beforeResult.server.id).toBe('custom');
      }

      // Clear config
      setUserLspConfig(undefined);

      // Should fall back to built-in
      const afterResult = findServerForExtension('.ts');
      expect(afterResult.status).toBe('found');
      if (afterResult.status === 'found') {
        expect(afterResult.server.id).toBe('typescript');
      }
    });
  });
});
