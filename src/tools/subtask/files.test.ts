/**
 * Tests for subtask file reference parsing.
 */

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildSyntheticFileParts,
  FILE_REGEX,
  parseFileReferences,
} from './files';

describe('parseFileReferences', () => {
  it('should parse simple @file references', () => {
    const text = 'Check @src/index.ts for the main entry';
    const refs = parseFileReferences(text);
    expect(refs.has('src/index.ts')).toBe(true);
  });

  it('should parse multiple @file references', () => {
    const text =
      'See @src/foo.ts and @src/bar.ts for details. Also check @README.md';
    const refs = parseFileReferences(text);
    expect(refs.size).toBe(3);
    expect(refs.has('src/foo.ts')).toBe(true);
    expect(refs.has('src/bar.ts')).toBe(true);
    expect(refs.has('README.md')).toBe(true);
  });

  it('should parse @ references outside backticks', () => {
    // Note: The regex doesn't fully exclude backtick-wrapped content,
    // but it does exclude @ preceded by word chars or backticks
    const text = 'Check @src/file.ts for details';
    const refs = parseFileReferences(text);
    expect(refs.size).toBe(1);
    expect(refs.has('src/file.ts')).toBe(true);
  });

  it('should not parse email-like patterns', () => {
    const text = 'Email me at user@example.com or check @src/file.ts';
    const refs = parseFileReferences(text);
    expect(refs.size).toBe(1);
    expect(refs.has('src/file.ts')).toBe(true);
  });

  it('should handle paths with dots', () => {
    const text = 'Config in @package.json and @tsconfig.json';
    const refs = parseFileReferences(text);
    expect(refs.size).toBe(2);
    expect(refs.has('package.json')).toBe(true);
    expect(refs.has('tsconfig.json')).toBe(true);
  });

  it('should handle paths with hyphens', () => {
    const text = 'See @my-file.ts and @some-other_file.js';
    const refs = parseFileReferences(text);
    expect(refs.size).toBe(2);
    expect(refs.has('my-file.ts')).toBe(true);
    expect(refs.has('some-other_file.js')).toBe(true);
  });

  it('should return empty set for text without references', () => {
    const text = 'Just some regular text without any file references';
    const refs = parseFileReferences(text);
    expect(refs.size).toBe(0);
  });

  it('should handle @ with leading dot for relative paths', () => {
    const text = 'Check @./relative/path.ts and @../parent/file.ts';
    const refs = parseFileReferences(text);
    expect(refs.size).toBe(2);
    expect(refs.has('./relative/path.ts')).toBe(true);
    expect(refs.has('../parent/file.ts')).toBe(true);
  });

  it('should handle references with trailing punctuation', () => {
    const text = 'See @src/file.ts, @src/other.ts. And @src/more.ts!';
    const refs = parseFileReferences(text);
    expect(refs).toEqual(
      new Set(['src/file.ts', 'src/other.ts', 'src/more.ts']),
    );
  });
});

describe('FILE_REGEX', () => {
  it('should match basic file patterns', () => {
    const text = '@src/index.ts';
    const matches = [...text.matchAll(FILE_REGEX)];
    expect(matches.length).toBe(1);
    expect(matches[0]?.[1]).toBe('src/index.ts');
  });

  it('should not match when preceded by word character', () => {
    const text = 'word@file.ts';
    const matches = [...text.matchAll(FILE_REGEX)];
    expect(matches.length).toBe(0);
  });

  it('should not match when preceded by backtick', () => {
    const text = '`@code`';
    const matches = [...text.matchAll(FILE_REGEX)];
    expect(matches.length).toBe(0);
  });
});

describe('buildSyntheticFileParts', () => {
  it('loads readable files inside the workspace', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-subtask-files-'));
    try {
      fs.writeFileSync(path.join(dir, 'file.ts'), 'const x = 1;\n');

      const parts = await buildSyntheticFileParts(dir, new Set(['file.ts']));

      expect(parts).toHaveLength(2);
      expect(parts[1]?.text).toContain('<type>file</type>');
      expect(parts[1]?.text).toContain('1: const x = 1;');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips path traversal and symlinks outside the workspace', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-subtask-files-'));
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), 'omos-subtask-outside-'),
    );
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link'));

      const parts = await buildSyntheticFileParts(
        dir,
        new Set(['../secret.txt', path.join(outside, 'secret.txt'), 'link']),
      );

      expect(parts).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
