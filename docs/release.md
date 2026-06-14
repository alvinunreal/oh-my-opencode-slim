# Release Process

This project has two related release tracks:

- **Plugin release**: the npm package version from `package.json`, tagged as
  `v<version>` and published to npm.
- **Companion release**: native desktop binaries, tagged as
  `companion-v<version>` and uploaded as GitHub Release assets.

The companion uses separate versioning so the plugin can ship patches without
rebuilding native binaries every time.

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

## 3. Update companion references

When releasing a new companion binary, update the installer constants:

```ts
// src/cli/companion.ts
const COMPANION_VERSION = '0.1.3';
const COMPANION_TAG = 'companion-v0.1.3';
```

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
linux-x64
linux-arm64
windows-x64
```

Expected release asset names for companion `0.1.3`:

```text
oh-my-opencode-slim-companion-v0.1.3-aarch64-apple-darwin.tar.gz
oh-my-opencode-slim-companion-v0.1.3-x86_64-unknown-linux-gnu.tar.gz
oh-my-opencode-slim-companion-v0.1.3-aarch64-unknown-linux-gnu.tar.gz
oh-my-opencode-slim-companion-v0.1.3-x86_64-pc-windows-msvc.zip
```

## 4. Build and publish companion assets

Trigger the manual workflow:

```bash
gh workflow run companion-release.yml \
  -f version=0.1.3 \
  -f targets=macos-arm64,linux-x64,linux-arm64,windows-x64
```

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

If the release already exists, upload with clobber:

```bash
gh release upload companion-v0.1.3 \
  /tmp/companion-v0.1.3-assets/* \
  --clobber
```

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

That creates the version commit and `v<version>` tag automatically.

## 6. Verify before tagging or publishing

Run the standard checks:

```bash
bun run check:ci
bun run typecheck
bun test
bun run build
bun run verify:release
cd companion && cargo fmt --all --check && cargo check && cargo test && cargo build --release
```

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
src/cli/companion.ts
src/cli/companion.test.ts
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
- `src/cli/companion.ts` points to `companion-v0.1.3`.
- Git tag `v2.0.3` exists on origin.
- GitHub release `v2.0.3` exists.
- GitHub release `companion-v0.1.3` exists with the expected assets.
- Working tree is clean.
- `bun run check:ci`, `bun run typecheck`, `bun test`, and `bun run build` pass.
- npm publish is run only after the GitHub release and companion assets are ready.
