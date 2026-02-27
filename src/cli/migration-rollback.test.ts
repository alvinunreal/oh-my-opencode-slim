/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from './config-io';
import {
  backupV1ConfigBeforeMigration,
  rollbackToV1,
} from './migration-rollback';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe('migration-rollback', () => {
  test('creates a V1 backup once for an existing config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omos-v1-backup-'));

    try {
      const configPath = join(dir, 'oh-my-opencode-slim.json');
      writeJson(configPath, {
        preset: 'zen-free',
        presets: { 'zen-free': {} },
      });

      const first = backupV1ConfigBeforeMigration(configPath);
      const second = backupV1ConfigBeforeMigration(configPath);

      expect(first.success).toBe(true);
      expect(first.created).toBe(true);
      expect(first.skipped).toBe(false);
      expect(second.success).toBe(true);
      expect(second.created).toBe(false);
      expect(second.skipped).toBe(true);
      expect(existsSync(`${configPath}.v1-backup`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails rollback when current config is not marked as migrated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omos-rollback-no-marker-'));

    try {
      const configPath = join(dir, 'oh-my-opencode-slim.json');
      writeJson(configPath, {
        preset: 'dynamic',
        presets: { dynamic: {} },
      });
      writeJson(`${configPath}.v1-backup`, {
        preset: 'zen-free',
        presets: { 'zen-free': {} },
      });

      const result = rollbackToV1(configPath);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not migrated from V1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rolls back to V1 backup and keeps rollback snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omos-rollback-success-'));

    try {
      const configPath = join(dir, 'oh-my-opencode-slim.json');
      const currentConfig = {
        preset: 'dynamic',
        presets: { dynamic: {} },
        _migratedFromV1: true,
      };
      const v1Config = {
        preset: 'zen-free',
        presets: { 'zen-free': {} },
      };

      writeJson(configPath, currentConfig);
      writeJson(`${configPath}.v1-backup`, v1Config);

      const result = rollbackToV1(configPath);
      expect(result.success).toBe(true);
      expect(result.rollbackPath).toBeDefined();

      const restored = parseConfig(configPath).config;
      expect(restored?.preset).toBe('zen-free');

      const rollbackPath = result.rollbackPath as string;
      expect(existsSync(rollbackPath)).toBe(true);
      const rollbackSnapshot = JSON.parse(
        readFileSync(rollbackPath, 'utf-8'),
      ) as {
        _migratedFromV1?: boolean;
      };
      expect(rollbackSnapshot._migratedFromV1).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
