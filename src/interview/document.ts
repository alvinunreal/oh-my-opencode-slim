import { createHash, randomUUID } from 'node:crypto';
import * as fsSync from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseFrontmatter as sharedParseFrontmatter } from '../utils/frontmatter';
import { applyUnifiedDiff, InterviewPatchApplyError } from './patch';
import type {
  InterviewAnswer,
  InterviewQuestion,
  InterviewRecord,
  SpecBlock,
} from './types';

// ─── Path Utilities ──────────────────────────────────────────────────

export const DEFAULT_OUTPUT_FOLDER = 'interview';

const DOCUMENT_LOCK_RETRY_LIMIT = 200;
const DOCUMENT_LOCK_RETRY_DELAY_MS = 25;
const DOCUMENT_LOCK_STALE_MS = 60_000;
const activeDocumentLockTokens = new Set<string>();

type DocumentLock = {
  handle: FileHandle;
  lockPath: string;
  token: string;
};

export { InterviewPatchApplyError } from './patch';

export class InterviewDocumentOwnershipError extends Error {
  constructor(
    readonly markdownPath: string,
    readonly ownerSessionID: string,
  ) {
    super(`Interview document is owned by another session: ${ownerSessionID}`);
    this.name = 'InterviewDocumentOwnershipError';
  }
}

export class InterviewPatchRequiredError extends InterviewPatchApplyError {
  constructor() {
    super('', '');
    this.message = 'Interview spec patch required';
    this.name = 'InterviewPatchRequiredError';
  }
}

function isNoSuchFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function isStaleDocumentLock(lockPath: string): Promise<boolean> {
  let stat: fsSync.Stats;
  try {
    stat = await fs.stat(lockPath);
  } catch (error) {
    return isNoSuchFileError(error);
  }

  if (Date.now() - stat.mtimeMs < DOCUMENT_LOCK_STALE_MS) {
    return false;
  }

  try {
    const content = await fs.readFile(lockPath, 'utf8');
    const metadata = JSON.parse(content) as {
      pid?: unknown;
      token?: unknown;
    };
    if (typeof metadata.pid !== 'number' || metadata.pid <= 0) {
      return true;
    }

    if (metadata.pid === process.pid && typeof metadata.token === 'string') {
      return !activeDocumentLockTokens.has(metadata.token);
    }

    try {
      process.kill(metadata.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  } catch {
    return true;
  }
}

async function acquireDocumentLock(lockPath: string): Promise<DocumentLock> {
  for (let attempt = 0; attempt < DOCUMENT_LOCK_RETRY_LIMIT; attempt++) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      const token = randomUUID();
      try {
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            startedAt: Date.now(),
            token,
          }),
          'utf8',
        );
      } catch (error) {
        await handle.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
        throw error;
      }
      activeDocumentLockTokens.add(token);
      return { handle, lockPath, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }

      if (await isStaleDocumentLock(lockPath)) {
        await fs.unlink(lockPath).catch(() => {});
        continue;
      }

      if (attempt + 1 < DOCUMENT_LOCK_RETRY_LIMIT) {
        await new Promise((resolve) =>
          setTimeout(resolve, DOCUMENT_LOCK_RETRY_DELAY_MS),
        );
      }
    }
  }

  throw new Error(`Timed out acquiring interview document lock: ${lockPath}`);
}

async function releaseDocumentLock(lock: DocumentLock): Promise<void> {
  await lock.handle.close().catch(() => {});
  try {
    const content = await fs.readFile(lock.lockPath, 'utf8');
    const metadata = JSON.parse(content) as { token?: unknown };
    if (metadata.token === lock.token) {
      await fs.unlink(lock.lockPath);
    }
  } catch {
    // The lock may have been removed by stale-lock recovery after a failure.
  } finally {
    activeDocumentLockTokens.delete(lock.token);
  }
}

export async function withInterviewDocumentLock<T>(
  markdownPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const canonicalPath = path.resolve(markdownPath);
  await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
  const lock = await acquireDocumentLock(`${canonicalPath}.lock`);
  try {
    return await operation();
  } finally {
    await releaseDocumentLock(lock);
  }
}

function buildInterviewFrontmatter(
  sessionID: string,
  baseMessageCount: number,
  owner = 'agent',
  tags = ['spec', 'diagnostic'],
  consumedState?: string,
  status?: string,
): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  return [
    '---',
    `sessionID: ${sessionID}`,
    `baseMessageCount: ${baseMessageCount}`,
    `updatedAt: ${now.toISOString()}`,
    'version: 1.0',
    `date_created: ${dateStr}`,
    `owner: ${owner}`,
    `tags: [${tags.join(', ')}]`,
    ...(consumedState ? [`consumedState: ${consumedState}`] : []),
    ...(status ? [`status: ${status}`] : []),
    '---',
    '',
  ].join('\n');
}

