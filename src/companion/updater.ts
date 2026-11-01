import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CompanionConfig } from '../config/schema';
import { getErrorMessage } from '../hooks/apply-patch/errors';
import { crossSpawn } from '../utils/compat';
import { log } from '../utils/logger';

export interface CompanionManifest {
  version: string;
  tag: string;
  repo: string;
  checksums?: Record<string, string>;
}

interface CompanionInstallMetadata {
  version: string;
  tag: string;
  target: string;
  installedAt: string;
  archiveName: string;
  checksum?: string;
}

export type CompanionUpdateResult =
  | { status: 'installed'; binaryPath: string; version: string }
  | { status: 'current'; binaryPath: string; version: string }
  | { status: 'skipped'; reason: string; binaryPath?: string }
  | { status: 'failed'; error: string; binaryPath: string };

const DOWNLOAD_TIMEOUT_MS = 30_000;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 5 * 60_000;
const FIRST_METADATA_VERSION = '0.1.2';
type StartupWait = { signal: AbortSignal; acquired: boolean };
const startupInstalls = new Map<
  string,
  {
    promise: Promise<CompanionUpdateResult>;
    controller: AbortController;
    wait: StartupWait;
    consumers: number;
  }
>();

export const COMPANION_MANIFEST: CompanionManifest = {
  version: '0.1.9',
  tag: 'companion-v0.1.9',
  repo: 'alvinunreal/oh-my-opencode-companion',
  checksums: {
    'oh-my-opencode-slim-companion-v0.1.9-aarch64-apple-darwin.tar.gz':
      'd41b1b8789218252e3a88acf55221476a10f3dc83cf3c2f57ad360afcc6b7ed4',
    'oh-my-opencode-slim-companion-v0.1.9-aarch64-unknown-linux-gnu.tar.gz':
      '175a9b0518d1e85469f6af5139f5ca0fa2d68fdf047cdbab4089283f9ee38fbe',
    'oh-my-opencode-slim-companion-v0.1.9-x86_64-apple-darwin.tar.gz':
      '229bc00f5082436cd6faad4a4af028ec7ae4f4a3fc6544c1cad157b857c5a474',
    'oh-my-opencode-slim-companion-v0.1.9-x86_64-pc-windows-msvc.zip':
      '36324bcc387b7926f964fbc423503957bf9480f7bbde1fe6dd05c5c8a2d362a3',
    'oh-my-opencode-slim-companion-v0.1.9-x86_64-unknown-linux-gnu.tar.gz':
      '7d4ad80a2005fd943dc016a85fbf50c297bd247eb7d4d15c6512143bb15e5fab',
  },
};

export function getCompanionTarget(): string | null {
  const p = process.platform;
  const a = process.arch;
  if (p === 'darwin') {
    if (a === 'arm64') return 'aarch64-apple-darwin';
    if (a === 'x64') return 'x86_64-apple-darwin';
  } else if (p === 'linux') {
    if (a === 'x64') return 'x86_64-unknown-linux-gnu';
    if (a === 'arm64') return 'aarch64-unknown-linux-gnu';
  } else if (p === 'win32') {
    if (a === 'x64') return 'x86_64-pc-windows-msvc';
  }
  return null;
}

export function getCompanionBinaryPath(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base =
    xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), '.local', 'share');
  return path.join(
    base,
    'opencode',
    'storage',
    'oh-my-opencode-slim',
    'bin',
    platform() === 'win32'
      ? 'oh-my-opencode-slim-companion.exe'
      : 'oh-my-opencode-slim-companion',
  );
}

export function loadCompanionManifestFromPackageRoot(
  packageRoot: string,
): CompanionManifest | null {
  const manifestPath = path.join(
    packageRoot,
    'src',
    'companion',
    'companion-manifest.json',
  );
  try {
    const parsed = JSON.parse(
      readFileSync(manifestPath, 'utf8'),
    ) as Partial<CompanionManifest>;
    if (parsed.version && parsed.tag && parsed.repo) {
      return {
        version: parsed.version,
        tag: parsed.tag,
        repo: parsed.repo,
        checksums: parsed.checksums,
      };
    }
  } catch (err) {
    log('[updater] manifest read failed', String(err));
  }
  return null;
}

