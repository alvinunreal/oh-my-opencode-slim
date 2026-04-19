import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { sync as whichSync } from 'which';
import { extractZip, getZipExtractionSupportError } from '../../utils';
import { type CrossSpawnResult, crossSpawn } from '../../utils/compat';

interface RipgrepReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface RipgrepReleaseResponse {
  tag_name?: string;
  assets?: RipgrepReleaseAsset[];
}

type ArchiveExtension = 'tar.gz' | 'zip';

interface PlatformCandidate {
  target: string;
  extension: ArchiveExtension;
}

function createAbortError(): Error {
  const error = new Error('ripgrep auto-install was aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

async function waitForExitAndStderr(
  proc: CrossSpawnResult,
  stderrPromise: Promise<string>,
): Promise<{ exitCode: number; stderr: string }> {
  const [exitResult, stderrResult] = await Promise.allSettled([
    proc.exited,
    stderrPromise,
  ]);

  return {
    exitCode: exitResult.status === 'fulfilled' ? exitResult.value : 1,
    stderr: stderrResult.status === 'fulfilled' ? stderrResult.value : '',
  };
}

function hasExecutable(name: string): boolean {
  try {
    const resolved = whichSync(name, { nothrow: true });
    return Array.isArray(resolved)
      ? (resolved[0] ?? '').length > 0
      : (resolved ?? '').length > 0;
  } catch {
    return false;
  }
}

function getCacheBaseDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
    return localAppData || join(homedir(), 'AppData', 'Local');
  }

  return process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
}

export function getRipgrepCacheDir(): string {
  return join(getCacheBaseDir(), 'oh-my-opencode-slim', 'grep', 'bin');
}

export function getRipgrepBinaryName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

export function getInstalledRipgrepPath(): string | null {
  const binaryPath = join(getRipgrepCacheDir(), getRipgrepBinaryName());
  return existsSync(binaryPath) ? binaryPath : null;
}

function detectLinuxLibc(): 'gnu' | 'musl' {
  const muslLoaders = [
    '/lib/ld-musl-x86_64.so.1',
    '/lib/ld-musl-aarch64.so.1',
    '/usr/glibc-compat/lib/ld-musl-x86_64.so.1',
    '/usr/glibc-compat/lib/ld-musl-aarch64.so.1',
  ];

  if (muslLoaders.some((candidate) => existsSync(candidate))) {
    return 'musl';
  }

  try {
    const result = spawnSync('ldd', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output =
      `${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`.toLowerCase();

    if (output.includes('musl')) {
      return 'musl';
    }
  } catch {
    // Ignore and fall back to gnu.
  }

  return 'gnu';
}

function getPlatformCandidates(): PlatformCandidate[] {
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') {
      return [{ target: 'aarch64-apple-darwin', extension: 'tar.gz' }];
    }

    if (process.arch === 'x64') {
      return [{ target: 'x86_64-apple-darwin', extension: 'tar.gz' }];
    }

    return [];
  }

  if (process.platform === 'win32') {
    if (process.arch === 'arm64') {
      return [{ target: 'aarch64-pc-windows-msvc', extension: 'zip' }];
    }

    if (process.arch === 'x64') {
      return [{ target: 'x86_64-pc-windows-msvc', extension: 'zip' }];
    }

    return [];
  }

  if (process.platform === 'linux') {
    const libc = detectLinuxLibc();

    if (process.arch === 'arm64') {
      return libc === 'musl'
        ? [
            { target: 'aarch64-unknown-linux-musl', extension: 'tar.gz' },
            { target: 'aarch64-unknown-linux-gnu', extension: 'tar.gz' },
          ]
        : [
            { target: 'aarch64-unknown-linux-gnu', extension: 'tar.gz' },
            { target: 'aarch64-unknown-linux-musl', extension: 'tar.gz' },
          ];
    }

    if (process.arch === 'x64') {
      return libc === 'musl'
        ? [
            { target: 'x86_64-unknown-linux-musl', extension: 'tar.gz' },
            { target: 'x86_64-unknown-linux-gnu', extension: 'tar.gz' },
          ]
        : [
            { target: 'x86_64-unknown-linux-gnu', extension: 'tar.gz' },
            { target: 'x86_64-unknown-linux-musl', extension: 'tar.gz' },
          ];
    }
  }

  return [];
}

