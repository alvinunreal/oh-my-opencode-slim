import type { PaneResult } from '../types';
import type { CmuxCloseIntent } from './close-policy';

export type CmuxSpawnState = 'known' | 'spawning' | 'attached' | 'failed';
export type CmuxLifecycleState = 'active' | 'deleted' | 'orphaned';

export interface CmuxDeferredSpawn {
  deadline: number;
  generation: number;
  timer?: { cancel(): void };
}

export interface CmuxSessionRecord {
  session: string;
  owner: string;
  parent: string;
  title: string;
  directory: string;
  paneId?: string;
  spawnState: CmuxSpawnState;
  lifecycle: CmuxLifecycleState;
  attachedAt?: number;
  lastActivityAt: number;
  activityVersion: number;
  idleConsecutive: number;
  statusMissingSince?: number;
  deferredSpawn?: CmuxDeferredSpawn;
  closeIntent?: CmuxCloseIntent;
  closeTimer?: { cancel(): void };
  spawnPromise?: Promise<PaneResult>;
}

const STORE_KEY = Symbol.for('oh-my-opencode-slim.cmux-session-store');

function records(): Map<string, CmuxSessionRecord> {
  const globalStore = globalThis as typeof globalThis & {
    [STORE_KEY]?: Map<string, CmuxSessionRecord>;
  };
  globalStore[STORE_KEY] ??= new Map();
  return globalStore[STORE_KEY];
}

export class CmuxSessionStore {
  claimCreated(record: CmuxSessionRecord): boolean {
    const existing = records().get(record.session);
    if (existing) {
      if (
        existing.directory !== record.directory ||
        (existing.lifecycle !== 'orphaned' && existing.lifecycle !== 'deleted')
      )
        return false;
      existing.closeTimer?.cancel();
      Object.assign(record, existing, {
        owner: record.owner,
        closeTimer: undefined,
      });
    }
    records().set(record.session, record);
    return true;
  }
  get(session: string): CmuxSessionRecord | undefined {
    return records().get(session);
  }
  ownedBy(owner: string): CmuxSessionRecord[] {
    return [...records().values()].filter((record) => record.owner === owner);
  }
  claimOrphans(owner: string, directory: string): CmuxSessionRecord[] {
    const claimed = [...records().values()].filter(
      (record) =>
        record.directory === directory &&
        Boolean(record.paneId) &&
        (record.lifecycle === 'orphaned' || record.lifecycle === 'deleted'),
    );
    for (const record of claimed) {
      record.closeTimer?.cancel();
      record.closeTimer = undefined;
      record.owner = owner;
    }
    return claimed;
  }
  markAttached(session: string, paneId: string, now: number): void {
    const record = records().get(session);
    if (!record) return;
    Object.assign(record, {
      paneId,
      attachedAt: now,
      lastActivityAt: now,
      spawnState: 'attached',
      deferredSpawn: undefined,
    });
  }
  markActivity(session: string, now: number): void {
    const record = records().get(session);
    if (!record) return;
    record.lastActivityAt = now;
    record.activityVersion += 1;
    record.idleConsecutive = 0;
    record.statusMissingSince = undefined;
  }
  markDeleted(session: string): void {
    const record = records().get(session);
    if (record) record.lifecycle = 'deleted';
  }
  markOrphaned(session: string): void {
    const record = records().get(session);
    if (record) record.lifecycle = 'orphaned';
  }
  removeAfterConfirmedClose(session: string): boolean {
    const record = records().get(session);
    return record?.paneId ? records().delete(session) : false;
  }
  removeWithoutPane(session: string): boolean {
    const record = records().get(session);
    return record && !record.paneId ? records().delete(session) : false;
  }
  resetForTests(): void {
    for (const record of records().values()) {
      record.deferredSpawn?.timer?.cancel();
      record.closeTimer?.cancel();
    }
    records().clear();
  }
}
