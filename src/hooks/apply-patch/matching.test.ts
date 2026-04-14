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
  test('seek finds matches with unicode and trim-end', () => {
    expect(seek(['console.log(“hola”);  '], ['console.log("hola");'], 0)).toBe(
      0,
    );
  });

  test('seek does not rescue trim-only matches with different indentation', () => {
    expect(seek(['  console.log("hola");'], ['console.log("hola");'], 0)).toBe(
      -1,
    );
  });

  test('prefix and suffix detect common edges', () => {
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

  test('rescueByPrefixSuffix rescues a single stale block', () => {
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

  test('rescueByPrefixSuffix marks ambiguity when multiple locations exist', () => {
    expect(
      rescueByPrefixSuffix(
        ['left', 'stale-one', 'right', 'gap', 'left', 'stale-two', 'right'],
        ['left', 'old', 'right'],
        ['left', 'new', 'right'],
        0,
      ),
    ).toEqual({ kind: 'ambiguous', phase: 'prefix_suffix' });
  });

  test('rescueByLcs respects the start and finds a single candidate', () => {
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

  test('rescueByLcs marks ambiguity when two windows tie without common edges', () => {
    expect(
      rescueByLcs(
        ['head', 'alpha', 'beta', 'mid', 'alpha', 'beta', 'tail'],
        ['alpha', 'beta'],
        ['ALPHA', 'BETA'],
        0,
      ),
    ).toEqual({ kind: 'ambiguous', phase: 'lcs' });
  });

  test('rescueByLcs rejects windows with only one matching edge even when the score is high', () => {
    expect(
      rescueByLcs(
        ['a', 'a', 'a', 'a', 'b', 'c'],
        ['a', 'b', 'c', 'd'],
        ['A', 'B', 'C', 'D'],
        0,
      ),
    ).toEqual({ kind: 'miss' });
  });

  test('rescueByLcs prunes a disproportionate chunk even when it has compatible edges', () => {
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

  test('rescueByLcs discards an implausible window before expensive scoring', () => {
    expect(
      rescueByLcs(
        ['left', 'noise-a', 'keep', 'noise-b', 'right'],
        ['left', 'old-a', 'old-b', 'old-c', 'right'],
        ['left', 'new-a', 'new-b', 'new-c', 'right'],
        0,
      ),
    ).toEqual({ kind: 'miss' });
  });

  test('seek matches mixed curly and straight quotes', () => {
    expect(
      seek(
        ['const title = “it’s ready”;'],
        ['const title = "it\'s ready";'],
        0,
      ),
    ).toBe(0);
  });

  test('seekMatch reports when the match was only tolerant and safe', () => {
    expect(
      seekMatch(['console.log(“hola”);  '], ['console.log("hola");'], 0),
    ).toEqual({
      index: 0,
      comparator: 'unicode-trim-end',
      exact: false,
    });
  });

  test('comparator separation distinguishes safe rescue from permissive comparators', () => {
    expect(autoRescueComparators).toHaveLength(4);
    expect(permissiveComparators).toHaveLength(6);
  });
});
