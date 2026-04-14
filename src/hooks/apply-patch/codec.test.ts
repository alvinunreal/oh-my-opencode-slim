import { describe, expect, test } from 'bun:test';

import {
  formatPatch,
  normalizeUnicode,
  parsePatch,
  parsePatchStrict,
  stripHeredoc,
} from './codec';
import type { ParsedPatch } from './types';

describe('apply-patch/codec', () => {
  test('stripHeredoc extracts the real patch content', () => {
    expect(
      stripHeredoc(`cat <<'PATCH'
*** Begin Patch
*** End Patch
PATCH`),
    ).toBe('*** Begin Patch\n*** End Patch');
  });

  test('parsePatch recognizes add delete update and move', () => {
    const parsed = parsePatch(`*** Begin Patch
*** Add File: added.txt
+alpha
*** Delete File: removed.txt
*** Update File: before.txt
*** Move to: after.txt
@@ ctx
 line-a
-line-b
+line-c
*** End of File
*** End Patch`);

    expect(parsed.hunks).toHaveLength(3);
    expect(parsed.hunks[0]).toEqual({
      type: 'add',
      path: 'added.txt',
      contents: 'alpha',
    });
    expect(parsed.hunks[1]).toEqual({ type: 'delete', path: 'removed.txt' });
    expect(parsed.hunks[2]).toEqual({
      type: 'update',
      path: 'before.txt',
      move_path: 'after.txt',
      chunks: [
        {
          old_lines: ['line-a', 'line-b'],
          new_lines: ['line-a', 'line-c'],
          change_context: 'ctx',
          is_end_of_file: true,
        },
      ],
    });
  });

  test('parsePatch tolerates heredocs with aggressive CRLF and preserves EOF', () => {
    const parsed = parsePatch(`cat <<'PATCH'\r
*** Begin Patch\r
*** Update File: sample.txt\r
@@\r
-alpha\r
+beta\r
*** End of File\r
*** End Patch\r
PATCH`);

    expect(parsed.hunks).toEqual([
      {
        type: 'update',
        path: 'sample.txt',
        chunks: [
          {
            old_lines: ['alpha'],
            new_lines: ['beta'],
            change_context: undefined,
            is_end_of_file: true,
          },
        ],
      },
    ]);
  });

  test('parsePatchStrict fails on garbage inside @@', () => {
    expect(() =>
      parsePatchStrict(`*** Begin Patch
*** Update File: sample.txt
@@
-alpha
garbage
+beta
*** End Patch`),
    ).toThrow('unexpected line in patch chunk');
  });

  test('parsePatchStrict fails on garbage inside Add File', () => {
    expect(() =>
      parsePatchStrict(`*** Begin Patch
*** Add File: sample.txt
+alpha
garbage
*** End Patch`),
    ).toThrow('unexpected line in Add File body');
  });

  test('parsePatchStrict fails on malformed Delete File', () => {
    expect(() =>
      parsePatchStrict(`*** Begin Patch
*** Delete File: sample.txt
+ghost
*** End Patch`),
    ).toThrow('unexpected line between hunks');
  });

  test('parsePatchStrict fails on garbage after End Patch', () => {
    expect(() =>
      parsePatchStrict(`*** Begin Patch
*** Delete File: sample.txt
*** End Patch
garbage`),
    ).toThrow('unexpected line after End Patch');
  });

  test('parsePatchStrict fails when Update File has no @@ chunks', () => {
    expect(() =>
      parsePatchStrict(`*** Begin Patch
*** Update File: sample.txt
*** End Patch`),
    ).toThrow('missing @@ chunk body');
  });

  test('formatPatch allows stable parse -> format -> parse roundtrips', () => {
    const parsed: ParsedPatch = {
      hunks: [
        {
          type: 'update',
          path: 'sample.txt',
          chunks: [
            {
              old_lines: ['alpha', 'beta'],
              new_lines: ['alpha', 'BETA'],
            },
          ],
        },
      ],
    };

    expect(parsePatch(formatPatch(parsed))).toEqual(parsed);
  });

  test('normalizeUnicode unifies expected typographic variants', () => {
    expect(normalizeUnicode('“uno”…\u00A0dos—tres')).toBe('"uno"... dos-tres');
  });

  test('normalizeUnicode covers less common typographic variants', () => {
    expect(normalizeUnicode('‛uno‟―dos')).toBe(`'uno"-dos`);
  });
});
