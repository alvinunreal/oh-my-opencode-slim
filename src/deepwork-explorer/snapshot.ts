/**
 * Deepwork explorer snapshot: a read-only projection of one deepwork run,
 * assembled from state that already exists — the router head and progress
 * file the skill maintains under `.slim/deepwork/`, and the background job
 * board's rows for the session. Nothing here writes, and nothing reaches a
 * prompt.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { BackgroundJobRecord } from '../utils/background-job-board';

/** Bound on the result text shipped per job (oracle verdicts, reports). */
const MAX_RESULT_CHARS = 6000;

export interface ExplorerJob {
  id: string;
  alias: string;
  agent: string;
  description: string;
  state: 'running' | 'completed' | 'error' | 'cancelled' | 'stopped';
  startedAt: number;
  endedAt?: number;
  result?: string;
}

export interface ExplorerProgress {
  pass?: number;
  goal?: string;
  next?: string;
  decision?: string;
  issues: string[];
}

export interface ExplorerSnapshot {
  version: 1;
  sessionID: string;
  slug?: string;
  status: 'active' | 'completed' | 'unknown';
  now: number;
  startedAt: number;
  progress: ExplorerProgress;
  /** When each observed pass first appeared in progress.md (ms). */
  passStarts: { pass: number; at: number }[];
  jobs: ExplorerJob[];
}

const PASS_NAMES: Record<string, number> = {
  sketch: 1,
  structure: 2,
  detail: 3,
};

const LIST_ITEM = /^\s*(?:\d+[.)]|[-*•])\s+(.+?)\s*$/;

function field(text: string, key: RegExp): string | undefined {
  for (const line of text.split('\n')) {
    const match = line.match(key);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

/**
 * Best-effort read of the skill's plain-prose progress file. The skill fixes
 * its contents (status, pass and goal, next step, decisions, a ranked
 * known-issues list) but not their layout, so every field is optional.
 */
export function parseProgress(text: string): ExplorerProgress {
  const passLine = field(
    text,
    /\bpass\b[^\n]*?\b(\d+|sketch|structure|detail)\b/i,
  );
  let pass: number | undefined;
  if (passLine) {
    const n = Number(passLine);
    pass = Number.isFinite(n) ? n : PASS_NAMES[passLine.toLowerCase()];
  }

  const issues: string[] = [];
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /known[- ]issues/i.test(l));
  if (start >= 0) {
    const inline = lines[start].split(/known[- ]issues\W*/i)[1]?.trim();
    if (inline && !LIST_ITEM.test(inline) && !/^none\b/i.test(inline))
      issues.push(inline);
    for (const line of lines.slice(start + 1)) {
      const item = line.match(LIST_ITEM);
      if (item) {
        issues.push(item[1]);
        continue;
      }
      if (line.trim() === '' && issues.length === 0) continue;
      break;
    }
  }

  return {
    pass,
    goal: field(text, /\bgoal\s*[:\-—]\s*(.+)$/i),
    next: field(text, /\bnext(?:\s+step)?\s*[:\-—]\s*(.+)$/i),
    decision: field(text, /\bdecisions?\s*[:\-—]\s*(.+)$/i),
    issues,
  };
}

function headStatus(text: string): ExplorerSnapshot['status'] {
  const status = field(text, /^\s*status:\s*(\w+)/i)?.toLowerCase();
  if (status === 'active' || status === 'completed') return status;
  return 'unknown';
}

function jobState(record: BackgroundJobRecord): ExplorerJob['state'] {
  if (record.state === 'reconciled')
    return record.terminalState === 'running' || !record.terminalState
      ? 'completed'
      : record.terminalState;
  return record.state;
}

export function projectJobs(records: BackgroundJobRecord[]): ExplorerJob[] {
  return records
    .filter((r) => !r.provisional)
    .map((r) => {
      const state = jobState(r);
      const result = r.resultSummary;
      return {
        id: r.taskID,
        alias: r.alias,
        agent: r.agent,
        description: r.description,
        state,
        startedAt: r.runStartedAt || r.launchedAt,
        endedAt: state === 'running' ? undefined : r.completedAt,
        result:
          result && result.length > MAX_RESULT_CHARS
            ? `${result.slice(0, MAX_RESULT_CHARS)}…`
            : result,
      };
    })
    .sort((a, b) => a.startedAt - b.startedAt);
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

export interface DeepworkFiles {
  slug?: string;
  status: ExplorerSnapshot['status'];
  headCreatedAt?: number;
  /** Last progress.md rewrite; the skill rewrites it at pass transitions. */
  progressWrittenAt?: number;
  progress: ExplorerProgress;
}

export async function readDeepworkFiles(
  directory: string,
  sessionID: string,
): Promise<DeepworkFiles> {
  const root = path.join(directory, '.slim', 'deepwork');
  const headPath = path.join(root, `${sessionID}.md`);
  const head = await readText(headPath);
  if (head === undefined)
    return { status: 'unknown', progress: { issues: [] } };

  let headCreatedAt: number | undefined;
  try {
    const info = await stat(headPath);
    headCreatedAt = info.birthtimeMs || info.mtimeMs;
  } catch {
    headCreatedAt = undefined;
  }

  const slug = field(head, /^\s*slug:\s*([\w.-]+)/i);
  // Slugs are plain directory names; never follow anything path-like.
  const safeSlug =
    slug && /^[\w.-]+$/.test(slug) && !slug.startsWith('.') ? slug : undefined;
  const progressPath = safeSlug
    ? path.join(root, safeSlug, 'progress.md')
    : undefined;
  const progressText = progressPath ? await readText(progressPath) : undefined;
  let progressWrittenAt: number | undefined;
  if (progressPath && progressText !== undefined) {
    try {
      progressWrittenAt = (await stat(progressPath)).mtimeMs;
    } catch {
      progressWrittenAt = undefined;
    }
  }

  return {
    slug: safeSlug,
    status: headStatus(head),
    headCreatedAt,
    progressWrittenAt,
    progress: progressText ? parseProgress(progressText) : { issues: [] },
  };
}
