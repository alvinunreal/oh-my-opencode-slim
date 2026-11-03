#!/usr/bin/env node
import { createHash } from 'node:crypto';

export const COMPANION_REPOSITORY = 'alvinunreal/oh-my-opencode-companion';
const COMPANION_TARGETS = [
  'aarch64-apple-darwin',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
];

export function companionArchiveNames(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid Companion version: ${version}`);
  }
  return COMPANION_TARGETS.map(
    (target) =>
      `oh-my-opencode-slim-companion-v${version}-${target}.${target.includes('windows') ? 'zip' : 'tar.gz'}`,
  );
}

export function validateCompanionManifest(manifest) {
  const names = companionArchiveNames(manifest?.version);
  if (
    manifest.tag !== `companion-v${manifest.version}` ||
    manifest.repo !== COMPANION_REPOSITORY
  ) {
    throw new Error('Unexpected Companion manifest release identity.');
  }
  if (
    JSON.stringify(Object.keys(manifest.checksums ?? {}).sort()) !==
    JSON.stringify([...names].sort())
  ) {
    throw new Error(
      'Companion manifest assets do not match the supported set.',
    );
  }
  for (const name of names) {
    if (!/^[a-f0-9]{64}$/.test(manifest.checksums[name])) {
      throw new Error(`Invalid SHA256 checksum for ${name}.`);
    }
  }
}

export function validateCompanionRelease(release, tag) {
  if (!/^companion-v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Invalid Companion release tag: ${tag}`);
  }
  if (
    !Number.isSafeInteger(release?.id) ||
    release.id <= 0 ||
    release.tag_name !== tag ||
    release.html_url !==
      `https://github.com/${COMPANION_REPOSITORY}/releases/tag/${tag}` ||
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.published_at !== 'string' ||
    !Array.isArray(release.assets)
  ) {
    throw new Error('Invalid published Companion release identity.');
  }
  const names = companionArchiveNames(tag.slice('companion-v'.length));
  return names.map((name) => {
    const matches = release.assets.filter((asset) => asset?.name === name);
    const asset = matches[0];
    if (
      matches.length !== 1 ||
      asset.state !== 'uploaded' ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      asset.browser_download_url !==
        `https://github.com/${COMPANION_REPOSITORY}/releases/download/${tag}/${name}`
    ) {
      throw new Error(`Incomplete Companion release asset: ${name}`);
    }
    return asset;
  });
}

export async function fetchCompanionRelease(tag, options = {}) {
  if (tag !== undefined && !/^companion-v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Invalid Companion release tag: ${tag}`);
  }
  // Public reads need no cross-repository token. Never derive the native
  // repository from GITHUB_REPOSITORY (which identifies the plugin in CI).
  const token = options.token ?? process.env.GH_TOKEN;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const response = await (options.request ?? fetch)(
    `https://api.github.com/repos/${COMPANION_REPOSITORY}/releases/${tag ? `tags/${tag}` : 'latest'}`,
    { headers, signal: AbortSignal.timeout(30_000) },
  );
  if (response.status !== 200) {
    throw new Error(
      `GitHub Companion release lookup returned HTTP ${response.status}.`,
    );
  }
  const release = await response.json();
  validateCompanionRelease(release, tag ?? release?.tag_name);
  return release;
}

export async function publishedCompanionManifest(release, options = {}) {
  const assets = validateCompanionRelease(release, release?.tag_name);
  const checksums = {};
  // Hash the downloaded bytes, not GitHub's optional digest metadata. All
  // five must succeed before callers may write either manifest copy.
  for (const asset of assets) {
    const response = await (options.request ?? fetch)(
      asset.browser_download_url,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (response.status !== 200) {
      throw new Error(`Companion download returned HTTP ${response.status}.`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== asset.size) {
      throw new Error(`Companion archive size mismatch: ${asset.name}`);
    }
    const checksum = createHash('sha256').update(bytes).digest('hex');
    if (asset.digest != null && asset.digest !== `sha256:${checksum}`) {
      throw new Error(`Companion archive digest mismatch: ${asset.name}`);
    }
    checksums[asset.name] = checksum;
  }
  return {
    version: release.tag_name.slice('companion-v'.length),
    tag: release.tag_name,
    repo: COMPANION_REPOSITORY,
    checksums,
  };
}

export function companionManifestsEqual(left, right) {
  return (
    left.version === right.version &&
    left.tag === right.tag &&
    left.repo === right.repo &&
    JSON.stringify(Object.entries(left.checksums ?? {}).sort()) ===
      JSON.stringify(Object.entries(right.checksums ?? {}).sort())
  );
}
