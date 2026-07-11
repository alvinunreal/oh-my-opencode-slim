import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseFrontmatter as sharedParseFrontmatter } from '../utils/frontmatter';
import type {
  InterviewAnswer,
  InterviewQuestion,
  InterviewRecord,
  SpecBlock,
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
  },
): string {
  const normalizedSummary = summary.trim() || 'Waiting for interview answers.';
  const normalizedHistory = history.trim() || 'No answers yet.';

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  const owner = meta?.owner ?? 'agent';
  const tags = meta?.tags ?? ['spec', 'diagnostic'];

  const frontmatter = meta?.sessionID
    ? [
        '---',
        `sessionID: ${meta.sessionID}`,
        `baseMessageCount: ${meta.baseMessageCount ?? 0}`,
        `updatedAt: ${now.toISOString()}`,
        `version: 1.0`,
        `date_created: ${dateStr}`,
        `owner: ${owner}`,
        `tags: [${tags.join(', ')}]`,
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
export const parseFrontmatter = sharedParseFrontmatter;

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
    // File missing or unreadable - recreate it
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
