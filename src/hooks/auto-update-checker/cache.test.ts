import { describe, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';

// Mock internal dependencies
mock.module('./constants', () => ({
  CACHE_DIR: '/mock/cache',
  PACKAGE_NAME: 'oh-my-opencode-slim',
}));

mock.module('../../utils/logger', () => ({
  log: mock(() => {}),
}));

mock.module('../../cli/config-manager', () => ({
  stripJsonComments: (s: string) => s,
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
      const writeSpy = spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
      const { invalidatePackage } = await import(
        `./cache?test=${importCounter++}`
      );

      const result = invalidatePackage();

      expect(result).toBe(true);
      const callArgs = writeSpy.mock.calls[0];
      const savedJson = JSON.parse(callArgs[1]);
      expect(savedJson.dependencies['oh-my-opencode-slim']).toBeUndefined();
      expect(savedJson.dependencies['other-pkg']).toBe('1.0.0');

      existsSpy.mockRestore();
      readSpy.mockRestore();
      writeSpy.mockRestore();
    });
  });
});
