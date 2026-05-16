import { existsSync } from 'node:fs';
import * as path from 'node:path';

type BunDatabase = import('bun:sqlite').Database;

/**
 * Safely import bun:sqlite only when running in Bun runtime.
 * Uses new Function() to hide the import from Node.js/Electron's static parser,
 * which would fail on bun: protocol resolution before .catch() could run.
 */
async function importBunSqlite(): Promise<
  typeof import('bun:sqlite') | null
> {
  if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') {
    return null;
  }
  try {
    const dynamicImport = new Function(
      "return import('bun:sqlite')",
    ) as () => Promise<typeof import('bun:sqlite')>;
    return await dynamicImport();
  } catch {
    return null;
  }
}

/**
 * Resolve the path to opencode.db.
 *
 * Default: $XDG_DATA_HOME/opencode/opencode.db (Linux/macOS).
 * Falls back to ~/.local/share/opencode/opencode.db.
 */
function getDbPath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const dataDir =
    xdg && xdg.length > 0
      ? xdg
      : path.join(process.env.HOME ?? '', '.local', 'share');
  return path.join(dataDir, 'opencode', 'opencode.db');
}

const MAX_MICROTASK_RETRIES = 10;

export interface MessageOverrideTarget {
  providerID?: string;
  modelID?: string;
  variant?: string;
}

function tryUpdateMessage(
  db: BunDatabase,
  messageId: string,
  target: MessageOverrideTarget,
): boolean {
  // Patch model.providerID, model.modelID, model.variant, flat variant, and
  // thinking mirror in one statement. Skips fields that are undefined.
  const sets: string[] = [];
  const args: unknown[] = [];
  if (typeof target.providerID === 'string') {
    sets.push("'$.model.providerID', ?");
    args.push(target.providerID);
  }
  if (typeof target.modelID === 'string') {
    sets.push("'$.model.modelID', ?");
    args.push(target.modelID);
  }
  if (typeof target.variant === 'string') {
    sets.push("'$.model.variant', ?");
    args.push(target.variant);
    sets.push("'$.variant', ?");
    args.push(target.variant);
    sets.push("'$.thinking', ?");
    args.push(target.variant);
  }
  if (sets.length === 0) return false;
  const sql = `UPDATE message SET data = json_set(data, ${sets.join(', ')}) WHERE id = ?`;
  args.push(messageId);
  const stmt = db.prepare(sql);
  const result = stmt.run(...(args as never[]));
  return result.changes > 0;
}

function retryViaMicrotask(
  db: BunDatabase,
  messageId: string,
  target: MessageOverrideTarget,
  attempt: number,
  log: (msg: string, extra?: Record<string, unknown>) => void,
): void {
  if (attempt >= MAX_MICROTASK_RETRIES) {
    log(
      '[preset-db-override] microtask retries exhausted, using setTimeout',
      { messageId, attempt },
    );
    setTimeout(() => {
      try {
        if (tryUpdateMessage(db, messageId, target)) {
          log('[preset-db-override] setTimeout fallback succeeded', {
            messageId,
            target,
          });
        } else {
          log('[preset-db-override] setTimeout fallback — message not found', {
            messageId,
          });
        }
      } catch (error) {
        log('[preset-db-override] setTimeout fallback failed', {
          messageId,
          error: String(error),
        });
      } finally {
        try {
          db.close();
        } catch {
          // ignore
        }
      }
    }, 0);
    return;
  }

  queueMicrotask(() => {
    let shouldCloseDb = true;
    try {
      if (tryUpdateMessage(db, messageId, target)) {
        log(
          `[preset-db-override] deferred update (attempt ${attempt}) succeeded`,
          { messageId, target },
        );
        return;
      }
      shouldCloseDb = false;
      retryViaMicrotask(db, messageId, target, attempt + 1, log);
    } catch (error) {
      log('[preset-db-override] deferred update failed', {
        messageId,
        attempt,
        error: String(error),
      });
    } finally {
      if (shouldCloseDb) {
        try {
          db.close();
        } catch {
          // ignore
        }
      }
    }
  });
}

/**
 * Schedule a deferred SQLite update that rewrites a single message's model
 * and variant in opencode.db WITHOUT emitting a Bus event.
 *
 * Uses a microtask retry loop to wait until opencode's own
 * Session.updateMessage() has persisted the message, then overwrites the row.
 * Falls back to setTimeout(fn, 0) after 10 microtask attempts.
 *
 * No-op when not running under Bun (the technique relies on bun:sqlite).
 * Stage A in-band mutation of `output.message` still takes effect for the
 * current turn's inference; only reload/history shows the original values.
 */
export function scheduleDeferredMessageOverride(
  messageId: string,
  target: MessageOverrideTarget,
  log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
): void {
  if (
    typeof target.providerID !== 'string' &&
    typeof target.modelID !== 'string' &&
    typeof target.variant !== 'string'
  ) {
    return;
  }
  queueMicrotask(async () => {
    const sqliteModule = await importBunSqlite();
    const Database = sqliteModule?.Database;
    if (typeof Database !== 'function') {
      log('[preset-db-override] bun:sqlite unavailable; skipping persistence', {
        messageId,
      });
      return;
    }

    const dbPath = getDbPath();
    if (!existsSync(dbPath)) {
      log('[preset-db-override] DB not found; skipping persistence', {
        dbPath,
      });
      return;
    }

    let db: BunDatabase;
    try {
      db = new Database(dbPath);
    } catch (error) {
      log('[preset-db-override] failed to open DB; skipping persistence', {
        messageId,
        error: String(error),
      });
      return;
    }

    try {
      retryViaMicrotask(db, messageId, target, 0, log);
    } catch (error) {
      log('[preset-db-override] failed to schedule deferred update', {
        error: String(error),
      });
      db.close();
    }
  });
}
