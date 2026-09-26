import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface BackgroundJobIdentity {
  parentSessionID: string;
  taskID: string;
  agent: string;
  alias: string;
  directory: string;
}

export interface ResumeClaimBaseline {
  childLatestUserID: string;
  childLatestUserCreatedAt?: number;
  claimedAt?: number;
}

export interface ResumeClaim {
  token: string;
  baseline?: ResumeClaimBaseline;
}

export type BackgroundJobOperation = 'message' | 'revive';

export type OperationClaimPhase =
  | 'prepared'
  | 'sent_unknown'
  | 'accepted'
  | 'compensating';

export type OperationClaimResolution =
  | 'pre_send_failure'
  | 'authoritative_rejection'
  | 'accepted_and_completed'
  | 'compensated';

export interface OperationClaim {
  token: string;
  baseline?: ResumeClaimBaseline;
  phase: OperationClaimPhase;
}

type PersistedOperationClaim = Omit<OperationClaim, 'phase'> & {
  phase?: OperationClaimPhase;
};

interface Entry {
  identity: BackgroundJobIdentity;
  pendingResume?: string | ResumeClaim;
  pendingOperations?: Partial<Record<BackgroundJobOperation, OperationClaim>>;
}

interface IndexState {
  version: 1;
  // One global high-water mark keeps retired aliases unavailable without
  // retaining an unbounded map of counters for every parent and prefix.
  counter: number;
  entries: Entry[];
}

interface Lock {
  path: string;
  token: string;
}

const MAX_ENTRIES = 4096;
const LOCK_TIMEOUT_MS = 1000;
const LOCK_RETRY_MS = 5;
const LOCK_STALE_MS = 30_000;
const SLEEPER = new Int32Array(new SharedArrayBuffer(4));
const ALIAS_PATTERN = /^[a-z][a-z0-9_]*-[1-9]\d*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validBaseline(value: unknown): value is ResumeClaimBaseline {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ['childLatestUserID', 'childLatestUserCreatedAt', 'claimedAt'].includes(
        key,
      ),
    ) &&
    validString(value.childLatestUserID) &&
    (value.childLatestUserCreatedAt === undefined ||
      validCounter(value.childLatestUserCreatedAt)) &&
    (value.claimedAt === undefined || validCounter(value.claimedAt))
  );
}

function validResumeClaim(value: unknown): value is string | ResumeClaim {
  return (
    validString(value) ||
    (isRecord(value) &&
      Object.keys(value).every((key) => ['token', 'baseline'].includes(key)) &&
      validString(value.token) &&
      (value.baseline === undefined || validBaseline(value.baseline)))
  );
}

function validOperationClaim(value: unknown): value is PersistedOperationClaim {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ['token', 'baseline', 'phase'].includes(key),
    ) &&
    validString(value.token) &&
    (value.baseline === undefined || validBaseline(value.baseline)) &&
    (value.phase === undefined ||
      ['prepared', 'sent_unknown', 'accepted', 'compensating'].includes(
        value.phase as string,
      ))
  );
}

function normalizeOperationClaim(value: unknown): OperationClaim {
  const claim = value as PersistedOperationClaim;
  return { ...claim, phase: claim.phase ?? 'prepared' };
}

