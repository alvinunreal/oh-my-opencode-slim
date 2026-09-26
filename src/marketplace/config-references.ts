import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, printParseErrorCode } from 'jsonc-parser';
import {
  prepareJsonConfigWrite,
  publishPreparedJsonConfig,
  restorePreparedJsonConfig,
  withSerializedConfigWrites,
} from '../cli/config-io';
import { findPluginConfigPaths } from '../config/loader';
import { MarketplaceActivationError } from './errors';
import { normalizeMarketplacePackageId } from './ids';

type RecordValue = Record<string, unknown>;

const MARKETPLACE_AGENT_LISTS = [
  'agents',
  'agents_add',
  'agents_remove',
] as const;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConfig(configPath: string, source: string): unknown {
  const errors: Parameters<typeof parse>[1] = [];
  const config = parse(source.replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: true,
  });
  if (errors.length || !isRecord(config)) {
    const detail = errors.length
      ? printParseErrorCode(errors[0].error)
      : 'expected a JSON object';
    throw new Error(`Failed to parse config ${configPath}: ${detail}`);
  }
  return config;
}

function resolvedId(value: string, field: string): string {
  const resolved = value.replace(/\{env:([^}]+)\}/g, (_match, name: string) => {
    if (process.env[name] === undefined) {
      throw new MarketplaceActivationError(
        `Cannot remove marketplace package: environment variable '${name}' referenced by marketplace.${field} is not set`,
      );
    }
    return process.env[name];
  });
  try {
    return normalizeMarketplacePackageId(resolved);
  } catch (error) {
    throw new MarketplaceActivationError(
      `Cannot remove marketplace package: invalid marketplace.${field} package ID (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function removeReferences(config: unknown, packageId: string): unknown {
  if (!isRecord(config) || !isRecord(config.presets)) return config;
  let presetsChanged = false;
  const presets = { ...config.presets };

  for (const [presetName, presetValue] of Object.entries(presets)) {
    if (!isRecord(presetValue)) continue;
    if (
      Object.hasOwn(presetValue, 'marketplace') &&
      !isRecord(presetValue.marketplace)
    ) {
      throw new MarketplaceActivationError(
        `Cannot remove marketplace package: preset '${presetName}' marketplace directives must be an object`,
      );
    }
    if (!isRecord(presetValue.marketplace)) continue;
    let marketplaceChanged = false;
    const marketplace = { ...presetValue.marketplace };
    for (const key of MARKETPLACE_AGENT_LISTS) {
      if (Object.hasOwn(marketplace, key) && !Array.isArray(marketplace[key])) {
        throw new MarketplaceActivationError(
          `Cannot remove marketplace package: marketplace.${key} must be an array of package IDs`,
        );
      }
      const entries = marketplace[key];
      if (!Array.isArray(entries)) continue;
      if (entries.some((entry) => typeof entry !== 'string')) {
        throw new MarketplaceActivationError(
          `Cannot remove marketplace package: marketplace.${key} must contain only package IDs`,
        );
      }
      const filtered = entries.filter(
        (entry) => resolvedId(entry as string, key) !== packageId,
      );
      if (filtered.length === entries.length) continue;
      marketplace[key] = filtered;
      marketplaceChanged = true;
    }
    if (marketplaceChanged) {
      presets[presetName] = { ...presetValue, marketplace };
      presetsChanged = true;
    }
  }

  return presetsChanged ? { ...config, presets } : config;
}

/**
 * Coordinate config-reference cleanup with a durable store mutation.
 * The operation must synchronously signal its commit point and must not
 * re-enter config mutation for any of the leased files.
 */
export function withMarketplaceConfigReferencesRemoved(
  projectDir: string,
  id: string,
  operation: (onCommitted: () => void) => void,
): void {
  const discovered = findPluginConfigPaths(projectDir);
  const configPaths = [discovered.userConfigPath, discovered.projectConfigPath]
    .filter((configPath): configPath is string => configPath !== null)
    .map((configPath) => resolve(configPath));
  const orderedPaths = [...new Set(configPaths)].sort();
  const targetId = normalizeMarketplacePackageId(id);

  let committed = false;
  try {
    withSerializedConfigWrites(orderedPaths, () => {
      const prepared = [];
      for (const configPath of orderedPaths) {
        if (!existsSync(configPath)) continue;
        const original = readFileSync(configPath, 'utf8');
        const config = parseConfig(configPath, original);
        const updated = removeReferences(config, targetId);
        prepared.push(
          prepareJsonConfigWrite(
            configPath,
            original,
            updated as Parameters<typeof prepareJsonConfigWrite>[2],
          ),
        );
      }

      const attempted: typeof prepared = [];
      try {
        for (const write of prepared) {
          if (!write.changed) continue;
          attempted.push(write);
          publishPreparedJsonConfig(write);
        }
        operation(() => {
          committed = true;
        });
      } catch (error) {
        if (committed) throw error;

        const rollbackErrors: Error[] = [];
        for (const write of attempted.reverse()) {
          try {
            restorePreparedJsonConfig(write);
          } catch (rollbackError) {
            rollbackErrors.push(
              new Error(`Failed to restore config ${write.configPath}`, {
                cause: rollbackError,
              }),
            );
          }
        }
        if (rollbackErrors.length) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            `Marketplace config removal for ${targetId} is in doubt; rollback failed`,
          );
        }
        throw error;
      }
    });
  } catch (error) {
    if (committed) {
      throw new Error(
        `Marketplace removal for ${targetId} completed, but finalization failed; config references remain removed`,
        { cause: error },
      );
    }
    throw error;
  }
}
