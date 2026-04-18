import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distEntry = path.join(repoRoot, 'dist', 'index.js');

function fail(message: string): never {
  throw new Error(message);
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: {
      ...process.env,
      ...options.env,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
    fail(
      `Command failed: ${command} ${args.join(' ')}${detail ? `\n${detail}` : ''}`,
    );
  }

  return result.stdout.trim();
}

function parsePackJson(output: string) {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');

  if (start === -1 || end === -1 || end < start) {
    fail(`Could not locate npm pack JSON output:\n${output}`);
  }

  return JSON.parse(output.slice(start, end + 1)) as Array<{
    filename?: string;
  }>;
}

function packArtifact() {
  const output = run('npm', ['pack', '--json', '--ignore-scripts']);
  const parsed = parsePackJson(output);
  const tarball = parsed[0]?.filename;
  if (!tarball) fail(`npm pack did not return a tarball filename:\n${output}`);
  return path.join(repoRoot, tarball);
}

async function getFreePort() {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate free port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForHealth(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'health check did not succeed';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `health check returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  fail(`OpenCode server did not become healthy: ${lastError}`);
}

function formatCapturedLogs(stdout: string, stderr: string): string {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
  if (!combined) return 'No stdout/stderr captured.';

  const lines = combined.split(/\r?\n/);
  return lines.slice(-200).join('\n');
}

async function stopProcess(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null) return;

  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);

  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

function assertNoPluginLoadErrors(logs: string) {
  const badPatterns = [
    /failed to load plugin/i,
    /cannot find module/i,
    /error=.*failed to load plugin/i,
  ];

  const match = badPatterns.find((pattern) => pattern.test(logs));
  if (!match) return;

  const relevantLines = logs
    .split(/\r?\n/)
    .filter((line) =>
      /plugin|failed to load|cannot find module|error=/i.test(line),
    )
    .slice(-20)
    .join('\n');

  fail(
    `OpenCode logs contain plugin load errors:${relevantLines ? `\n${relevantLines}` : ''}`,
  );
}

async function verifyHostSmoke(tarballPath: string) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'omos-opencode-smoke-'));
  const homeDir = path.join(tempRoot, 'home');
  const configDir = path.join(tempRoot, 'config');
  const cacheDir = path.join(tempRoot, 'cache');
  const dataDir = path.join(tempRoot, 'data');
  const hostDir = path.join(tempRoot, 'host');
  const workspaceDir = path.join(tempRoot, 'workspace');
  const tarballTarget = path.join(tempRoot, path.basename(tarballPath));
  const port = await getFreePort();
  const healthTimeoutMs = process.platform === 'darwin' ? 60_000 : 30_000;

  try {
    console.log('Packing plugin tarball into isolated test root...');
    copyFileSync(tarballPath, tarballTarget);

    for (const dir of [
      homeDir,
      configDir,
      cacheDir,
      dataDir,
      hostDir,
      workspaceDir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    const pluginDir = path.join(configDir, 'plugins');
    mkdirSync(pluginDir, { recursive: true });

    writeFileSync(
      path.join(hostDir, 'package.json'),
      JSON.stringify(
        { name: 'verify-opencode-host-smoke', private: true },
        null,
        2,
      ),
    );

    console.log('Installing opencode-ai into isolated test root...');
    run('bun', ['add', 'opencode-ai@latest'], { cwd: hostDir });

    const opencodeBin = path.join(hostDir, 'node_modules', '.bin', 'opencode');
    if (!existsSync(opencodeBin)) {
      fail(`Expected opencode binary at ${opencodeBin}`);
    }

    writeFileSync(
      path.join(configDir, 'package.json'),
      JSON.stringify(
        {
          type: 'module',
          dependencies: {
            'oh-my-opencode-slim': `file:${tarballTarget}`,
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      path.join(pluginDir, 'load-oh-my-opencode-slim.js'),
      "export { default } from 'oh-my-opencode-slim';\n",
    );

    const config = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      share: 'disabled',
      snapshot: false,
    });

    const env = {
      HOME: homeDir,
      XDG_CONFIG_HOME: configDir,
      XDG_CACHE_HOME: cacheDir,
      XDG_DATA_HOME: dataDir,
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_CONFIG_CONTENT: config,
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    };

    console.log('Starting opencode serve with packaged plugin...');
    const child = spawn(
      opencodeBin,
      [
        'serve',
        '--print-logs',
        '--log-level',
        'DEBUG',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      {
        cwd: workspaceDir,
        env: {
          ...process.env,
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const exitPromise = new Promise<never>((_, reject) => {
      child.once('exit', (code, signal) => {
        reject(
          new Error(
            `opencode serve exited before smoke test completed (code=${code}, signal=${signal})\n${stdout}\n${stderr}`,
          ),
        );
      });
    });

    try {
      await Promise.race([
        waitForHealth(`http://127.0.0.1:${port}/health`, healthTimeoutMs),
        exitPromise,
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(
        `${message}\nCaptured OpenCode logs:\n${formatCapturedLogs(stdout, stderr)}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
    assertNoPluginLoadErrors(`${stdout}\n${stderr}`);

    await stopProcess(child);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function cleanupTarball(tarballPath: string) {
  rmSync(tarballPath, { force: true });
}

async function main() {
  if (!existsSync(distEntry)) {
    fail(
      'dist/index.js is missing. Run `bun run build` before verify:host-smoke.',
    );
  }

  const tarballPath = packArtifact();
  try {
    await verifyHostSmoke(tarballPath);
  } finally {
    cleanupTarball(tarballPath);
  }

  console.log('OpenCode host smoke verification passed.');
}

await main();
process.exit(0);
