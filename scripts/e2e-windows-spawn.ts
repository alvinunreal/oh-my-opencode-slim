/**
 * Manual end-to-end check for the Windows crossSpawn fix.
 *
 * Reproduces the auto-updater failure: `bun` on PATH only as npm `.cmd`
 * shims (no real bun.exe in any PATH directory). Temporarily hides any
 * bun.exe in the npm shim directory, then runs crossSpawn(['bun', ...]).
 *
 * Run with: bun scripts/e2e-windows-spawn.ts
 * Expected on Windows: exit 0 and a printed bun version.
 * Before the fix: spawn error ENOENT for 'bun'.
 */
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { crossSpawn } from '../src/utils/compat';

function main(): void {
  if (process.platform !== 'win32') {
    console.log('skip: not win32');
    return;
  }
  const shimDir = join(process.env.APPDATA ?? '', 'npm');
  const realExe = join(shimDir, 'bun.exe');
  const hidden = `${realExe}.e2e-hidden`;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    try {
      renameSync(hidden, realExe);
    } catch {
      /* nothing to restore */
    }
    restored = true;
  };

  try {
    renameSync(realExe, hidden);
    console.log('hid bun.exe; PATH now exposes bun.cmd shims only');
  } catch {
    console.log('no bun.exe in shim dir; nothing to hide');
  }

  const proc = crossSpawn(['bun', '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.exited
    .then(async (code) => {
      if (code === 0) {
        console.log(
          `bun resolved via shim, version=${(await proc.stdout()).trim()}`,
        );
      } else {
        console.log(
          `bun exited ${code}: ${(await proc.stderr()).trim().slice(0, 200)}`,
        );
      }
      restore();
      process.exit(code === 0 ? 0 : 1);
    })
    .catch((err: Error) => {
      console.log(`spawn failed: ${err.message}`);
      restore();
      process.exit(1);
    });
}

main();
