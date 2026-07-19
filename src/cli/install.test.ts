import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { shouldInstallCompanion } from './install';
import type { InstallConfig } from './types';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;

const actualSkillSync = require('../hooks/auto-update-checker/skill-sync');
const actualConfigManager = require('./config-manager');
const actualBackgroundSubagents = require('./background-subagents');
const actualPaths = require('./paths');

const originalSyncBundledSkillsFromPackage =
  actualSkillSync.syncBundledSkillsFromPackage;

const originalIsOpenCodeInstalled = actualConfigManager.isOpenCodeInstalled;
const originalGetOpenCodeVersion = actualConfigManager.getOpenCodeVersion;
const originalGetOpenCodePath = actualConfigManager.getOpenCodePath;
const originalAddPluginToOpenCodeConfig =
  actualConfigManager.addPluginToOpenCodeConfig;
const originalAddPluginToOpenCodeTuiConfig =
  actualConfigManager.addPluginToOpenCodeTuiConfig;
const originalWarmOpenCodePluginCache =
  actualConfigManager.warmOpenCodePluginCache;
const originalDisableDefaultAgents = actualConfigManager.disableDefaultAgents;
const originalEnableLspByDefault = actualConfigManager.enableLspByDefault;
const originalDetectCurrentConfig = actualConfigManager.detectCurrentConfig;
const originalGenerateLiteConfig = actualConfigManager.generateLiteConfig;
const originalWriteLiteConfig = actualConfigManager.writeLiteConfig;

const originalIsBackgroundSubagentsEnabled =
  actualBackgroundSubagents.isBackgroundSubagentsEnabled;
const originalDetectBackgroundSubagentsTarget =
  actualBackgroundSubagents.detectBackgroundSubagentsTarget;
const originalExpandHomePath = actualBackgroundSubagents.expandHomePath;
const originalGetBackgroundSubagentsBlock =
  actualBackgroundSubagents.getBackgroundSubagentsBlock;
const originalWriteBackgroundSubagentsBlock =
  actualBackgroundSubagents.writeBackgroundSubagentsBlock;
const originalManualBackgroundSubagentsInstructions =
  actualBackgroundSubagents.manualBackgroundSubagentsInstructions;

const originalGetExistingLiteConfigPath = actualPaths.getExistingLiteConfigPath;

let importCounter = 0;
let mockSkippedResult: string[] = [];
let mockFailedResult: string[] = [];
let mockStagedResult: string[] = [];
let mockAdoptedResult: string[] = [];
let mockCustomizedResult: string[] = [];
let receivedSkillSyncOptions: unknown;
let enableInstallMocks = false;

mock.module('../hooks/auto-update-checker/skill-sync', () => {
  return {
    ...actualSkillSync,
    syncBundledSkillsFromPackage: (packageRoot: string, options?: any) => {
      if (enableInstallMocks) {
        receivedSkillSyncOptions = options;
        return {
          installed: [],
          skippedExisting: mockSkippedResult,
          failed: mockFailedResult,
          staged: mockStagedResult,
          adopted: mockAdoptedResult,
          customized: mockCustomizedResult,
        };
      }
      return originalSyncBundledSkillsFromPackage(packageRoot, options);
    },
  };
});

mock.module('./config-manager', () => {
  return {
    ...actualConfigManager,
    isOpenCodeInstalled: async () =>
      enableInstallMocks ? true : originalIsOpenCodeInstalled(),
    getOpenCodeVersion: async () =>
      enableInstallMocks ? '1.0.0' : originalGetOpenCodeVersion(),
    getOpenCodePath: () =>
      enableInstallMocks
        ? '/usr/local/bin/opencode'
        : originalGetOpenCodePath(),
    addPluginToOpenCodeConfig: async () =>
      enableInstallMocks
        ? { success: true, configPath: '/path' }
        : originalAddPluginToOpenCodeConfig(),
    addPluginToOpenCodeTuiConfig: async () =>
      enableInstallMocks
        ? { success: true, configPath: '/path' }
        : originalAddPluginToOpenCodeTuiConfig(),
    warmOpenCodePluginCache: async () =>
      enableInstallMocks
        ? { success: true, configPath: '/path' }
        : originalWarmOpenCodePluginCache(),
    disableDefaultAgents: () =>
      enableInstallMocks
        ? { success: true, configPath: '/path' }
        : originalDisableDefaultAgents(),
    enableLspByDefault: () =>
      enableInstallMocks
        ? { success: true, configPath: '/path' }
        : originalEnableLspByDefault(),
    detectCurrentConfig: () =>
      enableInstallMocks
        ? { isInstalled: true }
        : originalDetectCurrentConfig(),
    generateLiteConfig: (cfg: any) =>
      enableInstallMocks ? {} : originalGenerateLiteConfig(cfg),
    writeLiteConfig: (cfg: any, path?: string) =>
      enableInstallMocks
        ? { success: true, configPath: '/path' }
        : originalWriteLiteConfig(cfg, path),
  };
});

