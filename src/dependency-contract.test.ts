import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

type PackageManifest = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  version?: string;
};

async function readManifest(relativePath: string): Promise<PackageManifest> {
  return (await Bun.file(
    new URL(relativePath, import.meta.url),
  ).json()) as PackageManifest;
}

const rootManifest = await readManifest('../package.json');
const openCodePluginManifest = await readManifest(
  '../node_modules/@opencode-ai/plugin/package.json',
);
const openTuiSolidManifest = await readManifest(
  '../node_modules/@opentui/solid/package.json',
);

describe('dependency compatibility contract', () => {
  test('keeps OpenCode plugin and SDK on one exact version', () => {
    const pluginVersion = rootManifest.dependencies?.['@opencode-ai/plugin'];
    const sdkVersion = rootManifest.dependencies?.['@opencode-ai/sdk'];

    expect(pluginVersion).toBeDefined();
    expect(pluginVersion).toBe(sdkVersion);
    expect(openCodePluginManifest.version).toBe(pluginVersion);
    expect(openCodePluginManifest.dependencies?.['@opencode-ai/sdk']).toBe(
      sdkVersion,
    );
  });

  test('pins one compatible OpenTUI and Solid family', () => {
    const coreVersion = rootManifest.optionalDependencies?.['@opentui/core'];
    const solidVersion = rootManifest.optionalDependencies?.['@opentui/solid'];
    const solidJsVersion = rootManifest.optionalDependencies?.['solid-js'];

    expect(coreVersion).toBeDefined();
    expect(coreVersion).toBe(solidVersion);
    expect(openTuiSolidManifest.version).toBe(solidVersion);
    expect(openTuiSolidManifest.dependencies?.['@opentui/core']).toBe(
      coreVersion,
    );
    expect(openTuiSolidManifest.peerDependencies?.['solid-js']).toBe(
      solidJsVersion,
    );

    for (const packageName of ['@opentui/core', '@opentui/solid']) {
      const peerRange = openCodePluginManifest.peerDependencies?.[packageName];
      const installedVersion = rootManifest.optionalDependencies?.[packageName];
      expect(peerRange).toBeDefined();
      expect(installedVersion).toBeDefined();
      expect(
        Bun.semver.satisfies(installedVersion ?? '', peerRange ?? ''),
      ).toBe(true);
    }
  });
});

/**
 * Process-boundary contract (NFR-2 / I1): pane lifecycle code runs in the
 * client (TUI) process only. The server entry must not reach the client
 * lifecycle core or any multiplexer adapter through its import graph — a
 * server that can reach adapters can create/close/locate panes, which the
 * spec forbids ("server 侧无 pane 操作路径").
 *
 * Mutation check (3.10 self-proof): adding `import './multiplexer/client/index'`
 * (or any adapter import) to `src/index.ts` makes these tests fail with the
 * offending import chain; removing it restores green.
 */

const SRC_DIR = import.meta.dir;
const SERVER_ENTRY = path.join(SRC_DIR, 'index.ts');
const MULTIPLEXER_CLIENT_DIR = `${path.join(SRC_DIR, 'multiplexer', 'client')}${path.sep}`;
const ADAPTER_DIRS = ['tmux', 'zellij', 'herdr', 'kitty', 'cmux'].map(
  (dir) => `${path.join(SRC_DIR, 'multiplexer', dir)}${path.sep}`,
);

/**
 * Import specifiers of one module: static `import ... from`, `export ... from`
 * (including multi-line clauses), side-effect `import '...'`, and dynamic
 * `import('...')`. The `(?!;)` guard keeps the scan inside one statement.
 */
const SPECIFIER_PATTERNS = [
  /^[ \t]*(?:import|export)\b(?:(?!;)[\s\S])*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^[ \t]*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function extractImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

/** Resolve a relative specifier to a `.ts` file, or null (external/missing). */
function resolveRelativeImport(
  fromFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next resolution candidate.
    }
  }
  return null;
}

/**
 * Breadth-first walk of the relative-import graph starting at `entry`.
 * Returns every reachable file mapped to the file that imported it.
 */
function collectDependencyGraph(entry: string): Map<string, string | null> {
  const parents = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const specifier of extractImportSpecifiers(source)) {
      const resolved = resolveRelativeImport(file, specifier);
      if (!resolved || parents.has(resolved)) continue;
      parents.set(resolved, file);
      queue.push(resolved);
    }
  }

  return parents;
}

/** `index.ts -> a.ts -> b.ts` chain for a reachable file, for failure output. */
function importChain(
  graph: Map<string, string | null>,
  target: string,
): string[] {
  const chain: string[] = [];
  let current: string | null | undefined = target;
  while (current) {
    chain.unshift(path.relative(SRC_DIR, current));
    current = graph.get(current);
  }
  return chain;
}

describe('server entry dependency graph (pane process boundary)', () => {
  const graph = collectDependencyGraph(SERVER_ENTRY);
  const reachable = [...graph.keys()];

  test('walker resolves the server entry dependency surface', () => {
    const reachableSet = new Set(reachable);
    // Guards against a vacuous pass: if import resolution breaks, the graph
    // would be tiny and the boundary assertions below would prove nothing.
    expect(reachableSet.has(path.join(SRC_DIR, 'hooks', 'index.ts'))).toBe(
      true,
    );
    expect(reachableSet.has(path.join(SRC_DIR, 'config', 'index.ts'))).toBe(
      true,
    );
    expect(reachableSet.has(path.join(SRC_DIR, 'utils', 'index.ts'))).toBe(
      true,
    );
    expect(reachable.length).toBeGreaterThan(50);
  });

  test('server entry never reaches client-side pane code', () => {
    const offenders = reachable
      .filter((file) => file.startsWith(MULTIPLEXER_CLIENT_DIR))
      .map((file) => importChain(graph, file));

    expect(offenders).toEqual([]);
  });

  test('server entry never reaches a multiplexer adapter', () => {
    const offenders = reachable
      .filter((file) => ADAPTER_DIRS.some((dir) => file.startsWith(dir)))
      .map((file) => importChain(graph, file));

    expect(offenders).toEqual([]);
  });
});
