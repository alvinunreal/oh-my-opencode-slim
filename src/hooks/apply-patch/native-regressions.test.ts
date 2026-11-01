import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import { parsePatch } from './codec';
import { stageAddedText } from './execution-context';
import { nativeDeriveUpdate } from './native-update';
import {
  applyPatch,
  createTempDir,
  readText,
  rewritePatchText,
  writeFixture,
} from './test-helpers';

const patch = (...body: string[]) =>
  ['*** Begin Patch', ...body, '*** End Patch'].join('\n');

function nativeOutcome(
  root: string,
  files: Record<string, string>,
  text: string,
) {
  const state = new Map(Object.entries(files));
  const prepared = parsePatch(text).hunks.map((hunk) => {
    const source = path.normalize(hunk.path);
    if (hunk.type === 'add') {
      return { type: 'add', source, text: stageAddedText(hunk.contents) };
    }
    if (hunk.type === 'delete') {
      if (!state.has(source))
        throw new Error(`Native delete missing: ${source}`);
      return { type: 'delete', source };
    }
    const original = state.get(source);
    if (original === undefined)
      throw new Error(`Native update missing: ${source}`);
    return {
      type: 'update',
      source,
      destination: hunk.move_path && path.normalize(hunk.move_path),
      text: nativeDeriveUpdate(path.join(root, source), original, hunk.chunks),
    };
  });
  for (const step of prepared) {
    if (step.type === 'delete') state.delete(step.source);
    else {
      state.set(step.destination ?? step.source, step.text as string);
      if (step.destination) state.delete(step.source);
    }
  }
  return Object.fromEntries(state);
}

type Files = Record<string, string>;
type Expected = Record<string, string | null>;
type Accepted = [string, Files, string, Expected, Files?];
type Blocked = [string, Files, string, string];

