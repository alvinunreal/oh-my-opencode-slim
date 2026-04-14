import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const logMock = mock(() => {});

const checkerMocks = {
  extractChannel: mock(() => 'latest'),
  findPluginEntry: mock(() => null),
  getCachedVersion: mock(() => null),
  getLatestVersion: mock(async () => null),
  getLocalDevVersion: mock(() => null),
  getCurrentRuntimePackageJsonPath: mock(() => null),
};

const cacheMocks = {
  preparePackageUpdate: mock(() => '/tmp/opencode'),
  resolveInstallContext: mock(() => ({ installDir: '/tmp/opencode' })),
};

const crossSpawnMock = mock((_command: string[]) => ({
  exited: Promise.resolve(0),
  exitCode: 0,
  kill: mock(() => true),
  stdout: () => Promise.resolve(''),
  stderr: () => Promise.resolve(''),
  proc: {} as never,
}));

mock.module('../../utils/logger', () => ({
  log: logMock,
}));

mock.module('./checker', () => checkerMocks);

mock.module('./cache', () => cacheMocks);

mock.module('../../utils/compat', () => ({
  crossSpawn: crossSpawnMock,
  crossWrite: mock(() => Promise.resolve()),
  isBun: false,
}));

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

describe('auto-update-checker/index', () => {
  beforeEach(() => {
    logMock.mockClear();

    checkerMocks.extractChannel.mockReset();
    checkerMocks.extractChannel.mockImplementation(() => 'latest');
    checkerMocks.findPluginEntry.mockReset();
    checkerMocks.findPluginEntry.mockImplementation(() => null);
    checkerMocks.getCachedVersion.mockReset();
    checkerMocks.getCachedVersion.mockImplementation(() => null);
    checkerMocks.getLatestVersion.mockReset();
    checkerMocks.getLatestVersion.mockImplementation(async () => null);
    checkerMocks.getLocalDevVersion.mockReset();
    checkerMocks.getLocalDevVersion.mockImplementation(() => null);

    cacheMocks.preparePackageUpdate.mockReset();
    cacheMocks.preparePackageUpdate.mockImplementation(() => '/tmp/opencode');
    cacheMocks.resolveInstallContext.mockReset();
    cacheMocks.resolveInstallContext.mockImplementation(() => ({
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

  test('shows development toast and skips background update for local dev installs', async () => {
    checkerMocks.getLocalDevVersion.mockImplementation(() => '0.9.11-dev');

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim 0.9.11-dev (dev)',
        message: 'Running in local development mode.',
        variant: 'info',
        duration: 3000,
      },
    });
    expect(checkerMocks.findPluginEntry).not.toHaveBeenCalled();
    expect(checkerMocks.getLatestVersion).not.toHaveBeenCalled();
  });

  test('shows success toast after updating the active install root', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestVersion.mockImplementation(async () => '0.9.11');

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

    const hook = createAutoUpdateCheckerHook(ctx as never, {
      showStartupToast: false,
    });
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(cacheMocks.preparePackageUpdate).toHaveBeenCalledWith(
      '0.9.11',
      'oh-my-opencode-slim',
    );
    expect(crossSpawnMock).toHaveBeenCalledWith(
      ['bun', 'install'],
      expect.objectContaining({ cwd: '/tmp/opencode' }),
    );
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim Updated!',
        message: 'v0.9.1 → v0.9.11\nRestart OpenCode to apply.',
        variant: 'success',
        duration: 8000,
      },
    });
  });

  test('shows prepare failure toast and skips installation when active install cannot be resolved', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestVersion.mockImplementation(async () => '0.9.11');
    cacheMocks.preparePackageUpdate.mockImplementation(() => null);

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never, {
      showStartupToast: false,
    });
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

  test('shows install failure toast without telling users to restart', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.1');
    checkerMocks.getLatestVersion.mockImplementation(async () => '0.9.11');

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

    const hook = createAutoUpdateCheckerHook(ctx as never, {
      showStartupToast: false,
    });
    hook.event({ event: { type: 'session.created', properties: {} } });
    await waitForCalls(showToast);

    expect(crossSpawnMock).toHaveBeenCalledWith(
      ['bun', 'install'],
      expect.objectContaining({ cwd: '/tmp/opencode' }),
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
});
