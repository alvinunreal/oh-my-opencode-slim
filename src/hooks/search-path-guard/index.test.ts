import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PluginInput } from '@opencode-ai/plugin';

import { createSearchPathGuardHook, resolveSearchPath } from './index';

describe('search-path-guard hook', () => {
  let tempRoot: string;

  const createHook = (
    directory: string,
    hostFlavor?: string,
  ): ReturnType<typeof createSearchPathGuardHook> =>
    createSearchPathGuardHook({
      client: {} as PluginInput['client'],
      directory,
      hostFlavor,
    } as PluginInput);

  const runHook = (
    hook: ReturnType<typeof createSearchPathGuardHook>,
    tool: string,
    args: Record<string, unknown> | undefined,
  ): Promise<void> =>
    hook['tool.execute.before']({ tool }, args === undefined ? {} : { args });

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'search-path-guard-'));
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test('blocks grep when the absolute path does not exist', async () => {
    const hook = createHook(tempRoot);
    const missing = path.join(tempRoot, 'does-not-exist', 'missing.txt');

    const promise = runHook(hook, 'grep', { path: missing });

    await expect(promise).rejects.toThrow(/Search path does not exist/);
    await expect(promise).rejects.toThrow(missing);
  });

  test('blocks glob when the relative path does not exist under directory', async () => {
    const hook = createHook(tempRoot);
    const raw = 'no-such-dir';
    const resolved = path.join(tempRoot, raw);

    const promise = runHook(hook, 'glob', { path: raw });

    await expect(promise).rejects.toThrow(/Search path does not exist/);
    await expect(promise).rejects.toThrow(resolved);
  });

  test('allows an existing absolute file path', async () => {
    const filePath = path.join(tempRoot, 'file.txt');
    await writeFile(filePath, 'content');

    const hook = createHook(tempRoot);

    await runHook(hook, 'grep', { path: filePath });
  });

  test('allows an existing relative directory', async () => {
    await mkdir(path.join(tempRoot, 'subdir'));

    const hook = createHook(tempRoot);

    await runHook(hook, 'glob', { path: 'subdir' });
  });

  test('never blocks a relative path when directory is falsy', async () => {
    const hook = createHook('');

    await runHook(hook, 'grep', { path: 'definitely-missing-relative' });
  });

  test('ignores tools other than grep and glob', async () => {
    const hook = createHook(tempRoot);
    const missing = path.join(tempRoot, 'does-not-exist');

    await runHook(hook, 'read', { path: missing });
    await runHook(hook, 'bash', { path: missing });
  });

  test('ignores absent, non-string, or empty path values', async () => {
    const hook = createHook(tempRoot);

    await runHook(hook, 'grep', undefined);
    await runHook(hook, 'grep', {});
    await runHook(hook, 'glob', { path: 42 });
    await runHook(hook, 'glob', { path: null });
    await runHook(hook, 'grep', { path: '' });
  });

  test('blocks literal undefined/null strings like the host would resolve them', async () => {
    const hook = createHook(tempRoot);

    await expect(runHook(hook, 'grep', { path: 'undefined' })).rejects.toThrow(
      path.join(tempRoot, 'undefined'),
    );
    await expect(runHook(hook, 'glob', { path: 'null' })).rejects.toThrow(
      path.join(tempRoot, 'null'),
    );
  });

  test('preserves significant whitespace when resolving and blocking', async () => {
    const hook = createHook(tempRoot);
    const raw = '  padded-missing-dir  ';
    const resolved = path.join(tempRoot, raw);

    const promise = runHook(hook, 'glob', { path: raw });

    await expect(promise).rejects.toThrow(/Search path does not exist/);
    await expect(promise).rejects.toThrow(resolved);
  });

  test('allows a directory whose name contains significant whitespace', async () => {
    await mkdir(path.join(tempRoot, 'spaced dir '));

    const hook = createHook(tempRoot);

    await runHook(hook, 'glob', { path: 'spaced dir ' });
  });

  test('rejects an ENOTDIR path with an actionable error', async () => {
    const filePath = path.join(tempRoot, 'reg-file.txt');
    await writeFile(filePath, 'content');

    const hook = createHook(tempRoot);

    // A file used as a path component makes stat fail with ENOTDIR; the
    // guard should explain the malformed path instead of passing an opaque
    // ripgrep failure through to the caller.
    await expect(
      runHook(hook, 'grep', { path: 'reg-file.txt/child' }),
    ).rejects.toThrow(/not a directory.*ENOTDIR/);
    await expect(
      runHook(hook, 'glob', { path: 'reg-file.txt/child' }),
    ).rejects.toThrow(/not a directory.*ENOTDIR/);
  });

  test('uses the host grep and glob resolution rules separately', async () => {
    const directory = path.relative(process.cwd(), tempRoot);
    const raw = 'missing-search-path';
    const hook = createHook(directory);

    await expect(runHook(hook, 'grep', { path: raw })).rejects.toThrow(
      path.join(directory, raw),
    );
    await expect(runHook(hook, 'glob', { path: raw })).rejects.toThrow(
      path.resolve(directory, raw),
    );
  });

  test('preserves native Windows drive-relative host semantics', async () => {
    if (process.platform !== 'win32') return;

    const raw = 'C:missing-search-path';
    const hook = createHook(tempRoot);

    await expect(runHook(hook, 'grep', { path: raw })).rejects.toThrow(
      path.join(tempRoot, raw),
    );
    await expect(runHook(hook, 'glob', { path: raw })).rejects.toThrow(
      path.resolve(tempRoot, raw),
    );
  });

  test('v2 grep resolves drive-relative paths with win32 resolve semantics', () => {
    const directory = 'D:\\workspace';
    const raw = 'C:src';

    expect(resolveSearchPath('grep', 'v2', directory, raw, path.win32)).toBe(
      path.win32.resolve(directory, raw),
    );
    expect(
      resolveSearchPath('grep', undefined, directory, raw, path.win32),
    ).toBe(path.win32.join(directory, raw));
  });

  test('allows grep when the path points to an existing file', async () => {
    const filePath = path.join(tempRoot, 'target-file.ts');
    await writeFile(filePath, 'export {}');

    const hook = createHook(tempRoot);

    await runHook(hook, 'grep', { path: filePath });
  });
});
