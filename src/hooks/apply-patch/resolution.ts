import * as fs from 'node:fs/promises';

import {
  autoRescueComparators,
  list,
  prefix,
  rescueByLcs,
  rescueByPrefixSuffix,
  seek,
  seekMatch,
  suffix,
} from './matching';
import type {
  ApplyPatchRescueStrategy,
  ApplyPatchRuntimeOptions,
  MatchComparatorName,
  MatchHit,
  PatchChunk,
  ResolvedChunk,
} from './types';

type FileLines = {
  lines: string[];
  eol: '\n' | '\r\n';
  hasFinalNewline: boolean;
};

function splitFileLines(text: string): FileLines {
  const eol = text.match(/\r\n|\n|\r/)?.[0] === '\r\n' ? '\r\n' : '\n';
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const hasFinalNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (hasFinalNewline) {
    lines.pop();
  }

  return { lines, eol, hasFinalNewline };
}

async function readFileLinesWithEol(file: string): Promise<FileLines> {
  let text: string;

  try {
    text = await fs.readFile(file, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read file ${file}: ${error}`);
  }

  return splitFileLines(text);
}

export async function readFileLines(file: string): Promise<string[]> {
  return (await readFileLinesWithEol(file)).lines;
}

export function resolveChunkStart(
  lines: string[],
  chunk: PatchChunk,
  start: number,
): number {
  if (!chunk.change_context) {
    return start;
  }

  const at = seek(lines, [chunk.change_context], start);
  return at === -1 ? start : at + 1;
}

function resolveUniqueAnchor(
  lines: string[],
  changeContext: string,
  start: number,
):
  | { kind: 'missing' }
  | { kind: 'ambiguous' }
  | {
      kind: 'match';
      index: number;
      exact: boolean;
      comparator: MatchComparatorName;
      canonicalLine: string;
    } {
  const hits = new Set<number>();

  for (const same of autoRescueComparators) {
    for (const index of list(lines, [changeContext], start, same)) {
      hits.add(index);
    }
  }

  if (hits.size === 0) {
    return { kind: 'missing' };
  }

  if (hits.size > 1) {
    return { kind: 'ambiguous' };
  }

  const index = [...hits][0];
  const canonicalLine = lines[index];
  const comparator = seekMatch(lines, [changeContext], index)?.comparator;

  return {
    kind: 'match',
    index,
    exact: canonicalLine === changeContext,
    comparator: comparator ?? 'exact',
    canonicalLine,
  };
}

export function locateChunk(
  lines: string[],
  file: string,
  chunk: PatchChunk,
  start: number,
  cfg: ApplyPatchRuntimeOptions,
): ResolvedChunk {
  const old_lines = chunk.old_lines;
  const new_lines = chunk.new_lines;
  const match = seekMatch(
    lines,
    old_lines,
    start,
    chunk.is_end_of_file ?? false,
  );

  if (match) {
    const canonical_old_lines = lines.slice(
      match.index,
      match.index + old_lines.length,
    );
    const rewritten = !match.exact;

    return {
      hit: { start: match.index, del: old_lines.length, add: [...new_lines] },
      old_lines,
      canonical_old_lines,
      canonical_new_lines: [...chunk.new_lines],
      resolved_is_end_of_file:
        match.index + canonical_old_lines.length === lines.length,
      rewritten,
      strategy: undefined,
      matchComparator: match.comparator,
    };
  }

  if (cfg.prefixSuffix) {
    const rescued = rescueByPrefixSuffix(lines, old_lines, new_lines, start);

    if (rescued.kind === 'ambiguous') {
      throw new Error(
        `Prefix/suffix rescue was ambiguous in ${file}:\n${chunk.old_lines.join(
          '\n',
        )}`,
      );
    }

    if (rescued.kind === 'match') {
      const prefixLength = prefix(old_lines, new_lines);
      const suffixLength = suffix(old_lines, new_lines, prefixLength);
      const canonicalStart = rescued.hit.start - prefixLength;
      const canonicalEnd = rescued.hit.start + rescued.hit.del + suffixLength;

      return {
        hit: rescued.hit,
        old_lines,
        canonical_old_lines: lines.slice(canonicalStart, canonicalEnd),
        canonical_new_lines: [...chunk.new_lines],
        resolved_is_end_of_file: canonicalEnd === lines.length,
        rewritten: true,
        strategy: 'prefix/suffix',
        matchComparator: 'exact',
      };
    }
  }

  if (cfg.lcsRescue) {
    const rescued = rescueByLcs(lines, old_lines, new_lines, start);

    if (rescued.kind === 'ambiguous') {
      throw new Error(
        `LCS rescue was ambiguous in ${file}:\n${chunk.old_lines.join('\n')}`,
      );
    }

    if (rescued.kind === 'match') {
      return {
        hit: rescued.hit,
        old_lines,
        canonical_old_lines: lines.slice(
          rescued.hit.start,
          rescued.hit.start + rescued.hit.del,
        ),
        canonical_new_lines: [...chunk.new_lines],
        resolved_is_end_of_file:
          rescued.hit.start + rescued.hit.del === lines.length,
        rewritten: true,
        strategy: 'lcs',
        matchComparator: 'exact',
      };
    }
  }

  throw new Error(
    `Failed to find expected lines in ${file}:\n${chunk.old_lines.join('\n')}`,
  );
}

export function applyHits(
  lines: string[],
  hits: MatchHit[],
  eol: '\n' | '\r\n' = '\n',
  hasFinalNewline = true,
): string {
  const out = [...lines];

  for (let index = hits.length - 1; index >= 0; index -= 1) {
    out.splice(hits[index].start, hits[index].del, ...hits[index].add);
  }

  if (out.length === 0) {
    return '';
  }

  const rendered = out.join(eol);
  return hasFinalNewline ? `${rendered}${eol}` : rendered;
}

function resolveUpdateChunksFromFileLines(
  file: string,
  state: FileLines,
  chunks: PatchChunk[],
  cfg: ApplyPatchRuntimeOptions,
): {
  lines: string[];
  resolved: ResolvedChunk[];
  eol: '\n' | '\r\n';
  hasFinalNewline: boolean;
} {
  const lines = [...state.lines];
  const resolved: ResolvedChunk[] = [];
  let start = 0;

  for (const chunk of chunks) {
    const chunkStart = resolveChunkStart(lines, chunk, start);
    let strategy: ApplyPatchRescueStrategy | undefined;

    if (chunk.old_lines.length === 0) {
      if (chunk.is_end_of_file) {
        resolved.push({
          hit: {
            start: lines.length,
            del: 0,
            add: [...chunk.new_lines],
          },
          old_lines: [],
          canonical_old_lines: [],
          canonical_new_lines: [...chunk.new_lines],
          resolved_is_end_of_file: true,
          rewritten: false,
          strategy,
          matchComparator: 'exact',
        });
        start = lines.length;
        continue;
      }

      if (!chunk.change_context) {
        throw new Error(`Missing insertion anchor in ${file}`);
      }

      const anchorMatch = resolveUniqueAnchor(
        lines,
        chunk.change_context,
        start,
      );
      if (anchorMatch.kind === 'missing') {
        throw new Error(
          `Failed to find insertion anchor in ${file}:\n${chunk.change_context}`,
        );
      }

      if (anchorMatch.kind === 'ambiguous') {
        throw new Error(
          `Insertion anchor was ambiguous in ${file}:\n${chunk.change_context}`,
        );
      }

      const insertAt = anchorMatch.index + 1;
      if (insertAt === lines.length) {
        resolved.push({
          hit: {
            start: insertAt,
            del: 0,
            add: [...chunk.new_lines],
          },
          old_lines: [],
          canonical_old_lines: [],
          canonical_new_lines: [...chunk.new_lines],
          canonical_change_context: anchorMatch.exact
            ? undefined
            : anchorMatch.canonicalLine,
          resolved_is_end_of_file: insertAt === lines.length,
          rewritten: !anchorMatch.exact,
          strategy: anchorMatch.exact ? strategy : 'anchor',
          matchComparator: anchorMatch.comparator,
        });
        start = insertAt;
        continue;
      }

      const anchor = lines[insertAt];

      strategy = 'anchor';
      resolved.push({
        hit: {
          start: insertAt,
          del: 0,
          add: [...chunk.new_lines],
        },
        old_lines: [],
        canonical_old_lines: [anchor],
        canonical_new_lines: [...chunk.new_lines, anchor],
        resolved_is_end_of_file: insertAt + 1 === lines.length,
        rewritten: true,
        strategy,
        matchComparator: 'exact',
      });
      start = insertAt;
      continue;
    }

    const found = locateChunk(lines, file, chunk, chunkStart, cfg);
    resolved.push(found);
    start = found.hit.start + found.hit.del;
  }

  resolved.sort((a, b) => a.hit.start - b.hit.start);

  for (let index = 1; index < resolved.length; index += 1) {
    const previous = resolved[index - 1].hit;
    const current = resolved[index].hit;
    if (previous.start + previous.del > current.start) {
      throw new Error(`Overlapping patch chunks in ${file}`);
    }
  }

  return {
    lines,
    resolved,
    eol: state.eol,
    hasFinalNewline: state.hasFinalNewline,
  };
}

export async function resolveUpdateChunks(
  file: string,
  chunks: PatchChunk[],
  cfg: ApplyPatchRuntimeOptions,
): Promise<{
  lines: string[];
  resolved: ResolvedChunk[];
  eol: '\n' | '\r\n';
  hasFinalNewline: boolean;
}> {
  return resolveUpdateChunksFromFileLines(
    file,
    await readFileLinesWithEol(file),
    chunks,
    cfg,
  );
}

export function deriveNewContentFromText(
  file: string,
  text: string,
  chunks: PatchChunk[],
  cfg: ApplyPatchRuntimeOptions,
): string {
  const { lines, resolved, eol, hasFinalNewline } =
    resolveUpdateChunksFromFileLines(file, splitFileLines(text), chunks, cfg);

  return applyHits(
    lines,
    resolved.map((chunk) => chunk.hit),
    eol,
    hasFinalNewline,
  );
}

export function resolveUpdateChunksFromText(
  file: string,
  text: string,
  chunks: PatchChunk[],
  cfg: ApplyPatchRuntimeOptions,
): {
  lines: string[];
  resolved: ResolvedChunk[];
  eol: '\n' | '\r\n';
  hasFinalNewline: boolean;
} {
  return resolveUpdateChunksFromFileLines(
    file,
    splitFileLines(text),
    chunks,
    cfg,
  );
}

export async function deriveNewContent(
  file: string,
  chunks: PatchChunk[],
  cfg: ApplyPatchRuntimeOptions,
): Promise<string> {
  const { lines, resolved, eol, hasFinalNewline } = await resolveUpdateChunks(
    file,
    chunks,
    cfg,
  );
  return applyHits(
    lines,
    resolved.map((chunk) => chunk.hit),
    eol,
    hasFinalNewline,
  );
}
