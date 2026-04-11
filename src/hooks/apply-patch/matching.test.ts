import { describe, expect, test } from 'bun:test';

import {
  autoRescueComparators,
  permissiveComparators,
  prefix,
  rescueByLcs,
  rescueByPrefixSuffix,
  seek,
  seekMatch,
  suffix,
} from './matching';

describe('apply-patch/matching', () => {
  test('seek encuentra coincidencias con unicode y trim-end', () => {
    expect(seek(['console.log(“hola”);  '], ['console.log("hola");'], 0)).toBe(
      0,
    );
  });

  test('seek no rescata coincidencias trim-only con indentación distinta', () => {
    expect(seek(['  console.log("hola");'], ['console.log("hola");'], 0)).toBe(
      -1,
    );
  });

  test('prefix y suffix detectan bordes comunes', () => {
    const oldLines = [
      'const title = "Hola";',
      'old-value',
      'const footer = "Fin";',
    ];
    const newLines = [
      'const title = “Hola”;',
      'new-value',
      'const footer = “Fin”;',
    ];

    expect(prefix(oldLines, newLines)).toBe(1);
    expect(suffix(oldLines, newLines, 1)).toBe(1);
  });

  test('rescueByPrefixSuffix rescata un bloque stale único', () => {
    const result = rescueByPrefixSuffix(
      ['top', 'const title = “Hola”;', 'stale-value', 'const footer = “Fin”;'],
      ['const title = "Hola";', 'old-value', 'const footer = "Fin";'],
      ['const title = “Hola”;', 'new-value', 'const footer = “Fin”;'],
      0,
    );

    expect(result).toEqual({
      kind: 'match',
      hit: {
        start: 2,
        del: 1,
        add: ['new-value'],
      },
    });
  });

  test('rescueByPrefixSuffix marca ambigüedad cuando hay varias ubicaciones', () => {
    expect(
      rescueByPrefixSuffix(
        ['left', 'stale-one', 'right', 'gap', 'left', 'stale-two', 'right'],
        ['left', 'old', 'right'],
        ['left', 'new', 'right'],
        0,
      ),
    ).toEqual({ kind: 'ambiguous', phase: 'prefix_suffix' });
  });

  test('rescueByLcs respeta el start y encuentra un candidato único', () => {
    const result = rescueByLcs(
      [
        'head',
        'left',
        'stable-old',
        'keep',
        'right',
        'gap',
        'anchor',
        'left',
        'stale-old',
        'keep',
        'right',
        'tail',
      ],
      ['left', 'old', 'keep', 'right'],
      ['left', 'new', 'keep', 'right'],
      5,
    );

    expect(result).toEqual({
      kind: 'match',
      hit: {
        start: 7,
        del: 4,
        add: ['left', 'new', 'keep', 'right'],
      },
    });
  });

  test('rescueByLcs marca ambigüedad cuando dos ventanas empatan sin bordes comunes', () => {
    expect(
      rescueByLcs(
        ['head', 'alpha', 'beta', 'mid', 'alpha', 'beta', 'tail'],
        ['alpha', 'beta'],
        ['ALPHA', 'BETA'],
        0,
      ),
    ).toEqual({ kind: 'ambiguous', phase: 'lcs' });
  });

  test('rescueByLcs rechaza ventanas con un solo borde coincidente aunque el score sea alto', () => {
    expect(
      rescueByLcs(
        ['a', 'a', 'a', 'a', 'b', 'c'],
        ['a', 'b', 'c', 'd'],
        ['A', 'B', 'C', 'D'],
        0,
      ),
    ).toEqual({ kind: 'miss' });
  });

  test('rescueByLcs poda un chunk desproporcionado aunque tenga bordes compatibles', () => {
    const oldLines = Array.from({ length: 49 }, (_, index) => `line-${index}`);
    const lines = [...oldLines];
    lines[24] = 'line-24-stale';

    expect(
      rescueByLcs(
        lines,
        oldLines,
        oldLines.map((line, index) => (index === 24 ? 'line-24-new' : line)),
        0,
      ),
    ).toEqual({ kind: 'miss' });
  });

  test('rescueByLcs descarta una ventana poco plausible antes del scoring caro', () => {
    expect(
      rescueByLcs(
        ['left', 'noise-a', 'keep', 'noise-b', 'right'],
        ['left', 'old-a', 'old-b', 'old-c', 'right'],
        ['left', 'new-a', 'new-b', 'new-c', 'right'],
        0,
      ),
    ).toEqual({ kind: 'miss' });
  });

  test('seek empareja comillas curly y straight mezcladas', () => {
    expect(
      seek(
        ['const title = “it’s ready”;'],
        ['const title = "it\'s ready";'],
        0,
      ),
    ).toBe(0);
  });

  test('seekMatch informa cuando el match solo fue tolerante y seguro', () => {
    expect(
      seekMatch(['console.log(“hola”);  '], ['console.log("hola");'], 0),
    ).toEqual({
      index: 0,
      comparator: 'unicode-trim-end',
      exact: false,
    });
  });

  test('separación de comparadores distingue rescate seguro y comparadores permisivos', () => {
    expect(autoRescueComparators).toHaveLength(4);
    expect(permissiveComparators).toHaveLength(6);
  });
});
