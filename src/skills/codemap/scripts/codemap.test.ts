import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.restore();

const {
  computeFileHash,
  computeFolderHash,
  loadState,
  PatternMatcher,
  selectFiles,
} = await import('./codemap.mjs');

const tempDirs: string[] = [];

function createTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codemap-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('PatternMatcher', () => {
  test('matches expected paths', () => {
    const matcher = new PatternMatcher([
      'node_modules/',
      'dist/',
      '*.log',
      'src/**/*.ts',
    ]);

    expect(matcher.matches('node_modules/foo.js')).toBe(true);
    expect(matcher.matches('vendor/node_modules/bar.js')).toBe(true);
    expect(matcher.matches('dist/main.js')).toBe(true);
    expect(matcher.matches('src/dist/output.js')).toBe(true);
    expect(matcher.matches('error.log')).toBe(true);
    expect(matcher.matches('logs/access.log')).toBe(true);
    expect(matcher.matches('src/index.ts')).toBe(true);
    expect(matcher.matches('src/utils/helper.ts')).toBe(true);
    expect(matcher.matches('README.md')).toBe(false);
    expect(matcher.matches('tests/test.py')).toBe(false);
  });
});

describe('hash helpers', () => {
  test('computes file hash', () => {
    const dir = createTempDir();
    const filePath = path.join(dir, 'file.txt');
    writeFileSync(filePath, 'test content');

    expect(computeFileHash(filePath)).toBe('9473fdd0d880a43c21b7778d34872157');
  });

  test('computes stable folder hash', () => {
    const fileHashes = {
      'src/a.ts': 'hash-a',
      'src/b.ts': 'hash-b',
      'tests/test.ts': 'hash-test',
    };

    const hash1 = computeFolderHash('src', fileHashes);
    const hash2 = computeFolderHash('src', fileHashes);
    const hash3 = computeFolderHash('src', {
      'src/a.ts': 'hash-a-modified',
      'src/b.ts': 'hash-b',
    });

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });
});

describe('selectFiles', () => {
  test('respects include and exclude patterns', () => {
    const root = createTempDir();
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'node_modules'));
    writeFileSync(path.join(root, 'src', 'index.ts'), 'code');
    writeFileSync(path.join(root, 'src', 'index.test.ts'), 'test');
    writeFileSync(path.join(root, 'node_modules', 'foo.js'), 'dep');
    writeFileSync(path.join(root, 'package.json'), '{}');

    const selected = selectFiles(
      root,
      ['src/**/*.ts', 'package.json'],
      ['**/*.test.ts', 'node_modules/'],
      [],
      [],
    ).map((filePath) =>
      path.relative(root, filePath).split(path.sep).join('/'),
    );

    expect(selected).toEqual(['package.json', 'src/index.ts']);
  });
});

describe('loadState', () => {
  test('migrates legacy cartography state', () => {
    const root = createTempDir();
    const slimDir = path.join(root, '.slim');
    mkdirSync(slimDir);

    const legacyState = { metadata: { version: '1.0.0' } };
    writeFileSync(
      path.join(slimDir, 'cartography.json'),
      JSON.stringify(legacyState),
    );

    expect(loadState(root)).toEqual(legacyState);
    expect(existsSync(path.join(slimDir, 'cartography.json'))).toBe(false);
    expect(
      JSON.parse(readFileSync(path.join(slimDir, 'codemap.json'), 'utf8')),
    ).toEqual(legacyState);
  });
});
