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
  getTuiConfig: () => '/mock/config/tui.json',
  getTuiConfigJsonc: () => '/mock/config/tui.jsonc',
}));

// Cache buster for dynamic imports
let importCounter = 0;

describe('auto-update-checker/checker', () => {
  describe('extractChannel', () => {
    test('returns latest for null or empty', async () => {
      const { extractChannel } = await import(
        `./checker?test=${importCounter++}`
      );
      expect(extractChannel(null)).toBe('latest');
      expect(extractChannel('')).toBe('latest');
    });

    test('returns tag if version starts with non-digit', async () => {
      const { extractChannel } = await import(
        `./checker?test=${importCounter++}`
      );
      expect(extractChannel('beta')).toBe('beta');
      expect(extractChannel('next')).toBe('next');
    });

    test('extracts channel from prerelease version', async () => {
      const { extractChannel } = await import(
        `./checker?test=${importCounter++}`
      );
      expect(extractChannel('1.0.0-alpha.1')).toBe('alpha');
      expect(extractChannel('2.3.4-beta.5')).toBe('beta');
      expect(extractChannel('0.1.0-rc.1')).toBe('rc');
      expect(extractChannel('1.0.0-canary.0')).toBe('canary');
    });

    test('returns latest for standard versions', async () => {
      const { extractChannel } = await import(
        `./checker?test=${importCounter++}`
      );
      expect(extractChannel('1.0.0')).toBe('latest');
    });
  });

  describe('getLocalDevVersion', () => {
    test('returns null if no local dev path in config', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
      const { getLocalDevVersion } = await import(
        `./checker?test=${importCounter++}`
      );

      expect(getLocalDevVersion('/test')).toBeNull();

      existsSpy.mockRestore();
    });

    test('returns version from local package.json if path exists', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation(
        (p: string) => {
          if (p.includes('opencode.json')) return true;
          if (p.includes('package.json')) return true;
          return false;
        },
      );
      const statSpy = spyOn(fs, 'statSync').mockImplementation(
        () =>
          ({
            isDirectory: () => true,
          }) as unknown as fs.Stats,
      );
      const readSpy = spyOn(fs, 'readFileSync').mockImplementation(
        (p: string) => {
          if (p.includes('opencode.json')) {
            return JSON.stringify({
              plugin: ['file:///dev/oh-my-opencode-slim'],
            });
          }
          if (p.includes('package.json')) {
            return JSON.stringify({
              name: 'oh-my-opencode-slim',
              version: '1.2.3-dev',
            });
          }
          return '';
        },
      );

      const { getLocalDevVersion } = await import(
        `./checker?test=${importCounter++}`
      );

      expect(getLocalDevVersion('/test')).toBe('1.2.3-dev');

      existsSpy.mockRestore();
      statSpy.mockRestore();
      readSpy.mockRestore();
    });
  });

  describe('findPluginEntry', () => {
    test('detects latest version entry', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation(
        (p: string) => p.includes('opencode.json'),
      );
      const readSpy = spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({
          plugin: ['oh-my-opencode-slim'],
        }),
      );

      const { findPluginEntry } = await import(
        `./checker?test=${importCounter++}`
      );

      const entry = findPluginEntry('/test');
      expect(entry).not.toBeNull();
      expect(entry?.entry).toBe('oh-my-opencode-slim');
      expect(entry?.isPinned).toBe(false);
      expect(entry?.pinnedVersion).toBeNull();

      existsSpy.mockRestore();
      readSpy.mockRestore();
    });

    test('detects pinned version entry', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation(
        (p: string) => p.includes('opencode.json'),
      );
      const readSpy = spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({
          plugin: ['oh-my-opencode-slim@1.0.0'],
        }),
      );

      const { findPluginEntry } = await import(
        `./checker?test=${importCounter++}`
      );

      const entry = findPluginEntry('/test');
      expect(entry).not.toBeNull();
      expect(entry?.isPinned).toBe(true);
      expect(entry?.pinnedVersion).toBe('1.0.0');

      existsSpy.mockRestore();
      readSpy.mockRestore();
    });

    test('treats only installer-managed exact tuples as updateable', async () => {
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation((p) =>
        String(p).includes('opencode.json'),
      );
      const readSpy = spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({
          plugin: [
            'oh-my-opencode-slim@1.2.3',
            [
              'oh-my-opencode-slim@1.2.3',
              { __ohMyOpencodeSlimManagedByInstaller: true },
            ],
          ],
        }),
      );
      const { findPluginEntry } = await import(
        `./checker?test=${importCounter++}`
      );

      const entry = findPluginEntry('/test');
      expect(entry?.isPinned).toBe(false);
      expect(entry?.isInstallerManaged).toBe(true);

      const managedReadSpy = spyOn(fs, 'readFileSync').mockReturnValue(
        JSON.stringify({
          plugin: [
            [
              'oh-my-opencode-slim@1.2.3',
              { __ohMyOpencodeSlimManagedByInstaller: true },
            ],
          ],
        }),
      );
      const managedEntry = findPluginEntry('/test');
      expect(managedEntry?.isPinned).toBe(false);
      expect(managedEntry?.isInstallerManaged).toBe(true);

      existsSpy.mockRestore();
      readSpy.mockRestore();
      managedReadSpy.mockRestore();
    });
  });

  describe('updateInstallerManagedVersions', () => {
    test('structurally rewrites managed tuples in OpenCode and TUI configs only', async () => {
      const files = new Map<string, string>([
        [
          '/mock/config/opencode.json',
          `{
  // preserve this comment
  "note": "{ [ ] }",
  "other": { "plugin": [["oh-my-opencode-slim@0.1.0", { "__ohMyOpencodeSlimManagedByInstaller": true }]] },
  "plugin": [["oh-my-opencode-slim@0.2.0", { "__ohMyOpencodeSlimManagedByInstaller": true }]],
  "plugin": [
    [ /* tuple comment */ "oh-my-opencode-slim@1.2.3", { "__ohMyOpencodeSlimManagedByInstaller": true, "keep": "[{}]" } ],
    ["oh-my-opencode-slim@1.2.3", { "__ohMyOpencodeSlimManagedByInstaller": false, "__ohMyOpencodeSlimManagedByInstaller": true }],
    ["oh-my-opencode-slim@1.2.3", { "__ohMyOpencodeSlimManagedByInstaller": "true" }],
    ["oh-my-opencode-slim\\u00401.2.3", { "__ohMyOpencodeSlimManagedByInstall\\u0065r": true }],
    "oh-my-opencode-slim@1.2.3",
    ["oh-my-opencode-slim@1.2.3", { "nested": { "__ohMyOpencodeSlimManagedByInstaller": true } }]
  ]
}`,
        ],
        [
          '/mock/config/tui.json',
          JSON.stringify({
            plugin: [
              [
                'oh-my-opencode-slim@1.2.3',
                { __ohMyOpencodeSlimManagedByInstaller: true },
              ],
            ],
          }),
        ],
      ]);
      const existsSpy = spyOn(fs, 'existsSync').mockImplementation((path) =>
        files.has(String(path)),
      );
      const readSpy = spyOn(fs, 'readFileSync').mockImplementation(
        (path) => files.get(String(path)) ?? '',
      );
      const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(
        (path, data) => files.set(String(path), String(data)),
      );
      const renameSpy = spyOn(fs, 'renameSync').mockImplementation(
        (from, to) => {
          files.set(String(to), files.get(String(from)) ?? '');
        },
      );
      const { updateInstallerManagedVersions } = await import(
        `./checker?test=${importCounter++}`
      );

      const previousTuiConfig = process.env.OPENCODE_TUI_CONFIG;
      process.env.OPENCODE_TUI_CONFIG = '/mock/config/tui.json';
      expect(updateInstallerManagedVersions('/project', '1.2.4')).toBe(true);
      expect(files.get('/mock/config/opencode.json')).toContain(
        'oh-my-opencode-slim@1.2.4',
      );
      expect(files.get('/mock/config/opencode.json')).toContain(
        '"oh-my-opencode-slim@1.2.4", { "__ohMyOpencodeSlimManagedByInstall\\u0065r": true }',
      );
      expect(files.get('/mock/config/opencode.json')).toContain(
        '"oh-my-opencode-slim@0.1.0", { "__ohMyOpencodeSlimManagedByInstaller": true }',
      );
      expect(files.get('/mock/config/opencode.json')).toContain(
        '"oh-my-opencode-slim@0.2.0", { "__ohMyOpencodeSlimManagedByInstaller": true }',
      );
      expect(files.get('/mock/config/opencode.json')).toContain(
        '"oh-my-opencode-slim@1.2.3", { "__ohMyOpencodeSlimManagedByInstaller": "true" }',
      );
      expect(files.get('/mock/config/opencode.json')).toContain(
        '"keep": "[{}]"',
      );
      expect(files.get('/mock/config/opencode.json')).toContain(
        '"note": "{ [ ] }"',
      );
      expect(files.get('/mock/config/opencode.json')).toContain(
        'oh-my-opencode-slim@1.2.3',
      );
      expect(files.get('/mock/config/opencode.json')).toContain(
        '"nested": { "__ohMyOpencodeSlimManagedByInstaller": true }',
      );
      expect(files.get('/mock/config/opencode.json')).toContain(
        '// preserve this comment',
      );
      expect(files.get('/mock/config/tui.json')).toContain(
        'oh-my-opencode-slim@1.2.4',
      );
      if (previousTuiConfig === undefined) {
        delete process.env.OPENCODE_TUI_CONFIG;
      } else {
        process.env.OPENCODE_TUI_CONFIG = previousTuiConfig;
      }

      existsSpy.mockRestore();
      readSpy.mockRestore();
      writeSpy.mockRestore();
      renameSpy.mockRestore();
    });
  });

  describe('getLatestCompatibleVersion', () => {
    test('selects latest version within current major', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () =>
        Response.json({
          'dist-tags': {
            latest: '2.0.0',
          },
          versions: {
            '1.1.0': {},
            '1.1.2': {},
            '2.0.0': {},
          },
        }),
      ) as never;

      const { getLatestCompatibleVersion } = await import(
        `./checker?test=${importCounter++}`
      );

      const result = await getLatestCompatibleVersion('1.1.1');

      expect(result).toEqual({
        latestVersion: '1.1.2',
        latestMajorVersion: '2.0.0',
        blockedByMajor: true,
      });

      globalThis.fetch = originalFetch;
    });

    test('does not report major block when latest is same major', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () =>
        Response.json({
          'dist-tags': {
            latest: '1.1.2',
          },
          versions: {
            '1.1.1': {},
            '1.1.2': {},
          },
        }),
      ) as never;

      const { getLatestCompatibleVersion } = await import(
        `./checker?test=${importCounter++}`
      );

      const result = await getLatestCompatibleVersion('1.1.1');

      expect(result).toEqual({
        latestVersion: '1.1.2',
        latestMajorVersion: null,
        blockedByMajor: false,
      });

      globalThis.fetch = originalFetch;
    });

    test('uses channel tag as blocking major version', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () =>
        Response.json({
          'dist-tags': {
            latest: '1.9.0',
            beta: '2.0.0-beta.1',
          },
          versions: {
            '1.9.0': {},
            '2.0.0-beta.1': {},
          },
        }),
      ) as never;

      const { getLatestCompatibleVersion } = await import(
        `./checker?test=${importCounter++}`
      );

      const result = await getLatestCompatibleVersion('1.8.0-beta.1', 'beta');

      expect(result).toEqual({
        latestVersion: null,
        latestMajorVersion: '2.0.0-beta.1',
        blockedByMajor: true,
      });

      globalThis.fetch = originalFetch;
    });

    test('treats unparseable current version as unsafe for auto-update', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () =>
        Response.json({
          latest: '2.0.0',
        }),
      ) as never;

      const { getLatestCompatibleVersion } = await import(
        `./checker?test=${importCounter++}`
      );

      const result = await getLatestCompatibleVersion('workspace:*');

      expect(result).toEqual({
        latestVersion: null,
        latestMajorVersion: '2.0.0',
        blockedByMajor: true,
        unsafeReason: 'unparseable-current-version',
      });

      globalThis.fetch = originalFetch;
    });

    test('parses range prefixes before checking major compatibility', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () =>
        Response.json({
          'dist-tags': {
            latest: '1.9.0',
          },
          versions: {
            '1.8.0': {},
            '1.9.0': {},
          },
        }),
      ) as never;

      const { getLatestCompatibleVersion } = await import(
        `./checker?test=${importCounter++}`
      );

      const result = await getLatestCompatibleVersion('^1.0.0');

      expect(result).toEqual({
        latestVersion: '1.9.0',
        latestMajorVersion: null,
        blockedByMajor: false,
      });

      globalThis.fetch = originalFetch;
    });

    test('sorts prerelease numeric suffixes numerically', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () =>
        Response.json({
          'dist-tags': {
            beta: '1.0.0-beta.10',
            latest: '1.0.0',
          },
          versions: {
            '1.0.0-beta.2': {},
            '1.0.0-beta.10': {},
          },
        }),
      ) as never;

      const { getLatestCompatibleVersion } = await import(
        `./checker?test=${importCounter++}`
      );

      const result = await getLatestCompatibleVersion('1.0.0-beta.1', 'beta');

      expect(result).toEqual({
        latestVersion: '1.0.0-beta.10',
        latestMajorVersion: null,
        blockedByMajor: false,
      });

      globalThis.fetch = originalFetch;
    });

    test('supports custom prerelease dist-tag channel names', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () =>
        Response.json({
          'dist-tags': {
            latest: '1.0.0',
            nightly: '1.0.0-nightly.2',
          },
          versions: {
            '1.0.0-nightly.1': {},
            '1.0.0-nightly.2': {},
          },
        }),
      ) as never;

      const { getLatestCompatibleVersion } = await import(
        `./checker?test=${importCounter++}`
      );

      const result = await getLatestCompatibleVersion(
        '1.0.0-nightly.1',
        'nightly',
      );

      expect(result).toEqual({
        latestVersion: '1.0.0-nightly.2',
        latestMajorVersion: null,
        blockedByMajor: false,
      });

      globalThis.fetch = originalFetch;
    });

    test('fallback dist-tags never return lower-major versions as compatible', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: string) => {
        if (url.includes('/-/package/')) {
          return Response.json({ latest: '1.5.0' });
        }

        return new Response(null, { status: 503 });
      }) as never;

      const { getLatestCompatibleVersion } = await import(
        `./checker?test=${importCounter++}`
      );

      const result = await getLatestCompatibleVersion('2.0.0');

      expect(result).toEqual({
        latestVersion: null,
        latestMajorVersion: null,
        blockedByMajor: false,
      });

      globalThis.fetch = originalFetch;
    });

    test('fallback dist-tags never return stable latest for prerelease channel', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: string) => {
        if (url.includes('/-/package/')) {
          return Response.json({ latest: '1.5.0' });
        }

        return new Response(null, { status: 503 });
      }) as never;

      const { getLatestCompatibleVersion } = await import(
        `./checker?test=${importCounter++}`
      );

      const result = await getLatestCompatibleVersion('1.4.0-beta.1', 'beta');

      expect(result).toEqual({
        latestVersion: null,
        latestMajorVersion: null,
        blockedByMajor: false,
      });

      globalThis.fetch = originalFetch;
    });
  });
});