mock.module('./background-subagents', () => {
  return {
    ...actualBackgroundSubagents,
    isBackgroundSubagentsEnabled: (env?: string) =>
      enableInstallMocks ? true : originalIsBackgroundSubagentsEnabled(env),
    detectBackgroundSubagentsTarget: () =>
      enableInstallMocks ? '/path' : originalDetectBackgroundSubagentsTarget(),
    expandHomePath: (p: string) =>
      enableInstallMocks ? p : originalExpandHomePath(p),
    getBackgroundSubagentsBlock: (target: string) =>
      enableInstallMocks ? '' : originalGetBackgroundSubagentsBlock(target),
    writeBackgroundSubagentsBlock: (target: string) =>
      enableInstallMocks ? {} : originalWriteBackgroundSubagentsBlock(target),
    manualBackgroundSubagentsInstructions: (opts?: any) =>
      enableInstallMocks
        ? ''
        : originalManualBackgroundSubagentsInstructions(opts),
  };
});

mock.module('./paths', () => {
  return {
    ...actualPaths,
    getExistingLiteConfigPath: () =>
      enableInstallMocks
        ? '/path/lite-config.json'
        : originalGetExistingLiteConfigPath(),
  };
});

function baseConfig(): InstallConfig {
  return {
    installCustomSkills: false,
    forceSkillSync: false,
    reset: false,
    backgroundSubagents: 'no',
    companion: 'ask',
  };
}

describe('shouldInstallCompanion', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: ORIGINAL_STDIN_IS_TTY,
    });
  });

  test('dry-run defaults to skip on niri', async () => {
    process.env.NIRI_SOCKET = '/run/user/1000/niri.sock';
    const config = { ...baseConfig(), dryRun: true };

    await expect(shouldInstallCompanion(config)).resolves.toBe(false);
    expect(config.companion).toBe('no');
  });

  test('explicit companion yes still enables companion on niri', async () => {
    process.env.XDG_CURRENT_DESKTOP = 'niri';
    const config = { ...baseConfig(), companion: 'yes' as const };

    await expect(shouldInstallCompanion(config)).resolves.toBe(true);
  });

  test('dry-run defaults to skip outside niri', async () => {
    delete process.env.NIRI_SOCKET;
    delete process.env.XDG_CURRENT_DESKTOP;
    delete process.env.DESKTOP_SESSION;
    const config = { ...baseConfig(), dryRun: true };

    await expect(shouldInstallCompanion(config)).resolves.toBe(false);
    expect(config.companion).toBe('no');
  });
});

