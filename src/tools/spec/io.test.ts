import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveChange, mergeChange, proposeChange } from './io';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spec-io-'));
  mkdirSync(join(root, 'docs', 'spec'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedTrunk(reqs: string[] = ['REQ-001'], dess: string[] = ['DES-001']) {
  const reqBody =
    `# Requirements\n\n` +
    reqs.map((id) => `## ${id}: seed\n\nbody\n`).join('\n');
  const desBody =
    `# Design\n\n` +
    dess
      .map((id) => `## ${id}: seed\n\nRationale anchor: REQ-001.\n\nbody\n`)
      .join('\n');
  writeFileSync(join(root, 'docs', 'spec', 'requirements.md'), reqBody);
  writeFileSync(join(root, 'docs', 'spec', 'design.md'), desBody);
}

describe('proposeChange', () => {
  test('refuses when trunk requirements.md missing', () => {
    expect(() => proposeChange(join(root, 'docs', 'spec'), 'x', 'y')).toThrow(
      /requirements\.md not found/,
    );
  });

  test('refuses on slug collision', () => {
    seedTrunk();
    proposeChange(join(root, 'docs', 'spec'), 'feat-a', 'first');
    expect(() =>
      proposeChange(join(root, 'docs', 'spec'), 'feat-a', 'second'),
    ).toThrow(/already exists/);
  });

  test('writes proposal.md + delta files with next IDs', () => {
    seedTrunk(['REQ-001', 'REQ-002'], ['DES-001', 'DES-002', 'DES-003']);
    const result = proposeChange(
      join(root, 'docs', 'spec'),
      'feat-b',
      'do thing',
    );
    expect(result.slug).toBe('feat-b');
    expect(result.nextReqId).toBe('REQ-003');
    expect(result.nextDesId).toBe('DES-004');
    const deltaReqPath = join(
      root,
      'docs',
      'spec',
      'changes',
      'feat-b',
      'delta-requirements.md',
    );
    expect(existsSync(deltaReqPath)).toBe(true);
    const deltaReqText = readFileSync(deltaReqPath, 'utf8');
    expect(deltaReqText).toContain('do thing');
    expect(deltaReqText).toContain('## REQ-003');
    expect(
      readFileSync(
        join(root, 'docs', 'spec', 'changes', 'feat-b', 'delta-design.md'),
        'utf8',
      ),
    ).toContain('## DES-004');
  });

  test('accounts for IDs already reserved in other open changes', () => {
    seedTrunk(['REQ-001'], ['DES-001']);
    proposeChange(join(root, 'docs', 'spec'), 'feat-a', 'a');
    // feat-a reserved REQ-002 + DES-002. Next propose must start at 003.
    const r = proposeChange(join(root, 'docs', 'spec'), 'feat-b', 'b');
    expect(r.nextReqId).toBe('REQ-003');
    expect(r.nextDesId).toBe('DES-003');
  });
});

describe('mergeChange', () => {
  test('appends new REQ/DES sections into trunk and regenerates trace', () => {
    seedTrunk(['REQ-001'], ['DES-001']);
    proposeChange(join(root, 'docs', 'spec'), 'feat-x', 'x');
    // Fill in real content in deltas
    const deltaReq = join(
      root,
      'docs',
      'spec',
      'changes',
      'feat-x',
      'delta-requirements.md',
    );
    const deltaDes = join(
      root,
      'docs',
      'spec',
      'changes',
      'feat-x',
      'delta-design.md',
    );
    writeFileSync(deltaReq, '## REQ-002: new req\n\nbody\n');
    writeFileSync(
      deltaDes,
      '## DES-002: new des\n\nRationale anchor: REQ-002.\n\nbody\n',
    );

    const result = mergeChange(join(root, 'docs', 'spec'), 'feat-x');
    expect(result.mergedReqIds).toEqual(['REQ-002']);
    expect(result.mergedDesIds).toEqual(['DES-002']);

    const trunkReq = readFileSync(
      join(root, 'docs', 'spec', 'requirements.md'),
      'utf8',
    );
    expect(trunkReq).toContain('## REQ-002: new req');

    const trace = readFileSync(join(root, 'docs', 'spec', 'trace.md'), 'utf8');
    expect(trace).toContain('REQ-002');
  });

  test('refuses on ID collision with trunk', () => {
    seedTrunk(['REQ-001'], ['DES-001']);
    proposeChange(join(root, 'docs', 'spec'), 'feat-y', 'y');
    writeFileSync(
      join(root, 'docs', 'spec', 'changes', 'feat-y', 'delta-requirements.md'),
      '## REQ-001: collision\n\nbody\n',
    );
    expect(() => mergeChange(join(root, 'docs', 'spec'), 'feat-y')).toThrow(
      /already exists in trunk/,
    );
  });

  test('refuses when change directory missing', () => {
    seedTrunk();
    expect(() => mergeChange(join(root, 'docs', 'spec'), 'nope')).toThrow(
      /not found/,
    );
  });
});

describe('archiveChange', () => {
  test('moves change dir to archive with date prefix', () => {
    seedTrunk();
    proposeChange(join(root, 'docs', 'spec'), 'feat-z', 'z');
    const result = archiveChange(join(root, 'docs', 'spec'), 'feat-z');
    expect(result.archivePath).toMatch(
      /docs\/spec\/archive\/\d{4}-\d{2}-\d{2}-feat-z$/,
    );
    expect(existsSync(result.archivePath)).toBe(true);
    expect(existsSync(join(root, 'docs', 'spec', 'changes', 'feat-z'))).toBe(
      false,
    );
  });

  test('refuses when change dir missing', () => {
    seedTrunk();
    expect(() => archiveChange(join(root, 'docs', 'spec'), 'nope')).toThrow(
      /not found/,
    );
  });

  test('refuses on archive collision (same slug same day)', () => {
    seedTrunk();
    proposeChange(join(root, 'docs', 'spec'), 'feat-q', 'q');
    archiveChange(join(root, 'docs', 'spec'), 'feat-q');
    proposeChange(join(root, 'docs', 'spec'), 'feat-q', 'q-again');
    expect(() => archiveChange(join(root, 'docs', 'spec'), 'feat-q')).toThrow(
      /archive .* already exists/,
    );
  });
});
