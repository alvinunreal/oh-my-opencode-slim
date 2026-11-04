import { afterAll, mock } from 'bun:test';
import { mkdtempSync, readdirSync, rm, rmSync } from 'node:fs';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// bun test shares one process: keep every test off the real user dirs.
const root = mkdtempSync(join(tmpdir(), `omos-test-${process.pid}-`));
// Bun resolves os.homedir() before an in-process HOME assignment takes effect,
// so isolate the home directory through the module contract too.
const home = join(root, 'home');
process.env.HOME = home;
mock.module('node:os', () => ({ ...os, homedir: () => home }));
process.env.XDG_DATA_HOME = join(root, 'data');
process.env.XDG_CONFIG_HOME = join(root, 'config');
process.env.OPENCODE_LOG_DIR = join(root, 'log');
// Takes precedence over XDG_CONFIG_HOME; tests that need it set their own.
delete process.env.OPENCODE_CONFIG_DIR;
afterAll(() => rmSync(root, { recursive: true, force: true }));
// A signal or --bail skips afterAll; best effort: reclaim roots of dead runs.
try {
  for (const name of readdirSync(tmpdir())) {
    const pid = Number(/^omos-test-(\d+)-/.exec(name)?.[1]);
    try {
      if (pid) process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH')
        rm(join(tmpdir(), name), { recursive: true, force: true }, () => {});
    }
  }
} catch {}
