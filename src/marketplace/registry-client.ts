import {
  DEFAULT_MARKETPLACE_REGISTRY_URL,
  DEFAULT_MARKETPLACE_REGISTRY_V3_URL,
  MarketplacePackageBundleV2Schema,
  MarketplacePackageBundleV3Schema,
  type MarketplaceRegistryEntry,
  type MarketplaceRegistryEntryV3,
  type MarketplaceRegistryIndex,
  type MarketplaceRegistryIndexV3,
  parseMarketplaceRegistryIndex,
  parseMarketplaceRegistryIndexV3,
  parseMarketplaceRegistrySelector,
  resolveMarketplaceRegistryEntry,
  resolveMarketplaceRegistryEntryV3,
  validateMarketplaceRegistryEntry,
  validateMarketplaceRegistryEntryV3,
} from '../marketplace-contract/index.js';
import { satisfiesPluginCompatibility } from './compatibility.js';
import {
  MarketplaceCompatibilityError,
  MarketplaceRegistryIntegrityError,
  MarketplaceRegistryNotFoundError,
  MarketplaceRegistryProtocolError,
  MarketplaceRegistryUnavailableError,
} from './errors.js';
import type { MarketplacePackageBundle } from './schemas.js';

export const MARKETPLACE_REGISTRY_INDEX_URL = `${DEFAULT_MARKETPLACE_REGISTRY_URL}index.json`;
export const MARKETPLACE_REGISTRY_V2_INDEX_URL = MARKETPLACE_REGISTRY_INDEX_URL;
export const MARKETPLACE_REGISTRY_V3_INDEX_URL = `${DEFAULT_MARKETPLACE_REGISTRY_V3_URL}index.json`;
export const DEFAULT_MARKETPLACE_REGISTRY_TIMEOUT_MS = 10_000;
export const DEFAULT_MARKETPLACE_REGISTRY_INDEX_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MARKETPLACE_REGISTRY_ARTIFACT_MAX_BYTES = 512 * 1024;

function cancelResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => {});
  } catch {
    // Cancellation is best-effort; preserve the error that rejected the response.
  }
}

export interface MarketplaceRegistryClientOptions {
  pluginVersion: string;
  timeoutMs?: number;
  maxIndexBytes?: number;
  maxArtifactBytes?: number;
  fetch?: typeof globalThis.fetch;
}

