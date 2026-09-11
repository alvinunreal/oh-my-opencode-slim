import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');

const suspiciousPathPatterns = [
  /\/Users\/[^\s'"`]+(?:node_modules|oh-my-opencode-slim)[^\s'"`]*/,
  /\/home\/[^\s'"`]+(?:node_modules|oh-my-opencode-slim)[^\s'"`]*/,
];
const suspiciousImportPatterns = [/from\s+["']vscode-jsonrpc\/node["']/];

const packagedRequiredFiles = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/server/index.js',
  'dist/tui.js',
  'dist/tui.d.ts',
  'dist/cli/index.js',
  'oh-my-opencode-slim.schema.json',
  'src/companion/companion-manifest.json',
  'src/skills/simplify/SKILL.md',
  'src/skills/codemap/SKILL.md',
  'src/skills/clonedeps/SKILL.md',
  'src/skills/deepwork/SKILL.md',
  'src/skills/verification-planning/SKILL.md',
  'src/skills/reflect/SKILL.md',
  'src/skills/oh-my-opencode-slim/SKILL.md',
  'src/skills/worktrees/SKILL.md',
];

function fail(message: string): never {
  throw new Error(message);
}

function run(command: string, args: string[], options: { cwd?: string } = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
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

type PackEntry = {
  filename?: string;
  files?: Array<{ path: string }>;
};

function parsePackJson(output: string): PackEntry[] {
  // npm pack --json historically emitted an array of entries; npm >= 12
  // emits an object keyed by package name. Accept both shapes.
  const arrayStart = output.indexOf('[');
  const objectStart = output.indexOf('{');

  if (arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart)) {
    const end = output.lastIndexOf(']');
    if (end === -1 || end < arrayStart) {
      fail(`Could not locate npm pack JSON output:\n${output}`);
    }
    return JSON.parse(output.slice(arrayStart, end + 1)) as PackEntry[];
  }

  const end = output.lastIndexOf('}');
  if (objectStart === -1 || end === -1 || end < objectStart) {
    fail(`Could not locate npm pack JSON output:\n${output}`);
  }
  const parsed = JSON.parse(output.slice(objectStart, end + 1)) as Record<
    string,
    PackEntry | PackEntry[]
  >;
  return Object.values(parsed).flat() as PackEntry[];
}

function walkFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(fullPath);
    return [fullPath];
  });
}

function verifyDistHasNoLeakedPaths() {
  console.log('Checking dist for leaked machine paths...');
  const files = walkFiles(distDir).filter((file) =>
    /\.(?:js|d\.ts|map|json)$/.test(file),
  );

  const leaks: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const pattern of suspiciousPathPatterns) {
      const match = content.match(pattern);
      if (!match) continue;
      leaks.push(`${path.relative(repoRoot, file)}: ${match[0]}`);
    }
    for (const pattern of suspiciousImportPatterns) {
      const match = content.match(pattern);
      if (!match) continue;
      leaks.push(`${path.relative(repoRoot, file)}: ${match[0]}`);
    }
  }

  if (leaks.length > 0) {
    fail(
      `Built artifact contains machine-specific paths:\n${leaks.join('\n')}`,
    );
  }
}

function packArtifact() {
  console.log('Packing npm artifact...');
  const output = run('npm', ['pack', '--json', '--ignore-scripts'], {
    cwd: repoRoot,
  });
  const parsed = parsePackJson(output);
  const tarball = parsed[0]?.filename;

  if (!tarball) {
    fail(`npm pack did not return a tarball filename:\n${output}`);
  }

  const packagedFiles = new Set(
    (parsed[0]?.files ?? []).map((file) => file.path),
  );
  for (const requiredFile of packagedRequiredFiles) {
    if (!packagedFiles.has(requiredFile)) {
      fail(`npm pack artifact is missing required file: ${requiredFile}`);
    }
  }

  return path.join(repoRoot, tarball);
}

