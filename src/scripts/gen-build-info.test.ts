/**
 * scripts/gen-build-info.ts contract tests.
 *
 * The script runs inside CI's `npm pack --json --ignore-scripts`
 * (prepare → build), so it must keep STDOUT absolutely silent — the
 * release verifier slices pack JSON from the first `[` on stdout, and a
 * `[gen-build-info] …` prefix line breaks that parse. It must also be a
 * read-compare-write: an identical stamp may not touch the tracked
 * source file (`postversion` owns the committed stamp).
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateBuildInfo,
  renderBuildInfoSource,
} from '../../scripts/gen-build-info';

const outputRelative = join('src', 'generated', 'build-info.ts');

function createFixture(version = '9.9.99'): string {
  const rootDir = mkdtempSync(join(tmpdir(), 'omo-gen-build-info-'));
  mkdirSync(join(rootDir, 'src', 'generated'), { recursive: true });
  writeFileSync(
    join(rootDir, 'package.json'),
    JSON.stringify({ name: 'fixture', version }),
    'utf8',
  );
  return rootDir;
}

const fixtureDirs: string[] = [];
afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) {
    try {
      chmodSync(join(dir, outputRelative), 0o644);
    } catch {
      // Absent or already writable — rmSync below handles cleanup.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function track(dir: string): string {
  fixtureDirs.push(dir);
  return dir;
}

const firstStamp = () => new Date('2026-09-19T00:00:00.000Z');
const secondStamp = () => new Date('2026-09-19T01:02:03.456Z');

describe('scripts/gen-build-info', () => {
  test('writes the stamp when the file is absent and renders the expected source', () => {
    const rootDir = track(createFixture());
    const { wrote } = generateBuildInfo({
      rootDir,
      now: firstStamp,
      writer: { error: () => {} },
    });

    expect(wrote).toBe(true);
    expect(readFileSync(join(rootDir, outputRelative), 'utf8')).toBe(
      renderBuildInfoSource('9.9.99', '2026-09-19T00:00:00.000Z'),
    );
  });

  test('a content-identical invocation does not rewrite the file', () => {
    const rootDir = track(createFixture());
    const outputPath = join(rootDir, outputRelative);
    generateBuildInfo({
      rootDir,
      now: firstStamp,
      writer: { error: () => {} },
    });
    const before = readFileSync(outputPath, 'utf8');
    const beforeMtime = statSync(outputPath).mtimeMs;
    // Strong no-write proof: a rewrite of a read-only file would throw.
    chmodSync(outputPath, 0o444);
    try {
      const { wrote } = generateBuildInfo({
        rootDir,
        now: firstStamp,
        writer: { error: () => {} },
      });
      expect(wrote).toBe(false);
    } finally {
      chmodSync(outputPath, 0o644);
    }
    expect(readFileSync(outputPath, 'utf8')).toBe(before);
    expect(statSync(outputPath).mtimeMs).toBe(beforeMtime);
  });

  test('a differing stamp rewrites the file', () => {
    const rootDir = track(createFixture());
    const outputPath = join(rootDir, outputRelative);
    generateBuildInfo({
      rootDir,
      now: firstStamp,
      writer: { error: () => {} },
    });
    const { wrote } = generateBuildInfo({
      rootDir,
      now: secondStamp,
      writer: { error: () => {} },
    });

    expect(wrote).toBe(true);
    expect(readFileSync(outputPath, 'utf8')).toBe(
      renderBuildInfoSource('9.9.99', '2026-09-19T01:02:03.456Z'),
    );
  });

  test('the default writer keeps STDOUT silent (stderr only)', () => {
    const rootDir = track(createFixture());
    const stdout = spyOn(console, 'log').mockImplementation(() => {});
    const stderr = spyOn(console, 'error').mockImplementation(() => {});
    try {
      // First run writes, the identical second run skips — both must
      // stay off stdout.
      const first = generateBuildInfo({ rootDir, now: firstStamp });
      const second = generateBuildInfo({ rootDir, now: firstStamp });

      expect(first.wrote).toBe(true);
      expect(second.wrote).toBe(false);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr.mock.calls.length).toBe(2);
      for (const call of stderr.mock.calls) {
        expect(String(call[0])).toContain('[gen-build-info]');
      }
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
