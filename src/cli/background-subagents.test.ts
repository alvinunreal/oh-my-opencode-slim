/// <reference types="bun-types" />

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
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
import {
  detectBackgroundSubagentsTarget,
  detectShellKind,
  expandHomePath,
  getBackgroundSubagentsBlock,
  isBackgroundSubagentsEnabled,
  manualBackgroundSubagentsInstructions,
  upsertBackgroundSubagentsBlock,
  writeBackgroundSubagentsBlock,
} from './background-subagents';
import { parseArgs } from './index';
import { configureBackgroundSubagents } from './install';

describe('background subagents helpers', () => {
  test('detects true-like environment values', () => {
    expect(isBackgroundSubagentsEnabled('true')).toBe(true);
    expect(isBackgroundSubagentsEnabled('1')).toBe(true);
    expect(isBackgroundSubagentsEnabled('yes')).toBe(true);
    expect(isBackgroundSubagentsEnabled('false')).toBe(false);
    expect(isBackgroundSubagentsEnabled('0')).toBe(false);
    expect(isBackgroundSubagentsEnabled(undefined)).toBe(false);
  });

  test('detects supported shell kinds', () => {
    expect(detectShellKind('/bin/zsh')).toBe('zsh');
    expect(detectShellKind('/usr/local/bin/bash')).toBe('bash');
    expect(detectShellKind('/opt/homebrew/bin/fish')).toBe('fish');
    expect(detectShellKind('/bin/sh')).toBeUndefined();
  });

  test('detects shell startup targets including fish XDG config', () => {
    expect(
      detectBackgroundSubagentsTarget({
        SHELL: '/bin/zsh',
        HOME: '/home/test',
        ZDOTDIR: '/home/test/dotfiles',
      }),
    ).toBe('/home/test/dotfiles/.zshrc');
    expect(
      detectBackgroundSubagentsTarget({ SHELL: '/bin/zsh' })?.endsWith(
        '/.zshrc',
      ),
    ).toBe(true);
    expect(
      detectBackgroundSubagentsTarget({ SHELL: '/bin/bash' })?.endsWith(
        '/.bashrc',
      ),
    ).toBe(true);
    expect(
      detectBackgroundSubagentsTarget({
        SHELL: '/usr/bin/fish',
        XDG_CONFIG_HOME: '/tmp/xdg',
      }),
    ).toBe('/tmp/xdg/fish/conf.d/opencode-background-subagents.fish');
  });

  test('builds shell-specific managed blocks with true', () => {
    const bashBlock = getBackgroundSubagentsBlock('/tmp/.bashrc');
    const fishBlock = getBackgroundSubagentsBlock('/tmp/config.fish');
    expect(bashBlock).toContain(
      'export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true',
    );
    expect(bashBlock).toContain('export OPENCODE_ENABLE_EXA=1');
    expect(fishBlock).toContain(
      'set -gx OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS true',
    );
    expect(fishBlock).toContain('set -gx OPENCODE_ENABLE_EXA 1');
  });

  test('prints fish manual instructions for fish targets', () => {
    const instructions = manualBackgroundSubagentsInstructions({
      targetPath: '/tmp/config.fish',
    });

    expect(instructions).toContain(
      'set -gx OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS true',
    );
    expect(instructions).toContain(
      'env OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true OPENCODE_ENABLE_EXA=1 opencode',
    );
    expect(instructions).toContain('set -gx OPENCODE_ENABLE_EXA 1');
  });

  test('expands tilde target paths', () => {
    expect(expandHomePath('~')).not.toBe('~');
    expect(expandHomePath('~/profile')).not.toContain('~');
    expect(expandHomePath('/tmp/profile')).toBe('/tmp/profile');
  });

  test('upserts the managed block idempotently', () => {
    const first = upsertBackgroundSubagentsBlock('before\n', 'BLOCK');
    const second = upsertBackgroundSubagentsBlock(
      first,
      getBackgroundSubagentsBlock('/tmp/.zshrc'),
    );
    const third = upsertBackgroundSubagentsBlock(
      second,
      getBackgroundSubagentsBlock('/tmp/.zshrc'),
    );

    expect(third).toBe(second);
    expect(
      third.match(/OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS/g),
    ).toHaveLength(1);
  });
});

