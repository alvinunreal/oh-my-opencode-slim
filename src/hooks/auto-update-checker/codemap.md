# src/hooks/auto-update-checker/

## Responsibility

- Provides an OpenCode hook that reacts to `session.created`, ensures the hook only runs once per startup, and surfaces update information to the user via TUI toasts and logs.
- Detects local development builds, cached installs, and running plugins pinned to specific versions so the hook can decide whether to notify, auto-update, or skip work.

## Design

- `index.ts` orchestrates the hook lifecycle: it filters session events, defers the heavy work via `setTimeout`, and delegates version discovery and updates to helper functions while respecting the user’s `autoUpdate` and `showStartupToast` preferences.
- `checker.ts` encapsulates environment-aware utilities (config path discovery, local dev detection, NPM registry fetching, and pinned-version mutation) plus memoized cache lookups so the hook can derive current, cached, and latest versions without duplicating logic.
- `cache.ts` is responsible for invalidating cached installs (`node_modules`, `package.json`, `bun.lock`) before a fresh `bun install`, keeping the cached package state consistent with the server-provided latest version.
- Shared `constants.ts` standardizes paths (cache directory, config locations, package name, registry URL) and fetch timeouts so the rest of the hook is configuration-free.

## Flow

- On the first `session.created` event without a parent session, `createAutoUpdateCheckerHook` schedules `runBackgroundUpdateCheck` while immediately showing an initial toast (unless disabled) and short-circuiting for local dev builds.
- `runBackgroundUpdateCheck` resolves the current plugin entry and cached version, determines the update channel via `extractChannel`, retrieves the latest dist-tag from `getLatestVersion`, and compares versions.
- When an update is available, the hook either notifies the user or, if `autoUpdate` is on, updates the pinned entry in the OpenCode config (`updatePinnedVersion`), invalidates the cached package, and runs `bun install` safely (`runBunInstallSafe`) with a 60-second timeout before showing success/error toasts.
- `checker.ts` supports the above flow with helpers (`getLocalDevVersion`, `findPluginEntry`, `getCachedVersion`, `extractChannel`, etc.) that read configs (`.opencode/*.jsonc`, global config paths) via `stripJsonComments` and `fs` operations.
- `cache.ts` runs before reinstall to remove lingering plugin directories, dependency entries, and JSON-formatted `bun.lock` references, ensuring `runBunInstallSafe` operates on a clean slate.

## Integration

- Hooks into the OpenCode plugin lifecycle via `ctx.client.tui.showToast` and the `session.created` event, leveraging `PluginInput` to know the working directory and show UI feedback.
- Reads OpenCode configuration files exposed by `../../cli/config-manager` to locate plugin entries, pinned versions, and local `file://` installs, so it stays aligned with the same config sources that enable plugin loading.
- Uses shared `../../utils/logger` for tracing background operations and errors while talking to platform APIs (`fetch`, `Bun.spawn`, `fs`) to inspect, mutate, and reinstall the `omoslim` package stored under `CACHE_DIR`.
- Exposes `AutoUpdateCheckerOptions` for consumers (via `index.ts`) to opt out of toasts or automatic installs while still reusing the same checker/cache helpers.
