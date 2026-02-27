import { copyFileSync, existsSync } from 'node:fs';
import { parseConfig, writeConfig } from './config-io';
import type { OpenCodeConfig } from './types';

export interface RollbackToV1Result {
  success: boolean;
  error?: string;
  rollbackPath?: string;
  backupPath?: string;
}

export interface BackupV1Result {
  success: boolean;
  backupPath: string;
  created: boolean;
  skipped: boolean;
  error?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLikelyV1Config(config: OpenCodeConfig): boolean {
  if (!isObject(config)) return false;
  return (
    typeof config.preset === 'string' &&
    typeof config.presets === 'object' &&
    config.presets !== null
  );
}

export function backupV1ConfigBeforeMigration(
  configPath: string,
): BackupV1Result {
  const backupPath = `${configPath}.v1-backup`;

  if (!existsSync(configPath)) {
    return {
      success: true,
      backupPath,
      created: false,
      skipped: true,
    };
  }

  if (existsSync(backupPath)) {
    return {
      success: true,
      backupPath,
      created: false,
      skipped: true,
    };
  }

  try {
    copyFileSync(configPath, backupPath);
    return {
      success: true,
      backupPath,
      created: true,
      skipped: false,
    };
  } catch (error) {
    return {
      success: false,
      backupPath,
      created: false,
      skipped: false,
      error: String(error),
    };
  }
}

export function rollbackToV1(configPath: string): RollbackToV1Result {
  const backupPath = `${configPath}.v1-backup`;

  const { config: currentConfig, error: currentError } =
    parseConfig(configPath);
  if (currentError) {
    return {
      success: false,
      backupPath,
      error: `Failed to read current config: ${currentError}`,
    };
  }
  if (!currentConfig) {
    return {
      success: false,
      backupPath,
      error: 'Current config not found.',
    };
  }

  if (!isObject(currentConfig) || currentConfig._migratedFromV1 !== true) {
    return {
      success: false,
      backupPath,
      error: 'Config was not migrated from V1.',
    };
  }

  if (!existsSync(backupPath)) {
    return {
      success: false,
      backupPath,
      error: 'V1 backup not found.',
    };
  }

  const { config: v1BackupConfig, error: backupError } =
    parseConfig(backupPath);
  if (backupError) {
    return {
      success: false,
      backupPath,
      error: `Failed to read V1 backup: ${backupError}`,
    };
  }
  if (!v1BackupConfig || !isLikelyV1Config(v1BackupConfig)) {
    return {
      success: false,
      backupPath,
      error: 'V1 backup is invalid.',
    };
  }

  const rollbackPath = `${configPath}.rollback-${Date.now()}`;

  try {
    writeConfig(rollbackPath, currentConfig);
    writeConfig(configPath, v1BackupConfig);
    return {
      success: true,
      backupPath,
      rollbackPath,
    };
  } catch (error) {
    return {
      success: false,
      backupPath,
      rollbackPath,
      error: `Rollback failed: ${String(error)}`,
    };
  }
}
