/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installOmosCommandEntry } from './commands';

describe('commands installer', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omos-command-test-'));
    originalEnv = { ...process.env };
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('installs /omos command file under opencode/commands', () => {
    const result = installOmosCommandEntry();
    expect(result.success).toBe(true);

    const commandPath = join(tempDir, 'opencode', 'commands', 'omos.md');
    expect(existsSync(commandPath)).toBe(true);

    const content = readFileSync(commandPath, 'utf-8');
    expect(content).toContain('omos_preferences');
    expect(content).toContain('operation=score-plan');
    expect(content).toContain('confirm=true');
  });
});
