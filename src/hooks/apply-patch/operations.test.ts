import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, stat, symlink } from 'node:fs/promises';
import path from 'node:path';

import { parsePatch } from './codec';
import {
  isApplyPatchBlockedError,
  isApplyPatchValidationError,
  isApplyPatchVerificationError,
} from './errors';
import {
  applyPreparedChanges,
  preparePatchChanges,
  rewritePatch,
  rewritePatchText,
} from './operations';
import {
  applyPatch,
  createTempDir,
  DEFAULT_OPTIONS,
  readText,
  writeFixture,
} from './test-helpers';

describe('apply-patch/operations', () => {
  test('preparePatchChanges and applyPreparedChanges apply an exact match', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\ngamma\n');
    await chmod(path.join(root, 'sample.txt'), 0o750);

    await applyPatch(
      root,
      `*** Begin Patch
*** Update File: sample.txt
@@
 alpha
-beta
+BETA
 gamma
*** End Patch`,
    );

    expect(await readText(root, 'sample.txt')).toBe('alpha\nBETA\ngamma\n');
    expect((await stat(path.join(root, 'sample.txt'))).mode & 0o777).toBe(
      0o750,
    );
  });

  test('rewritePatchText leaves a healthy patch intact', async () => {
    const root = await createTempDir();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@ exact-top
-exact-old
+exact-new
 exact-bottom
*** End Patch`;
    await writeFixture(
      root,
      'sample.txt',
      'line-01\nexact-top\nexact-old\nexact-bottom\nline-05\n',
    );

    expect(await rewritePatchText(root, patchText, DEFAULT_OPTIONS)).toBe(
      patchText,
    );
    expect(await rewritePatch(root, patchText, DEFAULT_OPTIONS)).toMatchObject({
      patchText,
      changed: false,
      rewrittenChunks: 0,
      rewriteModes: [],
    });
  });

  test('rewritePatchText unwraps an exact patch wrapped in a heredoc', async () => {
    const root = await createTempDir();
    const cleanPatchText = `*** Begin Patch
*** Update File: sample.txt
@@ exact-top
-exact-old
+exact-new
 exact-bottom
*** End Patch`;
    const patchText = `cat <<'PATCH'
${cleanPatchText}
PATCH`;
    await writeFixture(
      root,
      'sample.txt',
      'line-01\nexact-top\nexact-old\nexact-bottom\nline-05\n',
    );

    expect(await rewritePatchText(root, patchText, DEFAULT_OPTIONS)).toBe(
      cleanPatchText,
    );
    expect(await rewritePatch(root, patchText, DEFAULT_OPTIONS)).toMatchObject({
      patchText: cleanPatchText,
      changed: true,
      rewrittenChunks: 0,
      rewriteModes: ['normalize:patch-text'],
    });
  });

  test('rewritePatchText normalizes exact CRLF + heredoc input and the patch still works', async () => {
    const root = await createTempDir();
    const cleanPatchText = `*** Begin Patch
*** Update File: sample.txt
@@ exact-top
-exact-old
+exact-new
 exact-bottom
*** End Patch`;
    const patchText = [
      "cat <<'PATCH'",
      '*** Begin Patch',
      '*** Update File: sample.txt',
      '@@ exact-top',
      '-exact-old',
      '+exact-new',
      ' exact-bottom',
      '*** End Patch',
      'PATCH',
    ].join('\r\n');
    await writeFixture(
      root,
      'sample.txt',
      'line-01\nexact-top\nexact-old\nexact-bottom\nline-05\n',
    );

    const rewritten = await rewritePatchText(root, patchText, DEFAULT_OPTIONS);

    expect(rewritten).toBe(cleanPatchText);
    await applyPatch(root, rewritten);
    expect(await readText(root, 'sample.txt')).toBe(
      'line-01\nexact-top\nexact-new\nexact-bottom\nline-05\n',
    );
  });

  test('rewritePatchText rewrites a stale patch and preserves new_lines byte-for-byte', async () => {
    const root = await createTempDir();
    await writeFixture(
      root,
      'sample.txt',
      'top\nprefix\nstale-value\nsuffix\nbottom\n',
    );
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@ top
 prefix
-old-value
+ \tverbatim  ""  Ω  
 suffix
*** End Patch`;

    const rewritten = parsePatch(
      await rewritePatchText(root, patchText, DEFAULT_OPTIONS),
    ).hunks[0];

    expect(rewritten.type).toBe('update');
    expect(
      rewritten.type === 'update' && rewritten.chunks[0]?.old_lines,
    ).toEqual(['prefix', 'stale-value', 'suffix']);
    expect(
      rewritten.type === 'update' && rewritten.chunks[0]?.new_lines,
    ).toEqual(['prefix', ' \tverbatim  ""  Ω  ', 'suffix']);
  });

  test('rewritePatchText removes EOF when a rescue moves the chunk away from the real end', async () => {
    const root = await createTempDir();
    await writeFixture(
      root,
      'sample.txt',
      'top\nprefix\nstale\nsuffix\nbottom\n',
    );
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@ top
 prefix
-old
+new
 suffix
*** End of File
*** End Patch`;

    const rewrittenText = await rewritePatchText(
      root,
      patchText,
      DEFAULT_OPTIONS,
    );
    const rewritten = parsePatch(rewrittenText).hunks[0];

    expect(rewrittenText.includes('*** End of File')).toBeFalse();
    expect(rewritten.type).toBe('update');
    expect(
      rewritten.type === 'update'
        ? rewritten.chunks[0]?.is_end_of_file
        : undefined,
    ).toBeUndefined();
  });

  test('rewritePatchText keeps EOF when the resolved chunk still ends at the real end', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha\nstale\nomega');
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
-alpha
-old
-omega
+alpha
+new
+omega
*** End of File
*** End Patch`;

    const rewrittenText = await rewritePatchText(
      root,
      patchText,
      DEFAULT_OPTIONS,
    );
    const rewritten = parsePatch(rewrittenText).hunks[0];

    expect(rewrittenText.includes('*** End of File')).toBeTrue();
    expect(rewritten.type).toBe('update');
    expect(
      rewritten.type === 'update'
        ? rewritten.chunks[0]?.is_end_of_file
        : undefined,
    ).toBeTrue();
  });

  test('rewritePatchText canonicalizes a unicode-only stale patch', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'const title = “Hola”;\n');
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
-const title = "Hola";
+const title = "Hola mundo";
*** End Patch`;

    const rewritten = parsePatch(
      await rewritePatchText(root, patchText, DEFAULT_OPTIONS),
    ).hunks[0];

    expect(rewritten.type).toBe('update');
    expect(
      rewritten.type === 'update' ? rewritten.chunks[0]?.old_lines : undefined,
    ).toEqual(['const title = “Hola”;']);
    expect(
      rewritten.type === 'update' ? rewritten.chunks[0]?.new_lines : undefined,
    ).toEqual(['const title = "Hola mundo";']);
  });

  test('rewritePatchText canonicalizes a trim-end stale patch', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha  \n');
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
-alpha
+omega
*** End Patch`;

    const rewritten = parsePatch(
      await rewritePatchText(root, patchText, DEFAULT_OPTIONS),
    ).hunks[0];

    expect(rewritten.type).toBe('update');
    expect(
      rewritten.type === 'update' ? rewritten.chunks[0]?.old_lines : undefined,
    ).toEqual(['alpha  ']);
    expect(
      rewritten.type === 'update' ? rewritten.chunks[0]?.new_lines : undefined,
    ).toEqual(['omega']);
  });

  test('rewritePatchText no longer rescues a trim-only stale patch', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', '  alpha  \n');
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
-alpha
+omega
*** End Patch`;

    await expect(
      rewritePatchText(root, patchText, DEFAULT_OPTIONS),
    ).rejects.toThrow(
      'apply_patch verification failed: Failed to find expected lines',
    );
  });

  test('rewritePatchText no longer canonicalizes a dangerous indented case', async () => {
    const root = await createTempDir();
    await writeFixture(
      root,
      'sample.yml',
      'root:\n  child:\n    enabled: false\nnext: true\n',
    );
    const patchText = `*** Begin Patch
*** Update File: sample.yml
@@
-enabled: false
+enabled: true
*** End Patch`;

    await expect(
      rewritePatchText(root, patchText, DEFAULT_OPTIONS),
    ).rejects.toThrow(
      'apply_patch verification failed: Failed to find expected lines',
    );
  });

  test('rewritePatchText rejects malformed @@ instead of silently sanitizing it', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\n');

    await expect(
      rewritePatchText(
        root,
        `*** Begin Patch
*** Update File: sample.txt
@@
 alpha
garbage
-beta
+BETA
*** End Patch`,
        DEFAULT_OPTIONS,
      ),
    ).rejects.toThrow(
      'apply_patch validation failed: Invalid patch format: unexpected line in patch chunk: garbage',
    );
  });

  test('preparePatchChanges rejects a malformed Add File', async () => {
    const root = await createTempDir();

    await expect(
      preparePatchChanges(
        root,
        `*** Begin Patch
*** Add File: added.txt
+fresh
garbage
*** End Patch`,
        DEFAULT_OPTIONS,
      ),
    ).rejects.toThrow(
      'apply_patch validation failed: Invalid patch format: unexpected line in Add File body: garbage',
    );
  });

  test('preparePatchChanges normalizes an Update File with an absolute path inside root', async () => {
    const root = await createTempDir();
    const absolutePath = path.join(root, 'sample.txt');
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\n');

    const rewritten = await rewritePatch(
      root,
      `*** Begin Patch
*** Update File: ${absolutePath}
@@
-alpha
+omega
*** End Patch`,
      DEFAULT_OPTIONS,
    );

    expect(rewritten.changed).toBeTrue();
    expect(rewritten.rewriteModes).toContain('normalize:patch-paths');
    const [rewrittenHunk] = parsePatch(rewritten.patchText).hunks;
    expect(rewrittenHunk.type).toBe('update');
    expect(rewrittenHunk.path).toBe('sample.txt');

    await expect(
      preparePatchChanges(
        root,
        `*** Begin Patch
*** Update File: ${absolutePath}
@@
-alpha
+omega
*** End Patch`,
        DEFAULT_OPTIONS,
      ),
    ).resolves.toEqual([
      {
        type: 'update',
        file: absolutePath,
        move: undefined,
        text: 'omega\nbeta\n',
      },
    ]);
  });

  test('preparePatchChanges normalizes an Add File with an absolute path inside root', async () => {
    const root = await createTempDir();
    const absolutePath = path.join(root, 'added.txt');

    const rewritten = await rewritePatch(
      root,
      `*** Begin Patch
*** Add File: ${absolutePath}
+fresh
*** End Patch`,
      DEFAULT_OPTIONS,
    );

    expect(rewritten.changed).toBeTrue();
    expect(parsePatch(rewritten.patchText).hunks[0]).toMatchObject({
      type: 'add',
      path: 'added.txt',
      contents: 'fresh',
    });

    await expect(
      preparePatchChanges(
        root,
        `*** Begin Patch
*** Add File: ${absolutePath}
+fresh
*** End Patch`,
        DEFAULT_OPTIONS,
      ),
    ).resolves.toEqual([
      {
        type: 'add',
        file: absolutePath,
        text: 'fresh\n',
      },
    ]);
  });

  test('preparePatchChanges normalizes a Move to with an absolute path inside root', async () => {
    const root = await createTempDir();
    const absoluteMovePath = path.join(root, 'nested/after.txt');

    await writeFixture(root, 'before.txt', 'alpha\nbeta\n');

    const rewritten = await rewritePatch(
      root,
      `*** Begin Patch
*** Update File: before.txt
*** Move to: ${absoluteMovePath}
@@
 alpha
-beta
+BETA
*** End Patch`,
      DEFAULT_OPTIONS,
    );

    expect(rewritten.changed).toBeTrue();
    expect(parsePatch(rewritten.patchText).hunks[0]).toMatchObject({
      type: 'update',
      path: 'before.txt',
      move_path: 'nested/after.txt',
    });

    await expect(
      preparePatchChanges(
        root,
        `*** Begin Patch
*** Update File: before.txt
*** Move to: ${absoluteMovePath}
@@
 alpha
-beta
+BETA
*** End Patch`,
        DEFAULT_OPTIONS,
      ),
    ).resolves.toEqual([
      {
        type: 'update',
        file: path.join(root, 'before.txt'),
        move: absoluteMovePath,
        text: 'alpha\nBETA\n',
      },
    ]);
  });

  test('preparePatchChanges blocks an absolute path outside root/worktree', async () => {
    const root = await createTempDir();
    const outsidePath = path.join(path.dirname(root), 'outside.txt');

    const error = await preparePatchChanges(
      root,
      `*** Begin Patch
*** Add File: ${outsidePath}
+fresh
*** End Patch`,
      DEFAULT_OPTIONS,
    ).catch((caughtError) => caughtError);

    expect(isApplyPatchBlockedError(error)).toBeTrue();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `apply_patch blocked: patch contains path outside workspace root: ${outsidePath}`,
    );
  });

  test('preparePatchChanges allows an absolute path inside worktree even when it is outside root', async () => {
    const worktree = await createTempDir();
    const root = path.join(worktree, 'subdir');
    await mkdir(root, { recursive: true });
    const siblingPath = path.join(worktree, 'shared.txt');

    const rewritten = await rewritePatch(
      root,
      `*** Begin Patch
*** Add File: ${siblingPath}
+fresh
*** End Patch`,
      DEFAULT_OPTIONS,
      worktree,
    );

    expect(rewritten.changed).toBeTrue();
    expect(parsePatch(rewritten.patchText).hunks[0]).toMatchObject({
      type: 'add',
      path: '../shared.txt',
      contents: 'fresh',
    });

    await expect(
      preparePatchChanges(
        root,
        `*** Begin Patch
*** Add File: ${siblingPath}
+fresh
*** End Patch`,
        DEFAULT_OPTIONS,
        worktree,
      ),
    ).resolves.toEqual([
      {
        type: 'add',
        file: siblingPath,
        text: 'fresh\n',
      },
    ]);
  });

  test('preparePatchChanges does not redirect an absolute root target to its basename', async () => {
    const root = await createTempDir();

    await expect(
      preparePatchChanges(
        root,
        `*** Begin Patch
*** Add File: ${root}
+fresh
*** End Patch`,
        DEFAULT_OPTIONS,
      ),
    ).rejects.toThrow(
      `apply_patch verification failed: Add File target already exists: ${root}`,
    );
  });

  test('preparePatchChanges rejects Add File on an existing path', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'added.txt', 'legacy\n');

    await expect(
      preparePatchChanges(
        root,
        `*** Begin Patch
*** Add File: added.txt
+fresh
*** End Patch`,
        DEFAULT_OPTIONS,
      ),
    ).rejects.toThrow(
      `apply_patch verification failed: Add File target already exists: ${path.join(root, 'added.txt')}`,
    );
  });

  test('preparePatchChanges rejects Move to on a different existing destination', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'before.txt', 'alpha\nbeta\n');
    await writeFixture(root, 'nested/after.txt', 'legacy\n');

    await expect(
      preparePatchChanges(
        root,
        `*** Begin Patch
*** Update File: before.txt
*** Move to: nested/after.txt
@@
 alpha
-beta
+BETA
*** End Patch`,
        DEFAULT_OPTIONS,
      ),
    ).rejects.toThrow(
      `apply_patch verification failed: Move destination already exists: ${path.join(root, 'nested/after.txt')}`,
    );
  });

  test('rewritePatchText rejects a missing Delete File like preparePatchChanges', async () => {
    const root = await createTempDir();
    const patchText = `*** Begin Patch
*** Delete File: missing.txt
*** End Patch`;
    const expectedMessage = `apply_patch verification failed: Failed to read file to delete: ${path.join(root, 'missing.txt')}`;

    await expect(
      rewritePatchText(root, patchText, DEFAULT_OPTIONS),
    ).rejects.toThrow(expectedMessage);
    await expect(
      preparePatchChanges(root, patchText, DEFAULT_OPTIONS),
    ).rejects.toThrow(expectedMessage);
  });

  test('rewritePatchText rejects duplicate Delete File on the same path', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'obsolete.txt', 'legacy\n');

    await expect(
      rewritePatchText(
        root,
        `*** Begin Patch
*** Delete File: obsolete.txt
*** Delete File: obsolete.txt
*** End Patch`,
        DEFAULT_OPTIONS,
      ),
    ).rejects.toThrow(
      `apply_patch verification failed: Failed to read file to delete: ${path.join(root, 'obsolete.txt')}`,
    );
  });

  test('rewritePatchText rejects Delete File on the source after a previous move', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'before.txt', 'alpha\nbeta\n');

    await expect(
      rewritePatchText(
        root,
        `*** Begin Patch
*** Update File: before.txt
*** Move to: nested/after.txt
@@
 alpha
-beta
+BETA
*** Delete File: before.txt
*** End Patch`,
        DEFAULT_OPTIONS,
      ),
    ).rejects.toThrow(
      `apply_patch verification failed: Failed to read file to delete: ${path.join(root, 'before.txt')}`,
    );
  });

  test('rewritePatchText keeps a valid Delete File and apply still works', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'obsolete.txt', 'legacy\n');
    const patchText = `*** Begin Patch
*** Delete File: obsolete.txt
*** End Patch`;

    expect(await rewritePatchText(root, patchText, DEFAULT_OPTIONS)).toBe(
      patchText,
    );

    await applyPatch(root, patchText);
    await expect(readText(root, 'obsolete.txt')).rejects.toThrow();
  });

  test('applyPreparedChanges rejects direct add on an existing path', async () => {
    const root = await createTempDir();
    const target = path.join(root, 'added.txt');
    await writeFixture(root, 'added.txt', 'legacy\n');

    await expect(
      applyPreparedChanges([
        {
          type: 'add',
          file: target,
          text: 'fresh\n',
        },
      ]),
    ).rejects.toThrow(
      `apply_patch verification failed: Prepared add target already exists: ${target}`,
    );

    expect(await readText(root, 'added.txt')).toBe('legacy\n');
  });

  test('applyPreparedChanges rejects direct move on an existing destination', async () => {
    const root = await createTempDir();
    const source = path.join(root, 'before.txt');
    const target = path.join(root, 'nested/after.txt');
    await writeFixture(root, 'before.txt', 'alpha\nbeta\n');
    await writeFixture(root, 'nested/after.txt', 'legacy\n');

    await expect(
      applyPreparedChanges([
        {
          type: 'update',
          file: source,
          move: target,
          text: 'alpha\nBETA\n',
        },
      ]),
    ).rejects.toThrow(
      `apply_patch verification failed: Prepared move destination already exists: ${target}`,
    );

    expect(await readText(root, 'before.txt')).toBe('alpha\nbeta\n');
    expect(await readText(root, 'nested/after.txt')).toBe('legacy\n');
  });

  test('applyPreparedChanges rejects legacy arrays with relative paths', async () => {
    const error = await applyPreparedChanges([
      {
        type: 'add',
        file: 'relative.txt' as unknown as string,
        text: 'fresh\n',
      },
    ]).catch((caughtError) => caughtError);

    expect(isApplyPatchValidationError(error)).toBeTrue();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'apply_patch validation failed: Prepared changes require absolute normalized file paths at index 0: relative.txt',
    );
  });

  test('rewritePatchText and preparePatchChanges share the validation/verification taxonomy', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\n');

    const verificationError = await rewritePatchText(
      root,
      `*** Begin Patch
*** Update File: sample.txt
@@
-missing
+omega
*** End Patch`,
      DEFAULT_OPTIONS,
    ).catch((error) => error);

    const validationError = await preparePatchChanges(
      root,
      `*** Begin Patch
*** Add File: added.txt
+fresh
garbage
*** End Patch`,
      DEFAULT_OPTIONS,
    ).catch((error) => error);

    expect(isApplyPatchVerificationError(verificationError)).toBeTrue();
    expect(isApplyPatchValidationError(validationError)).toBeTrue();
  });

  test('rewritePatchText canonicalizes EOF insertion with a tolerant anchor', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'top\n“anchor”\n');

    const rewritten = parsePatch(
      await rewritePatchText(
        root,
        `*** Begin Patch
*** Update File: sample.txt
@@ "anchor"
+middle
*** End Patch`,
        DEFAULT_OPTIONS,
      ),
    ).hunks[0];

    expect(rewritten.type).toBe('update');
    expect(
      rewritten.type === 'update'
        ? rewritten.chunks[0]?.change_context
        : undefined,
    ).toBe('“anchor”');
    expect(
      rewritten.type === 'update' ? rewritten.chunks[0]?.new_lines : undefined,
    ).toEqual(['middle']);
  });

  test('rewritePatch groups two exact Update File hunks on the same path', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\ngamma\ndelta\n');

    const result = await rewritePatch(
      root,
      `*** Begin Patch
*** Update File: sample.txt
@@
 alpha
-beta
+BETA
 gamma
*** Update File: sample.txt
@@
 gamma
-delta
+DELTA
*** End Patch`,
      DEFAULT_OPTIONS,
    );

    const rewritten = parsePatch(result.patchText);
    expect(result.changed).toBeTrue();
    expect(result.rewriteModes).toContain('merge:same-file-updates');
    expect(rewritten.hunks).toHaveLength(1);
    expect(rewritten.hunks[0]).toEqual({
      type: 'update',
      path: 'sample.txt',
      move_path: undefined,
      chunks: [
        {
          old_lines: ['beta'],
          new_lines: ['BETA'],
          change_context: 'alpha',
          is_end_of_file: undefined,
        },
        {
          old_lines: ['delta'],
          new_lines: ['DELTA'],
          change_context: 'gamma',
          is_end_of_file: undefined,
        },
      ],
    });
  });

  test('rewritePatch groups a second update that depends on the first', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\ngamma\n');

    const rewrittenText = await rewritePatchText(
      root,
      `*** Begin Patch
*** Update File: sample.txt
@@
 alpha
-beta
+BETA
 gamma
*** Update File: sample.txt
@@
 alpha
-BETA
+BETA!
 gamma
*** End Patch`,
      DEFAULT_OPTIONS,
    );

    expect(parsePatch(rewrittenText).hunks).toEqual([
      {
        type: 'update',
        path: 'sample.txt',
        move_path: undefined,
        chunks: [
          {
            old_lines: ['beta'],
            new_lines: ['BETA!'],
            change_context: 'alpha',
            is_end_of_file: undefined,
          },
        ],
      },
    ]);

    const changes = await preparePatchChanges(
      root,
      rewrittenText,
      DEFAULT_OPTIONS,
    );
    await applyPreparedChanges(changes);
    expect(await readText(root, 'sample.txt')).toBe('alpha\nBETA!\ngamma\n');
  });

  test('rewritePatch collapses Add File + exact Update File into a self-contained add', async () => {
    const root = await createTempDir();

    const result = await rewritePatch(
      root,
      `*** Begin Patch
*** Add File: added.txt
+alpha
+beta
*** Update File: added.txt
@@
 alpha
-beta
+BETA
*** End Patch`,
      DEFAULT_OPTIONS,
    );

    expect(result.changed).toBeTrue();
    expect(result.rewriteModes).toContain('collapse:add-followed-by-update');
    expect(parsePatch(result.patchText).hunks).toEqual([
      {
        type: 'add',
        path: 'added.txt',
        contents: 'alpha\nBETA',
      },
    ]);
  });

  test('rewritePatch collapses Add File + Update File + Move to into a self-contained final add', async () => {
    const root = await createTempDir();

    const result = await rewritePatch(
      root,
      `*** Begin Patch
*** Add File: before.txt
+alpha
+beta
*** Update File: before.txt
*** Move to: nested/after.txt
@@
 alpha
-beta
+BETA
*** End Patch`,
      DEFAULT_OPTIONS,
    );

    expect(result.changed).toBeTrue();
    expect(result.rewriteModes).toContain('collapse:add-followed-by-update');
    expect(parsePatch(result.patchText).hunks).toEqual([
      {
        type: 'add',
        path: 'nested/after.txt',
        contents: 'alpha\nBETA',
      },
    ]);
  });

  test('rewritePatch collapses an exact move followed by an update on the destination', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'before.txt', 'alpha\nbeta\ngamma\n');

    const result = await rewritePatch(
      root,
      `*** Begin Patch
*** Update File: before.txt
*** Move to: nested/after.txt
@@
 alpha
-beta
+BETA
 gamma
*** Update File: nested/after.txt
@@
 alpha
 BETA
-gamma
+GAMMA
*** End Patch`,
      DEFAULT_OPTIONS,
    );

    expect(result.changed).toBeTrue();
    expect(result.rewriteModes).toContain('collapse:move-followed-by-update');
    expect(parsePatch(result.patchText).hunks).toEqual([
      {
        type: 'update',
        path: 'before.txt',
        move_path: 'nested/after.txt',
        chunks: [
          {
            old_lines: ['beta', 'gamma'],
            new_lines: ['BETA', 'GAMMA'],
            change_context: 'alpha',
            is_end_of_file: true,
          },
        ],
      },
    ]);
  });

  test('rewritePatch minimizes whole-file collapse when the fallback remains verifiable', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'before.txt', 'alpha\nbeta\ngamma\n');

    const result = await rewritePatch(
      root,
      `*** Begin Patch
*** Update File: before.txt
*** Move to: nested/after.txt
@@
 alpha
 beta
 gamma
*** Update File: nested/after.txt
@@
 alpha
-beta
+BETA
 gamma
*** End Patch`,
      DEFAULT_OPTIONS,
    );

    expect(result.changed).toBeTrue();
    expect(result.rewriteModes).toContain('collapse:move-followed-by-update');
    expect(parsePatch(result.patchText).hunks).toEqual([
      {
        type: 'update',
        path: 'before.txt',
        move_path: 'nested/after.txt',
        chunks: [
          {
            old_lines: ['beta'],
            new_lines: ['BETA'],
            change_context: 'alpha',
            is_end_of_file: undefined,
          },
        ],
      },
    ]);

    await applyPatch(root, result.patchText);
    expect(await readText(root, 'nested/after.txt')).toBe(
      'alpha\nBETA\ngamma\n',
    );
  });

  test('rewritePatch keeps the correct change order when grouping same-file updates', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'one\ntwo\nthree\nfour\nfive\n');

    const rewrittenText = await rewritePatchText(
      root,
      `*** Begin Patch
*** Update File: sample.txt
@@
 one
-two
+TWO
 three
*** Update File: sample.txt
@@
 three
-four
+FOUR
 five
*** End Patch`,
      DEFAULT_OPTIONS,
    );

    expect(parsePatch(rewrittenText).hunks[0]).toEqual({
      type: 'update',
      path: 'sample.txt',
      move_path: undefined,
      chunks: [
        {
          old_lines: ['two'],
          new_lines: ['TWO'],
          change_context: 'one',
          is_end_of_file: undefined,
        },
        {
          old_lines: ['four'],
          new_lines: ['FOUR'],
          change_context: 'three',
          is_end_of_file: undefined,
        },
      ],
    });

    await applyPatch(root, rewrittenText);
    expect(await readText(root, 'sample.txt')).toBe(
      'one\nTWO\nthree\nFOUR\nfive\n',
    );
  });

  test('preparePatchChanges fails when rescue is ambiguous', async () => {
    const root = await createTempDir();
    await writeFixture(
      root,
      'sample.txt',
      'left\nstale-one\nright\nseparator\nleft\nstale-two\nright\n',
    );

    await expect(
      preparePatchChanges(
        root,
        `*** Begin Patch
*** Update File: sample.txt
@@
 left
-old
+new
 right
*** End Patch`,
        DEFAULT_OPTIONS,
      ),
    ).rejects.toThrow('apply_patch verification failed:');
  });

  test('applyPreparedChanges reverts previous changes when a later apply fails', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'first.txt', 'one\n');
    await writeFixture(root, 'blocker', 'not-a-dir\n');
    await chmod(path.join(root, 'first.txt'), 0o755);

    await expect(
      applyPreparedChanges([
        {
          type: 'update',
          file: path.join(root, 'first.txt'),
          text: 'ONE\n',
        },
        {
          type: 'add',
          file: path.join(root, 'blocker', 'second.txt'),
          text: 'two\n',
        },
      ]),
    ).rejects.toThrow(
      'apply_patch internal error: Failed to apply prepared changes',
    );

    expect(await readText(root, 'first.txt')).toBe('one\n');
    expect((await stat(path.join(root, 'first.txt'))).mode & 0o777).toBe(0o755);
    expect(await readText(root, 'blocker')).toBe('not-a-dir\n');
    await expect(readText(root, 'blocker/second.txt')).rejects.toThrow();
  });

  test('applyPreparedChanges supports update with move_path and preserves the source mode', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'before.txt', 'alpha\nbeta\ngamma\n');
    await chmod(path.join(root, 'before.txt'), 0o755);

    const changes = await preparePatchChanges(
      root,
      `*** Begin Patch
*** Update File: before.txt
*** Move to: nested/after.txt
@@
 alpha
-beta
+BETA
 gamma
*** End Patch`,
      DEFAULT_OPTIONS,
    );
    await applyPreparedChanges(changes);

    expect(await readText(root, 'nested/after.txt')).toBe(
      'alpha\nBETA\ngamma\n',
    );
    expect((await stat(path.join(root, 'nested/after.txt'))).mode & 0o777).toBe(
      0o755,
    );
    await expect(readText(root, 'before.txt')).rejects.toThrow();
    expect(changes[0]).toMatchObject({
      type: 'update',
      file: path.join(root, 'before.txt'),
      move: path.join(root, 'nested/after.txt'),
    });
  });

  test('applyPreparedChanges rejects direct update on a missing source', async () => {
    const root = await createTempDir();
    const target = path.join(root, 'missing.txt');

    await expect(
      applyPreparedChanges([
        {
          type: 'update',
          file: target,
          text: 'fresh\n',
        },
      ]),
    ).rejects.toThrow(
      `apply_patch verification failed: Prepared update source does not exist: ${target}`,
    );
  });

  test('applyPreparedChanges rejects direct delete on a missing source', async () => {
    const root = await createTempDir();
    const target = path.join(root, 'missing.txt');

    await expect(
      applyPreparedChanges([
        {
          type: 'delete',
          file: target,
        },
      ]),
    ).rejects.toThrow(
      `apply_patch verification failed: Prepared delete source does not exist: ${target}`,
    );
  });

  test('applyPreparedChanges rejects direct move with a missing source', async () => {
    const root = await createTempDir();
    const source = path.join(root, 'missing.txt');
    const target = path.join(root, 'nested/after.txt');

    await expect(
      applyPreparedChanges([
        {
          type: 'update',
          file: source,
          move: target,
          text: 'fresh\n',
        },
      ]),
    ).rejects.toThrow(
      `apply_patch verification failed: Prepared move source does not exist: ${source}`,
    );
  });

  test('applyPreparedChanges rejects an invalid transition after a previous delete', async () => {
    const root = await createTempDir();
    const target = path.join(root, 'sample.txt');
    await writeFixture(root, 'sample.txt', 'alpha\n');

    await expect(
      applyPreparedChanges([
        {
          type: 'delete',
          file: target,
        },
        {
          type: 'update',
          file: target,
          text: 'omega\n',
        },
      ]),
    ).rejects.toThrow(
      `apply_patch verification failed: Prepared update source does not exist: ${target}`,
    );

    expect(await readText(root, 'sample.txt')).toBe('alpha\n');
  });

  test('applyPatch supports move + update when the block is stale', async () => {
    const root = await createTempDir();
    await writeFixture(
      root,
      'before.txt',
      'top\nprefix\nstale-value\nsuffix\nbottom\n',
    );

    await applyPatch(
      root,
      `*** Begin Patch
*** Update File: before.txt
*** Move to: nested/after.txt
@@ top
 prefix
-old-value
+new-value
 suffix
*** End Patch`,
    );

    expect(await readText(root, 'nested/after.txt')).toBe(
      'top\nprefix\nnew-value\nsuffix\nbottom\n',
    );
    await expect(readText(root, 'before.txt')).rejects.toThrow();
  });

  test('preparePatchChanges and applyPreparedChanges preserve CRLF with stale rescue + exact chunk', async () => {
    const root = await createTempDir();
    await writeFixture(
      root,
      'sample.txt',
      'top\r\nprefix\r\nstale-value\r\nsuffix\r\nkeep\r\ntail-old\r\n',
    );

    const changes = await preparePatchChanges(
      root,
      `*** Begin Patch
*** Update File: sample.txt
@@ top
 prefix
-old-value
+new-value
 suffix
@@ suffix
 keep
-tail-old
+tail-new
*** End Patch`,
      DEFAULT_OPTIONS,
    );
    await applyPreparedChanges(changes);

    expect(await readText(root, 'sample.txt')).toBe(
      'top\r\nprefix\r\nnew-value\r\nsuffix\r\nkeep\r\ntail-new\r\n',
    );
  });

  test('preparePatchChanges and applyPreparedChanges support pure insertion at EOF', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'top\nanchor\n');

    const changes = await preparePatchChanges(
      root,
      `*** Begin Patch
*** Update File: sample.txt
@@ anchor
+middle
*** End Patch`,
      DEFAULT_OPTIONS,
    );
    await applyPreparedChanges(changes);

    expect(await readText(root, 'sample.txt')).toBe('top\nanchor\nmiddle\n');
  });

  test('preparePatchChanges and applyPreparedChanges accumulate two Update File hunks on the same path', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\ngamma\n');

    const changes = await preparePatchChanges(
      root,
      `*** Begin Patch
*** Update File: sample.txt
@@
 alpha
-beta
+BETA
 gamma
*** Update File: sample.txt
@@
 alpha
 BETA
-gamma
+GAMMA
*** End Patch`,
      DEFAULT_OPTIONS,
    );

    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      type: 'update',
      file: path.join(root, 'sample.txt'),
      text: 'alpha\nBETA\ngamma\n',
    });
    expect(changes[1]).toMatchObject({
      type: 'update',
      file: path.join(root, 'sample.txt'),
      text: 'alpha\nBETA\nGAMMA\n',
    });

    await applyPreparedChanges(changes);

    expect(await readText(root, 'sample.txt')).toBe('alpha\nBETA\nGAMMA\n');
  });

  test('preparePatchChanges and applyPreparedChanges preserve a file without a final newline', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha\nbeta');

    const changes = await preparePatchChanges(
      root,
      `*** Begin Patch
*** Update File: sample.txt
@@
 alpha
-beta
+omega
*** End Patch`,
      DEFAULT_OPTIONS,
    );

    await applyPreparedChanges(changes);

    expect(await readText(root, 'sample.txt')).toBe('alpha\nomega');
  });

  test('applyPatch applies add + update in the same patch', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\n');

    await applyPatch(
      root,
      `*** Begin Patch
*** Add File: added.txt
+fresh
*** Update File: sample.txt
@@
 alpha
-beta
+BETA
*** End Patch`,
    );

    expect(await readText(root, 'added.txt')).toBe('fresh\n');
    expect(await readText(root, 'sample.txt')).toBe('alpha\nBETA\n');
  });

  test('applyPatch applies update + delete in the same patch', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\n');
    await writeFixture(root, 'obsolete.txt', 'legacy\n');

    await applyPatch(
      root,
      `*** Begin Patch
*** Update File: sample.txt
@@
 alpha
-beta
+BETA
*** Delete File: obsolete.txt
*** End Patch`,
    );

    expect(await readText(root, 'sample.txt')).toBe('alpha\nBETA\n');
    await expect(readText(root, 'obsolete.txt')).rejects.toThrow();
  });

  test('applyPatch applies move + add in the same patch', async () => {
    const root = await createTempDir();
    await writeFixture(root, 'before.txt', 'alpha\nbeta\n');

    await applyPatch(
      root,
      `*** Begin Patch
*** Update File: before.txt
*** Move to: nested/after.txt
@@
 alpha
-beta
+BETA
*** Add File: before.txt
+replacement
*** End Patch`,
    );

    expect(await readText(root, 'nested/after.txt')).toBe('alpha\nBETA\n');
    expect(await readText(root, 'before.txt')).toBe('replacement\n');
  });

  test('rewritePatchText blocks a patch when the path escapes through a symlink with a missing ancestor', async () => {
    const root = await createTempDir();
    const outside = await createTempDir();
    await writeFixture(root, 'before.txt', 'alpha\nbeta\n');
    await symlink(outside, path.join(root, 'linked-outside'));

    const patchText = `*** Begin Patch
*** Update File: before.txt
*** Move to: linked-outside/missing/child.txt
@@
 alpha
-beta
+BETA
*** End Patch`;

    await expect(
      rewritePatchText(root, patchText, DEFAULT_OPTIONS, root),
    ).rejects.toThrow(
      'apply_patch blocked: patch contains path outside workspace root:',
    );
  });

  test('rewritePatchText blocks the whole patch if any add/delete escapes root even when an update is rewritable', async () => {
    const root = await createTempDir();
    const outsideDir = await createTempDir();
    await writeFixture(root, 'sample.txt', 'prefix\nstale-value\nsuffix\n');
    await writeFixture(outsideDir, 'outside.txt', 'legacy\n');

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

    await expect(
      rewritePatchText(root, patchText, DEFAULT_OPTIONS, root),
    ).rejects.toThrow(
      'apply_patch blocked: patch contains path outside workspace root:',
    );
  });

  test('preparePatchChanges keeps an escaping relative path as blocked', async () => {
    const root = await createTempDir();

    const error = await preparePatchChanges(
      root,
      `*** Begin Patch
*** Add File: ../outside-added.txt
+fresh
*** End Patch`,
      DEFAULT_OPTIONS,
      root,
    ).catch((caughtError) => caughtError);

    expect(isApplyPatchBlockedError(error)).toBeTrue();
    expect(isApplyPatchValidationError(error)).toBeFalse();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'apply_patch blocked: patch contains path outside workspace root:',
    );
  });

  test('preparePatchChanges rejects a path that escapes through a symlink with a missing ancestor', async () => {
    const root = await createTempDir();
    const outside = await createTempDir();
    await mkdir(path.join(outside, 'real-target'), { recursive: true });
    await symlink(outside, path.join(root, 'linked-outside'));

    await expect(
      preparePatchChanges(
        root,
        `*** Begin Patch
*** Add File: linked-outside/missing/child.txt
+fresh
*** End Patch`,
        DEFAULT_OPTIONS,
        root,
      ),
    ).rejects.toThrow(
      'apply_patch blocked: patch contains path outside workspace root:',
    );
  });
});
