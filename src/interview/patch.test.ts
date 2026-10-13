import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  extractSpecOutline,
  InterviewPatchRequiredError,
  markInterviewDocumentComplete,
  markInterviewDocumentIncomplete,
  rewriteInterviewDocument,
} from './document';
import firstTurn from './fixtures/first-applied-turn.json';
import { applyUnifiedDiff, InterviewPatchApplyError } from './patch';
import type { InterviewRecord } from './types';

const SOURCE = [
  '# Introduction',
  '',
  'alpha',
  '',
  '## 1. Purpose & Scope',
  '',
  'keep',
].join('\n');

describe('applyUnifiedDiff', () => {
  test('applies an insertion at the hinted old zero-count position', () => {
    const applied = applyUnifiedDiff('a\nb', '@@ -1,0 +2,1 @@\n+x');
    expect(applied).toEqual({ ok: true, text: 'a\nx\nb' });
  });

  test('adjusts later hunk hints after an earlier line-count change', () => {
    const patch = [
      '@@ -1,1 +1,2 @@',
      '-a',
      '+a',
      '+inserted',
      '@@ -2,1 +3,1 @@',
      '-b',
      '+changed',
    ].join('\n');
    const applied = applyUnifiedDiff('a\nb\nc', patch);
    expect(applied).toEqual({ ok: true, text: 'a\ninserted\nchanged\nc' });
  });
  test('replaces a matching line and keeps the surrounding spec', () => {
    const patch = [
      '--- a/spec',
      '+++ b/spec',
      '@@ -1,7 +1,7 @@',
      ' # Introduction',
      ' ',
      '-alpha',
      '+beta',
      ' ',
      ' ## 1. Purpose & Scope',
      ' ',
      ' keep',
    ].join('\n');

    const applied = applyUnifiedDiff(SOURCE, patch);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.text).toContain('beta');
      expect(applied.text).not.toContain('alpha');
      expect(applied.text).toContain('## 1. Purpose & Scope');
    }
  });

  test('returns the failed hunk when context is missing', () => {
    const patch = ['@@ -1,3 +1,3 @@', ' missing', '-nope', '+yep'].join('\n');
    const applied = applyUnifiedDiff(SOURCE, patch);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.failedHunk).toContain('-nope');
    }
  });

  test('rejects a payload that is not a unified diff', () => {
    const applied = applyUnifiedDiff(SOURCE, 'just the whole spec again');
    expect(applied.ok).toBe(false);
  });

  test('rejects a trailing header-only hunk without changing the source', () => {
    const patch = ['@@ -1,1 +1,1 @@', '-a', '+changed', '@@ -3,1 +3,1 @@'].join(
      '\n',
    );
    const applied = applyUnifiedDiff('a\nb\nc', patch);
    expect(applied.ok).toBe(false);
  });
});

