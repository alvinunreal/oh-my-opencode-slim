#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  COMPANION_MANIFEST,
  type CompanionManifest,
} from '../src/companion/updater';

const root = path.resolve(import.meta.dir, '..');
const manifestPath = path.join(
  root,
  'src',
  'companion',
  'companion-manifest.json',
);
const cargoPath = path.join(root, 'companion', 'Cargo.toml');

const manifest = JSON.parse(
  readFileSync(manifestPath, 'utf8'),
) as CompanionManifest;
const cargoToml = readFileSync(cargoPath, 'utf8');
const cargoVersion = cargoToml.match(
  /\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
)?.[1];

const expectedArchives = [
  `oh-my-opencode-slim-companion-v${manifest.version}-aarch64-apple-darwin.tar.gz`,
  `oh-my-opencode-slim-companion-v${manifest.version}-aarch64-unknown-linux-gnu.tar.gz`,
  `oh-my-opencode-slim-companion-v${manifest.version}-x86_64-apple-darwin.tar.gz`,
  `oh-my-opencode-slim-companion-v${manifest.version}-x86_64-pc-windows-msvc.zip`,
  `oh-my-opencode-slim-companion-v${manifest.version}-x86_64-unknown-linux-gnu.tar.gz`,
].sort();

const errors: string[] = [];

if (!cargoVersion) {
  errors.push('Could not read companion package version from Cargo.toml.');
} else if (manifest.version !== cargoVersion) {
  errors.push(
    `Companion manifest version ${manifest.version} does not match Cargo.toml ${cargoVersion}.`,
  );
}

const expectedTag = `companion-v${manifest.version}`;
if (manifest.tag !== expectedTag) {
  errors.push(
    `Companion manifest tag ${manifest.tag} does not match ${expectedTag}.`,
  );
}

const checksumEntries = Object.entries(manifest.checksums ?? {});
const actualArchives = checksumEntries.map(([archive]) => archive).sort();

if (JSON.stringify(actualArchives) !== JSON.stringify(expectedArchives)) {
  errors.push(
    `Companion manifest assets do not match the supported release set.\nExpected: ${expectedArchives.join(', ')}\nActual: ${actualArchives.join(', ')}`,
  );
}

for (const [archive, checksum] of checksumEntries) {
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    errors.push(`Invalid SHA256 checksum for ${archive}: ${checksum}`);
  }
}

if (
  manifest.version !== COMPANION_MANIFEST.version ||
  manifest.tag !== COMPANION_MANIFEST.tag ||
  manifest.repo !== COMPANION_MANIFEST.repo ||
  JSON.stringify(Object.entries(manifest.checksums ?? {}).sort()) !==
    JSON.stringify(Object.entries(COMPANION_MANIFEST.checksums ?? {}).sort())
) {
  errors.push(
    'Bundled companion-manifest.json does not match COMPANION_MANIFEST in updater.ts.',
  );
}

if (errors.length > 0) {
  console.error('Companion manifest verification failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Companion manifest verified: ${manifest.tag} with ${expectedArchives.length} release assets.`,
);
