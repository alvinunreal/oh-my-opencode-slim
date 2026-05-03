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

const packagedRequiredFiles = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/cli/index.js',
  'dist/divoom/council.gif',
  'dist/divoom/designer.gif',
  'dist/divoom/explorer.gif',
  'dist/divoom/fixer.gif',
  'dist/divoom/intro.gif',
  'dist/divoom/librarian.gif',
  'dist/divoom/oracle.gif',
  'dist/divoom/orchestrator.gif',
  'oh-my-opencode-slim.schema.json',
  'src/skills/simplify/SKILL.md',
  'src/skills/codemap/SKILL.md',
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

function parsePackJson(output: string) {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');

  if (start === -1 || end === -1 || end < start) {
    fail(`Could not locate npm pack JSON output:\n${output}`);
  }

  return JSON.parse(output.slice(start, end + 1)) as Array<{
    filename?: string;
    files?: Array<{ path: string }>;
  }>;
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
      "if (typeof pkg !== 'function') throw new Error('default export is not a function');",
      "console.log('package loads');",
      'process.exit(0);',
    ].join('\n');
    console.log('Importing installed package entrypoint...');
    run('node', ['--input-type=module', '--eval', smokeScript], {
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
