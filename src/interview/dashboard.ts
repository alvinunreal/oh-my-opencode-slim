import crypto from 'node:crypto';
import * as fsSync from 'node:fs';
import fs from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';
import { log } from '../utils';
import {
  extractSummarySection,
  extractTitle,
  parseFrontmatter,
  slugify,
} from './document';
import {
  extractResumeSlug,
  isValidId,
  readJsonBody,
  sendHtml,
  sendJson,
} from './helpers';
import type { InterviewFileItem, InterviewStateEntry } from './types';
import { renderDashboardPage, renderInterviewPage } from './ui';

// ─── Auth Token File ────────────────────────────────────────────────
// Dashboard writes its auth token to a file so sessions can discover it.
// Both processes run as the same user on the same machine (localhost-only).

function getAuthFilePath(port: number): string {
  const dataHome =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'opencode', `.dashboard-${port}.json`);
}

function writeAuthFile(port: number, token: string): void {
  const filePath = getAuthFilePath(port);
  const dir = path.dirname(filePath);
  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch {
    // Directory exists
  }
  fsSync.writeFileSync(
    filePath,
    JSON.stringify({
      token,
      pid: process.pid,
      startedAt: Date.now(),
    }),
    { mode: 0o600 },
  );
}

function removeAuthFile(port: number): void {
  try {
    fsSync.unlinkSync(getAuthFilePath(port));
  } catch {
    // File doesn't exist, ignore
  }
}

