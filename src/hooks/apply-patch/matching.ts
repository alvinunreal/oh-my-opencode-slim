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

const AUTO_RESCUE_COMPARATOR_NAMES = new Set<MatchComparatorName>([
  'exact',
  'unicode',
  'trim-end',
  'unicode-trim-end',
]);

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

const comparatorEntries: NamedComparator[] = [
  { name: 'exact', exact: true, same: equalExact },
  { name: 'unicode', exact: false, same: equalUnicodeExact },
  { name: 'trim-end', exact: false, same: equalTrimEnd },
  {
    name: 'unicode-trim-end',
    exact: false,
    same: equalUnicodeTrimEnd,
  },
  { name: 'trim', exact: false, same: equalTrim },
  { name: 'unicode-trim', exact: false, same: equalUnicodeTrim },
];

const autoRescueComparatorEntries = comparatorEntries.filter((entry) =>
  AUTO_RESCUE_COMPARATOR_NAMES.has(entry.name),
);

const MAX_LCS_CHUNK_LINES = 48;
const MAX_LCS_CANDIDATES = 64;

export const autoRescueComparators: LineComparator[] =
  autoRescueComparatorEntries.map((entry) => entry.same);

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
  const hits = new Map<string, MatchHit>();

  for (const same of autoRescueComparators) {
    for (const leftIndex of list(lines, left, start, same)) {
      const from = leftIndex + left.length;

      for (const rightIndex of list(lines, right, from, same)) {
        const key = `${from}:${rightIndex}`;
        hits.set(key, {
          start: from,
          del: rightIndex - from,
          add: [...middle],
        });
      }
    }
  }

  if (hits.size === 0) {
    return { kind: 'miss' };
  }

  if (hits.size > 1) {
    return { kind: 'ambiguous', phase: 'prefix_suffix' };
  }

  return { kind: 'match', hit: [...hits.values()][0] };
}

export function score(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array<number>(b.length + 1).fill(0),
  );

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] =
        normalizeUnicode(a[i - 1].trim()) === normalizeUnicode(b[j - 1].trim())
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  return dp[a.length][b.length];
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

function hasStableBorders(oldLines: string[], candidate: string[]): boolean {
  if (oldLines.length === 0 || candidate.length !== oldLines.length) {
    return false;
  }

  // LCS keeps its current scoring, but only competes across windows whose
  // edges pass safe comparators. Ignoring full-trim here prevents automatic
  // rescue from changing indentation depth in format-sensitive files.
  const same = autoRescueComparators.some((compare) =>
    compare(oldLines[0], candidate[0]),
  );
  if (!same) {
    return false;
  }

  if (oldLines.length === 1) {
    return true;
  }

  return autoRescueComparators.some((compare) =>
    compare(oldLines[oldLines.length - 1], candidate[candidate.length - 1]),
  );
}

function collectBorderAnchoredStarts(
  lines: string[],
  oldLines: string[],
  start: number,
): number[] {
  if (oldLines.length === 0) {
    return [];
  }

  const firstHits = new Set<number>();
  const lastHits = new Set<number>();
  const lastLine = oldLines[oldLines.length - 1];

  for (const same of autoRescueComparators) {
    for (const index of list(lines, [oldLines[0]], start, same)) {
      firstHits.add(index);
    }

    for (const index of list(lines, [lastLine], start, same)) {
      lastHits.add(index);
    }
  }

  const candidates: number[] = [];
  for (const index of [...firstHits].sort((a, b) => a - b)) {
    const end = index + oldLines.length - 1;
    if (end >= lines.length || !lastHits.has(end)) {
      continue;
    }

    const candidate = lines.slice(index, index + oldLines.length);
    if (!hasStableBorders(oldLines, candidate)) {
      continue;
    }

    candidates.push(index);
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

  const from = start;
  const to = lines.length - old_lines.length;

  if (to < from) {
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
    if (index < from || index > to) {
      continue;
    }

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
