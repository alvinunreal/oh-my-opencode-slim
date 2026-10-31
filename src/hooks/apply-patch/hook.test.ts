import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { derive, parse } from '@opencode/util/patch';
import { Result } from 'effect';

import { parsePatch } from './codec';
import { createApplyPatchHook } from './index';
import { nativeDeriveUpdate } from './native-update';
import { applyPatch, createTempDir, writeFixture } from './test-helpers';

function createHook(root = '/tmp/hook-root') {
  return createApplyPatchHook({
    client: {} as never,
    directory: root,
    worktree: root,
  } as never);
}

async function runHook(
  root: string,
  patchText: string,
  worktree?: string,
  tool: string = 'apply_patch',
) {
  const hook = worktree
    ? createApplyPatchHook({
        client: {} as never,
        directory: root,
        worktree,
      } as never)
    : createHook(root);
  const output = { args: { patchText } };
  await hook['tool.execute.before']({ tool }, output);
  return output.args.patchText;
}

describe('apply-patch/hook', () => {
  test('accepts a blank line after a v2 end-of-file chunk', async () => {
    const root = await createTempDir();
    const text = 'x\ny\n';
    await writeFixture(root, 'a.txt', text);
    const patch =
      '*** Begin Patch\n*** Update File: a.txt\n@@\n-y\n+Y\n*** End of File\n\n*** End Patch';
    const forwarded = await runHook(root, patch, undefined, 'patch');
    const parsed = parse(forwarded);
    if (!Result.isSuccess(parsed) || parsed.success[0].type !== 'update')
      throw new Error('invalid v2 patch');
    expect(derive('a.txt', parsed.success[0].chunks, text).content).toBe(
      'x\nY\n',
    );
  });

  test('preserves EOF anchoring on v2 and rescues it on v1', async () => {
    const root = await createTempDir();
    const text = 'first\nsame\nmiddle\nsame\n';
    await writeFixture(root, 'a.txt', text);
    const patch =
      '*** Begin Patch\n*** Update File: a.txt\n@@\n-same\n+last\n*** End of File\n*** End Patch';
    const v2 = await runHook(root, patch, undefined, 'patch');
    const parsed = parse(v2);
    if (!Result.isSuccess(parsed) || parsed.success[0].type !== 'update')
      throw new Error('invalid v2 patch');
    expect(derive('a.txt', parsed.success[0].chunks, text).content).toBe(
      'first\nsame\nmiddle\nlast\n',
    );
    const v1 = parsePatch(await runHook(root, patch)).hunks[0];
    if (v1.type !== 'update') throw new Error('invalid v1 patch');
    expect(nativeDeriveUpdate('a.txt', text, v1.chunks)).toBe(
      'first\nsame\nmiddle\nlast\n',
    );
    await expect(
      runHook(
        root,
        patch.replace('-same\n+last', '-middle\n+changed'),
        undefined,
        'patch',
      ),
    ).rejects.toThrow();
  });

  test('canonicalizes an unprefixed blank context for both hosts', async () => {
    const root = await createTempDir();
    const text = 'before\n\nafter\n';
    await writeFixture(root, 'a.txt', text);
    const patch =
      '*** Begin Patch\n*** Update File: a.txt\n@@\n before\n\n-after\n+done\n*** End Patch';
    for (const tool of ['apply_patch', 'patch']) {
      const forwarded = await runHook(root, patch, undefined, tool);
      const parsed = parse(forwarded);
      if (!Result.isSuccess(parsed) || parsed.success[0].type !== 'update')
        throw new Error('invalid patch');
      expect(derive('a.txt', parsed.success[0].chunks, text).content).toBe(
        'before\n\ndone\n',
      );
      expect(forwarded).toContain('\n \n');
    }
  });

  test('accepts the implicit first v2 update chunk', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'a.txt', 'before\n');
    const forwarded = await runHook(
      root,
      '*** Begin Patch\n*** Update File: a.txt\n-before\n+after\n*** End Patch',
      undefined,
      'patch',
    );
    const parsed = parse(forwarded);
    if (!Result.isSuccess(parsed) || parsed.success[0].type !== 'update')
      throw new Error('invalid patch');
    expect(derive('a.txt', parsed.success[0].chunks, 'before\n').content).toBe(
      'after\n',
    );
  });

  test('v2 appends without consuming the existing trailing blank line', async () => {
    const root = await createTempDir();
    const text = '# Title\n\n';
    await writeFixture(root, 'a.txt', text);
    const forwarded = await runHook(
      root,
      '*** Begin Patch\n*** Update File: a.txt\n@@\n+Paragraph\n*** End Patch',
      undefined,
      'patch',
    );
    const parsed = parse(forwarded);
    if (!Result.isSuccess(parsed) || parsed.success[0].type !== 'update')
      throw new Error('invalid patch');
    expect(derive('a.txt', parsed.success[0].chunks, text).content).toBe(
      '# Title\n\nParagraph\n',
    );
  });

  test('v2 matches the host Unicode normalization table', async () => {
    const root = await createTempDir();
    const text = 'a\u202fb\nx \u2212 y\n';
    await writeFixture(root, 'a.txt', text);
    const forwarded = await runHook(
      root,
      '*** Begin Patch\n*** Update File: a.txt\n@@\n-a b\n-x - y\n+done\n*** End Patch',
      undefined,
      'patch',
    );
    const parsed = parse(forwarded);
    if (!Result.isSuccess(parsed) || parsed.success[0].type !== 'update')
      throw new Error('invalid patch');
    expect(derive('a.txt', parsed.success[0].chunks, text).content).toBe(
      'done\n',
    );
  });

  test('v2 canonicalizes tolerated blank section separators', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'a.txt', 'a\n');
    const forwarded = await runHook(
      root,
      '*** Begin Patch\n*** Add File: n.txt\n+n\n\n*** Update File: a.txt\n@@\n-a\n+A\n*** End Patch',
      undefined,
      'patch',
    );
    expect(Result.isSuccess(parse(forwarded))).toBe(true);
  });

  test('passes unrelated tools through byte-identically', async () => {
    const hook = createHook();
    const patchText = '*** Begin Patch\n*** End Patch';
    for (const tool of ['read', 'grep', 'patched']) {
      const output = { args: { patchText } };

      await hook['tool.execute.before']({ tool }, output);

      expect(output.args.patchText).toBe(patchText);
    }
  });

  test('serves the v2 native patch tool: rewrites and mutates args in place', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'prefix\nstale-value\nsuffix\n');
    const hook = createHook(root);
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
 prefix
