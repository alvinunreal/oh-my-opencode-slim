/// <reference types="bun-types" />

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

mock.module('../utils/compat', () => ({
  crossSpawn: crossSpawnMock,
}));

const nonexistentPath = '/nonexistent/opencode.json';
mock.module('./paths', () => ({
  getConfigDir: () => '/nonexistent',
  getConfigSearchDirs: () => ['/nonexistent'],
  getOpenCodeConfigPaths: () => [],
  getConfigJson: () => nonexistentPath,
  getConfigJsonc: () => nonexistentPath,
  getLiteConfig: () => nonexistentPath,
  getLiteConfigJsonc: () => nonexistentPath,
  getTuiConfig: () => nonexistentPath,
  getTuiConfigJsonc: () => nonexistentPath,
  getExistingLiteConfigPath: () => nonexistentPath,
  getExistingTuiConfigPath: () => nonexistentPath,
  getExistingConfigPath: () => nonexistentPath,
  ensureConfigDir: () => {},
  ensureTuiConfigDir: () => {},
  ensureOpenCodeConfigDir: () => {},
}));

let importCounter = 0;

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
    delete process.env.XDG_CACHE_HOME;
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    if (originalXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    }
  });

  test('prewarms the OpenCode cache for bunx installs', async () => {
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
    expect(crossSpawnMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ cwd: expectedCacheDir }),
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
      error: `Cached plugin package not found at ${join(
        cacheHome,
        'opencode',
        'packages',
        'oh-my-opencode-slim@latest',
        'node_modules',
        'oh-my-opencode-slim',
        'package.json',
      )}`,
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

    const packageJsonSuffix = join(
      'oh-my-opencode-slim@latest',
      'package.json',
    );
    const fs = await import('node:fs');
    const originalWriteFileSync = fs.writeFileSync;
    const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(
      (path, data, options) => {
        if (String(path).endsWith(packageJsonSuffix)) {
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
    const pathsMod = await import('./paths');
    const configPathSpy = spyOn(
      pathsMod,
      'getExistingConfigPath',
    ).mockReturnValue(configPath);

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
      configPathSpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('uses running version from package.json when config is unpinned (bunx @beta scenario)', async () => {
    const tmpDir = mkdirTemp();
    const cacheHome = join(tmpDir, 'cache');
    process.env.XDG_CACHE_HOME = cacheHome;

    // Simulate bunx @beta: package.json has a beta version, config has no pinned version
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

    // Config mock returns no pinned version (nonexistent config path)
    const { warmOpenCodePluginCache } = await importFreshConfigIo();
    const result = await warmOpenCodePluginCache();

    const expectedCacheDir = join(
      cacheHome,
      'opencode',
      'packages',
      'oh-my-opencode-slim@2.0.0-beta.13',
    );

    expect(result?.success).toBe(true);
    expect(result?.configPath).toBe(expectedCacheDir);
    expect(
      JSON.parse(readFileSync(join(expectedCacheDir, 'package.json'), 'utf-8')),
    ).toEqual({
      name: 'oh-my-opencode-slim-cache',
      private: true,
      dependencies: {
        'oh-my-opencode-slim': '2.0.0-beta.13',
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

    const pathsMod = await import('./paths');
    const configPathSpy = spyOn(
      pathsMod,
      'getExistingConfigPath',
    ).mockReturnValue(configPath);

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
      configPathSpy.mockRestore();
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

    const pathsMod = await import('./paths');
    const configPathSpy = spyOn(
      pathsMod,
      'getExistingConfigPath',
    ).mockReturnValue(configPath);

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
      configPathSpy.mockRestore();
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
