import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { regenerateTrace } from './io';

describe('trace/io', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trace-io-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('regenerates trace.md from requirements + design', () => {
    writeFileSync(
      join(dir, 'requirements.md'),
      '## REQ-001: foo\n\nbody\n\n## REQ-002: bar\n\nbody',
    );
    writeFileSync(
      join(dir, 'design.md'),
      '## DES-001: foo\n\nRationale anchor: REQ-001.\n\n## DES-002: bar\n\nRationale anchor: REQ-001, REQ-002.',
    );

    const result = regenerateTrace(dir);

    expect(result.written).toBe(true);
    expect(result.path).toBe(join(dir, 'trace.md'));
    const trace = Bun.file(result.path).text();
    return trace.then((text) => {
      expect(text).toContain('| REQ-001 | DES-001, DES-002 | — |');
      expect(text).toContain('| REQ-002 | DES-002 | — |');
    });
  });

  test('throws when requirements.md missing', () => {
    expect(() => regenerateTrace(dir)).toThrow('requirements.md not found');
  });

  test('throws when design.md missing', () => {
    writeFileSync(join(dir, 'requirements.md'), '## REQ-001: foo');
    expect(() => regenerateTrace(dir)).toThrow('design.md not found');
  });

  test('isTraceStale returns true when source newer than trace', async () => {
    const { isTraceStale } = await import('./io');
    writeFileSync(join(dir, 'trace.md'), 'old');
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(join(dir, 'requirements.md'), 'newer');
    writeFileSync(join(dir, 'design.md'), 'newer');
    expect(isTraceStale(dir)).toBe(true);
  });

  test('isTraceStale returns false when trace newer than source', async () => {
    const { isTraceStale } = await import('./io');
    writeFileSync(join(dir, 'requirements.md'), 'old');
    writeFileSync(join(dir, 'design.md'), 'old');
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(join(dir, 'trace.md'), 'newer');
    expect(isTraceStale(dir)).toBe(false);
  });

  test('isTraceStale returns true when trace missing', async () => {
    const { isTraceStale } = await import('./io');
    writeFileSync(join(dir, 'requirements.md'), 'x');
    writeFileSync(join(dir, 'design.md'), 'x');
    expect(isTraceStale(dir)).toBe(true);
  });
});
