import { readFileSync, realpathSync } from 'node:fs';
import { DEFAULT_MARKETPLACE_REGISTRY_URL } from '../marketplace-contract';
import { readPluginPackageVersion } from '../utils/package-metadata';
import type { MarketplaceCompatibilityOptions } from './compatibility';
import { removeMarketplaceConfigReferences } from './config-references';
import {
  MarketplaceConflictError,
  MarketplaceRegistryNotFoundError,
  MarketplaceRegistryUnavailableError,
  MarketplaceValidationError,
} from './errors';
import { normalizeMarketplacePackageId } from './ids';
import type { MarketplaceRegistryDownload } from './registry-client';
import { MarketplaceRegistryClient } from './registry-client';
import { assertMarketplacePackageNotRetired } from './retirements';
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
  registryClient?: MarketplaceRegistryDownloadClient;
}

export type MarketplaceRegistryDownloadClient = Pick<
  MarketplaceRegistryClient,
  'download'
> &
  Partial<Pick<MarketplaceRegistryClient, 'downloadV3'>>;

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

export class MarketplaceService {
  readonly store: MarketplaceStore;
  readonly projectDir: string;
  readonly registryClient: MarketplaceRegistryDownloadClient;

  constructor(options: MarketplaceServiceOptions = {}) {
    this.store = new MarketplaceStore(options);
    this.projectDir = options.projectDir ?? process.cwd();
    this.registryClient =
      options.registryClient ??
      new MarketplaceRegistryClient({
        pluginVersion:
          options.pluginVersion ?? readPluginPackageVersion() ?? '0.0.0',
      });
  }

  install(
    input: MarketplacePackageBundle,
    source?: MarketplaceSource,
  ): StoredMarketplacePackage {
    const bundle = parseBundle(input);
    assertMarketplacePackageNotRetired(bundle.manifest.id);
    return this.store.install(bundle, source);
  }

  installFile(filePath: string): StoredMarketplacePackage {
    return this.install(
      parseBundleFromFile(filePath),
      sourceForImport(filePath),
    );
  }

  importFile(filePath: string): StoredMarketplacePackage {
    return this.installFile(filePath);
  }

  update(
    input: MarketplacePackageBundle,
    source?: MarketplaceSource,
  ): StoredMarketplacePackage {
    const bundle = parseBundle(input);
    assertMarketplacePackageNotRetired(bundle.manifest.id);
    return this.store.update(bundle, source);
  }

  updateFile(filePath: string): StoredMarketplacePackage {
    return this.update(
      parseBundleFromFile(filePath),
      sourceForImport(filePath),
    );
  }

  importFileUpdate(filePath: string): StoredMarketplacePackage {
    return this.updateFile(filePath);
  }

  async installRemote(
    selector: string,
    signal?: AbortSignal,
  ): Promise<StoredMarketplacePackage> {
    const selectorId = selector.trim().split('@', 1)[0].toLowerCase();
    assertMarketplacePackageNotRetired(selectorId);
    const downloaded = await this.downloadRemoteWithV3Fallback(
      selector,
      undefined,
      signal,
    );
    if (signal?.aborted) {
      throw new MarketplaceRegistryUnavailableError(
        'Marketplace install was cancelled before local mutation',
      );
    }
    return this.store.install(downloaded.bundle, {
      kind: 'registry',
      registry: downloaded.registry ?? DEFAULT_MARKETPLACE_REGISTRY_URL,
      indexUrl: downloaded.indexUrl,
      packageUrl: downloaded.packageUrl,
    });
  }

  private async downloadRemoteWithV3Fallback(
    selector: string,
    minimumVersion?: string,
    signal?: AbortSignal,
  ): Promise<MarketplaceRegistryDownload> {
    if (this.registryClient.downloadV3) {
      try {
        return await this.registryClient.downloadV3(
          selector,
          minimumVersion,
          signal,
        );
      } catch (error) {
        if (
          !(error instanceof MarketplaceRegistryUnavailableError) &&
          !(error instanceof MarketplaceRegistryNotFoundError)
        ) {
          throw error;
        }
      }
    }
    return this.registryClient.download(selector, minimumVersion, signal);
  }

  async updateRemote(
    id: string,
    signal?: AbortSignal,
  ): Promise<StoredMarketplacePackage> {
    const normalizedId = normalizeMarketplacePackageId(id);
    assertMarketplacePackageNotRetired(normalizedId);
    if (!this.store.getLockfile().packages[normalizedId]) {
      throw new MarketplaceConflictError(
        `${normalizedId} is not installed; updates require an existing package`,
      );
    }
    const current = this.store.show(normalizedId);
    const downloaded = await this.downloadRemoteWithV3Fallback(
      current.manifest.id,
      current.manifest.version,
      signal,
    );
    if (signal?.aborted) {
      throw new MarketplaceRegistryUnavailableError(
        'Marketplace update was cancelled before local mutation',
      );
    }
    return this.store.update(downloaded.bundle, {
      kind: 'registry',
      registry: downloaded.registry ?? DEFAULT_MARKETPLACE_REGISTRY_URL,
      indexUrl: downloaded.indexUrl,
      packageUrl: downloaded.packageUrl,
    });
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

  remove(id: string): void {
    const normalizedId = normalizeMarketplacePackageId(id);
    removeMarketplaceConfigReferences(this.projectDir, normalizedId);
    this.store.remove(normalizedId);
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