const accepted: Accepted[] = [
  [
    'T4 unanchored append',
    { 'a.txt': 'a\nb\n' },
    patch('*** Update File: a.txt', '@@', '+Z'),
    { 'a.txt': 'a\nb\nZ\n' },
  ],
  [
    'T5 blank lines between hunks',
    { 'a.txt': 'a\n', 'b.txt': 'b\n', 'd.txt': 'd\n' },
    patch(
      '*** Add File: n.txt',
      '+n',
      '',
      '*** Delete File: d.txt',
      '',
      '*** Update File: a.txt',
      '',
      '@@',
      '-a',
      '+A',
      '',
      '*** Update File: b.txt',
      '@@',
      '-b',
      '+B',
    ),
    { 'a.txt': 'A\n', 'b.txt': 'B\n', 'd.txt': null, 'n.txt': 'n\n' },
  ],
  [
    'T5b blank line before End Patch',
    { 'a.txt': 'a\n' },
    patch('*** Update File: a.txt', '@@', '-a', '+A', ''),
    { 'a.txt': 'A\n' },
  ],
  [
    'T6 fence outside markers',
    { 'a.txt': 'a\n' },
    `${patch('*** Update File: a.txt', '@@', '-a', '+A')}\n\`\`\``,
    { 'a.txt': 'A\n' },
  ],
  [
    'T6b fence around markers',
    { 'a.txt': 'a\n' },
    `\`\`\`patch\n${patch('*** Update File: a.txt', '@@', '-a', '+A')}\n\`\`\``,
    { 'a.txt': 'A\n' },
  ],
  [
    'T7 rename without chunks',
    { 'a.txt': 'a\n' },
    patch('*** Update File: a.txt', '*** Move to: b.txt'),
    { 'a.txt': null, 'b.txt': 'a\n' },
  ],
  [
    'T8 unified-diff header as absent context',
    { 'a.txt': 'a\nb\nc\n' },
    patch('*** Update File: a.txt', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'),
    { 'a.txt': 'a\nB\nc\n' },
  ],
  [
    'T8b stale @@ context',
    { 'a.txt': 'def f(x):\n    return x\n' },
    patch(
      '*** Update File: a.txt',
      '@@ def f(x, y):',
      '-    return x',
      '+    return x + 1',
    ),
    { 'a.txt': 'def f(x):\n    return x + 1\n' },
  ],
  [
    'T9 @@ context consumed by prior chunk',
    { 'a.txt': 'L0\nL1\nL2\nL3\nL4\nL5\n' },
    patch(
      '*** Update File: a.txt',
      '@@',
      ' L1',
      '-L2',
      '+X',
      ' L3',
      '@@ L3',
      '-L4',
      '+Y',
    ),
    { 'a.txt': 'L0\nL1\nX\nL3\nY\nL5\n' },
  ],
  [
    'T11 folded EOF chunks keep final marker',
    { 'a.txt': 'a\nb\nc\n' },
    patch(
      '*** Update File: a.txt',
      '@@',
      '-c',
      '+C',
      '*** End of File',
      '*** Update File: a.txt',
      '@@',
      '+Z',
      '*** End of File',
    ),
    { 'a.txt': 'a\nb\nC\nZ\n' },
  ],
  [
    'P0-4 folded middle insertion retains native old lines',
    { 'a.txt': 'a\nc\n' },
    patch(
      '*** Update File: a.txt',
      '@@ a',
      '+X',
      '*** Update File: a.txt',
      '*** Move to: b.txt',
      '@@',
      ' a',
    ),
    { 'a.txt': null, 'b.txt': 'a\nX\nc\n' },
  ],
  [
    'T12 retry without final empty context',
    { 'a.txt': 'a\nb\n' },
    patch('*** Update File: a.txt', '@@', ' a', '-b', '+B', ' '),
    { 'a.txt': 'a\nB\n' },
  ],
  [
    'T13 trim precedes unicode',
    { 'a.txt': 'x\n“k”\ny\n  "k"\ny\n' },
    patch('*** Update File: a.txt', '@@ "k"', '-y', '+Y'),
    { 'a.txt': 'x\n“k”\ny\n  "k"\nY\n' },
  ],
  [
    'T14 Add with final empty line',
    {},
    patch('*** Add File: n.txt', '+a', '+'),
    { 'n.txt': 'a\n' },
  ],
  [
    'T14b Add with only empty line',
    {},
    patch('*** Add File: n.txt', '+'),
    { 'n.txt': '' },
  ],
  [
    'T15 missing @@ on EOF insertion removed',
    { 'a.txt': 'a\n' },
    patch('*** Update File: a.txt', '@@ nope', '+Z', '*** End of File'),
    { 'a.txt': 'a\nZ\n' },
  ],
  [
    'T17 second update uses new @@ anchor',
    { 'a.txt': 'L0\nL1\nL2\n' },
    patch(
      '*** Update File: a.txt',
      '@@ L1',
      '+N',
      '*** Update File: a.txt',
      '@@ N',
      '-L2',
      '+M',
    ),
    { 'a.txt': 'L0\nL1\nN\nM\n' },
  ],
  [
    'U1 fuzzy whitespace edge preserves bytes',
    { 'a.txt': 'foo  \nold\nbar\n' },
    patch('*** Update File: a.txt', '@@', ' foo', '-stale', '+new', ' bar'),
    { 'a.txt': 'foo  \nnew\nbar\n' },
  ],
  [
    'U2 fuzzy unicode edge preserves bytes',
    { 'a.py': 'msg = “hi”\nold()\nend()\n' },
    patch(
      '*** Update File: a.py',
      '@@',
      ' msg = "hi"',
      '-stale()',
      '+new()',
      ' end()',
    ),
    { 'a.py': 'msg = “hi”\nnew()\nend()\n' },
  ],
  [
    'N4 EOF insertion preserves interior and final blanks',
    { 'a.txt': 'a\n\nb\n\n' },
    patch('*** Update File: a.txt', '@@', '+X', '*** End of File'),
    { 'a.txt': 'a\n\nb\nX\n' },
  ],
  [
    'N10 stacked @@ context matches native',
    {
      'a.py':
        'class A:\n    def m(self):\n        return 1\nclass B:\n    def m(self):\n        return 1\n',
      'b.txt': 'x\ny  \nz\n',
    },
    patch(
      '*** Update File: a.py',
      '@@ class B:',
      '@@     def m(self):',
      '-        return 1',
      '+        return 2',
      '*** Update File: b.txt',
      '@@',
      ' x',
      '-y',
      '+Y',
      ' z',
    ),
    {
      'a.py':
        'class A:\n    def m(self):\n        return 1\nclass B:\n    def m(self):\n        return 2\n',
      'b.txt': 'x\nY\nz\n',
    },
  ],
  [
    'F1 EOF append keeps a blank-ended file native-exact',
    { 'a.txt': 'a\n\n' },
    patch('*** Update File: a.txt', '@@', '+b', '+', '*** End of File'),
    { 'a.txt': 'a\nb\n\n' },
  ],
  [
    'F1b native writer drops one final blank line',
    { 'a.txt': 'x\n\n' },
    patch('*** Update File: a.txt', '@@', '-x', '+X'),
    { 'a.txt': 'X\n\n' },
    { 'a.txt': 'X\n' },
  ],
  [
    'F1c level 1 tolerates only one final blank',
    { 'a.txt': 'a\n\n' },
    patch(
      '*** Update File: a.txt',
      '@@',
      ' a',
      '-',
      '*** Update File: a.txt',
      '@@',
      '+b',
    ),
    { 'a.txt': 'a\nb\n' },
  ],
  [
    'F2 native cursor advances past context and hits',
    { 'a.txt': 'x\nx\nx\n' },
    patch('*** Update File: a.txt', '@@ x', '-x', '+X', '@@', '-x', '+Y'),
    { 'a.txt': 'x\nX\nY\n' },
  ],
  [
    'N1 CRLF two updates compare native modulo EOL',
    { 'a.txt': 'a\r\nb\r\nc\r\nd\r\n' },
    patch(
      '*** Update File: a.txt',
      '@@',
      '-a',
      '+A',
      '*** Update File: a.txt',
      '@@',
      '-d',
      '+D',
    ),
    { 'a.txt': 'A\r\nb\r\nc\r\nD\r\n' },
    { 'a.txt': 'A\nb\r\nc\r\nD\n' },
  ],
  [
    'T1 repeated closing brace EOF',
    {
      'a.ts':
        'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n',
    },
    patch(
      '*** Update File: a.ts',
      '@@',
      ' }',
      '+',
      '+export { a, b };',
      '*** End of File',
    ),
    {
      'a.ts':
        'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n\nexport { a, b };\n',
    },
  ],
  [
    'N6 mid-chunk empty line is canonicalized',
    { 'a.py': 'def foo():\n    x = 1\n    y = 2\n\n    return x\n' },
    patch(
      '*** Update File: a.py',
      '@@ def foo():',
      '     x = 1',
      '-    y = 2',
      '+    y = 3',
      '',
      '     return x',
    ),
    { 'a.py': 'def foo():\n    x = 1\n    y = 3\n\n    return x\n' },
  ],
];

const blocked: Blocked[] = [
  [
    'T10 unbounded prefix/suffix deletion',
    { 'a.txt': 'start\nold\nx1\nx2\nx3\nx4\nx5\nx6\nx7\nx8\nend\n' },
    patch('*** Update File: a.txt', '@@', ' start', '-stale', '+new', ' end'),
    'patch verification failed:',
  ],
  [
    'T16 Add followed by Delete',
    {},
    patch('*** Add File: n.txt', '+a', '*** Delete File: n.txt'),
    'patch verification failed:',
  ],
  [
    'N8 indented @@ would edit wrong native occurrence',
    {
      'a.py':
        'class A:\n    def run(self):\n        return 1\ndef run(self):\n    return 1\n',
    },
    patch(
      '*** Update File: a.py',
      '@@     def run(self):',
      '-        return 1',
      '+        return 2',
    ),
    'Native patch tool would not reproduce',
  ],
  [
    'Pa missing @@ insertion anchor fails closed',
    { 'a.txt': 'a\n' },
    patch('*** Update File: a.txt', '@@ nope', '+X'),
    'Failed to find insertion anchor',
  ],
  [
    'Pb stale @@ with duplicate old lines fails closed',
    { 'a.py': 'def f(x):\n    return x\n\ndef g(x):\n    return x\n' },
    patch(
      '*** Update File: a.py',
      '@@ def g_new(x):',
      '-    return x',
      '+    return x + 1',
    ),
    'Failed to find context',
  ],
];

describe('apply-patch/native regressions', () => {
  test.each(accepted)('%s', async (...row: Accepted) => {
    const [, files, input, expected, nativeExpected] = row;
    const root = await createTempDir();
    for (const [file, text] of Object.entries(files))
      await writeFixture(root, file, text);
    const rewritten = await rewritePatchText(root, input);
    const existing = Object.fromEntries(
      Object.entries(expected).filter(([, text]) => text !== null),
    ) as Files;
    expect(nativeOutcome(root, files, rewritten)).toEqual(
      nativeExpected ?? existing,
    );
    await applyPatch(root, rewritten);
    for (const [file, text] of Object.entries(expected)) {
      if (text === null) await expect(readText(root, file)).rejects.toThrow();
      else expect(await readText(root, file)).toBe(text);
    }
  });

  test.each(blocked)('%s is blocked', async (_name, files, input, error) => {
    const root = await createTempDir();
    for (const [file, text] of Object.entries(files))
      await writeFixture(root, file, text);
    await expect(rewritePatchText(root, input)).rejects.toThrow(error);
  });
});
