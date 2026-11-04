/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPluginConfigSnapshot } from './snapshot';

let tempDir: string;
let userConfigDir: string;
let projectDir: string;
const originalEnv = { ...process.env };
const spies: Array<{ mockRestore: () => void }> = [];

function userConfigPath(extension = '.json'): string {
  return path.join(userConfigDir, `oh-my-opencode-slim${extension}`);
}

function writeUserConfig(content: unknown, extension = '.json'): string {
  const target = userConfigPath(extension);
  fs.writeFileSync(
    target,
    typeof content === 'string' ? content : JSON.stringify(content),
  );
  return target;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-snapshot-'));
  userConfigDir = path.join(tempDir, 'xdg-config', 'opencode');
  projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(userConfigDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
  process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-config');
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  fs.rmSync(tempDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe('readPluginConfigSnapshot', () => {
  test('reports ignored v1 wake configuration on v2 without invalidating it', () => {
    const configPath = writeUserConfig({
      backgroundJobs: { orchestratorWake: { intervalMs: 60000 } },
    });
    const v2 = readPluginConfigSnapshot(projectDir, { hostFlavor: 'v2' });
    expect(v2.warnings).toEqual([
      expect.objectContaining({
        path: configPath,
        kind: 'unsupported-host',
        message: expect.stringContaining('orchestratorWake is v1-only'),
      }),
    ]);
    expect(
      readPluginConfigSnapshot(projectDir, { hostFlavor: 'v1' }).warnings,
    ).toEqual([]);
  });

  test('returns config, paths, warnings and a fingerprint', () => {
    writeUserConfig({ agents: { oracle: { model: 'test/model' } } });
    const snapshot = readPluginConfigSnapshot(projectDir);
    expect(snapshot.config.agents?.oracle?.model).toBe('test/model');
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.paths.userConfigPath).toBe(userConfigPath());
    expect(snapshot.fingerprint.length).toBeGreaterThan(0);
  });

  test('cached reads do not read the source again', () => {
    const target = writeUserConfig({ preset: 'alpha' });
    const original = fs.readFileSync;
    let reads = 0;
    const spy = spyOn(fs, 'readFileSync').mockImplementation(((
      file: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (file === target) reads += 1;
      return (original as (...args: unknown[]) => string).call(
        fs,
        file,
        ...rest,
      );
    }) as typeof fs.readFileSync);
    spies.push(spy);

    const first = readPluginConfigSnapshot(projectDir);
    const afterFirst = reads;
    expect(afterFirst).toBeGreaterThan(0);
    expect(readPluginConfigSnapshot(projectDir)).toBe(first);
    expect(reads).toBe(afterFirst);
  });

  test('explicit refresh covers a same-stat write', () => {
    const target = writeUserConfig({ sidebar: false });
    const realStat = fs.statSync;
    const frozen = realStat(target);
    const spy = spyOn(fs, 'statSync').mockImplementation((...args) => {
      if (String(args[0]) === target) return frozen;
      return realStat(...(args as Parameters<typeof fs.statSync>));
    });
    spies.push(spy);

    const first = readPluginConfigSnapshot(projectDir);
    expect(first.config.sidebar).toBe(false);
    writeUserConfig({ sidebar: true });
    const refreshed = readPluginConfigSnapshot(projectDir, { fresh: true });
    expect(refreshed.config.sidebar).toBe(true);
    expect(refreshed.fingerprint).not.toBe(first.fingerprint);
    expect(readPluginConfigSnapshot(projectDir)).toBe(refreshed);
  });

  test('replays warnings and recovers after the file is fixed', () => {
    writeUserConfig('{ not json', '.jsonc');
    const seen: string[] = [];
    const snapshot = readPluginConfigSnapshot(projectDir, {
      onWarning: (warning) => seen.push(warning.kind),
    });
    expect(snapshot.warnings.map((warning) => warning.kind)).toContain(
      'invalid-json',
    );
    expect(seen).toContain('invalid-json');

    const replayed: string[] = [];
    readPluginConfigSnapshot(projectDir, {
      onWarning: (warning) => replayed.push(warning.kind),
    });
    expect(replayed).toContain('invalid-json');

    writeUserConfig({ compactSidebar: false }, '.jsonc');
    const repaired = readPluginConfigSnapshot(projectDir);
    expect(repaired.config.compactSidebar).toBe(false);
    expect(repaired.warnings).toEqual([]);
  });

  test('a new .jsonc takes precedence and removing it restores .json', () => {
    writeUserConfig({ sidebar: false }, '.json');
    writeUserConfig({ sidebar: true }, '.jsonc');
    expect(readPluginConfigSnapshot(projectDir).config.sidebar).toBe(true);
    fs.rmSync(userConfigPath('.jsonc'));
    expect(readPluginConfigSnapshot(projectDir).config.sidebar).toBe(false);
  });

  test('a failed environment scan is not cached', () => {
    process.env.OMOS_TEST_MODEL = 'provider/one';
    const target = writeUserConfig({
      agents: { oracle: { model: '{env:OMOS_TEST_MODEL}' } },
    });
    const original = fs.readFileSync;
    let reads = 0;
    const spy = spyOn(fs, 'readFileSync').mockImplementation(((
      file: fs.PathLike,
      ...rest: unknown[]
    ) => {
      // The loader's read succeeds; the snapshot's own env scan fails once.
      if (file === target && ++reads === 2) {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      }
      return (original as (...args: unknown[]) => string).call(
        fs,
        file,
        ...rest,
      );
    }) as typeof fs.readFileSync);
    spies.push(spy);

    expect(
      readPluginConfigSnapshot(projectDir).config.agents?.oracle?.model,
    ).toBe('provider/one');
    process.env.OMOS_TEST_MODEL = 'provider/two';
    expect(
      readPluginConfigSnapshot(projectDir).config.agents?.oracle?.model,
    ).toBe('provider/two');
  });

  test('referenced environment values invalidate the cached config', () => {
    process.env.OMOS_TEST_MODEL = 'provider/one';
    writeUserConfig({ agents: { oracle: { model: '{env:OMOS_TEST_MODEL}' } } });
    expect(
      readPluginConfigSnapshot(projectDir).config.agents?.oracle?.model,
    ).toBe('provider/one');
    process.env.OMOS_TEST_MODEL = 'provider/two';
    expect(
      readPluginConfigSnapshot(projectDir).config.agents?.oracle?.model,
    ).toBe('provider/two');
  });
});