export async function ensureCompanionVersion(
  options: {
    config?: CompanionConfig;
    manifest?: CompanionManifest;
    dryRun?: boolean;
    downloadTimeoutMs?: number;
    lockTimeoutMs?: number;
    lockStaleMs?: number;
  },
  startupWait?: StartupWait,
): Promise<CompanionUpdateResult> {
  const { config, dryRun = false } = options;
  const manifest = options.manifest ?? COMPANION_MANIFEST;
  const binaryPath = getCompanionBinaryPath();

  if (config?.enabled !== true) {
    return { status: 'skipped', reason: 'disabled', binaryPath };
  }

  if (config.binaryPath?.trim()) {
    return { status: 'skipped', reason: 'custom-binary', binaryPath };
  }

  const target = getCompanionTarget();
  if (!target) {
    return {
      status: 'failed',
      binaryPath,
      error: `Unsupported platform/architecture: ${process.platform} ${process.arch}`,
    };
  }

  const current = readInstallMetadata(binaryPath);
  if (
    existsSync(binaryPath) &&
    !current &&
    manifest.version === FIRST_METADATA_VERSION
  ) {
    const archiveName = companionArchiveName(manifest.version, target);
    writeInstallMetadata(binaryPath, {
      version: manifest.version,
      tag: manifest.tag,
      target,
      installedAt: new Date().toISOString(),
      archiveName,
      checksum: manifest.checksums?.[archiveName],
    });
    return { status: 'current', binaryPath, version: manifest.version };
  }

  if (
    existsSync(binaryPath) &&
    current?.target === target &&
    compareSemver(current.version, manifest.version) >= 0 &&
    (process.platform !== 'win32' || dryRun)
  ) {
    return { status: 'current', binaryPath, version: current.version };
  }

  if (dryRun) {
    return { status: 'installed', binaryPath, version: manifest.version };
  }

  return withCompanionInstallLock(
    binaryPath,
    options.lockTimeoutMs,
    options.lockStaleMs,
    async () => {
      if (startupWait) startupWait.acquired = true;
      if (process.platform === 'win32' && existsSync(binaryPath)) {
        const prefix = `${path.basename(binaryPath)}.old-`;
        for (const name of readdirSync(path.dirname(binaryPath))) {
          if (
            !name.startsWith(prefix) ||
            !/^[\da-f-]{36}$/i.test(name.slice(prefix.length))
          )
            continue;
          try {
            rmSync(path.join(path.dirname(binaryPath), name), { force: true });
          } catch (err) {
            log('[companion] old executable cleanup deferred', String(err));
          }
        }
      }
      const lockedCurrent = readInstallMetadata(binaryPath);
      if (
        existsSync(binaryPath) &&
        !lockedCurrent &&
        manifest.version === FIRST_METADATA_VERSION
      ) {
        const archiveName = companionArchiveName(manifest.version, target);
        writeInstallMetadata(binaryPath, {
          version: manifest.version,
          tag: manifest.tag,
          target,
          installedAt: new Date().toISOString(),
          archiveName,
          checksum: manifest.checksums?.[archiveName],
        });
        return { status: 'current', binaryPath, version: manifest.version };
      }

      if (
        existsSync(binaryPath) &&
        lockedCurrent?.target === target &&
        compareSemver(lockedCurrent.version, manifest.version) >= 0
      ) {
        return {
          status: 'current',
          binaryPath,
          version: lockedCurrent.version,
        };
      }

      return installCompanionArchive(
        binaryPath,
        target,
        manifest,
        options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS,
      );
    },
    startupWait?.signal,
  );
}