describe('rewriteInterviewDocument', () => {
  test('uses the kickoff summary when the empty patch targets the placeholder', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'interview-patch-empty-kickoff-'),
    );
    const record: InterviewRecord = {
      id: 'interview-empty-kickoff',
      sessionID: 'session-empty-kickoff',
      idea: 'Empty kickoff',
      markdownPath: path.join(directory, 'spec.md'),
      baseMessageCount: 0,
      status: 'active',
      completed: false,
    };

    await rewriteInterviewDocument(record, '', 'empty-kickoff');
    const next = await rewriteInterviewDocument(
      record,
      'Full kickoff specification',
      'empty-kickoff',
      '',
    );

    expect(next).toContain('Full kickoff specification');
    expect(next).not.toContain('Waiting for interview answers.');
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('applies a patch onto the current spec and leaves Q&A history alone', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'interview-patch-'),
    );
    const record: InterviewRecord = {
      id: 'interview-1',
      sessionID: 'session-1',
      idea: 'Patch idea',
      markdownPath: path.join(directory, 'spec.md'),
      createdAt: new Date().toISOString(),
      status: 'active',
      baseMessageCount: 0,
    };

    await rewriteInterviewDocument(record, SOURCE, 'patch-idea');
    const patched = await rewriteInterviewDocument(
      record,
      'Updated the introduction.',
      undefined,
      ['@@ -3,1 +3,1 @@', '-alpha', '+beta'].join('\n'),
    );

    expect(patched).toContain('beta');
    expect(patched).not.toContain('\nalpha\n');
    expect(patched).toContain('## Q&A history');
    expect(patched).not.toContain('Updated the introduction.');
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('does not write a short status when the patch fails', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'interview-patch-'),
    );
    const record: InterviewRecord = {
      id: 'interview-2',
      sessionID: 'session-2',
      idea: 'Patch idea',
      markdownPath: path.join(directory, 'spec.md'),
      createdAt: new Date().toISOString(),
      status: 'active',
      baseMessageCount: 0,
    };
    await rewriteInterviewDocument(record, SOURCE);

    await expect(
      rewriteInterviewDocument(
        record,
        'status only',
        undefined,
        '@@ -1,1 +1,1 @@\n-missing\n+nope',
      ),
    ).rejects.toBeInstanceOf(InterviewPatchApplyError);

    const saved = await fs.readFile(record.markdownPath, 'utf8');
    expect(saved).toContain('alpha');
    expect(saved).not.toContain('status only');
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('requires a patch after the initial spec has been written', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'interview-patch-'),
    );
    const record: InterviewRecord = {
      id: 'interview-required-patch',
      sessionID: 'session-required-patch',
      idea: 'Patch idea',
      markdownPath: path.join(directory, 'spec.md'),
      createdAt: new Date().toISOString(),
      status: 'active',
      baseMessageCount: 0,
    };
    await rewriteInterviewDocument(record, SOURCE);

    await expect(
      rewriteInterviewDocument(record, 'status only'),
    ).rejects.toBeInstanceOf(InterviewPatchRequiredError);
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('keeps the current spec when patch is explicitly empty', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'interview-patch-'),
    );
    const record: InterviewRecord = {
      id: 'interview-3',
      sessionID: 'session-3',
      idea: 'Patch idea',
      markdownPath: path.join(directory, 'spec.md'),
      createdAt: new Date().toISOString(),
      status: 'active',
      baseMessageCount: 0,
    };
    await rewriteInterviewDocument(record, SOURCE);
    const next = await rewriteInterviewDocument(
      record,
      'No spec change.',
      undefined,
      '',
    );
    expect(next).toContain('alpha');
    expect(next).not.toContain('No spec change.');
    expect(extractSpecOutline(SOURCE)).toContain('## 1. Purpose & Scope');
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('leaves the body unchanged when a trailing hunk is cut off', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'interview-patch-cutoff-'),
    );
    const record: InterviewRecord = {
      id: 'interview-cutoff',
      sessionID: 'session-cutoff',
      idea: 'Cutoff idea',
      markdownPath: path.join(directory, 'spec.md'),
      createdAt: new Date().toISOString(),
      status: 'active',
      baseMessageCount: 0,
    };
    await rewriteInterviewDocument(record, SOURCE);
    await expect(
      rewriteInterviewDocument(
        record,
        'ignored',
        undefined,
        '@@ -3,1 +3,1 @@\n-alpha\n+beta\n@@ -7,1 +7,1 @@',
      ),
    ).rejects.toBeInstanceOf(InterviewPatchApplyError);
    expect(await fs.readFile(record.markdownPath, 'utf8')).toContain('alpha');
    await fs.rm(directory, { recursive: true, force: true });
  });
});

