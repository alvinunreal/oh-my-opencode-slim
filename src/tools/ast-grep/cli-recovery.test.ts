import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Module mocks elsewhere are process-wide; keep binary recovery isolated.
async function runRecovery(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), 'omos-sg-recovery-'));
  try {
    const source = `
      import { mock } from 'bun:test';
      import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
      import { createRequire } from 'node:module';
      import { delimiter, dirname, join } from 'node:path';
      const mode = process.env.SG_MODE;
      const compat = await import(process.env.COMPAT_URL);
      const utils = await import(process.env.UTILS_URL);
      const badBinary = '#!/missing-ast-grep-loader\\n' + '#'.repeat(11000);
      let downloads = 0;
      let evicted = false;
      let cachedPath;
      mock.module(process.env.UTILS_URL, () => ({
        ...utils,
        extractZip: async () => {
          evicted = !existsSync(cachedPath);
          if (mode === 'recover' || mode === 'missing') {
            const pkg = createRequire(import.meta.url).resolve('@ast-grep/cli/package.json');
            const { resolveBinaryPath } = createRequire(import.meta.url)(join(dirname(pkg), 'postinstall.js'));
            copyFileSync(resolveBinaryPath(), cachedPath);
          } else {
            writeFileSync(cachedPath, badBinary, { mode: 0o755 });
          }
        },
      }));
      globalThis.fetch = async () => {
        downloads++;
        if (mode === 'download-failure' || mode === 'stale-path') throw new Error('download unavailable');
        return new Response(new Uint8Array([0]));
      };
      const downloader = await import(process.env.DOWNLOADER_URL);
      cachedPath = join(downloader.getCacheDir(), downloader.getBinaryName());
      mkdirSync(dirname(cachedPath), { recursive: true });
      if (mode !== 'missing') writeFileSync(cachedPath, badBinary, { mode: 0o755 });
      const initialPath = mode === 'system' ? join(process.env.XDG_CACHE_HOME, 'system-sg') : cachedPath;
      if (mode === 'system') writeFileSync(initialPath, badBinary, { mode: 0o755 });
      let attempts = 0;
      let acquisitions = 0;
      if (mode === 'regression') {
        mock.module(process.env.COMPAT_URL, () => ({
          ...compat,
          crossSpawn: () => {
            attempts++;
            const error = attempts > 4
              ? new Error('REGRESSION_SENTINEL: stopped fifth spawn')
              : Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
            return {
              stdout: async () => { throw error; },
              stderr: async () => '',
              exited: Promise.resolve(1),
              kill: () => true,
            };
          },
        }));
        mock.module(process.env.DOWNLOADER_URL, () => ({
          ...downloader,
          ensureAstGrepBinary: async () => { acquisitions++; return cachedPath; },
        }));
      }
      const { runSg } = await import(process.env.CLI_URL);
      const { getSgCliPath, setSgCliPath } = await import(process.env.CONSTANTS_URL);
      let sourcePath = process.env.SOURCE_PATH;
      if (mode === 'stale-path') {
        // The installed sg shim locates ast-grep on PATH.
        const pkg = createRequire(import.meta.url).resolve('@ast-grep/cli/package.json');
        process.env.PATH = dirname(pkg) + delimiter + process.env.PATH;
        if (getSgCliPath() !== cachedPath) throw new Error('Expected the plugin cache to be resolved first');
        rmSync(cachedPath);
        sourcePath = join(process.env.XDG_CACHE_HOME, 'source.js');
        writeFileSync(sourcePath, 'foo(42);');
      } else {
        setSgCliPath(initialPath);
      }
      const result = await runSg({ pattern: 'foo($A)', lang: 'javascript', paths: [sourcePath] },
        mode === 'regression' ? {} : {
          spawn: (...args) => {
            if (++attempts > 4) throw new Error('REGRESSION_SENTINEL: stopped fifth spawn');
            return compat.crossSpawn(...args);
          },
          findBinary: mode === 'missing' ? () => null : undefined,
          ensureBinary: async (...args) => {
            acquisitions++;
            return downloader.ensureAstGrepBinary(...args);
          },
        });
      console.log('REPORT:' + JSON.stringify({ attempts, acquisitions, downloads, evicted,
        originalExists: existsSync(initialPath), result }));
    `;
    const proc = Bun.spawn([process.execPath, '-e', source], {
      env: {
        ...process.env,
        SG_MODE: mode,
        SOURCE_PATH: join(import.meta.dir, 'cli.ts'),
        XDG_CACHE_HOME: dir,
        LOCALAPPDATA: dir,
        CLI_URL: pathToFileURL(join(import.meta.dir, 'cli.ts')).href,
        CONSTANTS_URL: pathToFileURL(join(import.meta.dir, 'constants.ts'))
          .href,
        DOWNLOADER_URL: pathToFileURL(join(import.meta.dir, 'downloader.ts'))
          .href,
        COMPAT_URL: pathToFileURL(
          join(import.meta.dir, '../../utils/compat.ts'),
        ).href,
        UTILS_URL: pathToFileURL(join(import.meta.dir, '../../utils/index.ts'))
          .href,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`Recovery child: ${stderr}`);
    expect(stderr).not.toContain('Unhandled');
    return JSON.parse(stdout.split('REPORT:')[1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('bounds retries when acquisition returns the same unexecutable binary', async () => {
  const report = await runRecovery('regression');
  expect(report.attempts).toBeLessThanOrEqual(2);
  expect(report.acquisitions).toBeLessThanOrEqual(1);
  expect(report.result.error).toContain('cannot execute');
  expect(report.result.error).toContain('musl');
  expect(report.result.error).toContain('cargo install ast-grep --locked');
});

// A missing shebang interpreter produces the same ENOENT as a missing ELF loader.
// Windows cannot execute these POSIX stubs; the mocked regression runs everywhere.
test.skipIf(process.platform === 'win32')(
  'evicts an unexecutable cache entry once and returns an actionable tool error',
  async () => {
    const report = await runRecovery('loader-error');
    expect(report.attempts).toBe(2);
    expect(report.acquisitions).toBe(1);
    expect(report.downloads).toBe(1);
    expect(report.evicted).toBe(true);
    expect(report.result.error).toContain('exists but cannot execute');
    expect(report.result.error).toContain('Alpine/musl');
    expect(report.result.matches).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32').each(['recover', 'missing'])(
  'recovers successfully after one download (%s)',
  async (mode) => {
    const report = await runRecovery(mode);
    expect(report.attempts).toBe(2);
    expect(report.acquisitions).toBe(1);
    expect(report.downloads).toBe(1);
    expect(report.evicted).toBe(true);
    expect(report.result.error).toBeUndefined();
    expect(report.result.matches).toEqual([]);
  },
);

test('rediscovers an installed CLI offline after the resolved cache path disappears', async () => {
  const report = await runRecovery('stale-path');
  expect(report.attempts).toBeLessThanOrEqual(2);
  expect(report.acquisitions).toBe(0);
  expect(report.downloads).toBe(0);
  expect(report.originalExists).toBe(false);
  expect(report.result.error).toBeUndefined();
  expect(report.result.totalMatches).toBe(1);
  expect(report.result.matches[0].text).toBe('foo(42)');
});

test.skipIf(process.platform === 'win32')(
  'never evicts a failed binary outside the plugin cache',
  async () => {
    const report = await runRecovery('system');
    expect(report.attempts).toBe(2);
    expect(report.acquisitions).toBe(1);
    expect(report.downloads).toBe(0);
    expect(report.originalExists).toBe(true);
    expect(report.result.error).toContain('cannot execute');
  },
);

test.skipIf(process.platform === 'win32')(
  'returns a tool error if recovery cannot download a binary',
  async () => {
    const report = await runRecovery('download-failure');
    expect(report.attempts).toBe(1);
    expect(report.acquisitions).toBe(1);
    expect(report.downloads).toBe(1);
    expect(report.result.error).toContain('Automatic recovery failed');
  },
);
