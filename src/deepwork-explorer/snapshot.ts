/**
 * Deepwork explorer snapshot: a read-only projection of one deepwork run,
 * assembled from state that already exists — the router head and the
 * progress file's front matter that the skill maintains under
 * `.slim/deepwork/`, and the background job board's rows for the session.
 * Nothing here writes, and nothing reaches a prompt.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { BackgroundJobRecord } from '../utils/background-job-board';

/** Bound on the result text shipped per job (oracle verdicts, reports). */
const MAX_RESULT_CHARS = 6000;

/** The skill's gate task description: `Pass 2 gate — attempt 2 of 3`. */
const GATE_DESCRIPTION =
  /^\s*pass\s+(\d+)\s+gate\s*[—–-]+\s*attempt\s+(\d+)\s+of\s+(\d+)/i;

export interface ExplorerJob {
  id: string;
  alias: string;
  agent: string;
  description: string;
  state: 'running' | 'completed' | 'error' | 'cancelled' | 'stopped';
  startedAt: number;
  endedAt?: number;
  result?: string;
  /** Pass the job belongs to: from its gate description, else the pass in
   * progress.md when it launched. Absent when neither is known. */
  pass?: number;
  gate?: { attempt: number; max: number };
}

export interface ExplorerProgress {
  pass?: number;
  goal?: string;
  next?: string;
  issues: string[];
}

export interface ExplorerSnapshot {
  version: 2;
  sessionID: string;
  slug?: string;
  status: 'active' | 'completed' | 'unknown';
  now: number;
  progress: ExplorerProgress;
  jobs: ExplorerJob[];
}

function unquote(value: string): string {
  const v = value.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'")))
  )
    return v.slice(1, -1);
  return v;
}

/**
 * Read the progress file's front matter. The skill fixes four keys:
 * `pass` (number), `goal`, `next` (strings) and `issues` (a list). Only that
 * shape is read; a file without front matter yields no fields.
 */
export function parseProgress(text: string): ExplorerProgress {
  const progress: ExplorerProgress = { issues: [] };
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return progress;

  let list: string[] | undefined;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && list) {
      const value = unquote(item[1]);
      if (value) list.push(value);
      continue;
    }
    list = undefined;
    const pair = line.match(/^(\w+):\s*(.*)$/);
    if (!pair) continue;
    const [, key, raw] = pair;
    const value = unquote(raw);
    if (key === 'pass') {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0) progress.pass = n;
    } else if (key === 'goal' && value) progress.goal = value;
    else if (key === 'next' && value) progress.next = value;
    else if (key === 'issues' && (value === '' || value === '[]'))
      list = progress.issues;
  }
  return progress;
}

function jobState(record: BackgroundJobRecord): ExplorerJob['state'] {
  if (record.state === 'reconciled')
    return record.terminalState === 'running' || !record.terminalState
      ? 'completed'
      : record.terminalState;
  return record.state;
}

export function projectJobs(
  records: BackgroundJobRecord[],
  passAtLaunch: (taskID: string) => number | undefined = () => undefined,
): ExplorerJob[] {
  return records
    .filter((r) => !r.provisional)
    .map((r): ExplorerJob => {
      const state = jobState(r);
      const result = r.resultSummary;
      const gate = r.description.match(GATE_DESCRIPTION);
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
        pass: gate ? Number(gate[1]) : passAtLaunch(r.taskID),
        gate: gate
          ? { attempt: Number(gate[2]), max: Number(gate[3]) }
          : undefined,
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

function headField(head: string, key: string): string | undefined {
  const match = head.match(new RegExp(`^\\s*${key}:\\s*(\\S+)`, 'im'));
  return match?.[1];
}

export interface DeepworkFiles {
  slug?: string;
  status: ExplorerSnapshot['status'];
  progress: ExplorerProgress;
}

export async function readDeepworkFiles(
  directory: string,
  sessionID: string,
): Promise<DeepworkFiles> {
  const root = path.join(directory, '.slim', 'deepwork');
  const head = await readText(path.join(root, `${sessionID}.md`));
  if (head === undefined)
    return { status: 'unknown', progress: { issues: [] } };

  const status = headField(head, 'status')?.toLowerCase();
  const slug = headField(head, 'slug');
  // Slugs are plain directory names; never follow anything path-like.
  const safeSlug =
    slug && /^[\w.-]+$/.test(slug) && !slug.startsWith('.') ? slug : undefined;
  const progressText = safeSlug
    ? await readText(path.join(root, safeSlug, 'progress.md'))
    : undefined;

  return {
    slug: safeSlug,
    status: status === 'active' || status === 'completed' ? status : 'unknown',
    progress: progressText ? parseProgress(progressText) : { issues: [] },
  };
}
