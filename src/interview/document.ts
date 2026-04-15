import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  InterviewAnswer,
  InterviewQuestion,
  InterviewRecord,
} from './types';

// ─── Path Utilities ──────────────────────────────────────────────────

export const DEFAULT_OUTPUT_FOLDER = 'interview';

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
): string {
  const fileName = `${slugify(idea) || 'interview'}.md`;
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
  const marker = '## Q&A history\n\n';
  const index = document.indexOf(marker);
  return index >= 0 ? document.slice(index + marker.length).trim() : '';
}

export function extractSummarySection(document: string): string {
  const marker = '## Current spec\n\n';
  const historyMarker = '\n\n## Q&A history';
  const start = document.indexOf(marker);
  if (start < 0) {
    return '';
  }
  const summaryStart = start + marker.length;
  const summaryEnd = document.indexOf(historyMarker, summaryStart);
  return document
    .slice(summaryStart, summaryEnd >= 0 ? summaryEnd : undefined)
    .trim();
}

export function extractTitle(document: string): string {
  const match = document.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? '';
}

export function buildInterviewDocument(
  idea: string,
  summary: string,
  history: string,
  meta?: { sessionID?: string; baseMessageCount?: number },
): string {
  const normalizedSummary = summary.trim() || 'Waiting for interview answers.';
  const normalizedHistory = history.trim() || 'No answers yet.';

  const frontmatter = meta?.sessionID
    ? [
        '---',
        `sessionID: ${meta.sessionID}`,
        `baseMessageCount: ${meta.baseMessageCount ?? 0}`,
        `updatedAt: ${new Date().toISOString()}`,
        '---',
        '',
      ].join('\n')
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
export function parseFrontmatter(
  content: string,
): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      result[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
    }
  }
  return result;
}

export async function ensureInterviewFile(
  record: InterviewRecord,
): Promise<void> {
  await fs.mkdir(path.dirname(record.markdownPath), { recursive: true });
  try {
    await fs.access(record.markdownPath);
  } catch {
    await fs.writeFile(
      record.markdownPath,
      buildInterviewDocument(record.idea, '', '', {
        sessionID: record.sessionID,
        baseMessageCount: record.baseMessageCount,
      }),
      'utf8',
    );
  }
}

export async function readInterviewDocument(
  record: InterviewRecord,
): Promise<string> {
  try {
    return await fs.readFile(record.markdownPath, 'utf8');
  } catch {
    // File missing or unreadable — recreate it
  }
  await ensureInterviewFile(record);
  return fs.readFile(record.markdownPath, 'utf8');
}

export async function rewriteInterviewDocument(
  record: InterviewRecord,
  summary: string,
): Promise<string> {
  const existing = await readInterviewDocument(record);
  const history = extractHistorySection(existing);
  const next = buildInterviewDocument(record.idea, summary, history, {
    sessionID: record.sessionID,
    baseMessageCount: record.baseMessageCount,
  });
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
    buildInterviewDocument(record.idea, summary, nextHistory, {
      sessionID: record.sessionID,
      baseMessageCount: record.baseMessageCount,
    }),
    'utf8',
  );
}