function verifyFreshInstall(tarballPath: string) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'omos-release-'));

  try {
    console.log('Installing packed artifact into clean temp project...');
    const installDir = path.join(tempRoot, 'install');
    const tarballTarget = path.join(tempRoot, path.basename(tarballPath));

    copyFileSync(tarballPath, tarballTarget);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      path.join(installDir, 'package.json'),
      JSON.stringify(
        { name: 'verify-release-artifact', private: true },
        null,
        2,
      ),
    );
    run('bun', ['add', '--ignore-scripts', tarballTarget], {
      cwd: installDir,
    });

    const installedEntry = path.join(
      installDir,
      'node_modules',
      'oh-my-opencode-slim',
      'dist',
      'index.js',
    );
    const installedEntryContent = readFileSync(installedEntry, 'utf8');
    for (const pattern of suspiciousPathPatterns) {
      const match = installedEntryContent.match(pattern);
      if (match) {
        fail(
          `Installed package still contains machine-specific path: ${match[0]}`,
        );
      }
    }

    const smokeScript = [
      "import pkg from 'oh-my-opencode-slim';",
      "if (pkg?.id !== 'oh-my-opencode-slim') throw new Error('default export has an unexpected plugin id');",
      "if (typeof pkg.server !== 'function') throw new Error('default export is missing a server plugin factory');",
      "if (typeof pkg.setup !== 'function') throw new Error('default export is missing a v2 setup factory');",
      'const asyncNoop = async () => ({});',
      'const client = new Proxy({}, {',
      '  get(_target, property) {',
      "    if (property === 'app') return { log: asyncNoop };",
      "    if (property === 'session') return { abort: asyncNoop };",
      '    return new Proxy({}, { get: () => asyncNoop });',
      '  },',
      '});',
      'globalThis.fetch = async () => new Response(',
      "  '<!doctype html><html><head><title>Release smoke</title></head><body><main><h1>Release smoke</h1><p>packaged jsdom extraction works</p></main></body></html>',",
      "  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },",
      ');',
      'const plugin = await pkg.server({',
      '  client,',
      '  directory: process.cwd(),',
      '  worktree: process.cwd(),',
      "  serverUrl: new URL('http://127.0.0.1:4096'),",
      '});',
      'const webfetch = plugin?.tool?.webfetch;',
      "if (typeof webfetch?.execute !== 'function') throw new Error('server plugin did not register webfetch');",
      'const result = await webfetch.execute({',
      "  url: 'https://example.com/release-smoke',",
      "  format: 'markdown',",
      '  timeout: 10,',
      '  extract_main: true,',
      "  prefer_llms_txt: 'never',",
      '  include_metadata: false,',
      '  save_binary: false,',
      '}, {',
      '  ask: async () => undefined,',
      '  metadata: () => undefined,',
      '  abort: new AbortController().signal,',
      '  directory: process.cwd(),',
      "  sessionID: 'release-smoke',",
      '});',
      "if (!String(result).includes('packaged jsdom extraction works')) throw new Error('packaged webfetch did not extract the expected document');",
      'await plugin.dispose?.();',
      "console.log('package loads');",
      "console.log('packaged webfetch constructs and extracts a document');",
      'process.exit(0);',
    ].join('\n');
    console.log('Importing installed package entrypoint...');
    run('node', ['--input-type=module', '--eval', smokeScript], {
      cwd: installDir,
    });

    const tuiSmokeScript = [
      "import pkg from 'oh-my-opencode-slim/tui';",
      "if (pkg?.id !== 'oh-my-opencode-slim:tui') throw new Error('TUI export has an unexpected plugin id');",
      "if (typeof pkg.tui !== 'function') throw new Error('TUI export is missing its v1 factory');",
      "if (typeof pkg.setup !== 'function') throw new Error('TUI export is missing its v2 setup factory');",
      "console.log('TUI package loads');",
      'process.exit(0);',
    ].join('\n');
    console.log('Importing installed TUI entrypoint...');
    run('bun', ['--eval', tuiSmokeScript], { cwd: installDir });

    // v2 hosts install this package with `subpaths: ["server", ""]`; the
    // exports map must resolve ./server to the self-contained bundle.
    const serverSmokeScript = [
      "import pkg from 'oh-my-opencode-slim/server';",
      "if (pkg?.id !== 'oh-my-opencode-slim') throw new Error('server export has an unexpected plugin id');",
      "if (typeof pkg.server !== 'function') throw new Error('server export is missing a v1 plugin factory');",
      "if (typeof pkg.setup !== 'function') throw new Error('server export is missing a v2 setup factory');",
      "console.log('server package loads');",
      'process.exit(0);',
    ].join('\n');
    console.log('Importing installed server subpath entrypoint...');
    run('node', ['--input-type=module', '--eval', serverSmokeScript], {
      cwd: installDir,
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function cleanupTarball(tarballPath: string) {
  rmSync(tarballPath, { force: true });
}

function main() {
  verifyDistHasNoLeakedPaths();
  const tarballPath = packArtifact();
  try {
    verifyFreshInstall(tarballPath);
  } finally {
    cleanupTarball(tarballPath);
  }
  console.log('Release artifact verification passed.');
}

main();
