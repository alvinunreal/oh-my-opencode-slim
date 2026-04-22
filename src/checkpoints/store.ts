/**
 * Checkpoint storage - persists checkpoints to disk.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Checkpoint, CheckpointStore } from './types';

const STORE_FILENAME = '.slim/checkpoints.json';

export class CheckpointStorage {
  private storePath: string;
  private cache: CheckpointStore | null = null;

  constructor(directory: string) {
    this.storePath = path.join(directory, STORE_FILENAME);
  }

  /**
   * Ensure the .slim directory exists.
   */
  private async ensureDir(): Promise<void> {
    const dir = path.dirname(this.storePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      // Directory may already exist
    }
  }

  /**
   * Load the checkpoint store from disk.
   */
  async load(): Promise<CheckpointStore> {
    if (this.cache) return this.cache;

    try {
      const data = await fs.readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(data) as CheckpointStore;
      this.cache = {
        checkpoints: parsed.checkpoints || {},
        bySession: parsed.bySession || {},
      };
      return this.cache;
    } catch {
      // File doesn't exist or is corrupted - start fresh
      this.cache = { checkpoints: {}, bySession: {} };
      return this.cache;
    }
  }

  /**
   * Save the checkpoint store to disk.
   */
  private async save(store: CheckpointStore): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(this.storePath, JSON.stringify(store, null, 2), 'utf8');
    this.cache = store;
  }

  /**
   * Add a new checkpoint.
   */
  async add(checkpoint: Checkpoint): Promise<void> {
    const store = await this.load();
    store.checkpoints[checkpoint.id] = checkpoint;

    if (!store.bySession[checkpoint.sessionID]) {
      store.bySession[checkpoint.sessionID] = [];
    }
    if (!store.bySession[checkpoint.sessionID].includes(checkpoint.id)) {
      store.bySession[checkpoint.sessionID].push(checkpoint.id);
    }

    await this.save(store);
  }

  /**
   * Get a checkpoint by ID.
   */
  async get(id: string): Promise<Checkpoint | null> {
    const store = await this.load();
    return store.checkpoints[id] || null;
  }

  /**
   * Get a checkpoint by name (for a specific session).
   */
  async getByName(sessionID: string, name: string): Promise<Checkpoint | null> {
    const store = await this.load();
    const ids = store.bySession[sessionID] || [];
    for (const id of ids) {
      const cp = store.checkpoints[id];
      if (cp?.name === name) return cp;
    }
    return null;
  }

  /**
   * List all checkpoints for a session.
   */
  async listForSession(sessionID: string): Promise<Checkpoint[]> {
    const store = await this.load();
    const ids = store.bySession[sessionID] || [];
    return ids
      .map((id) => store.checkpoints[id])
      .filter((cp): cp is Checkpoint => !!cp)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Delete a checkpoint.
   */
  async delete(id: string): Promise<boolean> {
    const store = await this.load();
    const cp = store.checkpoints[id];
    if (!cp) return false;

    delete store.checkpoints[id];

    const sessionCheckpoints = store.bySession[cp.sessionID] || [];
    store.bySession[cp.sessionID] = sessionCheckpoints.filter((cid) => cid !== id);

    await this.save(store);
    return true;
  }

  /**
   * Delete all checkpoints for a session (cleanup).
   */
  async deleteForSession(sessionID: string): Promise<number> {
    const store = await this.load();
    const ids = store.bySession[sessionID] || [];
    let count = 0;

    for (const id of ids) {
      if (store.checkpoints[id]) {
        delete store.checkpoints[id];
        count++;
      }
    }

    delete store.bySession[sessionID];
    await this.save(store);
    return count;
  }

  /**
   * Clear the in-memory cache.
   */
  clearCache(): void {
    this.cache = null;
  }
}
