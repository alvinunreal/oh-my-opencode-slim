#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const versionFlag = process.argv.find((arg) => arg.startsWith('--version='));
const assetsFlag = process.argv.find((arg) => arg.startsWith('--assets-dir='));
const version = versionFlag?.slice('--version='.length);

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('Specify a numeric --version=X.Y.Z.');
}

function replaceRequired(text, pattern, replacement, label) {
  if (!pattern.test(text)) {
    throw new Error(`Could not locate ${label}`);
  }
  return text.replace(pattern, replacement);
}

const cargoPath = 'companion/Cargo.toml';
const cargo = readFileSync(cargoPath, 'utf8');
writeFileSync(
  cargoPath,
  replaceRequired(
    cargo,
    /^version\s*=\s*"[^"]+"/m,
    `version = "${version}"`,
    'package version in Cargo.toml',
  ),
);

const lockPath = 'companion/Cargo.lock';
const lock = readFileSync(lockPath, 'utf8');
const lockPackagePattern =
  /(\[\[package\]\]\r?\nname = "oh-my-opencode-slim-companion"\r?\nversion = ")[^"]+(")/;
writeFileSync(
  lockPath,
  replaceRequired(
    lock,
    lockPackagePattern,
    (_match, prefix, suffix) => `${prefix}${version}${suffix}`,
    'Companion package in Cargo.lock',
  ),
);

if (!assetsFlag) {
  console.log(`Prepared native Companion build version ${version}`);
  process.exit(0);
}

const assetsDir = assetsFlag.slice('--assets-dir='.length);
const targets = [
  'aarch64-apple-darwin',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
];
const checksums = {};
for (const target of targets) {
  const extension = target.includes('windows') ? 'zip' : 'tar.gz';
  const archive = `oh-my-opencode-slim-companion-v${version}-${target}.${extension}`;
  const path = join(assetsDir, archive);
  if (!existsSync(path)) {
    throw new Error(`Missing published Companion release asset: ${archive}`);
  }
  checksums[archive] = createHash('sha256')
    .update(readFileSync(path))
    .digest('hex');
}

const manifestPath = 'src/companion/companion-manifest.json';
const currentManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const manifest = {
  version,
  tag: `companion-v${version}`,
  repo: currentManifest.repo,
  checksums,
};
if (manifest.repo !== 'alvinunreal/oh-my-opencode-slim') {
  throw new Error('Unexpected Companion release repository.');
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const updaterPath = 'src/companion/updater.ts';
const updater = readFileSync(updaterPath, 'utf8');
const fallback = [
  'export const COMPANION_MANIFEST: CompanionManifest = {',
  `  version: '${version}',`,
  `  tag: 'companion-v${version}',`,
  `  repo: '${manifest.repo}',`,
  '  checksums: {',
  ...Object.entries(checksums).flatMap(([archive, sha]) => [
    `    '${archive}':`,
    `      '${sha}',`,
  ]),
  '  },',
  '};',
].join('\n');
writeFileSync(
  updaterPath,
  replaceRequired(
    updater,
    /export const COMPANION_MANIFEST: CompanionManifest = \{[\s\S]*?\n\};/,
    fallback,
    'Companion fallback manifest in updater.ts',
  ),
);
console.log(
  `Synchronized Companion ${version} from ${targets.length} actual release assets.`,
);
