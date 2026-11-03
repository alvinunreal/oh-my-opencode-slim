import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { normalizeLineEndings, parsePatch } from './codec';
import { ApplyPatchError, getErrorMessage } from './errors';
import { resolveUpdate } from './resolution';
import type {
  AddPatchHunk,
  DeletePatchHunk,
  ParsedPatch,
  PatchHostFlavor,
  PatchHunk,
  UpdatePatchHunk,
} from './types';

type PathGuardContext = {
  root: string;
  rootReal?: Promise<string>;
  worktree?: string;
  worktreeReal?: Promise<string>;
};

export type PreparedFileState =
  | {
      exists: false;
      derived: boolean;
    }
  | {
      exists: true;
      text: string;
      derived: boolean;
    };

type ExistingFileState = Extract<PreparedFileState, { exists: true }>;

export type SimulatedStep =
  | { type: 'add'; hunk: AddPatchHunk; filePath: string; finalText: string }
  | { type: 'delete'; hunk: DeletePatchHunk; filePath: string }
  | {
      type: 'update';
      hunk: UpdatePatchHunk;
      filePath: string;
      movePath?: string;
      current: ExistingFileState;
      resolved: ResolvedPreparedUpdate['resolved'];
      nextText: string;
    };

export type PatchExecutionContext = {
  hunks: PatchHunk[];
  pathsNormalized: boolean;
  staged: Map<string, PreparedFileState>;
  getPreparedFileState: (
    filePath: string,
    verb: 'update' | 'delete',
  ) => Promise<ExistingFileState>;
  assertPreparedPathMissing: (
    filePath: string,
    verb: 'add' | 'move',
  ) => Promise<void>;
};

export type ResolvedPreparedUpdate = {
  resolved: ReturnType<typeof resolveUpdate>['resolved'];
  nextText: string;
};

export function isMissingPathError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

async function real(target: string): Promise<string> {
  const parts: string[] = [];
  let current = path.resolve(target);

  while (true) {
    const exact = await fs.realpath(current).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return null;
      }

      throw new ApplyPatchError(
        'internal',
        `Failed to resolve real path: ${current}`,
        error,
      );
    });
    if (exact) {
      return parts.length === 0 ? exact : path.join(exact, ...parts.reverse());
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return parts.length === 0
        ? current
        : path.join(current, ...parts.reverse());
    }

    parts.push(path.basename(current));
    current = parent;
  }
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

async function guard(ctx: PathGuardContext, target: string): Promise<void> {
  const targetReal = await real(target);
  // Both resolutions are lazy: whichever rejects first is observed here,
  // and the other is never created, so no promise is left unhandled.
  ctx.rootReal ??= real(ctx.root);
  if (inside(await ctx.rootReal, targetReal)) {
    return;
  }

  // Resolve the worktree lazily, without an unobserved promise on root hits.
  if (ctx.worktree && ctx.worktree !== '/') {
    ctx.worktreeReal ??= real(ctx.worktree);
    if (inside(await ctx.worktreeReal, targetReal)) return;
  }

  throw new ApplyPatchError(
    'blocked',
    `patch contains path outside workspace root: ${target}`,
  );
}

async function statOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw new ApplyPatchError(
      'internal',
      `Failed to stat file for patch verification: ${filePath}`,
      error,
    );
  }
}

function collectPatchTargets(root: string, hunks: PatchHunk[]): string[] {
  const targets = new Set<string>();

  for (const hunk of hunks) {
    targets.add(path.resolve(root, hunk.path));

    if (hunk.type === 'update' && hunk.move_path) {
      targets.add(path.resolve(root, hunk.move_path));
    }
  }

  return [...targets];
}

function normalizePatchPath(root: string, value: string): string {
  if (!path.isAbsolute(value)) return value;
  const relative = path.relative(root, path.resolve(value));
  return (relative.length === 0 ? '.' : relative).replaceAll('\\', '/');
}

function normalizePatchPaths(
  root: string,
  hunks: PatchHunk[],
): {
  hunks: PatchHunk[];
  changed: boolean;
} {
  const resolvedRoot = path.resolve(root);
  let changed = false;

  const normalized = hunks.map((hunk): PatchHunk => {
    const nextPath = normalizePatchPath(resolvedRoot, hunk.path);
    if (hunk.type === 'update') {
      const nextMove = hunk.move_path
        ? normalizePatchPath(resolvedRoot, hunk.move_path)
        : undefined;
      if (nextPath === hunk.path && nextMove === hunk.move_path) return hunk;
      changed = true;
      return { ...hunk, path: nextPath, move_path: nextMove };
    }
    if (nextPath === hunk.path) return hunk;
    changed = true;
    return { ...hunk, path: nextPath };
  });

  return { hunks: normalized, changed };
}

async function guardPatchTargets(
  root: string,
  worktree: string | undefined,
  targets: string[],
): Promise<void> {
  const guardContext: PathGuardContext = { root, worktree };

  for (const target of targets) {
    await guard(guardContext, target);
  }
}

export function parseValidatedPatch(
  patchText: string,
  flavor: PatchHostFlavor = 'v1',
): ParsedPatch {
  let parsed: ParsedPatch;

  try {
    parsed = parsePatch(patchText, flavor);
  } catch (error) {
    throw new ApplyPatchError('validation', getErrorMessage(error));
  }

  if (parsed.hunks.length === 0) {
    const clean = normalizeLineEndings(patchText).trim();
    if (clean === '*** Begin Patch\n*** End Patch') {
      throw new ApplyPatchError('validation', 'empty patch');
    }

    throw new ApplyPatchError('validation', 'no hunks found');
  }

  return parsed;
}

