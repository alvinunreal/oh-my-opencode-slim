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
  test('readFileLines elimina la línea vacía sintética final', async () => {
    const root = await createTempDir();
    const file = path.join(root, 'sample.txt');
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\n');

    expect(await readFileLines(file)).toEqual(['alpha', 'beta']);
  });

  test('resolveChunkStart usa change_context como ancla cuando existe', () => {
    const chunk: PatchChunk = {
      old_lines: [],
      new_lines: ['middle'],
      change_context: 'anchor',
    };

    expect(resolveChunkStart(['top', 'anchor', 'bottom'], chunk, 0)).toBe(2);
  });

  test('locateChunk rescata prefijo/sufijo y conserva new_lines', () => {
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

  test('locateChunk canoniza un match unicode tolerante', () => {
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

  test('locateChunk canoniza un match trim-end tolerante', () => {
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

  test('locateChunk ya no rescata un stale trim-only', () => {
    const chunk: PatchChunk = {
      old_lines: ['alpha'],
      new_lines: ['omega'],
    };

    expect(() =>
      locateChunk([' alpha  '], 'sample.txt', chunk, 0, DEFAULT_OPTIONS),
    ).toThrow('Failed to find expected lines');
  });

  test('locateChunk ya no canoniza un caso indentado peligroso', () => {
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

  test('locateChunk conserva una blank line final real cuando existe en el archivo', () => {
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

  test('locateChunk falla si el patch agrega una blank line final inexistente', () => {
    const chunk: PatchChunk = {
      old_lines: ['alpha', ''],
      new_lines: ['omega', ''],
    };

    expect(() =>
      locateChunk(['alpha'], 'sample.txt', chunk, 0, DEFAULT_OPTIONS),
    ).toThrow('Failed to find expected lines');
  });

  test('deriveNewContent resuelve actualizaciones EOF', async () => {
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

  test('deriveNewContent preserva CRLF al recomponer contenido', async () => {
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

  test('deriveNewContent inserta bloque anclado sin desplazarlo a EOF', async () => {
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

  test('deriveNewContent soporta inserción pura al EOF con anchor único', async () => {
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

  test('resolveUpdateChunks canoniza inserción EOF con anchor tolerante', async () => {
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

  test('deriveNewContent falla si una inserción pura no encuentra su anchor', async () => {
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

  test('deriveNewContent falla si una inserción pura tiene anchor ambiguo', async () => {
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

  test('deriveNewContent falla si un chunk posterior queda ambiguo', async () => {
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

  test('deriveNewContent rescata un EOF stale y conserva el update final', async () => {
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

  test('applyHits preserva el salto de línea final', () => {
    expect(
      applyHits(['start', 'end'], [{ start: 0, del: 1, add: ['next'] }]),
    ).toBe('next\nend\n');
  });

  test('applyHits puede preservar un archivo sin newline final', () => {
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
