import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import whichModule from 'which';

let existsSyncSpy: ReturnType<typeof spyOn> | undefined;
let whichSyncSpy: ReturnType<typeof spyOn> | undefined;

// Now import the code to test
import { findServerForExtension, isServerInstalled } from './config';

describe('config', () => {
  beforeEach(() => {
    existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation(() => false);
    whichSyncSpy = spyOn(whichModule, 'sync').mockReturnValue(null as any);
  });

  afterEach(() => {
    whichSyncSpy?.mockRestore();
    whichSyncSpy = undefined;
    existsSyncSpy?.mockRestore();
    existsSyncSpy = undefined;
  });

  describe('isServerInstalled', () => {
    test('should return false if command is empty', () => {
      expect(isServerInstalled([])).toBe(false);
    });

    test('should detect absolute paths', () => {
      (fs.existsSync as any).mockImplementation(
        (path: string) => path === '/usr/bin/lsp-server',
      );
      expect(isServerInstalled(['/usr/bin/lsp-server'])).toBe(true);
      expect(isServerInstalled(['/usr/bin/missing'])).toBe(false);
    });

    test('should detect server in PATH', () => {
      const originalPath = process.env.PATH;
      process.env.PATH = '/usr/local/bin:/usr/bin';

      // Mock whichSync to return a path (simulating the command is found)
      whichSyncSpy?.mockReturnValue(
        join('/usr/bin', 'typescript-language-server'),
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

      (fs.existsSync as any).mockImplementation(
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

      // Mock whichSync to return the global bin path
      whichSyncSpy?.mockReturnValue(globalBin);

      expect(isServerInstalled(['typescript-language-server'])).toBe(true);
    });
  });

  describe('findServerForExtension', () => {
    test('should skip deno for .ts when project is not a deno workspace', () => {
      whichSyncSpy?.mockImplementation((cmd: string) =>
        cmd === 'typescript-language-server'
          ? join('/usr/bin', 'typescript-language-server')
          : null,
      );
      (fs.existsSync as any).mockImplementation((path: string) =>
        path.includes('bun.lock'),
      );
      const result = findServerForExtension(
        '.ts',
        '/workspace/project/src/index.ts',
      );
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('typescript');
      }
    });

    test('should prefer deno for .ts in a deno workspace', () => {
      whichSyncSpy?.mockImplementation((cmd: string) =>
        cmd === 'deno' ? join('/usr/bin', 'deno') : null,
      );
      (fs.existsSync as any).mockImplementation((path: string) =>
        path.includes('deno.json'),
      );
      const result = findServerForExtension('.ts', '/workspace/app/src/mod.ts');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('deno');
      }
    });

    test('should return found for .py extension if installed (prefers ty)', () => {
      whichSyncSpy?.mockImplementation((cmd: string) =>
        cmd === 'ty' ? join('/usr/bin', 'ty') : null,
      );
      const result = findServerForExtension('.py');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('ty');
      }
    });

    test('should return not_configured for unknown extension', () => {
      const result = findServerForExtension('.unknown');
      expect(result.status).toBe('not_configured');
    });

    test('should continue to later matching servers when earlier ones are unavailable', () => {
      whichSyncSpy?.mockImplementation((cmd: string) =>
        cmd === 'typescript-language-server'
          ? join('/usr/bin', 'typescript-language-server')
          : null,
      );
      (fs.existsSync as any).mockImplementation((path: string) =>
        path.includes('bun.lock'),
      );

      const result = findServerForExtension(
        '.ts',
        '/workspace/project/src/index.ts',
      );

      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('typescript');
      }
    });

    test('should return first applicable not_installed server if no match is launchable', () => {
      (fs.existsSync as any).mockImplementation((path: string) =>
        path.includes('bun.lock'),
      );
      const result = findServerForExtension(
        '.ts',
        '/workspace/project/src/index.ts',
      );
      expect(result.status).toBe('not_installed');
      if (result.status === 'not_installed') {
        expect(result.server.id).toBe('typescript');
        expect(result.installHint).toContain('typescript-language-server');
      }
    });
  });
});
