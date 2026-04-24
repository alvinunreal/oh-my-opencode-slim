import { normalizeUnicode } from './codec';
import type {
  LineComparator,
  MatchComparatorName,
  MatchHit,
  RescueResult,
  SeekHit,
} from './types';

type NamedComparator = {
  name: MatchComparatorName;
  exact: boolean;
  same: LineComparator;
};

export type PreparedAutoRescueTarget = {
  exact: string;
  unicode: string;
  trimEnd: string;
  unicodeTrimEnd: string;
};

export function equalExact(a: string, b: string): boolean {
  return a === b;
}

export function equalUnicodeExact(a: string, b: string): boolean {
  return normalizeUnicode(a) === normalizeUnicode(b);
}

export function equalTrimEnd(a: string, b: string): boolean {
  return a.trimEnd() === b.trimEnd();
}

export function equalUnicodeTrimEnd(a: string, b: string): boolean {
  return normalizeUnicode(a.trimEnd()) === normalizeUnicode(b.trimEnd());
}

export function equalTrim(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

export function equalUnicodeTrim(a: string, b: string): boolean {
  return normalizeUnicode(a.trim()) === normalizeUnicode(b.trim());
}

const autoRescueComparatorEntries: NamedComparator[] = [
  { name: 'exact', exact: true, same: equalExact },
  { name: 'unicode', exact: false, same: equalUnicodeExact },
  { name: 'trim-end', exact: false, same: equalTrimEnd },
  {
    name: 'unicode-trim-end',
    exact: false,
    same: equalUnicodeTrimEnd,
  },
];

const comparatorEntries: NamedComparator[] = [
  ...autoRescueComparatorEntries,
  { name: 'trim', exact: false, same: equalTrim },
  { name: 'unicode-trim', exact: false, same: equalUnicodeTrim },
];

const MAX_LCS_CHUNK_LINES = 48;
const MAX_LCS_CANDIDATES = 64;

export const autoRescueComparators: LineComparator[] =
  autoRescueComparatorEntries.map((entry) => entry.same);

export function prepareAutoRescueTarget(
  target: string,
): PreparedAutoRescueTarget {
  const trimEnd = target.trimEnd();
  const unicode = normalizeUnicode(target);

  return {
    exact: target,
    unicode,
    trimEnd,
    unicodeTrimEnd: trimEnd === target ? unicode : normalizeUnicode(trimEnd),
  };
}

export function matchPreparedAutoRescueComparator(
  candidate: string,
  target: PreparedAutoRescueTarget,
): MatchComparatorName | undefined {
  if (candidate === target.exact) {
    return 'exact';
  }

  const unicode = normalizeUnicode(candidate);
  if (unicode === target.unicode) {
    return 'unicode';
  }

  const trimEnd = candidate.trimEnd();
  if (trimEnd === target.trimEnd) {
    return 'trim-end';
  }

  const unicodeTrimEnd =
    trimEnd === candidate ? unicode : normalizeUnicode(trimEnd);
  if (unicodeTrimEnd === target.unicodeTrimEnd) {
    return 'unicode-trim-end';
  }

  return undefined;
}

// Full-trim comparators remain available as explicit utilities, but stay out
// of automatic canonicalization because they can cross indentation levels and
// rescue semantically unsafe patches.
export const permissiveComparators: LineComparator[] = comparatorEntries.map(
  (entry) => entry.same,
);

function tryMatch(
  lines: string[],
  pattern: string[],
  start: number,
  comparator: NamedComparator,
  eof: boolean,
): SeekHit | undefined {
  if (eof) {
    const at = lines.length - pattern.length;
    if (at >= start) {
      let ok = true;
      for (let index = 0; index < pattern.length; index += 1) {
        if (!comparator.same(lines[at + index], pattern[index])) {
          ok = false;
          break;
        }
      }

      if (ok) {
        return {
          index: at,
          comparator: comparator.name,
          exact: comparator.exact,
        };
      }
    }
  }

  for (let index = start; index <= lines.length - pattern.length; index += 1) {
    let ok = true;

    for (let inner = 0; inner < pattern.length; inner += 1) {
      if (!comparator.same(lines[index + inner], pattern[inner])) {
        ok = false;
        break;
      }
    }

    if (ok) {
      return {
        index,
        comparator: comparator.name,
        exact: comparator.exact,
      };
    }
  }

  return undefined;
}

export function seekMatch(
  lines: string[],
  pattern: string[],
  start: number,
  eof = false,
): SeekHit | undefined {
  if (pattern.length === 0) {
    return undefined;
  }

  for (const comparator of autoRescueComparatorEntries) {
    const hit = tryMatch(lines, pattern, start, comparator, eof);
    if (hit) {
      return hit;
    }
  }

  return undefined;
}

export function seek(
  lines: string[],
  pattern: string[],
  start: number,
  eof = false,
): number {
  return seekMatch(lines, pattern, start, eof)?.index ?? -1;
}

export function list(
  lines: string[],
  pattern: string[],
  start: number,
  same: LineComparator,
): number[] {
  if (pattern.length === 0) {
    return [];
  }

  const out: number[] = [];

  for (let index = start; index <= lines.length - pattern.length; index += 1) {
    let ok = true;

    for (let inner = 0; inner < pattern.length; inner += 1) {
      if (!same(lines[index + inner], pattern[inner])) {
        ok = false;
        break;
      }
    }

    if (ok) {
      out.push(index);
    }
  }

  return out;
}

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) {
      low = middle + 1;
      continue;
    }

    high = middle;
  }

  return low;
}

