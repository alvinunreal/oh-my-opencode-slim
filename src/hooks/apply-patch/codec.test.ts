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
  test('stripHeredoc extrae el contenido real del patch', () => {
    expect(
      stripHeredoc(`cat <<'PATCH'
*** Begin Patch
*** End Patch
PATCH`),
    ).toBe('*** Begin Patch\n*** End Patch');
  });

  test('parsePatch reconoce add delete update y move', () => {
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

  test('parsePatch tolera heredoc con CRLF agresivo y conserva EOF', () => {
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

  test('parsePatchStrict falla con basura dentro de @@', () => {
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

  test('parsePatchStrict falla con basura dentro de Add File', () => {
    expect(() =>
      parsePatchStrict(`*** Begin Patch
*** Add File: sample.txt
+alpha
garbage
*** End Patch`),
    ).toThrow('unexpected line in Add File body');
  });

  test('parsePatchStrict falla con Delete File mal formado', () => {
    expect(() =>
      parsePatchStrict(`*** Begin Patch
*** Delete File: sample.txt
+ghost
*** End Patch`),
    ).toThrow('unexpected line between hunks');
  });

  test('parsePatchStrict falla con basura después de End Patch', () => {
    expect(() =>
      parsePatchStrict(`*** Begin Patch
*** Delete File: sample.txt
*** End Patch
garbage`),
    ).toThrow('unexpected line after End Patch');
  });

  test('parsePatchStrict falla si Update File no trae chunks @@', () => {
    expect(() =>
      parsePatchStrict(`*** Begin Patch
*** Update File: sample.txt
*** End Patch`),
    ).toThrow('missing @@ chunk body');
  });

  test('formatPatch permite roundtrip estable parse -> format -> parse', () => {
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

  test('normalizeUnicode unifica variantes tipográficas esperadas', () => {
    expect(normalizeUnicode('“uno”…\u00A0dos—tres')).toBe('"uno"... dos-tres');
  });

  test('normalizeUnicode cubre variantes tipográficas menos comunes', () => {
    expect(normalizeUnicode('‛uno‟―dos')).toBe(`'uno"-dos`);
  });
});
