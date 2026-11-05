/**
 * Cold-loading probe for scripts/verify-optional-loading.ts.
 *
 * Runs in a throwaway child process owned by the runner. Imports the built
 * server artifact, calls the shared plugin factory with a fake client, waits
 * for the enabled JSDOM startup work to land in the CJS cache, records
 * code/CPU/memory/import/init/disposal numbers plus the registered tool and
 * agent rosters, then disposes the instance. Never executes a feature:
 * webfetch is only registered, ACP uses a command string that is never run,
 * and the companion points at a binary that does not exist.
 *
 * Plain JavaScript on purpose: this file is executed by Node, not Bun.
 *
 * Usage: node optional-loading-probe.mjs <entry-path> <case-name>
 * Prints one JSON report line on stdout after disposal.
 */
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import v8 from 'node:v8';

const [entry, caseName] = process.argv.slice(2);
if (!entry || !caseName) {
  throw new Error(
    'usage: node optional-loading-probe.mjs <entry-path> <case-name>',
  );
}

const directory = process.env.OMOS_PROBE_DIRECTORY;
if (!directory) {
  throw new Error('OMOS_PROBE_DIRECTORY is required');
}

// No network is authorized while probing: override the global fetch so any
// attempt fails immediately and is counted. Set before the artifact import so
// module-scope captures of the global see the guard.
let fetchCalls = 0;
globalThis.fetch = () => {
  fetchCalls += 1;
  throw new Error('optional-loading probe: network fetch is not authorized');
};

const noop = async () => ({ data: [] });

const client = new Proxy(
  {
    session: new Proxy(
      {
        get: async (input) => ({ data: { id: input.path.id } }),
        messages: noop,
        status: async () => ({ data: {} }),
      },
      { get: (target, key) => Reflect.get(target, key) ?? noop },
    ),
    app: { log: noop },
  },
  {
    get: (target, key) =>
      Reflect.get(target, key) ?? new Proxy({}, { get: () => noop }),
  },
);

const startCpu = process.cpuUsage();
const startMemory = process.memoryUsage();
const started = performance.now();
const mod = await import(entry);
const imported = performance.now();
const hooks = await mod.default.server({
  client,
  directory,
  worktree: directory,
  serverUrl: new URL('http://127.0.0.1:4096'),
});
const initialized = performance.now();

// Shared CJS module cache, viewed from this ESM process. jsdom loads through
// a dynamic require inside the plugin, so its record shows up here.
const require = createRequire(new URL('file:///om_opencode_probe/'));

const hasLoadedJSDOM = () =>
  Object.keys(require.cache).some((key) =>
    key.endsWith('/jsdom/lib/api.js')
      ? require.cache[key]?.loaded === true
      : false,
  );

// The enabled JSDOM startup probe is complete once Node's CJS record for
// jsdom/lib/api.js is loaded. Bounded turns of the microtask/macrotask loop:
// no guessed sleep duration, and no wait at all when the feature is off.
let settleTurns = 0;
if (hooks?.tool?.webfetch) {
  for (; settleTurns < 500 && !hasLoadedJSDOM(); settleTurns += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
await new Promise((resolve) => setImmediate(resolve));
if (typeof globalThis.gc === 'function') globalThis.gc();
const settledAt = performance.now();
const settledCpu = process.cpuUsage(startCpu);
const settledMemory = process.memoryUsage();
const code = v8.getHeapCodeStatistics();
const jsdomLoaded = hasLoadedJSDOM();

const tools = Object.keys(hooks?.tool ?? {}).sort();
const agents = Object.keys(hooks?.agent ?? {}).sort();

const startedDisposal = performance.now();
await hooks?.dispose?.();
const disposed = performance.now();

console.log(
  JSON.stringify({
    case: caseName,
    importMs: +(imported - started).toFixed(2),
    initMs: +(initialized - imported).toFixed(2),
    settleMs: +(settledAt - initialized).toFixed(2),
    settleTurns,
    disposeMs: +(disposed - startedDisposal).toFixed(2),
    totalMs: +(disposed - started).toFixed(2),
    cpuUserMs: +(settledCpu.user / 1000).toFixed(2),
    cpuSystemMs: +(settledCpu.system / 1000).toFixed(2),
    rssDeltaMB: +((settledMemory.rss - startMemory.rss) / 1048576).toFixed(2),
    heapUsedDeltaMB: +(
      (settledMemory.heapUsed - startMemory.heapUsed) /
      1048576
    ).toFixed(2),
    externalDeltaMB: +(
      (settledMemory.external - startMemory.external) /
      1048576
    ).toFixed(2),
    codeAndMetadataMB: +(code.code_and_metadata_size / 1048576).toFixed(2),
    bytecodeAndMetadataMB: +(code.bytecode_and_metadata_size / 1048576).toFixed(
      2,
    ),
    externalScriptSourceMB: +(
      code.external_script_source_size / 1048576
    ).toFixed(2),
    jsdomLoaded,
    jsdomWaitEnabled: Boolean(hooks?.tool?.webfetch),
    fetchCalls,
    tools,
    agents,
  }),
);
