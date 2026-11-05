# Release Process

The plugin and native Companion have independent repositories and versions:

- **Plugin:** this repository, npm package version from `package.json`, tags
  `v<version>`.
- **Native Companion:** [alvinunreal/oh-my-opencode-companion](https://github.com/alvinunreal/oh-my-opencode-companion),
  tags `companion-v<version>`. The Rust crate, assets, native CI, and autonomous
  native release workflow live there, with the crate at the repository root.

Plugin-only changes never rebuild native binaries. The TypeScript manager,
installer, updater, and CLI remain in this repository. The binary name
`oh-my-opencode-slim-companion`, archive names, state channel, and native tag
format are unchanged by the extraction.

## Companion manifest handoff

The [Companion Manifest Sync](../.github/workflows/companion-manifest-sync.yml)
workflow runs every six hours or on manual dispatch. It reads the native
repository's latest published release, requires all five supported archives,
hashes their actual bytes, and proposes an update to
`src/companion/companion-manifest.json` and the matching `COMPANION_MANIFEST`
fallback in `src/companion/updater.ts`. When aligned it writes nothing; API
errors, incomplete releases, invalid release identities, truncated downloads,
downgrades, and same-tag checksum changes fail closed, and it never builds
native code or rewrites an existing release.

It only needs public read access to the native repository: its own
`GITHUB_TOKEN` creates the PR in this repository, so no cross-repository write
token or repository-dispatch setup is required. Bot PRs need normal review and
merge, and their focused checks run inside the sync workflow because PRs
created with `GITHUB_TOKEN` do not trigger ordinary PR workflows.

Merge the generated manifest PR before shipping a plugin that requires the new
native release. Managed installs follow the version pinned in the installed
plugin, not whatever happens to be latest upstream.

### Companion release strategy

- Binaries ship as `companion-vX.Y.Z` GitHub Release assets in
  [oh-my-opencode-companion](https://github.com/alvinunreal/oh-my-opencode-companion/releases);
  GitHub Releases are the source of truth (R2 can mirror later).
- The companion is versioned separately from the plugin, so plugin betas do not
  require native rebuilds. `companion install` selects the archive for the
  current OS/arch, and the plugin ships the release plus SHA-256 in its manifest.
- Asset names are
  `oh-my-opencode-slim-companion-vX.Y.Z-<target>.tar.gz` (`.zip` for Windows),
  for `aarch64-apple-darwin`, `x86_64-apple-darwin`,
  `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, and
  `x86_64-pc-windows-msvc`.
- Native CI and the autonomous release workflow live in the companion
  repository. Sync metadata by hand with
  `gh workflow run companion-manifest-sync.yml --repo alvinunreal/oh-my-opencode-slim`;
  for local recovery run `bun run sync:companion-manifest`, then
  `bun run verify:companion-manifest` and `bun run verify:companion-release`.
### Local synchronization / recovery

```bash
# Discover latest public native release, hash downloads, update both copies.
bun run sync:companion-manifest

# Or download a specific, already published release and generate both copies.
mkdir -p /tmp/opencode/companion-assets
gh release download companion-v0.1.9 \
  --repo alvinunreal/oh-my-opencode-companion \
  --dir /tmp/opencode/companion-assets
node scripts/prepare-companion-release.mjs \
  --version=0.1.9 --assets-dir=/tmp/opencode/companion-assets

bun run verify:companion-manifest
bun run verify:companion-release
```

`prepare-companion-release.mjs` only writes the plugin manifests. It requires
all five published archives and never reads or changes Cargo files. Native
build/release recovery belongs in the native repository; never overwrite a
published native tag or archive. Publish a successor patch for corrections.

For version `X.Y.Z`, supported archives are:

```text
oh-my-opencode-slim-companion-vX.Y.Z-aarch64-apple-darwin.tar.gz
oh-my-opencode-slim-companion-vX.Y.Z-aarch64-unknown-linux-gnu.tar.gz
oh-my-opencode-slim-companion-vX.Y.Z-x86_64-apple-darwin.tar.gz
oh-my-opencode-slim-companion-vX.Y.Z-x86_64-pc-windows-msvc.zip
oh-my-opencode-slim-companion-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz
```

### Independent release guards

- `verify:companion-manifest` is **offline**: validates the version/tag,
  standalone repository, complete target set, SHA-256 syntax, and fallback/JSON
  consistency. No native checkout, local Companion tags, Cargo, or network.
- `verify:companion-release` is **online**: reads the exact pinned tag from the
  native repository, checks published release/repository identity and asset
  URLs, and compares all five downloaded archive hashes with the manifest.
  It does not use `latest` for provenance. A changed archive cannot silently
  replace the immutable release identity recorded by the tag plus checksums.

Both `npm version` (`preversion`) and `npm publish` (`prepublishOnly`) run these
guards. Public reads work without authentication; optional `GH_TOKEN` supplies
authenticated read rate limits. API/download failure blocks release. There is
no same-repository native-source drift gate: native source provenance and
release creation are owned by the autonomous native repository.

## Plugin release

### 1. Inspect the release diff and choose versions

Before writing release notes, inspect the actual changes from the previous
plugin tag:

```bash
git log --oneline --decorate <previous-plugin-tag>..HEAD
git diff --stat <previous-plugin-tag>..HEAD
git diff --name-only <previous-plugin-tag>..HEAD
```

Use the diff for release notes (Added, Changed, Fixed, Docs, CI,
Compatibility/migration notes, Publish notes). Choose the plugin version
independently of Companion; bump native only when its code or the required
state protocol/asset set changes.

### 2. Verify before tagging or publishing

```bash
bun run check:ci
bun run typecheck
bun test
bun test ./scripts/check-companion-release.test.ts ./scripts/companion-release-scripts.test.ts
bun run build
bun run verify:companion-manifest
bun run verify:companion-release
bun run verify:release
bun run verify:optional-loading
bun run verify:host-smoke
```

CI uses the Bun version pinned in `packageManager`, `bun ci`, JUnit/LCOV reports,
a non-blocking latest-Bun canary, package smoke for package-affecting PRs, and
scheduled pinned/latest OpenCode compatibility checks.

Inspect `git status --short`, `git diff`, and `git log --oneline -10`. Stage only
intended files. Commit/push release preparation before versioning.

### 3. Bump the plugin

```bash
npm version patch
```

`preversion` verifies Companion first. The `version` hook force-regenerates and
stages `src/generated/build-info.ts` **before** npm creates the version commit
and annotated tag. It never amends a tagged commit. Ordinary builds leave the
committed build stamp untouched.

If editing `package.json` manually, run `bun run gen:build-info` and include the
generated stamp in the version commit. Do **not** subsequently run `npm version`
or a `release:*` script: that would bump the version twice. Create the annotated
`v<version>` tag manually instead.

For the automatic chain, `bun run release:patch` runs `npm version patch`, pushes
with `git push --follow-tags`, then publishes. `release:minor`, `release:major`,
`release:beta`, and `release:beta:next` follow the same sequence with their
respective version/publish tags. These commands mutate remote state; review
pending changes and ensure the working tree is clean first.

### 4. Push tags and create the plugin GitHub release

```bash
git push --follow-tags
git ls-remote --tags origin v<version>
gh release create v<version> --title "v<version>" \
  --notes-file /tmp/opencode/plugin-release-notes.md
gh release view v<version>
```

If the plugin release already exists, use `gh release edit` with the same title
and notes file. Native releases belong only in the native repository.

### 5. Publish npm last

```bash
npm login
npm publish
npm view oh-my-opencode-slim version
```

Use `npm publish --tag beta` for beta releases. `prepublishOnly` builds the
package and runs both Companion guards. Verify the plugin tag and GitHub release
exist, the pinned native release has all expected assets, checks pass, and the
working tree is clean before publishing.
