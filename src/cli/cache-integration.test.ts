import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('failed cache warm-up preserves the previously installed plugin', () => {
  const root = mkdtempSync(join(tmpdir(), 'omos-cache-integration-'));
  try {
    const packageRoot = join(
      root,
      'bunx-1000-oh-my-opencode-slim@latest',
      'node_modules',
      'oh-my-opencode-slim',
    );
    const entry = join(packageRoot, 'dist', 'cli', 'index.js');
    const oldPlugin = join(
      root,
      'cache',
      'opencode',
      'packages',
      'oh-my-opencode-slim@latest',
      'node_modules',
      'oh-my-opencode-slim',
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    mkdirSync(oldPlugin, { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      '{"name":"oh-my-opencode-slim","version":"1.0.0"}',
    );
    writeFileSync(entry, '');
    writeFileSync(
      join(oldPlugin, 'package.json'),
      '{"name":"oh-my-opencode-slim","version":"0.9.0"}',
    );
    const script = `import { warmOpenCodePluginCache } from ${JSON.stringify(join(import.meta.dir, 'config-io.ts'))}; process.argv[1] = ${JSON.stringify(entry)}; console.log(JSON.stringify(await warmOpenCodePluginCache()));`;
    const result = spawnSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        HOME: root,
        XDG_CACHE_HOME: join(root, 'cache'),
        OPENCODE_CONFIG_DIR: join(root, 'config'),
        npm_config_registry: 'http://127.0.0.1:9/',
      },
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).success).toBe(false);
    expect(
      JSON.parse(readFileSync(join(oldPlugin, 'package.json'), 'utf8')).version,
    ).toBe('0.9.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
