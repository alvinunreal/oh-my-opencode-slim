import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRg, runRgCount } from './cli';
import { grep } from './tools';
import { formatGrepResult } from './utils';

describe('grep tool', () => {
  const testDir = join(tmpdir(), `grep-test-${Date.now()}`);
  const testFile1 = join(testDir, 'test1.txt');
  const testFile2 = join(testDir, 'test2.ts');

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(
      testFile1,
      'Hello world\nThis is a test file\nAnother line with match',
    );
    await writeFile(
      testFile2,
      "const x = 'Hello world';\nconsole.log('test');",
    );
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('formatGrepResult', () => {
    test('formats empty results', () => {
      const result = {
        matches: [],
        totalMatches: 0,
        filesSearched: 10,
        truncated: false,
      };
      expect(formatGrepResult(result)).toBe('No matches found.');
    });

    test('formats error results', () => {
      const result = {
        matches: [],
        totalMatches: 0,
        filesSearched: 0,
        truncated: false,
        error: 'Something went wrong',
      };
      expect(formatGrepResult(result)).toBe('Error: Something went wrong');
    });

    test('formats matches correctly', () => {
      const result = {
        matches: [
          { file: 'file1.ts', line: 10, text: "const foo = 'bar'" },
          { file: 'file1.ts', line: 15, text: 'console.log(foo)' },
          { file: 'file2.ts', line: 5, text: "import { foo } from './file1'" },
        ],
        totalMatches: 3,
        filesSearched: 2,
        truncated: false,
      };

      const output = formatGrepResult(result);
      expect(output).toContain('file1.ts:');
      expect(output).toContain("  10: const foo = 'bar'");
      expect(output).toContain('  15: console.log(foo)');
      expect(output).toContain('file2.ts:');
      expect(output).toContain("  5: import { foo } from './file1'");
      expect(output).toContain('Found 3 matches in 2 files');
    });

    test('indicates truncation', () => {
      const result = {
        matches: [{ file: 'foo.txt', line: 1, text: 'bar' }],
        totalMatches: 100,
        filesSearched: 50,
        truncated: true,
      };
      expect(formatGrepResult(result)).toContain('(output truncated)');
    });
  });

  describe('runRg', () => {
    test('finds matches in files', async () => {
      const result = await runRg({
        pattern: 'Hello',
        paths: [testDir],
      });

      expect(result.totalMatches).toBeGreaterThanOrEqual(2);
      expect(
        result.matches.some(
          (m) => m.file.includes('test1.txt') && m.text.includes('Hello'),
        ),
      ).toBe(true);
      expect(
        result.matches.some(
          (m) => m.file.includes('test2.ts') && m.text.includes('Hello'),
        ),
      ).toBe(true);
    });

    test('respects file inclusion patterns', async () => {
      const result = await runRg({
        pattern: 'Hello',
        paths: [testDir],
        globs: ['*.txt'],
      });

      expect(result.matches.some((m) => m.file.includes('test1.txt'))).toBe(
        true,
      );
      expect(result.matches.some((m) => m.file.includes('test2.ts'))).toBe(
        false,
      );
    });

    test('handles no matches', async () => {
      const result = await runRg({
        pattern: 'NonExistentString12345',
        paths: [testDir],
      });

      expect(result.totalMatches).toBe(0);
      expect(result.matches).toHaveLength(0);
    });

    test('respects case sensitivity', async () => {
      // Default is case insensitive (smart case usually, but wrapper might default differently, let's check implementation)
      // Looking at cli.ts: if (!options.caseSensitive) args.push("-i")
      // So default is case insensitive.

      const resultInsensitive = await runRg({
        pattern: 'hello',
        paths: [testDir],
        caseSensitive: false,
      });
      expect(resultInsensitive.totalMatches).toBeGreaterThan(0);

      const resultSensitive = await runRg({
        pattern: 'hello', // File has "Hello"
        paths: [testDir],
        caseSensitive: true,
      });
      expect(resultSensitive.totalMatches).toBe(0);
    });

    test('respects whole word match', async () => {
      const resultPartial = await runRg({
        pattern: 'Hell',
        paths: [testDir],
        wholeWord: false,
      });
      expect(resultPartial.totalMatches).toBeGreaterThan(0);

      const resultWhole = await runRg({
        pattern: 'Hell',
        paths: [testDir],
        wholeWord: true,
      });
      expect(resultWhole.totalMatches).toBe(0);
    });

    test('respects max count', async () => {
      const result = await runRg({
        pattern: 'Hello',
        paths: [testDir],
        maxCount: 1,
      });
      // maxCount is per file
      expect(
        result.matches.filter((m) => m.file.includes('test1.txt')).length,
      ).toBeLessThanOrEqual(1);
    });
  });

  describe('runRgCount', () => {
    test('counts matches correctly', async () => {
      const results = await runRgCount({
        pattern: 'Hello',
        paths: [testDir],
      });

      expect(results.length).toBeGreaterThan(0);
      const file1Result = results.find((r) => r.file.includes('test1.txt'));
      expect(file1Result).toBeDefined();
      expect(file1Result?.count).toBe(1);
    });
  });

  describe('grep tool execute', () => {
    test('executes successfully', async () => {
      // @ts-expect-error
      const result = await grep.execute({
        pattern: 'Hello',
        path: testDir,
      });

      expect(typeof result).toBe('string');
      expect(result).toContain('Found');
      expect(result).toContain('matches');
    });

    test('handles errors gracefully', async () => {
      // @ts-expect-error
      const result = await grep.execute({
        pattern: 'Hello',
        path: '/non/existent/path/12345',
      });

      // Depending on implementation, it might return "No matches found" or an error string
      // But it should not throw
      expect(typeof result).toBe('string');
    });

    test('respects include pattern in execute', async () => {
      // @ts-expect-error
      const result = await grep.execute({
        pattern: 'Hello',
        path: testDir,
        include: '*.txt',
      });

      expect(result).toContain('test1.txt');
      expect(result).not.toContain('test2.ts');
    });
  });
});
