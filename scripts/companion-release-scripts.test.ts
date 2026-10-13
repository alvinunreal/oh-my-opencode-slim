import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sourceCheck = join(import.meta.dir, 'verify-companion-source.mjs');
const prepareRelease = join(import.meta.dir, 'prepare-companion-release.mjs');
const windowsArchive =
  'oh-my-opencode-slim-companion-v0.1.5-x86_64-pc-windows-msvc.zip';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'omo-companion-release-'));
  mkdirSync(join(root, 'companion', 'src'), { recursive: true });
  mkdirSync(join(root, 'companion', 'animations'), { recursive: true });
  mkdirSync(join(root, 'src', 'companion'), { recursive: true });
  writeFileSync(
    join(root, 'companion', 'Cargo.toml'),
    '[package]\nname = "oh-my-opencode-slim-companion"\nversion = "0.1.4"\n\n[dependencies]\nserde = "1"\n',
  );
  writeFileSync(
    join(root, 'companion', 'Cargo.lock'),
    '[[package]]\nname = "oh-my-opencode-slim-companion"\nversion = "0.1.4"\n',
  );
  writeFileSync(join(root, 'companion', 'src', 'main.rs'), 'fn main() {}\n');
  writeFileSync(join(root, 'companion', 'animations', 'intro.jpg'), 'frame-v1');
  writeFileSync(
    join(root, 'src', 'companion', 'companion-manifest.json'),
    JSON.stringify({
      version: '0.1.4',
      tag: 'companion-v0.1.4',
      repo: 'alvinunreal/oh-my-opencode-slim',
      checksums: {},
    }),
  );
  writeFileSync(
    join(root, 'src', 'companion', 'updater.ts'),
    "export const COMPANION_MANIFEST: CompanionManifest = {\n  version: '0.1.4',\n  tag: 'companion-v0.1.4',\n  repo: 'alvinunreal/oh-my-opencode-slim',\n  checksums: {},\n};\n",
  );
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Companion Test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Companion v0.1.4 source');
  git(root, 'tag', 'companion-v0.1.4');
  return root;
}

function check(root: string) {
  return spawnSync('node', [sourceCheck], { cwd: root, encoding: 'utf8' });
}

test('native source check rejects post-release Rust changes', () => {
  const root = fixture();
  try {
    expect(check(root).status).toBe(0);
    writeFileSync(
      join(root, 'companion', 'src', 'main.rs'),
      'fn main() { println!("new"); }\n',
    );
    const result = check(root);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('main.rs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native source check detects changes to embedded Companion sprites', () => {
  const root = fixture();
  try {
    expect(check(root).status).toBe(0);
    writeFileSync(
      join(root, 'companion', 'animations', 'intro.jpg'),
      'frame-v2',
    );
    const result = check(root);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('animations/intro.jpg');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native source check permits crate version-only synchronization', () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, 'companion', 'Cargo.toml'),
      '[package]\nname = "oh-my-opencode-slim-companion"\nversion = "0.1.5"\n\n[dependencies]\nserde = "1"\n',
    );
    writeFileSync(
      join(root, 'companion', 'Cargo.lock'),
      '[[package]]\nname = "oh-my-opencode-slim-companion"\nversion = "0.1.5"\n',
    );
    for (const name of ['Cargo.toml', 'Cargo.lock']) {
      const file = join(root, 'companion', name);
      writeFileSync(file, readFileSync(file, 'utf8').replaceAll('\n', '\r\n'));
    }
    expect(check(root).status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native source check rejects dependency changes and missing tags', () => {
  const root = fixture();
  try {
    const cargoPath = join(root, 'companion', 'Cargo.toml');
    writeFileSync(
      cargoPath,
      `${readFileSync(cargoPath, 'utf8')}winit = "0.30"\n`,
    );
    expect(check(root).status).toBe(2);
    git(root, 'tag', '-d', 'companion-v0.1.4');
    expect(check(root).status).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release preparation reads real archive hashes and synchronizes both manifests', () => {
  const root = fixture();
  try {
    mkdirSync(join(root, 'assets'));
    for (const target of [
      'aarch64-apple-darwin',
      'aarch64-unknown-linux-gnu',
      'x86_64-apple-darwin',
      'x86_64-pc-windows-msvc',
      'x86_64-unknown-linux-gnu',
    ]) {
      const suffix = target.includes('windows') ? 'zip' : 'tar.gz';
      writeFileSync(
        join(
          root,
          'assets',
          `oh-my-opencode-slim-companion-v0.1.5-${target}.${suffix}`,
        ),
        `archive bytes for ${target}`,
      );
    }

    const result = spawnSync(
      'node',
      [prepareRelease, '--version=0.1.5', '--assets-dir=assets'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    const manifest = JSON.parse(
      readFileSync(
        join(root, 'src', 'companion', 'companion-manifest.json'),
        'utf8',
      ),
    );
    const digest = createHash('sha256')
      .update(readFileSync(join(root, 'assets', windowsArchive)))
      .digest('hex');
    expect(manifest.version).toBe('0.1.5');
    expect(Object.keys(manifest.checksums)).toHaveLength(5);
    expect(manifest.checksums[windowsArchive]).toBe(digest);
    expect(
      readFileSync(join(root, 'src', 'companion', 'updater.ts'), 'utf8'),
    ).toContain(digest);
    expect(
      readFileSync(join(root, 'companion', 'Cargo.lock'), 'utf8'),
    ).toContain('version = "0.1.5"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
