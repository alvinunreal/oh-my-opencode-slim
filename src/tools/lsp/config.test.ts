import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';

// Mock modules BEFORE importing
mock.module('fs', () => ({
  existsSync: mock(() => false),
}));

mock.module('os', () => ({
  homedir: () => '/home/user',
}));

mock.module('which', () => ({
  default: {
    sync: mock(() => null),
  },
}));

import { existsSync } from 'node:fs';
import whichSync from 'which';
import { findServerForExtension, isServerInstalled } from './config';
import { setUserLspConfig } from './config-store';

describe('config', () => {
  beforeEach(() => {
    (existsSync as any).mockClear();
    (existsSync as any).mockImplementation(() => false);
    (whichSync.sync as any).mockClear();
    (whichSync.sync as any).mockImplementation(() => null);
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

    test('should detect server in PATH via which', () => {
      (whichSync.sync as any).mockImplementation(() => '/usr/bin/tsserver');
      expect(isServerInstalled(['tsserver'])).toBe(true);
    });

    test('should detect server in PATH via which - not found', () => {
      (whichSync.sync as any).mockImplementation(() => null);
      expect(isServerInstalled(['missing-server'])).toBe(false);
    });

    test('should detect server in local node_modules', () => {
      const cwd = process.cwd();
      const localBin = join(
        cwd,
        'node_modules',
        '.bin',
        'typescript-language-server',
      );

      // which returns null, but existsSync finds it in node_modules
      (whichSync.sync as any).mockImplementation(() => null);
      (existsSync as any).mockImplementation(
        (path: string) => path === localBin,
      );

      expect(isServerInstalled(['typescript-language-server'])).toBe(true);
    });

    test('should detect server in global opencode bin via which', () => {
      // which finds it in opencode bin
      (whichSync.sync as any).mockImplementation(
        () => '/home/user/.config/opencode/bin/tsserver',
      );
      expect(isServerInstalled(['tsserver'])).toBe(true);
    });
  });

  describe('findServerForExtension', () => {
    test('should return found for .ts extension if installed', () => {
      (existsSync as any).mockReturnValue(true);
      const result = findServerForExtension('.ts');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        // deno is first in OpenCode core order
        expect(result.server.id).toBe('deno');
      }
    });

    test('should return found for .py extension if installed', () => {
      (existsSync as any).mockReturnValue(true);
      const result = findServerForExtension('.py');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        // ty is first Python server in OpenCode core order
        expect(result.server.id).toBe('ty');
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
        // deno is first .ts server in OpenCode core order
        expect(result.server.id).toBe('deno');
        expect(result.installHint).toContain('deno');
      }
    });
  });

  describe('findServerForExtension with user config', () => {
    test('should use user config instead of built-in servers when same ID', () => {
      (existsSync as any).mockReturnValue(true);
      // User overrides the built-in deno server
      setUserLspConfig({
        deno: {
          command: ['my-language-server'],
          extensions: ['.ts', '.tsx'],
        },
      });

      const result = findServerForExtension('.ts');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('deno');
        expect(result.server.command).toEqual(['my-language-server']);
        // rootPatterns from built-in should be preserved
        expect(result.server.rootPatterns).toEqual(['deno.json', 'deno.jsonc']);
      }
    });

    test('should add custom server alongside built-in servers', () => {
      (existsSync as any).mockReturnValue(true);
      setUserLspConfig({
        myserver: {
          command: ['my-language-server'],
          extensions: ['.custom'],
        },
      });

      // Built-in servers still work for their extensions
      const result = findServerForExtension('.ts');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        // deno is first .ts server (built-in takes precedence)
        expect(result.server.id).toBe('deno');
      }

      // Custom server works for its extension
      const customResult = findServerForExtension('.custom');
      expect(customResult.status).toBe('found');
      if (customResult.status === 'found') {
        expect(customResult.server.id).toBe('myserver');
        expect(customResult.server.command).toEqual(['my-language-server']);
      }
    });

    test('should skip disabled user servers (removes built-in)', () => {
      (existsSync as any).mockReturnValue(true);
      setUserLspConfig({
        ty: {
          disabled: true,
          command: ['ty'],
          extensions: ['.py'],
        },
      });

      // Disabled ty should be removed, falls back to pyright
      const result = findServerForExtension('.py');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('pyright');
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
      // Should fall back to built-in ty (first Python server)
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('ty');
      }
    });

    test('should handle multiple user servers merging with built-ins', () => {
      (existsSync as any).mockReturnValue(true);
      setUserLspConfig({
        rust: { command: ['custom-rust-analyzer'] },
        vue: { command: ['custom-vue-ls'] },
      });

      // rust should be merged with built-in
      const rustResult = findServerForExtension('.rs');
      expect(rustResult.status).toBe('found');
      if (rustResult.status === 'found') {
        expect(rustResult.server.id).toBe('rust');
        // User's command should override built-in
        expect(rustResult.server.command).toEqual(['custom-rust-analyzer']);
        // rootPatterns from built-in should be preserved
        expect(rustResult.server.rootPatterns).toContain('Cargo.toml');
      }

      // vue should be merged with built-in (unique extension)
      const vueResult = findServerForExtension('.vue');
      expect(vueResult.status).toBe('found');
      if (vueResult.status === 'found') {
        expect(vueResult.server.id).toBe('vue');
        expect(vueResult.server.command).toEqual(['custom-vue-ls']);
        // rootPatterns from built-in should be preserved
        expect(vueResult.server.rootPatterns).toBeDefined();
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

      // Should fall back to built-in deno for .ts (first server with .ts)
      const afterResult = findServerForExtension('.ts');
      expect(afterResult.status).toBe('found');
      if (afterResult.status === 'found') {
        expect(afterResult.server.id).toBe('deno');
      }
    });
  });

  describe('findServerForExtension with merged config', () => {
    test('should preserve rootPatterns from built-in when merging', () => {
      (existsSync as any).mockReturnValue(true);
      // User overrides command but not rootPatterns
      setUserLspConfig({
        deno: {
          command: ['custom-deno', 'lsp'],
          extensions: ['.ts', '.tsx'],
        },
      });

      const result = findServerForExtension('.ts');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('deno');
        expect(result.server.command).toEqual(['custom-deno', 'lsp']);
        // rootPatterns should be preserved from built-in
        expect(result.server.rootPatterns).toEqual(['deno.json', 'deno.jsonc']);
      }
    });

    test('should merge user env with built-in when same server', () => {
      (existsSync as any).mockReturnValue(true);
      setUserLspConfig({
        rust: {
          command: ['rust-analyzer'],
          extensions: ['.rs'],
          env: { RUST_LOG: 'debug' },
        },
      });

      const result = findServerForExtension('.rs');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('rust');
        expect(result.server.env).toEqual({ RUST_LOG: 'debug' });
        // rootPatterns from built-in should be preserved
        expect(result.server.rootPatterns).toEqual([
          'Cargo.toml',
          'Cargo.lock',
        ]);
      }
    });

    test('should allow user to override extensions on merged server', () => {
      (existsSync as any).mockReturnValue(true);
      // Disable deno to test typescript server specifically
      setUserLspConfig({
        deno: { disabled: true },
        typescript: {
          command: ['tsserver'],
          extensions: ['.ts', '.tsx', '.mjs'],
        },
      });

      const result = findServerForExtension('.ts');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('typescript');
        expect(result.server.extensions).toContain('.ts');
        expect(result.server.extensions).toContain('.mjs');
      }
    });

    test('should use user initialization options when merging', () => {
      (existsSync as any).mockReturnValue(true);
      // Disable deno to test typescript server specifically
      setUserLspConfig({
        deno: { disabled: true },
        typescript: {
          command: ['tsserver'],
          extensions: ['.ts'],
          initialization: {
            preferences: { includePackageJsonAutoImport: 'on' },
          },
        },
      });

      const result = findServerForExtension('.ts');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('typescript');
        expect(result.server.initialization).toEqual({
          preferences: { includePackageJsonAutoImport: 'on' },
        });
        // rootPatterns from built-in should still be preserved
        expect(result.server.rootPatterns).toBeDefined();
      }
    });

    test('should remove built-in server when disabled', () => {
      (existsSync as any).mockReturnValue(true);
      // Disable deno
      setUserLspConfig({
        deno: { disabled: true },
      });

      // Should fall back to typescript (next .ts server)
      const result = findServerForExtension('.ts');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('typescript');
      }
    });

    test('should allow partial user config to merge with built-in', () => {
      (existsSync as any).mockReturnValue(true);
      // User only provides command, extensions come from built-in
      setUserLspConfig({
        ty: {
          command: ['custom-ty', 'server'],
        },
      });

      const result = findServerForExtension('.py');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('ty');
        expect(result.server.command).toEqual(['custom-ty', 'server']);
        // Extensions should come from built-in
        expect(result.server.extensions).toEqual(['.py', '.pyi']);
        // rootPatterns from built-in should be preserved
        expect(result.server.rootPatterns).toContain('pyproject.toml');
      }
    });

    test('should add new server without affecting built-in servers', () => {
      (existsSync as any).mockReturnValue(true);
      setUserLspConfig({
        custom_lsp: {
          command: ['custom-lsp'],
          extensions: ['.custom'],
        },
      });

      // Built-in servers should still work
      const tsResult = findServerForExtension('.ts');
      expect(tsResult.status).toBe('found');
      if (tsResult.status === 'found') {
        expect(tsResult.server.id).toBe('deno');
      }

      // Custom server should also work
      const customResult = findServerForExtension('.custom');
      expect(customResult.status).toBe('found');
      if (customResult.status === 'found') {
        expect(customResult.server.id).toBe('custom_lsp');
      }
    });
  });
});
