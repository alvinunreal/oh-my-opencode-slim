import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

const whichSyncMock = mock((..._args: unknown[]) => null as string | null);
mock.module('which', () => ({
  sync: whichSyncMock,
  default: { sync: whichSyncMock },
}));

import { findServerForExtension, isServerInstalled } from './config';

describe('config', () => {
  beforeEach(() => {
    spyOn(fs, 'existsSync').mockImplementation(() => false);
    spyOn(os, 'homedir').mockReturnValue('/home/user');
    whichSyncMock.mockClear();
    whichSyncMock.mockReturnValue(null);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('isServerInstalled', () => {
    test('should return false if command is empty', () => {
      expect(isServerInstalled([])).toBe(false);
    });

    test('should detect absolute paths', () => {
      spyOn(fs, 'existsSync').mockImplementation(
        (path: fs.PathLike) => path === '/usr/bin/lsp-server',
      );
      expect(isServerInstalled(['/usr/bin/lsp-server'])).toBe(true);
      expect(isServerInstalled(['/usr/bin/missing'])).toBe(false);
    });

    test('should detect server in PATH', () => {
      const originalPath = process.env.PATH;
      process.env.PATH = '/usr/local/bin:/usr/bin';

      whichSyncMock.mockReturnValue(
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

      spyOn(fs, 'existsSync').mockImplementation(
        (path: fs.PathLike) => path === localBin,
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

      whichSyncMock.mockReturnValue(globalBin);

      expect(isServerInstalled(['typescript-language-server'])).toBe(true);
    });
  });

  describe('findServerForExtension', () => {
    test('should skip deno for .ts when project is not a deno workspace', () => {
      whichSyncMock.mockImplementation((cmd: unknown) =>
        cmd === 'typescript-language-server'
          ? join('/usr/bin', 'typescript-language-server')
          : null,
      );
      spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) =>
        path.toString().includes('bun.lock'),
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
      whichSyncMock.mockImplementation((cmd: unknown) =>
        cmd === 'deno' ? join('/usr/bin', 'deno') : null,
      );
      spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) =>
        path.toString().includes('deno.json'),
      );

      const result = findServerForExtension('.ts', '/workspace/app/src/mod.ts');

      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('deno');
      }
    });

    test('should return found for .py extension if installed (prefers ty)', () => {
      whichSyncMock.mockImplementation((cmd: unknown) =>
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
      whichSyncMock.mockImplementation((cmd: unknown) =>
        cmd === 'typescript-language-server'
          ? join('/usr/bin', 'typescript-language-server')
          : null,
      );
      spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) =>
        path.toString().includes('bun.lock'),
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
      spyOn(fs, 'existsSync').mockImplementation((path: fs.PathLike) =>
        path.toString().includes('bun.lock'),
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
