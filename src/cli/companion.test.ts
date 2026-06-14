/// <reference types="bun-types" />

import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPANION_TAG,
  COMPANION_VERSION,
  getCompanionTarget,
  installCompanion,
} from './companion';
import type { InstallConfig } from './types';

const EXPECTED_RELEASE_TARGETS = [
  ['aarch64-apple-darwin', 'tar.gz'],
  ['x86_64-unknown-linux-gnu', 'tar.gz'],
  ['aarch64-unknown-linux-gnu', 'tar.gz'],
  ['x86_64-pc-windows-msvc', 'zip'],
] as const;

const CURRENT_COMPANION_TARGET = getCompanionTarget();

function expectedArchiveName(target: string, ext: string): string {
  return `oh-my-opencode-slim-companion-v${COMPANION_VERSION}-${target}.${ext}`;
}

function dryRunConfig(): InstallConfig {
  return {
    hasTmux: false,
    installCustomSkills: false,
    reset: false,
    backgroundSubagents: 'no',
    companion: 'yes',
    dryRun: true,
  };
}

describe('companion release metadata', () => {
  test('keeps installer tag aligned with companion crate version', () => {
    expect(COMPANION_TAG).toBe(`companion-v${COMPANION_VERSION}`);

    const cargoToml = readFileSync(
      join(import.meta.dir, '..', '..', 'companion', 'Cargo.toml'),
      'utf8',
    );
    expect(cargoToml).toContain(`version = "${COMPANION_VERSION}"`);

    const cargoLock = readFileSync(
      join(import.meta.dir, '..', '..', 'companion', 'Cargo.lock'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(cargoLock).toContain(
      `name = "oh-my-opencode-slim-companion"\nversion = "${COMPANION_VERSION}"`,
    );
  });

  test('release docs list every current companion asset', () => {
    const releaseDocs = readFileSync(
      join(import.meta.dir, '..', '..', 'docs', 'release.md'),
      'utf8',
    );
    const companionDocs = readFileSync(
      join(import.meta.dir, '..', '..', 'docs', 'companion.md'),
      'utf8',
    );

    expect(releaseDocs).toContain(COMPANION_TAG);
    expect(companionDocs).toContain(COMPANION_TAG);

    for (const [target, ext] of EXPECTED_RELEASE_TARGETS) {
      const archiveName = expectedArchiveName(target, ext);
      expect(releaseDocs).toContain(archiveName);
      expect(companionDocs).toContain(archiveName);
    }
  });

  test.skipIf(!CURRENT_COMPANION_TARGET)(
    'dry-run downloads the current companion release asset',
    async () => {
      const target = CURRENT_COMPANION_TARGET;
      if (!target) {
        throw new Error('unsupported companion target was not skipped');
      }

      const log = spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        await expect(installCompanion(dryRunConfig())).resolves.toMatchObject({
          success: true,
        });

        const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
        const expectedUrl =
          `https://github.com/alvinunreal/oh-my-opencode-slim/releases/download/` +
          `${COMPANION_TAG}/${expectedArchiveName(target, ext)}`;
        expect(log.mock.calls.flat().join('\n')).toContain(expectedUrl);
      } finally {
        log.mockRestore();
      }
    },
  );
});
