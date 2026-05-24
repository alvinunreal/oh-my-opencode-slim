import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { regenerateTrace } from '../trace/io';
import { extractIds, extractSections } from '../trace/parser';

// Invariants enforced by this module (do not break without re-deriving):
//   1. spec_archive only runs after spec_merge succeeds, so trunk
//      requirements.md / design.md subsume every ID that ever lived in
//      archive/. Therefore nextId() can safely ignore archive/ when
//      computing the next available REQ/DES — trunk is the upper bound.
//   2. Slug reuse across days is allowed (archive paths are date-prefixed,
//      so collisions across runs are impossible). Same-day reuse is
//      refused by spec_archive.
//   3. merge is purely additive in v1. Editing an existing REQ/DES
//      requires a future spec_amend tool; until then mergeChange refuses
//      on any trunk collision.

export interface ProposeResult {
  slug: string;
  changeDir: string;
  nextReqId: string;
  nextDesId: string;
}

export interface MergeResult {
  mergedReqIds: string[];
  mergedDesIds: string[];
}

export interface ArchiveResult {
  archivePath: string;
}

function changesDir(specDir: string): string {
  return join(specDir, 'changes');
}

function archiveDir(specDir: string): string {
  return join(specDir, 'archive');
}

function listOpenChangeSlugs(specDir: string): string[] {
  const dir = changesDir(specDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function collectReservedIds(
  specDir: string,
  prefix: 'REQ' | 'DES',
): Set<string> {
  const reserved = new Set<string>();
  const trunkFile = prefix === 'REQ' ? 'requirements.md' : 'design.md';
  const trunkPath = join(specDir, trunkFile);
  if (existsSync(trunkPath)) {
    for (const id of extractIds(readFileSync(trunkPath, 'utf8'), prefix)) {
      reserved.add(id);
    }
  }
  const deltaFile =
    prefix === 'REQ' ? 'delta-requirements.md' : 'delta-design.md';
  for (const slug of listOpenChangeSlugs(specDir)) {
    const p = join(changesDir(specDir), slug, deltaFile);
    if (!existsSync(p)) continue;
    for (const id of extractIds(readFileSync(p, 'utf8'), prefix)) {
      reserved.add(id);
    }
  }
  return reserved;
}

function nextId(reserved: Set<string>, prefix: 'REQ' | 'DES'): string {
  let n = 1;
  for (const id of reserved) {
    const m = id.match(/^(?:REQ|DES)-(\d+)$/);
    if (m) {
      const v = Number.parseInt(m[1], 10);
      if (v >= n) n = v + 1;
    }
  }
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

export function proposeChange(
  specDir: string,
  slug: string,
  summary: string,
): ProposeResult {
  if (!existsSync(join(specDir, 'requirements.md'))) {
    throw new Error(
      `requirements.md not found in ${specDir}; bootstrap the trunk triad first`,
    );
  }
  const changeDir = join(changesDir(specDir), slug);
  if (existsSync(changeDir)) {
    throw new Error(`change ${slug} already exists at ${changeDir}`);
  }

  const nextReqId = nextId(collectReservedIds(specDir, 'REQ'), 'REQ');
  const nextDesId = nextId(collectReservedIds(specDir, 'DES'), 'DES');

  mkdirSync(changeDir, { recursive: true });
  writeFileSync(
    join(changeDir, 'delta-requirements.md'),
    `<!-- proposal: ${summary} -->\n\n## ${nextReqId}: <fill in>\n\n<requirement body>\n`,
  );
  writeFileSync(
    join(changeDir, 'delta-design.md'),
    `## ${nextDesId}: <fill in>\n\nRationale anchor: <REQ-N> [, REQ-M ...].\n\n<design body>\n`,
  );

  return { slug, changeDir, nextReqId, nextDesId };
}

function appendSections(
  trunkPath: string,
  sections: Array<{ id: string; body: string }>,
): void {
  if (sections.length === 0) return;
  const existing = readFileSync(trunkPath, 'utf8').trimEnd();
  const appended = sections.map((s) => s.body).join('\n\n');
  writeFileSync(trunkPath, `${existing}\n\n${appended}\n`, 'utf8');
}

export function mergeChange(specDir: string, slug: string): MergeResult {
  const changeDir = join(changesDir(specDir), slug);
  if (!existsSync(changeDir)) {
    throw new Error(`change ${slug} not found at ${changeDir}`);
  }

  const deltaReqPath = join(changeDir, 'delta-requirements.md');
  const deltaDesPath = join(changeDir, 'delta-design.md');

  const deltaReq = existsSync(deltaReqPath)
    ? readFileSync(deltaReqPath, 'utf8')
    : '';
  const deltaDes = existsSync(deltaDesPath)
    ? readFileSync(deltaDesPath, 'utf8')
    : '';

  const reqSections = extractSections(deltaReq, 'REQ');
  const desSections = extractSections(deltaDes, 'DES');

  const trunkReq = readFileSync(join(specDir, 'requirements.md'), 'utf8');
  const trunkDes = readFileSync(join(specDir, 'design.md'), 'utf8');
  const trunkReqIds = new Set(extractIds(trunkReq, 'REQ'));
  const trunkDesIds = new Set(extractIds(trunkDes, 'DES'));

  for (const s of reqSections) {
    if (trunkReqIds.has(s.id)) {
      throw new Error(`${s.id} already exists in trunk requirements.md`);
    }
  }
  for (const s of desSections) {
    if (trunkDesIds.has(s.id)) {
      throw new Error(`${s.id} already exists in trunk design.md`);
    }
  }

  appendSections(join(specDir, 'requirements.md'), reqSections);
  appendSections(join(specDir, 'design.md'), desSections);
  regenerateTrace(specDir);

  return {
    mergedReqIds: reqSections.map((s) => s.id),
    mergedDesIds: desSections.map((s) => s.id),
  };
}

function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function archiveChange(specDir: string, slug: string): ArchiveResult {
  const changeDir = join(changesDir(specDir), slug);
  if (!existsSync(changeDir)) {
    throw new Error(`change ${slug} not found at ${changeDir}`);
  }
  const stamp = todayStamp();
  const archiveBase = archiveDir(specDir);
  if (!existsSync(archiveBase)) {
    mkdirSync(archiveBase, { recursive: true });
  }
  const archivePath = join(archiveBase, `${stamp}-${slug}`);
  if (existsSync(archivePath)) {
    throw new Error(`archive ${archivePath} already exists`);
  }
  renameSync(changeDir, archivePath);
  return { archivePath };
}
