import { normalizeLineEndings } from './codec';
import {
  commonEdges,
  matchesAt,
  prepareAutoRescueTarget,
  rescueByLcs,
  rescueByPrefixSuffix,
  sameRescueLine,
  seek,
  seekMatch,
} from './matching';
import type {
  MatchHit,
  PatchChunk,
  PatchHostFlavor,
  ResolvedChunk,
} from './types';

type FileLines = {
  lines: string[];
  eol: '\n' | '\r\n';
  hasFinalNewline: boolean;
};

export function splitFileLines(text: string): FileLines {
  const eol = text.match(/\r\n|\n|\r/)?.[0] === '\r\n' ? '\r\n' : '\n';
  const normalized = normalizeLineEndings(text);
  const hasFinalNewline = normalized.endsWith('\n');
  // Empty text is zero lines, not one empty line; '\n' is one empty line.
  const lines = normalized.length === 0 ? [] : normalized.split('\n');
  if (lines.length > 0 && hasFinalNewline) {
    lines.pop();
  }

  return { lines, eol, hasFinalNewline };
}

export function resolveChunkStart(
  lines: string[],
  chunk: PatchChunk,
  start: number,
): number {
  if (!chunk.change_context) return start;

  const at = seek(lines, [chunk.change_context], start);
  return at === -1 ? start : at + 1;
}

function resolveUniqueAnchor(
  lines: string[],
  changeContext: string,
  start: number,
):
  | { kind: 'ambiguous' }
  | {
      kind: 'match';
      index: number;
      exact: boolean;
    } {
  let matchedIndex: number | undefined;
  const anchorTarget = prepareAutoRescueTarget(changeContext);

  for (let index = start; index < lines.length; index += 1) {
    if (!matchesAt(lines[index], anchorTarget)) {
      continue;
    }

    if (matchedIndex !== undefined) {
      return { kind: 'ambiguous' };
    }

    matchedIndex = index;
  }

  if (matchedIndex === undefined) throw new Error('Missing insertion anchor');

  return {
    kind: 'match',
    index: matchedIndex,
    exact: lines[matchedIndex] === changeContext,
  };
}

function buildResolvedChunk(
  lines: string[],
  chunk: PatchChunk,
  hit: MatchHit,
  rewritten: boolean,
  canonicalStart = hit.start,
  canonicalEnd = hit.start + hit.del,
  canonicalNewLines = chunk.new_lines,
  canonicalChangeContext?: string,
): ResolvedChunk {
  return {
    hit,
    canonical_old_lines: lines.slice(canonicalStart, canonicalEnd),
    canonical_new_lines: [...canonicalNewLines],
    canonical_change_context: canonicalChangeContext,
    resolved_is_end_of_file: canonicalEnd === lines.length,
    rewritten,
    canonical_start: canonicalStart,
    canonical_end: canonicalEnd,
  };
}

