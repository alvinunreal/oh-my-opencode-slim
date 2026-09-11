# Clonedeps

![Clonedeps dependency source workspace](../img/clonedeps.jpg)

`clonedeps` is a bundled Orchestrator skill for cloning a small set of important
dependency source repositories into a local, ignored workspace so agents can
inspect library internals while working on your project.

It is useful when docs are not enough and the agent needs to understand how a
runtime, SDK, framework, plugin API, or other core dependency actually behaves.

---

## What It Does

When you ask for cloned dependency source, the Orchestrator:

1. Checks `.slim/clonedeps.json` first and reuses existing clones when possible.
2. Asks `@librarian` for source-repo recommendations only if more context is
   needed.
3. Presents a small clone plan for approval.
4. Clones each approved source repository once into
   `.slim/clonedeps/repos/<safe-repo-name>/`.
5. Writes `.slim/clonedeps.json` as trackable project metadata.
6. Updates ignore files so git ignores clone contents while OpenCode can read
   them.
7. Updates root `AGENTS.md` with a concise list of cloned repos and why each one
   exists.

There is intentionally no helper script. The workflow uses agent judgment for
source selection and normal git/filesystem operations for cloning.

---

## How To Use It

Ask the Orchestrator directly:

```text
Use clonedeps to clone the key dependency source repos for this project.
```

Or for a specific dependency/debugging task:

```text
Use clonedeps for the OpenCode SDK so you can inspect its plugin API internals.
```

The Orchestrator should show you what it wants to clone before running network
git operations, unless you explicitly ask it to clone immediately.

---

## Files It Creates

### `.slim/clonedeps/repos/`

Ignored local clones live here, one folder per source repository:

```text
.slim/clonedeps/repos/<safe-repo-name>/
```

The safe folder name is based on the repository owner/name, not the package
name, and may include a pinned-release suffix when multiple revisions need to
coexist. For example, the TypeScript OpenCode repository
`https://github.com/anomalyco/opencode.git` becomes
`.slim/clonedeps/repos/anomalyco__opencode-v1.18.13/` when pinned to that
release. This project also keeps a separate
`.slim/clonedeps/repos/opencode/` checkout of the OpenCode `beta` source for
intentional v2 migration work. That checkout is tracked as source by its branch
and commit, not as an npm-pinned dependency.

If multiple packages come from the same monorepo, they share one cloned repo path
and use different `packagePath` values in the manifest.

These repositories are read-only reference source. Do not edit them.

### `.slim/clonedeps.json`

This is the structured manifest. It is intentionally small and committable. The
following abbreviated example shows the OpenCode entries; other manifest entries
are omitted:

```json
{
  "version": "1.0.0",
  "updatedAt": "2026-08-04T19:15:39.000Z",
  "dependencies": [
    {
      "name": "@opencode-ai/plugin",
      "resolvedVersion": "1.18.13",
      "repoUrl": "https://github.com/anomalyco/opencode.git",
      "ref": "v1.18.13@a105350812f05f914c768e468559dbd6bd508d8e",
      "path": ".slim/clonedeps/repos/anomalyco__opencode-v1.18.13",
      "packagePath": "packages/plugin",
      "reason": "Plugin API source used by the project"
    },
    {
      "name": "@opencode-ai/sdk",
      "resolvedVersion": "1.18.13",
      "repoUrl": "https://github.com/anomalyco/opencode.git",
      "ref": "v1.18.13@a105350812f05f914c768e468559dbd6bd508d8e",
      "path": ".slim/clonedeps/repos/anomalyco__opencode-v1.18.13",
      "packagePath": "packages/sdk/js",
      "reason": "Core SDK source used to inspect runtime behavior"
    },
    {
      "name": "anomalyco/opencode",
      "resolvedVersion": "beta",
      "repoUrl": "https://github.com/anomalyco/opencode.git",
      "ref": "beta@d6deb62379c54dc60468b80c498bd6a5899797cf",
      "path": ".slim/clonedeps/repos/opencode",
      "packagePath": "packages/plugin",
      "reason": "OpenCode v2 plugin SDK and runtime source for the v2 migration"
    }
  ]
}
```

The actual manifest may contain additional dependency entries beyond this
abbreviated example.

The beta entry is a checked-out source reference: `resolvedVersion` identifies
the beta channel, while `ref` records the branch and commit. It does not pin an
npm package version.

Future clonedeps runs read this file first instead of starting from a fresh scan.

### `AGENTS.md`

The skill also keeps a short `## Cloned Dependency Source` section in the repo
root `AGENTS.md`, listing the cloned repo paths directly so future agents do not
need to read the manifest just to know what exists.

Example:

```markdown
## Cloned Dependency Source

Read-only dependency source repositories are available under
`.slim/clonedeps/repos/` for inspection. Do not edit these clones.

- `.slim/clonedeps/repos/anomalyco__opencode-v1.18.13/` -
  `anomalyco/opencode` at
  `v1.18.13@a105350812f05f914c768e468559dbd6bd508d8e`; inspect `packages/plugin` and
  `packages/sdk/js` for OpenCode plugin and SDK internals.
- `.slim/clonedeps/repos/opencode/` - `anomalyco/opencode` at
  `beta@d6deb62379c54dc60468b80c498bd6a5899797cf`; inspect the checked-out beta
  source as an intentional OpenCode v2 migration reference. This is not an
  npm-pinned dependency.
```

---

## Safety Defaults

- Prefer **0-3 strong recommendations** over a dependency dump.
- Clone at most **3-5 core dependencies** by default.
- Use HTTPS repository URLs by default.
- Prefer pinned tags or commit SHAs.
- Do not run install, build, test, or lifecycle scripts from cloned repos.
- Git ignores `.slim/clonedeps/repos/`, but not `.slim/clonedeps.json`.
- Ignore-file edits are limited to managed clonedeps marker blocks.

---

## When To Use It

Use clonedeps when source code is likely to answer questions better than docs:

- debugging SDK or framework behavior;
- implementing against plugin/runtime APIs;
- checking version-specific internals;
- understanding generated types, adapters, or protocol code;
- working with dependencies whose docs are incomplete or stale.

Do not use it for ordinary documentation lookup, tiny utilities, transitive
dependencies, or packages where public docs are sufficient.