describe('document status updates', () => {
  test('preserves custom frontmatter and body when completing and reopening', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'interview-document-status-'),
    );
    const record: InterviewRecord = {
      id: 'status-preservation',
      sessionID: 'owner-session',
      idea: 'Status idea',
      markdownPath: path.join(directory, 'spec.md'),
      createdAt: new Date().toISOString(),
      status: 'active',
      baseMessageCount: 0,
    };
    const frontmatter = [
      '---',
      'title: Custom title',
      'owner: custom-owner',
      'tags: [one, two]',
      'date_created: 2026-10-07',
      'status: active',
      'custom: preserved',
      '---',
    ].join('\n');
    const body = '\n# Custom body\n\nDo not rewrite this.\n';
    await fs.writeFile(record.markdownPath, frontmatter + body, 'utf8');

    const complete = await markInterviewDocumentComplete(record);
    expect(complete).toBe(
      frontmatter.replace('status: active', 'status: complete') + body,
    );
    const incomplete = await markInterviewDocumentIncomplete(record);
    expect(incomplete).toBe(frontmatter.replace('status: active\n', '') + body);
    expect(incomplete).not.toContain('status:');

    await fs.writeFile(
      record.markdownPath,
      frontmatter.replace('status: active\n', '') + body,
      'utf8',
    );
    const added = await markInterviewDocumentComplete(record);
    expect(added).toBe(
      frontmatter
        .replace('status: active\n', '')
        .replace('\n---', '\nstatus: complete\n---') + body,
    );
    await fs.rm(directory, { recursive: true, force: true });
  });
});

describe('already applied hunks', () => {
  test('does not let a later hunk apply above an earlier hunk', () => {
    const patch = [
      '@@ -3,1 +3,1 @@',
      '-a',
      '+x',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+y',
    ].join('\n');
    const applied = applyUnifiedDiff('a\nb\na', patch);
    expect(applied.ok).toBe(false);
  });

  test('does not treat a blank-only addition as an already-applied mismatch', () => {
    const applied = applyUnifiedDiff('other\n\n', '@@ -1,1 +1,1 @@\n-old\n+');
    expect(applied.ok).toBe(false);
  });

  test('retains an inserted blank line', () => {
    const applied = applyUnifiedDiff('a\nb', '@@ -1,0 +2,1 @@\n+');
    expect(applied).toEqual({ ok: true, text: 'a\n\nb' });
  });

  test('a miss stays a miss when the added lines are absent', () => {
    const applied = applyUnifiedDiff(
      'other\n',
      '@@ -1,1 +1,1 @@\n-missing\n+added-run',
    );
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.contextWindow.split('\n').length).toBeLessThanOrEqual(20);
    }
  });

  test('a miss fails when deletions are gone and additions are contiguous', () => {
    const patch = [
      '@@ -1,3 +1,3 @@',
      ' # Introduction',
      ' ',
      '-alpha',
      '+beta',
    ].join('\n');
    const once = applyUnifiedDiff(SOURCE, patch);
    expect(once.ok).toBe(true);
    if (!once.ok) {
      return;
    }
    expect(applyUnifiedDiff(once.text, patch).ok).toBe(false);
  });

  test('does not skip an addition when the resulting lines already match', () => {
    const applied = applyUnifiedDiff('a\nb\nc', '@@ -1,1 +1,2 @@\n a\n+b');
    expect(applied).toEqual({ ok: true, text: 'a\nb\nb\nc' });
  });

  test('reports about 20 lines around the mismatch', () => {
    const lines = Array.from({ length: 80 }, (_, index) => `line-${index}`);
    const applied = applyUnifiedDiff(
      lines.join('\n'),
      '@@ -1,1 +1,1 @@\n-missing\n+nope',
    );
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      const windowLines = applied.contextWindow.split('\n');
      expect(windowLines.length).toBeLessThanOrEqual(20);
      expect(applied.contextWindow).toContain('line-0');
      expect(applied.contextWindow).not.toContain('line-40');
    }
  });

  test('the session first multi-hunk patch rejects a repeated submission', () => {
    const once = applyUnifiedDiff(firstTurn.summary, firstTurn.patch);
    expect(once.ok).toBe(true);
    if (!once.ok) {
      return;
    }
    expect(once.text).toContain('remove command MUST report');
    expect(once.text).not.toContain(
      'Should the list command support filtering in a later iteration?\n',
    );
    const removeExamples = once.text
      .split('\n')
      .filter((line) =>
        line.includes('complete create, list, and remove examples'),
      );
    expect(removeExamples).toHaveLength(1);
    expect(applyUnifiedDiff(once.text, firstTurn.patch).ok).toBe(false);
  });
});
