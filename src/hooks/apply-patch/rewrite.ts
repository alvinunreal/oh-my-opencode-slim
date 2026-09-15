import path from 'node:path';

import { formatPatch, normalizePatchText } from './codec';
import {
  createApplyPatchVerificationError,
  ensureApplyPatchError,
} from './errors';
import {
  createPatchExecutionContext,
  resolvePreparedUpdate,
  stageAddedText,
} from './execution-context';
import { deriveNewContentFromText } from './resolution';
import type {
  ApplyPatchRuntimeOptions,
  PatchHunk,
  UpdatePatchHunk,
} from './types';

export type RewritePatchResult = {
  patchText: string;
  changed: boolean;
};

type RewriteUpdateGroup = {
  index: number;
  sourcePath: string;
  outputPath: string;
  sourceFilePath: string;
  outputFilePath: string;
  baseText: string;
  finalText: string;
  chunks?: UpdatePatchHunk['chunks'];
};

type RewriteAddGroup = {
  index: number;
  outputPath: string;
  outputFilePath: string;
  finalText: string;
};

type RewriteDependencyGroup =
  | { kind: 'add'; group: RewriteAddGroup }
  | { kind: 'update'; group: RewriteUpdateGroup };

function normalizeTextLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function splitPatchTextLines(text: string): string[] {
  // Empty text is zero lines, not one empty line; '\n' is one empty line.
  if (text.length === 0) {
    return [];
  }

  const normalized = normalizeTextLineEndings(text);
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

function createCollapsedUpdateHunk(
  pathValue: string,
  filePath: string,
  baseText: string,
  finalText: string,
  cfg: ApplyPatchRuntimeOptions,
  movePath?: string,
): UpdatePatchHunk {
  const collapsedChunk = {
    old_lines: splitPatchTextLines(baseText),
    new_lines: splitPatchTextLines(finalText),
    change_context: undefined,
    is_end_of_file: true,
  } satisfies UpdatePatchHunk['chunks'][number];

  const minimizedChunk = minimizeMergedChunk(collapsedChunk);
  const chunk =
    minimizedChunk.old_lines.length === collapsedChunk.old_lines.length &&
    minimizedChunk.new_lines.length === collapsedChunk.new_lines.length &&
    minimizedChunk.change_context === collapsedChunk.change_context &&
    minimizedChunk.is_end_of_file === collapsedChunk.is_end_of_file
      ? collapsedChunk
      : (() => {
          try {
            return deriveNewContentFromText(
              filePath,
              baseText,
              [minimizedChunk],
              cfg,
            ) === finalText
              ? minimizedChunk
              : collapsedChunk;
          } catch {
            // Keep the whole-file chunk when trimming shared context would make
            // the fallback ambiguous or no longer reproduce the same result.
            return collapsedChunk;
          }
        })();

  return {
    type: 'update',
    path: pathValue,
    move_path: movePath,
    chunks: [chunk],
  };
}

function clonePatchChunks(
  chunks: UpdatePatchHunk['chunks'],
): UpdatePatchHunk['chunks'] {
  return chunks.map((chunk) => ({
    old_lines: [...chunk.old_lines],
    new_lines: [...chunk.new_lines],
    change_context: chunk.change_context,
    is_end_of_file: chunk.is_end_of_file,
  }));
}

function minimizeMergedChunk(chunk: UpdatePatchHunk['chunks'][number]) {
  let prefixLength = 0;
  while (
    prefixLength < chunk.old_lines.length &&
    prefixLength < chunk.new_lines.length &&
    chunk.old_lines[prefixLength] === chunk.new_lines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    chunk.old_lines.length - suffixLength - 1 >= prefixLength &&
    chunk.new_lines.length - suffixLength - 1 >= prefixLength &&
    chunk.old_lines[chunk.old_lines.length - suffixLength - 1] ===
      chunk.new_lines[chunk.new_lines.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  if (prefixLength === 0 && suffixLength === 0) {
    return {
      old_lines: [...chunk.old_lines],
      new_lines: [...chunk.new_lines],
      change_context: chunk.change_context,
      is_end_of_file: chunk.is_end_of_file,
    };
  }

  return {
    old_lines: chunk.old_lines.slice(
      prefixLength,
      chunk.old_lines.length - suffixLength,
    ),
    new_lines: chunk.new_lines.slice(
      prefixLength,
      chunk.new_lines.length - suffixLength,
    ),
    change_context:
      prefixLength > 0
        ? chunk.old_lines[prefixLength - 1]
        : chunk.change_context,
    is_end_of_file:
      chunk.is_end_of_file && suffixLength === 0 ? true : undefined,
  };
}

function createUpdateHunk(
  pathValue: string,
  chunks: UpdatePatchHunk['chunks'],
  movePath?: string,
): UpdatePatchHunk {
  return {
    type: 'update',
    path: pathValue,
    move_path: movePath,
    chunks: clonePatchChunks(chunks),
  };
}

function mergeSameFileUpdateGroupChunks(
  filePath: string,
  group: RewriteUpdateGroup,
  nextChunks: UpdatePatchHunk['chunks'],
  finalText: string,
  cfg: ApplyPatchRuntimeOptions,
): UpdatePatchHunk['chunks'] | undefined {
  if (!group.chunks) {
    return undefined;
  }

  // minimizeMergedChunk never mutates its input, so the original chunk
  // arrays can be mapped directly.
  const mergedChunks = [
    ...group.chunks.map(minimizeMergedChunk),
    ...nextChunks.map(minimizeMergedChunk),
  ];

  try {
    const mergedText = deriveNewContentFromText(
      filePath,
      group.baseText,
      mergedChunks,
      cfg,
    );

    return mergedText === finalText ? mergedChunks : undefined;
  } catch {
    return undefined;
  }
}

function renderRewriteDependencyGroup(
  group: RewriteDependencyGroup,
  cfg: ApplyPatchRuntimeOptions,
): PatchHunk {
  if (group.kind === 'add') {
    return {
      type: 'add',
      path: group.group.outputPath,
      // Guarantee the canonical newline-terminated Add representation:
      // finalText may legitimately lack a final newline (e.g. updates on a
      // no-final-newline file), which the renderer would otherwise drop.
      contents: stageAddedText(group.group.finalText),
    };
  }

  return group.group.chunks
    ? createUpdateHunk(
        group.group.sourcePath,
        group.group.chunks,
        group.group.outputPath !== group.group.sourcePath
          ? group.group.outputPath
          : undefined,
      )
    : createCollapsedUpdateHunk(
        group.group.sourcePath,
        group.group.sourceFilePath,
        group.group.baseText,
        group.group.finalText,
        cfg,
        group.group.outputPath !== group.group.sourcePath
          ? group.group.outputPath
          : undefined,
      );
}

function combineDependentUpdateGroup(
  filePath: string,
  group: RewriteDependencyGroup,
  nextChunks: UpdatePatchHunk['chunks'],
  finalText: string,
  nextOutputPath: string,
  nextOutputFilePath: string,
  cfg: ApplyPatchRuntimeOptions,
): RewriteDependencyGroup {
  if (group.kind === 'add') {
    return {
      kind: 'add',
      group: {
        ...group.group,
        outputPath: nextOutputPath,
        outputFilePath: nextOutputFilePath,
        finalText,
      },
    };
  }

  const mergedChunks =
    group.group.outputFilePath === filePath &&
    group.group.sourceFilePath === filePath &&
    nextOutputFilePath === filePath
      ? mergeSameFileUpdateGroupChunks(
          filePath,
          group.group,
          nextChunks,
          finalText,
          cfg,
        )
      : undefined;

  return {
    kind: 'update',
    group: {
      ...group.group,
      outputPath: nextOutputPath,
      outputFilePath: nextOutputFilePath,
      finalText,
      chunks: mergedChunks,
    },
  };
}

export async function rewritePatch(
  root: string,
  patchText: string,
  cfg: ApplyPatchRuntimeOptions,
  worktree?: string,
): Promise<RewritePatchResult> {
  try {
    const {
      hunks,
      pathsNormalized,
      staged,
      getPreparedFileState,
      assertPreparedPathMissing,
    } = await createPatchExecutionContext(root, patchText, worktree);
    const normalizedPatchText = normalizePatchText(patchText);
    const rewritten: PatchHunk[] = [];
    let changed = false;

    const dependencyGroups = new Map<string, RewriteDependencyGroup>();

    function clearDependencyGroup(filePath: string) {
      dependencyGroups.delete(filePath);
    }

    function hunkTouchedPaths(hunk: PatchHunk): Set<string> {
      const touched = new Set<string>([path.resolve(root, hunk.path)]);
      if (hunk.type === 'update' && hunk.move_path) {
        touched.add(path.resolve(root, hunk.move_path));
      }
      return touched;
    }

    // Fold a dependency group in place only when no hunk emitted after it
    // touches its paths: reordering around interleaved hunks (delete of the
    // move destination, add recreating the move source) is exactly where
    // folded patches stop being order-equivalent. On any interference the
    // fold is abandoned and the caller emits the update standalone, which
    // preserves the original patch ordering and is always safe.
    function reemitFoldedGroup(
      groupIndex: number,
      rendered: PatchHunk,
    ): number | undefined {
      const touched = hunkTouchedPaths(rendered);
      for (let index = groupIndex + 1; index < rewritten.length; index += 1) {
        for (const target of hunkTouchedPaths(rewritten[index])) {
          if (touched.has(target)) {
            return undefined;
          }
        }
      }

      rewritten[groupIndex] = rendered;
      return groupIndex;
    }

    for (const hunk of hunks) {
      if (hunk.type === 'add') {
        const filePath = path.resolve(root, hunk.path);
        await assertPreparedPathMissing(filePath, 'add');
        rewritten.push(hunk);
        clearDependencyGroup(filePath);
        const finalText = stageAddedText(hunk.contents);
        staged.set(filePath, {
          exists: true,
          text: finalText,
          derived: true,
        });
        dependencyGroups.set(filePath, {
          kind: 'add',
          group: {
            index: rewritten.length - 1,
            outputPath: hunk.path,
            outputFilePath: filePath,
            finalText,
          },
        });
        continue;
      }

      if (hunk.type === 'delete') {
        const filePath = path.resolve(root, hunk.path);
        await getPreparedFileState(filePath, 'delete');
        clearDependencyGroup(filePath);
        rewritten.push(hunk);
        staged.set(filePath, { exists: false, derived: true });
        continue;
      }

      const filePath = path.resolve(root, hunk.path);
      const currentDependency = dependencyGroups.get(filePath);
      const current = await getPreparedFileState(filePath, 'update');
      if (!current.exists) {
        throw createApplyPatchVerificationError(
          `Failed to read file to update: ${filePath}`,
        );
      }

      const movePath = hunk.move_path
        ? path.resolve(root, hunk.move_path)
        : undefined;
      if (movePath && movePath !== filePath) {
        await assertPreparedPathMissing(movePath, 'move');
      }

      const { resolved, nextText } = resolvePreparedUpdate(
        filePath,
        current.text,
        hunk,
        cfg,
      );

      let next: UpdatePatchHunk['chunks'] = [];
      let lastCanonicalEnd = -1;
      let sawCanonicalOverlap = false;
      for (const [index, chunk] of resolved.entries()) {
        const changeContext =
          chunk.canonical_change_context ?? hunk.chunks[index].change_context;
        const isEndOfFile =
          hunk.chunks[index].is_end_of_file && chunk.resolved_is_end_of_file
            ? true
            : undefined;

        const previous = next[next.length - 1];
        const overlap = previous ? lastCanonicalEnd - chunk.canonical_start : 0;

        if (
          previous &&
          overlap > 0 &&
          overlap <= previous.old_lines.length &&
          chunk.canonical_old_lines.length >= overlap
        ) {
          // A rescue extended this chunk's canonical range over lines the
          // previous chunk already claimed. Serialize both as one chunk so
          // every source line is consumed exactly once; separate chunks
          // would re-match consumed context and fail on re-apply.
          previous.old_lines = previous.old_lines
            .slice(0, previous.old_lines.length - overlap)
            .concat(chunk.canonical_old_lines);
          previous.new_lines = previous.new_lines
            .slice(0, previous.new_lines.length - overlap)
            .concat(chunk.canonical_new_lines);
          previous.is_end_of_file = isEndOfFile ?? previous.is_end_of_file;
          lastCanonicalEnd = Math.max(lastCanonicalEnd, chunk.canonical_end);
          sawCanonicalOverlap = true;
          continue;
        }

        if (overlap > 0) {
          sawCanonicalOverlap = true;
        }

        next.push({
          old_lines: [...chunk.canonical_old_lines],
          new_lines: [...chunk.canonical_new_lines],
          change_context: changeContext,
          is_end_of_file: isEndOfFile,
        });
        lastCanonicalEnd = chunk.canonical_end;
      }

      if (sawCanonicalOverlap) {
        // Overlap merges must reproduce the accepted hits exactly. If an
        // exotic shape does not, fall back to a verified whole-file chunk
        // instead of shipping a rewrite that cannot re-apply.
        try {
          if (
            deriveNewContentFromText(filePath, current.text, next, cfg) !==
            nextText
          ) {
            next = createCollapsedUpdateHunk(
              hunk.path,
              filePath,
              current.text,
              nextText,
              cfg,
            ).chunks;
          }
        } catch {
          next = createCollapsedUpdateHunk(
            hunk.path,
            filePath,
            current.text,
            nextText,
            cfg,
          ).chunks;
        }
      }

      for (const chunk of resolved) {
        if (!chunk.rewritten) {
          continue;
        }
        changed = true;
      }

      const nextOutputPath = hunk.move_path ?? hunk.path;
      const nextOutputFilePath = movePath ?? filePath;

      let folded = false;
      if (current.derived && currentDependency) {
        const nextGroup = combineDependentUpdateGroup(
          filePath,
          currentDependency,
          next,
          nextText,
          nextOutputPath,
          nextOutputFilePath,
          cfg,
        );
        const foldedIndex = reemitFoldedGroup(
          currentDependency.group.index,
          renderRewriteDependencyGroup(nextGroup, cfg),
        );
        if (foldedIndex !== undefined) {
          changed = true;
          clearDependencyGroup(filePath);
          if (movePath && movePath !== filePath) {
            clearDependencyGroup(movePath);
          }
          nextGroup.group.index = foldedIndex;
          dependencyGroups.set(nextOutputFilePath, nextGroup);
          folded = true;
        }
      }

      if (!folded) {
        // First touch of this path, or an interfering hunk made the fold
        // order-unsafe: emit this update standalone, which preserves the
        // original patch ordering.
        rewritten.push(createUpdateHunk(hunk.path, next, hunk.move_path));
        clearDependencyGroup(filePath);
        if (movePath && movePath !== filePath) {
          clearDependencyGroup(movePath);
        }
        dependencyGroups.set(nextOutputFilePath, {
          kind: 'update',
          group: {
            index: rewritten.length - 1,
            sourcePath: hunk.path,
            outputPath: nextOutputPath,
            sourceFilePath: filePath,
            outputFilePath: nextOutputFilePath,
            baseText: current.text,
            finalText: nextText,
            chunks: clonePatchChunks(next),
          },
        });
      }

      if (movePath && movePath !== filePath) {
        staged.set(filePath, { exists: false, derived: true });
        staged.set(movePath, {
          exists: true,
          text: nextText,
          mode: current.mode,
          derived: true,
        });
      } else {
        staged.set(filePath, {
          exists: true,
          text: nextText,
          mode: current.mode,
          derived: true,
        });
      }
    }

    if (!changed) {
      if (pathsNormalized) {
        return {
          patchText: formatPatch({ hunks }),
          changed: true,
        };
      }

      if (normalizedPatchText !== patchText) {
        return {
          patchText: normalizedPatchText,
          changed: true,
        };
      }

      return {
        patchText,
        changed: false,
      };
    }

    return {
      patchText: formatPatch({ hunks: rewritten }),
      changed: true,
    };
  } catch (error) {
    throw ensureApplyPatchError(error, 'Unexpected rewrite failure');
  }
}

export async function rewritePatchText(
  root: string,
  patchText: string,
  cfg: ApplyPatchRuntimeOptions,
  worktree?: string,
): Promise<string> {
  return (await rewritePatch(root, patchText, cfg, worktree)).patchText;
}