function parseState(text: string, directory: string): IndexState {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('invalid JSON');
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !validCounter(value.counter) ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_ENTRIES
  ) {
    throw new Error('invalid or unsupported index version/schema');
  }

  const seenTasks = new Set<string>();
  const seenAliases = new Set<string>();
  const entries: Entry[] = [];
  for (const raw of value.entries) {
    if (!isRecord(raw) || !isRecord(raw.identity)) {
      throw new Error('invalid identity entry');
    }
    const identity = raw.identity;
    const pendingOperations = isRecord(raw.pendingOperations)
      ? raw.pendingOperations
      : undefined;
    if (
      !validString(identity.parentSessionID) ||
      !validString(identity.taskID) ||
      ALIAS_PATTERN.test(identity.taskID) ||
      !validString(identity.agent) ||
      !validString(identity.alias) ||
      identity.directory !== directory ||
      (raw.pendingResume !== undefined &&
        !validResumeClaim(raw.pendingResume)) ||
      (raw.pendingOperations !== undefined &&
        (!pendingOperations ||
          Object.keys(pendingOperations).length !== 1 ||
          raw.pendingResume !== undefined ||
          Object.keys(pendingOperations ?? {}).some(
            (operation) =>
              !['message', 'revive'].includes(operation) ||
              !validOperationClaim(pendingOperations[operation]),
          )))
    ) {
      throw new Error('invalid identity entry');
    }
    const suffix = /^[a-z][a-z0-9_]*-([1-9]\d*)$/.exec(identity.alias);
    if (
      !suffix ||
      !validCounter(Number(suffix[1])) ||
      Number(suffix[1]) > value.counter
    ) {
      throw new Error('invalid alias counter');
    }
    const taskKey = JSON.stringify([identity.parentSessionID, identity.taskID]);
    const aliasKey = JSON.stringify([identity.parentSessionID, identity.alias]);
    if (seenTasks.has(taskKey) || seenAliases.has(aliasKey)) {
      throw new Error('duplicate identity mapping');
    }
    seenTasks.add(taskKey);
    seenAliases.add(aliasKey);
    entries.push({
      identity: {
        parentSessionID: identity.parentSessionID,
        taskID: identity.taskID,
        agent: identity.agent,
        alias: identity.alias,
        directory,
      },
      ...(raw.pendingResume === undefined
        ? {}
        : { pendingResume: raw.pendingResume }),
      ...(pendingOperations === undefined
        ? {}
        : {
            pendingOperations: {
              ...(pendingOperations.message === undefined
                ? {}
                : {
                    message: normalizeOperationClaim(pendingOperations.message),
                  }),
              ...(pendingOperations.revive === undefined
                ? {}
                : {
                    revive: normalizeOperationClaim(pendingOperations.revive),
                  }),
            },
          }),
    });
  }
  if (
    entries.some((item) =>
      seenTasks.has(
        JSON.stringify([item.identity.parentSessionID, item.identity.alias]),
      ),
    )
  ) {
    throw new Error('ambiguous identity mapping');
  }
  return { version: 1, counter: value.counter, entries };
}

function readState(filePath: string, directory: string): IndexState {
  let handle: number;
  try {
    handle = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, counter: 0, entries: [] };
    }
    throw new Error(`Cannot open background job identity index ${filePath}`, {
      cause: error,
    });
  }
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new Error('not a private regular file');
    }
    return parseState(fs.readFileSync(handle, 'utf8'), directory);
  } catch (error) {
    throw new Error(
      `Unreadable or corrupt background job identity index ${filePath}`,
      { cause: error },
    );
  } finally {
    fs.closeSync(handle);
  }
}

