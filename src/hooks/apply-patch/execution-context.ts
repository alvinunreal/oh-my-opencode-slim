import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { parsePatchStrict } from './codec';
import {
  createApplyPatchBlockedError,
  createApplyPatchInternalError,
  createApplyPatchValidationError,
  createApplyPatchVerificationError,
  getErrorMessage,
} from './errors';
import { applyHits, resolveUpdateChunksFromText } from './resolution';
import type {
  ApplyPatchRuntimeOptions,
  PatchHunk,
  UpdatePatchHunk,
} from './types';

type PathGuardContext = {
  rootReal: Promise<string>;
  worktreeReal?: Promise<string>;
  realCache: Map<string, Promise<string>>;
};

type FileCacheContext = {
  stats: Map<string, Promise<Stats | null>>;
};

export type PreparedFileState =
  | {
      exists: false;
      derived: boolean;
    }
  | {
      exists: true;
      text: string;
      mode?: number;
      derived: boolean;
    };

export type PatchExecutionContext = {
  hunks: PatchHunk[];
  staged: Map<string, PreparedFileState>;
  getPreparedFileState: (
    filePath: string,
    verb: 'update' | 'delete',
  ) => Promise<PreparedFileState>;
  assertPreparedPathMissing: (
    filePath: string,
    verb: 'add' | 'move',
  ) => Promise<void>;
};

export type ResolvedPreparedUpdate = {
  resolved: Awaited<ReturnType<typeof resolveUpdateChunksFromText>>['resolved'];
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

      throw createApplyPatchInternalError(
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
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function createPathGuardContext(
  root: string,
  worktree: string | undefined,
): PathGuardContext {
  return {
    rootReal: real(root),
    worktreeReal: worktree && worktree !== '/' ? real(worktree) : undefined,
    realCache: new Map(),
  };
}

async function realCached(
  ctx: PathGuardContext,
  target: string,
): Promise<string> {
  const resolvedTarget = path.resolve(target);
  let pending = ctx.realCache.get(resolvedTarget);
  if (!pending) {
    pending = real(resolvedTarget);
    ctx.realCache.set(resolvedTarget, pending);
  }

  return await pending;
}

async function guard(ctx: PathGuardContext, target: string): Promise<void> {
  const [targetReal, rootReal] = await Promise.all([
    realCached(ctx, target),
    ctx.rootReal,
  ]);
  if (inside(rootReal, targetReal)) {
    return;
  }

  if (!ctx.worktreeReal) {
    throw createApplyPatchBlockedError(
      `patch contains path outside workspace root: ${target}`,
    );
  }

  const treeReal = await ctx.worktreeReal;
  if (inside(treeReal, targetReal)) {
    return;
  }

  throw createApplyPatchBlockedError(
    `patch contains path outside workspace root: ${target}`,
  );
}

function createFileCacheContext(): FileCacheContext {
  return { stats: new Map() };
}

async function statCached(
  ctx: FileCacheContext,
  filePath: string,
): Promise<Stats | null> {
  let pending = ctx.stats.get(filePath);
  if (!pending) {
    const nextPending = fs.stat(filePath).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return null;
      }

      throw createApplyPatchInternalError(
        `Failed to stat file for patch verification: ${filePath}`,
        error,
      );
    });
    ctx.stats.set(filePath, nextPending);
    pending = nextPending;
  }

  return await pending;
}

