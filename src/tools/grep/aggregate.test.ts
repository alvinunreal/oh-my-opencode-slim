/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { GrepAggregator } from './aggregate';
import {
  consumeNullCountPairs,
  consumeNullCountPairsBytes,
  consumeNullItems,
  consumeNullItemsBytes,
  consumeRgJsonStream,
} from './json-stream';
import { createTempTracker, createTextStream } from './test-helpers';

describe('tools/grep/aggregate', () => {
  const temps = createTempTracker();

  test('aggregates asymmetric before/after context independently', () => {
    const repoDir = temps.createRepo();
    const aggregator = new GrepAggregator({
      cwd: repoDir,
      worktree: repoDir,
      maxResults: 10,
      beforeContext: 1,
      afterContext: 2,
    });

    const filePath = 'src/example.ts';

    aggregator.consume({
      type: 'context',
      data: {
        path: { text: filePath },
        lines: { text: 'line 1\n' },
        line_number: 1,
      },
    });
    aggregator.consume({
      type: 'context',
      data: {
        path: { text: filePath },
        lines: { text: 'line 2\n' },
        line_number: 2,
      },
    });
    aggregator.consume({
      type: 'match',
      data: {
        path: { text: filePath },
        lines: { text: 'line 3 createTool\n' },
        line_number: 3,
        submatches: [
          {
            match: { text: 'createTool' },
            start: 7,
            end: 17,
          },
        ],
      },
    });
    aggregator.consume({
      type: 'context',
      data: {
        path: { text: filePath },
        lines: { text: 'line 4\n' },
        line_number: 4,
      },
    });
    aggregator.consume({
      type: 'context',
      data: {
        path: { text: filePath },
        lines: { text: 'line 5\n' },
        line_number: 5,
      },
    });
    aggregator.consume({
      type: 'context',
      data: {
        path: { text: filePath },
        lines: { text: 'line 6\n' },
        line_number: 6,
      },
    });

    const snapshot = aggregator.snapshot();
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]?.matches[0]?.before).toEqual([
      {
        lineNumber: 2,
        text: 'line 2',
      },
    ]);
    expect(snapshot.files[0]?.matches[0]?.after).toEqual([
      {
        lineNumber: 4,
        text: 'line 4',
      },
      {
        lineNumber: 5,
        text: 'line 5',
      },
    ]);
  });

  test('keeps adjacent post-limit matches as after-context while draining', () => {
    const repoDir = temps.createRepo();
    const aggregator = new GrepAggregator({
      cwd: repoDir,
      worktree: repoDir,
      maxResults: 1,
      beforeContext: 0,
      afterContext: 2,
    });

    const filePath = 'src/example.ts';

    aggregator.consume({
      type: 'match',
      data: {
        path: { text: filePath },
        lines: { text: 'needle one\n' },
        line_number: 1,
        submatches: [{ match: { text: 'needle' }, start: 0, end: 6 }],
      },
    });
    aggregator.consume({
      type: 'match',
      data: {
        path: { text: filePath },
        lines: { text: 'needle two\n' },
        line_number: 2,
        submatches: [{ match: { text: 'needle' }, start: 0, end: 6 }],
      },
    });
    aggregator.consume({
      type: 'context',
      data: {
        path: { text: filePath },
        lines: { text: 'after three\n' },
        line_number: 3,
      },
    });

    const snapshot = aggregator.snapshot();
    expect(snapshot.totalMatches).toBe(1);
    expect(snapshot.files[0]?.matches[0]?.after).toEqual([
      { lineNumber: 2, text: 'needle two' },
      { lineNumber: 3, text: 'after three' },
    ]);
  });

  test('preserves a final blank line inside multiline matches', () => {
    const repoDir = temps.createRepo();
    const aggregator = new GrepAggregator({
      cwd: repoDir,
      worktree: repoDir,
      maxResults: 5,
      beforeContext: 0,
      afterContext: 0,
    });

    aggregator.consume({
      type: 'match',
      data: {
        path: { text: 'src/example.ts' },
        lines: { text: 'foo\n\n' },
        line_number: 1,
        submatches: [{ match: { text: 'foo' }, start: 0, end: 3 }],
      },
    });

    const snapshot = aggregator.snapshot();
    expect(snapshot.files[0]?.matches[0]?.lineText).toBe('foo\n');
  });

  test.each([
    {
      name: 'consumeNullItems drops incomplete trailing filenames',
      run: async () => {
        const items: string[] = [];
        await consumeNullItems(createTextStream(['alpha\0beta']), (item) => {
          items.push(item);
          return true;
        });
        expect(items).toEqual(['alpha']);
      },
    },
    {
      name: 'consumeNullItems preserves carriage returns inside valid POSIX paths',
      run: async () => {
        const items: string[] = [];
        await consumeNullItems(createTextStream(['alpha\r\0']), (item) => {
          items.push(item);
          return true;
        });
        expect(items).toEqual(['alpha\r']);
      },
    },
    {
      name: 'consumeNullCountPairs drops incomplete trailing pairs and invalid counts',
      run: async () => {
        const pairs: Array<[string, string]> = [];
        await consumeNullCountPairs(
          createTextStream(['alpha\x0012\n', 'beta\x003oops']),
          (filePath, countText) => {
            pairs.push([filePath, countText]);
            return true;
          },
        );
        expect(pairs).toEqual([['alpha', '12']]);
      },
    },
    {
      name: 'consumeNullCountPairs preserves carriage returns in paths',
      run: async () => {
        const pairs: Array<[string, string]> = [];
        await consumeNullCountPairs(
          createTextStream(['alpha\r\x0012\n']),
          (filePath, countText) => {
            pairs.push([filePath, countText]);
            return true;
          },
        );
        expect(pairs).toEqual([['alpha\r', '12']]);
      },
    },
  ])('$name', async ({ run }) => {
    await run();
  });

  test.each([
    {
      name: 'consumeNullItemsBytes stitches chunked filenames and drops trailing partial bytes',
      run: async () => {
        const decoder = new TextDecoder();
        const items: string[] = [];

        await consumeNullItemsBytes(
          createTextStream(['al', 'pha\0be', 'ta\0gam']),
          (item) => {
            items.push(decoder.decode(item));
            return true;
          },
        );

        expect(items).toEqual(['alpha', 'beta']);
      },
    },
    {
      name: 'consumeNullCountPairsBytes stitches chunked pairs without copying each chunk into a new buffer',
      run: async () => {
        const decoder = new TextDecoder();
        const pairs: Array<[string, string]> = [];

        await consumeNullCountPairsBytes(
          createTextStream(['al', 'pha\x001', '2\nbe', 'ta\x003oops']),
          (filePath, countText) => {
            pairs.push([decoder.decode(filePath), countText]);
            return true;
          },
        );

        expect(pairs).toEqual([['alpha', '12']]);
      },
    },
  ])('$name', async ({ run }) => {
    await run();
  });

  test('consumeRgJsonStream respects false returned by trailing callback', async () => {
    const events: string[] = [];
    await consumeRgJsonStream(
      createTextStream([
        '{"type":"match","data":{"path":{"text":"a"},"lines":{"text":"x"},"line_number":1,"submatches":[]}}',
      ]),
      (event) => {
        events.push(event.type);
        return false;
      },
    );

    expect(events).toEqual(['match']);
  });
});
