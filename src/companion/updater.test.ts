import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zip from '../utils/zip-extractor';
import {
  COMPANION_MANIFEST,
  ensureCompanionVersion,
  getCompanionBinaryPath,
  getCompanionTarget,
  loadCompanionManifestFromPackageRoot,
} from './updater';

const TEST_DIR = path.join(
  os.tmpdir(),
  `companion-updater-test-${process.pid}`,
);
const originalXdg = process.env.XDG_DATA_HOME;
const originalFetch = globalThis.fetch;

describe('companion updater', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    process.env.XDG_DATA_HOME = TEST_DIR;
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    if (originalXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdg;
    }
    globalThis.fetch = originalFetch;
  });

  test('skips disabled companion config', async () => {
    const result = await ensureCompanionVersion({
      config: { enabled: false },
    });

    expect(result.status).toBe('skipped');
    expect(result).toMatchObject({ reason: 'disabled' });
  });

  test('skips user-managed custom companion binaries', async () => {
    const result = await ensureCompanionVersion({
      config: { enabled: true, binaryPath: '/custom/companion' },
    });

    expect(result.status).toBe('skipped');
    expect(result).toMatchObject({ reason: 'custom-binary' });
  });

  test('treats matching installed metadata as current', async () => {
    const bin = getCompanionBinaryPath();
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, 'binary');
    writeFileSync(
      `${bin}.json`,
      JSON.stringify({
        version: COMPANION_MANIFEST.version,
        tag: COMPANION_MANIFEST.tag,
        target: getCompanionTarget(),
        installedAt: new Date().toISOString(),
        archiveName: 'archive.tar.gz',
      }),
    );

    const result = await ensureCompanionVersion({
      config: { enabled: true },
    });

    expect(result).toMatchObject({
      status: 'current',
      binaryPath: bin,
      version: COMPANION_MANIFEST.version,
    });
  });

  test('treats older metadata as stale against the bundled manifest', async () => {
    const bin = getCompanionBinaryPath();
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, 'binary');
    writeFileSync(
      `${bin}.json`,
      JSON.stringify({
        version: '0.1.3',
        tag: 'companion-v0.1.3',
        target: getCompanionTarget(),
        installedAt: new Date().toISOString(),
        archiveName:
          'oh-my-opencode-slim-companion-v0.1.3-x86_64-pc-windows-msvc.zip',
      }),
    );

    const result = await ensureCompanionVersion({
      config: { enabled: true },
      dryRun: true,
    });

    expect(result).toMatchObject({
      status: 'installed',
      binaryPath: bin,
      version: COMPANION_MANIFEST.version,
    });
  });

  test('dry-run reports the install without downloading', async () => {
    const result = await ensureCompanionVersion({
      config: { enabled: true },
      dryRun: true,
    });

    expect(result).toMatchObject({
      status: 'installed',
      binaryPath: getCompanionBinaryPath(),
      version: COMPANION_MANIFEST.version,
    });
  });

  test('migrates existing v0.1.2 binaries without metadata', async () => {
    const bin = getCompanionBinaryPath();
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, 'existing-binary');
    globalThis.fetch = (() => {
      throw new Error('should not download existing 0.1.2 binary');
    }) as unknown as typeof fetch;

    const result = await ensureCompanionVersion({
      config: { enabled: true },
      manifest: {
        version: '0.1.2',
        tag: 'companion-v0.1.2',
        repo: 'alvinunreal/oh-my-opencode-slim',
      },
    });

    expect(result).toMatchObject({ status: 'current', version: '0.1.2' });
    expect(existsSync(`${bin}.json`)).toBe(true);
    expect(JSON.parse(readFileSync(`${bin}.json`, 'utf8'))).toMatchObject({
      version: '0.1.2',
      tag: 'companion-v0.1.2',
      target: getCompanionTarget(),
    });
  });

  test('fails closed when archive checksum is missing', async () => {
    const fetchCalls: string[] = [];
    globalThis.fetch = ((url: RequestInfo | URL) => {
      fetchCalls.push(String(url));
      throw new Error('should not fetch without checksum');
    }) as unknown as typeof fetch;

    const result = await ensureCompanionVersion({
      config: { enabled: true },
      manifest: {
        version: '0.2.0',
        tag: 'companion-v0.2.0',
        repo: 'owner/repo',
      },
    });

    expect(result.status).toBe('failed');
    expect(result).toMatchObject({
      error: expect.stringContaining('Missing SHA256 checksum'),
    });
    expect(fetchCalls).toEqual([]);
  });

  test('checksum mismatch fails without replacing existing binary', async () => {
    const bin = getCompanionBinaryPath();
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, 'old-binary');
    writeFileSync(
      `${bin}.json`,
      JSON.stringify({
        version: '0.1.1',
        tag: 'companion-v0.1.1',
        target: getCompanionTarget(),
        installedAt: new Date().toISOString(),
        archiveName: 'old.tar.gz',
      }),
    );
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        statusText: 'OK',
      })) as unknown as typeof fetch;

    const target = getCompanionTarget() ?? 'unsupported';
    const result = await ensureCompanionVersion({
      config: { enabled: true },
      manifest: {
        version: '0.2.0',
        tag: 'companion-v0.2.0',
        repo: 'owner/repo',
        checksums: {
          [archiveName('0.2.0', target)]: 'bad',
        },
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: 'Companion archive checksum mismatch',
    });
    expect(readFileSync(bin, 'utf8')).toBe('old-binary');
  });

  test('replaces a locked Windows executable and removes the old image on a later start', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const arch = Object.getOwnPropertyDescriptor(process, 'arch');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    const bin = getCompanionBinaryPath();
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, 'old-binary');
    const originalRename = fs.renameSync;
    const originalRemove = fs.rmSync;
    let imageLocked = true;
    const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (
        String(from) === `${bin}.tmp` &&
        String(to) === bin &&
        existsSync(bin)
      ) {
        throw Object.assign(new Error('executable is locked'), {
          code: 'EPERM',
        });
      }
      return originalRename(from, to);
    });
    const remove = spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      if (imageLocked && String(file).startsWith(`${bin}.old-`)) {
        throw Object.assign(new Error('image is locked'), { code: 'EPERM' });
      }
      return originalRemove(file, options);
    });
    const extract = spyOn(zip, 'extractZip').mockImplementation(
      async (_archive, destination) => {
        writeFileSync(
          path.join(destination, 'oh-my-opencode-slim-companion.exe'),
          'new-binary',
        );
      },
    );
    const bytes = Buffer.from('verified archive');
    globalThis.fetch = (async () => new Response(bytes)) as typeof fetch;
    const manifest = {
      version: '0.2.0',
      tag: 'companion-v0.2.0',
      repo: 'owner/repo',
      checksums: {
        [archiveName('0.2.0', 'x86_64-pc-windows-msvc')]: createHash('sha256')
          .update(bytes)
          .digest('hex'),
      },
    };
    try {
      expect(
        (await ensureCompanionVersion({ config: { enabled: true }, manifest }))
          .status,
      ).toBe('installed');
      expect(readFileSync(bin, 'utf8')).toBe('new-binary');
      expect(
        fs
          .readdirSync(path.dirname(bin))
          .some((name) => name.startsWith(`${path.basename(bin)}.old-`)),
      ).toBe(true);
      imageLocked = false;
      expect(
        (await ensureCompanionVersion({ config: { enabled: true }, manifest }))
          .status,
      ).toBe('current');
      expect(
        fs
          .readdirSync(path.dirname(bin))
          .some((name) => name.startsWith(`${path.basename(bin)}.old-`)),
      ).toBe(false);
    } finally {
      extract.mockRestore();
      remove.mockRestore();
      rename.mockRestore();
      if (platform) Object.defineProperty(process, 'platform', platform);
      if (arch) Object.defineProperty(process, 'arch', arch);
    }
  });

  test('fails instead of installing without a lock after lock timeout', async () => {
    const bin = getCompanionBinaryPath();
    mkdirSync(`${bin}.lock`, { recursive: true });
    globalThis.fetch = (() => {
      throw new Error('should not install without lock');
    }) as unknown as typeof fetch;

    const result = await ensureCompanionVersion({
      config: { enabled: true },
      manifest: {
        version: '0.2.0',
        tag: 'companion-v0.2.0',
        repo: 'owner/repo',
        checksums: {},
      },
      lockTimeoutMs: 1,
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: 'Timed out waiting for companion install lock',
    });
  });

  test('recovers from stale install locks', async () => {
    const bin = getCompanionBinaryPath();
    const lock = `${bin}.lock`;
    mkdirSync(lock, { recursive: true });
    const oldDate = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, oldDate, oldDate);
    globalThis.fetch = (() => {
      throw new Error('should not fetch without checksum');
    }) as unknown as typeof fetch;

    const result = await ensureCompanionVersion({
      config: { enabled: true },
      manifest: {
        version: '0.2.0',
        tag: 'companion-v0.2.0',
        repo: 'owner/repo',
        checksums: {},
      },
      lockTimeoutMs: 100,
      lockStaleMs: 1,
    });

    expect(existsSync(lock)).toBe(false);
    expect(result).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Missing SHA256 checksum'),
    });
  });

  test('loads a companion manifest from an installed package root', () => {
    const packageRoot = path.join(TEST_DIR, 'package');
    const manifestDir = path.join(packageRoot, 'src', 'companion');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      path.join(manifestDir, 'companion-manifest.json'),
      JSON.stringify({
        version: '0.2.0',
        tag: 'companion-v0.2.0',
        repo: 'owner/repo',
      }),
    );

    expect(loadCompanionManifestFromPackageRoot(packageRoot)).toEqual({
      version: '0.2.0',
      tag: 'companion-v0.2.0',
      repo: 'owner/repo',
    });
  });

  test('bundled JSON manifest matches the runtime manifest constant', () => {
    const packageRoot = path.resolve(import.meta.dir, '..', '..');
    expect(loadCompanionManifestFromPackageRoot(packageRoot)).toEqual(
      COMPANION_MANIFEST,
    );
  });

  test('bundled companion manifest pins the standalone native release', () => {
    expect(COMPANION_MANIFEST.repo).toBe(
      'alvinunreal/oh-my-opencode-companion',
    );
    expect(COMPANION_MANIFEST.tag).toBe(
      `companion-v${COMPANION_MANIFEST.version}`,
    );
  });

  test('uses the macOS x64 release target on Intel Macs', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    try {
      expect(getCompanionTarget()).toBe('x86_64-apple-darwin');
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
      if (originalArch) {
        Object.defineProperty(process, 'arch', originalArch);
      }
    }
  });

  test('returns null on corrupt manifest without throwing', () => {
    const brokenDir = path.join(TEST_DIR, 'broken-manifest');
    mkdirSync(path.join(brokenDir, 'src', 'companion'), { recursive: true });
    writeFileSync(
      path.join(brokenDir, 'src', 'companion', 'companion-manifest.json'),
      'not-json',
    );

    const result = loadCompanionManifestFromPackageRoot(brokenDir);

    // Must gracefully return null instead of throwing
    expect(result).toBeNull();
  });

  test('fails gracefully when metadata file is corrupt', () => {
    const bin = getCompanionBinaryPath();
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(`${bin}.json`, 'not-json');

    const result = ensureCompanionVersion({
      config: { enabled: true },
      manifest: {
        version: '0.2.0',
        tag: 'companion-v0.2.0',
        repo: 'owner/repo',
        checksums: {},
      },
      lockTimeoutMs: 1,
    });

    expect(result).resolves.toMatchObject({ status: 'failed' });
  });
});

function archiveName(version: string, target: string): string {
  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
  return `oh-my-opencode-slim-companion-v${version}-${target}.${ext}`;
}