-old-value
+new-value
 suffix
*** End Patch`;
    const args = { patchText };
    const output = { args };

    await hook['tool.execute.before']({ tool: 'patch' }, output);

    expect(output.args).toBe(args);
    expect(args.patchText).toContain('-stale-value');
    expect(args.patchText).toContain('+new-value');

    await applyPatch(root, args.patchText);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf-8')).toBe(
      'prefix\nnew-value\nsuffix\n',
    );
  });

  test('v2 patch tool with a non-string patchText passes through untouched', async () => {
    const hook = createHook();
    const output = { args: { patchText: 42 } };

    await hook['tool.execute.before']({ tool: 'patch' }, output);

    expect(output.args.patchText).toBe(42);
  });

  test('apply_patch and patch behave identically on the same patch', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'prefix\nstale-value\nsuffix\n');
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
 prefix
-old-value
+new-value
 suffix
*** End Patch`;
    const viaApplyPatch = await runHook(root, patchText);
    const viaPatch = await runHook(root, patchText, undefined, 'patch');
    expect(viaPatch).toBe(viaApplyPatch);
    expect(viaPatch).not.toBe(patchText);
  });

  test('blocks an unrecoverable patch as verification before native execution', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\ngamma\n');
    const hook = createHook(root);
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
-missing
+omega
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before']({ tool: 'apply_patch' }, output),
    ).rejects.toThrow(
      'patch verification failed: Failed to find expected lines',
    );

    expect(output.args.patchText).toBe(patchText);
  });

  test('passes through an absolute target outside root/worktree before native execution', async () => {
    const root = await createTempDir('apply-patch-hook-');
    const outsideDir = await createTempDir('apply-patch-hook-outside-');
    const outsidePath = path.join(outsideDir, 'outside.txt');
    await writeFile(outsidePath, 'outside\n', 'utf-8');
    const patchText = `*** Begin Patch
*** Update File: ${outsidePath}
@@
-outside
+changed
*** End Patch`;
    expect(await runHook(root, patchText, root)).toBe(patchText);
    expect(await readFile(outsidePath, 'utf-8')).toBe('outside\n');
  });

  test('rewrites a stale prefix patch and remains applicable', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(
      root,
      'sample.txt',
      'top\nA\nB-stale\nC\nD\nE\nbottom\n',
    );
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@ top
 A
-B
-C
-D
-E
+B
+C
+D
+X
*** End Patch`;
    const rewrittenText = await runHook(root, patchText);
    const rewritten = parsePatch(rewrittenText).hunks[0];
    expect(rewritten.type).toBe('update');
    expect(
      rewritten.type === 'update' && rewritten.chunks[0]?.old_lines,
    ).toEqual(['A', 'B-stale', 'C', 'D', 'E']);

    await applyPatch(root, rewrittenText);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf-8')).toBe(
      'top\nA\nB\nC\nD\nX\nbottom\n',
    );
  });

  test('rewrites by mutating the original args without replacing it', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'prefix\nstale-value\nsuffix\n');
    const hook = createHook(root);
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
 prefix
-old-value
+new-value
 suffix
*** End Patch`;
    const args = { patchText };
    const output = { args };

    await hook['tool.execute.before']({ tool: 'apply_patch' }, output);

    expect(output.args).toBe(args);
    expect(args.patchText).toContain('-stale-value');
    expect(args.patchText).toContain('+new-value');
  });

  test('fails open without replacing frozen args', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'prefix\nstale-value\nsuffix\n');
    const hook = createHook(root);
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
 prefix
