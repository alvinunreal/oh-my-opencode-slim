import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parsePatch } from './codec';
import { createApplyPatchHook } from './index';
import { applyPreparedChanges, preparePatchChanges } from './operations';
import { createTempDir, DEFAULT_OPTIONS, writeFixture } from './test-helpers';

function createHook() {
  return createApplyPatchHook({
    client: {} as never,
    directory: '/tmp/hook-root',
    worktree: '/tmp/hook-root',
  } as never);
}

describe('apply-patch/hook', () => {
  test('ignora tools distintos de apply_patch', async () => {
    const hook = createHook();
    const patchText = '*** Begin Patch\n*** End Patch';
    const output = { args: { patchText } };

    await hook['tool.execute.before']({ tool: 'read' }, output);

    expect(output.args.patchText).toBe(patchText);
  });

  test('bloquea un patch no rescatable como verification antes del nativo', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\ngamma\n');
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
-missing
+omega
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before'](
        { tool: 'apply_patch', directory: root },
        output,
      ),
    ).rejects.toThrow(
      'apply_patch verification failed: Failed to find expected lines',
    );

    expect(output.args.patchText).toBe(patchText);
  });

  test('normaliza un patch exacto envuelto en heredoc antes del nativo', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(
      root,
      'sample.txt',
      'line-01\nexact-top\nexact-old\nexact-bottom\nline-05\n',
    );
    const hook = createHook();
    const cleanPatchText = `*** Begin Patch
*** Update File: sample.txt
@@ exact-top
-exact-old
+exact-new
 exact-bottom
*** End Patch`;
    const output = {
      args: {
        patchText: `cat <<'PATCH'
${cleanPatchText}
PATCH`,
      },
    };

    await hook['tool.execute.before'](
      { tool: 'apply_patch', directory: root },
      output,
    );

    expect(output.args.patchText).toBe(cleanPatchText);

    const changes = await preparePatchChanges(
      root,
      output.args.patchText as string,
      DEFAULT_OPTIONS,
    );
    await applyPreparedChanges(changes);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf-8')).toBe(
      'line-01\nexact-top\nexact-new\nexact-bottom\nline-05\n',
    );
  });

  test('reescribe stale patch de prefijo y sigue siendo aplicable', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(
      root,
      'sample.txt',
      'top\nA\nB-stale\nC\nD\nE\nbottom\n',
    );
    const hook = createHook();
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
    const output = { args: { patchText } };

    await hook['tool.execute.before'](
      { tool: 'apply_patch', directory: root },
      output,
    );

    const rewritten = parsePatch(output.args.patchText as string).hunks[0];
    expect(rewritten.type).toBe('update');
    expect(
      rewritten.type === 'update' && rewritten.chunks[0]?.old_lines,
    ).toEqual(['A', 'B-stale', 'C', 'D', 'E']);

    const changes = await preparePatchChanges(
      root,
      output.args.patchText as string,
      DEFAULT_OPTIONS,
    );
    await applyPreparedChanges(changes);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf-8')).toBe(
      'top\nA\nB\nC\nD\nX\nbottom\n',
    );
  });

  test('no altera new_lines durante la reescritura', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(
      root,
      'sample.txt',
      'top\nprefix\nstale-value\nsuffix\nbottom\n',
    );
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@ top
 prefix
-old-value
+ \tverbatim  ""  Ω  
 suffix
*** End Patch`;
    const expected = parsePatch(patchText).hunks[0];
    const output = { args: { patchText } };

    await hook['tool.execute.before'](
      { tool: 'apply_patch', directory: root },
      output,
    );

    const rewritten = parsePatch(output.args.patchText as string).hunks[0];
    expect(expected.type).toBe('update');
    expect(rewritten.type).toBe('update');
    expect(
      expected.type === 'update' && rewritten.type === 'update'
        ? rewritten.chunks[0]?.new_lines
        : undefined,
    ).toEqual(expected.type === 'update' ? expected.chunks[0]?.new_lines : []);
  });

  test('reescribe stale unicode-only y sigue siendo aplicable', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'const title = “Hola”;\n');
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
-const title = "Hola";
+const title = "Hola mundo";
*** End Patch`;
    const output = { args: { patchText } };

    await hook['tool.execute.before'](
      { tool: 'apply_patch', directory: root },
      output,
    );

    const rewritten = parsePatch(output.args.patchText as string).hunks[0];
    expect(rewritten.type).toBe('update');
    expect(
      rewritten.type === 'update' ? rewritten.chunks[0]?.old_lines : undefined,
    ).toEqual(['const title = “Hola”;']);

    const changes = await preparePatchChanges(
      root,
      output.args.patchText as string,
      DEFAULT_OPTIONS,
    );
    await applyPreparedChanges(changes);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf-8')).toBe(
      'const title = "Hola mundo";\n',
    );
  });

  test('reescribe stale trim-end y sigue siendo aplicable', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'alpha  \n');
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
-alpha
+omega
*** End Patch`;
    const output = { args: { patchText } };

    await hook['tool.execute.before'](
      { tool: 'apply_patch', directory: root },
      output,
    );

    const rewritten = parsePatch(output.args.patchText as string).hunks[0];
    expect(rewritten.type).toBe('update');
    expect(
      rewritten.type === 'update' ? rewritten.chunks[0]?.old_lines : undefined,
    ).toEqual(['alpha  ']);

    const changes = await preparePatchChanges(
      root,
      output.args.patchText as string,
      DEFAULT_OPTIONS,
    );
    await applyPreparedChanges(changes);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf-8')).toBe(
      'omega\n',
    );
  });

  test('bloquea un stale trim-only como verification', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', '  alpha  \n');
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
-alpha
+omega
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before'](
        { tool: 'apply_patch', directory: root },
        output,
      ),
    ).rejects.toThrow(
      'apply_patch verification failed: Failed to find expected lines',
    );

    expect(output.args.patchText).toBe(patchText);
  });

  test('bloquea en runtime un @@ mal formado antes del nativo', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\n');
    const hook = createHook();
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
      hook['tool.execute.before'](
        { tool: 'apply_patch', directory: root },
        output,
      ),
    ).rejects.toThrow(
      'apply_patch validation failed: Invalid patch format: unexpected line in patch chunk: garbage',
    );

    expect(output.args.patchText).toBe(patchText);
  });

  test('bloquea en runtime un Add File mal formado antes del nativo', async () => {
    const root = await createTempDir('apply-patch-hook-');
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Add File: added.txt
+fresh
garbage
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before'](
        { tool: 'apply_patch', directory: root },
        output,
      ),
    ).rejects.toThrow(
      'apply_patch validation failed: Invalid patch format: unexpected line in Add File body: garbage',
    );

    expect(output.args.patchText).toBe(patchText);
  });

  test('bloquea errores internos del guard antes del nativo', async () => {
    const root = await createTempDir('apply-patch-hook-');
    const lockedDir = path.join(root, 'locked');
    await mkdir(lockedDir, { recursive: true });
    await chmod(lockedDir, 0o000);
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Add File: locked/child.txt
+fresh
*** End Patch`;
    const output = { args: { patchText } };

    try {
      await expect(
        hook['tool.execute.before'](
          { tool: 'apply_patch', directory: root },
          output,
        ),
      ).rejects.toThrow('apply_patch internal error:');

      expect(output.args.patchText).toBe(patchText);
    } finally {
      await chmod(lockedDir, 0o755);
    }
  });

  test('bloquea un caso indentado peligroso como verification', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(
      root,
      'sample.yml',
      'root:\n  child:\n    enabled: false\nnext: true\n',
    );
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.yml
@@
-enabled: false
+enabled: true
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before'](
        { tool: 'apply_patch', directory: root },
        output,
      ),
    ).rejects.toThrow(
      'apply_patch verification failed: Failed to find expected lines',
    );

    expect(output.args.patchText).toBe(patchText);
  });

  test('reescribe inserción anclada para evitar EOF del nativo', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(
      root,
      'sample.txt',
      'top\nanchor-insert\nafter-anchor\nend\n',
    );
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@ anchor-insert
+middle-inserted
*** End Patch`;
    const output = { args: { patchText } };

    await hook['tool.execute.before'](
      { tool: 'apply_patch', directory: root },
      output,
    );

    const changes = await preparePatchChanges(
      root,
      output.args.patchText as string,
      DEFAULT_OPTIONS,
    );
    await applyPreparedChanges(changes);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf-8')).toBe(
      'top\nanchor-insert\nmiddle-inserted\nafter-anchor\nend\n',
    );
  });

  test('bloquea una inserción pura si falta el anchor', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'top\nafter-anchor\nend\n');
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@ anchor-insert
+middle-inserted
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before'](
        { tool: 'apply_patch', directory: root },
        output,
      ),
    ).rejects.toThrow(
      'apply_patch verification failed: Failed to find insertion anchor',
    );

    expect(output.args.patchText).toBe(patchText);
  });

  test('bloquea una inserción pura si el anchor es ambiguo', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(
      root,
      'sample.txt',
      'top\nanchor-insert\nafter-first\nsplit\nanchor-insert\nafter-second\nend\n',
    );
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@ anchor-insert
+middle-inserted
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before'](
        { tool: 'apply_patch', directory: root },
        output,
      ),
    ).rejects.toThrow(
      'apply_patch verification failed: Insertion anchor was ambiguous',
    );

    expect(output.args.patchText).toBe(patchText);
  });

  test('bloquea ambigüedad real del patch antes del nativo', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(
      root,
      'sample.txt',
      'left\nstale-one\nright\nseparator\nleft\nstale-two\nright\n',
    );
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
 left
-old
+new
 right
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before'](
        { tool: 'apply_patch', directory: root },
        output,
      ),
    ).rejects.toThrow('apply_patch verification failed:');

    expect(output.args.patchText).toBe(patchText);
  });

  test('reescribe solo el hunk update en un patch con add + update', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(
      root,
      'sample.txt',
      'top\nprefix\nstale-value\nsuffix\n',
    );
    const hook = createHook();
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

    await hook['tool.execute.before'](
      { tool: 'apply_patch', directory: root },
      output,
    );

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

    const changes = await preparePatchChanges(
      root,
      output.args.patchText as string,
      DEFAULT_OPTIONS,
    );
    await applyPreparedChanges(changes);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf-8')).toBe(
      'top\nprefix\nnew-value\nsuffix\n',
    );
    expect(await readFile(path.join(root, 'added.txt'), 'utf-8')).toBe(
      'fresh\n',
    );
  });

  test('aborta temprano si el patch solo apunta fuera del root/worktree', async () => {
    const root = await createTempDir('apply-patch-hook-');
    const outside = path.join(path.dirname(root), 'outside.txt');
    await writeFile(outside, 'outside\n', 'utf-8');
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: ../outside.txt
@@
-outside
+changed
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before'](
        { tool: 'apply_patch', directory: root },
        output,
      ),
    ).rejects.toThrow(
      `apply_patch blocked: patch contains path outside workspace root: ${outside}`,
    );

    expect(output.args.patchText).toBe(patchText);
    expect(await readFile(outside, 'utf-8')).toBe('outside\n');
  });

  test('aborta temprano y no aplica nada si un patch mixto tiene rutas fuera', async () => {
    const root = await createTempDir('apply-patch-hook-');
    const outsideDir = await createTempDir('apply-patch-hook-outside-');
    await writeFixture(root, 'sample.txt', 'prefix\nstale-value\nsuffix\n');
    await writeFixture(outsideDir, 'outside.txt', 'legacy\n');
    const hook = createHook();
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
      hook['tool.execute.before'](
        { tool: 'apply_patch', directory: root },
        output,
      ),
    ).rejects.toThrow(
      `apply_patch blocked: patch contains path outside workspace root: ${outsideAdded}`,
    );

    expect(output.args.patchText).toBe(patchText);
    expect(await readFile(path.join(root, 'sample.txt'), 'utf-8')).toBe(
      'prefix\nstale-value\nsuffix\n',
    );
    expect(await stat(outsideAdded).catch(() => null)).toBeNull();
    expect(await readFile(path.join(outsideDir, 'outside.txt'), 'utf-8')).toBe(
      'legacy\n',
    );
  });

  test('mantiene el comportamiento normal para patches íntegramente dentro', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\n');
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
-alpha
+omega
 beta
*** End Patch`;
    const output = { args: { patchText } };

    await expect(
      hook['tool.execute.before'](
        { tool: 'apply_patch', directory: root },
        output,
      ),
    ).resolves.toBeUndefined();

    expect(output.args.patchText).toBe(patchText);
  });

  test('no expone hook tool.execute.after', () => {
    const hook = createHook() as Record<string, unknown>;

    expect(hook['tool.execute.after']).toBeUndefined();
  });

  test('no altera un patch exacto', async () => {
    const root = await createTempDir('apply-patch-hook-');
    await writeFixture(root, 'sample.txt', 'alpha\nbeta\n');
    const hook = createHook();
    const patchText = `*** Begin Patch
*** Update File: sample.txt
@@
-alpha
+omega
 beta
*** End Patch`;
    const output = { args: { patchText } };

    await hook['tool.execute.before'](
      { tool: 'apply_patch', directory: root },
      output,
    );

    expect(output.args.patchText).toBe(patchText);
  });
});
