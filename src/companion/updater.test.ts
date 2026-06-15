import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
        version: '0.1.2',
        tag: 'companion-v0.1.2',
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
      version: '0.1.2',
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
      version: '0.1.2',
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
});

function archiveName(version: string, target: string): string {
  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
  return `oh-my-opencode-slim-companion-v${version}-${target}.${ext}`;
}