function writeState(filePath: string, state: IndexState): void {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: number | undefined;
  let created = false;
  try {
    handle = fs.openSync(tempPath, 'wx', 0o600);
    created = true;
    fs.writeFileSync(handle, `${JSON.stringify(state)}\n`);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Preserve the original write failure.
      }
    }
    if (created) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // An orphan temp file cannot be mistaken for a committed index.
      }
    }
    throw error;
  }
  // The rename is the commit point. A directory sync failure cannot undo it;
  // throwing here would make callers treat an allocated alias as unallocated.
  let dirHandle: number | undefined;
  try {
    dirHandle = fs.openSync(path.dirname(filePath), 'r');
    fs.fsyncSync(dirHandle);
  } catch {
    // The new index is visible, although crash durability is uncertain.
  } finally {
    if (dirHandle !== undefined) {
      try {
        fs.closeSync(dirHandle);
      } catch {
        // Closing after commit cannot change the identity returned to callers.
      }
    }
  }
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory()) {
    throw new Error(`Unsafe background job identity directory ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
}

function lockIsDead(lockPath: string): boolean {
  try {
    const stat = fs.lstatSync(lockPath);
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      Date.now() - stat.mtimeMs < LOCK_STALE_MS
    ) {
      return false;
    }
    const handle = fs.openSync(
      lockPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    let value: unknown;
    try {
      const opened = fs.fstatSync(handle);
      if (opened.ino !== stat.ino || opened.dev !== stat.dev) return false;
      value = JSON.parse(fs.readFileSync(handle, 'utf8'));
    } finally {
      fs.closeSync(handle);
    }
    if (
      !isRecord(value) ||
      value.host !== os.hostname() ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      !validString(value.token)
    ) {
      return false;
    }
    try {
      process.kill(value.pid as number, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  } catch {
    // Legacy empty locks have no provable owner and must fail closed.
    return false;
  }
}

function releaseLock(lock: Lock): void {
  let handle: number | undefined;
  try {
    handle = fs.openSync(
      lock.path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const value: unknown = JSON.parse(fs.readFileSync(handle, 'utf8'));
    if (isRecord(value) && value.token === lock.token) fs.unlinkSync(lock.path);
  } catch {
    // A failed release leaves a lock; never unlink a lock we cannot verify.
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Release must never turn an already committed write into a failure.
      }
    }
  }
}

function acquireLock(filePath: string): Lock {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  do {
    const token = randomUUID();
    const tempPath = `${lockPath}.${process.pid}.${token}.tmp`;
    let handle: number | undefined;
    let created = false;
    let ready = false;
    let published = false;
    try {
      handle = fs.openSync(tempPath, 'wx', 0o600);
      created = true;
      fs.writeFileSync(
        handle,
        JSON.stringify({ pid: process.pid, host: os.hostname(), token }),
      );
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = undefined;
      ready = true;
      // Publish complete metadata in one filesystem operation. A crash while
      // writing leaves only an orphan temp file, never an ownerless lock.
      fs.linkSync(tempPath, lockPath);
      published = true;
    } catch (error) {
      if (handle !== undefined) {
        try {
          fs.closeSync(handle);
        } catch {
          // Keep the acquisition error, including failed metadata writes.
        }
      }
      if (created) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // A temp file is not a published lock.
        }
      }
      if (!ready || (error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    if (published) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // The lock was published; an orphan temp file cannot undo ownership.
      }
      return { path: lockPath, token };
    }
    try {
      if (lockIsDead(lockPath)) {
        // Recheck the inode before removing a lock replaced in the meantime.
        const before = fs.lstatSync(lockPath);
        if (!lockIsDead(lockPath)) continue;
        const current = fs.lstatSync(lockPath);
        if (current.ino === before.ino && current.dev === before.dev) {
          fs.unlinkSync(lockPath);
        }
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    Atomics.wait(SLEEPER, 0, 0, LOCK_RETRY_MS);
  } while (Date.now() <= deadline);
  throw new Error(
    `Background job identity index lock unavailable: ${lockPath}`,
  );
}

export function createBackgroundJobIdentityIndex(projectDir: string) {
  const directory = path.resolve(projectDir);
  const scope = createHash('sha256')
    .update(directory)
    .digest('hex')
    .slice(0, 12);
  const filePath = path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
    'opencode',
    'storage',
    'oh-my-opencode-slim',
    scope,
    'background-job-identities.json',
  );

  function mutate<T>(
    action: (state: IndexState) => { result: T; changed: boolean },
  ): T {
    ensureDirectory(path.dirname(filePath));
    const lock = acquireLock(filePath);
    try {
      const state = readState(filePath, directory);
      const { result, changed } = action(state);
      if (changed) writeState(filePath, state);
      return result;
    } finally {
      releaseLock(lock);
    }
  }

  function entry(state: IndexState, parentSessionID: string, taskID: string) {
    return state.entries.find(
      (item) =>
        item.identity.parentSessionID === parentSessionID &&
        item.identity.taskID === taskID,
    );
  }

  function transitionOperation(
    parentSessionID: string,
    taskID: string,
    operation: BackgroundJobOperation,
    token: string,
    transitions: Partial<Record<OperationClaimPhase, OperationClaimPhase>>,
  ): boolean {
    if (!['message', 'revive'].includes(operation))
      throw new Error('Invalid background job operation claim');
    return mutate((state) => {
      const claim = entry(state, parentSessionID, taskID)?.pendingOperations?.[
        operation
      ];
      if (!claim || !validString(token) || claim.token !== token)
        return { result: false, changed: false };
      const next = transitions[claim.phase];
      if (next === undefined) return { result: false, changed: false };
      if (next === claim.phase) return { result: true, changed: false };
      claim.phase = next;
      return { result: true, changed: true };
    });
  }

  return {
    reserve(
      parentSessionID: string,
      taskID: string,
      agent: string,
      prefix: string,
      minimumCounter = 0,
    ): BackgroundJobIdentity {
      if (
        !validString(parentSessionID) ||
        !validString(taskID) ||
        ALIAS_PATTERN.test(taskID) ||
        !validString(agent) ||
        !/^[a-z][a-z0-9_]*$/.test(prefix) ||
        !validCounter(minimumCounter)
      ) {
        throw new Error('Invalid background job identity reservation');
      }
      return mutate((state) => {
        const existing = entry(state, parentSessionID, taskID);
        if (existing) {
          if (
            existing.identity.agent !== agent ||
            !existing.identity.alias.startsWith(`${prefix}-`)
          ) {
            throw new Error(`Conflicting identity for task ${taskID}`);
          }
          return { result: existing.identity, changed: false };
        }
        if (
          state.entries.some(
            (item) =>
              item.identity.parentSessionID === parentSessionID &&
              item.identity.alias === taskID,
          )
        ) {
          throw new Error(
            `Task ID conflicts with an existing alias: ${taskID}`,
          );
        }
        const next = Math.max(state.counter, minimumCounter) + 1;
        if (!Number.isSafeInteger(next)) {
          throw new Error('Alias counter exhausted');
        }
        const alias = `${prefix}-${next}`;
        if (alias === taskID) {
          throw new Error(`Alias conflicts with task ID: ${taskID}`);
        }
        if (
          state.entries.some(
            (item) =>
              item.identity.parentSessionID === parentSessionID &&
              item.identity.taskID === alias,
          )
        ) {
          throw new Error(`Alias conflicts with an existing task ID: ${alias}`);
        }
        if (state.entries.length === MAX_ENTRIES) {
          const oldestSettled = state.entries.findIndex(
            (item) =>
              item.pendingResume === undefined &&
              Object.keys(item.pendingOperations ?? {}).length === 0,
          );
          if (oldestSettled < 0) {
            throw new Error('Identity index full of unsettled claims');
          }
          state.entries.splice(oldestSettled, 1);
        }
        state.counter = next;
        const identity = { parentSessionID, taskID, agent, alias, directory };
        state.entries.push({ identity });
        return { result: identity, changed: true };
      });
    },
    lookup(
      parentSessionID: string,
      key: string,
    ): BackgroundJobIdentity | undefined {
      const state = readState(filePath, directory);
      return state.entries.find(
        (item) =>
          item.identity.parentSessionID === parentSessionID &&
          (item.identity.taskID === key || item.identity.alias === key),
      )?.identity;
    },
    forget(parentSessionID: string, taskID: string): void {
      mutate((state) => {
        const index = state.entries.findIndex(
          (item) =>
            item.identity.parentSessionID === parentSessionID &&
            item.identity.taskID === taskID,
        );
        if (index < 0) return { result: undefined, changed: false };
        if (state.entries[index]?.pendingResume !== undefined)
          throw new Error(`Cannot forget unsettled resume for ${taskID}`);
        if (
          Object.keys(state.entries[index]?.pendingOperations ?? {}).length > 0
        )
          throw new Error(`Cannot forget unsettled operation for ${taskID}`);
        state.entries.splice(index, 1);
        return { result: undefined, changed: true };
      });
    },
    claimResume(
      parentSessionID: string,
      taskID: string,
      baseline?: ResumeClaimBaseline,
    ): string | undefined {
      if (baseline !== undefined && !validBaseline(baseline)) {
        throw new Error('Invalid background job resume baseline');
      }
      return mutate((state) => {
        const item = entry(state, parentSessionID, taskID);
        if (
          !item ||
          item.pendingResume !== undefined ||
          Object.keys(item.pendingOperations ?? {}).length > 0
        ) {
          return { result: undefined, changed: false };
        }
        const token = randomUUID();
        item.pendingResume = baseline
          ? { token, baseline: { ...baseline } }
          : token;
        return { result: token, changed: true };
      });
    },
    inspectResumeClaim(
      parentSessionID: string,
      taskID: string,
    ): ResumeClaim | undefined {
      const claim = entry(
        readState(filePath, directory),
        parentSessionID,
        taskID,
      )?.pendingResume;
      if (claim === undefined) return undefined;
      return typeof claim === 'string' ? { token: claim } : claim;
    },
    settleResume(parentSessionID: string, taskID: string, token: string): void {
      mutate((state) => {
        const item = entry(state, parentSessionID, taskID);
        if (
          !item ||
          !validString(token) ||
          (typeof item.pendingResume === 'string'
            ? item.pendingResume !== token
            : item.pendingResume?.token !== token)
        ) {
          return { result: undefined, changed: false };
        }
        delete item.pendingResume;
        return { result: undefined, changed: true };
      });
    },
    hasUnsettledResume(parentSessionID: string, taskID: string): boolean {
      return (
        entry(readState(filePath, directory), parentSessionID, taskID)
          ?.pendingResume !== undefined
      );
    },
    claimOperation(
      parentSessionID: string,
      taskID: string,
      operation: BackgroundJobOperation,
      baseline?: ResumeClaimBaseline,
    ): string | undefined {
      if (
        !['message', 'revive'].includes(operation) ||
        (baseline !== undefined && !validBaseline(baseline))
      ) {
        throw new Error('Invalid background job operation claim');
      }
      return mutate((state) => {
        const item = entry(state, parentSessionID, taskID);
        if (
          !item ||
          item.pendingResume !== undefined ||
          Object.keys(item.pendingOperations ?? {}).length > 0
        ) {
          return { result: undefined, changed: false };
        }
        const token = randomUUID();
        item.pendingOperations = {
          ...(item.pendingOperations ?? {}),
          [operation]: {
            token,
            ...(baseline ? { baseline: { ...baseline } } : {}),
            phase: 'prepared',
          },
        };
        return { result: token, changed: true };
      });
    },
    inspectOperationClaim(
      parentSessionID: string,
      taskID: string,
      operation: BackgroundJobOperation,
    ): OperationClaim | undefined {
      if (!['message', 'revive'].includes(operation))
        throw new Error('Invalid background job operation claim');
      return entry(readState(filePath, directory), parentSessionID, taskID)
        ?.pendingOperations?.[operation];
    },
    markOperationSent(
      parentSessionID: string,
      taskID: string,
      operation: BackgroundJobOperation,
      token: string,
    ): boolean {
      return transitionOperation(parentSessionID, taskID, operation, token, {
        prepared: 'sent_unknown',
        sent_unknown: 'sent_unknown',
      });
    },
    markOperationAccepted(
      parentSessionID: string,
      taskID: string,
      operation: BackgroundJobOperation,
      token: string,
    ): boolean {
      return transitionOperation(parentSessionID, taskID, operation, token, {
        sent_unknown: 'accepted',
        accepted: 'accepted',
      });
    },
    beginOperationCompensation(
      parentSessionID: string,
      taskID: string,
      operation: BackgroundJobOperation,
      token: string,
    ): boolean {
      return transitionOperation(parentSessionID, taskID, operation, token, {
        sent_unknown: 'compensating',
        accepted: 'compensating',
        compensating: 'compensating',
      });
    },
    settleOperation(
      parentSessionID: string,
      taskID: string,
      operation: BackgroundJobOperation,
      token: string,
      ...resolutionArg: [resolution?: OperationClaimResolution]
    ): boolean {
      if (!['message', 'revive'].includes(operation))
        throw new Error('Invalid background job operation claim');
      const resolution =
        resolutionArg.length === 0
          ? 'accepted_and_completed'
          : resolutionArg[0];
      const allowed: Record<OperationClaimResolution, OperationClaimPhase[]> = {
        pre_send_failure: ['prepared'],
        authoritative_rejection: ['prepared', 'sent_unknown'],
        accepted_and_completed: ['accepted'],
        compensated: ['compensating'],
      };
      if (typeof resolution !== 'string' || !Object.hasOwn(allowed, resolution))
        return false;
      // Legacy callers only settle after a confirmed successful response, but
      // have not yet been updated to persist the sent/accepted transitions.
      const legacyCompletion = resolutionArg.length === 0;
      return mutate((state) => {
        const item = entry(state, parentSessionID, taskID);
        const claim = item?.pendingOperations?.[operation];
        if (
          !item ||
          !claim ||
          claim.token !== token ||
          !validString(token) ||
          (!allowed[resolution].includes(claim.phase) &&
            !(legacyCompletion && claim.phase === 'prepared'))
        ) {
          return { result: false, changed: false };
        }
        delete item.pendingOperations?.[operation];
        if (Object.keys(item.pendingOperations ?? {}).length === 0)
          delete item.pendingOperations;
        return { result: true, changed: true };
      });
    },
    hasUnsettledOperation(
      parentSessionID: string,
      taskID: string,
      operation?: BackgroundJobOperation,
    ): boolean {
      const operations = entry(
        readState(filePath, directory),
        parentSessionID,
        taskID,
      )?.pendingOperations;
      return operation
        ? operations?.[operation] !== undefined
        : Object.keys(operations ?? {}).length > 0;
    },
  };
}
