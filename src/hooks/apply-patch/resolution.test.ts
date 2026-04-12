import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
  applyHits,
  deriveNewContent,
  locateChunk,
  readFileLines,
  resolveChunkStart,
  resolveUpdateChunks,
} from './resolution';
import { createTempDir, DEFAULT_OPTIONS, writeFixture } from './test-helpers';
import type { PatchChunk } from './types';

describe('apply-patch/resolution', () => {
  test('readFileLines removes the final synthetic empty line', async () => {
    const root = await createTempDir();
    const file = path.join(root, 'sample.txt');
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\n');

    expect(await readFileLines(file)).toEqual(['alpha', 'beta']);
  });

  test('resolveChunkStart uses change_context as an anchor when present', () => {
    const chunk: PatchChunk = {
      old_lines: [],
      new_lines: ['middle'],
      change_context: 'anchor',
    };

    expect(resolveChunkStart(['top', 'anchor', 'bottom'], chunk, 0)).toBe(2);
  });

  test('locateChunk rescues prefix/suffix and preserves new_lines', () => {
    const chunk: PatchChunk = {
      old_lines: [
        'const title = "Hola";',
        'old-value',
        'const footer = "Fin";',
      ],
      new_lines: [
        'const title = “Hola”;',
        'new-value',
        'const footer = “Fin”;',
      ],
    };

    const resolved = locateChunk(
      ['top', 'const title = “Hola”;', 'stale-value', 'const footer = “Fin”;'],
      'sample.txt',
      chunk,
      0,
      DEFAULT_OPTIONS,
    );

    expect(resolved.rewritten).toBe(true);
    expect(resolved.canonical_old_lines).toEqual([
      'const title = “Hola”;',
      'stale-value',
      'const footer = “Fin”;',
    ]);
    expect(resolved.canonical_new_lines).toEqual(chunk.new_lines);
  });

  test('locateChunk canonicalizes a tolerant unicode match', () => {
    const chunk: PatchChunk = {
      old_lines: ['const title = "Hola";'],
      new_lines: ['const title = "Hola mundo";'],
    };

    const resolved = locateChunk(
      ['const title = “Hola”;'],
      'sample.txt',
      chunk,
      0,
      DEFAULT_OPTIONS,
    );

    expect(resolved.rewritten).toBe(true);
    expect(resolved.matchComparator).toBe('unicode');
    expect(resolved.canonical_old_lines).toEqual(['const title = “Hola”;']);
    expect(resolved.canonical_new_lines).toEqual([
      'const title = "Hola mundo";',
    ]);
  });

  test('locateChunk canonicalizes a tolerant trim-end match', () => {
    const chunk: PatchChunk = {
      old_lines: ['alpha'],
      new_lines: ['omega'],
    };

    const resolved = locateChunk(
      ['alpha  '],
      'sample.txt',
      chunk,
      0,
      DEFAULT_OPTIONS,
    );

    expect(resolved.rewritten).toBe(true);
    expect(resolved.matchComparator).toBe('trim-end');
    expect(resolved.canonical_old_lines).toEqual(['alpha  ']);
    expect(resolved.canonical_new_lines).toEqual(['omega']);
  });

  test('locateChunk no longer rescues a trim-only stale patch', () => {
    const chunk: PatchChunk = {
      old_lines: ['alpha'],
      new_lines: ['omega'],
    };

    expect(() =>
      locateChunk([' alpha  '], 'sample.txt', chunk, 0, DEFAULT_OPTIONS),
    ).toThrow('Failed to find expected lines');
  });

  test('locateChunk no longer canonicalizes a dangerous indented case', () => {
    const chunk: PatchChunk = {
      old_lines: ['enabled: false'],
      new_lines: ['enabled: true'],
    };

    expect(() =>
      locateChunk(
        ['root:', '  child:', '    enabled: false', 'done: true'],
        'sample.yml',
        chunk,
        0,
        DEFAULT_OPTIONS,
      ),
    ).toThrow('Failed to find expected lines');
  });

  test('locateChunk preserves a real final blank line when it exists in the file', () => {
    const chunk: PatchChunk = {
      old_lines: ['alpha', ''],
      new_lines: ['omega', ''],
    };

    const resolved = locateChunk(
      ['alpha', ''],
      'sample.txt',
      chunk,
      0,
      DEFAULT_OPTIONS,
    );

    expect(resolved.canonical_old_lines).toEqual(['alpha', '']);
    expect(resolved.canonical_new_lines).toEqual(['omega', '']);
  });

  test('locateChunk fails if the patch adds a non-existent final blank line', () => {
    const chunk: PatchChunk = {
      old_lines: ['alpha', ''],
      new_lines: ['omega', ''],
    };

    expect(() =>
      locateChunk(['alpha'], 'sample.txt', chunk, 0, DEFAULT_OPTIONS),
    ).toThrow('Failed to find expected lines');
  });

  test('deriveNewContent resolves EOF updates', async () => {
    const root = await createTempDir();
    const file = path.join(root, 'sample.txt');
    await writeFixture(root, 'sample.txt', 'alpha\nbeta');

    expect(
      await deriveNewContent(
        file,
        [
          {
            old_lines: ['beta'],
            new_lines: ['omega'],
            is_end_of_file: true,
          },
        ],
        DEFAULT_OPTIONS,
      ),
    ).toBe('alpha\nomega');
  });

  test('deriveNewContent preserves CRLF while rebuilding content', async () => {
    const root = await createTempDir();
    const file = path.join(root, 'sample.txt');
    await writeFixture(root, 'sample.txt', 'alpha\r\nbeta\r\ngamma\r\n');

    expect(
      await deriveNewContent(
        file,
        [
          {
            old_lines: ['alpha', 'beta', 'gamma'],
            new_lines: ['alpha', 'BETA', 'gamma'],
          },
        ],
        DEFAULT_OPTIONS,
      ),
    ).toBe('alpha\r\nBETA\r\ngamma\r\n');
  });

  test('deriveNewContent inserts an anchored block without moving it to EOF', async () => {
    const root = await createTempDir();
    const file = path.join(root, 'sample.txt');
    await writeFixture(root, 'sample.txt', 'top\nanchor\nbottom\n');

    expect(
      await deriveNewContent(
        file,
        [
          {
            old_lines: [],
            new_lines: ['middle'],
            change_context: 'anchor',
          },
        ],
        DEFAULT_OPTIONS,
      ),
    ).toBe('top\nanchor\nmiddle\nbottom\n');
  });

  test('deriveNewContent supports pure insertion at EOF with a single anchor', async () => {
    const root = await createTempDir();
    const file = path.join(root, 'sample.txt');
    await writeFixture(root, 'sample.txt', 'top\nanchor\n');

    expect(
      await deriveNewContent(
        file,
        [
          {
            old_lines: [],
            new_lines: ['middle'],
            change_context: 'anchor',
          },
        ],
        DEFAULT_OPTIONS,
      ),
    ).toBe('top\nanchor\nmiddle\n');
  });

  test('resolveUpdateChunks canonicalizes EOF insertion with a tolerant anchor', async () => {
    const root = await createTempDir();
    const file = path.join(root, 'sample.txt');
    await writeFixture(root, 'sample.txt', 'top\n“anchor”\n');

    const { resolved } = await resolveUpdateChunks(
      file,
      [
        {
          old_lines: [],
          new_lines: ['middle'],
          change_context: '"anchor"',
        },
      ],
      DEFAULT_OPTIONS,
    );

    expect(resolved[0]).toMatchObject({
      canonical_change_context: '“anchor”',
      rewritten: true,
      strategy: 'anchor',
      matchComparator: 'unicode',
    });
  });

  test('deriveNewContent fails if a pure insertion cannot find its anchor', async () => {
    const root = await createTempDir();
    const file = path.join(root, 'sample.txt');
    await writeFixture(root, 'sample.txt', 'top\nbottom\n');

    await expect(
      deriveNewContent(
        file,
        [
          {
            old_lines: [],
            new_lines: ['middle'],
            change_context: 'anchor',
          },
        ],
        DEFAULT_OPTIONS,
      ),
    ).rejects.toThrow('Failed to find insertion anchor');
  });

  test('deriveNewContent fails if a pure insertion has an ambiguous anchor', async () => {
    const root = await createTempDir();
    const file = path.join(root, 'sample.txt');
    await writeFixture(
      root,
      'sample.txt',
      'top\nanchor\none\nsplit\nanchor\ntwo\n',
    );

    await expect(
      deriveNewContent(
        file,
        [
          {
            old_lines: [],
            new_lines: ['middle'],
            change_context: 'anchor',
          },
        ],
        DEFAULT_OPTIONS,
      ),
    ).rejects.toThrow('Insertion anchor was ambiguous');
  });

  test('deriveNewContent fails if a later chunk remains ambiguous', async () => {
    const root = await createTempDir();
    const file = path.join(root, 'sample.txt');
    await writeFixture(
      root,
      'sample.txt',
      'alpha\none\nomega\nsplit\nleft\nstale-one\nright\ngap\nleft\nstale-two\nright\n',
    );

    await expect(
      deriveNewContent(
        file,
        [
          {
            old_lines: ['one'],
            new_lines: ['ONE'],
          },
          {
            old_lines: ['left', 'old', 'right'],
            new_lines: ['left', 'new', 'right'],
          },
        ],
        DEFAULT_OPTIONS,
      ),
    ).rejects.toThrow('ambiguous');
  });

  test('deriveNewContent rescues a stale EOF and preserves the final update', async () => {
    const root = await createTempDir();
    const file = path.join(root, 'sample.txt');
    await writeFixture(root, 'sample.txt', 'alpha\nstale\nomega');

    expect(
      await deriveNewContent(
        file,
        [
          {
            old_lines: ['alpha', 'old', 'omega'],
            new_lines: ['alpha', 'new', 'omega'],
            is_end_of_file: true,
          },
        ],
        DEFAULT_OPTIONS,
      ),
    ).toBe('alpha\nnew\nomega');
  });

  test('applyHits preserves the final newline', () => {
    expect(
      applyHits(['start', 'end'], [{ start: 0, del: 1, add: ['next'] }]),
    ).toBe('next\nend\n');
  });

  test('applyHits can preserve a file without a final newline', () => {
    expect(
      applyHits(
        ['start', 'end'],
        [{ start: 0, del: 1, add: ['next'] }],
        '\n',
        false,
      ),
    ).toBe('next\nend');
  });
});
