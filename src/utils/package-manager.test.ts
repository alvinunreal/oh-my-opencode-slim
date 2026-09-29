import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolvePackageManager, resolveRuntimeBun } from './package-manager';

const createdDirs: string[] = [];
let originalPath: string | undefined;
let pathOverridden = false;

function makeDir(name?: string): string {
  const dir = name
    ? path.join(mkdtempSync(path.join(tmpdir(), 'pm-test-')), name)
    : mkdtempSync(path.join(tmpdir(), 'pm-test-'));
  mkdirSync(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

function dirWithFiles(...files: string[]): string {
  const dir = makeDir();
  for (const file of files) {
    writeFileSync(path.join(dir, file), '');
  }
  return dir;
}

function setPath(entries: string[]): void {
  if (!pathOverridden) {
    originalPath = process.env.PATH;
    pathOverridden = true;
  }
  process.env.PATH = entries.join(path.delimiter);
}

afterEach(() => {
  if (pathOverridden) {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    pathOverridden = false;
  }
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveRuntimeBun', () => {
  test('accepts the running bun executable', () => {
    expect(resolveRuntimeBun('/usr/local/bin/bun')).toEqual({
      packageManager: 'bun',
      command: '/usr/local/bin/bun',
    });
  });

  test('accepts a Windows-style bun executable', () => {
    expect(resolveRuntimeBun('/tools/bun.exe')).toEqual({
      packageManager: 'bun',
      command: '/tools/bun.exe',
    });
  });

  test('rejects a node runtime named node.exe', () => {
    expect(resolveRuntimeBun('/usr/bin/node.exe')).toBeNull();
  });

  test('rejects a node runtime named node', () => {
    expect(resolveRuntimeBun('/usr/bin/node')).toBeNull();
  });
});

describe('resolvePackageManager', () => {
  test('prefers the running bun runtime over PATH probing', () => {
    setPath([]);
    expect(resolvePackageManager('/opt/bun/bun')).toEqual({
      packageManager: 'bun',
      command: '/opt/bun/bun',
    });
  });

  test.skipIf(process.platform === 'win32')(
    'finds bun on PATH and reports the bare command',
    () => {
      const dir = dirWithFiles('bun');
      setPath([dir]);
      expect(resolvePackageManager('/usr/bin/node')).toEqual({
        packageManager: 'bun',
        command: 'bun',
      });
    },
  );

  test.skipIf(process.platform === 'win32')(
    'falls back to npm when only npm is on PATH',
    () => {
      const dir = dirWithFiles('npm');
      setPath([dir]);
      expect(resolvePackageManager('/usr/bin/node')).toEqual({
        packageManager: 'npm',
        command: 'npm',
      });
    },
  );

  test.skipIf(process.platform === 'win32')(
    'returns null when neither bun nor npm is on PATH',
    () => {
      const dir = makeDir();
      setPath([dir]);
      expect(resolvePackageManager('/usr/bin/node')).toBeNull();
    },
  );

  test.skipIf(process.platform === 'win32')(
    'silently skips PATH entries that do not exist',
    () => {
      const bunDir = dirWithFiles('bun');
      const missingDir = path.join(tmpdir(), `pm-missing-${process.pid}`);
      setPath([missingDir, bunDir]);
      expect(resolvePackageManager('/usr/bin/node')).toEqual({
        packageManager: 'bun',
        command: 'bun',
      });
    },
  );

  test.skipIf(process.platform === 'win32')(
    'ignores directories on PATH when probing for an executable',
    () => {
      const parent = makeDir();
      mkdirSync(path.join(parent, 'bun'), { recursive: true });
      setPath([parent]);
      expect(resolvePackageManager('/usr/bin/node')).toBeNull();
    },
  );
});
