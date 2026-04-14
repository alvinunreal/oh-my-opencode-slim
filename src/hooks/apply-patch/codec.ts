import type { ParsedPatch, PatchChunk, PatchHunk } from './types';

type ParseMode = 'permissive' | 'strict';

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function normalizeUnicode(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ');
}

export function stripHeredoc(input: string): string {
  const normalized = normalizeLineEndings(input);
  const match = normalized.match(
    /^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/,
  );
  return match ? match[2] : normalized;
}

export function normalizePatchText(patchText: string): string {
  return stripHeredoc(normalizeLineEndings(patchText).trim());
}

function parseHeader(lines: string[], index: number) {
  const line = lines[index];

  if (line.startsWith('*** Add File:')) {
    const file = line.slice('*** Add File:'.length).trim();
    return file ? { file, next: index + 1 } : null;
  }

  if (line.startsWith('*** Delete File:')) {
    const file = line.slice('*** Delete File:'.length).trim();
    return file ? { file, next: index + 1 } : null;
  }

  if (line.startsWith('*** Update File:')) {
    const file = line.slice('*** Update File:'.length).trim();
    let move: string | undefined;
    let next = index + 1;

    if (next < lines.length && lines[next].startsWith('*** Move to:')) {
      const moveTarget = lines[next].slice('*** Move to:'.length).trim();
      if (!moveTarget) {
        return null;
      }

      move = moveTarget;
      next += 1;
    }

    return file ? { file, move, next } : null;
  }

  return null;
}

function unexpectedPatchLine(context: string, line: string): never {
  const rendered = line.length === 0 ? '<empty>' : line;
  throw new Error(
    `Invalid patch format: unexpected line ${context}: ${rendered}`,
  );
}

function parseChunks(lines: string[], index: number, mode: ParseMode) {
  const chunks: PatchChunk[] = [];
  let at = index;

  while (at < lines.length && !lines[at].startsWith('***')) {
    if (!lines[at].startsWith('@@')) {
      if (mode === 'strict') {
        unexpectedPatchLine('in update body', lines[at]);
      }
      at += 1;
      continue;
    }

    const context = lines[at].slice(2).trim() || undefined;
    at += 1;

    const old_lines: string[] = [];
    const new_lines: string[] = [];
    let eof = false;

    while (
      at < lines.length &&
      !lines[at].startsWith('@@') &&
      (!lines[at].startsWith('***') || lines[at] === '*** End of File')
    ) {
      const line = lines[at];

      if (line === '*** End of File') {
        eof = true;
        at += 1;
        break;
      }

      if (line.startsWith(' ')) {
        old_lines.push(line.slice(1));
        new_lines.push(line.slice(1));
        at += 1;
        continue;
      }

      if (line.startsWith('-')) {
        old_lines.push(line.slice(1));
        at += 1;
        continue;
      }

      if (line.startsWith('+')) {
        new_lines.push(line.slice(1));
        at += 1;
        continue;
      }

      if (mode === 'strict') {
        unexpectedPatchLine('in patch chunk', line);
      }

      at += 1;
    }

    chunks.push({
      old_lines,
      new_lines,
      change_context: context,
      is_end_of_file: eof || undefined,
    });
  }

  return { chunks, next: at };
}

function parseAdd(lines: string[], index: number, mode: ParseMode) {
  let contents = '';
  let at = index;

  while (at < lines.length && !lines[at].startsWith('***')) {
    if (lines[at].startsWith('+')) {
      contents += `${lines[at].slice(1)}\n`;
      at += 1;
      continue;
    }

    if (mode === 'strict') {
      unexpectedPatchLine('in Add File body', lines[at]);
    }

    at += 1;
  }

  if (contents.endsWith('\n')) {
    contents = contents.slice(0, -1);
  }

  return { content: contents, next: at };
}

