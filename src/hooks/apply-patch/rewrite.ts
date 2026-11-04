import path from 'node:path';

import { formatPatch, normalizePatchText } from './codec';
import { ApplyPatchError, ensureApplyPatchError } from './errors';
import { simulatePatch, stageAddedText } from './execution-context';
import { commonEdges } from './matching';
import { nativeDeriveUpdate } from './native-update';
import { splitFileLines } from './resolution';
import type { PatchHostFlavor, PatchHunk, UpdatePatchHunk } from './types';

export type RewritePatchResult = {
  patchText: string;
  changed: boolean;
};

type RewriteDependencyGroup =
  | { kind: 'add'; index: number }
  | {
      kind: 'update';
      index: number;
      sourcePath: string;
      sourceFilePath: string;
      outputFilePath: string;
      baseText: string;
      chunks?: UpdatePatchHunk['chunks'];
    };

const lf = (text: string) =>
  text.replace(/\r\n/g, '\n').replace(/([^\n])$/, '$1\n');

function reproduces(
  filePath: string,
  baseText: string,
  chunks: UpdatePatchHunk['chunks'],
  finalText: string,
  flavor: PatchHostFlavor,
): 0 | 1 | 2 {
  // 2: exact modulo CRLF/final newline; 1: native's writer dropped one final blank line.
  try {
    const actual = lf(nativeDeriveUpdate(filePath, baseText, chunks, flavor));
    const expected = lf(finalText);
    return actual === expected ? 2 : `${actual}\n` === expected ? 1 : 0;
  } catch {
    return 0;
  }
}

function createCollapsedUpdateHunk(
  pathValue: string,
  filePath: string,
  baseText: string,
  finalText: string,
  flavor: PatchHostFlavor,
  movePath?: string,
): UpdatePatchHunk {
  const collapsedChunk = {
    old_lines: splitFileLines(baseText).lines,
    new_lines: splitFileLines(finalText).lines,
    change_context: undefined,
    is_end_of_file: true,
  } satisfies UpdatePatchHunk['chunks'][number];

  const minimizedChunk = minimizeMergedChunk(collapsedChunk);
  const chunk =
    minimizedChunk.old_lines.length === collapsedChunk.old_lines.length &&
    minimizedChunk.new_lines.length === collapsedChunk.new_lines.length
      ? collapsedChunk
      : reproduces(filePath, baseText, [minimizedChunk], finalText, flavor)
        ? minimizedChunk
        : collapsedChunk;
  if (!reproduces(filePath, baseText, [chunk], finalText, flavor)) {
    throw new ApplyPatchError(
      'verification',
      `Native update cannot reproduce the resolved file: ${filePath}`,
    );
  }

  return {
    type: 'update',
    path: pathValue,
    move_path: movePath,
    chunks: [chunk],
  };
}

