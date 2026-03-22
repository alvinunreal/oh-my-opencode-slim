import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';

// Mock fs and os BEFORE importing the modules that use them
mock.module('fs', () => ({
  existsSync: mock(() => false),
}));

mock.module('os', () => ({
  homedir: () => '/home/user',
}));

// Create a mock for which.sync
const whichSyncMock = mock(() => null);
mock.module('which', () => ({
  sync: whichSyncMock,
  default: { sync: whichSyncMock },
}));

import { existsSync } from 'node:fs';
// Now import the code to test
import { findServerForExtension, isServerInstalled } from './config';

describe('config', () => {
  beforeEach(() => {
    (existsSync as any).mockClear();
    (existsSync as any).mockImplementation(() => false);
    whichSyncMock.mockClear();
    whichSyncMock.mockReturnValue(null);
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

      // Mock whichSync to return a path (simulating the command is found)
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

      // Mock whichSync to return the global bin path
      whichSyncMock.mockReturnValue(globalBin);

      expect(isServerInstalled(['typescript-language-server'])).toBe(true);
    });
  });

  describe('findServerForExtension', () => {
    test('should return found for .ts extension if installed', () => {
      (existsSync as any).mockReturnValue(true);
      const result = findServerForExtension('.ts');
      expect(result.status).toBe('found');
      if (result.status === 'found') {
        expect(result.server.id).toBe('deno');
      }
    });

    test('should return found for .py extension if installed (prefers ty)', () => {
      (existsSync as any).mockReturnValue(true);
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

    test('should return not_installed if server not in PATH', () => {
      (existsSync as any).mockReturnValue(false);
      const result = findServerForExtension('.ts');
      expect(result.status).toBe('not_installed');
      if (result.status === 'not_installed') {
        expect(result.server.id).toBe('deno');
        expect(result.installHint).toContain('Install Deno');
      }
    });
  });
});
