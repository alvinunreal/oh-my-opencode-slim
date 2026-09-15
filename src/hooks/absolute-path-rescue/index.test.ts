import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PluginInput } from '@opencode-ai/plugin';

import { createAbsolutePathRescueHook, findRescuedSuffix } from './index';

describe('absolute-path-rescue hook', () => {
  let tempRoot: string;
  let workspace: string;

  const createHook = (
    directory: string,
  ): ReturnType<typeof createAbsolutePathRescueHook> =>
    createAbsolutePathRescueHook({
      client: {} as PluginInput['client'],
      directory,
    } as PluginInput);

  const runHook = (
    hook: ReturnType<typeof createAbsolutePathRescueHook>,
    tool: string,
    args: Record<string, unknown> | undefined,
  ): Promise<void> =>
    hook['tool.execute.before']({ tool }, args === undefined ? {} : { args });

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'absolute-path-rescue-'));
    workspace = path.join(tempRoot, 'Parent', 'Child', 'Project');
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    await writeFile(path.join(workspace, 'src', 'app.ts'), 'export {}');
    await writeFile(path.join(workspace, 'README.md'), '# root readme');
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test('rewrites a dropped-segment absolute path to the existing suffix', async () => {
    const hook = createHook(workspace);
    const guessed = path.join(tempRoot, 'Parent', 'Project'); // Child dropped
    const args = { filePath: path.join(guessed, 'src', 'app.ts') };

    await runHook(hook, 'read', args);

    expect(args.filePath).toBe(path.join(workspace, 'src', 'app.ts'));
  });

  test('rescues the path key used by glob/grep-style tools', async () => {
    const hook = createHook(workspace);
    const guessed = path.join(tempRoot, 'Project', 'src'); // Parent/Child dropped
    const args = { path: guessed };

    await runHook(hook, 'glob', args);

    expect(args.path).toBe(path.join(workspace, 'src'));
  });

  test('never rewrites a missing path already under the workspace', async () => {
    const hook = createHook(workspace);
    const args = { filePath: path.join(workspace, 'nonexistent', 'README.md') };

    await runHook(hook, 'read', args);

    expect(args.filePath).toBe(
      path.join(workspace, 'nonexistent', 'README.md'),
    );
  });

  test('leaves an existing absolute path untouched', async () => {
    const hook = createHook(workspace);
    const args = { filePath: path.join(workspace, 'src', 'app.ts') };

    await runHook(hook, 'read', args);

    expect(args.filePath).toBe(path.join(workspace, 'src', 'app.ts'));
  });

  test('leaves relative paths untouched', async () => {
    const hook = createHook(workspace);
    const args = { filePath: 'src/app.ts' };

    await runHook(hook, 'read', args);

    expect(args.filePath).toBe('src/app.ts');
  });

  test('leaves a guess with no existing confined suffix untouched', async () => {
    const hook = createHook(workspace);
    const unrelated = path.join(os.tmpdir(), 'elsewhere', 'nope');
    const args = { filePath: unrelated };

    await runHook(hook, 'read', args);

    expect(args.filePath).toBe(unrelated);
  });

  test('rejects guesses containing .. segments entirely', () => {
    // Literal string: path.join would normalize the .. away.
    const dotted = `${os.tmpdir()}/__slim_missing_1143__/../../src`;
    expect(findRescuedSuffix(dotted, workspace)).toBeNull();
  });

  test('never trims the tail to a bare basename (meaning change)', () => {
    // Anchor = basename(workspace) matches, but the tail after it does
    // not exist: no rescue to <workspace>/README.md (oracle counterexample).
    const guessed = path.join(
      tempRoot,
      path.basename(workspace), // == workspace leaf name
      'nonexistent-subproject',
      'README.md',
    );
    expect(findRescuedSuffix(guessed, workspace)).toBeNull();
  });

  test('repeated anchor occurrences make the rescue ambiguous (null)', () => {
    const base = path.basename(workspace);
    const guessed = path.join(
      tempRoot,
      base,
      'nonexistent-subproject',
      base,
      'README.md',
    );
    expect(findRescuedSuffix(guessed, workspace)).toBeNull();
  });

  test('a missing tail under the longest anchor never falls back shorter', () => {
    // Longest anchor = Child/Project matches; its tail is missing. The
    // rescue must NOT reinterpret via the shorter anchor Project
    // (which would find src/ under the workspace).
    const guessed = path.join(
      tempRoot,
      'Parent',
      'Child',
      'Project',
      'nope',
      'src',
    );
    expect(findRescuedSuffix(guessed, workspace)).toBeNull();
  });

  test('anchor at guess end rescues to the workspace root', () => {
    // Canonical dropped-parents: guess stops exactly at Project.
    const guessed = path.join(tempRoot, 'Parent', 'Project');
    expect(findRescuedSuffix(guessed, workspace)).toBe(workspace);
  });

  test('forward slashes in a guess segment like a Windows drive path', () => {
    // On win32 path.sep is '\': a C:/Users/… guess with a dropped
    // parent must segment the same as the workspace. Simulated with a
    // win32-flavored path module and an injected `exists` so the test
    // is meaningful on every platform.
    const win32Path = path.win32;
    const target = 'C:\\Users\\dev\\Work\\Parent\\Project\\src\\app.ts';
    const guessed = 'C:/Users/dev/Work/Project/src/app.ts'; // Parent dropped
    const rescued = findRescuedSuffix(
      guessed,
      'C:\\Users\\dev\\Work\\Parent\\Project',
      win32Path,
      (p) => p === target,
    );
    expect(rescued).toBe(target);
  });

  test('rejects candidates whose stat fails for non-ENOENT reasons', () => {
    // /src/app.ts/extra crosses a FILE component: stat yields ENOTDIR,
    // which must NOT count as an existing candidate.
    const guessed = path.join(tempRoot, 'Project', 'src', 'app.ts', 'extra');
    expect(findRescuedSuffix(guessed, workspace)).toBeNull();
  });

  test('ignores tools without a file path argument', async () => {
    const hook = createHook(workspace);
    const args = { command: `cat ${path.join(tempRoot, 'Project', 'x')}` };

    await runHook(hook, 'bash', args);

    expect(args.command).toContain('Project'); // untouched
  });

  test('findRescuedSuffix keeps the longest existing tail', () => {
    const guessed = path.join(tempRoot, 'Parent', 'Project');
    expect(
      findRescuedSuffix(path.join(guessed, 'src', 'app.ts'), workspace),
    ).toBe(path.join(workspace, 'src', 'app.ts'));
    // A guess with no matching tail yields no rescue.
    expect(
      findRescuedSuffix(path.join(guessed, 'nope', 'missing'), workspace),
    ).toBeNull();
  });
});
