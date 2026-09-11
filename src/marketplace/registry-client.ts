import { satisfies } from 'semver';
import {
  DEFAULT_MARKETPLACE_REGISTRY_URL,
  MarketplacePackageBundleSchema,
  type MarketplaceRegistryEntry,
  type MarketplaceRegistryIndex,
  parseMarketplaceRegistryIndex,
  parseMarketplaceRegistrySelector,
  resolveMarketplaceRegistryEntry,
  validateMarketplaceRegistryEntry,
} from '../marketplace-contract';
import {
  MarketplaceCompatibilityError,
  MarketplaceRegistryIntegrityError,
  MarketplaceRegistryNotFoundError,
  MarketplaceRegistryProtocolError,
  MarketplaceRegistryUnavailableError,
} from './errors';
import {
  MARKETPLACE_ROLE_CONTRACT_VERSION,
  type MarketplacePackageBundle,
} from './schemas';

export const MARKETPLACE_REGISTRY_INDEX_URL = `${DEFAULT_MARKETPLACE_REGISTRY_URL}index.json`;
export const DEFAULT_MARKETPLACE_REGISTRY_TIMEOUT_MS = 10_000;
export const DEFAULT_MARKETPLACE_REGISTRY_INDEX_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MARKETPLACE_REGISTRY_ARTIFACT_MAX_BYTES = 512 * 1024;

export interface MarketplaceRegistryClientOptions {
  pluginVersion: string;
  roleContractVersion?: string;
  timeoutMs?: number;
  maxIndexBytes?: number;
  maxArtifactBytes?: number;
  fetch?: typeof globalThis.fetch;
}

