import { readFileSync, realpathSync } from 'node:fs';
import type { MarketplaceCompatibilityOptions } from './compatibility';
import {
  type MarketplaceConfigReference,
  readMarketplaceConfigReferences,
} from './config-references';
import {
  MarketplaceActivationReferenceError,
  MarketplaceValidationError,
} from './errors';
import { normalizeMarketplacePackageId } from './ids';
import {
  type MarketplacePackageBundle,
  MarketplacePackageBundleSchema,
  MarketplacePackageManifestSchema,
  type MarketplaceSource,
} from './schemas';
import {
  MarketplaceStore,
  type MarketplaceStoreOptions,
  type MarketplaceVerification,
  type StoredMarketplacePackage,
} from './store';

export interface MarketplaceServiceOptions
  extends MarketplaceStoreOptions,
    MarketplaceCompatibilityOptions {
  projectDir?: string;
}

export interface MarketplaceRemoveOptions {
  force?: boolean;
}

function parseBundle(value: unknown): MarketplacePackageBundle {
  const candidate =
    typeof value === 'object' && value !== null && 'manifest' in value
      ? value
      : { manifest: value };
  const withDefaults =
    'manifest' in candidate ? candidate : { manifest: candidate };
  const result = MarketplacePackageBundleSchema.safeParse(withDefaults);
  if (!result.success) {
    throw new MarketplaceValidationError(result.error.message);
  }
  return result.data;
}

function sourceForImport(filePath: string): MarketplaceSource {
  return { kind: 'local', path: realpathSync(filePath) };
}

function referenceMessage(
  packageId: string,
  references: MarketplaceConfigReference[],
): string {
  const locations = references
    .filter((reference) => reference.packageId === packageId)
    .map(
      (reference) =>
        `${reference.configPath} (preset ${reference.presetName}, ${reference.target})`,
    );
  return `Cannot remove referenced package ${packageId}: ${locations.join('; ')}. Deactivate it first or use --force.`;
}

export class MarketplaceService {
  readonly store: MarketplaceStore;
  readonly projectDir: string;

  constructor(options: MarketplaceServiceOptions = {}) {
    this.store = new MarketplaceStore(options);
    this.projectDir = options.projectDir ?? process.cwd();
  }

  install(
    input: MarketplacePackageBundle,
    source?: MarketplaceSource,
  ): StoredMarketplacePackage {
    const bundle = parseBundle(input);
    return this.store.install(bundle, source);
  }

  installFile(filePath: string): StoredMarketplacePackage {
    return this.install(
      parseBundleFromFile(filePath),
      sourceForImport(filePath),
    );
  }

  update(
    input: MarketplacePackageBundle,
    source?: MarketplaceSource,
  ): StoredMarketplacePackage {
    const bundle = parseBundle(input);
    return this.store.update(bundle, source);
  }

  updateFile(filePath: string): StoredMarketplacePackage {
    return this.update(
      parseBundleFromFile(filePath),
      sourceForImport(filePath),
    );
  }

  list(): StoredMarketplacePackage[] {
    return this.store.list();
  }

  show(id: string): StoredMarketplacePackage {
    return this.store.show(normalizeMarketplacePackageId(id));
  }

  verify(id?: string): MarketplaceVerification[] {
    if (id) return [this.store.verify(normalizeMarketplacePackageId(id))];
    return this.store.verifyAll();
  }

  remove(id: string, options: MarketplaceRemoveOptions = {}): void {
    const normalizedId = normalizeMarketplacePackageId(id);
    this.store.remove(
      normalizedId,
      options.force
        ? undefined
        : () => {
            const references = readMarketplaceConfigReferences(this.projectDir);
            if (
              references.some(
                (reference) => reference.packageId === normalizedId,
              )
            ) {
              throw new MarketplaceActivationReferenceError(
                referenceMessage(normalizedId, references),
              );
            }
          },
    );
  }
}

export function parseBundleFromFile(
  filePath: string,
): MarketplacePackageBundle {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new MarketplaceValidationError(
      `Cannot read package file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseBundle(value);
}

export function validateMarketplaceManifest(value: unknown) {
  const result = MarketplacePackageManifestSchema.safeParse(value);
  if (!result.success) {
    throw new MarketplaceValidationError(result.error.message);
  }
  return result.data;
}