function minimizeMergedChunk(chunk: UpdatePatchHunk['chunks'][number]) {
  const { prefixLength, suffixLength } = commonEdges(
    chunk.old_lines,
    chunk.new_lines,
  );

  if (prefixLength === 0 && suffixLength === 0) {
    return {
      old_lines: [...chunk.old_lines],
      new_lines: [...chunk.new_lines],
      change_context: chunk.change_context,
      is_end_of_file: chunk.is_end_of_file,
    };
  }

  if (
    chunk.old_lines.length === prefixLength + suffixLength &&
    (suffixLength > 0 || !chunk.is_end_of_file)
  ) {
    return {
      ...chunk,
      old_lines: [...chunk.old_lines],
      new_lines: [...chunk.new_lines],
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
    is_end_of_file: suffixLength === 0 ? chunk.is_end_of_file : undefined,
  };
}

export async function rewritePatch(
  root: string,
  patchText: string,
  worktree?: string,
  flavor: PatchHostFlavor = 'v1',
): Promise<RewritePatchResult> {
  try {
    const { hunks, pathsNormalized, steps } = await simulatePatch(
      root,
      patchText,
      worktree,
      flavor,
    );
    const rewritten: PatchHunk[] = [];
    let changed = false;

    const dependencyGroups = new Map<string, RewriteDependencyGroup>();

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
    // fold is abandoned and the update stays in order. Native still verifies
    // each separate update against the pre-patch file, not the staged state.
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

    for (const step of steps) {
      const { filePath } = step;
      if (step.type === 'add') {
        rewritten.push(step.hunk);
        dependencyGroups.set(filePath, {
          kind: 'add',
          index: rewritten.length - 1,
        });
        continue;
      }

      if (step.type === 'delete') {
        dependencyGroups.delete(filePath);
        rewritten.push(step.hunk);
        continue;
      }

      const hunk = step.hunk;
      const { current, movePath, resolved, nextText } = step;
      const currentDependency = dependencyGroups.get(filePath);

      let next: UpdatePatchHunk['chunks'] = [];
      let lastCanonicalEnd = -1;
      let sawCanonicalOverlap = false;
      for (const [index, chunk] of resolved.entries()) {
        const changeContext = chunk.canonical_change_context;
        const isEndOfFile =
          index === resolved.length - 1 &&
          hunk.chunks[index].is_end_of_file &&
          chunk.resolved_is_end_of_file
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
          // previous chunk already claimed. Serialize as one chunk, then
          // verify it with native matching before forwarding the rewrite.
          previous.old_lines = previous.old_lines
            .slice(0, previous.old_lines.length - overlap)
            .concat(chunk.canonical_old_lines);
          previous.new_lines = previous.new_lines
            .slice(0, previous.new_lines.length - overlap)
            .concat(chunk.canonical_new_lines);
          previous.is_end_of_file = isEndOfFile;
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
        // Native matching checks this merged shape; use a whole-file chunk
        // only if it too reproduces the staged text under native semantics.
        if (!reproduces(filePath, current.text, next, nextText, flavor)) {
          next = createCollapsedUpdateHunk(
            hunk.path,
            filePath,
            current.text,
            nextText,
            flavor,
          ).chunks;
        }
      }

      const rewrittenHunk = resolved.some((chunk) => chunk.rewritten);
      const text = current.text;
      let keepOriginal = false;
      if (!current.derived) {
        const rewrite = rewrittenHunk
          ? reproduces(filePath, text, next, nextText, flavor)
          : 0;
        const original =
          rewrite === 2
            ? 0
            : reproduces(filePath, text, hunk.chunks, nextText, flavor);
        if (!rewrite && !original) {
          if (
            flavor !== 'v1' ||
            !hunk.chunks.some((chunk) => chunk.is_end_of_file)
          ) {
            throw new ApplyPatchError(
              'verification',
              `Native patch tool would not reproduce the verified update: ${filePath}`,
            );
          }
          next = createCollapsedUpdateHunk(
            hunk.path,
            filePath,
            text,
            nextText,
            flavor,
          ).chunks;
          changed = true;
        }
        keepOriginal = original > rewrite;
        if (keepOriginal) next = hunk.chunks;
      }
      changed ||= !keepOriginal && rewrittenHunk;

      const nextOutputPath = hunk.move_path ?? hunk.path;
      const nextOutputFilePath = movePath ?? filePath;

      let folded = false;
      if (current.derived && currentDependency) {
        let nextGroup: RewriteDependencyGroup;
        let rendered: PatchHunk;
        if (currentDependency.kind === 'add') {
          nextGroup = currentDependency;
          // Add contents must remain newline-terminated after a fold.
          rendered = {
            type: 'add',
            path: nextOutputPath,
            contents: stageAddedText(nextText),
          };
        } else {
          const group = currentDependency;
          let chunks: UpdatePatchHunk['chunks'] | undefined;
          if (
            group.chunks &&
            group.outputFilePath === filePath &&
            group.sourceFilePath === filePath &&
            nextOutputFilePath === filePath
          ) {
            const merged = [
              ...group.chunks.map(minimizeMergedChunk),
              ...next.map(minimizeMergedChunk),
            ];
            if (
              reproduces(filePath, group.baseText, merged, nextText, flavor)
            ) {
              chunks = merged;
            }
          }
          nextGroup = {
            ...group,
            outputFilePath: nextOutputFilePath,
            chunks,
          };
          const move =
            nextOutputPath !== group.sourcePath ? nextOutputPath : undefined;
          rendered = chunks
            ? {
                type: 'update',
                path: group.sourcePath,
                move_path: move,
                chunks,
              }
            : createCollapsedUpdateHunk(
                group.sourcePath,
                group.sourceFilePath,
                group.baseText,
                nextText,
                flavor,
                move,
              );
        }
        const foldedIndex = reemitFoldedGroup(
          currentDependency.index,
          rendered,
        );
        if (foldedIndex !== undefined) {
          changed = true;
          dependencyGroups.delete(filePath);
          nextGroup.index = foldedIndex;
          dependencyGroups.set(nextOutputFilePath, nextGroup);
          folded = true;
        }
      }

      if (!folded) {
        // First touch of this path, or an interfering hunk made the fold
        // order-unsafe: emit this update standalone, which preserves the
        // original patch ordering.
        rewritten.push({
          type: 'update',
          path: hunk.path,
          move_path: hunk.move_path,
          chunks: next,
        });
        dependencyGroups.delete(filePath);
        dependencyGroups.set(nextOutputFilePath, {
          kind: 'update',
          index: rewritten.length - 1,
          sourcePath: hunk.path,
          sourceFilePath: filePath,
          outputFilePath: nextOutputFilePath,
          baseText: current.text,
          chunks: next,
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

      const normalizedPatchText = normalizePatchText(patchText);
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