-old-value
+new-value
 suffix
*** End Patch`;
    const args = Object.freeze({ patchText });
    const output = { args };

    await expect(
      hook['tool.execute.before']({ tool: 'apply_patch' }, output),
    ).resolves.toBeUndefined();

    expect(output.args).toBe(args);
    expect(args.patchText).toBe(patchText);
  });

  test('blocks a malformed @@ at runtime before native execution', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\n');
    const hook = createHook(root);
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
 alpha
garbage
-beta
+BETA
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before']({ tool: 'apply_patch' }, output),
    ).rejects.toThrow(
      'patch validation failed: Invalid patch format: unexpected line in patch chunk: garbage',
    );

    expect(output.args.patchText).toBe(patchText);
  });

  test('blocks internal guard errors before native execution', async () => {
    const root = await createTempDir('apply-patch-hook-');
    const lockedDir = path.join(root, 'locked');
    await mkdir(lockedDir, { recursive: true });
    await chmod(lockedDir, 0o000);
    const hook = createHook(root);
    const patchText = `*** Begin Patch
*** Add File: locked/child.txt
+fresh
*** End Patch`;
    const output = { args: { patchText } };

    try {
      await expect(
        hook['tool.execute.before']({ tool: 'apply_patch' }, output),
      ).rejects.toThrow('patch internal error:');

      expect(output.args.patchText).toBe(patchText);
    } finally {
      await chmod(lockedDir, 0o755);
    }
  });

  test('rewrites anchored insertion to avoid native EOF handling', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(
      root,
      'sample.txt',
      'top\nanchor-insert\nafter-anchor\nend\n',
    );
    const hook = createHook(root);
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@ anchor-insert
+middle-inserted
*** End Patch`;
    const output = { args: { patchText } };

    await hook['tool.execute.before']({ tool: 'apply_patch' }, output);

    await applyPatch(root, output.args.patchText as string);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf-8')).toBe(
      'top\nanchor-insert\nmiddle-inserted\nafter-anchor\nend\n',
    );
  });

  test('rewrites only the update hunk in a patch with add + update', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(
      root,
      'sample.txt',
      'top\nprefix\nstale-value\nsuffix\n',
    );
    const hook = createHook(root);
    const patchText = `*** Begin Patch
*** Add File: added.txt
+fresh
*** Update File: sample.txt
@@ top
 prefix
-old-value
+new-value
 suffix
*** End Patch`;
    const output = { args: { patchText } };

    await hook['tool.execute.before']({ tool: 'apply_patch' }, output);

    const rewritten = parsePatch(output.args.patchText as string);
    expect(rewritten.hunks[0]).toEqual({
      type: 'add',
      path: 'added.txt',
      contents: 'fresh',
    });
    expect(rewritten.hunks[1]).toEqual({
      type: 'update',
      path: 'sample.txt',
      chunks: [
        {
          old_lines: ['prefix', 'stale-value', 'suffix'],
          new_lines: ['prefix', 'new-value', 'suffix'],
          change_context: 'top',
          is_end_of_file: undefined,
        },
      ],
    });

    await applyPatch(root, output.args.patchText as string);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf-8')).toBe(
      'top\nprefix\nnew-value\nsuffix\n',
    );
    expect(await readFile(path.join(root, 'added.txt'), 'utf-8')).toBe(
      'fresh\n',
    );
  });

  test('normalizes an absolute path inside worktree even when it is outside root', async () => {
    const worktree = await createTempDir('apply-patch-worktree-');
    const root = path.join(worktree, 'subdir');
    await mkdir(root, { recursive: true });
    const siblingPath = path.join(worktree, 'shared.txt');
    const hook = createApplyPatchHook({
      client: {} as never,
      directory: root,
      worktree,
    } as never);
    const patchText = `*** Begin Patch
*** Add File: ${siblingPath}
+fresh
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before']({ tool: 'apply_patch' }, output),
    ).resolves.toBeUndefined();

    expect(parsePatch(output.args.patchText as string).hunks[0]).toMatchObject({
      type: 'add',
      path: '../shared.txt',
      contents: 'fresh',
    });
  });

  test('passes through mixed patches with outside paths without partial rewrite', async () => {
    const root = await createTempDir('apply-patch-hook-');
    const outsideDir = await createTempDir('apply-patch-hook-outside-');
    await writeFixture(root, 'sample.txt', 'prefix\nstale-value\nsuffix\n');
    await writeFixture(outsideDir, 'outside.txt', 'legacy\n');
    const hook = createHook(root);
    const outsideAdded = path.join(path.dirname(root), 'outside-added.txt');
    const patchText = `*** Begin Patch
*** Add File: ../outside-added.txt
+fresh
*** Update File: sample.txt
@@
 prefix
-old-value
+new-value
 suffix
*** Delete File: ../${path.basename(outsideDir)}/outside.txt
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before']({ tool: 'apply_patch' }, output),
    ).resolves.toBeUndefined();

    expect(output.args.patchText).toBe(patchText);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf-8')).toBe(
      'prefix\nstale-value\nsuffix\n',
    );
    expect(await stat(outsideAdded).catch(() => null)).toBeNull();
    expect(await readFile(path.join(outsideDir, 'outside.txt'), 'utf-8')).toBe(
      'legacy\n',
    );
  });

  test('does not expose the tool.execute.after hook', () => {
    const hook = createHook() as Record<string, unknown>;

    expect(hook['tool.execute.after']).toBeUndefined();
  });

  test('does not alter an exact patch', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\n');
    const hook = createHook(root);
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
-alpha
+omega
 beta
*** End Patch`;
    const output = { args: { patchText } };

    await hook['tool.execute.before']({ tool: 'apply_patch' }, output);

    expect(output.args.patchText).toBe(patchText);
  });
});