function findBinaryRecursive(
  directory: string,
  binaryName: string,
): string | null {
  try {
    const entries = readdirSync(directory, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = join(directory, entry.name);

      if (entry.isFile() && entry.name === binaryName) {
        return entryPath;
      }

      if (entry.isDirectory()) {
        const nested = findBinaryRecursive(entryPath, binaryName);
        if (nested) {
          return nested;
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function fetchLatestRelease(
  signal?: AbortSignal,
): Promise<RipgrepReleaseResponse> {
  const response = await fetch(
    'https://api.github.com/repos/BurntSushi/ripgrep/releases/latest',
    {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'oh-my-opencode-slim',
      },
      redirect: 'follow',
      signal,
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to resolve latest ripgrep release: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as RipgrepReleaseResponse;
  if (!payload.tag_name || !Array.isArray(payload.assets)) {
    throw new Error('Latest ripgrep release metadata is incomplete.');
  }

  return payload;
}

function selectReleaseAsset(release: RipgrepReleaseResponse): {
  asset: RipgrepReleaseAsset;
  version: string;
} {
  const version = release.tag_name?.replace(/^v/i, '');
  if (!version) {
    throw new Error('Latest ripgrep release is missing a version tag.');
  }

  const assets = release.assets ?? [];
  const candidates = getPlatformCandidates();

  if (candidates.length === 0) {
    throw new Error(
      `Unsupported platform for ripgrep auto-install: ${process.platform}-${process.arch}`,
    );
  }

  for (const candidate of candidates) {
    const expectedName = `ripgrep-${version}-${candidate.target}.${candidate.extension}`;
    const asset = assets.find((item) => item.name === expectedName);

    if (asset?.browser_download_url) {
      return { asset, version };
    }
  }

  throw new Error(
    `No ripgrep asset is available for ${process.platform}-${process.arch}.`,
  );
}

async function downloadArchive(
  url: string,
  destinationPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, { redirect: 'follow', signal });

  if (!response.ok) {
    throw new Error(
      `Failed to download ripgrep archive: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  throwIfAborted(signal);
  await writeFile(destinationPath, Buffer.from(arrayBuffer));
}

async function extractTarGz(
  archivePath: string,
  destinationDir: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const proc = crossSpawn(['tar', '-xzf', archivePath, '-C', destinationDir], {
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      // Process may have already exited.
    }
  };

  signal?.addEventListener('abort', onAbort, { once: true });

  const stderrPromise = proc.stderr();
  const { exitCode, stderr } = await waitForExitAndStderr(proc, stderrPromise);
  signal?.removeEventListener('abort', onAbort);

  if (signal?.aborted) {
    throw createAbortError();
  }

  if (exitCode !== 0) {
    throw new Error(`ripgrep extraction failed (exit ${exitCode}): ${stderr}`);
  }
}

async function extractArchive(
  archivePath: string,
  destinationDir: string,
  extension: ArchiveExtension,
  signal?: AbortSignal,
): Promise<void> {
  if (extension === 'zip') {
    await extractZip(archivePath, destinationDir, signal);
    return;
  }

  await extractTarGz(archivePath, destinationDir, signal);
}

function ensureExecutable(binaryPath: string): void {
  if (process.platform !== 'win32') {
    chmodSync(binaryPath, 0o755);
  }
}

function validateInstalledBinary(
  binaryPath: string,
  signal?: AbortSignal,
): void {
  throwIfAborted(signal);
  const result = spawnSync(binaryPath, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  throwIfAborted(signal);

  if (result.status !== 0) {
    throw new Error(
      `Installed ripgrep binary failed validation with exit ${String(result.status)}.`,
    );
  }

  const output =
    `${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`.toLowerCase();
  if (!output.includes('ripgrep')) {
    throw new Error('Installed binary did not identify itself as ripgrep.');
  }
}

function ensureArchiveSupport(extension: ArchiveExtension): void {
  if (extension === 'zip') {
    const zipError = getZipExtractionSupportError();
    if (zipError) {
      throw new Error(zipError);
    }
    return;
  }

  if (!hasExecutable('tar')) {
    throw new Error(
      'ripgrep auto-install requires tar to extract .tar.gz archives.',
    );
  }
}

export async function installLatestStableRipgrep(
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const existing = getInstalledRipgrepPath();
  if (existing) {
    return existing;
  }

  const release = await fetchLatestRelease(signal);
  const { asset } = selectReleaseAsset(release);
  const extension = (
    asset.name?.endsWith('.zip') ? 'zip' : 'tar.gz'
  ) as ArchiveExtension;
  ensureArchiveSupport(extension);
  const cacheDir = getRipgrepCacheDir();
  const binaryName = getRipgrepBinaryName();
  const finalPath = join(cacheDir, binaryName);
  const tmpRoot = join(
    cacheDir,
    `.install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const archivePath = join(tmpRoot, asset.name ?? 'ripgrep-archive');
  const extractDir = join(tmpRoot, 'extract');
  const stagedBinaryPath = join(tmpRoot, binaryName);

  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });

  try {
    await downloadArchive(
      asset.browser_download_url as string,
      archivePath,
      signal,
    );
    await extractArchive(archivePath, extractDir, extension, signal);
    throwIfAborted(signal);

    const extractedBinaryPath = findBinaryRecursive(extractDir, binaryName);
    if (!extractedBinaryPath) {
      throw new Error('ripgrep binary was not found after extraction.');
    }

    renameSync(extractedBinaryPath, stagedBinaryPath);
    ensureExecutable(stagedBinaryPath);
    validateInstalledBinary(stagedBinaryPath, signal);
    throwIfAborted(signal);

    if (!existsSync(finalPath)) {
      renameSync(stagedBinaryPath, finalPath);
    }

    if (!existsSync(finalPath)) {
      throw new Error('ripgrep binary was not installed successfully.');
    }

    return finalPath;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(dirname(finalPath), { recursive: true });
  }
}
