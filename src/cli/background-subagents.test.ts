/// <reference types="bun-types" />

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(getBackgroundSubagentsBlock('/tmp/.bashrc')).toContain(
      'export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true',
    );
    expect(getBackgroundSubagentsBlock('/tmp/config.fish')).toContain(
      'set -gx OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS true',
    );
  });

  test('prints fish manual instructions for fish targets', () => {
    const instructions = manualBackgroundSubagentsInstructions({
      targetPath: '/tmp/config.fish',
    });

    expect(instructions).toContain(
      'set -gx OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS true',
    );
    expect(instructions).toContain(
      'env OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode',
    );
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
  test('defaults background subagents to ask', () => {
    expect(parseArgs([]).backgroundSubagents).toBe('ask');
    expect(parseArgs(['--no-tui']).backgroundSubagents).toBe('ask');
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
});

describe('parseArgs companion', () => {
  test('defaults companion install to ask', () => {
    expect(parseArgs([]).companion).toBe('ask');
  });

  test('parses companion mode override', () => {
    expect(parseArgs(['--companion=yes']).companion).toBe('yes');
    expect(parseArgs(['--companion=no']).companion).toBe('no');
    expect(parseArgs(['--companion=ask']).companion).toBe('ask');
  });
});

describe('parseArgs skills', () => {
  test('parses force skill synchronization mode', () => {
    expect(parseArgs(['--skills=force']).skills).toBe('force');
  });
});

describe('configureBackgroundSubagents', () => {
  let tempDir: string | undefined;
  const originalBackgroundEnv =
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    if (originalBackgroundEnv === undefined) {
      delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    } else {
      process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS =
        originalBackgroundEnv;
    }
  });

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
        hasTmux: false,
        installCustomSkills: false,
        promptForStar: false,
        reset: false,
        backgroundSubagents: 'yes',
      });

      expect(result.configuredTarget?.endsWith('/.zshrc')).toBe(true);
      expect(readFileSync(join(tempDir, '.zshrc'), 'utf8')).toContain(
        'OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS',
      );
      expect(log.mock.calls.join('\n')).toContain(
        'Background subagents enabled',
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
        hasTmux: false,
        installCustomSkills: false,
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