async function readPreparedFileText(
  filePath: string,
  verb: 'update' | 'delete',
): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new ApplyPatchError(
        'verification',
        `Failed to read file to ${verb}: ${filePath}`,
      );
    }

    throw new ApplyPatchError(
      'internal',
      `Failed to read file for patch verification: ${filePath}`,
      error,
    );
  }
}

async function createPatchExecutionContext(
  root: string,
  patchText: string,
  worktree?: string,
  flavor: PatchHostFlavor = 'v1',
): Promise<PatchExecutionContext> {
  const parsed = parseValidatedPatch(patchText, flavor);
  const parsedHunks = parsed.hunks;
  await guardPatchTargets(
    root,
    worktree,
    collectPatchTargets(root, parsedHunks),
  );
  const normalized = normalizePatchPaths(root, parsedHunks);
  const staged = new Map<string, PreparedFileState>();

  async function assertPreparedPathMissing(
    filePath: string,
    verb: 'add' | 'move',
  ): Promise<void> {
    const message =
      verb === 'add'
        ? `Add File target already exists: ${filePath}`
        : `Move destination already exists: ${filePath}`;
    const existing = staged.get(filePath);
    if (existing) {
      if (!existing.exists) return;
    } else if (!(await statOrNull(filePath))) {
      return;
    }
    throw new ApplyPatchError('verification', message);
  }

  async function getPreparedFileState(
    filePath: string,
    verb: 'update' | 'delete',
  ): Promise<ExistingFileState> {
    const existing = staged.get(filePath);
    if (existing) {
      if (!existing.exists) {
        throw new ApplyPatchError(
          'verification',
          `Failed to read file to ${verb}: ${filePath}`,
        );
      }

      return existing;
    }

    const stat = await statOrNull(filePath);
    if (!stat?.isFile()) {
      throw new ApplyPatchError(
        'verification',
        `Failed to read file to ${verb}: ${filePath}`,
      );
    }
    const text = await readPreparedFileText(filePath, verb);
    const state: PreparedFileState = {
      exists: true,
      text,
      derived: false,
    };
    staged.set(filePath, state);
    return state;
  }

  return {
    hunks: normalized.hunks,
    pathsNormalized: normalized.changed || !!parsed.canonicalized,
    staged,
    getPreparedFileState,
    assertPreparedPathMissing,
  };
}

export async function simulatePatch(
  root: string,
  patchText: string,
  worktree?: string,
  flavor: PatchHostFlavor = 'v1',
): Promise<{
  hunks: PatchHunk[];
  pathsNormalized: boolean;
  steps: SimulatedStep[];
}> {
  const {
    hunks,
    pathsNormalized,
    staged,
    getPreparedFileState,
    assertPreparedPathMissing,
  } = await createPatchExecutionContext(root, patchText, worktree, flavor);
  const steps: SimulatedStep[] = [];
  const addedPaths = new Set<string>();

  for (const hunk of hunks) {
    const filePath = path.resolve(root, hunk.path);

    if (hunk.type === 'add') {
      await assertPreparedPathMissing(filePath, 'add');
      const finalText = stageAddedText(hunk.contents);
      steps.push({ type: 'add', hunk, filePath, finalText });
      addedPaths.add(filePath);
      staged.set(filePath, { exists: true, text: finalText, derived: true });
      continue;
    }

    if (hunk.type === 'delete') {
      if (addedPaths.has(filePath)) {
        throw new ApplyPatchError(
          'verification',
          `Failed to read file to delete: ${filePath}`,
        );
      }
      await getPreparedFileState(filePath, 'delete');
      steps.push({ type: 'delete', hunk, filePath });
      staged.set(filePath, { exists: false, derived: true });
      continue;
    }

    const movePath = hunk.move_path
      ? path.resolve(root, hunk.move_path)
      : undefined;
    if (movePath === filePath) {
      throw new ApplyPatchError(
        'validation',
        `Move destination is the source: ${filePath}`,
      );
    }
    const current = await getPreparedFileState(filePath, 'update');
    if (movePath && movePath !== filePath) {
      await assertPreparedPathMissing(movePath, 'move');
    }

    const { resolved, nextText } = resolvePreparedUpdate(
      filePath,
      current.text,
      hunk,
      flavor,
    );
    steps.push({
      type: 'update',
      hunk,
      filePath,
      movePath,
      current,
      resolved,
      nextText,
    });

    if (movePath && movePath !== filePath) {
      staged.set(filePath, { exists: false, derived: true });
    }
    staged.set(movePath ?? filePath, {
      exists: true,
      text: nextText,
      derived: true,
    });
  }

  return { hunks, pathsNormalized, steps };
}

export function resolvePreparedUpdate(
  filePath: string,
  currentText: string,
  hunk: UpdatePatchHunk,
  flavor: PatchHostFlavor = 'v1',
): ResolvedPreparedUpdate {
  try {
    return resolveUpdate(filePath, currentText, hunk.chunks, flavor);
  } catch (error) {
    throw new ApplyPatchError('verification', getErrorMessage(error), error);
  }
}

export function stageAddedText(contents: string): string {
  return contents.length === 0 || contents.endsWith('\n')
    ? contents
    : `${contents}\n`;
}