export function sameRescueLine(a: string, b: string): boolean {
  return equalExact(a, b) || equalUnicodeExact(a, b);
}

export function prefix(old_lines: string[], new_lines: string[]): number {
  let index = 0;

  while (
    index < old_lines.length &&
    index < new_lines.length &&
    sameRescueLine(old_lines[index], new_lines[index])
  ) {
    index += 1;
  }

  return index;
}

export function suffix(
  old_lines: string[],
  new_lines: string[],
  prefixLength: number,
): number {
  let index = 0;

  while (
    old_lines.length - index - 1 >= prefixLength &&
    new_lines.length - index - 1 >= prefixLength &&
    sameRescueLine(
      old_lines[old_lines.length - index - 1],
      new_lines[new_lines.length - index - 1],
    )
  ) {
    index += 1;
  }

  return index;
}

export function rescueByPrefixSuffix(
  lines: string[],
  old_lines: string[],
  new_lines: string[],
  start: number,
): RescueResult {
  const prefixLength = prefix(old_lines, new_lines);
  const suffixLength = suffix(old_lines, new_lines, prefixLength);

  if (prefixLength === 0 || suffixLength === 0) {
    return { kind: 'miss' };
  }

  const left = old_lines.slice(0, prefixLength);
  const right = old_lines.slice(old_lines.length - suffixLength);
  const middle = new_lines.slice(prefixLength, new_lines.length - suffixLength);

  if (left.length === 1 && right.length === 1) {
    const { leftHits, rightHits } = collectOneLinePrefixSuffixHits(
      lines,
      left[0],
      right[0],
      start,
    );

    return resolvePrefixSuffixHits(leftHits, rightHits, left.length, middle);
  }

  const hits = new Set<string>();
  let hit: MatchHit | undefined;

  for (const same of autoRescueComparators) {
    const leftHits = list(lines, left, start, same);
    if (leftHits.length === 0) {
      continue;
    }

    const rightHits = list(lines, right, leftHits[0] + left.length, same);
    if (rightHits.length === 0) {
      continue;
    }

    for (const leftIndex of leftHits) {
      const from = leftIndex + left.length;

      for (
        let index = lowerBound(rightHits, from);
        index < rightHits.length;
        index += 1
      ) {
        const rightIndex = rightHits[index];
        const key = `${from}:${rightIndex}`;
        if (!hits.has(key)) {
          hits.add(key);
          hit = {
            start: from,
            del: rightIndex - from,
            add: [...middle],
          };
        }

        if (hits.size > 1) {
          return { kind: 'ambiguous', phase: 'prefix_suffix' };
        }
      }
    }
  }

  if (!hit) {
    return { kind: 'miss' };
  }

  return { kind: 'match', hit };
}

function collectOneLinePrefixSuffixHits(
  lines: string[],
  left: string,
  right: string,
  start: number,
): { leftHits: number[]; rightHits: number[] } {
  const leftTarget = prepareAutoRescueTarget(left);
  const rightTarget = prepareAutoRescueTarget(right);
  const leftHits: number[] = [];
  const rightHits: number[] = [];

  // The one-line prefix/suffix fast path intentionally compares at the
  // broadest safe automatic level. This preserves exact/unicode/trim-end
  // behavior while avoiding multiple full scans for the common one-line edge
  // case. Full-trim remains excluded from automatic rescue.
  for (let index = start; index < lines.length; index += 1) {
    const line = prepareAutoRescueTarget(lines[index]);

    if (line.unicodeTrimEnd === leftTarget.unicodeTrimEnd) {
      leftHits.push(index);
    }

    if (index > start && line.unicodeTrimEnd === rightTarget.unicodeTrimEnd) {
      rightHits.push(index);
    }
  }

  return { leftHits, rightHits };
}

