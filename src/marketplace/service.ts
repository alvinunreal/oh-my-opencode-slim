import { readFileSync, realpathSync } from 'node:fs';
import { BUILD_VERSION } from '../generated/build-info.js';
import {
  DEFAULT_MARKETPLACE_REGISTRY_URL,
  MarketplacePackageBundleSchema,
  MarketplacePackageManifestSchema,
} from '../marketplace-contract/index.js';
import { withMarketplaceConfigReferencesRemoved } from './config-references.js';
import {
  MarketplaceCompatibilityError,
  MarketplaceRegistryNotFoundError,
  MarketplaceRegistryUnavailableError,
  MarketplaceValidationError,
} from './errors.js';
import { normalizeMarketplacePackageId } from './ids.js';
import type { MarketplaceRegistryDownload } from './registry-client.js';
import { MarketplaceRegistryClient } from './registry-client.js';
import type { MarketplacePackageBundle } from './schemas.js';
import {
  MarketplaceStore,
  type MarketplaceStoreOptions,
  type MarketplaceVerification,
  type StoredMarketplacePackage,
} from './store.js';
import type { MarketplaceSource } from './store-schemas.js';

export interface MarketplaceServiceOptions
  extends Omit<MarketplaceStoreOptions, 'pluginVersion'> {
  pluginVersion?: string;
  projectDir?: string;
  registryClient?: MarketplaceRegistryDownloadClient;
}

export type MarketplaceRegistryDownloadClient = Pick<
  MarketplaceRegistryClient,
  'download'
> &
  Partial<Pick<MarketplaceRegistryClient, 'downloadV3'>>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseBundle(value: unknown): MarketplacePackageBundle {
  const candidate =
    typeof value === 'object' && value !== null && 'manifest' in value
      ? value
      : { manifest: value };
  const parsed = MarketplacePackageBundleSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new MarketplaceValidationError(parsed.error.message);
  }
  return parsed.data;
}

function sourceForImport(filePath: string): MarketplaceSource {
  try {
    return { kind: 'local', path: realpathSync(filePath) };
  } catch (error) {
    throw new MarketplaceValidationError(
      `Cannot resolve package file ${filePath}: ${errorMessage(error)}`,
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
      `Cannot read package file ${filePath}: ${errorMessage(error)}`,
    );
  }
  return parseBundle(value);
}

export function validateMarketplaceManifest(value: unknown) {
  const parsed = MarketplacePackageManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new MarketplaceValidationError(parsed.error.message);
  }
  return parsed.data;
}

export class MarketplaceService {
  readonly store: MarketplaceStore;
  readonly projectDir: string;
  readonly registryClient: MarketplaceRegistryDownloadClient;

  constructor(options: MarketplaceServiceOptions = {}) {
    const pluginVersion = options.pluginVersion ?? BUILD_VERSION;
    this.store = new MarketplaceStore({ ...options, pluginVersion });
    this.projectDir = options.projectDir ?? process.cwd();
    this.registryClient =
      options.registryClient ??
      new MarketplaceRegistryClient({ pluginVersion });
  }

  install(
    input: MarketplacePackageBundle,
    source?: MarketplaceSource,
  ): StoredMarketplacePackage {
    return this.store.install(parseBundle(input), source);
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
    return this.store.update(parseBundle(input), source);
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
    const downloaded = await this.downloadRemoteWithV3Fallback(
      selector,
      undefined,
      signal,
    );
    this.assertNotAborted(signal, 'install');
    return this.store.install(
      downloaded.bundle,
      this.registrySource(downloaded),
    );
  }

  async updateRemote(
    id: string,
    signal?: AbortSignal,
  ): Promise<StoredMarketplacePackage> {
    const normalizedId = normalizeMarketplacePackageId(id);
    const current = this.store.show(normalizedId);
    const downloaded = await this.downloadRemoteWithV3Fallback(
      current.manifest.id,
      current.manifest.version,
      signal,
    );
    this.assertNotAborted(signal, 'update');
    return this.store.update(
      downloaded.bundle,
      this.registrySource(downloaded),
    );
  }

  list(): StoredMarketplacePackage[] {
    return this.store.list();
  }

  show(id: string): StoredMarketplacePackage {
    return this.store.show(normalizeMarketplacePackageId(id));
  }

  verify(id?: string): MarketplaceVerification[] {
    return id
      ? [this.store.verify(normalizeMarketplacePackageId(id))]
      : this.store.verifyAll();
  }

  remove(id: string): void {
    const normalizedId = normalizeMarketplacePackageId(id);
    withMarketplaceConfigReferencesRemoved(
      this.projectDir,
      normalizedId,
      (onCommitted) => this.store.remove(normalizedId, { onCommitted }),
    );
  }

  private registrySource(
    downloaded: MarketplaceRegistryDownload,
  ): MarketplaceSource {
    return {
      kind: 'registry',
      registry: downloaded.registry ?? DEFAULT_MARKETPLACE_REGISTRY_URL,
      indexUrl: downloaded.indexUrl,
      packageUrl: downloaded.packageUrl,
    };
  }

  private assertNotAborted(
    signal: AbortSignal | undefined,
    action: string,
  ): void {
    if (signal?.aborted) {
      throw new MarketplaceRegistryUnavailableError(
        `Marketplace ${action} was cancelled before local mutation`,
      );
    }
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
          !(error instanceof MarketplaceRegistryNotFoundError) &&
          !(error instanceof MarketplaceCompatibilityError)
        ) {
          throw error;
        }
        if (signal?.aborted) throw error;
      }
    }
    return this.registryClient.download(selector, minimumVersion, signal);
  }
}