async function assertRegularFile(
  ctx: FileCacheContext,
  filePath: string,
  verb: 'update' | 'delete',
): Promise<void> {
  const stat = await statCached(ctx, filePath);
  if (!stat || stat.isDirectory()) {
    throw createApplyPatchVerificationError(
      `Failed to read file to ${verb}: ${filePath}`,
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

function validatePatchPaths(hunks: PatchHunk[]): void {
  for (const hunk of hunks) {
    if (path.isAbsolute(hunk.path)) {
      throw createApplyPatchValidationError(
        `absolute patch paths are not allowed: ${hunk.path}`,
      );
    }

    if (
      hunk.type === 'update' &&
      hunk.move_path &&
      path.isAbsolute(hunk.move_path)
    ) {
      throw createApplyPatchValidationError(
        `absolute patch paths are not allowed: ${hunk.move_path}`,
      );
    }
  }
}

async function guardPatchTargets(
  root: string,
  worktree: string | undefined,
  targets: string[],
): Promise<number> {
  const guardContext = createPathGuardContext(root, worktree);

  for (const target of targets) {
    await guard(guardContext, target);
  }

  return targets.length;
}

export function parseValidatedPatch(patchText: string): PatchHunk[] {
  let hunks: PatchHunk[];

  try {
    hunks = parsePatchStrict(patchText).hunks;
  } catch (error) {
    throw createApplyPatchValidationError(getErrorMessage(error));
  }

  if (hunks.length === 0) {
    const clean = patchText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (clean === '*** Begin Patch\n*** End Patch') {
      throw createApplyPatchValidationError('empty patch');
    }

    throw createApplyPatchValidationError('no hunks found');
  }

  validatePatchPaths(hunks);

  return hunks;
}

async function readPreparedFileText(
  filePath: string,
  verb: 'update' | 'delete',
): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isMissingPathError(error)) {
      throw createApplyPatchVerificationError(
        `Failed to read file to ${verb}: ${filePath}`,
      );
    }

    throw createApplyPatchInternalError(
      `Failed to read file for patch verification: ${filePath}`,
      error,
    );
  }
}

export async function createPatchExecutionContext(
  root: string,
  patchText: string,
  worktree?: string,
): Promise<PatchExecutionContext> {
  const hunks = parseValidatedPatch(patchText);
  await guardPatchTargets(root, worktree, collectPatchTargets(root, hunks));
  const files = createFileCacheContext();
  const staged = new Map<string, PreparedFileState>();

  async function assertPreparedPathMissing(
    filePath: string,
    verb: 'add' | 'move',
  ): Promise<void> {
    const existing = staged.get(filePath);
    if (existing) {
      if (!existing.exists) {
        return;
      }

      throw createApplyPatchVerificationError(
        verb === 'add'
          ? `Add File target already exists: ${filePath}`
          : `Move destination already exists: ${filePath}`,
      );
    }

    const stat = await statCached(files, filePath);
    if (!stat) {
      return;
    }

    throw createApplyPatchVerificationError(
      verb === 'add'
        ? `Add File target already exists: ${filePath}`
        : `Move destination already exists: ${filePath}`,
    );
  }

  async function getPreparedFileState(
    filePath: string,
    verb: 'update' | 'delete',
  ): Promise<PreparedFileState> {
    const existing = staged.get(filePath);
    if (existing) {
      if (!existing.exists) {
        throw createApplyPatchVerificationError(
          `Failed to read file to ${verb}: ${filePath}`,
        );
      }

      return existing;
    }

    await assertRegularFile(files, filePath, verb);
    const stat = await statCached(files, filePath);
    const text = await readPreparedFileText(filePath, verb);
    const state: PreparedFileState = {
      exists: true,
      text,
      mode: stat ? stat.mode & 0o7777 : undefined,
      derived: false,
    };
    staged.set(filePath, state);
    return state;
  }

  return {
    hunks,
    staged,
    getPreparedFileState,
    assertPreparedPathMissing,
  };
}

export function resolvePreparedUpdate(
  filePath: string,
  currentText: string,
  hunk: UpdatePatchHunk,
  cfg: ApplyPatchRuntimeOptions,
): ResolvedPreparedUpdate {
  try {
    const { lines, resolved, eol, hasFinalNewline } =
      resolveUpdateChunksFromText(filePath, currentText, hunk.chunks, cfg);

    return {
      resolved,
      nextText: applyHits(
        lines,
        resolved.map((chunk) => chunk.hit),
        eol,
        hasFinalNewline,
      ),
    };
  } catch (error) {
    throw createApplyPatchVerificationError(getErrorMessage(error), error);
  }
}

export function stageAddedText(contents: string): string {
  return contents.length === 0 || contents.endsWith('\n')
    ? contents
    : `${contents}\n`;
}