export function ensureCompanionVersionForStartup(
  config: CompanionConfig | undefined,
  signal: AbortSignal,
): Promise<CompanionUpdateResult> {
  const binaryPath = getCompanionBinaryPath();
  if (signal.aborted)
    return Promise.resolve({
      status: 'skipped',
      reason: 'disposed',
      binaryPath,
    });
  let install = startupInstalls.get(binaryPath);
  if (!install) {
    const controller = new AbortController();
    const wait: StartupWait = { signal: controller.signal, acquired: false };
    const promise: Promise<CompanionUpdateResult> = ensureCompanionVersion(
      {
        config,
        // Startup is asynchronous, so a crashed install lock can expire.
        lockTimeoutMs: STALE_LOCK_MS + LOCK_TIMEOUT_MS,
      },
      wait,
    ).finally(() => {
      if (startupInstalls.get(binaryPath)?.promise === promise)
        startupInstalls.delete(binaryPath);
    });
    install = { promise, controller, wait, consumers: 0 };
    startupInstalls.set(binaryPath, install);
  }
  const current = install;
  current.consumers++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', release);
    current.consumers--;
    // An acquired installation remains available to the next generation.
    if (current.consumers === 0 && !current.wait.acquired) {
      if (startupInstalls.get(binaryPath) === current)
        startupInstalls.delete(binaryPath);
      current.controller.abort();
    }
  };
  signal.addEventListener('abort', release, { once: true });
  void current.promise.then(release, release);
  return current.promise;
}

async function installCompanionArchive(
  finalBinaryPath: string,
  target: string,
  manifest: CompanionManifest,
  downloadTimeoutMs: number,
): Promise<CompanionUpdateResult> {
  const isWindows = process.platform === 'win32';
  const archiveName = companionArchiveName(manifest.version, target, isWindows);
  const downloadUrl = `https://github.com/${manifest.repo}/releases/download/${manifest.tag}/${archiveName}`;
  const expectedChecksum = manifest.checksums?.[archiveName];
  if (!expectedChecksum) {
    return {
      status: 'failed',
      binaryPath: finalBinaryPath,
      error: `Missing SHA256 checksum for companion archive: ${archiveName}`,
    };
  }

  let buffer: ArrayBuffer;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), downloadTimeoutMs);
  try {
    const res = await fetch(downloadUrl, { signal: controller.signal });
    if (!res.ok) {
      return {
        status: 'failed',
        binaryPath: finalBinaryPath,
        error: `Failed to download companion binary (HTTP ${res.status}): ${res.statusText}`,
      };
    }
    buffer = await res.arrayBuffer();
  } catch (err) {
    return {
      status: 'failed',
      binaryPath: finalBinaryPath,
      error: `Failed to fetch companion archive: ${getErrorMessage(err)}`,
    };
  } finally {
    clearTimeout(timeout);
  }

  const checksum = createHash('sha256')
    .update(Buffer.from(buffer))
    .digest('hex');
  if (checksum !== expectedChecksum) {
    return {
      status: 'failed',
      binaryPath: finalBinaryPath,
      error: 'Companion archive checksum mismatch',
    };
  }

  let tempDir = '';
  try {
    tempDir = mkdtempSync(path.join(tmpdir(), 'companion-install-'));
    const archivePath = path.join(tempDir, archiveName);
    writeFileSync(archivePath, Buffer.from(buffer));

    const extractedDir = path.join(tempDir, 'extracted');
    mkdirSync(extractedDir, { recursive: true });

    if (isWindows) {
      const { extractZip } = await import('../utils/zip-extractor');
      await extractZip(archivePath, extractedDir);
    } else {
      const proc = crossSpawn(['tar', '-xzf', archivePath, '-C', extractedDir]);
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await proc.stderr();
        return {
          status: 'failed',
          binaryPath: finalBinaryPath,
          error: `Archive extraction failed (tar exited with ${exitCode}): ${stderr}`,
        };
      }
    }

    const binaryName = isWindows
      ? 'oh-my-opencode-slim-companion.exe'
      : 'oh-my-opencode-slim-companion';
    const extractedBinaryPath = path.join(extractedDir, binaryName);

    if (!existsSync(extractedBinaryPath)) {
      return {
        status: 'failed',
        binaryPath: finalBinaryPath,
        error: `Binary ${binaryName} not found in extracted archive`,
      };
    }

    const binDir = path.dirname(finalBinaryPath);
    mkdirSync(binDir, { recursive: true });

    const tmpFinalPath = `${finalBinaryPath}.tmp`;
    copyFileSync(extractedBinaryPath, tmpFinalPath);

    if (!isWindows) {
      chmodSync(tmpFinalPath, 0o755);
    }

    const oldBinary =
      isWindows && existsSync(finalBinaryPath)
        ? `${finalBinaryPath}.old-${randomUUID()}`
        : undefined;
    if (oldBinary) renameSync(finalBinaryPath, oldBinary);
    try {
      renameSync(tmpFinalPath, finalBinaryPath);
    } catch (err) {
      if (oldBinary) {
        try {
          renameSync(oldBinary, finalBinaryPath);
        } catch (restoreError) {
          log(
            '[companion] failed to restore previous executable',
            String(restoreError),
          );
        }
      }
      throw err;
    }
    writeInstallMetadata(finalBinaryPath, {
      version: manifest.version,
      tag: manifest.tag,
      target,
      installedAt: new Date().toISOString(),
      archiveName,
      checksum,
    });

    return {
      status: 'installed',
      binaryPath: finalBinaryPath,
      version: manifest.version,
    };
  } catch (err) {
    return {
      status: 'failed',
      binaryPath: finalBinaryPath,
      error: `Failed to install companion: ${getErrorMessage(err)}`,
    };
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch (err) {
        log('[updater] install cleanup failed', String(err));
      }
    }
  }
}

