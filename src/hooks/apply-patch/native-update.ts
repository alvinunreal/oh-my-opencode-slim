import { seek } from './matching';
import type { PatchChunk, PatchHostFlavor } from './types';

// Model the native apply_patch update executor, not the hook's rescue rules.
// Native resolves every hit against the original file, then applies them back
// to front. v1's parser discards the EOF marker; v2 anchors it.
export function nativeDeriveUpdate(
  file: string,
  text: string,
  chunks: PatchChunk[],
  flavor: PatchHostFlavor = 'v1',
): string {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const hits: { start: number; del: number; add: string[] }[] = [];
  let cursor = 0;

  for (const chunk of chunks) {
    if (chunk.change_context) {
      const at = seek(lines, [chunk.change_context.trim()], cursor);
      if (at < 0) {
        throw new Error(
          `Failed to find context '${chunk.change_context}' in ${file}`,
        );
      }
      cursor = at + 1;
    }

    if (chunk.old_lines.length === 0) {
      const at =
        flavor === 'v1' && lines.at(-1) === ''
          ? lines.length - 1
          : lines.length;
      hits.push({ start: at, del: 0, add: chunk.new_lines });
      continue;
    }

    let old = chunk.old_lines;
    let next = chunk.new_lines;
    const find = (pattern: string[]) => {
      const start =
        flavor === 'v2' && chunk.is_end_of_file
          ? Math.max(cursor, lines.length - pattern.length)
          : cursor;
      return seek(lines, pattern, start);
    };
    let at = find(old);
    if (at < 0 && old.at(-1) === '') {
      old = old.slice(0, -1);
      if (next.at(-1) === '') next = next.slice(0, -1);
      at = find(old);
    }
    if (at < 0) {
      throw new Error(
        `Failed to find expected lines in ${file}:\n${chunk.old_lines.join('\n')}`,
      );
    }
    hits.push({ start: at, del: old.length, add: next });
    cursor = at + old.length;
  }

  hits.sort((a, b) => a.start - b.start);
  for (let index = hits.length - 1; index >= 0; index -= 1) {
    const hit = hits[index];
    lines.splice(hit.start, hit.del, ...hit.add);
  }
  if (lines.at(-1) !== '') lines.push('');
  return lines.join('\n');
}