describe('install skill synchronization error mapping', () => {
  let logSpy: ReturnType<typeof mock>;
  let originalConsoleLog: typeof console.log;

  beforeEach(() => {
    enableInstallMocks = true;
    mockSkippedResult = [];
    mockFailedResult = [];
    mockStagedResult = [];
    mockAdoptedResult = [];
    mockCustomizedResult = [];
    receivedSkillSyncOptions = undefined;
    originalConsoleLog = console.log;
    logSpy = mock(() => {});
    console.log = logSpy;
  });

  afterEach(() => {
    enableInstallMocks = false;
    console.log = originalConsoleLog;
  });

  test('maps __lock__ to lock acquisition failure', async () => {
    mockFailedResult = ['__lock__'];
    const { install } = await import(`./install?test=${importCounter++}`);

    await install({
      skills: 'yes',
      tui: false,
      companion: 'no',
    });

    const calls = logSpy.mock.calls.map((call: any[]) => call[0] as string);
    const hasLockErr = calls.some((msg: string) =>
      msg?.includes('Lock acquisition failed'),
    );
    expect(hasLockErr).toBe(true);

    const hasRawSentinel = calls.some((msg: string) =>
      msg?.includes('__lock__'),
    );
    expect(hasRawSentinel).toBe(false);

    // Verify summary does not count __lock__ as a failed skill
    const summaryMsg = calls.find((msg: string) =>
      msg?.includes('Skill synchronization complete'),
    );
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg).toContain(
      '0 staged, 0 adopted, 0 customized, 0 failed.',
    );
  });

  test('maps __manifest__ to manifest write failure', async () => {
    mockFailedResult = ['__manifest__'];
    const { install } = await import(`./install?test=${importCounter++}`);

    await install({
      skills: 'yes',
      tui: false,
      companion: 'no',
    });

    const calls = logSpy.mock.calls.map((call: any[]) => call[0] as string);
    const hasManifestErr = calls.some((msg: string) =>
      msg?.includes('Manifest write failed'),
    );
    expect(hasManifestErr).toBe(true);

    const hasRawSentinel = calls.some((msg: string) =>
      msg?.includes('__manifest__'),
    );
    expect(hasRawSentinel).toBe(false);

    // Verify summary does not count __manifest__ as a failed skill
    const summaryMsg = calls.find((msg: string) =>
      msg?.includes('Skill synchronization complete'),
    );
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg).toContain(
      '0 staged, 0 adopted, 0 customized, 0 failed.',
    );
  });

  test('keeps normal skill names prefix as Failed: <name>', async () => {
    mockFailedResult = ['some-custom-skill'];
    const { install } = await import(`./install?test=${importCounter++}`);

    await install({
      skills: 'yes',
      tui: false,
      companion: 'no',
    });

    const calls = logSpy.mock.calls.map((call: any[]) => call[0] as string);
    const hasSkillErr = calls.some((msg: string) =>
      msg?.includes('Failed: some-custom-skill'),
    );
    expect(hasSkillErr).toBe(true);

    // Verify summary DOES count standard skill failures in the failed count
    const summaryMsg = calls.find((msg: string) =>
      msg?.includes('Skill synchronization complete'),
    );
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg).toContain(
      '0 staged, 0 adopted, 0 customized, 1 failed.',
    );
  });

  test('prints staged skills during sync', async () => {
    mockStagedResult = ['staged-skill'];
    const { install } = await import(`./install?test=${importCounter++}`);

    await install({
      skills: 'yes',
      tui: false,
      companion: 'no',
    });

    const calls = logSpy.mock.calls.map((call: any[]) => call[0] as string);
    expect(
      calls.some((msg: string) =>
        msg?.includes('Staged for review: staged-skill'),
      ),
    ).toBe(true);
  });

  test('prints adopted skills during sync', async () => {
    mockAdoptedResult = ['adopted-skill'];
    const { install } = await import(`./install?test=${importCounter++}`);

    await install({
      skills: 'yes',
      tui: false,
      companion: 'no',
    });

    const calls = logSpy.mock.calls.map((call: any[]) => call[0] as string);
    expect(
      calls.some((msg: string) => msg?.includes('Adopted: adopted-skill')),
    ).toBe(true);
  });

  test('prints customized skills during sync', async () => {
    mockCustomizedResult = ['customized-skill'];
    const { install } = await import(`./install?test=${importCounter++}`);

    await install({
      skills: 'yes',
      tui: false,
      companion: 'no',
    });

    const calls = logSpy.mock.calls.map((call: any[]) => call[0] as string);
    expect(
      calls.some((msg: string) =>
        msg?.includes('Customized: customized-skill'),
      ),
    ).toBe(true);
  });

  test('does not double-print categorized skipped skills', async () => {
    mockSkippedResult = ['staged-skill', 'adopted-skill', 'customized-skill'];
    mockStagedResult = ['staged-skill'];
    mockAdoptedResult = ['adopted-skill'];
    mockCustomizedResult = ['customized-skill'];
    const { install } = await import(`./install?test=${importCounter++}`);

    await install({
      skills: 'yes',
      tui: false,
      companion: 'no',
    });

    const calls = logSpy.mock.calls.map((call: any[]) => call[0] as string);
    expect(
      calls.some((msg: string) =>
        msg?.includes('Skipped/Preserved: staged-skill'),
      ),
    ).toBe(false);
    expect(
      calls.some((msg: string) =>
        msg?.includes('Skipped/Preserved: adopted-skill'),
      ),
    ).toBe(false);
    expect(
      calls.some((msg: string) =>
        msg?.includes('Skipped/Preserved: customized-skill'),
      ),
    ).toBe(false);

    const summaryMsg = calls.find((msg: string) =>
      msg?.includes('Skill synchronization complete'),
    );
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg).toContain(
      '0 skipped/preserved, 1 staged, 1 adopted, 1 customized, 0 failed.',
    );
  });

  test('passes force mode to bundled skill synchronization', async () => {
    const { install } = await import(`./install?test=${importCounter++}`);

    await install({
      skills: 'force',
      tui: false,
      companion: 'no',
    });

    expect(receivedSkillSyncOptions).toEqual({ force: true });
  });
});
