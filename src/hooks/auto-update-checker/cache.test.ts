import { describe, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('auto-update-checker/cache', () => {
  describe('resolveInstallContext', () => {
    test('detects OpenCode packages install root from runtime package path', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation(
        (p: string) =>
          p ===
          '/home/user/.cache/opencode/packages/oh-my-opencode-slim@latest/package.json',
      );
      const { resolveInstallContext } = await import(
        `./cache?test=${importCounter++}`
      );

      const context = resolveInstallContext(
        '/home/user/.cache/opencode/packages/oh-my-opencode-slim@latest/node_modules/oh-my-opencode-slim/package.json',
      );

      expect(context).toEqual({
        installDir:
          '/home/user/.cache/opencode/packages/oh-my-opencode-slim@latest',
        packageJsonPath:
          '/home/user/.cache/opencode/packages/oh-my-opencode-slim@latest/package.json',
      });

      existsSpy.mockRestore();
    });

    test('does not fall back to legacy cache when runtime path is active but wrapper root is invalid', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation(() => false);
      const { resolveInstallContext } = await import(
        `./cache?test=${importCounter++}`
      );

      const context = resolveInstallContext(
        '/home/user/.cache/opencode/packages/oh-my-opencode-slim@latest/node_modules/oh-my-opencode-slim/package.json',
      );

      expect(context).toBeNull();

      existsSpy.mockRestore();
    });
  });

  describe('preparePackageUpdate', () => {
    test('returns null when no install context is available', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
      const { preparePackageUpdate } = await import(
        `./cache?test=${importCounter++}`
      );

      const result = preparePackageUpdate('1.0.1');
      expect(result).toBeNull();

      existsSpy.mockRestore();
    });

    test('updates packages wrapper dependency and removes installed package', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation(
        (p: string) =>
          p ===
            '/home/user/.cache/opencode/packages/oh-my-opencode-slim@latest/package.json' ||
          p ===
            '/home/user/.cache/opencode/packages/oh-my-opencode-slim@latest/node_modules/oh-my-opencode-slim',
      );
      const readSpy = spyOn(fs, 'readFileSync').mockImplementation(
        (p: string) => {
          if (
            p ===
            '/home/user/.cache/opencode/packages/oh-my-opencode-slim@latest/package.json'
          ) {
            return JSON.stringify({
              dependencies: {
                'oh-my-opencode-slim': '0.9.1',
              },
            });
          }
          return '';
        },
      );
      const writtenData: string[] = [];
      const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(
        (_path: string, data: string) => {
          writtenData.push(data);
        },
      );
      const rmSyncSpy = spyOn(fs, 'rmSync').mockReturnValue(undefined);
      const mkdirSyncSpy = spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
      const mkdtempSyncSpy = spyOn(fs, 'mkdtempSync').mockReturnValue(
        '/home/user/.cache/opencode/packages/.oh-my-opencode-slim@0.9.11.staging-test',
      );
      const { preparePackageUpdate } = await import(
        `./cache?test=${importCounter++}`
      );

      const result = preparePackageUpdate(
        '0.9.11',
        'oh-my-opencode-slim',
        '/home/user/.cache/opencode/packages/oh-my-opencode-slim@latest/node_modules/oh-my-opencode-slim/package.json',
      );

      expect(result).toEqual({
        stagingDir:
          '/home/user/.cache/opencode/packages/.oh-my-opencode-slim@0.9.11.staging-test',
        targetDir:
          '/home/user/.cache/opencode/packages/oh-my-opencode-slim@0.9.11',
      });
      expect(writtenData.length).toBeGreaterThan(0);
      expect(JSON.parse(writtenData[0])).toEqual({
        private: true,
        dependencies: {
          'oh-my-opencode-slim': '0.9.11',
        },
      });

      existsSpy.mockRestore();
      readSpy.mockRestore();
      writeSpy.mockRestore();
      rmSyncSpy.mockRestore();
      mkdirSyncSpy.mockRestore();
      mkdtempSyncSpy.mockRestore();
    });

    test('keeps working when dependency is already on target version', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation(
        (p: string) =>
          p.endsWith('/.cache/opencode/package.json') ||
          p.endsWith('/.cache/opencode/node_modules/oh-my-opencode-slim'),
      );
      const readSpy = spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({
          dependencies: {
            'oh-my-opencode-slim': '1.0.1',
          },
        }),
      );
      const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => {});
      const rmSyncSpy = spyOn(fs, 'rmSync').mockReturnValue(undefined);
      const { preparePackageUpdate } = await import(
        `./cache?test=${importCounter++}`
      );

      const result = preparePackageUpdate('1.0.1', 'oh-my-opencode-slim', null);

      expect(result).not.toBeNull();
      expect(writeSpy).toHaveBeenCalled();

      existsSpy.mockRestore();
      readSpy.mockRestore();
      writeSpy.mockRestore();
      rmSyncSpy.mockRestore();
    });
  });

  describe('publishPackageUpdate transaction', () => {
    function createPackage(dir: string, version: string): void {
      const packageDir = join(dir, 'node_modules', 'oh-my-opencode-slim');
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({ name: 'oh-my-opencode-slim', version }),
      );
    }

    function createPrepared(root: string, version: string) {
      const parent = join(root, 'packages');
      fs.mkdirSync(parent, { recursive: true });
      const stagingDir = fs.mkdtempSync(join(parent, '.staging-'));
      return {
        stagingDir,
        targetDir: join(parent, `oh-my-opencode-slim@${version}`),
      };
    }

    test('publishes a verified staged package atomically', async () => {
      const root = fs.mkdtempSync(join(tmpdir(), 'omo-cache-'));
      const prepared = createPrepared(root, '1.2.4');
      createPackage(prepared.stagingDir, '1.2.4');
      const { publishPackageUpdate } = await import(
        `./cache?test=${importCounter++}`
      );

      expect(publishPackageUpdate(prepared, '1.2.4')).toBe(prepared.targetDir);
      expect(fs.existsSync(prepared.stagingDir)).toBe(false);
      expect(fs.existsSync(join(prepared.targetDir, 'node_modules'))).toBe(
        true,
      );
      fs.rmSync(root, { recursive: true, force: true });
    });

    test('cleans staging when a valid concurrent target already exists', async () => {
      const root = fs.mkdtempSync(join(tmpdir(), 'omo-cache-'));
      const prepared = createPrepared(root, '1.2.4');
      createPackage(prepared.stagingDir, '1.2.4');
      createPackage(prepared.targetDir, '1.2.4');
      const { publishPackageUpdate } = await import(
        `./cache?test=${importCounter++}`
      );

      expect(publishPackageUpdate(prepared, '1.2.4')).toBe(prepared.targetDir);
      expect(fs.existsSync(prepared.stagingDir)).toBe(false);
      expect(
        fs
          .readdirSync(join(root, 'packages'))
          .some((name) => name.includes('invalid-')),
      ).toBe(false);
      fs.rmSync(root, { recursive: true, force: true });
    });

    test('replaces an invalid target and removes its quarantine', async () => {
      const root = fs.mkdtempSync(join(tmpdir(), 'omo-cache-'));
      const prepared = createPrepared(root, '1.2.4');
      createPackage(prepared.stagingDir, '1.2.4');
      fs.mkdirSync(prepared.targetDir, { recursive: true });
      fs.writeFileSync(join(prepared.targetDir, 'package.json'), '{}');
      const { publishPackageUpdate } = await import(
        `./cache?test=${importCounter++}`
      );

      expect(publishPackageUpdate(prepared, '1.2.4')).toBe(prepared.targetDir);
      expect(
        fs
          .readdirSync(join(root, 'packages'))
          .some((name) => name.includes('invalid-')),
      ).toBe(false);
      expect(fs.existsSync(prepared.stagingDir)).toBe(false);
      fs.rmSync(root, { recursive: true, force: true });
    });

    test('removes an unverifiable freshly published target and staging', async () => {
      const root = fs.mkdtempSync(join(tmpdir(), 'omo-cache-'));
      const prepared = createPrepared(root, '1.2.4');
      createPackage(prepared.stagingDir, '1.2.3');
      const { publishPackageUpdate } = await import(
        `./cache?test=${importCounter++}`
      );

      expect(publishPackageUpdate(prepared, '1.2.4')).toBeNull();
      expect(fs.existsSync(prepared.targetDir)).toBe(false);
      expect(fs.existsSync(prepared.stagingDir)).toBe(false);
      fs.rmSync(root, { recursive: true, force: true });
    });

    test('restores the prior usable target when replacement verification fails', async () => {
      const root = fs.mkdtempSync(join(tmpdir(), 'omo-cache-'));
      const prepared = createPrepared(root, '1.2.4');
      createPackage(prepared.targetDir, '1.2.3');
      createPackage(prepared.stagingDir, '1.2.3');
      const { publishPackageUpdate } = await import(
        `./cache?test=${importCounter++}`
      );

      expect(publishPackageUpdate(prepared, '1.2.4')).toBeNull();
      expect(
        JSON.parse(
          fs.readFileSync(
            join(
              prepared.targetDir,
              'node_modules',
              'oh-my-opencode-slim',
              'package.json',
            ),
            'utf-8',
          ),
        ),
      ).toEqual({ name: 'oh-my-opencode-slim', version: '1.2.3' });
      expect(fs.existsSync(prepared.stagingDir)).toBe(false);
      expect(
        fs
          .readdirSync(join(root, 'packages'))
          .some((name) => name.includes('invalid-')),
      ).toBe(false);
      fs.rmSync(root, { recursive: true, force: true });
    });
  });
});
