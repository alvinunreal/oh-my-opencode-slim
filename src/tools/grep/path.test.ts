/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { decodeRgPayload } from './json-stream';
import { buildPathFromBytes, sanitizeTitle } from './path-utils';
import { createTempTracker } from './test-helpers';

describe('tools/grep/path', () => {
  const temps = createTempTracker();

  test('buildPathFromBytes preserves non-UTF8 paths without lossy replacement', () => {
    const repoDir = temps.createRepo();
    const raw = Uint8Array.from([0x73, 0x72, 0x63, 0x2f, 0x66, 0x6f, 0x80]);
    const info = buildPathFromBytes(raw, repoDir, repoDir);

    expect(info.nonUtf8Path).toBe(true);
    expect(info.replayPath).toBeUndefined();
    expect(info.displayPath).toContain('src/fo');
    expect(info.displayPath).toContain('\\x80');
    expect(info.displayPath).toContain('[bytes:base64:');
    expect(info.absolutePath).toMatch(/^bytes:base64:/);
    expect(info.pathKey).toBe(info.absolutePath);
  });

  test.each([
    {
      name: 'keeps absolute display paths when worktree is filesystem root',
      raw: Uint8Array.from([
        0x2f, 0x74, 0x6d, 0x70, 0x2f, 0x62, 0x61, 0x64, 0x80,
      ]),
      cwd: () => temps.createRepo(),
      worktree: (repoDir: string) => path.parse(repoDir).root,
      assertInfo(info: ReturnType<typeof buildPathFromBytes>) {
        expect(info.displayPath.startsWith('/tmp/bad')).toBe(true);
        expect(info.displayPath).toContain('\\x80');
        expect(info.displayPath).toContain('[bytes:base64:');
      },
    },
    {
      name: 'does not relativize unrelated paths that only share a prefix',
      raw: Uint8Array.from([
        0x2f, 0x74, 0x6d, 0x70, 0x2f, 0x72, 0x65, 0x70, 0x6f, 0x73, 0x69, 0x74,
        0x6f, 0x72, 0x79, 0x2f, 0x66, 0x6f, 0x80,
      ]),
      cwd: () => '/tmp/repo',
      worktree: () => '/tmp/repo',
      assertInfo(info: ReturnType<typeof buildPathFromBytes>) {
        expect(info.displayPath.startsWith('/tmp/repository/fo')).toBe(true);
        expect(info.displayPath).toContain('\\x80');
        expect(info.displayPath).toContain('[bytes:base64:');
      },
    },
    {
      name: 'treats leading backslash as relative on POSIX',
      raw: Uint8Array.from([0x5c, 0x66, 0x6f, 0x80]),
      cwd: () => '/tmp/repo',
      worktree: () => '/tmp/repo',
      assertInfo(info: ReturnType<typeof buildPathFromBytes>) {
        expect(info.displayPath).toBe(
          '\\fo\\x80 [bytes:base64:L3RtcC9yZXBvL1xmb4A=]',
        );
        expect(info.absolutePath).toBe('bytes:base64:L3RtcC9yZXBvL1xmb4A=');
      },
    },
    {
      name: 'keeps POSIX backslashes as normal bytes inside names',
      raw: Uint8Array.from([0x73, 0x72, 0x63, 0x5c, 0x66, 0x6f, 0x6f, 0x80]),
      cwd: () => '/tmp/repo',
      worktree: () => '/tmp/repo',
      assertInfo(info: ReturnType<typeof buildPathFromBytes>) {
        expect(info.displayPath).toBe(
          'src\\foo\\x80 [bytes:base64:L3RtcC9yZXBvL3NyY1xmb2+A]',
        );
        expect(info.absolutePath).toBe('bytes:base64:L3RtcC9yZXBvL3NyY1xmb2+A');
      },
    },
    {
      name: 'does not relativize POSIX paths with backslash after prefix',
      raw: Uint8Array.from([
        0x2f, 0x74, 0x6d, 0x70, 0x2f, 0x72, 0x65, 0x70, 0x6f, 0x5c, 0x65, 0x76,
        0x69, 0x6c, 0x80,
      ]),
      cwd: () => '/tmp/repo',
      worktree: () => '/tmp/repo',
      assertInfo(info: ReturnType<typeof buildPathFromBytes>) {
        expect(info.displayPath).toBe(
          '/tmp/repo\\evil\\x80 [bytes:base64:L3RtcC9yZXBvXGV2aWyA]',
        );
      },
    },
  ])('buildPathFromBytes $name', ({ raw, cwd, worktree, assertInfo }) => {
    const cwdValue = cwd();
    assertInfo(buildPathFromBytes(raw, cwdValue, worktree(cwdValue)));
  });

  test('buildPathFromBytes handles Windows drive absolute non-UTF8 paths conservatively', () => {
    const raw = Uint8Array.from([
      0x43, 0x3a, 0x5c, 0x72, 0x65, 0x70, 0x6f, 0x5c, 0x62, 0x61, 0x64, 0x5f,
      0x80, 0x2e, 0x74, 0x78, 0x74,
    ]);

    const info = buildPathFromBytes(raw, 'C:\\cwd', 'C:\\repo');

    expect(info.displayPath).toBe(
      'bad_\\x80.txt [bytes:base64:QzpccmVwb1xiYWRfgC50eHQ=]',
    );
    expect(info.absolutePath).toBe('bytes:base64:QzpccmVwb1xiYWRfgC50eHQ=');
    expect(info.replayPath).toBeUndefined();
  });

  test('buildPathFromBytes keeps UNC-like non-UTF8 paths absolute at root', () => {
    const raw = Uint8Array.from([
      0x5c, 0x5c, 0x73, 0x72, 0x76, 0x5c, 0x73, 0x68, 0x61, 0x72, 0x65, 0x5c,
      0x62, 0x61, 0x64, 0x80,
    ]);

    const info = buildPathFromBytes(raw, 'C:\\cwd', '\\\\srv\\share\\');

    expect(info.displayPath).toBe(
      '\\\\srv\\share\\bad\\x80 [bytes:base64:XFxzcnZcc2hhcmVcYmFkgA==]',
    );
    expect(info.absolutePath).toBe('bytes:base64:XFxzcnZcc2hhcmVcYmFkgA==');
  });

  test('buildPathFromBytes keeps stable identity with trailing separators', () => {
    const raw = Uint8Array.from([0x73, 0x72, 0x63, 0x2f, 0x66, 0x6f, 0x80]);

    const posixA = buildPathFromBytes(raw, '/tmp/repo', '/tmp/repo');
    const posixB = buildPathFromBytes(raw, '/tmp/repo/', '/tmp/repo/');
    expect(posixA.absolutePath).toBe(posixB.absolutePath);
    expect(posixA.pathKey).toBe(posixB.pathKey);
    expect(posixA.displayPath).toBe(posixB.displayPath);

    const winRaw = Uint8Array.from([0x73, 0x72, 0x63, 0x5c, 0x66, 0x6f, 0x80]);
    const winA = buildPathFromBytes(winRaw, 'C:\\repo', 'C:\\repo');
    const winB = buildPathFromBytes(winRaw, 'C:\\repo\\', 'C:\\repo\\');
    expect(winA.absolutePath).toBe(winB.absolutePath);
    expect(winA.pathKey).toBe(winB.pathKey);
    expect(winA.displayPath).toBe(winB.displayPath);
  });

  test('buildPathFromBytes keeps canonical identity for root cwd/worktree forms', () => {
    const raw = Uint8Array.from([0x73, 0x72, 0x63, 0x2f, 0x66, 0x6f, 0x80]);

    const posix = buildPathFromBytes(raw, '/', '/');
    expect(posix.absolutePath).toBe('bytes:base64:L3NyYy9mb4A=');
    expect(posix.displayPath).toBe('/src/fo\\x80 [bytes:base64:L3NyYy9mb4A=]');

    const winRaw = Uint8Array.from([0x73, 0x72, 0x63, 0x5c, 0x66, 0x6f, 0x80]);
    const drive = buildPathFromBytes(winRaw, 'C:\\', 'C:\\');
    expect(drive.absolutePath).toBe('bytes:base64:Qzpcc3JjXGZvgA==');
    expect(drive.displayPath).toBe(
      'C:\\src\\fo\\x80 [bytes:base64:Qzpcc3JjXGZvgA==]',
    );

    const unc = buildPathFromBytes(
      winRaw,
      '\\\\srv\\share\\',
      '\\\\srv\\share\\',
    );
    expect(unc.absolutePath).toBe('bytes:base64:XFxzcnZcc2hhcmVcc3JjXGZvgA==');
    expect(unc.displayPath).toBe(
      '\\\\srv\\share\\src\\fo\\x80 [bytes:base64:XFxzcnZcc2hhcmVcc3JjXGZvgA==]',
    );
  });

  test('distinguishes non-UTF8 payloads from literal backslash escapes', () => {
    const literal = decodeRgPayload({ text: 'bad\\x80.txt' });
    const nonUtf8 = decodeRgPayload({
      bytes: Buffer.from([
        0x62, 0x61, 0x64, 0x80, 0x2e, 0x74, 0x78, 0x74,
      ]).toString('base64'),
    });

    expect(literal).toBe('bad\\x80.txt');
    expect(nonUtf8).toContain('bad\\x80.txt');
    expect(nonUtf8).toContain('[bytes:base64:');
    expect(nonUtf8).not.toBe(literal);
  });

  test('decodeRgPayload preserves non-UTF8 bytes losslessly', () => {
    const decoded = decodeRgPayload({
      bytes: Buffer.from([0x66, 0x6f, 0x80, 0x0a, 0x09]).toString('base64'),
    });

    expect(decoded).toBe('fo\\x80\n\t [bytes:base64:Zm+ACgk=]');
  });

  test('sanitizeTitle escapes control characters without mangling normal backslashes', () => {
    expect(sanitizeTitle('foo\u001b[31mbar')).toContain('\\x1b[31m');
    expect(sanitizeTitle('C:\\repo\\file.ts')).toBe('C:\\repo\\file.ts');
  });
});
