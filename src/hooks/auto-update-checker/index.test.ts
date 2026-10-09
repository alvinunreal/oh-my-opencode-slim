import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as packageManagerModule from '../../utils/package-manager';

const logMock = mock(() => {});

const checkerMocks = {
  extractChannel: mock(() => 'latest'),
  findPluginEntry: mock(() => null),
  getCachedVersion: mock(() => null),
  getLatestCompatibleVersion: mock(async () => ({
    latestVersion: null,
    latestMajorVersion: null,
    blockedByMajor: false,
  })),
  getLatestVersion: mock(async () => null),
  getLocalDevVersion: mock(() => null),
  getCurrentRuntimePackageJsonPath: mock(() => null),
  updateInstallerManagedVersions: mock(() => ({ status: 'changed' })),
};

const releaseInstallLockMock = mock(() => {});

const cacheMocks = {
  acquirePackageUpdateLock: mock(
    async (_targetInstallDir: string): Promise<(() => void) | null> =>
      releaseInstallLockMock,
  ),
  preparePackageUpdate: mock(() => '/tmp/opencode'),
  discardPreparedPackageUpdate: mock(() => {}),
  publishPackageUpdate: mock(() => '/tmp/opencode'),
  resolveInstallContext: mock(() => ({ installDir: '/tmp/opencode' })),
  getTargetInstallContext: mock(() => ({ installDir: '/tmp/opencode' })),
  verifyInstalledPackage: mock((_installDir: string, _version: string) => true),
};

const companionUpdaterMocks = {
  ensureCompanionVersion: mock(async () => ({
    status: 'current' as const,
    binaryPath: '/tmp/companion',
    version: '0.1.2',
  })),
  loadCompanionManifestFromPackageRoot: mock(() => null),
};

const crossSpawnMock = mock((_command: string[]) => ({
  exited: Promise.resolve(0),
  exitCode: 0,
  kill: mock(() => true),
  stdout: () => Promise.resolve(''),
  stderr: () => Promise.resolve(''),
  proc: {} as never,
}));

const BUN_INSTALL = { command: ['bun', 'install', '--ignore-scripts'] };
const NPM_INSTALL = {
  command: ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
};
let resolvedInstall: { command: string[] } | null = BUN_INSTALL;

mock.module('../../utils/logger', () => ({
  log: logMock,
}));

mock.module('./checker', () => checkerMocks);

mock.module('./cache', () => cacheMocks);

mock.module('../../companion/updater', () => companionUpdaterMocks);

mock.module('../../utils/compat', () => ({
  crossSpawn: crossSpawnMock,
  crossWrite: mock(() => Promise.resolve()),
  isBun: false,
}));

// bun's mock.module registry is process-global and test files run in
// filesystem readdir order, so this file's package-manager mock would
// otherwise leak into src/utils/package-manager.test.ts. Capture the real
// exports (before mocking) and restore them once this file's tests are done.
const realPackageExports = { ...packageManagerModule };

mock.module('../../utils/package-manager', () => ({
  resolvePackageInstallCommand: () => resolvedInstall,
}));

afterAll(() => {
  mock.module('../../utils/package-manager', () => realPackageExports);
});

let importCounter = 0;

function createCtx() {
  const showToast = mock(() => Promise.resolve(undefined));

  return {
    ctx: {
      directory: '/test',
      client: {
        tui: {
          showToast,
        },
      },
    },
    showToast,
  };
}