function resolvePrefixSuffixHits(
  leftHits: number[],
  rightHits: number[],
  leftLength: number,
  middle: string[],
): RescueResult {
  if (leftHits.length === 0 || rightHits.length === 0) {
    return { kind: 'miss' };
  }

  const hits = new Set<string>();
  let hit: MatchHit | undefined;

  for (const leftIndex of leftHits) {
    const from = leftIndex + leftLength;

    for (
      let index = lowerBound(rightHits, from);
      index < rightHits.length;
      index += 1
    ) {
      const rightIndex = rightHits[index];
      const key = `${from}:${rightIndex}`;
      if (!hits.has(key)) {
        hits.add(key);
        hit = {
          start: from,
          del: rightIndex - from,
          add: [...middle],
        };
      }

      if (hits.size > 1) {
        return { kind: 'ambiguous', phase: 'prefix_suffix' };
      }
    }
  }

  if (!hit) {
    return { kind: 'miss' };
  }

  return { kind: 'match', hit };
}

export function score(a: string[], b: string[]): number {
  const normalizedA = a.map(normalizeLcsLine);
  const normalizedB = b.map(normalizeLcsLine);
  let previous = Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    const current = Array<number>(b.length + 1).fill(0);

    for (let j = 1; j <= b.length; j += 1) {
      current[j] =
        normalizedA[i - 1] === normalizedB[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1]);
    }

    previous = current;
  }

  return previous[b.length];
}

function normalizeLcsLine(line: string): string {
  return normalizeUnicode(line).trim();
}

function countLcsUpperBound(a: string[], b: string[]): number {
  const counts = new Map<string, number>();

  for (const line of a) {
    const key = normalizeLcsLine(line);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let shared = 0;
  for (const line of b) {
    const key = normalizeLcsLine(line);
    const available = counts.get(key) ?? 0;
    if (available === 0) {
      continue;
    }

    shared += 1;
    if (available === 1) {
      counts.delete(key);
      continue;
    }

    counts.set(key, available - 1);
  }

  return shared;
}

function collectBorderAnchoredStarts(
  lines: string[],
  oldLines: string[],
  start: number,
): number[] {
  if (oldLines.length === 0) {
    return [];
  }

  const candidates: number[] = [];
  const firstLine = prepareAutoRescueTarget(oldLines[0]);
  const lastLine = prepareAutoRescueTarget(oldLines[oldLines.length - 1]);

  // LCS keeps its current scoring, but only competes across windows whose
  // edges pass safe comparators. Ignoring full-trim here prevents automatic
  // rescue from changing indentation depth in format-sensitive files.
  const lastOffset = oldLines.length - 1;
  const maxStart = lines.length - oldLines.length;

  for (let index = start; index <= maxStart; index += 1) {
    const end = index + lastOffset;

    if (
      matchPreparedAutoRescueComparator(lines[index], firstLine) === undefined
    ) {
      continue;
    }

    if (
      oldLines.length === 1 ||
      matchPreparedAutoRescueComparator(lines[end], lastLine) !== undefined
    ) {
      candidates.push(index);
    }
  }

  return candidates;
}

export function rescueByLcs(
  lines: string[],
  old_lines: string[],
  new_lines: string[],
  start: number,
): RescueResult {
  if (old_lines.length === 0 || lines.length === 0) {
    return { kind: 'miss' };
  }

  if (old_lines.length > MAX_LCS_CHUNK_LINES) {
    return { kind: 'miss' };
  }

  const needed =
    old_lines.length <= 2
      ? old_lines.length
      : Math.max(2, Math.ceil(old_lines.length * 0.7));
  const candidates = collectBorderAnchoredStarts(lines, old_lines, start);

  if (candidates.length === 0 || candidates.length > MAX_LCS_CANDIDATES) {
    return { kind: 'miss' };
  }

  let best: MatchHit | undefined;
  let bestScore = 0;
  let ties = 0;

  for (const index of candidates) {
    const window = lines.slice(index, index + old_lines.length);
    if (countLcsUpperBound(old_lines, window) < needed) {
      continue;
    }

    const current = score(old_lines, window);

    if (current > bestScore) {
      bestScore = current;
      ties = 1;
      best = {
        start: index,
        del: old_lines.length,
        add: [...new_lines],
      };
      continue;
    }

    if (current === bestScore && current > 0) {
      ties += 1;
    }
  }

  if (!best || bestScore < needed) {
    return { kind: 'miss' };
  }

  if (ties > 1) {
    return { kind: 'ambiguous', phase: 'lcs' };
  }

  return { kind: 'match', hit: best };
}