describe('background subagents writing', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  test('writes managed block without duplicates', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'omoo-bg-'));
    const target = join(tempDir, '.bashrc');
    writeFileSync(target, 'existing=true\n');

    writeBackgroundSubagentsBlock(target);
    writeBackgroundSubagentsBlock(target);

    const content = readFileSync(target, 'utf8');
    expect(content).toContain('existing=true');
    expect(
      content.match(/OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS/g),
    ).toHaveLength(1);
  });
});

describe('parseArgs background subagents', () => {
  test('does not request background setup for non-interactive installs', () => {
    expect(parseArgs([]).backgroundSubagents).toBe('ask');
    expect(parseArgs(['--no-tui']).backgroundSubagents).toBe('no');
  });

  test('parses mode and target override', () => {
    expect(
      parseArgs([
        '--background-subagents=yes',
        '--background-subagents-target=/tmp/profile',
      ]),
    ).toMatchObject({
      backgroundSubagents: 'yes',
      backgroundSubagentsTarget: '/tmp/profile',
    });
  });

  test('rejects unknown install options and retains equals signs in values', () => {
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dir, 'index.ts'),
        'install',
        '--background-subagent=no',
        '--dry-run',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown install option');
    expect(
      parseArgs(['--background-subagents-target=/tmp/a=b'])
        .backgroundSubagentsTarget,
    ).toBe('/tmp/a=b');
  });

  test('v2 installation skips v1-only shell, TUI, and model refresh steps', () => {
    const root = mkdtempSync(join(tmpdir(), 'omoo-v2-install-'));
    try {
      const bin = join(root, 'bin');
      const config = join(root, 'config');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'opencode'),
        '#!/bin/sh\necho opencode v2.2.4\n',
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        [
          join(import.meta.dir, 'index.ts'),
          'install',
          '--no-tui',
          '--background-subagents=yes',
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            HOME: root,
            XDG_CONFIG_HOME: config,
            XDG_CACHE_HOME: join(root, 'cache'),
            OPENCODE_CONFIG_DIR: config,
            PATH: `${bin}:/usr/bin:/bin`,
            SHELL: '/bin/bash',
          },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(0);
      expect(existsSync(join(root, '.bashrc'))).toBe(false);
      expect(existsSync(join(config, 'tui.json'))).toBe(false);
      expect(result.stdout).not.toContain('opencode models --refresh');
      expect(result.stdout).toContain('opencode models');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('parseArgs companion', () => {
  test('ignores the removed --companion install option', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseArgs(['--companion=yes'])).not.toHaveProperty('companion');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('companion install'),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('configureBackgroundSubagents', () => {
  let tempDir: string | undefined;
  const originalBackgroundEnv =
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
  const originalExaEnv = process.env.OPENCODE_ENABLE_EXA;
  const originalExperimental = process.env.OPENCODE_EXPERIMENTAL;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    if (originalBackgroundEnv === undefined) {
      delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    } else {
      process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS =
        originalBackgroundEnv;
    }
    if (originalExaEnv === undefined) {
      delete process.env.OPENCODE_ENABLE_EXA;
    } else {
      process.env.OPENCODE_ENABLE_EXA = originalExaEnv;
    }
    if (originalExperimental === undefined)
      delete process.env.OPENCODE_EXPERIMENTAL;
    else process.env.OPENCODE_EXPERIMENTAL = originalExperimental;
  });

  test('recognizes the v1 global experimental flag', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'omoo-bg-'));
    const target = join(tempDir, '.zshrc');
    process.env.OPENCODE_EXPERIMENTAL = 'true';
    delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    delete process.env.OPENCODE_ENABLE_EXA;
    const result = await configureBackgroundSubagents({
      reset: false,
      backgroundSubagents: 'yes',
      backgroundSubagentsTarget: target,
    });
    expect(result.enabledNow).toBe(true);
    expect(() => readFileSync(target)).toThrow();
  });

  test.each(['true', '1', 'TRUE'])(
    'returns already enabled without writing the target when Exa is %s',
    async (exaValue) => {
      tempDir = mkdtempSync(join(tmpdir(), 'omoo-bg-'));
      const target = join(tempDir, '.zshrc');
      writeFileSync(target, 'preserve=true\n');
      process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = 'true';
      process.env.OPENCODE_ENABLE_EXA = exaValue;
      const log = spyOn(console, 'log').mockImplementation(() => undefined);

      try {
        const result = await configureBackgroundSubagents({
          promptForStar: false,
          reset: false,
          backgroundSubagents: 'yes',
          backgroundSubagentsTarget: target,
        });

        expect(result).toEqual({ enabledNow: true });
        expect(readFileSync(target, 'utf8')).toBe('preserve=true\n');
        expect(log.mock.calls.join('\n')).toContain(
          'already enabled in environment',
        );
      } finally {
        log.mockRestore();
      }
    },
  );

  test.each([undefined, 'yes', 'false'])(
    'writes Exa configuration when Exa is %s',
    async (exaValue) => {
      tempDir = mkdtempSync(join(tmpdir(), 'omoo-bg-'));
      const target = join(tempDir, '.zshrc');
      process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = 'true';
      if (exaValue === undefined) {
        delete process.env.OPENCODE_ENABLE_EXA;
      } else {
        process.env.OPENCODE_ENABLE_EXA = exaValue;
      }
      const log = spyOn(console, 'log').mockImplementation(() => undefined);

      try {
        const result = await configureBackgroundSubagents({
          promptForStar: false,
          reset: false,
          backgroundSubagents: 'yes',
          backgroundSubagentsTarget: target,
        });

        expect(result).toEqual({ enabledNow: false, configuredTarget: target });
        expect(readFileSync(target, 'utf8')).toContain('OPENCODE_ENABLE_EXA=1');
        expect(log.mock.calls.join('\n')).not.toContain(
          'already enabled in environment',
        );
      } finally {
        log.mockRestore();
      }
    },
  );

  test('writes shell config without prompting', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'omoo-bg-'));
    delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const originalShell = process.env.SHELL;
    const originalHome = process.env.HOME;
    process.env.SHELL = '/bin/zsh';
    process.env.HOME = tempDir;

    try {
      const result = await configureBackgroundSubagents({
        promptForStar: false,
        reset: false,
        backgroundSubagents: 'yes',
      });

      expect(result.configuredTarget?.endsWith('/.zshrc')).toBe(true);
      expect(readFileSync(join(tempDir, '.zshrc'), 'utf8')).toContain(
        'OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS',
      );
      expect(readFileSync(join(tempDir, '.zshrc'), 'utf8')).toContain(
        'OPENCODE_ENABLE_EXA=1',
      );
      expect(log.mock.calls.join('\n')).toContain(
        'Background subagents and Exa websearch enabled',
      );
    } finally {
      process.env.SHELL = originalShell;
      process.env.HOME = originalHome;
      log.mockRestore();
    }
  });

  test('returns no configured target when writing shell config fails', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'omoo-bg-'));
    delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    rmSync(tempDir, { recursive: true, force: true });
    writeFileSync(tempDir, 'not a directory');
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const originalShell = process.env.SHELL;
    const originalHome = process.env.HOME;
    process.env.SHELL = '/bin/zsh';
    process.env.HOME = tempDir;

    try {
      const result = await configureBackgroundSubagents({
        promptForStar: false,
        reset: false,
        backgroundSubagents: 'yes',
      });

      expect(result).toEqual({ enabledNow: false });
      expect(log.mock.calls.join('\n')).toContain(
        'Could not write background subagents shell config:',
      );
      expect(log.mock.calls.join('\n')).toContain('Add the setting manually');
    } finally {
      process.env.SHELL = originalShell;
      process.env.HOME = originalHome;
      log.mockRestore();
    }
  });
});