export interface MarketplaceRegistryDownload {
  bundle: MarketplacePackageBundle;
  entry: MarketplaceRegistryEntry;
  indexUrl: string;
  packageUrl: string;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  url: string,
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new MarketplaceRegistryProtocolError(
      `Registry response exceeds the ${maxBytes}-byte limit: ${url}`,
    );
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new MarketplaceRegistryProtocolError(
        `Registry response exceeds the ${maxBytes}-byte limit: ${url}`,
      );
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new MarketplaceRegistryProtocolError(
          `Registry response exceeds the ${maxBytes}-byte limit: ${url}`,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class MarketplaceRegistryClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxIndexBytes: number;
  private readonly maxArtifactBytes: number;
  private readonly roleContractVersion: string;

  constructor(private readonly options: MarketplaceRegistryClientOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs =
      options.timeoutMs ?? DEFAULT_MARKETPLACE_REGISTRY_TIMEOUT_MS;
    this.maxIndexBytes =
      options.maxIndexBytes ?? DEFAULT_MARKETPLACE_REGISTRY_INDEX_MAX_BYTES;
    this.maxArtifactBytes =
      options.maxArtifactBytes ??
      DEFAULT_MARKETPLACE_REGISTRY_ARTIFACT_MAX_BYTES;
    this.roleContractVersion =
      options.roleContractVersion ?? MARKETPLACE_ROLE_CONTRACT_VERSION;
  }

  async fetchIndex(signal?: AbortSignal): Promise<MarketplaceRegistryIndex> {
    const text = await this.fetchJson(
      MARKETPLACE_REGISTRY_INDEX_URL,
      this.maxIndexBytes,
      signal,
    );
    try {
      return parseMarketplaceRegistryIndex(text);
    } catch (error) {
      throw new MarketplaceRegistryProtocolError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async download(
    selectorText: string,
    minimumVersion?: string,
    signal?: AbortSignal,
  ): Promise<MarketplaceRegistryDownload> {
    if (signal?.aborted) {
      throw new MarketplaceRegistryUnavailableError(
        'Marketplace registry request was cancelled',
      );
    }
    const selector = (() => {
      try {
        return parseMarketplaceRegistrySelector(selectorText);
      } catch (error) {
        throw new MarketplaceRegistryProtocolError(
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
    const index = await this.fetchIndex(signal);
    const matchingId = index.entries.some((entry) => entry.id === selector.id);
    if (!matchingId) {
      throw new MarketplaceRegistryNotFoundError(
        `Marketplace package ${selector.id} was not found in the registry`,
      );
    }
    if (
      selector.version &&
      !index.entries.some(
        (entry) =>
          entry.id === selector.id && entry.version === selector.version,
      )
    ) {
      throw new MarketplaceRegistryNotFoundError(
        `Marketplace package ${selector.id}@${selector.version} was not found in the registry`,
      );
    }
    let entry: MarketplaceRegistryEntry;
    try {
      entry = resolveMarketplaceRegistryEntry(
        index,
        selector,
        {
          pluginVersion: this.options.pluginVersion,
          roleContractVersion: this.roleContractVersion,
        },
        minimumVersion,
      );
    } catch (error) {
      throw new MarketplaceCompatibilityError(
        error instanceof Error ? error.message : String(error),
      );
    }

    const packageUrl = new URL(
      entry.artifactPath,
      DEFAULT_MARKETPLACE_REGISTRY_URL,
    ).href;
    const artifact = await this.fetchJson(
      packageUrl,
      this.maxArtifactBytes,
      signal,
    );
    let bundle: MarketplacePackageBundle;
    try {
      const result = MarketplacePackageBundleSchema.safeParse(artifact);
      if (!result.success) {
        throw new Error(result.error.message);
      }
      bundle = result.data;
      validateMarketplaceRegistryEntry(entry, bundle);
    } catch (error) {
      throw new MarketplaceRegistryIntegrityError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!this.isCompatible(bundle)) {
      throw new MarketplaceCompatibilityError(
        `${bundle.manifest.id}@${bundle.manifest.version} is incompatible with this plugin`,
      );
    }
    if (signal?.aborted) {
      throw new MarketplaceRegistryUnavailableError(
        'Marketplace registry request was cancelled',
      );
    }
    return {
      bundle,
      entry,
      indexUrl: MARKETPLACE_REGISTRY_INDEX_URL,
      packageUrl,
    };
  }

  private isCompatible(bundle: MarketplacePackageBundle): boolean {
    return (
      satisfies(
        this.options.pluginVersion,
        bundle.manifest.compatibility.plugin,
      ) &&
      satisfies(
        this.roleContractVersion,
        bundle.manifest.compatibility.roleContract,
      )
    );
  }

  private async fetchJson(
    url: string,
    maxBytes: number,
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abortExternal = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    externalSignal?.addEventListener('abort', abortExternal, { once: true });
    try {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        throw new MarketplaceRegistryUnavailableError(
          `Registry request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (response.status >= 300 && response.status < 400) {
        throw new MarketplaceRegistryProtocolError(
          `Registry redirects are not permitted: ${url}`,
        );
      }
      if (response.status === 404) {
        throw new MarketplaceRegistryNotFoundError(
          `Registry resource not found: ${url}`,
        );
      }
      if (response.status !== 200) {
        throw new MarketplaceRegistryUnavailableError(
          `Registry returned HTTP ${response.status}: ${url}`,
        );
      }
      const text = await readBoundedBody(response, maxBytes, url);
      if (controller.signal.aborted || externalSignal?.aborted) {
        throw new MarketplaceRegistryUnavailableError(
          `Registry request was cancelled: ${url}`,
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch (error) {
        throw new MarketplaceRegistryProtocolError(
          `Registry returned invalid JSON for ${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } catch (error) {
      if (
        error instanceof MarketplaceRegistryProtocolError ||
        error instanceof MarketplaceRegistryNotFoundError ||
        error instanceof MarketplaceRegistryUnavailableError
      ) {
        throw error;
      }
      throw new MarketplaceRegistryUnavailableError(
        `Registry request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortExternal);
    }
  }
}
