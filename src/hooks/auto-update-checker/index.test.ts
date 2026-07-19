import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

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
  updateInstallerManagedVersions: mock(() => true),
};

const cacheMocks = {
  preparePackageUpdate: mock(() => '/tmp/opencode'),
  discardPreparedPackageUpdate: mock(() => {}),
  publishPackageUpdate: mock(() => '/tmp/opencode'),
  resolveInstallContext: mock(() => ({ installDir: '/tmp/opencode' })),
  verifyInstalledPackage: mock(() => true),
};

const skillSyncMocks = {
  syncBundledSkillsFromPackage: mock(() => ({
    installed: [],
    skippedExisting: [],
    failed: [],
    staged: [],
    adopted: [],
    customized: [],
    stagedThisSync: [],
  })),
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

mock.module('../../utils/logger', () => ({
  log: logMock,
}));

mock.module('./checker', () => checkerMocks);

mock.module('./cache', () => cacheMocks);

mock.module('./skill-sync', () => skillSyncMocks);

mock.module('../../companion/updater', () => companionUpdaterMocks);

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
    checkerMocks.updateInstallerManagedVersions.mockImplementation(() => true);
    checkerMocks.getCurrentRuntimePackageJsonPath.mockReset();
    checkerMocks.getCurrentRuntimePackageJsonPath.mockImplementation(
      () => null,
    );

    cacheMocks.preparePackageUpdate.mockReset();
    cacheMocks.preparePackageUpdate.mockImplementation(() => ({
      stagingDir: '/tmp/opencode-staging',
      targetDir: '/tmp/opencode',
    }));
    cacheMocks.publishPackageUpdate.mockReset();
    cacheMocks.publishPackageUpdate.mockImplementation(() => '/tmp/opencode');
    cacheMocks.verifyInstalledPackage.mockReset();
    cacheMocks.verifyInstalledPackage.mockImplementation(() => true);
    cacheMocks.discardPreparedPackageUpdate.mockReset();
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

    skillSyncMocks.syncBundledSkillsFromPackage.mockReset();
    skillSyncMocks.syncBundledSkillsFromPackage.mockImplementation(() => ({
      installed: [],
      skippedExisting: [],
      failed: [],
      staged: [],
      adopted: [],
      customized: [],
      stagedThisSync: [],
    }));

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
    expect(crossSpawnMock).toHaveBeenCalledWith(
      ['bun', 'install'],
      expect.objectContaining({ cwd: '/tmp/opencode-staging' }),
    );
    expect(skillSyncMocks.syncBundledSkillsFromPackage).toHaveBeenCalledWith(
      '/tmp/opencode/node_modules/oh-my-opencode-slim',
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

  test('shows a manual-review toast for newly staged startup skills when up to date', async () => {
    checkerMocks.getCurrentRuntimePackageJsonPath.mockImplementation(
      () => '/tmp/opencode/package.json',
    );
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.11');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    skillSyncMocks.syncBundledSkillsFromPackage.mockImplementation(() => ({
      installed: [],
      skippedExisting: [],
      failed: [],
      staged: ['reflect'],
      adopted: [],
      customized: ['reflect'],
      stagedThisSync: ['reflect'],
    }));

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    createAutoUpdateCheckerHook(ctx as never).event({
      event: { type: 'session.created', properties: {} },
    });
    await waitForCalls(showToast);

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'Skill updates need review',
        message: 'Manual review required: reflect',
        variant: 'info',
        duration: 8000,
      },
    });
  });

  test('shows a manual-review toast when a version-pinned update is staged at startup', async () => {
    checkerMocks.getCurrentRuntimePackageJsonPath.mockImplementation(
      () => '/tmp/opencode/package.json',
    );
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: '0.9.1',
      isPinned: true,
    }));
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    skillSyncMocks.syncBundledSkillsFromPackage.mockImplementation(() => ({
      installed: [],
      skippedExisting: [],
      failed: [],
      staged: ['reflect'],
      adopted: [],
      customized: ['reflect'],
      stagedThisSync: ['reflect'],
    }));

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    createAutoUpdateCheckerHook(ctx as never).event({
      event: { type: 'session.created', properties: {} },
    });
    await waitForCalls(showToast, 2);

    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'Skill updates need review',
        message: 'Manual review required: reflect',
        variant: 'info',
        duration: 8000,
      },
    });
  });

  test('includes newly installed bundled skills in success toast', async () => {
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
    skillSyncMocks.syncBundledSkillsFromPackage.mockImplementation(() => ({
      installed: ['reflect', 'worktrees'],
      skippedExisting: ['codemap'],
      failed: [],
      staged: [],
      adopted: [],
      customized: [],
      stagedThisSync: [],
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
        title: 'OMO-Slim Updated!',
        message:
          'v0.9.1 → v0.9.11\nAdded bundled skills: reflect, worktrees\nRestart OpenCode to apply the plugin update.',
        variant: 'success',
        duration: 8000,
      },
    });
  });

  test('reports only new skill transitions in success toast without duplication', async () => {
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
    skillSyncMocks.syncBundledSkillsFromPackage.mockImplementation(() => ({
      installed: ['reflect'],
      skippedExisting: [],
      failed: [],
      staged: ['worktrees'],
      adopted: [],
      customized: ['worktrees', 'my-custom-skill'],
      stagedThisSync: ['worktrees'],
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
        title: 'OMO-Slim Updated!',
        message:
          'v0.9.1 → v0.9.11\nAdded bundled skills: reflect\nStaged skill updates require manual review: worktrees\nRestart OpenCode to apply the plugin update.',
        variant: 'success',
        duration: 8000,
      },
    });
  });

  test('retains staged transitions from startup reconciliation for the update toast', async () => {
    checkerMocks.getCurrentRuntimePackageJsonPath.mockImplementation(
      () => '/tmp/opencode/package.json',
    );
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
    skillSyncMocks.syncBundledSkillsFromPackage.mockImplementationOnce(() => ({
      installed: [],
      skippedExisting: [],
      failed: [],
      staged: ['reflect'],
      adopted: [],
      customized: ['reflect'],
      stagedThisSync: ['reflect'],
    }));
    skillSyncMocks.syncBundledSkillsFromPackage.mockImplementationOnce(() => ({
      installed: [],
      skippedExisting: [],
      failed: [],
      staged: [],
      adopted: [],
      customized: ['reflect'],
      stagedThisSync: [],
    }));

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    createAutoUpdateCheckerHook(ctx as never).event({
      event: { type: 'session.created', properties: {} },
    });
    await waitForCalls(showToast);

    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'OMO-Slim Updated!',
        message:
          'v0.9.1 → v0.9.11\nStaged skill updates require manual review: reflect\nRestart OpenCode to apply the plugin update.',
        variant: 'success',
        duration: 8000,
      },
    });
  });

  test('removes startup staged transitions adopted by post-install sync', async () => {
    checkerMocks.getCurrentRuntimePackageJsonPath.mockImplementation(
      () => '/tmp/opencode/package.json',
    );
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
    skillSyncMocks.syncBundledSkillsFromPackage.mockImplementationOnce(() => ({
      installed: [],
      skippedExisting: [],
      failed: [],
      staged: ['reflect'],
      adopted: [],
      customized: ['reflect'],
      stagedThisSync: ['reflect'],
    }));
    skillSyncMocks.syncBundledSkillsFromPackage.mockImplementationOnce(() => ({
      installed: [],
      skippedExisting: [],
      failed: [],
      staged: [],
      adopted: ['reflect'],
      customized: [],
      stagedThisSync: ['reflect'],
    }));

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx, showToast } = createCtx();

    createAutoUpdateCheckerHook(ctx as never).event({
      event: { type: 'session.created', properties: {} },
    });
    await waitForCalls(showToast);

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
    ).toHaveBeenCalledWith('/tmp/opencode/node_modules/oh-my-opencode-slim');
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

  test('still reports update success when bundled skill sync has failures', async () => {
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
    skillSyncMocks.syncBundledSkillsFromPackage.mockImplementation(() => ({
      installed: [],
      skippedExisting: [],
      failed: ['reflect'],
      staged: [],
      adopted: [],
      customized: [],
      stagedThisSync: [],
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
        title: 'OMO-Slim Updated!',
        message:
          'v0.9.1 → v0.9.11\nRestart OpenCode to apply the plugin update.',
        variant: 'success',
        duration: 8000,
      },
    });
    expect(logMock).toHaveBeenCalledWith(
      '[auto-update-checker] Skill sync warnings/failures: reflect',
    );
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
    expect(skillSyncMocks.syncBundledSkillsFromPackage).not.toHaveBeenCalled();
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
    expect(skillSyncMocks.syncBundledSkillsFromPackage).not.toHaveBeenCalled();
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
      ['bun', 'install'],
      expect.objectContaining({ cwd: '/tmp/opencode-staging' }),
    );
    expect(skillSyncMocks.syncBundledSkillsFromPackage).not.toHaveBeenCalled();
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

  test('shows a manual-review toast when installation fails after startup staging', async () => {
    checkerMocks.getCurrentRuntimePackageJsonPath.mockImplementation(
      () => '/tmp/opencode/package.json',
    );
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
    skillSyncMocks.syncBundledSkillsFromPackage.mockImplementation(() => ({
      installed: [],
      skippedExisting: [],
      failed: [],
      staged: ['reflect'],
      adopted: [],
      customized: ['reflect'],
      stagedThisSync: ['reflect'],
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

    createAutoUpdateCheckerHook(ctx as never).event({
      event: { type: 'session.created', properties: {} },
    });
    await waitForCalls(showToast, 2);

    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'Skill updates need review',
        message: 'Manual review required: reflect',
        variant: 'info',
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
          'It requires OpenCode background subagents.\nRun: bunx oh-my-opencode-slim@latest install',
        variant: 'info',
        duration: 12000,
      },
    });
    expect(cacheMocks.preparePackageUpdate).not.toHaveBeenCalled();
    expect(crossSpawnMock).not.toHaveBeenCalled();
    expect(skillSyncMocks.syncBundledSkillsFromPackage).not.toHaveBeenCalled();
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
    expect(skillSyncMocks.syncBundledSkillsFromPackage).not.toHaveBeenCalled();
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
    expect(skillSyncMocks.syncBundledSkillsFromPackage).not.toHaveBeenCalled();
  });

  test('runs startup skill reconciliation even when already on latest version', async () => {
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: null,
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => '0.9.11');
    checkerMocks.getLatestCompatibleVersion.mockImplementation(async () => ({
      latestVersion: '0.9.11',
      latestMajorVersion: null,
      blockedByMajor: false,
    }));
    checkerMocks.getCurrentRuntimePackageJsonPath.mockImplementation(
      () => '/tmp/opencode/package.json',
    );

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });

    await waitForCalls(logMock, 1);

    expect(skillSyncMocks.syncBundledSkillsFromPackage).toHaveBeenCalledWith(
      '/tmp/opencode',
    );
  });

  test('logs staged and customized skills during startup reconciliation', async () => {
    checkerMocks.getCurrentRuntimePackageJsonPath.mockImplementation(
      () => '/tmp/opencode/package.json',
    );
    checkerMocks.findPluginEntry.mockImplementation(() => ({
      pinnedVersion: '0.9.11',
      isPinned: false,
    }));
    checkerMocks.getCachedVersion.mockImplementation(() => null);
    skillSyncMocks.syncBundledSkillsFromPackage.mockImplementation(() => ({
      installed: [],
      skippedExisting: [],
      failed: [],
      staged: ['reflect'],
      adopted: [],
      customized: ['my-custom-skill'],
      stagedThisSync: [],
    }));

    const { createAutoUpdateCheckerHook } = await import(
      `./index?test=${importCounter++}`
    );
    const { ctx } = createCtx();

    const hook = createAutoUpdateCheckerHook(ctx as never);
    hook.event({ event: { type: 'session.created', properties: {} } });

    await waitForCalls(logMock, 3);

    const logs = logMock.mock.calls.map((entry: [string]) => entry[0]);

    expect(logs).toContain(
      '[auto-update-checker] Startup skill sync staged: reflect',
    );
    expect(logs).toContain(
      '[auto-update-checker] Startup skill sync customized: my-custom-skill',
    );
  });
});
