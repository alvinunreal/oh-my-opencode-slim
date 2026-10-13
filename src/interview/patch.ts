export class InterviewPatchApplyError extends Error {
  constructor(
    readonly failedHunk: string,
    readonly contextWindow: string,
  ) {
    super('Interview spec patch did not apply');
    this.name = 'InterviewPatchApplyError';
  }
}

type HunkLine = { kind: ' ' | '+' | '-'; text: string };

type Hunk = {
  raw: string;
  oldStart: number;
  oldCount: number;
  newCount: number;
  lines: HunkLine[];
};

export type PatchApplyResult =
  | { ok: true; text: string }
  | { ok: false; failedHunk: string; contextWindow: string };

const CONTEXT_RADIUS = 10;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split('\n');
  if (text.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

function parseHunks(patch: string): Hunk[] | { failedHunk: string } {
  const rawLines = patch.replace(/\r\n/g, '\n').split('\n');
  const hunks: Hunk[] = [];
  let current: {
    header: string;
    oldStart: number;
    oldCount: number;
    newCount: number;
    body: string[];
  } | null = null;

  const flush = (): { failedHunk: string } | null => {
    if (!current) {
      return null;
    }
    const lines: HunkLine[] = [];
    for (const line of current.body) {
      if (line.length === 0 || line.startsWith('\\')) {
        continue;
      }
      const kind = line[0];
      if (kind !== ' ' && kind !== '+' && kind !== '-') {
        return {
          failedHunk: [current.header, ...current.body].join('\n'),
        };
      }
      lines.push({ kind, text: line.slice(1) });
    }
    if (lines.length === 0) {
      return { failedHunk: current.header };
    }
    hunks.push({
      raw: [current.header, ...current.body].join('\n'),
      oldStart: current.oldStart,
      oldCount: current.oldCount,
      newCount: current.newCount,
      lines,
    });
    current = null;
    return null;
  };

  for (const line of rawLines) {
    const header = line.match(HUNK_HEADER);
    if (header) {
      const failed = flush();
      if (failed) {
        return failed;
      }
      current = {
        header: line,
        oldStart: Number(header[1]),
        oldCount: Number(header[2] ?? 1),
        newCount: Number(header[3] ?? 1),
        body: [],
      };
      continue;
    }
    if (current) {
      current.body.push(line);
    }
  }
  const failed = flush();
  if (failed) {
    return failed;
  }
  return hunks;
}

function matchesAt(lines: string[], needle: string[], index: number): boolean {
  if (index < 0 || index + needle.length > lines.length) {
    return false;
  }
  for (let offset = 0; offset < needle.length; offset += 1) {
    if (lines[index + offset] !== needle[offset]) {
      return false;
    }
  }
  return true;
}

function contextAround(lines: string[], center: number): string {
  const start = Math.max(0, Math.min(center, lines.length) - CONTEXT_RADIUS);
  const end = Math.min(lines.length, start + CONTEXT_RADIUS * 2);
  return lines.slice(start, end).join('\n');
}

function findSequence(
  lines: string[],
  needle: string[],
  hint: number,
  min: number,
): number {
  if (needle.length === 0) {
    return Math.min(Math.max(hint, min), lines.length);
  }
  if (hint >= min && matchesAt(lines, needle, hint)) {
    return hint;
  }
  const last = lines.length - needle.length;
  let nearest = -1;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = min; index <= last; index += 1) {
    if (!matchesAt(lines, needle, index)) continue;
    const candidateDistance = Math.abs(index - hint);
    if (candidateDistance < distance) {
      nearest = index;
      distance = candidateDistance;
    }
  }
  return nearest;
}

/** Apply a unified diff to the current spec body. Frontmatter is not part of `source`. */
export function applyUnifiedDiff(
  source: string,
  patch: string,
): PatchApplyResult {
  const parsed = parseHunks(patch);
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      failedHunk: parsed.failedHunk,
      contextWindow: '',
    };
  }
  if (parsed.length === 0) {
    return {
      ok: false,
      failedHunk: patch.trim() || '(empty patch)',
      contextWindow: '',
    };
  }

  const trailingNewline = source.endsWith('\n');
  let lines = splitLines(source);
  let searchFrom = 0;
  let lineOffset = 0;

  for (const hunk of parsed) {
    const oldLines = hunk.lines
      .filter((line) => line.kind !== '+')
      .map((line) => line.text);
    const newLines = hunk.lines
      .filter((line) => line.kind !== '-')
      .map((line) => line.text);
    const hinted = Math.max(
      0,
      (hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1) + lineOffset,
    );
    const index = findSequence(lines, oldLines, hinted, searchFrom);
    if (index < 0) {
      return {
        ok: false,
        failedHunk: hunk.raw,
        contextWindow: contextAround(lines, hinted),
      };
    }
    lines = [
      ...lines.slice(0, index),
      ...newLines,
      ...lines.slice(index + oldLines.length),
    ];
    lineOffset += newLines.length - oldLines.length;
    searchFrom = index + newLines.length;
  }

  const text = lines.join('\n');
  return {
    ok: true,
    text: trailingNewline && text.length > 0 ? `${text}\n` : text,
  };
}