export async function readDashboardAuthFile(
  port: number,
): Promise<{ token: string; pid: number; startedAt: number } | null> {
  try {
    const content = await fs.readFile(getAuthFilePath(port), 'utf8');
    const data = JSON.parse(content) as {
      token: string;
      pid: number;
      startedAt: number;
    };
    // Check if the PID is still alive — stale file from crashed dashboard
    try {
      process.kill(data.pid, 0); // signal 0 = existence check, no actual signal
    } catch {
      // PID doesn't exist — stale auth file from crashed dashboard
      try {
        fsSync.unlinkSync(getAuthFilePath(port));
      } catch {
        // Ignore cleanup errors
      }
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function jitterMs(): number {
  return 50 + Math.floor(Math.random() * 150);
}

// ─── Types ────────────────────────────────────────────────────────────

interface RegisteredSession {
  sessionID: string;
  directory: string;
  pid: number;
  registeredAt: number;
}

// ─── Config ───────────────────────────────────────────────────────────

export const DEFAULT_DASHBOARD_PORT = 43211;

export interface DashboardConfig {
  port: number;
  outputFolder: string;
  sessionClient?: {
    list: (params?: Record<string, unknown>) => Promise<{
      data?: Array<{
        directory?: string;
        time?: { updated?: number };
      }>;
    }>;
  };
}

// ─── Dashboard Server ─────────────────────────────────────────────────

export function createDashboardServer(config: DashboardConfig): {
  start: () => Promise<string>;
  close: () => void;
  registerSession: (info: RegisteredSession) => void;
  removeSession: (sessionID: string) => void;
  pushState: (entry: InterviewStateEntry) => void;
  getState: (interviewId: string) => InterviewStateEntry | undefined;
  storeAnswers: (
    interviewId: string,
    answers: Array<{ questionId: string; answer: string }>,
  ) => void;
  getPendingAnswers: (interviewId: string) => Array<{
    questionId: string;
    answer: string;
  }> | null;
  consumePendingAnswers: (
    interviewId: string,
  ) => Array<{ questionId: string; answer: string }> | null;
  consumeNudgeAction: (
    interviewId: string,
  ) => 'more-questions' | 'confirm-complete' | null;
  authToken: string;
  discoverSessionDirectories: () => Promise<void>;
  addManualFolder: (dir: string) => void;
  removeManualFolder: (dir: string) => void;
  getManualFolders: () => string[];
  setScanDays: (days: number) => void;
  getScanDays: () => number;
  refreshFiles: () => Promise<void>;
} {
  const authToken = crypto.randomBytes(32).toString('hex');
  let activeServer: Server | null = null;
  let baseUrl: string | null = null;

  // Session registry
  const sessions = new Map<string, RegisteredSession>();

  // Interview state cache
  const stateCache = new Map<string, InterviewStateEntry>();

  // Periodic cleanup: remove terminal entries older than 24h
  const TERMINAL_MODES = new Set([
    'abandoned',
    'completed',
    'session-disconnected',
  ]);
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [id, entry] of stateCache) {
      if (TERMINAL_MODES.has(entry.mode) && entry.lastUpdatedAt < cutoff) {
        stateCache.delete(id);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  // File scan cache (TTL 10s)
  let fileCache: { items: InterviewFileItem[]; at: number } | null = null;
  const FILE_CACHE_TTL = 10_000;

  // ─── Auth ─────────────────────────────────────────────────────────

  function isAuthenticated(request: IncomingMessage): boolean {
    // 1. Check HttpOnly cookie (browser requests)
    const cookieHeader = request.headers.cookie ?? '';
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)dashboard_token=([^;]+)/);
    if (cookieMatch?.[1] === authToken) return true;
    // 2. Check query param (inter-process: session → dashboard)
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const tokenParam = url.searchParams.get('token');
    if (tokenParam === authToken) return true;
    // 3. Check Authorization header (Bearer token)
    const authHeader = request.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;
    if (bearerToken === authToken) return true;
    return false;
  }

  function setSessionCookie(response: ServerResponse): void {
    response.setHeader(
      'Set-Cookie',
      `dashboard_token=${authToken}; HttpOnly; SameSite=Strict; Path=/`,
    );
  }

  // ─── Session Discovery ───────────────────────────────────────────

  const manualFolders = new Set<string>();
  const discoveredFolders = new Set<string>();
  let scanDays = 30;

  function getKnownDirectories(): Set<string> {
    const dirs = new Set<string>();
    // Always scan home directory — interviews may have been created from a
    // session that ran with cwd=$HOME and never registered with the dashboard.
    dirs.add(os.homedir());
    for (const session of sessions.values()) {
      if (session.directory) dirs.add(session.directory);
    }
    for (const folder of manualFolders) {
      dirs.add(folder);
    }
    for (const folder of discoveredFolders) {
      dirs.add(folder);
    }
    return dirs;
  }

  async function discoverSessionDirectories(): Promise<void> {
    if (!config.sessionClient) return;
    try {
      const result = await config.sessionClient.list({ limit: 500 });
      const sessionList = result.data;
      if (!sessionList) return;

      const cutoff =
        scanDays > 0 ? Date.now() - scanDays * 24 * 60 * 60 * 1000 : 0;

      for (const session of sessionList) {
        if (!session.directory) continue;
        if (cutoff > 0 && session.time?.updated) {
          if (session.time.updated < cutoff) continue;
        }
        // Add to discovered set (not manualFolders) so user removal
        // of a manual folder isn't undone by the next scan
        discoveredFolders.add(session.directory);
      }
    } catch {
      // Session list not available — rely on registered sessions
    }
  }

  // ─── File Scanning ───────────────────────────────────────────────

  async function scanInterviewFiles(): Promise<InterviewFileItem[]> {
    if (fileCache && Date.now() - fileCache.at < FILE_CACHE_TTL) {
      return fileCache.items;
    }

    const directories = getKnownDirectories();
    const items: InterviewFileItem[] = [];

    for (const dir of directories) {
      const interviewDir = path.join(dir, config.outputFolder);
      let entries: string[];
      try {
        entries = await fs.readdir(interviewDir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;

        let content: string;
        try {
          content = await fs.readFile(path.join(interviewDir, entry), 'utf8');
        } catch {
          continue;
        }

        // Extract title and summary using shared extractors
        const title = extractTitle(content) || entry.replace(/\.md$/, '');
        const summary = extractSummarySection(content);
        const baseName = entry.replace(/\.md$/, '');

        items.push({
          fileName: entry,
          resumeCommand: `/interview ${baseName}`,
          title,
          summary:
            summary.length > 120 ? `${summary.slice(0, 120)}\u2026` : summary,
        });
      }
    }

    const sorted = items.sort((a, b) => a.title.localeCompare(b.title));
    fileCache = { items: sorted, at: Date.now() };
    return sorted;
  }

  // ─── Failover: rebuild state from .md frontmatter ──────────────

  async function rebuildFromFiles(): Promise<void> {
    const directories = getKnownDirectories();
    let rebuilt = 0;

    for (const dir of directories) {
      const interviewDir = path.join(dir, config.outputFolder);
      let entries: string[];
      try {
        entries = await fs.readdir(interviewDir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;

        let content: string;
        try {
          content = await fs.readFile(path.join(interviewDir, entry), 'utf8');
        } catch {
          continue;
        }

        // Parse frontmatter for session ID
        const fm = parseFrontmatter(content);
        if (!fm?.sessionID) continue;

        // Extract title and summary using shared extractors
        const title = extractTitle(content) || entry.replace(/\.md$/, '');
        const summary = extractSummarySection(content);

        // Generate a stable interview ID from slugified filename
        const baseName = entry.replace(/\.md$/, '');
        const interviewId = `recovered-${slugify(baseName) || baseName}`;

        // Only add if not already in cache (sessions may have re-pushed)
        if (stateCache.has(interviewId)) continue;

        stateCache.set(interviewId, {
          interviewId,
          sessionID: fm.sessionID,
          idea: title,
          mode: 'session-disconnected',
          summary,
          title,
          questions: [],
          pendingAnswers: null,
          lastUpdatedAt: fm.updatedAt
            ? new Date(fm.updatedAt).getTime()
            : Date.now(),
          filePath: path.join(interviewDir, entry),
          nudgeAction: null,
        });

        // Also register the session directory
        if (!sessions.has(fm.sessionID)) {
          sessions.set(fm.sessionID, {
            sessionID: fm.sessionID,
            directory: dir,
            pid: 0,
            registeredAt: Date.now(),
          });
        }
        rebuilt++;
      }
    }

    if (rebuilt > 0) {
      fileCache = null;
      log(
        `[interview] dashboard: rebuilt ${rebuilt} interview(s) from files`,
        {},
      );
    }
  }

  // ─── Request Handler ─────────────────────────────────────────────

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? '127.0.0.1'}`,
    );
    const pathname = decodeURIComponent(url.pathname);

    // NOTE: No CORS headers. Same-origin only — dashboard pages and
    // API share the same origin (127.0.0.1:port). Cross-origin POST is
    // blocked by browser preflight since we don't send Access-Control
    // headers. Do NOT add them without also adding CSRF protection.

    // ── Health check (no auth required) ────────────────────────────
    if (request.method === 'GET' && pathname === '/api/health') {
      sendJson(response, 200, {
        status: 'ok',
        timestamp: Date.now(),
        sessions: sessions.size,
        interviews: stateCache.size,
      });
      return;
    }

    // ── API: settings (scan days, folders, discovery) ──────────────
    if (request.method === 'GET' && pathname === '/api/settings') {
      if (!isAuthenticated(request)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      sendJson(response, 200, {
        scanDays,
        folders: [...manualFolders],
        discoveredFolders: [...discoveredFolders],
        registeredSessions: sessions.size,
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/settings') {
      if (!isAuthenticated(request)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        sendJson(response, 400, { error: 'Invalid JSON' });
        return;
      }
      const data = body as {
        scanDays?: number;
        addFolder?: string;
        removeFolder?: string;
        discover?: boolean;
      };
      if (typeof data.scanDays === 'number' && data.scanDays >= 0) {
        scanDays = data.scanDays;
      }
      if (data.addFolder) {
        manualFolders.add(data.addFolder);
        fileCache = null;
      }
      if (data.removeFolder) {
        manualFolders.delete(data.removeFolder);
        fileCache = null;
      }
      if (data.discover) {
        await discoverSessionDirectories();
        fileCache = null;
        await rebuildFromFiles();
      }
      sendJson(response, 200, {
        scanDays,
        folders: [...manualFolders],
      });
      return;
    }

    // ── Dashboard UI ───────────────────────────────────────────────
    if (request.method === 'GET' && pathname === '/') {
      const files = await scanInterviewFiles();
      // Render actual interviews from state cache (not raw sessions)
      const activeInterviews: Array<{
        id: string;
        idea: string;
        status: 'active' | 'abandoned';
        mode: string;
        createdAt: string;
        url: string;
        resumeSlug: string;
      }> = [...stateCache.values()]
        .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
        .map((entry) => {
          const resumeSlug = extractResumeSlug(entry.interviewId);
          return {
            id: entry.interviewId,
            idea: entry.idea,
            status:
              entry.mode === 'session-disconnected'
                ? ('abandoned' as const)
                : ('active' as const),
            mode: entry.mode,
            createdAt: new Date(entry.lastUpdatedAt).toISOString(),
            url: `/interview/${entry.interviewId}`,
            resumeSlug,
          };
        });
      const outputFolder = config.outputFolder;
      setSessionCookie(response);
      sendHtml(
        response,
        renderDashboardPage(activeInterviews, files, outputFolder),
      );
      return;
    }

    // ── API: list sessions (auth required) ──────────────────────────
    if (request.method === 'GET' && pathname === '/api/sessions') {
      if (!isAuthenticated(request)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      const daysParam = url.searchParams.get('days');
      const days = daysParam ? Number.parseInt(daysParam, 10) : 3;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const result = [...sessions.values()]
        .filter((s) => s.registeredAt > cutoff)
        .map((s) => ({
          sessionID: s.sessionID,
          directory: s.directory,
          pid: s.pid,
        }));
      sendJson(response, 200, { sessions: result });
      return;
    }

    // ── API: list files (auth required) ─────────────────────────────
    if (request.method === 'GET' && pathname === '/api/files') {
      if (!isAuthenticated(request)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      const files = await scanInterviewFiles();
      sendJson(response, 200, { files });
      return;
    }

    // ── Auth gate for mutation endpoints ───────────────────────────
    if (request.method === 'POST' && !isAuthenticated(request)) {
      sendJson(response, 401, { error: 'Unauthorized' });
      return;
    }

    // ── API: register session ──────────────────────────────────────
    if (request.method === 'POST' && pathname === '/api/register') {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        sendJson(response, 400, { error: 'Invalid JSON' });
        return;
      }

      const { sessionID, directory, pid } = body as {
        sessionID?: string;
        directory?: string;
        pid?: number;
      };
      if (!sessionID || !directory || !isValidId(sessionID)) {
        sendJson(response, 400, {
          error: 'sessionID and directory required',
        });
        return;
      }

      sessions.set(sessionID, {
        sessionID,
        directory,
        pid: pid ?? 0,
        registeredAt: Date.now(),
      });
      fileCache = null; // invalidate
      sendJson(response, 200, { status: 'registered' });
      return;
    }

    // ── API: create interview ──────────────────────────────────────
    if (request.method === 'POST' && pathname === '/api/interviews') {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        sendJson(response, 400, { error: 'Invalid JSON' });
        return;
      }

      const { interviewId, sessionID, idea } = body as {
        interviewId?: string;
        sessionID?: string;
        idea?: string;
      };
      if (!interviewId || !sessionID || !idea || !isValidId(interviewId)) {
        sendJson(response, 400, {
          error: 'interviewId, sessionID, and idea required',
        });
        return;
      }

      stateCache.set(interviewId, {
        interviewId,
        sessionID,
        idea,
        mode: 'awaiting-agent',
        summary: 'Interview created.',
        title: idea,
        questions: [],
        pendingAnswers: null,
        lastUpdatedAt: Date.now(),
        filePath: '',
        nudgeAction: null,
      });
      fileCache = null;

      const interviewUrl = `${baseUrl}/interview/${interviewId}`;
      sendJson(response, 200, {
        interviewId,
        url: interviewUrl,
      });
      return;
    }

    // ── API: push state (session → dashboard) ──────────────────────
    if (
      request.method === 'POST' &&
      pathname.startsWith('/api/interviews/') &&
      pathname.endsWith('/state')
    ) {
      const interviewId = pathname
        .replace('/api/interviews/', '')
        .replace('/state', '');
      if (!interviewId || !isValidId(interviewId)) {
        sendJson(response, 400, { error: 'Invalid interview ID' });
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        sendJson(response, 400, { error: 'Invalid JSON' });
        return;
      }

      const state = body as Partial<InterviewStateEntry>;
      const existing = stateCache.get(interviewId);
      if (existing) {
        // Merge state update
        if (state.mode) existing.mode = state.mode;
        if (state.summary) existing.summary = state.summary;
        if (state.title) existing.title = state.title;
        if (state.questions) existing.questions = state.questions;
        if (state.filePath) existing.filePath = state.filePath;
        existing.lastUpdatedAt = Date.now();
      } else {
        // New entry
        stateCache.set(interviewId, {
          interviewId,
          sessionID: state.sessionID ?? '',
          idea: state.idea ?? '',
          mode: state.mode ?? 'awaiting-agent',
          summary: state.summary ?? '',
          title: state.title ?? '',
          questions: state.questions ?? [],
          pendingAnswers: null,
          lastUpdatedAt: Date.now(),
          filePath: state.filePath ?? '',
          nudgeAction: null,
        });
      }

      sendJson(response, 200, { status: 'ok' });
      return;
    }

    // ── API: get state (dashboard → browser poll, auth required) ───
    if (
      request.method === 'GET' &&
      pathname.startsWith('/api/interviews/') &&
      pathname.endsWith('/state')
    ) {
      if (!isAuthenticated(request)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      const interviewId = pathname
        .replace('/api/interviews/', '')
        .replace('/state', '');
      if (!isValidId(interviewId)) {
        sendJson(response, 400, { error: 'Invalid interview ID' });
        return;
      }
      const entry = stateCache.get(interviewId);
      if (!entry) {
        sendJson(response, 404, { error: 'Interview not found' });
        return;
      }

      // Read .md document from disk for completed/disconnected interviews
      let document = '';
      let markdownPath = entry.filePath;
      if (entry.filePath) {
        try {
          document = await fs.readFile(entry.filePath, 'utf8');
        } catch {
          // File may not exist yet
        }
      } else {
        // Fallback: try to find file in known session directories
        const dirs = getKnownDirectories();
        for (const dir of dirs) {
          const slug = extractResumeSlug(interviewId);
          const candidate = path.join(dir, config.outputFolder, `${slug}.md`);
          try {
            document = await fs.readFile(candidate, 'utf8');
            markdownPath = candidate;
            entry.filePath = candidate;
            break;
          } catch {
            // Not in this directory
          }
        }
      }

      // Use just the filename to avoid leaking absolute paths
      const displayPath = markdownPath
        ? markdownPath.split('/').pop() || markdownPath
        : 'interview.md';

      sendJson(response, 200, {
        interview: {
          id: entry.interviewId,
          sessionID: entry.sessionID,
          idea: entry.idea,
          markdownPath: displayPath,
          createdAt: new Date(entry.lastUpdatedAt).toISOString(),
          status:
            entry.mode === 'session-disconnected'
              ? ('abandoned' as const)
              : ('active' as const),
          baseMessageCount: 0, // Unknown for recovered entries
        },
        url: `${baseUrl}/interview/${entry.interviewId}`,
        markdownPath,
        mode: entry.mode,
        isBusy: entry.mode === 'awaiting-agent',
        summary: entry.summary,
        questions: entry.questions,
        document,
        lastUpdatedAt: entry.lastUpdatedAt,
        nudgeAction: entry.nudgeAction,
      });
      return;
    }

    // ── API: submit answers (browser → dashboard) ──────────────────
    if (
      request.method === 'POST' &&
      pathname.startsWith('/api/interviews/') &&
      pathname.endsWith('/answers')
    ) {
      const interviewId = pathname
        .replace('/api/interviews/', '')
        .replace('/answers', '');
      if (!isValidId(interviewId)) {
        sendJson(response, 400, { error: 'Invalid interview ID' });
        return;
      }
      const entry = stateCache.get(interviewId);
      if (!entry) {
        sendJson(response, 404, { error: 'Interview not found' });
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        sendJson(response, 400, { error: 'Invalid JSON' });
        return;
      }

      const { answers } = body as {
        answers?: Array<{ questionId: string; answer: string }>;
      };
      if (!Array.isArray(answers)) {
        sendJson(response, 400, { error: 'answers array required' });
        return;
      }

      entry.pendingAnswers = answers;
      entry.mode = 'awaiting-agent';
      entry.lastUpdatedAt = Date.now();
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    // ── API: get pending answers (session polls, auth required) ────
    if (
      request.method === 'GET' &&
      pathname.startsWith('/api/interviews/') &&
      pathname.endsWith('/pending')
    ) {
      if (!isAuthenticated(request)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      const interviewId = pathname
        .replace('/api/interviews/', '')
        .replace('/pending', '');
      if (!isValidId(interviewId)) {
        sendJson(response, 400, { error: 'Invalid interview ID' });
        return;
      }
      const entry = stateCache.get(interviewId);
      if (!entry) {
        sendJson(response, 404, { error: 'Interview not found' });
        return;
      }
      // Atomically consume pending answers (like nudge pattern)
      const answers = entry.pendingAnswers;
      if (answers) {
        entry.pendingAnswers = null;
      }
      sendJson(response, 200, {
        answers,
      });
      return;
    }

    // ── API: nudge agent (browser → dashboard) ────────────────────
    if (
      request.method === 'POST' &&
      pathname.startsWith('/api/interviews/') &&
      pathname.endsWith('/nudge')
    ) {
      if (!isAuthenticated(request)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }

      const interviewId = pathname
        .replace('/api/interviews/', '')
        .replace('/nudge', '');
      if (!isValidId(interviewId)) {
        sendJson(response, 400, { error: 'Invalid interview ID' });
        return;
      }
      const entry = stateCache.get(interviewId);
      if (!entry) {
        sendJson(response, 404, { error: 'Interview not found' });
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        sendJson(response, 400, { error: 'Invalid JSON' });
        return;
      }

      const { action } = body as {
        action?: 'more-questions' | 'confirm-complete';
      };
      if (action !== 'more-questions' && action !== 'confirm-complete') {
        sendJson(response, 400, {
          error: 'action must be "more-questions" or "confirm-complete"',
        });
        return;
      }

      entry.nudgeAction = action;
      entry.mode = 'awaiting-agent';
      entry.lastUpdatedAt = Date.now();
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    // ── API: get nudge action (session polls, auth required) ──────
    if (
      request.method === 'GET' &&
      pathname.startsWith('/api/interviews/') &&
      pathname.endsWith('/nudge')
    ) {
      if (!isAuthenticated(request)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      const interviewId = pathname
        .replace('/api/interviews/', '')
        .replace('/nudge', '');
      if (!isValidId(interviewId)) {
        sendJson(response, 400, { error: 'Invalid interview ID' });
        return;
      }
      const entry = stateCache.get(interviewId);
      if (!entry) {
        sendJson(response, 404, { error: 'Interview not found' });
        return;
      }
      const action = entry.nudgeAction;
      if (action) {
        entry.nudgeAction = null; // Clear after reading
      }
      sendJson(response, 200, { action });
      return;
    }

    // ── Interview page ─────────────────────────────────────────────
    if (request.method === 'GET' && pathname.startsWith('/interview/')) {
      const interviewId = pathname.replace('/interview/', '');
      if (!isValidId(interviewId)) {
        sendJson(response, 400, { error: 'Invalid interview ID' });
        return;
      }
      const entry = stateCache.get(interviewId);
      if (!entry) {
        sendJson(response, 404, { error: 'Interview not found' });
        return;
      }
      const resumeSlug = extractResumeSlug(interviewId);
      setSessionCookie(response);
      sendHtml(response, renderInterviewPage(interviewId, resumeSlug));
      return;
    }

    // ── 404 ────────────────────────────────────────────────────────
    sendJson(response, 404, { error: 'Not found' });
  }

  // ─── Server Lifecycle ────────────────────────────────────────────

  function start(): Promise<string> {
    if (baseUrl) return Promise.resolve(baseUrl);

    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        handleRequest(request, response).catch((error: unknown) => {
          sendJson(response, 500, {
            error:
              error instanceof Error ? error.message : 'Internal server error',
          });
        });
      });

      server.requestTimeout = 30_000;
      server.headersTimeout = 10_000;

      server.on('error', (error: NodeJS.ErrnoException) => {
        server.close();
        if (error.code === 'EADDRINUSE') {
          reject(new Error(`Dashboard port ${config.port} is already in use.`));
        } else {
          reject(error);
        }
      });

      server.listen(config.port, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to start dashboard server'));
          return;
        }
        activeServer = server;
        baseUrl = `http://127.0.0.1:${address.port}`;
        writeAuthFile(config.port, authToken);
        resolve(baseUrl);
      });
    });
  }

  function close(): void {
    if (activeServer) {
      removeAuthFile(config.port);
      activeServer.closeAllConnections();
      activeServer.close();
      activeServer = null;
      baseUrl = null;
    }
  }

  // ─── Public API ──────────────────────────────────────────────────

  return {
    start,
    close,
    registerSession: (info) => {
      const wasEmpty = sessions.size === 0;
      sessions.set(info.sessionID, info);
      fileCache = null;
      // Rebuild from files when first session registers (failover recovery)
      if (wasEmpty) {
        rebuildFromFiles().catch(() => {});
      }
    },
    removeSession: (sessionID: string) => {
      sessions.delete(sessionID);
      fileCache = null;
    },
    pushState: (entry: InterviewStateEntry) => {
      // Preserve browser-submitted data that the session doesn't know about
      const existing = stateCache.get(entry.interviewId);
      if (existing) {
        if (existing.pendingAnswers)
          entry.pendingAnswers ??= existing.pendingAnswers;
        if (existing.nudgeAction) entry.nudgeAction ??= existing.nudgeAction;
      }
      stateCache.set(entry.interviewId, entry);
    },
    getState: (id) => stateCache.get(id),
    storeAnswers: (id, answers) => {
      const entry = stateCache.get(id);
      if (entry) {
        entry.pendingAnswers = answers;
        entry.mode = 'awaiting-agent';
        entry.lastUpdatedAt = Date.now();
      }
    },
    getPendingAnswers: (id) => stateCache.get(id)?.pendingAnswers ?? null,
    consumePendingAnswers: (id) => {
      const entry = stateCache.get(id);
      if (!entry?.pendingAnswers) return null;
      const answers = entry.pendingAnswers;
      entry.pendingAnswers = null;
      return answers;
    },
    consumeNudgeAction: (id) => {
      const entry = stateCache.get(id);
      if (!entry?.nudgeAction) return null;
      const action = entry.nudgeAction;
      entry.nudgeAction = null;
      return action;
    },
    authToken,
    discoverSessionDirectories,
    addManualFolder: (dir: string) => {
      manualFolders.add(dir);
      fileCache = null;
    },
    removeManualFolder: (dir: string) => {
      manualFolders.delete(dir);
      fileCache = null;
    },
    getManualFolders: () => [...manualFolders],
    setScanDays: (days: number) => {
      scanDays = days;
    },
    getScanDays: () => scanDays,
    refreshFiles: () => {
      fileCache = null;
      return rebuildFromFiles();
    },
  };
}

// ─── Health Probe (for session processes) ─────────────────────────────

export async function probeDashboard(
  port: number,
): Promise<{ alive: boolean; timestamp: number }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return { alive: false, timestamp: 0 };
    const data = (await response.json()) as {
      status: string;
      timestamp: number;
    };
    return {
      alive: data.status === 'ok',
      timestamp: data.timestamp,
    };
  } catch {
    return { alive: false, timestamp: 0 };
  }
}

// ─── Try Become Dashboard (with jitter retry) ─────────────────────────

export async function tryBecomeDashboard(
  config: DashboardConfig,
  maxAttempts = 3,
): Promise<ReturnType<typeof createDashboardServer> | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // First, probe if a dashboard is already running
    const probe = await probeDashboard(config.port);
    if (probe.alive) {
      return null; // Dashboard already running, we're a session
    }

    // Try to bind the port
    const dashboard = createDashboardServer(config);
    try {
      await dashboard.start();
      return dashboard;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('already in use')) {
        // Another process won the race, wait with jitter and retry
        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, jitterMs()));
          continue;
        }
        return null; // All retries exhausted — treat as session
      }
      throw error;
    }
  }

  return null;
}