function readInstallMetadata(
  binaryPath: string,
): CompanionInstallMetadata | null {
  try {
    const parsed = JSON.parse(
      readFileSync(metadataPath(binaryPath), 'utf8'),
    ) as Partial<CompanionInstallMetadata> | null;
    if (parsed?.version && parsed.tag && parsed.target) {
      return parsed as CompanionInstallMetadata;
    }
  } catch (err) {
    log('[updater] metadata read failed', String(err));
  }
  return null;
}

function writeInstallMetadata(
  binaryPath: string,
  metadata: CompanionInstallMetadata,
): void {
  writeFileSync(metadataPath(binaryPath), JSON.stringify(metadata, null, 2));
}

function metadataPath(binaryPath: string): string {
  return `${binaryPath}.json`;
}

async function withCompanionInstallLock(
  binaryPath: string,
  timeoutMs: number | undefined,
  staleMs: number | undefined,
  run: () => Promise<CompanionUpdateResult>,
  signal?: AbortSignal,
): Promise<CompanionUpdateResult> {
  const lock = `${binaryPath}.lock`;
  const deadline = Date.now() + (timeoutMs ?? LOCK_TIMEOUT_MS);
  const staleAfterMs = staleMs ?? STALE_LOCK_MS;
  mkdirSync(path.dirname(binaryPath), { recursive: true });
  while (Date.now() <= deadline) {
    if (signal?.aborted)
      return { status: 'skipped', reason: 'disposed', binaryPath };
    try {
      mkdirSync(lock);
      try {
        return await run();
      } finally {
        try {
          rmSync(lock, { recursive: true, force: true });
        } catch (err) {
          log('[updater] lock release failed', String(err));
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      try {
        const ageMs = Date.now() - statSync(lock).mtimeMs;
        if (ageMs > staleAfterMs) {
          rmSync(lock, { recursive: true, force: true });
          log('[companion] removed stale install lock', lock);
          continue;
        }
      } catch (statErr) {
        const statCode = (statErr as NodeJS.ErrnoException).code;
        if (statCode !== 'ENOENT') throw statErr;
      }
      try {
        await delay(25, undefined, { signal });
      } catch (err) {
        if (signal?.aborted)
          return { status: 'skipped', reason: 'disposed', binaryPath };
        throw err;
      }
    }
  }
  log('[companion] install lock timed out', lock);
  return {
    status: 'failed',
    binaryPath,
    error: 'Timed out waiting for companion install lock',
  };
}

function companionArchiveName(
  version: string,
  target: string,
  isWindows = process.platform === 'win32',
): string {
  const ext = isWindows ? 'zip' : 'tar.gz';
  return `oh-my-opencode-slim-companion-v${version}-${target}.${ext}`;
}

function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return a.localeCompare(b);
  for (let i = 0; i < 3; i++) {
    const diff = left[i] - right[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseSemver(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
