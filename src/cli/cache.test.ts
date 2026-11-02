/// <reference types="bun-types" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pathsMod from '../config/paths';
import * as packageManagerModule from '../utils/package-manager';

type SpawnResult = {
  exited: Promise<number>;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
  kill: () => boolean;
  exitCode: number | null;
  proc: never;
};

type SpawnOptions = {
  cwd?: string;
};

const crossSpawnMock = mock((_command: string[], _options?: SpawnOptions) =>
  createSpawnResult(),
);

const BUN_INSTALL = { command: ['bun', 'install', '--ignore-scripts'] };
const NPM_INSTALL = {
  command: ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
};
let resolvedInstall: { command: string[] } | null = BUN_INSTALL;

// bun's mock.module registry is process-global and test files run in
// filesystem readdir order, so this file's package-manager mock would
// otherwise leak into src/utils/package-manager.test.ts when cli/ is walked
// before utils/. Capture the real exports (before mocking) and restore them
// once this file's tests are done.
const realPackageExports = { ...packageManagerModule };

mock.module('../utils/compat', () => ({
  crossSpawn: crossSpawnMock,
}));

mock.module('../utils/package-manager', () => ({
  resolvePackageInstallCommand: () => resolvedInstall,
}));

afterAll(() => {
  mock.module('../utils/package-manager', () => realPackageExports);
});

const nonexistentPath = '/nonexistent/opencode.json';

let importCounter = 0;
let getExistingConfigPathSpy: ReturnType<typeof spyOn>;

function createSpawnResult(exitCode = 0): SpawnResult {
  return {
    exited: Promise.resolve(exitCode),
    stdout: () => Promise.resolve(''),
    stderr: () => Promise.resolve(''),
    kill: () => true,
    exitCode,
    proc: {} as never,
  };
}

async function importFreshConfigIo() {
  return import(`./config-io?test=${importCounter++}`);
}