async function waitForCalls(
  fn: { mock: { calls: unknown[] } },
  minCalls = 1,
): Promise<void> {
  const deadline = Date.now() + 1000;

  while (fn.mock.calls.length < minCalls) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for async hook work');
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitForLogCall(fragment: string): Promise<void> {
  const deadline = Date.now() + 1000;

  while (
    !logMock.mock.calls.some((call) => String(call[0]).includes(fragment))
  ) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for log: ${fragment}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('auto-update-checker/index', () => {
  beforeEach(() => {
    logMock.mockClear();

    checkerMocks.extractChannel.mockReset();
    checkerMocks.extractChannel.mockImplementation(() => 'latest');
    checkerMocks.findPluginEntry.mockReset();
    checkerMocks.findPluginEntry.mockImplementation(() => null);
    checkerMocks.getCachedVersion.mockReset();
    checkerMocks.getCachedVersion.mockImplementation(() => null);
    checkerMocks.getLatestCompatibleVersion.mockReset();
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: null,
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    checkerMocks.getLatestVersion.mockReset();
    checkerMocks.getLatestVersion.mockImplementation(async () => null);
    checkerMocks.getLocalDevVersion.mockReset();
    checkerMocks.getLocalDevVersion.mockImplementation(() => null);
    checkerMocks.updateInstallerManagedVersions.mockReset();
    checkerMocks.updateInstallerManagedVersions.mockImplementation(() => ({
      status: 'changed' as const,
    }));
    checkerMocks.getCurrentRuntimePackageJsonPath.mockReset();
    checkerMocks.getCurrentRuntimePackageJsonPath.mockImplementation(
      () => null,
    );

    releaseInstallLockMock.mockReset();
    releaseInstallLockMock.mockImplementation(() => {});
    cacheMocks.acquirePackageUpdateLock.mockReset();
    cacheMocks.acquirePackageUpdateLock.mockImplementation(
      async (): Promise<(() => void) | null> => releaseInstallLockMock,
    );
    cacheMocks.preparePackageUpdate.mockReset();
    cacheMocks.preparePackageUpdate.mockImplementation(() => ({
      stagingDir: '/tmp/opencode-staging',
      targetDir: '/tmp/opencode',
    }));
    cacheMocks.publishPackageUpdate.mockReset();
    cacheMocks.publishPackageUpdate.mockImplementation(() => '/tmp/opencode');
    cacheMocks.verifyInstalledPackage.mockReset();
    // Default: only the freshly staged install verifies, so the post-lock
    // re-check against the target install dir proceeds to the install.
    cacheMocks.verifyInstalledPackage.mockImplementation(
      (dir: string) => dir === '/tmp/opencode-staging',
    );
    cacheMocks.discardPreparedPackageUpdate.mockReset();
    cacheMocks.resolveInstallContext.mockReset();
    cacheMocks.resolveInstallContext.mockImplementation(() => ({
      installDir: '/tmp/opencode',
    }));
    cacheMocks.getTargetInstallContext.mockReset();
    cacheMocks.getTargetInstallContext.mockImplementation(() => ({
      installDir: '/tmp/opencode',
    }));

    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation(() => ({
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: mock(() => true),
      stdout: () => Promise.resolve(''),
      stderr: () => Promise.resolve(''),
      proc: {} as never,
    }));

    resolvedInstall = BUN_INSTALL;

    companionUpdaterMocks.ensureCompanionVersion.mockReset();
    companionUpdaterMocks.ensureCompanionVersion.mockImplementation(
      async () => ({
        status: 'current' as const,
        binaryPath: '/tmp/companion',
        version: '0.1.2',
      }),
    );
    companionUpdaterMocks.loadCompanionManifestFromPackageRoot.mockReset();
    companionUpdaterMocks.loadCompanionManifestFromPackageRoot.mockImplementation(
      () => null,
    );
  });

  afterEach(() => {
    // Mocks are automatically cleared by Bun's test runner between tests
  });

  test('uses resolved install root for auto-update installs', async () => {
    const { getAutoUpdateInstallDir } = await import(
      `./index?test=${importCounter++}`
    );

    expect(getAutoUpdateInstallDir()).toBe('/tmp/opencode');
  });

  test('skips background update for local dev installs without startup toast', async () => {
    checkerMocks.getLocalDevVersion.mockImplementation(() => '0.9.11-dev');

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(logMock);

    expect(showToast).not.toHaveBeenCalled();
    expect(checkerMocks.findPluginEntry).not.toHaveBeenCalled();
    expect(checkerMocks.getLatestVersion).not.toHaveBeenCalled();
  });

  test('shows success toast after updating the active install root', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));

    crossSpawnMock.mockImplementation(() => ({
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: mock(() => true),
      stdout: () => Promise.resolve(''),
      stderr: () => Promise.resolve(''),
      proc: {} as never,
    }));

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(cacheMocks.preparePackageUpdate).toHaveBeenCalledWith(
      '0.9.11',
      'oh-my-opencode-slim',
      undefined,
      'latest',
    );
    expect(cacheMocks.acquirePackageUpdateLock).toHaveBeenCalledWith(
      '/tmp/opencode',
    );
    expect(releaseInstallLockMock).toHaveBeenCalled();
    expect(crossSpawnMock).toHaveBeenCalledWith(
      ['bun', 'install', '--ignore-scripts'],
      expect.objectContaining({ cwd: '/tmp/opencode-staging' }),
    );
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim Updated!',
        message:
          'v0.9.1 → v0.9.11\nRestart OpenCode to apply the plugin update.',
        variant: 'success',
        duration: 8000,
      },
    });
  });

  test('skips install when the target version was already installed by another process', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    // The post-lock re-check against the target install dir verifies, while
    // staging (never reached) would not.
    cacheMocks.verifyInstalledPackage.mockImplementation(
      (dir: string) => dir !== '/tmp/opencode-staging',
    );

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(cacheMocks.acquirePackageUpdateLock).toHaveBeenCalledWith(
      '/tmp/opencode',
    );
    expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
    expect(crossSpawnMock).not.toHaveBeenCalled();
    expect(releaseInstallLockMock).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim Updated!',
        message:
          'v0.9.1 → v0.9.11\nRestart OpenCode to apply the plugin update.',
        variant: 'success',
        duration: 8000,
      },
    });
  });

  test('already-installed path ensures the companion from the installed package root', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    // The post-lock re-check against the target install dir verifies, while
    // staging (never reached) would not.
    cacheMocks.verifyInstalledPackage.mockImplementation(
      (dir: string) => dir !== '/tmp/opencode-staging',
    );
    companionUpdaterMocks.loadCompanionManifestFromPackageRoot.mockImplementation(
      () => ({
        version: '0.2.0',
        tag: 'companion-v0.2.0',
        repo: 'owner/repo',
      }),
    );

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never, {
      companion: { enabled: true },
    });
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(
      companionUpdaterMocks.loadCompanionManifestFromPackageRoot,
    ).toHaveBeenCalledWith(
      join('/tmp/opencode', 'node_modules', 'oh-my-opencode-slim'),
    );
    expect(companionUpdaterMocks.ensureCompanionVersion).toHaveBeenCalledWith({
      config: { enabled: true },
      manifest: {
        version: '0.2.0',
        tag: 'companion-v0.2.0',
        repo: 'owner/repo',
      },
    });
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim Updated!',
        message:
          'v0.9.1 → v0.9.11\nRestart OpenCode to apply the plugin update.',
        variant: 'success',
        duration: 8000,
      },
    });
  });

  test('skips install quietly when another process holds the install lock', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    cacheMocks.acquirePackageUpdateLock.mockImplementation(
      async (): Promise<(() => void) | null> => null,
    );

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForLogCall('Another OpenCode process is installing the update');

    expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
    expect(crossSpawnMock).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  test('already-installed path reports redirect failure for installer-managed configs', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
      isInstallerManaged: true,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    const versionedDir = '/cache/packages/oh-my-opencode-slim@0.9.11';
    cacheMocks.resolveInstallContext.mockImplementation(() => ({
      installDir: '/cache/packages/oh-my-opencode-slim@latest',
    }));
    cacheMocks.getTargetInstallContext.mockImplementation(() => ({
      installDir: versionedDir,
    }));
    // The post-lock re-check against the target install dir verifies, while
    // staging (never reached) would not.
    cacheMocks.verifyInstalledPackage.mockImplementation(
      (dir: string) => dir === versionedDir,
    );
    checkerMocks.updateInstallerManagedVersions.mockImplementation(() => ({
      status: 'error' as const,
      error: new Error('config locked'),
    }));

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
    expect(checkerMocks.updateInstallerManagedVersions).toHaveBeenCalledWith(
      '/test',
      '0.9.11',
    );
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim 0.9.11',
        message:
          'Update installed in cache, but plugin configuration could not be updated.',
        variant: 'error',
        duration: 8000,
      },
    });
  });

  test('releases the install lock when the already-installed redirect errors', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
      isInstallerManaged: true,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    const versionedDir = '/cache/packages/oh-my-opencode-slim@0.9.11';
    cacheMocks.resolveInstallContext.mockImplementation(() => ({
      installDir: '/cache/packages/oh-my-opencode-slim@latest',
    }));
    cacheMocks.getTargetInstallContext.mockImplementation(() => ({
      installDir: versionedDir,
    }));
    cacheMocks.verifyInstalledPackage.mockImplementation(
      (dir: string) => dir === versionedDir,
    );
    checkerMocks.updateInstallerManagedVersions.mockImplementation(() => ({
      status: 'error' as const,
      error: new Error('config locked'),
    }));

    // Real lock dir on disk, so the release assertion is filesystem state
    // rather than a mock call count. The redirect-error branch returns from
    // inside the try, so only the finally can release this.
    const lockRoot = mkdtempSync(join(tmpdir(), 'omo-idxlock-'));
    const lockDir = join(lockRoot, 'install.lock');
    cacheMocks.acquirePackageUpdateLock.mockImplementation(
      async (): Promise<(() => void) | null> => {
        mkdirSync(lockDir, { recursive: true });
        return () => rmSync(lockDir, { recursive: true, force: true });
      },
    );

    try {
      const { createAutoUpdateCheckerHook } = await import(
        `./index?test=${importCounter++}`
      );
      const { ctx, showToast } = createCtx();

      const hook = createAutoUpdateCheckerHook(ctx as never);
      hook.event({ event: { type: 'session.created', properties: {} } });
      await waitForCalls(showToast);

      expect(existsSync(lockDir)).toBe(false);
      expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledTimes(1);
      expect(showToast).toHaveBeenCalledWith({
        body: {
          title: 'OMO-Slim 0.9.11',
          message:
            'Update installed in cache, but plugin configuration could not be updated.',
          variant: 'error',
          duration: 8000,
        },
      });
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  test('still shows the success toast when the already-installed redirect reports unchanged', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
      isInstallerManaged: true,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    const versionedDir = '/cache/packages/oh-my-opencode-slim@0.9.11';
    cacheMocks.resolveInstallContext.mockImplementation(() => ({
      installDir: '/cache/packages/oh-my-opencode-slim@latest',
    }));
    cacheMocks.getTargetInstallContext.mockImplementation(() => ({
      installDir: versionedDir,
    }));
    // The post-lock re-check against the target install dir verifies, while
    // staging (never reached) would not.
    cacheMocks.verifyInstalledPackage.mockImplementation(
      (dir: string) => dir === versionedDir,
    );
    checkerMocks.updateInstallerManagedVersions.mockImplementation(() => ({
      status: 'unchanged' as const,
    }));

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
    expect(checkerMocks.updateInstallerManagedVersions).toHaveBeenCalledWith(
      '/test',
      '0.9.11',
    );
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim Updated!',
        message:
          'v0.9.1 → v0.9.11\nRestart OpenCode to apply the plugin update.',
        variant: 'success',
        duration: 8000,
      },
    });
  });

  test('uses npm with audit/fund disabled when the resolver returns npm', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    resolvedInstall = NPM_INSTALL;

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(crossSpawnMock).toHaveBeenCalledWith(
      ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
      expect.objectContaining({ cwd: '/tmp/opencode-staging' }),
    );
  });

  test('updates enabled companion after plugin auto-update', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    companionUpdaterMocks.loadCompanionManifestFromPackageRoot.mockImplementation(
      () => ({
        version: '0.2.0',
        tag: 'companion-v0.2.0',
        repo: 'owner/repo',
      }),
    );
    companionUpdaterMocks.ensureCompanionVersion.mockImplementation(
      async () => ({
        status: 'installed' as const,
        binaryPath: '/tmp/companion',
        version: '0.2.0',
      }),
    );

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never, {
      companion: { enabled: true },
    });
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(
      companionUpdaterMocks.loadCompanionManifestFromPackageRoot,
    ).toHaveBeenCalledWith(
      join('/tmp/opencode', 'node_modules', 'oh-my-opencode-slim'),
    );
    expect(companionUpdaterMocks.ensureCompanionVersion).toHaveBeenCalledWith({
      config: { enabled: true },
      manifest: {
        version: '0.2.0',
        tag: 'companion-v0.2.0',
        repo: 'owner/repo',
      },
    });
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim Updated!',
        message:
          'v0.9.1 → v0.9.11\nCompanion updated.\nRestart OpenCode to apply the plugin update.',
        variant: 'success',
        duration: 8000,
      },
    });
  });

  test('keeps plugin update successful when companion update fails', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    companionUpdaterMocks.ensureCompanionVersion.mockImplementation(
      async () => ({
        status: 'failed' as const,
        binaryPath: '/tmp/companion',
        error: 'network down',
      }),
    );

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never, {
      companion: { enabled: true },
    });
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim Updated!',
        message:
          'v0.9.1 → v0.9.11\nCompanion update will retry on restart.\nRestart OpenCode to apply the plugin update.',
        variant: 'success',
        duration: 8000,
      },
    });
  });

  test('shows notification-only toast when auto-update is disabled', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never, {
      autoUpdate: false,
    });
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim 0.9.11',
        message: 'v0.9.11 available. Auto-update is disabled.',
        variant: 'info',
        duration: 8000,
      },
    });
    expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
    expect(crossSpawnMock).not.toHaveBeenCalled();
  });

  test('shows prepare failure toast and skips installation when active install cannot be resolved', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    cacheMocks.preparePackageUpdate.mockImplementation(() => null);

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(crossSpawnMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim 0.9.11',
        message:
          'v0.9.11 available. Auto-update could not prepare the active install.',
        variant: 'info',
        duration: 8000,
      },
    });
  });

  test('skips self-install and points at the update command when no v1 install context exists', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    cacheMocks.resolveInstallContext.mockImplementation(() => null);

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim 0.9.11',
        message:
          'v0.9.1 → v0.9.11 available. Run `opencode plugin update` to apply.',
        variant: 'info',
        duration: 8000,
      },
    });
    expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
    expect(cacheMocks.publishPackageUpdate).not.toHaveBeenCalled();
    expect(checkerMocks.updateInstallerManagedVersions).not.toHaveBeenCalled();
    expect(crossSpawnMock).not.toHaveBeenCalled();
    expect(logMock).not.toHaveBeenCalledWith(
      expect.stringContaining('Update installed'),
    );
  });

  test('suggests the prerelease channel for an installer-managed skip without a v1 install context', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
      isInstallerManaged: true,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '3.0.0-beta.13');
    checkerMocks.extractChannel.mockImplementation(() => 'beta');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '3.0.0-beta.14',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    cacheMocks.resolveInstallContext.mockImplementation(() => null);

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim 3.0.0-beta.14',
        message:
          'v3.0.0-beta.13 → v3.0.0-beta.14 available. Run `bunx oh-my-opencode-slim@beta install` to apply.',
        variant: 'info',
        duration: 8000,
      },
    });
    expect(checkerMocks.extractChannel).toHaveBeenCalledWith('3.0.0-beta.13');
    expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
    expect(crossSpawnMock).not.toHaveBeenCalled();
  });

  test('suggests the latest channel for an installer-managed skip without a v1 install context', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
      isInstallerManaged: true,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '2.2.22');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '2.2.23',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    cacheMocks.resolveInstallContext.mockImplementation(() => null);

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim 2.2.23',
        message:
          'v2.2.22 → v2.2.23 available. Run `bunx oh-my-opencode-slim@latest install` to apply.',
        variant: 'info',
        duration: 8000,
      },
    });
    expect(checkerMocks.extractChannel).toHaveBeenCalledWith('2.2.22');
    expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
    expect(crossSpawnMock).not.toHaveBeenCalled();
  });

  test('shows install failure toast without telling users to restart', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));

    crossSpawnMock.mockImplementation(() => ({
      exited: Promise.resolve(1),
      exitCode: 1,
      kill: mock(() => true),
      stdout: () => Promise.resolve(''),
      stderr: () => Promise.resolve(''),
      proc: {} as never,
    }));

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(crossSpawnMock).toHaveBeenCalledWith(
      ['bun', 'install', '--ignore-scripts'],
      expect.objectContaining({ cwd: '/tmp/opencode-staging' }),
    );
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim 0.9.11',
        message:
          'v0.9.11 available, but auto-update failed to install it. Check logs or retry manually.',
        variant: 'error',
        duration: 8000,
      },
    });
  });

  test('shows install failure toast and does not spawn when no package manager is found', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    resolvedInstall = null;

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(crossSpawnMock).not.toHaveBeenCalled();
    expect(cacheMocks.discardPreparedPackageUpdate).toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(
      '[auto-update-checker] No bun or npm found; cannot install update',
    );
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim 0.9.11',
        message:
          'v0.9.11 available, but auto-update failed to install it. Check logs or retry manually.',
        variant: 'error',
        duration: 8000,
      },
    });
  });

  test('does not auto-update across major versions', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '1.1.2');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '1.1.2',
      latestMajorVersion: '2.0.0',
      blockedByMajor: true,
    }));

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'oh-my-opencode-slim v2.0.0 is available.',
        message:
          'Running v1.1.2.\nIt requires OpenCode background subagents.\nRefresh the cached copy: `bunx oh-my-opencode-slim@latest install`',
        variant: 'info',
        duration: 12000,
      },
    });
    expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
    expect(crossSpawnMock).not.toHaveBeenCalled();
  });

  test('major toast names the running copy and its origin', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '2.9.9');
    checkerMocks.getCurrentRuntimePackageJsonPath.mockImplementation(
      () =>
        '/home/u/.cache/opencode/packages/oh-my-opencode-slim@latest/node_modules/oh-my-opencode-slim/package.json',
    );
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: null,
      latestMajorVersion: '3.0.2',
      blockedByMajor: true,
    }));

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'oh-my-opencode-slim v3.0.2 is available.',
        message:
          'Running v2.9.9 from /home/u/.cache/opencode/packages/oh-my-opencode-slim@latest/node_modules/oh-my-opencode-slim/package.json.\nIt requires OpenCode background subagents.\nRefresh the cached copy: `bunx oh-my-opencode-slim@latest install`',
        variant: 'info',
        duration: 12000,
      },
    });
    expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
    expect(crossSpawnMock).not.toHaveBeenCalled();
  });

  test('shows only migration toast when compatible and blocked major updates coexist', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '1.0.0');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '1.5.0',
      latestMajorVersion: '2.0.0',
      blockedByMajor: true,
    }));

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      body: expect.objectContaining({
        title: 'oh-my-opencode-slim v2.0.0 is available.',
      }),
    });
    expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
    expect(crossSpawnMock).not.toHaveBeenCalled();
  });

  test('does not show migration copy for unparseable current versions', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: 'workspace:*',
      isPinned: true,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => null);
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: null,
      latestMajorVersion: '1.9.0',
      blockedByMajor: true,
      unsafeReason: 'unparseable-current-version',
    }));

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim 1.9.0',
        message:
          'v1.9.0 available. Auto-update skipped because the current version could not be compared safely.',
        variant: 'info',
        duration: 8000,
      },
    });
    expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
    expect(crossSpawnMock).not.toHaveBeenCalled();
  });

  test('redirects the installer-managed config only after a verified publish', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
      isInstallerManaged: true,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    const versionedDir = '/cache/packages/oh-my-opencode-slim@0.9.11';
    cacheMocks.resolveInstallContext.mockImplementation(() => ({
      installDir: '/cache/packages/oh-my-opencode-slim@latest',
    }));
    cacheMocks.getTargetInstallContext.mockImplementation(() => ({
      installDir: versionedDir,
    }));
    cacheMocks.publishPackageUpdate.mockImplementation(() => versionedDir);

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(checkerMocks.updateInstallerManagedVersions).toHaveBeenCalledWith(
      '/test',
      '0.9.11',
    );
    expect(showToast).toHaveBeenCalledWith({
      body: expect.objectContaining({
        title: 'OMO-Slim Updated!',
        variant: 'success',
      }),
    });
  });

  test('does not redirect the installer-managed config when the install fails', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
      isInstallerManaged: true,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    cacheMocks.resolveInstallContext.mockImplementation(() => ({
      installDir: '/cache/packages/oh-my-opencode-slim@latest',
    }));
    cacheMocks.getTargetInstallContext.mockImplementation(() => ({
      installDir: '/cache/packages/oh-my-opencode-slim@0.9.11',
    }));
    crossSpawnMock.mockImplementation(() => ({
      exited: Promise.resolve(1),
      exitCode: 1,
      kill: mock(() => true),
      stdout: () => Promise.resolve(''),
      stderr: () => Promise.resolve(''),
      proc: {} as never,
    }));

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(checkerMocks.updateInstallerManagedVersions).not.toHaveBeenCalled();
    expect(cacheMocks.discardPreparedPackageUpdate).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({
      body: expect.objectContaining({
        title: 'OMO-Slim 0.9.11',
        variant: 'error',
      }),
    });
  });

  test('skips when a valid wrapper has no derivable publish target', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
      isInstallerManaged: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    cacheMocks.resolveInstallContext.mockImplementation(() => ({
      installDir: '/cache/packages/oh-my-opencode-slim@latest',
    }));
    cacheMocks.getTargetInstallContext.mockImplementation(() => null);

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim 0.9.11',
        message:
          'v0.9.1 → v0.9.11 available. Run `opencode plugin update` to apply.',
        variant: 'info',
        duration: 8000,
      },
    });
    expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
    expect(cacheMocks.publishPackageUpdate).not.toHaveBeenCalled();
    expect(checkerMocks.updateInstallerManagedVersions).not.toHaveBeenCalled();
    expect(crossSpawnMock).not.toHaveBeenCalled();
  });
});
