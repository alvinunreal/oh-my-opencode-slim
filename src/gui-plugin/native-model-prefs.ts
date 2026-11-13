import type { NativeModelPrefs } from './rpc';

/**
 * OpenCode Desktop keeps model favorites and recents in its local persistence
 * database (`drafts.sqlite`, table `state`, row name `opencode.global.dat`,
 * key `model`). The public plugin SDK does not expose them, so the Desktop GUI
 * main process reads that one row read-only.
 *
 * The DB schema is app-internal and may change between releases. Every failure
 * is non-fatal: the picker simply falls back to the server's model list. This
 * module intentionally has no top-level Node/Electron imports so the window
 * bundle can load it without evaluating main-only APIs; only the main process
 * calls the reader.
 */

const CACHE_MS = 60_000;
const MAX_ENTRIES = 200;

async function electronUserDataDir(): Promise<string | undefined> {
  const read = (electron: { app?: { getPath?: (name: string) => string } }) => {
    const path = electron.app?.getPath?.('userData');
    return typeof path === 'string' && path.trim() ? path : undefined;
  };
  try {
    // Keep Electron out of static resolution: tsconfig is shared with window
    // code and Electron is only present in the Desktop main process.
    const electronSpec = 'electron';
    const electron = (await import(/* @vite-ignore */ electronSpec)) as {
      app?: { getPath?: (name: string) => string };
    };
    const path = read(electron);
    if (path) return path;
  } catch {
    // Fall through to the CommonJS main-process require.
  }
  try {
    const commonjs = (
      process as unknown as {
        mainModule?: { require?: (id: string) => unknown };
      }
    ).mainModule;
    const electron = commonjs?.require?.('electron') as
      | { app?: { getPath?: (name: string) => string } }
      | undefined;
    if (electron) {
      const path = read(electron);
      if (path) return path;
    }
  } catch {
    // Not Electron (for example an old server-side registration).
  }
  return undefined;
}

async function fallbackUserDataDir(): Promise<string> {
  const [{ homedir }, { join }] = await Promise.all([
    import('node:os'),
    import('node:path'),
  ]);
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    return appData
      ? join(appData, 'ai.opencode.desktop')
      : join(homedir(), 'AppData', 'Roaming', 'ai.opencode.desktop');
  }
  if (process.platform === 'darwin') {
    return join(
      homedir(),
      'Library',
      'Application Support',
      'ai.opencode.desktop',
    );
  }
  const configHome = process.env.XDG_CONFIG_HOME?.trim();
  return join(configHome || join(homedir(), '.config'), 'ai.opencode.desktop');
}

function normalize(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { providerID?: unknown; modelID?: unknown };
  if (
    typeof record.providerID !== 'string' ||
    typeof record.modelID !== 'string'
  ) {
    return undefined;
  }
  const provider = record.providerID.trim();
  const model = record.modelID.trim();
  if (!provider || !model) return undefined;
  return `${provider}/${model}`;
}

function listOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value) {
    const id = normalize(entry);
    if (id && !result.includes(id)) result.push(id);
    if (result.length >= MAX_ENTRIES) break;
  }
  return result;
}

interface Driver {
  get(key: string): unknown;
  close(): void;
}

async function openDraftsDb(path: string): Promise<Driver | undefined> {
  // Bun ships bun:sqlite; Electron/Node hosts get node:sqlite.
  try {
    const bunSpec = 'bun:sqlite';
    const bun = (await import(/* @vite-ignore */ bunSpec)) as {
      Database: new (
        path: string,
        options: { readonly: boolean },
      ) => {
        query(sql: string): { get(...params: unknown[]): unknown };
        close(): void;
      };
    };
    const db = new bun.Database(path, { readonly: true });
    return {
      get: (key) =>
        db
          .query('select value from state where name = ? and key = ?')
          .get('opencode.global.dat', key),
      close: () => db.close(),
    };
  } catch {
    // Not Bun, or bun:sqlite changed; try Node.
  }
  try {
    const nodeSpec = 'node:sqlite';
    const node = (await import(/* @vite-ignore */ nodeSpec)) as {
      DatabaseSync: new (
        path: string,
        options: { readOnly: boolean },
      ) => {
        prepare(sql: string): { get(...params: unknown[]): unknown };
        close(): void;
      };
    };
    const db = new node.DatabaseSync(path, { readOnly: true });
    return {
      get: (key) =>
        db
          .prepare('select value from state where name = ? and key = ?')
          .get('opencode.global.dat', key),
      close: () => db.close(),
    };
  } catch {
    return undefined;
  }
}

/**
 * Create the read-only reader. `path` exists only for deterministic tests of
 * this module; the GUI IPC exposes no caller-supplied path.
 */
export function createNativeModelPrefsReader({
  path,
  now = Date.now,
}: {
  path?: string;
  now?: () => number;
} = {}) {
  let resolvedPath: Promise<string> | undefined;
  let cache: NativeModelPrefs | undefined;
  let cachedAt = 0;
  let loading: Promise<NativeModelPrefs> | undefined;

  const databasePath = () => {
    if (path) return Promise.resolve(path);
    resolvedPath ??= (async () => {
      const [userData, { join }] = await Promise.all([
        electronUserDataDir(),
        import('node:path'),
      ]);
      return join(userData ?? (await fallbackUserDataDir()), 'drafts.sqlite');
    })();
    return resolvedPath;
  };

  async function read(): Promise<NativeModelPrefs> {
    const db = await openDraftsDb(await databasePath());
    if (!db) return { status: 'unavailable', favorites: [], recent: [] };
    try {
      // One exact row; never scan or accept a path from the renderer.
      const row = db.get('model') as { value?: unknown } | undefined;
      if (!row || typeof row.value !== 'string') {
        return { status: 'unavailable', favorites: [], recent: [] };
      }
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      return {
        status: 'ok',
        favorites: listOf(parsed.favorite),
        recent: listOf(parsed.recent),
        updatedAt: new Date(now()).toISOString(),
      };
    } finally {
      db.close();
    }
  }

  return {
    async get(): Promise<NativeModelPrefs> {
      if (cache && now() - cachedAt < CACHE_MS) return cache;
      loading ??= read()
        .catch(
          (): NativeModelPrefs => ({
            status: 'unavailable',
            favorites: [],
            recent: [],
          }),
        )
        .then((value) => {
          cache = value;
          cachedAt = now();
          return value;
        })
        .finally(() => {
          loading = undefined;
        });
      return loading;
    },
  };
}