export function locateChunk(
  lines: string[],
  file: string,
  chunk: PatchChunk,
  start: number,
  flavor: PatchHostFlavor = 'v1',
): ResolvedChunk {
  let old_lines = chunk.old_lines;
  let new_lines = chunk.new_lines;
  const find = (old: string[]) =>
    seekMatch(
      lines,
      old,
      flavor === 'v2' && chunk.is_end_of_file
        ? Math.max(start, lines.length - old.length)
        : start,
      chunk.is_end_of_file ?? false,
    );
  let match = find(old_lines);
  let retried = false;
  if (!match && old_lines.at(-1) === '') {
    old_lines = old_lines.slice(0, -1);
    if (new_lines.at(-1) === '') new_lines = new_lines.slice(0, -1);
    match = find(old_lines);
    retried = !!match;
  }

  if (match) {
    return buildResolvedChunk(
      lines,
      chunk,
      { start: match.index, del: old_lines.length, add: [...new_lines] },
      !match.exact || retried,
      match.index,
      match.index + old_lines.length,
      new_lines,
    );
  }

  const prefixSuffix = rescueByPrefixSuffix(lines, old_lines, new_lines, start);

  if (prefixSuffix.kind === 'ambiguous') {
    throw new Error(
      `Prefix/suffix rescue was ambiguous in ${file}:\n${chunk.old_lines.join(
        '\n',
      )}`,
    );
  }

  if (prefixSuffix.kind === 'match') {
    const { prefixLength, suffixLength } = commonEdges(
      old_lines,
      new_lines,
      sameRescueLine,
    );
    const canonicalStart = prefixSuffix.hit.start - prefixLength;
    const canonicalEnd =
      prefixSuffix.hit.start + prefixSuffix.hit.del + suffixLength;
    const canonicalNewLines = [
      ...lines.slice(canonicalStart, prefixSuffix.hit.start),
      ...prefixSuffix.hit.add,
      ...lines.slice(
        prefixSuffix.hit.start + prefixSuffix.hit.del,
        canonicalEnd,
      ),
    ];

    return buildResolvedChunk(
      lines,
      chunk,
      prefixSuffix.hit,
      true,
      canonicalStart,
      canonicalEnd,
      canonicalNewLines,
    );
  }

  const lcs = rescueByLcs(lines, old_lines, new_lines, start);

  if (lcs.kind === 'ambiguous') {
    throw new Error(
      `LCS rescue was ambiguous in ${file}:\n${chunk.old_lines.join('\n')}`,
    );
  }

  if (lcs.kind === 'match') {
    return buildResolvedChunk(lines, chunk, lcs.hit, true);
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

export function resolveUpdate(
  file: string,
  text: string,
  chunks: PatchChunk[],
  flavor: PatchHostFlavor = 'v1',
): {
  resolved: ResolvedChunk[];
  nextText: string;
} {
  const { lines, eol, hasFinalNewline } = splitFileLines(text);
  const resolved: ResolvedChunk[] = [];
  let start = 0;

  for (const chunk of chunks) {
    const chunkStart = resolveChunkStart(lines, chunk, start);
    const canonicalContext =
      chunk.change_context && chunkStart > start
        ? lines[chunkStart - 1]
        : undefined;
    const contextRewritten = canonicalContext !== chunk.change_context;

    if (chunk.old_lines.length === 0) {
      const appendAt =
        flavor === 'v1' && lines.at(-1) === ''
          ? lines.length - 1
          : lines.length;
      if (chunk.is_end_of_file || !chunk.change_context) {
        const consumesBlank = appendAt < lines.length ? 1 : 0;
        resolved.push(
          buildResolvedChunk(
            lines,
            chunk,
            { start: appendAt, del: consumesBlank, add: [...chunk.new_lines] },
            contextRewritten || consumesBlank !== 0,
            appendAt,
            appendAt + consumesBlank,
            chunk.new_lines,
            canonicalContext,
          ),
        );
        start = appendAt;
        continue;
      }

      if (!canonicalContext) {
        throw new Error(
          `Failed to find insertion anchor in ${file}:\n${chunk.change_context}`,
        );
      }
      const anchorMatch = resolveUniqueAnchor(lines, canonicalContext, start);
      if (anchorMatch.kind === 'ambiguous') {
        throw new Error(
          `Insertion anchor was ambiguous in ${file}:\n${chunk.change_context}`,
        );
      }

      const insertAt = anchorMatch.index + 1;
      const hit = { start: insertAt, del: 0, add: [...chunk.new_lines] };
      if (insertAt === lines.length) {
        resolved.push(
          buildResolvedChunk(
            lines,
            chunk,
            hit,
            !anchorMatch.exact || contextRewritten,
            insertAt,
            insertAt,
            chunk.new_lines,
            canonicalContext,
          ),
        );
        start = insertAt;
        continue;
      }

      const anchor = lines[insertAt];
      const trailingBlank = anchor === '' && insertAt === lines.length - 1;

      resolved.push(
        buildResolvedChunk(
          lines,
          chunk,
          trailingBlank
            ? { start: insertAt, del: 1, add: [...chunk.new_lines] }
            : hit,
          true,
          insertAt,
          insertAt + 1,
          trailingBlank ? chunk.new_lines : [...chunk.new_lines, anchor],
          canonicalContext,
        ),
      );
      start = insertAt;
      continue;
    }

    const found = locateChunk(lines, file, chunk, chunkStart, flavor);
    if (
      flavor === 'v2' &&
      chunk.is_end_of_file &&
      !found.resolved_is_end_of_file
    ) {
      throw new Error(`Failed to find EOF-anchored lines in ${file}`);
    }
    if (
      chunk.change_context &&
      !canonicalContext &&
      seek(lines, found.canonical_old_lines, found.canonical_start + 1) >= 0
    ) {
      throw new Error(
        `Failed to find context '${chunk.change_context}' in ${file}`,
      );
    }
    found.canonical_change_context = canonicalContext;
    found.rewritten ||= contextRewritten;
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
    resolved,
    nextText: applyHits(
      lines,
      resolved.map((chunk) => chunk.hit),
      eol,
      hasFinalNewline,
    ),
  };
}
