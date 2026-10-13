#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function releaseRelevant(path) {
  return (
    path.startsWith('companion/src/') ||
    path.startsWith('companion/assets/') ||
    path.startsWith('companion/animations/') ||
    path === 'companion/build.rs' ||
    path === 'companion/Cargo.toml' ||
    path === 'companion/Cargo.lock'
  );
}

function withoutCrateVersion(path, text) {
  const normalized = text.replace(/\r\n/g, '\n');
  if (path === 'companion/Cargo.toml') {
    return normalized.replace(/(^version\s*=\s*")[^"]+(")/m, '$1<version>$2');
  }
  if (path === 'companion/Cargo.lock') {
    return normalized.replace(
      /(\[\[package\]\]\r?\nname = "oh-my-opencode-slim-companion"\r?\nversion = ")[^"]+(")/,
      '$1<version>$2',
    );
  }
  return normalized;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const tagArg = process.argv.find((arg) => arg.startsWith('--tag='));
const manifest = JSON.parse(
  readFileSync('src/companion/companion-manifest.json', 'utf8'),
);
const tag = tagArg ? tagArg.slice('--tag='.length) : manifest.tag;
if (!/^companion-v\d+\.\d+\.\d+$/.test(tag)) {
  fail(`Invalid Companion release tag: ${tag}`);
}

try {
  git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
} catch {
  fail(
    `Companion release tag ${tag} is unavailable. Fetch release tags before publishing (git fetch --tags origin).`,
  );
}

let changed;
try {
  const tracked = git('diff', '--name-only', tag, '--', 'companion/');
  const untracked = git(
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    'companion/',
  );
  changed = [...new Set([...tracked.split('\n'), ...untracked.split('\n')])]
    .filter(releaseRelevant)
    .sort();
} catch (error) {
  fail(`Unable to compare native Companion sources: ${String(error)}`);
}

const drift = [];
for (const path of changed) {
  if (path !== 'companion/Cargo.toml' && path !== 'companion/Cargo.lock') {
    drift.push(path);
    continue;
  }

  try {
    const released = git('show', `${tag}:${path}`);
    const current = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
    if (
      withoutCrateVersion(path, released) !== withoutCrateVersion(path, current)
    ) {
      drift.push(path);
    }
  } catch {
    drift.push(path);
  }
}

if (drift.length > 0) {
  fail(
    `Companion native sources have changed since ${tag}:\n- ${drift.join('\n- ')}\nPublish a new native Companion release and sync its manifest before releasing OMO Slim.`,
    2,
  );
}

console.log(`Companion native sources match release ${tag}.`);
