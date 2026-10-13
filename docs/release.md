# Release Process

This project has two related release tracks:

- **Plugin release**: the npm package version from `package.json`, tagged as
  `v<version>` and published to npm.
- **Companion release**: native desktop binaries, tagged as
  `companion-v<version>` and uploaded as GitHub Release assets.

The companion uses separate versioning so the plugin can ship patches without
rebuilding native binaries every time.

## Automatic native Companion release (default)

When native Companion sources change on `master`, the
[`Companion Auto Release`](../.github/workflows/companion-auto-release.yml)
workflow compares the tracked runtime inputs (including embedded animations)
against the most recent `companion-vX.Y.Z` release tag. It also verifies that
the release actually contains all five platform archives. When native sources
are unchanged, the release is complete, and the packaged manifest is already
aligned, the workflow does nothing.

GitHub release lookup is fail-closed: missing or incomplete releases are
handled as release work, but API outages, authentication errors, rate limits,
and malformed responses do not trigger a new version. The lookup retries
transient failures before reporting an error. An incomplete released tag is
not overwritten; recovery uses a successor immutable patch.

When native source changes require a release, the workflow automatically:

1. Chooses the next Companion patch version and runs the reusable
   [native release workflow](../.github/workflows/companion-release.yml) for
   all five supported platforms.
2. Stamps the release version into Cargo.toml/Cargo.lock in the build jobs
   and into the immutable Git tag, so the tag identifies the actual sources.
3. Publishes the GitHub release without overwriting an existing tag or binary.
4. Downloads the **published** archives, computes SHA-256 hashes, and
   generates matching JSON and TypeScript manifests along with the Cargo
   version update.
5. Runs release-manifest, native-source, lint, typecheck, and test validation,
   then opens a bot PR with the synchronized manifest.

**Crash recovery:** Every six hours (and on manual dispatch), the workflow
rechecks the latest release. If a tag exists but its GitHub Release is missing
or contains fewer than five archives, the next patch version is built rather
than rewriting an immutable tag. If all archives are present but the manifest
is still behind, the workflow resumes only the manifest stage; it reuses an
existing sync branch/PR when available, avoiding repeated rebuilds.
Native `cargo build` uses `--locked` on all five targets so dependency
resolution agrees with the tagged `Cargo.lock`.

Merge that generated PR before publishing the next plugin npm version.
The normal `npm version` (via `preversion`) and `npm publish` (via
`prepublishOnly`) paths both **fail closed** if any release-relevant native
code, dependency, or bundled asset differs from the manifest's native tag.
They also fail if the tag is unavailable (run `git fetch --tags origin`).
This prevents another 0.1.3-to-0.1.4 or post-#1477 silent mismatch.

**One-time repository prerequisite:** give GitHub Actions write permission to
repository contents and enable **Allow GitHub Actions to create and approve
pull requests** in Actions settings. If that permission is not enabled, the
published native release remains available, but the bot's manifest branch is
left for maintainers and the workflow reports a failure instead of pretending
the handoff completed. Generated PRs require normal review and merge.

The manual instructions below are for recovery or exceptional targeted builds,
not a required routine step. A plugin-only change does not rebuild Companion.

## 1. Inspect the release diff

Before writing release notes, inspect the actual changes between the previous
plugin tag and the new plugin tag or release branch state.

```bash
git log --oneline --decorate v2.0.0..HEAD
git diff --stat v2.0.0..HEAD
git diff --name-only v2.0.0..HEAD
```

Use that diff to write the GitHub release body. Do not rely on memory.

Recommended release note sections:

- Added
- Changed
- Fixed
- Docs
- CI
- Compatibility / migration notes
- Publish notes

## 2. Choose versions

Pick versions independently:

```text
plugin: 2.0.3
plugin tag: v2.0.3

companion: 0.1.3
companion tag: companion-v0.1.3
```

Use a plugin patch release for ordinary bug fixes and release-process fixes.
Only bump the companion when the Rust companion changes or the plugin expects a
new companion state protocol or asset set.

## 3. Update companion references (manual fallback)