describe('warmOpenCodePluginCache', () => {
  const originalArgv = [...process.argv];
  const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

  beforeEach(() => {
    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation(
      (_command: string[], options?: SpawnOptions) => {
        writeCachedPluginPackage(options?.cwd);
        return createSpawnResult();
      },
    );
    resolvedInstall = BUN_INSTALL;
    delete process.env.XDG_CACHE_HOME;
    getExistingConfigPathSpy = spyOn(
      pathsMod,
      'getExistingConfigPath',
    ).mockReturnValue(nonexistentPath);
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    if (originalXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    }
    getExistingConfigPathSpy.mockRestore();
  });

  test('prewarms the @latest OpenCode cache for bunx @latest installs', async () => {
    const tmpDir = mkdirTemp();
    const cacheHome = join(tmpDir, 'cache');
    process.env.XDG_CACHE_HOME = cacheHome;

    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@latest',
      'node_modules',
      'oh-my-opencode-slim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-slim', version: '2.0.0' }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const { warmOpenCodePluginCache } = await importFreshConfigIo();
    const result = await warmOpenCodePluginCache();

    const expectedCacheDir = join(
      cacheHome,
      'opencode',
      'packages',
      'oh-my-opencode-slim@latest',
    );

    expect(result?.success).toBe(true);
    expect(result?.configPath).toBe(expectedCacheDir);
    expect(crossSpawnMock).toHaveBeenCalledTimes(1);
    expect(crossSpawnMock.mock.calls[0][0]).toEqual([
      'bun',
      'install',
      '--ignore-scripts',
    ]);
    expect(crossSpawnMock.mock.calls[0][1]?.cwd).toStartWith(
      `${expectedCacheDir}.staging-`,
    );
    expect(
      JSON.parse(readFileSync(join(expectedCacheDir, 'package.json'), 'utf-8')),
    ).toEqual({
      name: 'oh-my-opencode-slim-cache',
      private: true,
      dependencies: {
        'oh-my-opencode-slim': 'latest',
      },
    });

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('uses npm with audit/fund disabled when the resolver returns npm', async () => {
    const tmpDir = mkdirTemp();
    const cacheHome = join(tmpDir, 'cache');
    process.env.XDG_CACHE_HOME = cacheHome;
    resolvedInstall = NPM_INSTALL;

    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@latest',
      'node_modules',
      'oh-my-opencode-slim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-slim', version: '2.0.0' }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const { warmOpenCodePluginCache } = await importFreshConfigIo();
    const result = await warmOpenCodePluginCache();

    const expectedCacheDir = join(
      cacheHome,
      'opencode',
      'packages',
      'oh-my-opencode-slim@latest',
    );

    expect(result?.success).toBe(true);
    expect(crossSpawnMock).toHaveBeenCalledTimes(1);
    expect(crossSpawnMock.mock.calls[0][0]).toEqual([
      'npm',
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
    expect(crossSpawnMock.mock.calls[0][1]?.cwd).toStartWith(
      `${expectedCacheDir}.staging-`,
    );

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns a failed result without spawning when no package manager is found', async () => {
    const tmpDir = mkdirTemp();
    const cacheHome = join(tmpDir, 'cache');
    process.env.XDG_CACHE_HOME = cacheHome;
    resolvedInstall = null;

    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@latest',
      'node_modules',
      'oh-my-opencode-slim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-slim' }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const { warmOpenCodePluginCache } = await importFreshConfigIo();
    const result = await warmOpenCodePluginCache();

    const expectedCacheDir = join(
      cacheHome,
      'opencode',
      'packages',
      'oh-my-opencode-slim@latest',
    );

    expect(result).toEqual({
      success: false,
      configPath: expectedCacheDir,
      error:
        'No bun or npm found on PATH; install either to warm the OpenCode plugin cache.',
    });
    expect(crossSpawnMock).not.toHaveBeenCalled();
    // The live cached plugin must survive when no manager exists: neither the
    // cache dir nor the manifest may be created/rewritten.
    expect(existsSync(expectedCacheDir)).toBe(false);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('repairs a stale OpenCode cache manifest', async () => {
    const tmpDir = mkdirTemp();
    const cacheHome = join(tmpDir, 'cache');
    process.env.XDG_CACHE_HOME = cacheHome;

    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@latest',
      'node_modules',
      'oh-my-opencode-slim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-slim' }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const expectedCacheDir = join(
      cacheHome,
      'opencode',
      'packages',
      'oh-my-opencode-slim@latest',
    );
    mkdirSync(expectedCacheDir, { recursive: true });
    writeFileSync(
      join(expectedCacheDir, 'package.json'),
      JSON.stringify({
        name: 'stale-cache',
        scripts: { postinstall: 'should-not-run' },
        dependencies: { other: '1.0.0' },
      }),
    );

    const { warmOpenCodePluginCache } = await importFreshConfigIo();
    const result = await warmOpenCodePluginCache();

    expect(result?.success).toBe(true);
    expect(
      JSON.parse(readFileSync(join(expectedCacheDir, 'package.json'), 'utf-8')),
    ).toEqual({
      name: 'oh-my-opencode-slim-cache',
      private: true,
      dependencies: {
        'oh-my-opencode-slim': 'latest',
      },
    });

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('fails when bun install does not create the cached plugin package', async () => {
    const tmpDir = mkdirTemp();
    const cacheHome = join(tmpDir, 'cache');
    process.env.XDG_CACHE_HOME = cacheHome;

    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@latest',
      'node_modules',
      'oh-my-opencode-slim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-slim' }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');
    crossSpawnMock.mockImplementation(() => createSpawnResult());

    const { warmOpenCodePluginCache } = await importFreshConfigIo();
    const result = await warmOpenCodePluginCache();

    expect(result).toEqual({
      success: false,
      configPath: join(
        cacheHome,
        'opencode',
        'packages',
        'oh-my-opencode-slim@latest',
      ),
      error: expect.stringContaining('Cached plugin package not found at '),
    });

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns a failed result when bun install fails', async () => {
    const tmpDir = mkdirTemp();
    const cacheHome = join(tmpDir, 'cache');
    process.env.XDG_CACHE_HOME = cacheHome;

    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@latest',
      'node_modules',
      'oh-my-opencode-slim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-slim' }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');
    crossSpawnMock.mockImplementation(() => ({
      ...createSpawnResult(1),
      stderr: () => Promise.resolve('registry unavailable'),
    }));

    const { warmOpenCodePluginCache } = await importFreshConfigIo();
    const result = await warmOpenCodePluginCache();

    expect(result).toEqual({
      success: false,
      configPath: join(
        cacheHome,
        'opencode',
        'packages',
        'oh-my-opencode-slim@latest',
      ),
      error: 'registry unavailable',
    });

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns a failed result when cache package.json cannot be written', async () => {
    const tmpDir = mkdirTemp();
    const cacheHome = join(tmpDir, 'cache');
    process.env.XDG_CACHE_HOME = cacheHome;

    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@latest',
      'node_modules',
      'oh-my-opencode-slim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-slim' }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const fs = await import('node:fs');
    const originalWriteFileSync = fs.writeFileSync;
    const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(
      (path, data, options) => {
        if (
          String(path).includes('oh-my-opencode-slim@latest.staging-') &&
          String(path).endsWith('/package.json')
        ) {
          throw new Error('disk full');
        }
        return originalWriteFileSync(path, data, options);
      },
    );
    try {
      const { warmOpenCodePluginCache } = await importFreshConfigIo();
      const result = await warmOpenCodePluginCache();

      expect(result).toEqual({
        success: false,
        configPath: join(
          cacheHome,
          'opencode',
          'packages',
          'oh-my-opencode-slim@latest',
        ),
        error: 'Failed to write cache package.json: Error: disk full',
      });
      expect(crossSpawnMock).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('restores the previous cache when publishing the staged cache fails', async () => {
    const tmpDir = mkdirTemp();
    const cacheHome = join(tmpDir, 'cache');
    process.env.XDG_CACHE_HOME = cacheHome;
    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@latest',
      'node_modules',
      'oh-my-opencode-slim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-slim' }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');
    const packagesDir = join(cacheHome, 'opencode', 'packages');
    const cacheDir = join(packagesDir, 'oh-my-opencode-slim@latest');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'old-cache'), 'original');

    const fs = await import('node:fs');
    const originalRenameSync = fs.renameSync;
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (
        String(from).startsWith(`${cacheDir}.staging-`) &&
        !String(from).endsWith('.previous') &&
        String(to) === cacheDir
      ) {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return originalRenameSync(from, to);
    });
    try {
      const { warmOpenCodePluginCache } = await importFreshConfigIo();
      const result = await warmOpenCodePluginCache();
      expect(result?.success).toBe(false);
      expect(result?.error).toContain('EPERM');
      expect(renameSpy).toHaveBeenCalledTimes(3);
      expect(readFileSync(join(cacheDir, 'old-cache'), 'utf8')).toBe(
        'original',
      );
      expect(fs.readdirSync(packagesDir)).toEqual([
        'oh-my-opencode-slim@latest',
      ]);
    } finally {
      renameSpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('skips cache warm-up for local repo installs', async () => {
    const tmpDir = mkdirTemp();
    const packageRoot = join(tmpDir, 'repo');
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-slim' }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const { warmOpenCodePluginCache } = await importFreshConfigIo();
    const result = await warmOpenCodePluginCache();

    expect(result).toBeNull();
    expect(crossSpawnMock).not.toHaveBeenCalled();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('uses pinned version in cache dir and manifest when config has a pinned version', async () => {
    const tmpDir = mkdirTemp();
    const cacheHome = join(tmpDir, 'cache');
    process.env.XDG_CACHE_HOME = cacheHome;

    // Set up a config file with a pinned version
    const configDir = join(tmpDir, 'config');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'opencode.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        plugin: ['oh-my-opencode-slim@1.2.3'],
      }),
    );

    // Override getExistingConfigPath to return our test config
    getExistingConfigPathSpy.mockReturnValue(configPath);

    try {
      const packageRoot = join(
        tmpDir,
        'bunx-1000-oh-my-opencode-slim@latest',
        'node_modules',
        'oh-my-opencode-slim',
      );
      mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({ name: 'oh-my-opencode-slim' }),
      );
      process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

      const { warmOpenCodePluginCache } = await importFreshConfigIo();
      const result = await warmOpenCodePluginCache();

      const expectedCacheDir = join(
        cacheHome,
        'opencode',
        'packages',
        'oh-my-opencode-slim@1.2.3',
      );

      expect(result?.success).toBe(true);
      expect(result?.configPath).toBe(expectedCacheDir);
      expect(
        JSON.parse(
          readFileSync(join(expectedCacheDir, 'package.json'), 'utf-8'),
        ),
      ).toEqual({
        name: 'oh-my-opencode-slim-cache',
        private: true,
        dependencies: {
          'oh-my-opencode-slim': '1.2.3',
        },
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('uses @latest warm dir for unpinned config regardless of running dist-tag', async () => {
    const tmpDir = mkdirTemp();
    const cacheHome = join(tmpDir, 'cache');
    process.env.XDG_CACHE_HOME = cacheHome;

    // Simulate a bunx @beta runtime: package.json has a beta version, config
    // has no pinned version. The warm dir must be @latest because that is the
    // directory OpenCode reads for a bare config entry.
    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@beta',
      'node_modules',
      'oh-my-opencode-slim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-slim', version: '2.0.0-beta.13' }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const { warmOpenCodePluginCache } = await importFreshConfigIo();
    const result = await warmOpenCodePluginCache();

    const expectedCacheDir = join(
      cacheHome,
      'opencode',
      'packages',
      'oh-my-opencode-slim@latest',
    );

    expect(result?.success).toBe(true);
    expect(result?.configPath).toBe(expectedCacheDir);
    expect(
      JSON.parse(readFileSync(join(expectedCacheDir, 'package.json'), 'utf-8')),
    ).toEqual({
      name: 'oh-my-opencode-slim-cache',
      private: true,
      dependencies: {
        'oh-my-opencode-slim': 'latest',
      },
    });

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('uses pinned version from array-format plugin entry', async () => {
    const tmpDir = mkdirTemp();
    const cacheHome = join(tmpDir, 'cache');
    process.env.XDG_CACHE_HOME = cacheHome;

    // Config uses array tuple format: [spec, options]
    const configDir = join(tmpDir, 'config');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'opencode.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        plugin: [['oh-my-opencode-slim@1.2.3', { someOption: true }]],
      }),
    );

    getExistingConfigPathSpy.mockReturnValue(configPath);

    try {
      const packageRoot = join(
        tmpDir,
        'bunx-1000-oh-my-opencode-slim@latest',
        'node_modules',
        'oh-my-opencode-slim',
      );
      mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({ name: 'oh-my-opencode-slim' }),
      );
      process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

      const { warmOpenCodePluginCache } = await importFreshConfigIo();
      const result = await warmOpenCodePluginCache();

      const expectedCacheDir = join(
        cacheHome,
        'opencode',
        'packages',
        'oh-my-opencode-slim@1.2.3',
      );

      expect(result?.success).toBe(true);
      expect(result?.configPath).toBe(expectedCacheDir);
      expect(
        JSON.parse(
          readFileSync(join(expectedCacheDir, 'package.json'), 'utf-8'),
        ),
      ).toEqual({
        name: 'oh-my-opencode-slim-cache',
        private: true,
        dependencies: {
          'oh-my-opencode-slim': '1.2.3',
        },
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('pinned config version takes precedence over running version', async () => {
    const tmpDir = mkdirTemp();
    const cacheHome = join(tmpDir, 'cache');
    process.env.XDG_CACHE_HOME = cacheHome;

    // Running version is beta
    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@beta',
      'node_modules',
      'oh-my-opencode-slim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-slim', version: '2.0.0-beta.13' }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    // Config has a pinned stable version
    const configDir = join(tmpDir, 'config');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'opencode.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        plugin: ['oh-my-opencode-slim@1.2.3'],
      }),
    );

    getExistingConfigPathSpy.mockReturnValue(configPath);

    try {
      const { warmOpenCodePluginCache } = await importFreshConfigIo();
      const result = await warmOpenCodePluginCache();

      const expectedCacheDir = join(
        cacheHome,
        'opencode',
        'packages',
        'oh-my-opencode-slim@1.2.3',
      );

      expect(result?.success).toBe(true);
      expect(result?.configPath).toBe(expectedCacheDir);
      expect(
        JSON.parse(
          readFileSync(join(expectedCacheDir, 'package.json'), 'utf-8'),
        ),
      ).toEqual({
        name: 'oh-my-opencode-slim-cache',
        private: true,
        dependencies: {
          'oh-my-opencode-slim': '1.2.3',
        },
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function mkdirTemp(): string {
  return mkdtempSync(join(tmpdir(), 'opencode-cache-test-'));
}

function writeCachedPluginPackage(cacheDir?: string): void {
  if (!cacheDir) return;

  const pluginRoot = join(cacheDir, 'node_modules', 'oh-my-opencode-slim');
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(
    join(pluginRoot, 'package.json'),
    JSON.stringify({ name: 'oh-my-opencode-slim' }),
  );
}
