---
name: release-smoke-test
description: Test an oh-my-opencode-slim release candidate or bugfix before publishing. Use when validating a packed plugin artifact, release branch, crash fix, OpenCode runtime compatibility, or model-specific smoke test such as OpenCode 1.17.11 message transform regressions.
---

# Release Smoke Test

Use this skill to validate an `oh-my-opencode-slim` release candidate before
public npm publish. Test the packed artifact, not `@latest` and not the source
tree.

## Core Workflow

1. Start from the release-prep branch or commit.
2. Build and pack the candidate.
3. Install the tarball into a throwaway app.
4. Create an isolated OpenCode config pointing at the installed
   `node_modules/oh-my-opencode-slim/dist/index.js`.
5. Run `opencode debug config` and verify `plugin_origins` contains only the
   intended plugin when doing an isolation smoke.
6. Run non-pure `opencode run --print-logs --log-level DEBUG`.
7. Search isolated logs for the original crash signature.
8. Record exact artifact, model, OpenCode version, command shape, result, and
   limitations on the release issue or PR.

## Pack Candidate

Use a temp directory so release validation never depends on the local package
cache.

```bash
SMOKE=/tmp/oh-my-opencode-slim-release-smoke
rm -rf "$SMOKE"
mkdir -p "$SMOKE/pkg" "$SMOKE/app" "$SMOKE/home" "$SMOKE/xdg/opencode" "$SMOKE/run"

bun run build
npm pack --pack-destination "$SMOKE/pkg"
```

Install the tarball:

```bash
cd "$SMOKE/app"
bun init -y
bun add "$SMOKE/pkg"/oh-my-opencode-slim-*.tgz
node -p "require('./node_modules/oh-my-opencode-slim/package.json').version"
```

## Isolated Config

Write the minimal OpenCode config:

```bash
cat > "$SMOKE/xdg/opencode/opencode.json" <<EOF
{
  "model": "opencode/deepseek-v4-flash-free",
  "plugin": [
    "file://$SMOKE/app/node_modules/oh-my-opencode-slim/dist/index.js"
  ],
  "agent": {
    "orchestrator": {
      "model": "opencode/deepseek-v4-flash-free"
    }
  }
}
EOF
```

Use `env -i` for the cleanest smoke. This strips host `OPENCODE_*`, `ORCA_*`,
and project overlay variables that can silently add plugins or provider aliases.

```bash
env -i PATH="$PATH" HOME="$SMOKE/home" XDG_CONFIG_HOME="$SMOKE/xdg" \
  opencode debug config
```

Confirm:

- `plugin_origins` has exactly one entry.
- That entry points to the temp app's packed `dist/index.js`.
- The model is the one intended for the smoke.

If OpenCode needs provider aliases from the host environment, run a second
non-isolated model-specific smoke and clearly label it as weaker isolation.

## Runtime Smoke

Run the actual prompt with timeout:

```bash
env -i PATH="$PATH" HOME="$SMOKE/home" XDG_CONFIG_HOME="$SMOKE/xdg" \
  timeout 120 \
  opencode run --print-logs --log-level DEBUG "Say OK only."
```

Expected result:

```text
OK
```

Search logs for the bug signature. For the OpenCode 1.17.11 malformed-message
crash, use:

```bash
rg "message\\.info\\.role|undefined is not an object|Cannot read properties of undefined|TypeError" \
  "$SMOKE/home/.local/share/opencode/log" -n 2>/dev/null || true
```

No matches should appear.

## OpenAI / Host-Provider Smoke

If the fully isolated environment cannot resolve OpenAI provider aliases, run a
separate host-provider smoke while keeping the plugin path pointed at the
tarball install.

```bash
mkdir -p "$SMOKE/config"
cat > "$SMOKE/config/opencode.json" <<EOF
{
  "model": "openai/gpt-5.6-fast",
  "plugin": [
    "file://$SMOKE/app/node_modules/oh-my-opencode-slim/dist/index.js"
  ],
  "agent": {
    "orchestrator": {
      "model": "openai/gpt-5.6-fast"
    }
  }
}
EOF

OPENCODE_CONFIG_DIR="$SMOKE/config" \
  timeout 120 \
  opencode run --print-logs --log-level DEBUG "Say OK only."
```

Report this as a host-provider smoke because existing project, user, or Orca
OpenCode config may still merge in. Use `opencode debug config` to disclose
what else loaded.

## Reporting Template

```markdown
## Release-candidate smoke validation

- Commit under test:
- Tarball:
- Installed package version:
- OpenCode version:
- Config isolation: sanitized `env -i` / host-provider
- Plugin origin:
- Model:
- Command:
- Result:
- Crash signature search:
- Limitations:
```