When releasing a new companion binary, update the packaged companion manifest:

```json
// src/companion/companion-manifest.json
{
  "version": "0.1.3",
  "tag": "companion-v0.1.3",
  "repo": "alvinunreal/oh-my-opencode-slim",
  "checksums": {
    "oh-my-opencode-slim-companion-v0.1.3-aarch64-apple-darwin.tar.gz": "..."
  }
}
```

The installer and updater read the packaged JSON manifest at runtime. Keep the
matching fallback constant in `src/companion/updater.ts` synchronized with the
JSON manifest; tests cover this sync.

Also update the Rust crate version:

```toml
# companion/Cargo.toml
version = "0.1.3"
```

Regenerate or update `companion/Cargo.lock` so the package entry matches.

Update companion documentation in:

- `docs/companion.md`
- `docs/configuration.md`

Supported companion workflow target names:

```text
macos-arm64
macos-x64
linux-x64
linux-arm64
windows-x64
```

Expected release asset names for companion `0.1.3`:

```text
oh-my-opencode-slim-companion-v0.1.3-aarch64-apple-darwin.tar.gz
oh-my-opencode-slim-companion-v0.1.3-x86_64-apple-darwin.tar.gz
oh-my-opencode-slim-companion-v0.1.3-x86_64-unknown-linux-gnu.tar.gz
oh-my-opencode-slim-companion-v0.1.3-aarch64-unknown-linux-gnu.tar.gz
oh-my-opencode-slim-companion-v0.1.3-x86_64-pc-windows-msvc.zip
```

## 4. Build and publish companion assets (manual fallback)

Trigger the manual workflow from the release-prep ref that contains the
Companion changes. Building from the prep ref lets you publish the native
assets, copy their final digests into the manifest, and only then merge a
self-consistent release change:

```bash
gh workflow run companion-release.yml \
  --ref <release-prep-branch> \
  -f version=0.1.3 \
  -f targets=macos-arm64,macos-x64,linux-x64,linux-arm64,windows-x64
```

The manual workflow publishes the GitHub release **only when all five targets**
are built. Partial target runs are for debugging: they upload workflow artifacts
but cannot create an incomplete immutable public Companion version.

Watch the run:

```bash
gh run list --workflow companion-release.yml --limit 5
gh run watch <run-id>
```

Verify the companion release:

```bash
gh release view companion-v0.1.3
```

Download assets for a local sanity check:

```bash
mkdir -p /tmp/companion-v0.1.3-assets
gh release download companion-v0.1.3 \
  --dir /tmp/companion-v0.1.3-assets
```

Confirm the asset list matches the installer targets before publishing the
plugin package that points to this companion tag.

Copy each asset's SHA256 digest into `src/companion/companion-manifest.json`.
GitHub release asset metadata reports these as `digest: sha256:<hash>`; store
only the hash value in the manifest. Then mirror the same values in the fallback
`COMPANION_MANIFEST` constant in `src/companion/updater.ts`.

Before merging the release prep or publishing the plugin, run:

```bash
bun run verify:companion-manifest
```

The verifier fails if the Rust crate version, manifest version/tag, supported
asset names, SHA256 values, or TypeScript fallback manifest drift apart.
`npm publish` runs that manifest verification **and** `verify:companion-source`
through `prepublishOnly`; `npm version` runs the source guard through
`preversion`. Unlike the manifest-only check, the source guard detects native
Rust/assets/dependency edits made after the release tag.

### Manual companion upload fallback

If the workflow builds artifacts successfully but the release upload step fails,
download the workflow artifacts and upload them manually:

```bash
gh run download <run-id> \
  --dir /tmp/companion-v0.1.3-assets

gh release create companion-v0.1.3 \
  --title "Companion v0.1.3" \
  --notes "Manual companion binary release for oh-my-opencode-slim." \
  /tmp/companion-v0.1.3-assets/*
```

Never overwrite a published Companion version. If release assets are wrong,
ship a new patch version with a new immutable tag instead.

Then verify:

```bash
gh release view companion-v0.1.3
```

## 5. Bump the plugin package

For a stable patch, update `package.json`:

```json
{
  "version": "2.0.3"
}
```

If you manually edit the version, do **not** later run `bun run release:patch` or
`npm version patch`, because that would bump the package again.

If you have not manually edited the version, use npm's version command instead:

```bash
npm version patch
```

That creates the version commit and annotated `v<version>` tag automatically.
The package's `version` lifecycle hook runs after npm updates `package.json` but
before npm creates the commit and tag. It force-regenerates
`src/generated/build-info.ts` with the new package version and stages it, so the
version commit and tag both point to the commit containing the generated stamp.
The hook does not amend or otherwise rewrite the commit after tagging.

For the automatic patch release chain, `bun run release:patch` runs
`npm version patch`, pushes the current branch and its annotated version tag
with `git push --follow-tags`, then publishes to npm. Review the pending release
changes and ensure the working tree is clean before running it; this command
performs both the push and npm publish. The `release:minor`, `release:major`,
`release:beta`, and `release:beta:next` scripts follow the same sequence with
their respective npm version and publish tags.

If you bumped the version manually, run `bun run gen:build-info` (the version
change triggers the rewrite) and include the generated file in the version
commit. Ordinary `bun run build` runs leave the committed stamp untouched, so
building never dirties the git tree.

## 6. Verify before tagging or publishing

Run the standard checks:

```bash
bun run check:ci
bun run typecheck
bun test
bun run build
bun run verify:companion-manifest
bun run verify:companion-source
```

CI installs the Bun version pinned by `packageManager` in `package.json` and
uses `bun ci` so lockfile drift fails instead of rewriting `bun.lock`. Required
CI uploads JUnit and LCOV reports. A non-blocking latest-Bun canary reports
upcoming runtime incompatibilities, package smoke runs for package-affecting
pull requests, and the scheduled OpenCode compatibility workflow checks both
the pinned supported host and latest host canary.

Before committing or tagging, inspect:

```bash
git status --short
git diff
git log --oneline -10
```

## 7. Commit and push release prep

Stage only intended files. Typical files for a companion-backed plugin patch:

```text
.github/workflows/companion-release.yml
companion/Cargo.toml
companion/Cargo.lock
docs/companion.md
docs/configuration.md
package.json
src/companion/companion-manifest.json
src/companion/updater.ts
```

Commit and push:

```bash
git add <intended-files>
git commit -m "chore: prepare companion 0.1.3 release"
git push
```

## 8. Create and push the plugin tag

If `npm version` created the tag, push it:

```bash
git push --follow-tags
```

If the package version was edited manually, create and push the tag yourself:

```bash
git tag -a v2.0.3 -m "v2.0.3"
git push origin v2.0.3
```

Verify the tag exists remotely:

```bash
git ls-remote --tags origin v2.0.3
```

## 9. Create the GitHub plugin release

Use release notes based on the actual git diff.

```bash
gh release create v2.0.3 \
  --title "v2.0.3" \
  --notes-file /tmp/oh-my-opencode-slim-v2.0.3-notes.md
```

If a release already exists, update it:

```bash
gh release edit v2.0.3 \
  --title "v2.0.3" \
  --notes-file /tmp/oh-my-opencode-slim-v2.0.3-notes.md
```

Verify:

```bash
gh release view v2.0.3
```

## 10. Publish npm

Publishing is the final step and requires npm authentication:

```bash
npm login
npm publish
```

After publishing, verify the package version:

```bash
npm view oh-my-opencode-slim version
```

## 11. Current v2.0.3 release checklist

For the `2.0.3` / `companion-v0.1.3` release, the completed state should be:

- `package.json` version is `2.0.3`.
- `src/companion/companion-manifest.json` points to `companion-v0.1.3`.
- Git tag `v2.0.3` exists on origin.
- GitHub release `v2.0.3` exists.
- GitHub release `companion-v0.1.3` exists with the expected assets.
- Working tree is clean.
- `bun run check:ci`, `bun run typecheck`, `bun test`, `bun run build`, and
  `bun run verify:companion-manifest` pass.
- npm publish is run only after the GitHub release and companion assets are ready.
