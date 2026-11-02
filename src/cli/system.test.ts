import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOpenCode } from './system';

test('finds and identifies OpenCode in ~/.opencode/bin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-system-test-'));
  try {
    const bin = join(dir, '.opencode', 'bin');
    const opencode = join(bin, 'opencode');
    mkdirSync(bin, { recursive: true });
    writeFileSync(opencode, '#!/bin/sh\necho opencode v2.2.4\n', {
      mode: 0o755,
    });
    expect(
      findOpenCode({ ...process.env, HOME: dir, PATH: '/usr/bin:/bin' }),
    ).toEqual({
      path: opencode,
      version: 'opencode v2.2.4',
      hostFlavor: 'v2',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