export interface MarketplaceRegistryDownload {
  bundle: MarketplacePackageBundle;
  entry: MarketplaceRegistryEntry | MarketplaceRegistryEntryV3;
  indexUrl: string;
  packageUrl: string;
  registry?: string;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  url: string,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      cancelResponseBody(response);
      throw new MarketplaceRegistryProtocolError(
        `Registry response exceeds the ${maxBytes}-byte limit: ${url}`,
      );
    }
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
      if (signal.aborted) {
        throw signal.reason ?? new Error('Registry request was cancelled');
      }

      let abortRead: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        abortRead = () => {
          try {
            const cancellation = reader.cancel();
            void cancellation.catch(() => {});
          } catch {
            // Cancellation is best-effort; preserve the abort reason.
          }
          reject(signal.reason ?? new Error('Registry request was cancelled'));
        };
        signal.addEventListener('abort', abortRead, { once: true });
      });
      try {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          try {
            const cancellation = reader.cancel();
            void cancellation.catch(() => {});
          } catch {
            // Preserve the oversized-body protocol error.
          }
          throw new MarketplaceRegistryProtocolError(
            `Registry response exceeds the ${maxBytes}-byte limit: ${url}`,
          );
        }
        chunks.push(value);
      } finally {
        if (abortRead) signal.removeEventListener('abort', abortRead);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending, uncooperative read can prevent releasing its lock.
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MarketplaceRegistryClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxIndexBytes: number;
  private readonly maxArtifactBytes: number;

  constructor(private readonly options: MarketplaceRegistryClientOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs =
      options.timeoutMs ?? DEFAULT_MARKETPLACE_REGISTRY_TIMEOUT_MS;
    this.maxIndexBytes =
      options.maxIndexBytes ?? DEFAULT_MARKETPLACE_REGISTRY_INDEX_MAX_BYTES;
    this.maxArtifactBytes =
      options.maxArtifactBytes ??
      DEFAULT_MARKETPLACE_REGISTRY_ARTIFACT_MAX_BYTES;
    if (
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      !Number.isSafeInteger(this.maxIndexBytes) ||
      this.maxIndexBytes <= 0 ||
      !Number.isSafeInteger(this.maxArtifactBytes) ||
      this.maxArtifactBytes <= 0
    ) {
      throw new RangeError('Registry limits must be positive finite integers');
    }
  }

  async fetchIndex(signal?: AbortSignal): Promise<MarketplaceRegistryIndex> {
    const value = await this.fetchJson(
      MARKETPLACE_REGISTRY_INDEX_URL,
      this.maxIndexBytes,
      signal,
    );
    try {
      return parseMarketplaceRegistryIndex(value);
    } catch (error) {
      throw new MarketplaceRegistryProtocolError(errorMessage(error));
    }
  }

  download(
    selectorText: string,
    minimumVersion?: string,
    signal?: AbortSignal,
  ): Promise<MarketplaceRegistryDownload> {
    return this.downloadFromRegistry(
      selectorText,
      minimumVersion,
      signal,
      false,
    );
  }

  downloadV3(
    selectorText: string,
    minimumVersion?: string,
    signal?: AbortSignal,
  ): Promise<MarketplaceRegistryDownload> {
    return this.downloadFromRegistry(
      selectorText,
      minimumVersion,
      signal,
      true,
    );
  }

  private async downloadFromRegistry(
    selectorText: string,
    minimumVersion: string | undefined,
    signal: AbortSignal | undefined,
    v3: boolean,
  ): Promise<MarketplaceRegistryDownload> {
    if (signal?.aborted) {
      throw new MarketplaceRegistryUnavailableError(
        'Marketplace registry request was cancelled',
      );
    }

    let selector: ReturnType<typeof parseMarketplaceRegistrySelector>;
    try {
      selector = parseMarketplaceRegistrySelector(selectorText);
    } catch (error) {
      throw new MarketplaceRegistryProtocolError(errorMessage(error));
    }

    const indexUrl = v3
      ? MARKETPLACE_REGISTRY_V3_INDEX_URL
      : MARKETPLACE_REGISTRY_INDEX_URL;
    const registry = v3
      ? DEFAULT_MARKETPLACE_REGISTRY_V3_URL
      : DEFAULT_MARKETPLACE_REGISTRY_URL;
    const indexValue = await this.fetchJson(
      indexUrl,
      this.maxIndexBytes,
      signal,
    );

    let index: MarketplaceRegistryIndex | MarketplaceRegistryIndexV3;
    try {
      index = v3
        ? parseMarketplaceRegistryIndexV3(indexValue)
        : parseMarketplaceRegistryIndex(indexValue);
    } catch (error) {
      throw new MarketplaceRegistryProtocolError(errorMessage(error));
    }

    if (!index.entries.some((entry) => entry.id === selector.id)) {
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

    let entry: MarketplaceRegistryEntry | MarketplaceRegistryEntryV3;
    try {
      entry = v3
        ? resolveMarketplaceRegistryEntryV3(
            index as MarketplaceRegistryIndexV3,
            selector,
            { pluginVersion: this.options.pluginVersion },
            minimumVersion,
          )
        : resolveMarketplaceRegistryEntry(
            index as MarketplaceRegistryIndex,
            selector,
            { pluginVersion: this.options.pluginVersion },
            minimumVersion,
          );
    } catch (error) {
      throw new MarketplaceCompatibilityError(errorMessage(error));
    }

    const packageUrl = new URL(entry.artifactPath, registry).href;
    const artifact = await this.fetchJson(
      packageUrl,
      this.maxArtifactBytes,
      signal,
    );
    let bundle: MarketplacePackageBundle;
    try {
      if (v3) {
        const parsed = MarketplacePackageBundleV3Schema.safeParse(artifact);
        if (!parsed.success) throw new Error(parsed.error.message);
        bundle = parsed.data;
        validateMarketplaceRegistryEntryV3(
          entry as MarketplaceRegistryEntryV3,
          bundle,
        );
      } else {
        const parsed = MarketplacePackageBundleV2Schema.safeParse(artifact);
        if (!parsed.success) throw new Error(parsed.error.message);
        bundle = parsed.data;
        validateMarketplaceRegistryEntry(
          entry as MarketplaceRegistryEntry,
          bundle,
        );
      }
    } catch (error) {
      throw new MarketplaceRegistryIntegrityError(errorMessage(error));
    }

    if (
      !satisfiesPluginCompatibility(
        this.options.pluginVersion,
        bundle.manifest.compatibility.plugin,
      )
    ) {
      throw new MarketplaceCompatibilityError(
        `${bundle.manifest.id}@${bundle.manifest.version} is incompatible with this plugin`,
      );
    }
    if (signal?.aborted) {
      throw new MarketplaceRegistryUnavailableError(
        'Marketplace registry request was cancelled',
      );
    }

    return { bundle, entry, indexUrl, packageUrl, registry };
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
          `Registry request failed for ${url}: ${errorMessage(error)}`,
        );
      }

      if (response.status >= 300 && response.status < 400) {
        cancelResponseBody(response);
        throw new MarketplaceRegistryProtocolError(
          `Registry redirects are not permitted: ${url}`,
        );
      }
      if (response.status === 404) {
        cancelResponseBody(response);
        throw new MarketplaceRegistryNotFoundError(
          `Registry resource not found: ${url}`,
        );
      }
      if (response.status !== 200) {
        cancelResponseBody(response);
        throw new MarketplaceRegistryUnavailableError(
          `Registry returned HTTP ${response.status}: ${url}`,
        );
      }

      const text = await readBoundedBody(
        response,
        maxBytes,
        url,
        controller.signal,
      );
      if (controller.signal.aborted || externalSignal?.aborted) {
        throw new MarketplaceRegistryUnavailableError(
          `Registry request was cancelled: ${url}`,
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch (error) {
        throw new MarketplaceRegistryProtocolError(
          `Registry returned invalid JSON for ${url}: ${errorMessage(error)}`,
        );
      }
    } catch (error) {
      if (externalSignal?.aborted) {
        throw new MarketplaceRegistryUnavailableError(
          `Registry request was cancelled: ${url}`,
        );
      }
      if (
        error instanceof MarketplaceRegistryProtocolError ||
        error instanceof MarketplaceRegistryNotFoundError ||
        error instanceof MarketplaceRegistryUnavailableError
      ) {
        throw error;
      }
      throw new MarketplaceRegistryUnavailableError(
        `Registry request failed for ${url}: ${errorMessage(error)}`,
      );
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortExternal);
    }
  }
}