function parsePatchInternal(patchText: string, mode: ParseMode): ParsedPatch {
  const clean = normalizePatchText(patchText);
  const lines = clean.split('\n');
  const begin = lines.findIndex((line) => line.trim() === '*** Begin Patch');
  const end = lines.findIndex((line) => line.trim() === '*** End Patch');

  if (begin === -1 || end === -1 || begin >= end) {
    throw new Error('Invalid patch format: missing Begin/End markers');
  }

  if (mode === 'strict') {
    for (const line of lines.slice(0, begin)) {
      unexpectedPatchLine('before Begin Patch', line);
    }

    for (const line of lines.slice(end + 1)) {
      unexpectedPatchLine('after End Patch', line);
    }
  }

  const hunks: PatchHunk[] = [];
  let index = begin + 1;

  while (index < end) {
    const header = parseHeader(lines, index);

    if (!header) {
      if (mode === 'strict') {
        unexpectedPatchLine('between hunks', lines[index]);
      }
      index += 1;
      continue;
    }

    if (lines[index].startsWith('*** Add File:')) {
      const next = parseAdd(lines, header.next, mode);
      hunks.push({
        type: 'add',
        path: header.file,
        contents: next.content,
      });
      index = next.next;
      continue;
    }

    if (lines[index].startsWith('*** Delete File:')) {
      hunks.push({ type: 'delete', path: header.file });
      index = header.next;
      continue;
    }

    const next = parseChunks(lines, header.next, mode);
    if (mode === 'strict' && next.chunks.length === 0) {
      throw new Error(
        `Invalid patch format: Update File is missing @@ chunk body: ${header.file}`,
      );
    }

    hunks.push({
      type: 'update',
      path: header.file,
      move_path: header.move,
      chunks: next.chunks,
    });
    index = next.next;
  }

  return { hunks };
}

export function parsePatch(patchText: string): ParsedPatch {
  return parsePatchInternal(patchText, 'permissive');
}

export function parsePatchStrict(patchText: string): ParsedPatch {
  return parsePatchInternal(patchText, 'strict');
}

function diffMatrix(old_lines: string[], new_lines: string[]): number[][] {
  const dp = Array.from({ length: old_lines.length + 1 }, () =>
    Array<number>(new_lines.length + 1).fill(0),
  );

  for (let oldIndex = 1; oldIndex <= old_lines.length; oldIndex += 1) {
    for (let newIndex = 1; newIndex <= new_lines.length; newIndex += 1) {
      dp[oldIndex][newIndex] =
        old_lines[oldIndex - 1] === new_lines[newIndex - 1]
          ? dp[oldIndex - 1][newIndex - 1] + 1
          : Math.max(dp[oldIndex - 1][newIndex], dp[oldIndex][newIndex - 1]);
    }
  }

  return dp;
}

function renderChunk(chunk: PatchChunk): string[] {
  const lines = [chunk.change_context ? `@@ ${chunk.change_context}` : '@@'];
  const dp = diffMatrix(chunk.old_lines, chunk.new_lines);
  const body: string[] = [];
  let oldIndex = chunk.old_lines.length;
  let newIndex = chunk.new_lines.length;

  while (oldIndex > 0 && newIndex > 0) {
    if (chunk.old_lines[oldIndex - 1] === chunk.new_lines[newIndex - 1]) {
      body.push(` ${chunk.old_lines[oldIndex - 1]}`);
      oldIndex -= 1;
      newIndex -= 1;
      continue;
    }

    if (dp[oldIndex - 1][newIndex] >= dp[oldIndex][newIndex - 1]) {
      body.push(`-${chunk.old_lines[oldIndex - 1]}`);
      oldIndex -= 1;
      continue;
    }

    body.push(`+${chunk.new_lines[newIndex - 1]}`);
    newIndex -= 1;
  }

  while (oldIndex > 0) {
    body.push(`-${chunk.old_lines[oldIndex - 1]}`);
    oldIndex -= 1;
  }

  while (newIndex > 0) {
    body.push(`+${chunk.new_lines[newIndex - 1]}`);
    newIndex -= 1;
  }

  lines.push(...body.reverse());

  if (chunk.is_end_of_file) {
    lines.push('*** End of File');
  }

  return lines;
}

function renderAddContents(contents: string): string[] {
  if (contents.length === 0) {
    return [];
  }

  return contents.split('\n').map((line) => `+${line}`);
}

export function formatPatch(patch: ParsedPatch): string {
  const lines = ['*** Begin Patch'];

  for (const hunk of patch.hunks) {
    if (hunk.type === 'add') {
      lines.push(`*** Add File: ${hunk.path}`);
      lines.push(...renderAddContents(hunk.contents));
      continue;
    }

    if (hunk.type === 'delete') {
      lines.push(`*** Delete File: ${hunk.path}`);
      continue;
    }

    lines.push(`*** Update File: ${hunk.path}`);
    if (hunk.move_path) {
      lines.push(`*** Move to: ${hunk.move_path}`);
    }
    for (const chunk of hunk.chunks) {
      lines.push(...renderChunk(chunk));
    }
  }

  lines.push('*** End Patch');
  return lines.join('\n');
}
