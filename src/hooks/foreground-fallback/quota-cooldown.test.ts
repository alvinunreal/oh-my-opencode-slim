import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  getCoolingQuotaModelKeys,
  isQuotaModelCooling,
  recordQuotaCooldown,
} from './quota-cooldown';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'omos-quota-cooldown-'));
  roots.push(root);
  return root;
}

function minimalWorkerEnv(root: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    OPENCODE_CONFIG_DIR: root,
    LANG: 'C',
  };
}

function spawnWriter(
  filePath: string,
  providerID: string,
  modelID: string,
): Bun.Subprocess {
  const moduleUrl = new URL('./quota-cooldown.ts', import.meta.url).href;
  const source = `
    const { recordQuotaCooldown } = await import(${JSON.stringify(moduleUrl)});
    const [filePath, providerID, modelID] = process.argv.slice(-3);
    process.stdout.write('ready\\n');
    await new Promise((resolve) => process.stdin.once('data', resolve));
    const written = await recordQuotaCooldown(
      providerID,
      modelID,
      374901749,
      Date.now(),
      { filePath, lockTimeoutMs: 3000 },
    );
    process.exitCode = written ? 0 : 1;
  `;
  return Bun.spawn(
    [process.execPath, '-e', source, filePath, providerID, modelID],
    {
      env: minimalWorkerEnv(path.dirname(filePath)),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}

async function readInFreshProcess(
  filePath: string,
  providerID: string,
  modelID: string,
  now: number,
): Promise<string> {
  const moduleUrl = new URL('./quota-cooldown.ts', import.meta.url).href;
  const source = `
    const { isQuotaModelCooling } = await import(${JSON.stringify(moduleUrl)});
    const [filePath, providerID, modelID, nowText] = process.argv.slice(-4);
    const cooling = isQuotaModelCooling(
      providerID,
      modelID,
      Number(nowText),
      filePath,
    );
    process.stdout.write(cooling ? 'cooling' : 'clear');
  `;
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      source,
      filePath,
      providerID,
      modelID,
      String(now),
    ],
    {
      env: minimalWorkerEnv(path.dirname(filePath)),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (exitCode !== 0)
    throw new Error(
      `fresh quota reader exited ${exitCode}: ${await child.stderr.text()}`,
    );
  return output;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('quota cooldown persistence', () => {
  test('retains a reset longer than five hours with an unchanged absolute deadline', async () => {
    const filePath = path.join(tempRoot(), 'omos-quota-cooldowns.json');
    const now = 1_000_000;
    const resetAfterMs = 374_901_749;

    expect(
      await recordQuotaCooldown('provider', 'model', resetAfterMs, now, {
        filePath,
      }),
    ).toBe(true);
    const initialBytes = fs.readFileSync(filePath, 'utf8');
    expect(JSON.parse(initialBytes)).toEqual({
      version: 1,
      entries: { '["provider","model"]': now + resetAfterMs },
    });
    expect(isQuotaModelCooling('provider', 'model', now, filePath)).toBe(true);
    expect(isQuotaModelCooling('provider', 'other-model', now, filePath)).toBe(
      false,
    );
    expect(isQuotaModelCooling('other-provider', 'model', now, filePath)).toBe(
      false,
    );
    expect(
      isQuotaModelCooling(
        'provider',
        'model',
        now + resetAfterMs - 1,
        filePath,
      ),
    ).toBe(true);
    expect(
      isQuotaModelCooling('provider', 'model', now + resetAfterMs, filePath),
    ).toBe(false);

    const reopened = await import(`./quota-cooldown.ts?reopen=${randomUUID()}`);
    expect(
      reopened.isQuotaModelCooling(
        'provider',
        'model',
        now + resetAfterMs - 1,
        filePath,
      ),
    ).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(initialBytes);
    expect(
      await readInFreshProcess(
        filePath,
        'provider',
        'model',
        now + resetAfterMs - 1,
      ),
    ).toBe('cooling');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(initialBytes);

    fs.rmSync(filePath);
    expect(isQuotaModelCooling('provider', 'model', now, filePath)).toBe(false);
  });

  test('rejects absent, non-positive, non-finite, and overflowing reset durations', async () => {
    const filePath = path.join(tempRoot(), 'omos-quota-cooldowns.json');
    for (const duration of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_VALUE,
    ]) {
      expect(
        await recordQuotaCooldown('provider', 'model', duration, 1_000, {
          filePath,
        }),
      ).toBe(false);
    }
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('two writer processes merge distinct models without losing either entry', async () => {
    const filePath = path.join(tempRoot(), 'omos-quota-cooldowns.json');
    const workers = [
      spawnWriter(filePath, 'provider-a', 'model-a'),
      spawnWriter(filePath, 'provider-b', 'model-b'),
    ];
    try {
      const readers = workers.map((worker) => worker.stdout.getReader());
      const ready = await Promise.all(readers.map((reader) => reader.read()));
      for (const result of ready) {
        expect(new TextDecoder().decode(result.value)).toContain('ready');
      }
      // Both real writer processes are held at stdin until they are ready.
      for (const worker of workers) {
        worker.stdin.write('go\n');
        worker.stdin.end();
      }
      const exits = await Promise.all(workers.map((worker) => worker.exited));
      for (let index = 0; index < workers.length; index++) {
        if (exits[index] !== 0) {
          throw new Error(
            `quota writer ${index} exited ${exits[index]}: ${await workers[index].stderr.text()}`,
          );
        }
      }
    } finally {
      for (const worker of workers) {
        if (worker.exitCode === null) {
          worker.stdin.end();
          worker.kill();
        }
      }
      await Promise.all(workers.map((worker) => worker.exited));
    }

    const keys = getCoolingQuotaModelKeys(0, filePath);
    expect(keys).toEqual(
      new Set(['["provider-a","model-a"]', '["provider-b","model-b"]']),
    );
  });

  test('recovers a dead-owner lock through the shared lock helper', async () => {
    const filePath = path.join(tempRoot(), 'omos-quota-cooldowns.json');
    const lockPath = `${filePath}.lock`;
    const exitedChild = Bun.spawn([process.execPath, '-e', 'process.exit(0)'], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const deadPid = exitedChild.pid;
    expect(await exitedChild.exited).toBe(0);
    let deadOwnerCode: string | undefined;
    try {
      process.kill(deadPid, 0);
    } catch (error) {
      deadOwnerCode = (error as NodeJS.ErrnoException).code;
    }
    expect(deadOwnerCode).toBe('ESRCH');

    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner'), `${deadPid}\nstale-owner`);

    expect(
      await recordQuotaCooldown('provider', 'model', 10_000, 1_000, {
        filePath,
      }),
    ).toBe(true);
    expect(isQuotaModelCooling('provider', 'model', 1_000, filePath)).toBe(
      true,
    );
  });

  test('contention, malformed JSON, and unavailable storage fail open without overwriting', async () => {
    const root = tempRoot();
    const filePath = path.join(root, 'omos-quota-cooldowns.json');
    const release = await import('../../utils/pid-file-lock').then((module) =>
      module.acquirePidFileLock(filePath),
    );
    expect(release).not.toBeNull();
    expect(
      await recordQuotaCooldown('provider', 'contended', 10_000, 1_000, {
        filePath,
        lockTimeoutMs: 0,
      }),
    ).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
    release?.();

    fs.writeFileSync(filePath, '{invalid');
    const malformedBytes = fs.readFileSync(filePath, 'utf8');
    expect(isQuotaModelCooling('provider', 'model', 1_000, filePath)).toBe(
      false,
    );
    expect(
      await recordQuotaCooldown('provider', 'model', 10_000, 1_000, {
        filePath,
      }),
    ).toBe(false);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(malformedBytes);

    const blocker = path.join(root, 'not-a-directory');
    fs.writeFileSync(blocker, 'blocker');
    const unavailablePath = path.join(blocker, 'quota.json');
    expect(
      await recordQuotaCooldown('provider', 'model', 10_000, 1_000, {
        filePath: unavailablePath,
        lockTimeoutMs: 0,
      }),
    ).toBe(false);
    expect(
      isQuotaModelCooling('provider', 'model', 1_000, unavailablePath),
    ).toBe(false);
  });
});
