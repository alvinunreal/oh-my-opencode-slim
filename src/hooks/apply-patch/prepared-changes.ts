import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  createApplyPatchInternalError,
  createApplyPatchValidationError,
  createApplyPatchVerificationError,
  ensureApplyPatchError,
  getErrorMessage,
} from './errors';
import {
  createPatchExecutionContext,
  isMissingPathError,
  resolvePreparedUpdate,
  stageAddedText,
} from './execution-context';
import type { ApplyPatchRuntimeOptions, PreparedChange } from './types';

function isNormalizedAbsolutePath(filePath: string): boolean {
  return path.isAbsolute(filePath) && path.normalize(filePath) === filePath;
}

function assertPreparedChangePath(
  value: unknown,
  field: 'file' | 'move',
  index: number,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw createApplyPatchValidationError(
      `Prepared changes require a non-empty string ${field} at index ${index}`,
    );
  }

  if (!isNormalizedAbsolutePath(value)) {
    throw createApplyPatchValidationError(
      `Prepared changes require absolute normalized ${field} paths at index ${index}: ${value}`,
    );
  }
}

function assertPreparedChangesContract(
  changes: readonly PreparedChange[],
): void {
  for (const [index, change] of changes.entries()) {
    if (!change || typeof change !== 'object') {
      throw createApplyPatchValidationError(
        `Prepared change at index ${index} must be an object`,
      );
    }

    if (!('type' in change)) {
      throw createApplyPatchValidationError(
        `Prepared change at index ${index} is missing type`,
      );
    }

    assertPreparedChangePath(change.file, 'file', index);

    if (change.type === 'add') {
      if (typeof change.text !== 'string') {
        throw createApplyPatchValidationError(
          `Prepared add at index ${index} is missing text`,
        );
      }
      continue;
    }

    if (change.type === 'delete') {
      continue;
    }

    if (change.type === 'update') {
      if (typeof change.text !== 'string') {
        throw createApplyPatchValidationError(
          `Prepared update at index ${index} is missing text`,
        );
      }

      if (change.move !== undefined) {
        assertPreparedChangePath(change.move, 'move', index);
      }

      continue;
    }

    throw createApplyPatchValidationError(
      `Prepared change at index ${index} has unsupported type`,
    );
  }
}

export async function preparePatchChanges(
  root: string,
  patchText: string,
  cfg: ApplyPatchRuntimeOptions,
  worktree?: string,
): Promise<PreparedChange[]> {
  try {
    const { hunks, staged, getPreparedFileState, assertPreparedPathMissing } =
      await createPatchExecutionContext(root, patchText, worktree);
    const changes: PreparedChange[] = [];

    for (const hunk of hunks) {
      const filePath = path.resolve(root, hunk.path);

      if (hunk.type === 'add') {
        await assertPreparedPathMissing(filePath, 'add');
        const text = stageAddedText(hunk.contents);
        changes.push({
          type: 'add',
          file: filePath,
          text,
        });
        staged.set(filePath, { exists: true, text, derived: true });
        continue;
      }

      if (hunk.type === 'delete') {
        await getPreparedFileState(filePath, 'delete');

        changes.push({ type: 'delete', file: filePath });
        staged.set(filePath, { exists: false, derived: true });
        continue;
      }

      const current = await getPreparedFileState(filePath, 'update');
      if (!current.exists) {
        throw createApplyPatchVerificationError(
          `Failed to read file to update: ${filePath}`,
        );
      }

      const move = hunk.move_path
        ? path.resolve(root, hunk.move_path)
        : undefined;
      if (move && move !== filePath) {
        await assertPreparedPathMissing(move, 'move');
      }
      const { nextText } = resolvePreparedUpdate(
        filePath,
        current.text,
        hunk,
        cfg,
      );

      changes.push({
        type: 'update',
        file: filePath,
        move,
        text: nextText,
      });

      if (move && move !== filePath) {
        staged.set(filePath, { exists: false, derived: true });
        staged.set(move, {
          exists: true,
          text: nextText,
          mode: current.mode,
          derived: true,
        });
        continue;
      }

      staged.set(filePath, {
        exists: true,
        text: nextText,
        mode: current.mode,
        derived: true,
      });
    }

    return changes;
  } catch (error) {
    throw ensureApplyPatchError(error, 'Unexpected prepare failure');
  }
}

type FileSnapshot =
  | { type: 'missing' }
  | {
      type: 'file';
      text: string;
      mode: number;
    };

async function readSnapshot(filePath: string): Promise<FileSnapshot> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      throw createApplyPatchInternalError(
        `Refusing to overwrite directory while applying prepared changes: ${filePath}`,
      );
    }

    return {
      type: 'file',
      text: await fs.readFile(filePath, 'utf-8'),
      mode: stat.mode & 0o7777,
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return { type: 'missing' };
    }

    throw createApplyPatchInternalError(
      `Failed to snapshot file before apply: ${filePath}`,
      error,
    );
  }
}

