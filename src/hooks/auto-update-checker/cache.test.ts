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

describe('auto-update-checker/cache', () => {
  describe('invalidatePackage', () => {
    test('returns false when nothing to invalidate', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
      const { invalidatePackage } = await import(
        `./cache?test=${importCounter++}`
      );

      const result = invalidatePackage();
      expect(result).toBe(false);

      existsSpy.mockRestore();
    });

    test('returns true and removes directory if node_modules path exists', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation(
        (p: string) => p.includes('node_modules'),
      );
      const rmSyncSpy = spyOn(fs, 'rmSync').mockReturnValue(undefined);
      const { invalidatePackage } = await import(
        `./cache?test=${importCounter++}`
      );

      const result = invalidatePackage();

      expect(rmSyncSpy).toHaveBeenCalled();
      expect(result).toBe(true);

      existsSpy.mockRestore();
      rmSyncSpy.mockRestore();
    });

    test('removes dependency from package.json if present', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation(
        (p: string) => p.includes('package.json'),
      );
      const readSpy = spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({
          dependencies: {
            'oh-my-opencode-slim': '1.0.0',
            'other-pkg': '1.0.0',
          },
        }),
      );
      const writtenData: string[] = [];
      const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(
        (_path: string, data: string) => {
          writtenData.push(data);
        },
      );
      const { invalidatePackage } = await import(
        `./cache?test=${importCounter++}`
      );

      const result = invalidatePackage();

      expect(result).toBe(true);
      expect(writtenData.length).toBeGreaterThan(0);
      const savedJson = JSON.parse(writtenData[0]);
      expect(savedJson.dependencies['oh-my-opencode-slim']).toBeUndefined();
      expect(savedJson.dependencies['other-pkg']).toBe('1.0.0');

      existsSpy.mockRestore();
      readSpy.mockRestore();
      writeSpy.mockRestore();
    });
  });
});