export function interviewOwnerSessionID(record: InterviewRecord): string {
  return record.sessionID;
}

/** Hash of one assistant interview_state turn. Empty patches stay distinct. */
export function hashInterviewState(state: {
  summary: string;
  title?: string;
  patch?: string;
  questions: Array<{ id: string; question: string }>;
}): string {
  const canonical = JSON.stringify({
    summary: state.summary,
    title: state.title ?? '',
    patch: state.patch ?? '',
    questions: state.questions.map((question) => ({
      id: question.id,
      question: question.question,
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export async function claimInterviewDocument(
  markdownPath: string,
  sessionID: string,
  baseMessageCount: number,
): Promise<string> {
  return withInterviewDocumentLock(markdownPath, async () => {
    const document = await fs.readFile(markdownPath, 'utf8');
    const frontmatter = sharedParseFrontmatter(document);
    const owner = frontmatter?.sessionID;
    if (owner && owner !== sessionID) {
      throw new InterviewDocumentOwnershipError(markdownPath, owner);
    }
    if (owner) {
      return document;
    }

    const frontmatterMatch = document.match(
      /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/,
    );
    const existingFrontmatter = frontmatterMatch?.[1]
      .split(/\r?\n/)
      .filter((line) => !/^sessionID\s*:/i.test(line))
      .join('\n');
    const next = frontmatterMatch
      ? [
          '---',
          `sessionID: ${sessionID}`,
          `baseMessageCount: ${baseMessageCount}`,
          existingFrontmatter,
          '---',
          '',
          document.slice(frontmatterMatch[0].length),
        ].join('\n')
      : `${buildInterviewFrontmatter(sessionID, baseMessageCount)}${document}`;
    await fs.writeFile(markdownPath, next, 'utf8');
    return next;
  });
}

export function normalizeOutputFolder(outputFolder: string): string {
  const normalized = outputFolder.trim().replace(/^\/+|\/+$/g, '');
  return normalized || DEFAULT_OUTPUT_FOLDER;
}

export function createInterviewDirectoryPath(
  directory: string,
  outputFolder: string,
): string {
  return path.join(directory, normalizeOutputFolder(outputFolder));
}

export function createInterviewFilePath(
  directory: string,
  outputFolder: string,
  idea: string,
  uniqueId?: string,
): string {
  const readableSlug = slugify(idea) || 'interview';
  const uniqueSuffix = uniqueId
    ? `-${uniqueId.replace(/[^a-z0-9-]+/gi, '-')}`
    : '';
  const fileName = `${readableSlug}${uniqueSuffix}.md`;
  return path.join(
    createInterviewDirectoryPath(directory, outputFolder),
    fileName,
  );
}

export function relativeInterviewPath(
  directory: string,
  filePath: string,
): string {
  return path.relative(directory, filePath) || path.basename(filePath);
}

/**
 * Resolve a user-provided value to an existing .md file path.
 * Checks absolute paths, relative paths, and output-folder-relative paths.
 * Returns null if no matching file is found.
 */
export function resolveExistingInterviewPath(
  directory: string,
  outputFolder: string,
  value: string,
): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const outputDir = createInterviewDirectoryPath(directory, outputFolder);
  const candidates = new Set<string>();
  const resolvedRoot = path.resolve(directory);

  if (path.isAbsolute(trimmed)) {
    candidates.add(trimmed);
  } else {
    candidates.add(path.resolve(directory, trimmed));
    candidates.add(path.join(outputDir, trimmed));
    if (!trimmed.endsWith('.md')) {
      candidates.add(path.join(outputDir, `${trimmed}.md`));
    }
  }

  for (const candidate of candidates) {
    if (path.extname(candidate) !== '.md') {
      continue;
    }
    const resolved = path.resolve(candidate);
    if (
      !resolved.startsWith(resolvedRoot + path.sep) &&
      resolved !== resolvedRoot
    ) {
      continue;
    }
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ─── String Utilities ────────────────────────────────────────────────

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

// ─── Markdown Document Operations ────────────────────────────────────

function extractHistorySection(document: string): string {
  const marker = /## Q&A history/i;
  const match = document.match(marker);
  if (!match || match.index === undefined) return '';
  return document.slice(match.index + match[0].length).trim();
}

export function extractSummarySection(document: string): string {
  const marker = '## Current spec\n\n';
  const start = document.indexOf(marker);
  if (start < 0) {
    return '';
  }
  const summaryStart = start + marker.length;
  const historyMarker = /\n\n## Q&A history/i;
  const historyMatch = document.slice(summaryStart).match(historyMarker);
  const summaryEnd =
    historyMatch?.index !== undefined
      ? summaryStart + historyMatch.index
      : undefined;
  return document.slice(summaryStart, summaryEnd).trim();
}

/** Heading lines from a spec body, used instead of pasting the body into a prompt. */
export function extractSpecOutline(spec: string): string {
  const headings = spec
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => /^#{1,6}\s+\S/.test(line));
  return headings.length > 0 ? headings.join('\n') : '(no headings yet)';
}

export function extractTitle(document: string): string {
  const match = document.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? '';
}

export function buildInterviewDocument(
  idea: string,
  summary: string,
  history: string,
  meta?: {
    sessionID?: string;
    baseMessageCount?: number;
    owner?: string;
    tags?: string[];
    consumedState?: string;
    status?: string;
  },
): string {
  const normalizedSummary = summary.trim() || 'Waiting for interview answers.';
  const normalizedHistory = history.trim() || 'No answers yet.';

  const owner = meta?.owner ?? 'agent';
  const tags = meta?.tags ?? ['spec', 'diagnostic'];

  const frontmatter = meta?.sessionID
    ? buildInterviewFrontmatter(
        meta.sessionID,
        meta.baseMessageCount ?? 0,
        owner,
        tags,
        meta.consumedState,
        meta.status,
      )
    : '';

  return [
    frontmatter,
    `# ${idea}`,
    '',
    '## Current spec',
    '',
    normalizedSummary,
    '',
    '## Q&A history',
    '',
    normalizedHistory,
    '',
  ].join('\n');
}

/** Parse frontmatter from a .md file. Returns null if no frontmatter. */
export const parseFrontmatter = sharedParseFrontmatter;

export async function ensureInterviewFile(
  record: InterviewRecord,
): Promise<void> {
  await fs.mkdir(path.dirname(record.markdownPath), { recursive: true });
  try {
    await fs.writeFile(
      record.markdownPath,
      buildInterviewDocument(record.idea, '', '', {
        sessionID: interviewOwnerSessionID(record),
        baseMessageCount: record.baseMessageCount,
      }),
      { encoding: 'utf8', flag: 'wx' },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
}

export async function readInterviewDocument(
  record: InterviewRecord,
): Promise<string> {
  try {
    return await fs.readFile(record.markdownPath, 'utf8');
  } catch {
    // File missing or unreadable - recreate it
  }
  await ensureInterviewFile(record);
  return fs.readFile(record.markdownPath, 'utf8');
}

export async function rewriteInterviewDocument(
  record: InterviewRecord,
  summary: string,
  title?: string,
  patch?: string,
  consumedState?: string,
): Promise<string> {
  const existing = await readInterviewDocument(record);
  const history = extractHistorySection(existing);
  const current = extractSummarySection(existing);
  let nextSummary = summary;
  if (
    patch === undefined &&
    current &&
    current !== 'Waiting for interview answers.'
  ) {
    throw new InterviewPatchRequiredError();
  }
  if (patch !== undefined) {
    if (patch.trim()) {
      const applied = applyUnifiedDiff(current, patch);
      if (!applied.ok) {
        throw new InterviewPatchApplyError(
          applied.failedHunk,
          applied.contextWindow,
        );
      }
      nextSummary = applied.text.trim();
    } else {
      nextSummary =
        current && current !== 'Waiting for interview answers.'
          ? current
          : summary;
    }
  }
  const next = buildInterviewDocument(
    title || extractTitle(existing) || record.idea,
    nextSummary,
    history,
    {
      sessionID: interviewOwnerSessionID(record),
      baseMessageCount: record.baseMessageCount,
      consumedState: consumedState ?? parseFrontmatter(existing)?.consumedState,
      status: parseFrontmatter(existing)?.status,
    },
  );
  await fs.writeFile(record.markdownPath, next, 'utf8');
  return next;
}

/** Mark the file finished without rewriting the spec body. */
export async function markInterviewDocumentComplete(
  record: InterviewRecord,
): Promise<string> {
  const existing = await readInterviewDocument(record);
  const next = updateInterviewStatus(existing, 'complete');
  await fs.writeFile(record.markdownPath, next, 'utf8');
  return next;
}

export async function markInterviewDocumentIncomplete(
  record: InterviewRecord,
): Promise<string> {
  const existing = await readInterviewDocument(record);
  const next = updateInterviewStatus(existing, null);
  await fs.writeFile(record.markdownPath, next, 'utf8');
  return next;
}

function updateInterviewStatus(
  document: string,
  status: string | null,
): string {
  const frontmatterMatch = document.match(/^---[\s\S]*?---/);
  if (!frontmatterMatch || frontmatterMatch.index === undefined)
    return document;
  const frontmatter = frontmatterMatch[0];
  const statusLine = /^status:[^\n]*(?:\n|$)/m;
  const updatedFrontmatter = status
    ? statusLine.test(frontmatter)
      ? frontmatter.replace(statusLine, `status: ${status}\n`)
      : frontmatter.replace(/\n---$/, `\nstatus: ${status}\n---`)
    : frontmatter.replace(statusLine, '');
  return `${updatedFrontmatter}${document.slice(frontmatter.length)}`;
}

/**
 * Replace only the current specification with a clean completion response.
 * The response is deliberately not passed through the interview-state parser:
 * a previous structured response must never win over the final markdown.
 */
export async function rewriteInterviewDocumentWithFinalSpec(
  record: InterviewRecord,
  finalMarkdown: string,
): Promise<string> {
  const existing = await readInterviewDocument(record);
  const history = extractHistorySection(existing);
  const frontmatter = existing.match(/^---[\s\S]*?---\s*/)?.[0] ?? '';
  const withoutFrontmatter = finalMarkdown
    .trim()
    .replace(/^---[\s\S]*?---\s*/i, '')
    .trim();
  const summary =
    extractSummarySection(withoutFrontmatter) || withoutFrontmatter;
  const title = extractTitle(existing) || record.idea;
  const next = [
    frontmatter,
    `# ${title}`,
    '',
    '## Current spec',
    '',
    summary.trim() || 'Specification completed.',
    '',
    '## Q&A history',
    '',
    history || 'No answers yet.',
    '',
  ].join('\n');
  await fs.writeFile(record.markdownPath, next, 'utf8');
  return next;
}

export async function appendInterviewAnswers(
  record: InterviewRecord,
  questions: InterviewQuestion[],
  answers: InterviewAnswer[],
): Promise<void> {
  const existing = await readInterviewDocument(record);
  const summary = extractSummarySection(existing);
  const history = extractHistorySection(existing);
  const questionMap = new Map(
    questions.map((question) => [question.id, question]),
  );
  const appended = answers
    .map((answer) => {
      const question = questionMap.get(answer.questionId);
      return question
        ? `Q: ${question.question}\nA: ${answer.answer.trim()}`
        : null;
    })
    .filter((value): value is string => value !== null)
    .join('\n\n');
  const nextHistory = [history === 'No answers yet.' ? '' : history, appended]
    .filter(Boolean)
    .join('\n\n');
  await fs.writeFile(
    record.markdownPath,
    buildInterviewDocument(
      extractTitle(existing) || record.idea,
      summary,
      nextHistory,
      {
        sessionID: interviewOwnerSessionID(record),
        baseMessageCount: record.baseMessageCount,
        consumedState: parseFrontmatter(existing)?.consumedState,
        status: parseFrontmatter(existing)?.status,
      },
    ),
    'utf8',
  );
}

export function parseSpecBlocks(markdown: string): SpecBlock[] {
  const blocks: SpecBlock[] = [];
  const lines = markdown.split('\n');

  let currentBlockId: string | null = null;
  let currentBlockTitle: string | null = null;
  let currentBlockLines: string[] = [];

  const flush = () => {
    if (currentBlockId) {
      blocks.push({
        id: currentBlockId,
        title: currentBlockTitle || currentBlockId,
        content: currentBlockLines.join('\n').trim(),
      });
    }
  };

  for (const line of lines) {
    if (/^##\s+Q&A history\s*$/i.test(line)) {
      break;
    }

    const headerMatch = line.match(/^##\s+(\d+)\.\s+(.+)$/);
    if (headerMatch) {
      flush();
      const num = headerMatch[1];
      const name = headerMatch[2].trim();
      currentBlockId = `section-${num}`;
      currentBlockTitle = `${num}. ${name}`;
      currentBlockLines = [];
    } else if (line.startsWith('# ') && !line.startsWith('## ')) {
      // Intro section before ## 1.
      if (currentBlockId === null) {
        currentBlockId = 'section-0';
        currentBlockTitle = 'Introduction';
        currentBlockLines = [];
      }
    } else if (line.startsWith('## ') && !headerMatch) {
      // Any other H2
      flush();
      const name = line.replace(/^##\s+/, '').trim();
      currentBlockId = `section-${slugify(name)}`;
      currentBlockTitle = name;
      currentBlockLines = [];
    }

    if (currentBlockId !== null) {
      currentBlockLines.push(line);
    }
  }

  flush();
  return blocks;
}
