import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolveWindowsCommand } from './compat';
import {
  isOnPathWindows,
  resolvePackageManager,
  resolveRuntimeBun,
} from './package-manager';

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
  return dirWithExecutableFiles(0o755, ...files);
}

/**
 * Creates a temp dir containing empty files with an explicit POSIX mode.
 * The POSIX PATH probe now requires the user-execute bit, so fixtures must
 * be chmodded explicitly (umask-independent).
 */
function dirWithExecutableFiles(mode: number, ...files: string[]): string {
  const dir = makeDir();
  for (const file of files) {
    const filePath = path.join(dir, file);
    writeFileSync(filePath, '');
    chmodSync(filePath, mode);
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

  test.skipIf(process.platform === 'win32')(
    'ignores a non-executable file named like the command',
    () => {
      const dir = dirWithExecutableFiles(0o644, 'bun', 'npm');
      setPath([dir]);
      expect(resolvePackageManager('/usr/bin/node')).toBeNull();
    },
  );
});

describe('isOnPathWindows', () => {
  // The Windows branch is a pure fs-walk over the supplied PATH/PATHEXT
  // strings, so it is drivable on any OS. PATH entries are joined with the
  // host delimiter because resolveWindowsCommand splits on path.delimiter.
  const winPath = (dirs: string[]): string => dirs.join(path.delimiter);
  const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

  test('finds a .CMD shim on a windows-style PATH', () => {
    const dir = dirWithFiles('bun.CMD');
    expect(isOnPathWindows('bun', winPath([dir]), DEFAULT_PATHEXT)).toBe(true);
  });

  test('does not match an extensionless file with the default PATHEXT', () => {
    const dir = dirWithFiles('bun', 'npm');
    expect(isOnPathWindows('bun', winPath([dir]), DEFAULT_PATHEXT)).toBe(false);
  });

  test('skips PATH entries that do not exist', () => {
    const bunDir = dirWithFiles('bun.CMD');
    const missingDir = path.join(tmpdir(), `pm-missing-${process.pid}`);
    expect(
      isOnPathWindows('bun', winPath([missingDir, bunDir]), DEFAULT_PATHEXT),
    ).toBe(true);
    expect(isOnPathWindows('bun', winPath([missingDir]), DEFAULT_PATHEXT)).toBe(
      false,
    );
  });

  test('honours a custom PATHEXT that omits the on-disk extension', () => {
    const dir = dirWithFiles('bun.CMD');
    // .CMD present but excluded by this PATHEXT -> not found.
    expect(isOnPathWindows('bun', winPath([dir]), '.EXE')).toBe(false);
    expect(isOnPathWindows('bun', winPath([dir]), '.CMD')).toBe(true);
  });

  test('respects PATHEXT order, first match wins', () => {
    const dir = dirWithFiles('bun.exe', 'bun.cmd');
    expect(
      resolveWindowsCommand('bun', winPath([dir]), '.CMD;.EXE')?.file,
    ).toBe(path.join(dir, 'bun.cmd'));
    expect(
      resolveWindowsCommand('bun', winPath([dir]), DEFAULT_PATHEXT)?.file,
    ).toBe(path.join(dir, 'bun.exe'));
  });
});