async function restoreSnapshot(
  filePath: string,
  snapshot: FileSnapshot,
): Promise<void> {
  if (snapshot.type === 'missing') {
    await fs.rm(filePath, { force: true });
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomically(filePath, snapshot.text, snapshot.mode);
}

function createTempSiblingPath(target: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.apply-patch-${randomUUID()}.tmp`,
  );
}

async function writeFileAtomically(
  target: string,
  text: string,
  mode?: number,
): Promise<void> {
  const tempPath = createTempSiblingPath(target);

  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(tempPath, text, 'utf-8');
    if (mode !== undefined) {
      await fs.chmod(tempPath, mode);
    }
    await fs.rename(tempPath, target);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function getSnapshotMode(snapshot: FileSnapshot): number | undefined {
  return snapshot.type === 'file' ? snapshot.mode : undefined;
}

function assertPreparedApplyPreconditions(
  changes: PreparedChange[],
  snapshots: Map<string, FileSnapshot>,
): void {
  const staged = new Map<string, FileSnapshot['type']>();

  function pathState(filePath: string): FileSnapshot['type'] {
    if (staged.has(filePath)) {
      return staged.get(filePath) ?? 'missing';
    }

    return snapshots.get(filePath)?.type ?? 'missing';
  }

  for (const change of changes) {
    if (change.type === 'add') {
      if (pathState(change.file) !== 'missing') {
        throw createApplyPatchVerificationError(
          `Prepared add target already exists: ${change.file}`,
        );
      }

      staged.set(change.file, 'file');

      continue;
    }

    if (change.type === 'delete') {
      if (pathState(change.file) !== 'file') {
        throw createApplyPatchVerificationError(
          `Prepared delete source does not exist: ${change.file}`,
        );
      }

      staged.set(change.file, 'missing');
      continue;
    }

    if (pathState(change.file) !== 'file') {
      throw createApplyPatchVerificationError(
        change.move && change.move !== change.file
          ? `Prepared move source does not exist: ${change.file}`
          : `Prepared update source does not exist: ${change.file}`,
      );
    }

    if (change.move && change.move !== change.file) {
      if (pathState(change.move) !== 'missing') {
        throw createApplyPatchVerificationError(
          `Prepared move destination already exists: ${change.move}`,
        );
      }

      staged.set(change.file, 'missing');
      staged.set(change.move, 'file');
      continue;
    }

    staged.set(change.file, 'file');
  }
}

/**
 * Internal best-effort helper that applies the output of
 * `preparePatchChanges()`: it snapshots all touched paths first and uses
 * temp + rename for writes to regular files. It is not a universal multi-file
 * transaction and is not perfect against concurrent external interference,
 * but it avoids leaving silent partial states on normal apply failures.
 *
 * Contract: although it is exported for local tests/helpers, its expected
 * input is the already prepared output of `preparePatchChanges()`. If it
 * receives manual arrays, it revalidates the basic shape
 * (types/text/normalized absolute paths) and filesystem invariants: it
 * rejects updates/deletes/moves whose source does not exist, and add/move
 * operations whose destination is already occupied.
 */
export async function applyPreparedChanges(
  changes: PreparedChange[],
): Promise<void> {
  assertPreparedChangesContract(changes);

  const snapshots = new Map<string, FileSnapshot>();

  for (const change of changes) {
    if (!snapshots.has(change.file)) {
      snapshots.set(change.file, await readSnapshot(change.file));
    }

    if (
      change.type === 'update' &&
      change.move &&
      !snapshots.has(change.move)
    ) {
      snapshots.set(change.move, await readSnapshot(change.move));
    }
  }

  assertPreparedApplyPreconditions(changes, snapshots);

  try {
    for (const change of changes) {
      if (change.type === 'add') {
        await writeFileAtomically(change.file, change.text);
        continue;
      }

      if (change.type === 'delete') {
        await fs.unlink(change.file);
        continue;
      }

      if (change.move && change.move !== change.file) {
        await writeFileAtomically(
          change.move,
          change.text,
          getSnapshotMode(snapshots.get(change.file) ?? { type: 'missing' }),
        );
        await fs.unlink(change.file);
        continue;
      }

      await writeFileAtomically(
        change.file,
        change.text,
        getSnapshotMode(snapshots.get(change.file) ?? { type: 'missing' }),
      );
    }
  } catch (error) {
    const rollbackFailures: string[] = [];

    for (const [filePath, snapshot] of [...snapshots.entries()].reverse()) {
      try {
        await restoreSnapshot(filePath, snapshot);
      } catch (rollbackError) {
        rollbackFailures.push(`${filePath}: ${getErrorMessage(rollbackError)}`);
      }
    }

    const message = rollbackFailures.length
      ? `Failed to apply prepared changes and rollback was incomplete: ${getErrorMessage(error)}; rollback issues: ${rollbackFailures.join('; ')}`
      : `Failed to apply prepared changes; rolled back touched files: ${getErrorMessage(error)}`;

    throw createApplyPatchInternalError(message, error);
  }
}
