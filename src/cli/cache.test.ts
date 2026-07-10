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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pathsMod from './paths';

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
      'bunx-1000-oh-my-opencode-ultraslim@latest',
      'node_modules',
      'oh-my-opencode-ultraslim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-ultraslim', version: '2.0.0' }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const { warmOpenCodePluginCache } = await importFreshConfigIo();
    const result = await warmOpenCodePluginCache();

    const expectedCacheDir = join(
      cacheHome,
      'opencode',
      'packages',
      'oh-my-opencode-ultraslim@latest',
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
      name: 'oh-my-opencode-ultraslim-cache',
      private: true,
      dependencies: {
        'oh-my-opencode-ultraslim': 'latest',
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
      'bunx-1000-oh-my-opencode-ultraslim@latest',
      'node_modules',
      'oh-my-opencode-ultraslim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-ultraslim' }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const expectedCacheDir = join(
      cacheHome,
      'opencode',
      'packages',
      'oh-my-opencode-ultraslim@latest',
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
      name: 'oh-my-opencode-ultraslim-cache',
      private: true,
      dependencies: {
        'oh-my-opencode-ultraslim': 'latest',
      },
    });

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('removes stale @latest cache artifacts before reinstalling', async () => {
    const tmpDir = mkdirTemp();
    const cacheHome = join(tmpDir, 'cache');
    process.env.XDG_CACHE_HOME = cacheHome;

    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-ultraslim@latest',
      'node_modules',
      'oh-my-opencode-ultraslim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-ultraslim', version: '2.0.1' }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const expectedCacheDir = join(
      cacheHome,
      'opencode',
      'packages',
      'oh-my-opencode-ultraslim@latest',
    );
    const stalePluginDir = join(
      expectedCacheDir,
      'node_modules',
      'oh-my-opencode-ultraslim',
    );
    mkdirSync(stalePluginDir, { recursive: true });
    writeFileSync(
      join(stalePluginDir, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-ultraslim', version: '1.1.2' }),
    );
    writeFileSync(join(expectedCacheDir, 'bun.lock'), 'stale lockfile');

    crossSpawnMock.mockImplementation(
      (_command: string[], options?: SpawnOptions) => {
        expect(options?.cwd).toBe(expectedCacheDir);
        expect(existsSync(stalePluginDir)).toBe(false);
        expect(existsSync(join(expectedCacheDir, 'bun.lock'))).toBe(false);
        writeCachedPluginPackage(options?.cwd);
        return createSpawnResult();
      },
    );

    const { warmOpenCodePluginCache } = await importFreshConfigIo();
    const result = await warmOpenCodePluginCache();

    expect(result?.success).toBe(true);
    expect(result?.configPath).toBe(expectedCacheDir);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('fails when bun install does not create the cached plugin package', async () => {
    const tmpDir = mkdirTemp();
    const cacheHome = join(tmpDir, 'cache');
    process.env.XDG_CACHE_HOME = cacheHome;

    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-ultraslim@latest',
      'node_modules',
      'oh-my-opencode-ultraslim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-ultraslim' }),
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
        'oh-my-opencode-ultraslim@latest',
      ),
      error: `Cached plugin package not found at ${join(
        cacheHome,
        'opencode',
        'packages',
        'oh-my-opencode-ultraslim@latest',
        'node_modules',
        'oh-my-opencode-ultraslim',
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
      'bunx-1000-oh-my-opencode-ultraslim@latest',
      'node_modules',
      'oh-my-opencode-ultraslim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-ultraslim' }),
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
        'oh-my-opencode-ultraslim@latest',
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
      'bunx-1000-oh-my-opencode-ultraslim@latest',
      'node_modules',
      'oh-my-opencode-ultraslim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'oh-my-opencode-ultraslim' }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const packageJsonSuffix = join(
      'oh-my-opencode-ultraslim@latest',
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
          'oh-my-opencode-ultraslim@latest',
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
      JSON.stringify({ name: 'oh-my-opencode-ultraslim' }),
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
        plugin: ['oh-my-opencode-ultraslim@1.2.3'],
      }),
    );

    // Override getExistingConfigPath to return our test config
    getExistingConfigPathSpy.mockReturnValue(configPath);

    try {
      const packageRoot = join(
        tmpDir,
        'bunx-1000-oh-my-opencode-ultraslim@latest',
        'node_modules',
        'oh-my-opencode-ultraslim',
      );
      mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({ name: 'oh-my-opencode-ultraslim' }),
      );
      process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

      const { warmOpenCodePluginCache } = await importFreshConfigIo();
      const result = await warmOpenCodePluginCache();

      const expectedCacheDir = join(
        cacheHome,
        'opencode',
        'packages',
        'oh-my-opencode-ultraslim@1.2.3',
      );

      expect(result?.success).toBe(true);
      expect(result?.configPath).toBe(expectedCacheDir);
      expect(
        JSON.parse(
          readFileSync(join(expectedCacheDir, 'package.json'), 'utf-8'),
        ),
      ).toEqual({
        name: 'oh-my-opencode-ultraslim-cache',
        private: true,
        dependencies: {
          'oh-my-opencode-ultraslim': '1.2.3',
        },
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('uses requested dist-tag when config is unpinned (bunx @beta scenario)', async () => {
    const tmpDir = mkdirTemp();
    const cacheHome = join(tmpDir, 'cache');
    process.env.XDG_CACHE_HOME = cacheHome;

    // Simulate bunx @beta: package.json has a beta version, config has no pinned version
    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-ultraslim@beta',
      'node_modules',
      'oh-my-opencode-ultraslim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'oh-my-opencode-ultraslim',
        version: '2.0.0-beta.13',
      }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    // Config mock returns no pinned version (nonexistent config path)
    const { warmOpenCodePluginCache } = await importFreshConfigIo();
    const result = await warmOpenCodePluginCache();

    const expectedCacheDir = join(
      cacheHome,
      'opencode',
      'packages',
      'oh-my-opencode-ultraslim@beta',
    );

    expect(result?.success).toBe(true);
    expect(result?.configPath).toBe(expectedCacheDir);
    expect(
      JSON.parse(readFileSync(join(expectedCacheDir, 'package.json'), 'utf-8')),
    ).toEqual({
      name: 'oh-my-opencode-ultraslim-cache',
      private: true,
      dependencies: {
        'oh-my-opencode-ultraslim': 'beta',
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
        plugin: [['oh-my-opencode-ultraslim@1.2.3', { someOption: true }]],
      }),
    );

    getExistingConfigPathSpy.mockReturnValue(configPath);

    try {
      const packageRoot = join(
        tmpDir,
        'bunx-1000-oh-my-opencode-ultraslim@latest',
        'node_modules',
        'oh-my-opencode-ultraslim',
      );
      mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({ name: 'oh-my-opencode-ultraslim' }),
      );
      process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

      const { warmOpenCodePluginCache } = await importFreshConfigIo();
      const result = await warmOpenCodePluginCache();

      const expectedCacheDir = join(
        cacheHome,
        'opencode',
        'packages',
        'oh-my-opencode-ultraslim@1.2.3',
      );

      expect(result?.success).toBe(true);
      expect(result?.configPath).toBe(expectedCacheDir);
      expect(
        JSON.parse(
          readFileSync(join(expectedCacheDir, 'package.json'), 'utf-8'),
        ),
      ).toEqual({
        name: 'oh-my-opencode-ultraslim-cache',
        private: true,
        dependencies: {
          'oh-my-opencode-ultraslim': '1.2.3',
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
      'bunx-1000-oh-my-opencode-ultraslim@beta',
      'node_modules',
      'oh-my-opencode-ultraslim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'oh-my-opencode-ultraslim',
        version: '2.0.0-beta.13',
      }),
    );
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    // Config has a pinned stable version
    const configDir = join(tmpDir, 'config');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'opencode.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        plugin: ['oh-my-opencode-ultraslim@1.2.3'],
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
        'oh-my-opencode-ultraslim@1.2.3',
      );

      expect(result?.success).toBe(true);
      expect(result?.configPath).toBe(expectedCacheDir);
      expect(
        JSON.parse(
          readFileSync(join(expectedCacheDir, 'package.json'), 'utf-8'),
        ),
      ).toEqual({
        name: 'oh-my-opencode-ultraslim-cache',
        private: true,
        dependencies: {
          'oh-my-opencode-ultraslim': '1.2.3',
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

  const pluginRoot = join(cacheDir, 'node_modules', 'oh-my-opencode-ultraslim');
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(
    join(pluginRoot, 'package.json'),
    JSON.stringify({ name: 'oh-my-opencode-ultraslim' }),
  );
}
