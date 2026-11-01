/// <reference types="bun-types" />

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import * as fs from 'node:fs';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mutateJsonFile,
  prepareJsonConfigWrite,
  publishPreparedJsonConfig,
  removeTopLevelJsonProperty,
  restorePreparedJsonConfig,
  writeJsonAtomic,
} from '../config/json-file';
import { parseJsonConfigText } from '../config/jsonc';
import * as paths from '../config/paths';
import * as marketplaceLease from '../marketplace/lease';
import {
  addPluginToOpenCodeConfig,
  addPluginToOpenCodeTuiConfig,
  isPluginConfigured,
  parseConfig,
  parseConfigFile,
  writeLiteConfig,
} from './config-io';

describe('config-io', () => {
  let tmpDir: string;
  let children: Promise<void>[] = [];
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];

  beforeEach(() => {
    children = [];
    tmpDir = mkdtempSync(join(tmpdir(), 'opencode-io-test-'));
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_TUI_CONFIG;
    process.env.XDG_CONFIG_HOME = tmpDir;
  });

  afterEach(async () => {
    await Promise.allSettled(children);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    process.argv = [...originalArgv];
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    mock.restore();
  });

  function writePackageJson(dir: string, version?: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'oh-my-opencode-slim',
        ...(version ? { version } : {}),
      }),
    );
  }

  test('parseConfigFile parses valid JSON', () => {
    const path = join(tmpDir, 'test.json');
    writeFileSync(path, '{"a": 1}');
    const result = parseConfigFile(path);
    expect(result.config).toEqual({ a: 1 } as any);
    expect(result.error).toBeUndefined();
  });

  test('parseConfigFile strips a UTF-8 BOM before parsing', () => {
    const path = join(tmpDir, 'bom.json');
    writeFileSync(path, `\uFEFF${'{"a": 1}'}`);
    const result = parseConfigFile(path);
    expect(result.config).toEqual({ a: 1 } as any);
    expect(result.error).toBeUndefined();
  });

  test('parseConfigFile returns null for non-existent file', () => {
    const result = parseConfigFile(join(tmpDir, 'nonexistent.json'));
    expect(result.config).toBeNull();
  });

  test('parseConfigFile returns null for empty or whitespace-only file', () => {
    const emptyPath = join(tmpDir, 'empty.json');
    writeFileSync(emptyPath, '');
    expect(parseConfigFile(emptyPath).config).toBeNull();

    const whitespacePath = join(tmpDir, 'whitespace.json');
    writeFileSync(whitespacePath, '   \n  ');
    expect(parseConfigFile(whitespacePath).config).toBeNull();
  });

  test('parseConfigFile returns error for invalid JSON', () => {
    const path = join(tmpDir, 'invalid.json');
    writeFileSync(path, '{"a": 1');
    const result = parseConfigFile(path);
    expect(result.config).toBeNull();
    expect(result.error).toBeDefined();
  });

  test('parseConfig tries .jsonc if .json is missing', () => {
    const jsoncPath = join(tmpDir, 'test.jsonc');
    writeFileSync(jsoncPath, '{"a": 1}');

    // We pass .json path, it should try .jsonc
    const result = parseConfig(join(tmpDir, 'test.json'));
    expect(result.config).toEqual({ a: 1 } as any);
  });

  test('writeJsonAtomic writes JSON and creates backup', () => {
    const path = join(tmpDir, 'test.json');
    writeFileSync(path, '{"old": true}');

    writeJsonAtomic(path, { new: true } as any);

    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ new: true });
    expect(JSON.parse(readFileSync(`${path}.bak`, 'utf-8'))).toEqual({
      old: true,
    });
  });

  test('config and backup retain restrictive file permissions', () => {
    const configPath = join(tmpDir, 'private.json');
    writeFileSync(configPath, '{"secret":"key"}', { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
    mutateJsonFile(configPath, (current) => ({ ...current, enabled: true }));
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(`${configPath}.bak`).mode & 0o777).toBe(0o600);
  });

  test('config writes follow relative symlinks and preserve JSONC and backups', () => {
    const targetDir = join(tmpDir, 'dotfiles');
    mkdirSync(targetDir);
    const target = join(targetDir, 'config.jsonc');
    const link = join(tmpDir, 'config.jsonc');
    const original = '{\n  // keep\n  "preset": "old"\n}\n';
    writeFileSync(target, original);
    symlinkSync('dotfiles/config.jsonc', link);

    mutateJsonFile(link, (current) => ({ ...current, preset: 'new' }));

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('// keep');
    expect(readFileSync(target, 'utf8')).toContain('"new"');
    expect(readFileSync(`${link}.bak`, 'utf8')).toBe(original);

    writeJsonAtomic(link, { preset: 'reset' });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(parseJsonConfigText(readFileSync(target, 'utf8'))).toEqual({
      preset: 'reset',
    });
  });

  test('prepared config publication and rollback preserve the symlink', () => {
    const target = join(tmpDir, 'target.json');
    const link = join(tmpDir, 'config.json');
    const original = '{"preset":"old"}';
    writeFileSync(target, original);
    symlinkSync(target, link);
    const prepared = prepareJsonConfigWrite(link, original, { preset: 'new' });

    publishPreparedJsonConfig(prepared);
    expect(JSON.parse(readFileSync(target, 'utf8')).preset).toBe('new');
    restorePreparedJsonConfig(prepared);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(readFileSync(`${link}.bak`, 'utf8')).toBe(original);
  });

  test('dangling config symlinks fail without replacing the link or creating a backup', () => {
    const link = join(tmpDir, 'config.json');
    symlinkSync('missing.json', link);
    expect(() => writeJsonAtomic(link, { enabled: true })).toThrow(
      'Cannot resolve config path',
    );
    expect(() => mutateJsonFile(link, () => ({ enabled: true }))).toThrow(
      'Cannot resolve config path',
    );
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(`${link}.bak`)).toBe(false);
  });

  test('mutateJsonFile backup replaces a symlink instead of overwriting its target', () => {
    const path = join(tmpDir, 'symlink-safe.jsonc');
    const victim = join(tmpDir, 'victim.txt');
    const backup = `${path}.bak`;
    writeFileSync(path, '{"preset":"old"}');
    writeFileSync(victim, 'do-not-touch');
    symlinkSync(victim, backup);

    mutateJsonFile(path, (current) => ({ ...current, preset: 'new' }));

    expect(readFileSync(victim, 'utf8')).toBe('do-not-touch');
    expect(lstatSync(backup).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(backup, 'utf8'))).toEqual({
      preset: 'old',
    });
  });

  test('removeTopLevelJsonProperty preserves trailing comments on the previous property', () => {
    const path = join(tmpDir, 'remove-last-property.jsonc');
    writeFileSync(
      path,
      `{
  "companion": { "enabled": true }, // keep this explanation
  "preset": "local",
}
`,
    );

    removeTopLevelJsonProperty(path, 'preset');

    const savedText = readFileSync(path, 'utf-8');
    expect(savedText).toContain('// keep this explanation');
    expect(parseJsonConfigText(savedText)).toEqual({
      companion: { enabled: true },
    });
    expect(readFileSync(`${path}.bak`, 'utf-8')).toContain('"preset": "local"');
  });

  test('removeTopLevelJsonProperty removes duplicate keys without losing unrelated JSONC comments', () => {
    const path = join(tmpDir, 'remove-duplicate-properties.jsonc');
    writeFileSync(
      path,
      `{
  "preset": "first",
  // keep companion comment
  "companion": { "enabled": true },
  "preset": "second",
  // keep unrelated comment
  "unrelated": 42,
  "preset": "third",
}
`,
    );

    removeTopLevelJsonProperty(path, 'preset');

    const savedText = readFileSync(path, 'utf-8');
    expect(savedText.match(/"preset"\s*:/g) ?? []).toHaveLength(0);
    expect(savedText).toContain('// keep companion comment');
    expect(savedText).toContain('// keep unrelated comment');
    expect(parseJsonConfigText(savedText)).toEqual({
      companion: { enabled: true },
      unrelated: 42,
    });
    expect(readFileSync(`${path}.bak`, 'utf-8')).toContain('"preset": "third"');
  });

  test('removeTopLevelJsonProperty handles adjacent duplicate-only keys with trailing comma', () => {
    const path = join(tmpDir, 'remove-adjacent-duplicate-properties.jsonc');
    writeFileSync(
      path,
      `{
  "preset": "first",
  "preset": "second",
}
`,
    );

    removeTopLevelJsonProperty(path, 'preset');

    const savedText = readFileSync(path, 'utf-8');
    expect(savedText.match(/"preset"\s*:/g) ?? []).toHaveLength(0);
    expect(parseJsonConfigText(savedText)).toEqual({});
  });

  test('mutateJsonFile preserves JSONC comments and unrelated keys', () => {
    const path = join(tmpDir, 'settings.jsonc');
    writeFileSync(
      path,
      '{\n  // Keep this explanation\n  "unrelated": { "enabled": true },\n  "preset": "old",\n}\n',
    );

    mutateJsonFile(path, (current) => ({ ...current, preset: 'new' }));

    const savedText = readFileSync(path, 'utf-8');
    expect(savedText).toContain('// Keep this explanation');
    expect(parseJsonConfigText(savedText)).toEqual({
      unrelated: { enabled: true },
      preset: 'new',
    });
    expect(readFileSync(`${path}.bak`, 'utf-8')).toContain('"preset": "old"');
  });

  test('mutateJsonFile keeps nested field comments beside edited fields', () => {
    const path = join(tmpDir, 'localized.jsonc');
    writeFileSync(
      path,
      '{\n  "nested": {\n    // Keep by first\n    "first": 1, // first trailing\n    /* Keep by second */ "second": 2\n  },\n  "url": "https://example.com/a//b",\n}\n',
    );

    mutateJsonFile(path, (current) => {
      (current.nested as Record<string, unknown>).first = 3;
      return current;
    });

    const savedText = readFileSync(path, 'utf-8');
    expect(savedText).toContain(
      '// Keep by first\n    "first": 3, // first trailing',
    );
    expect(savedText).toContain('/* Keep by second */ "second": 2');
    expect(savedText).toContain('"url": "https://example.com/a//b"');
  });

  test('mutateJsonFile adds and removes properties without relocating neighbor comments', () => {
    const path = join(tmpDir, 'properties.jsonc');
    writeFileSync(
      path,
      '{\n  // Preserve this comment\n  "neighbor": 1,\n  "removeMe": 2\n}\n',
    );

    mutateJsonFile(path, (current) => {
      delete current.removeMe;
      current.added = true;
      return current;
    });

    const savedText = readFileSync(path, 'utf-8');
    expect(savedText).toContain('// Preserve this comment\n  "neighbor": 1');
    expect(parseJsonConfigText(savedText)).toEqual({
      neighbor: 1,
      added: true,
    });
  });

  test('mutateJsonFile preserves BOM, CRLF, and untouched JSONC bytes', () => {
    const path = join(tmpDir, 'crlf.jsonc');
    const original =
      '\uFEFF{\r\n  // Keep this CRLF comment\r\n  "untouched": [1, 2],\r\n  "value": 1\r\n}\r\n';
    writeFileSync(path, original);

    mutateJsonFile(path, (current) => ({ ...current, value: 2 }));

    const savedText = readFileSync(path, 'utf-8');
    expect(savedText.startsWith('\uFEFF')).toBe(true);
    expect(savedText).toContain('\r\n  // Keep this CRLF comment\r\n');
    expect(savedText).toContain('"untouched": [1, 2]');
    expect(savedText.replaceAll('\r\n', '')).not.toContain('\n');
    expect(parseJsonConfigText(savedText.replace(/^\uFEFF/, ''))).toEqual({
      untouched: [1, 2],
      value: 2,
    });
  });

  test('mutateJsonFile is byte-identical and creates no backup for a no-op', () => {
    const path = join(tmpDir, 'noop.jsonc');
    const original = '{\n  // Keep exactly\n  "value": 1,\n}\n';
    writeFileSync(path, original);

    mutateJsonFile(path, (current) => current);

    expect(readFileSync(path, 'utf-8')).toBe(original);
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  test('mutateJsonFile accepts BOM-prefixed JSON and keeps the BOM and keys', () => {
    const path = join(tmpDir, 'bom.json');
    writeFileSync(path, '\uFEFF{\n  "unrelated": true,\n  "value": 1\n}\n');

    mutateJsonFile(path, (current) => ({ ...current, value: 2 }));

    const savedText = readFileSync(path, 'utf-8');
    expect(savedText.startsWith('\uFEFF')).toBe(true);
    expect(JSON.parse(savedText.replace(/^\uFEFF/, ''))).toEqual({
      unrelated: true,
      value: 2,
    });
    expect(readFileSync(`${path}.bak`, 'utf-8')).toContain('\uFEFF');
  });

  test('mutateJsonFile accepts BOM-prefixed JSONC and preserves comments and keys', () => {
    const path = join(tmpDir, 'bom.jsonc');
    writeFileSync(
      path,
      '\uFEFF{\n  // Keep this explanation\n  "unrelated": true,\n  "value": 1,\n}\n',
    );

    mutateJsonFile(path, (current) => ({ ...current, value: 2 }));

    const savedText = readFileSync(path, 'utf-8');
    expect(savedText.startsWith('\uFEFF')).toBe(true);
    expect(savedText).toContain('// Keep this explanation');
    expect(parseJsonConfigText(savedText.replace(/^\uFEFF/, ''))).toEqual({
      unrelated: true,
      value: 2,
    });
    expect(readFileSync(`${path}.bak`, 'utf-8')).toContain('"value": 1');
  });

  test('retries failed lease cleanup after a committed config publication', () => {
    const path = join(tmpDir, 'lease-retry.json');
    const originalUnlink = fs.unlinkSync;
    const unlink = spyOn(fs, 'unlinkSync');
    let failLeaseUnlink = true;
    unlink.mockImplementation(((target: fs.PathLike) => {
      if (String(target).endsWith('.lease') && failLeaseUnlink) {
        failLeaseUnlink = false;
        throw new Error('lease unlink failure');
      }
      return originalUnlink.call(fs, target);
    }) as typeof fs.unlinkSync);

    expect(() => writeJsonAtomic(path, { value: 1 })).toThrow(
      'lease unlink failure',
    );
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ value: 1 });

    writeJsonAtomic(path, { value: 2 });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ value: 2 });
  });

  test('preserves publication error when lease cleanup also fails and retries', () => {
    const path = join(tmpDir, 'failed-lease-retry.json');
    const publish = spyOn(marketplaceLease, 'writeAtomic').mockImplementation(
      () => {
        throw new Error('original publication failure');
      },
    );
    const originalUnlink = fs.unlinkSync;
    const unlink = spyOn(fs, 'unlinkSync');
    let failLeaseUnlink = true;
    unlink.mockImplementation(((target: fs.PathLike) => {
      if (String(target).endsWith('.lease') && failLeaseUnlink) {
        failLeaseUnlink = false;
        throw new Error('secondary lease unlink failure');
      }
      return originalUnlink.call(fs, target);
    }) as typeof fs.unlinkSync);

    expect(() => writeJsonAtomic(path, { value: 1 })).toThrow(
      'original publication failure',
    );
    expect(existsSync(path)).toBe(false);

    publish.mockRestore();
    writeJsonAtomic(path, { value: 2 });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ value: 2 });
  });

  test('serialized JSON mutations do not lose cross-process updates', async () => {
    const path = join(tmpDir, 'shared.json');
    const link = join(tmpDir, 'shared-link.json');
    writeFileSync(path, '{"writers": 0}');
    symlinkSync(path, link);
    const script =
      `import { mutateJsonFile } from './src/config/json-file.ts';\n` +
      `mutateJsonFile(process.env.CONFIG_PATH!, (current) => ({ ...current, writers: Number(current.writers) + 1 }));`;

    for (let index = 0; index < 8; index++) {
      children.push(
        (async () => {
          const child = Bun.spawn(['bun', '-e', script], {
            cwd: process.cwd(),
            env: { ...process.env, CONFIG_PATH: index % 2 ? link : path },
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const exitCode = await child.exited;
          if (exitCode !== 0) {
            throw new Error(await new Response(child.stderr).text());
          }
        })(),
      );
    }
    const results = await Promise.allSettled(children);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;

    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ writers: 8 });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test('failed atomic publication leaves the original config intact', () => {
    const path = join(tmpDir, 'publication.jsonc');
    const original = '{\n  // Existing setting\n  "value": 1,\n}\n';
    writeFileSync(path, original);
    const publish = spyOn(marketplaceLease, 'writeAtomic').mockImplementation(
      () => {
        throw new Error('publish failure');
      },
    );

    expect(() => writeJsonAtomic(path, { value: 2 })).toThrow(
      'publish failure',
    );
    expect(readFileSync(path, 'utf-8')).toBe(original);
    expect(readFileSync(`${path}.bak`, 'utf-8')).toBe(original);
    publish.mockRestore();
  });

  test('prepares all JSONC edits before publishing either file', () => {
    const firstPath = join(tmpDir, 'first.jsonc');
    const secondPath = join(tmpDir, 'second.jsonc');
    const firstOriginal = '{\n  // First comment\n  "value": 1,\n}\n';
    const secondOriginal = '{\n  // Second comment\n  "value": 2,\n}\n';
    writeFileSync(firstPath, firstOriginal);
    writeFileSync(secondPath, secondOriginal);

    const prepared = [
      prepareJsonConfigWrite(firstPath, readFileSync(firstPath, 'utf-8'), {
        value: 10,
      } as any),
      prepareJsonConfigWrite(secondPath, readFileSync(secondPath, 'utf-8'), {
        value: 20,
      } as any),
    ];

    expect(prepared.every((write) => write.changed)).toBe(true);
    expect(readFileSync(firstPath, 'utf-8')).toBe(firstOriginal);
    expect(readFileSync(secondPath, 'utf-8')).toBe(secondOriginal);

    for (const write of prepared) publishPreparedJsonConfig(write);
    expect(parseJsonConfigText(readFileSync(firstPath, 'utf-8'))).toEqual({
      value: 10,
    });
    expect(parseJsonConfigText(readFileSync(secondPath, 'utf-8'))).toEqual({
      value: 20,
    });
  });

  test('prepared no-op keeps original bytes and does not create a backup', () => {
    const path = join(tmpDir, 'prepared-noop.jsonc');
    const original = '\uFEFF{\r\n  // Keep exactly\r\n  "value": 1,\r\n}\r\n';
    writeFileSync(path, original);

    const prepared = prepareJsonConfigWrite(path, readFileSync(path, 'utf-8'), {
      value: 1,
    } as any);
    publishPreparedJsonConfig(prepared);

    expect(prepared.changed).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe(original);
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  test('prepared compact JSON no-op preserves file and existing backup', () => {
    const path = join(tmpDir, 'prepared-compact-noop.json');
    const original = '{"value":1}';
    const backup = 'keep this backup byte-for-byte';
    writeFileSync(path, original);
    writeFileSync(`${path}.bak`, backup);
    const oldTime = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(path, oldTime, oldTime);
    utimesSync(`${path}.bak`, oldTime, oldTime);

    const fileMtime = statSync(path).mtimeMs;
    const backupMtime = statSync(`${path}.bak`).mtimeMs;
    const prepared = prepareJsonConfigWrite(path, original, {
      value: 1,
    } as any);
    publishPreparedJsonConfig(prepared);

    expect(prepared.changed).toBe(false);
    expect(prepared.content).toBe(original);
    expect(readFileSync(path, 'utf-8')).toBe(original);
    expect(readFileSync(`${path}.bak`, 'utf-8')).toBe(backup);
    expect(statSync(path).mtimeMs).toBe(fileMtime);
    expect(statSync(`${path}.bak`).mtimeMs).toBe(backupMtime);
  });

  test('prepared BOM JSON no-op preserves file and existing backup', () => {
    const path = join(tmpDir, 'prepared-bom-noop.json');
    const original = '\uFEFF{"value":1}';
    const backup = 'keep this BOM backup';
    writeFileSync(path, original);
    writeFileSync(`${path}.bak`, backup);
    const oldTime = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(path, oldTime, oldTime);
    utimesSync(`${path}.bak`, oldTime, oldTime);

    const fileMtime = statSync(path).mtimeMs;
    const backupMtime = statSync(`${path}.bak`).mtimeMs;
    const prepared = prepareJsonConfigWrite(path, original, {
      value: 1,
    } as any);
    publishPreparedJsonConfig(prepared);

    expect(prepared.changed).toBe(false);
    expect(prepared.content).toBe(original);
    expect(readFileSync(path, 'utf-8')).toBe(original);
    expect(readFileSync(`${path}.bak`, 'utf-8')).toBe(backup);
    expect(statSync(path).mtimeMs).toBe(fileMtime);
    expect(statSync(`${path}.bak`).mtimeMs).toBe(backupMtime);
  });

  test('prepared unchanged malformed config still fails parsing', () => {
    const path = join(tmpDir, 'prepared-malformed.json');
    expect(() =>
      prepareJsonConfigWrite(path, '{"value":', { value: 1 } as any),
    ).toThrow('Invalid JSONC config');
  });

  test('restores exact prepared bytes and leaves the recovery backup intact', () => {
    const firstPath = join(tmpDir, 'rollback-first.jsonc');
    const secondPath = join(tmpDir, 'rollback-second.json');
    const firstOriginal =
      '\uFEFF{\r\n  // Preserve exactly\r\n  "value": 1,\r\n}\r\n';
    const secondOriginal = '{ "value": 2 }';
    writeFileSync(firstPath, firstOriginal);
    writeFileSync(secondPath, secondOriginal);
    const prepared = [
      prepareJsonConfigWrite(firstPath, firstOriginal, { value: 10 } as any),
      prepareJsonConfigWrite(secondPath, secondOriginal, { value: 20 } as any),
    ];

    publishPreparedJsonConfig(prepared[0]);
    const recoveryBackup = readFileSync(`${firstPath}.bak`, 'utf-8');
    const publish = spyOn(marketplaceLease, 'writeAtomic').mockImplementation(
      () => {
        throw new Error('second publication failed');
      },
    );
    expect(() => publishPreparedJsonConfig(prepared[1])).toThrow(
      'second publication failed',
    );
    publish.mockRestore();

    restorePreparedJsonConfig(prepared[0]);
    restorePreparedJsonConfig(prepared[1]);
    expect(readFileSync(firstPath, 'utf-8')).toBe(firstOriginal);
    expect(readFileSync(secondPath, 'utf-8')).toBe(secondOriginal);
    expect(readFileSync(`${firstPath}.bak`, 'utf-8')).toBe(recoveryBackup);
    expect(readFileSync(`${firstPath}.bak`, 'utf-8')).toBe(firstOriginal);
  });

  test('mutateJsonFile starts from an empty object for a missing config', () => {
    const path = join(tmpDir, 'created.json');
    mutateJsonFile(path, (current) => ({ ...current, enabled: true }));
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ enabled: true });
  });

  test('addPluginToOpenCodeConfig adds plugin and removes duplicates', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    paths.ensureConfigDir();
    writeFileSync(
      configPath,
      JSON.stringify({ plugin: ['other', 'oh-my-opencode-slim@1.0.0'] }),
    );
    process.argv[1] = '';

    const result = await addPluginToOpenCodeConfig();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toContain('oh-my-opencode-slim');
    expect(saved.plugin).not.toContain('oh-my-opencode-slim@1.0.0');
    expect(saved.plugin.length).toBe(2);
  });

  test('installation preserves JSON comments and backs up the original before enabling LSP', async () => {
    paths.ensureConfigDir();
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    const original =
      '{\n  // user comment\n  "plugin": [],\n  /* more */ "theme": "dark"\n}\n';
    writeFileSync(configPath, original);
    process.argv[1] = '';
    expect((await addPluginToOpenCodeConfig()).success).toBe(true);
    const saved = readFileSync(configPath, 'utf8');
    expect(saved).toContain('// user comment');
    expect(saved).toContain('/* more */');
    expect(parseJsonConfigText(saved).lsp).toBe(true);
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe(original);
  });

  test('addPluginToOpenCodeConfig reads and preserves a plural-key config', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    paths.ensureConfigDir();
    writeFileSync(
      configPath,
      JSON.stringify({ plugins: ['other', 'oh-my-opencode-slim@1.0.0'] }),
    );
    process.argv[1] = '';

    const result = await addPluginToOpenCodeConfig();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugins).toEqual(['other']);
    expect(saved.plugins).not.toContain('oh-my-opencode-slim@1.0.0');
    expect(saved.plugin).toEqual(['oh-my-opencode-slim']);
  });

  test('installs a pinned bunx symlink in plugin without duplicates across keys', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    const modules = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@beta',
      'node_modules',
    );
    const packageRoot = join(modules, 'oh-my-opencode-slim');
    const entry = join(packageRoot, 'dist', 'cli', 'index.js');
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    mkdirSync(join(modules, '.bin'), { recursive: true });
    writePackageJson(packageRoot, '1.2.3');
    writeFileSync(entry, '');
    const link = join(modules, '.bin', 'oh-my-opencode-slim');
    symlinkSync(entry, link);
    paths.ensureConfigDir();
    writeFileSync(
      configPath,
      JSON.stringify({
        plugin: ['other-legacy', 'oh-my-opencode-slim@1.0.0'],
        plugins: [{ package: 'oh-my-opencode-slim@1.1.0' }, 'other-native'],
      }),
    );
    process.argv[1] = link;

    expect((await addPluginToOpenCodeConfig()).success).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toEqual([
      'other-legacy',
      [
        'oh-my-opencode-slim@1.2.3',
        { __ohMyOpencodeSlimManagedByInstaller: true },
      ],
    ]);
    expect(saved.plugins).toEqual(['other-native']);
  });

  test('addPluginToOpenCodeConfig respects OPENCODE_CONFIG_DIR', async () => {
    const customConfigDir = join(tmpDir, 'custom-opencode');
    const defaultConfigDir = join(tmpDir, 'opencode');
    const customConfigPath = join(customConfigDir, 'opencode.jsonc');
    const defaultConfigPath = join(defaultConfigDir, 'opencode.json');

    process.env.OPENCODE_CONFIG_DIR = customConfigDir;
    mkdirSync(customConfigDir, { recursive: true });
    mkdirSync(defaultConfigDir, { recursive: true });
    writeFileSync(
      customConfigPath,
      JSON.stringify({ plugin: ['other', 'oh-my-opencode-slim@1.0.0'] }),
    );
    writeFileSync(defaultConfigPath, JSON.stringify({ plugin: ['default'] }));
    process.argv[1] = '';

    const result = await addPluginToOpenCodeConfig();

    expect(result.success).toBe(true);
    expect(result.configPath).toBe(customConfigPath);
    const customSaved = JSON.parse(readFileSync(customConfigPath, 'utf-8'));
    const defaultSaved = JSON.parse(readFileSync(defaultConfigPath, 'utf-8'));
    expect(customSaved.plugin).toEqual(['other', 'oh-my-opencode-slim']);
    expect(defaultSaved.plugin).toEqual(['default']);
  });

  test('addPluginToOpenCodeConfig stores package name for bunx temp paths', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@latest',
      'node_modules',
      'oh-my-opencode-slim',
    );
    paths.ensureConfigDir();
    writeFileSync(configPath, JSON.stringify({ plugin: [] }));
    writePackageJson(packageRoot);
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const result = await addPluginToOpenCodeConfig();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toEqual(['oh-my-opencode-slim']);
  });

  test('addPluginToOpenCodeConfig leaves @latest bunx invocations unpinned', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@latest',
      'node_modules',
      'oh-my-opencode-slim',
    );
    paths.ensureConfigDir();
    writeFileSync(configPath, JSON.stringify({ plugin: [] }));
    writePackageJson(packageRoot, '1.2.3');
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const result = await addPluginToOpenCodeConfig();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toEqual(['oh-my-opencode-slim']);
  });

  test('addPluginToOpenCodeConfig writes the resolved version as an installer-managed tuple', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@beta',
      'node_modules',
      'oh-my-opencode-slim',
    );
    paths.ensureConfigDir();
    writeFileSync(configPath, JSON.stringify({ plugin: [] }));
    writePackageJson(packageRoot, '1.2.3');
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const result = await addPluginToOpenCodeConfig();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toEqual([
      [
        'oh-my-opencode-slim@1.2.3',
        { __ohMyOpencodeSlimManagedByInstaller: true },
      ],
    ]);
  });

  test('addPluginToOpenCodeConfig stores local repo path for local dev paths', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    const packageRoot = join(tmpDir, 'repo');
    const localCliPath = join(packageRoot, 'dist', 'cli', 'index.js');
    paths.ensureConfigDir();
    writeFileSync(configPath, JSON.stringify({ plugin: [] }));
    writePackageJson(packageRoot);
    process.argv[1] = localCliPath;

    const result = await addPluginToOpenCodeConfig();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toEqual([packageRoot]);
  });

  test('addPluginToOpenCodeConfig stores local repo path for local paths containing bunx-', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    const packageRoot = join(tmpDir, 'repo', 'bunx-tools');
    const localCliPath = join(packageRoot, 'dist', 'cli', 'index.js');
    paths.ensureConfigDir();
    writeFileSync(configPath, JSON.stringify({ plugin: [] }));
    writePackageJson(packageRoot);
    process.argv[1] = localCliPath;

    const result = await addPluginToOpenCodeConfig();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toEqual([packageRoot]);
  });

  test('addPluginToOpenCodeConfig deduplicates existing local repo path entries', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    const packageRoot = join(tmpDir, 'repo');
    const localCliPath = join(packageRoot, 'dist', 'cli', 'index.js');
    paths.ensureConfigDir();
    writePackageJson(packageRoot);
    writeFileSync(
      configPath,
      JSON.stringify({ plugin: ['other', packageRoot] }),
    );
    process.argv[1] = localCliPath;

    const result = await addPluginToOpenCodeConfig();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toEqual(['other', packageRoot]);
  });

  test('addPluginToOpenCodeConfig preserves non-string plugin entries when refreshing', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    paths.ensureConfigDir();
    process.argv[1] = '';

    const objectPlugin = { name: 'some-config-plugin', enabled: true };
    writeFileSync(
      configPath,
      JSON.stringify({
        plugin: ['other-plugin', objectPlugin, 'oh-my-opencode-slim@1.0.0'],
      }),
    );

    const result = await addPluginToOpenCodeConfig();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toContain('oh-my-opencode-slim');
    expect(saved.plugin).toContain('other-plugin');
    expect(saved.plugin).not.toContain('oh-my-opencode-slim@1.0.0');
    // Non-string entries (objects) must survive the plugin refresh
    expect(saved.plugin).toContainEqual(objectPlugin);
    expect(saved.plugin.length).toBe(3);
  });

  test('addPluginToOpenCodeConfig removes tuple plugin entries', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    paths.ensureConfigDir();
    writeFileSync(
      configPath,
      JSON.stringify({
        plugin: ['other', ['oh-my-opencode-slim', { enabled: true }]],
      }),
    );
    process.argv[1] = '';

    const result = await addPluginToOpenCodeConfig();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.plugin).toEqual(['other', 'oh-my-opencode-slim']);
  });

  test('addPluginToOpenCodeTuiConfig adds plugin to tui.json and removes duplicates', async () => {
    const tuiPath = join(tmpDir, 'opencode', 'tui.json');
    paths.ensureConfigDir();
    writeFileSync(
      tuiPath,
      JSON.stringify({ plugin: ['other', 'oh-my-opencode-slim@1.0.0'] }),
    );
    process.argv[1] = '';

    const result = await addPluginToOpenCodeTuiConfig();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(tuiPath, 'utf-8'));
    expect(saved.plugin).toContain('oh-my-opencode-slim');
    expect(saved.plugin).not.toContain('oh-my-opencode-slim@1.0.0');
    expect(saved.plugin.length).toBe(2);
  });

  test('addPluginToOpenCodeTuiConfig stores package name for bunx temp paths', async () => {
    const tuiPath = join(tmpDir, 'opencode', 'tui.json');
    const packageRoot = join(
      tmpDir,
      'bunx-1000-oh-my-opencode-slim@latest',
      'node_modules',
      'oh-my-opencode-slim',
    );
    paths.ensureConfigDir();
    writeFileSync(tuiPath, JSON.stringify({ plugin: [] }));
    writePackageJson(packageRoot);
    process.argv[1] = join(packageRoot, 'dist', 'cli', 'index.js');

    const result = await addPluginToOpenCodeTuiConfig();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(tuiPath, 'utf-8'));
    expect(saved.plugin).toEqual(['oh-my-opencode-slim']);
  });

  test('addPluginToOpenCodeTuiConfig removes tuple plugin entries', async () => {
    const tuiPath = join(tmpDir, 'opencode', 'tui.json');
    paths.ensureConfigDir();
    writeFileSync(
      tuiPath,
      JSON.stringify({
        plugin: ['other', ['oh-my-opencode-slim', { enabled: true }]],
      }),
    );
    process.argv[1] = '';

    const result = await addPluginToOpenCodeTuiConfig();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(tuiPath, 'utf-8'));
    expect(saved.plugin).toEqual(['other', 'oh-my-opencode-slim']);
  });

  test('addPluginToOpenCodeTuiConfig honors OPENCODE_TUI_CONFIG', async () => {
    const tuiPath = join(tmpDir, 'custom', 'tui.custom.json');
    process.env.OPENCODE_TUI_CONFIG = tuiPath;
    process.argv[1] = '';

    const result = await addPluginToOpenCodeTuiConfig();
    expect(result.success).toBe(true);
    expect(result.configPath).toBe(tuiPath);

    const saved = JSON.parse(readFileSync(tuiPath, 'utf-8'));
    expect(saved.plugin).toEqual(['oh-my-opencode-slim']);
  });

  test('addPluginToOpenCodeTuiConfig does not bypass OPENCODE_TUI_CONFIG for existing default config', async () => {
    const defaultTuiPath = join(tmpDir, 'opencode', 'tui.jsonc');
    const customTuiPath = join(tmpDir, 'custom', 'tui.json');
    paths.ensureConfigDir();
    writeFileSync(defaultTuiPath, JSON.stringify({ plugin: ['default'] }));
    process.env.OPENCODE_TUI_CONFIG = customTuiPath;
    process.argv[1] = '';

    const result = await addPluginToOpenCodeTuiConfig();
    expect(result.success).toBe(true);
    expect(result.configPath).toBe(customTuiPath);

    const custom = JSON.parse(readFileSync(customTuiPath, 'utf-8'));
    const original = JSON.parse(readFileSync(defaultTuiPath, 'utf-8'));
    expect(custom.plugin).toEqual(['oh-my-opencode-slim']);
    expect(original.plugin).toEqual(['default']);
  });

  test('addPluginToOpenCodeTuiConfig stores local repo path for local dev paths', async () => {
    const tuiPath = join(tmpDir, 'opencode', 'tui.json');
    const packageRoot = join(tmpDir, 'repo');
    const localCliPath = join(packageRoot, 'dist', 'cli', 'index.js');
    paths.ensureConfigDir();
    writeFileSync(tuiPath, JSON.stringify({ plugin: [] }));
    writePackageJson(packageRoot);
    process.argv[1] = localCliPath;

    const result = await addPluginToOpenCodeTuiConfig();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(tuiPath, 'utf-8'));
    expect(saved.plugin).toEqual([packageRoot]);
  });

  test('addPluginToOpenCodeTuiConfig deduplicates existing local repo path entries', async () => {
    const tuiPath = join(tmpDir, 'opencode', 'tui.json');
    const packageRoot = join(tmpDir, 'repo');
    const localCliPath = join(packageRoot, 'dist', 'cli', 'index.js');
    paths.ensureConfigDir();
    writePackageJson(packageRoot);
    writeFileSync(tuiPath, JSON.stringify({ plugin: ['other', packageRoot] }));
    process.argv[1] = localCliPath;

    const result = await addPluginToOpenCodeTuiConfig();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(tuiPath, 'utf-8'));
    expect(saved.plugin).toEqual(['other', packageRoot]);
  });

  test('addPluginToOpenCodeTuiConfig preserves non-string plugin entries when refreshing', async () => {
    const tuiPath = join(tmpDir, 'opencode', 'tui.json');
    paths.ensureConfigDir();
    process.argv[1] = '';

    const objectPlugin = { name: 'some-tui-plugin', enabled: true };
    writeFileSync(
      tuiPath,
      JSON.stringify({
        plugin: ['other-plugin', objectPlugin, 'oh-my-opencode-slim@1.0.0'],
      }),
    );

    const result = await addPluginToOpenCodeTuiConfig();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(tuiPath, 'utf-8'));
    expect(saved.plugin).toContain('oh-my-opencode-slim');
    expect(saved.plugin).toContain('other-plugin');
    expect(saved.plugin).not.toContain('oh-my-opencode-slim@1.0.0');
    // Non-string entries (objects) must survive the plugin refresh
    expect(saved.plugin).toContainEqual(objectPlugin);
    expect(saved.plugin.length).toBe(3);
  });

  test('writeLiteConfig writes lite config with OpenAI preset', () => {
    const litePath = join(tmpDir, 'opencode', 'oh-my-opencode-slim.json');
    paths.ensureConfigDir();

    const result = writeLiteConfig({
      reset: false,
    });
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(litePath, 'utf-8'));
    expect(saved.$schema).toBe(
      'https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json',
    );
    expect(saved.preset).toBe('openai');
    expect(saved.presets.openai).toBeDefined();
    expect(saved.presets['opencode-go']).toBeDefined();
  });

  test('resetting a symlinked lite config updates its target', () => {
    paths.ensureConfigDir();
    const link = paths.getLiteConfig();
    const target = join(tmpDir, 'dotfiles.json');
    const original = '{"preset":"old"}';
    writeFileSync(target, original);
    symlinkSync(target, link);
    const result = writeLiteConfig({ reset: true }, link);
    expect(result.success).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8')).preset).toBe('openai');
    expect(readFileSync(`${link}.bak`, 'utf8')).toBe(original);
  });

  test('broken JSONC config is selected for writes and fails clearly', async () => {
    paths.ensureConfigDir();
    const link = paths.getConfigJsonc();
    symlinkSync('missing.jsonc', link);
    const result = await addPluginToOpenCodeConfig();
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot resolve config path');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(paths.getConfigJson())).toBe(false);
  });

  test('writeLiteConfig writes selected preset', () => {
    const litePath = join(tmpDir, 'opencode', 'oh-my-opencode-slim.json');
    paths.ensureConfigDir();

    const result = writeLiteConfig({
      preset: 'opencode-go',
      reset: false,
    });
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(litePath, 'utf-8'));
    expect(saved.preset).toBe('opencode-go');
    expect(saved.disabled_agents).toEqual([]);
    expect(saved.presets.openai).toBeDefined();
    expect(saved.presets['opencode-go'].orchestrator.model).toBe(
      'opencode-go/minimax-m3',
    );
    expect(saved.presets['opencode-go'].orchestrator.variant).toBe('thinking');
    expect(saved.presets['opencode-go'].observer.model).toBe(
      'opencode-go/mimo-v2.5',
    );
    expect(saved.presets['opencode-go'].observer.variant).toBeUndefined();
  });

  test('installation preserves explicit lsp config', async () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    paths.ensureConfigDir();
    writeFileSync(configPath, JSON.stringify({ lsp: false }));

    const result = await addPluginToOpenCodeConfig();
    expect(result.success).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.lsp).toBe(false);
  });

  test('detectCurrentConfig detects installed status for installer-managed tuple', () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    paths.ensureConfigDir();

    writeFileSync(
      configPath,
      JSON.stringify({
        plugin: [
          [
            'oh-my-opencode-slim@1.2.3',
            { __ohMyOpencodeSlimManagedByInstaller: true },
          ],
        ],
      }),
    );

    expect(isPluginConfigured()).toBe(true);
  });

  test('detectCurrentConfig treats local repo path entries as installed', () => {
    const configPath = join(tmpDir, 'opencode', 'opencode.json');
    const packageRoot = join(tmpDir, 'repo');
    paths.ensureConfigDir();
    writePackageJson(packageRoot);
    writeFileSync(configPath, JSON.stringify({ plugin: [packageRoot] }));

    expect(isPluginConfigured()).toBe(true);
  });
});
