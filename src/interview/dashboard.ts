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
import type { PluginInput } from '@opencode-ai/plugin';
import { log } from '../utils';
import {
  extractSummarySection,
  extractTitle,
  parseFrontmatter,
  parseSpecBlocks,
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
    // Check if the PID is still alive - stale file from crashed dashboard
    try {
      process.kill(data.pid, 0); // signal 0 = existence check, no actual signal
    } catch {
      // PID doesn't exist - stale auth file from crashed dashboard
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

/**
 * When a live interview is created or pushes state, remove any stale
 * recovered- entry for the same slug.  Called from three code paths:
 * HTTP create, HTTP state-push, and in-process pushState.
 */
function dedupRecovered(
  interviewId: string,
  cache: Map<string, InterviewStateEntry>,
): void {
  if (interviewId.startsWith('recovered-')) return;
  const slug = extractResumeSlug(interviewId);
  if (!slug) return;
  const recoveredKey = `recovered-${slug}`;
  if (cache.has(recoveredKey)) {
    cache.delete(recoveredKey);
  }
}

/**
 * Check whether the cache already contains a live (non-recovered) entry
 * whose slug matches the given one.  Used by rebuildFromFiles to skip
 * adding a recovered entry when a live session already covers it.
 */
function hasLiveForSlug(
  slug: string,
  cache: Map<string, InterviewStateEntry>,
): boolean {
  return [...cache.values()].some(
    (e) =>
      !e.interviewId.startsWith('recovered-') &&
      extractResumeSlug(e.interviewId) === slug,
  );
}

// ─── Types ────────────────────────────────────────────────────────────

interface RegisteredSession {
  sessionID: string;
  directory: string;
  pid: number;
  registeredAt: number;
}

type PendingKind = 'answers' | 'nudge' | 'block-comment' | 'chat';

interface PendingClaim {
  claimId: string;
  kind: PendingKind;
}

// ─── Config ───────────────────────────────────────────────────────────

export const DEFAULT_DASHBOARD_PORT = 43211;

export interface DashboardConfig {
  port: number;
  outputFolder: string;
  sessionClient?: Pick<PluginInput['client']['session'], 'list'>;
  /** Already-listening server to adopt instead of binding `port`. */
  server?: Server;
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
  claimPendingAnswers: (interviewId: string) => {
    claimId: string;
    answers: Array<{ questionId: string; answer: string }>;
  } | null;
  claimNudgeAction: (interviewId: string) => {
    claimId: string;
    action: 'more-questions' | 'confirm-complete';
  } | null;
  claimBlockComment: (interviewId: string) => {
    claimId: string;
    comment: { section: string; comment: string };
  } | null;
  claimChatMessage: (interviewId: string) => {
    claimId: string;
    message: string;
  } | null;
  acknowledgePending: (
    interviewId: string,
    kind: PendingKind,
    claimId: string,
  ) => boolean;
  rollbackPending: (
    interviewId: string,
    kind: PendingKind,
    claimId: string,
  ) => boolean;
  consumePendingAnswers: (
    interviewId: string,
  ) => Array<{ questionId: string; answer: string }> | null;
  consumeNudgeAction: (
    interviewId: string,
  ) => 'more-questions' | 'confirm-complete' | null;
  consumeBlockComment: (
    interviewId: string,
  ) => { section: string; comment: string } | null;
  consumeChatMessage: (interviewId: string) => string | null;
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
  let pendingServer: Server | null = null;
  let baseUrl: string | null = null;
  let startPromise: Promise<string> | null = null;
  let closed = false;

  // Session registry
  const sessions = new Map<string, RegisteredSession>();

  // Interview state cache
  const stateCache = new Map<string, InterviewStateEntry>();
  const pendingClaims = new Map<string, PendingClaim>();
  let claimCounter = 0;

  function claimKey(interviewId: string, kind: PendingKind): string {
    return `${interviewId}:${kind}`;
  }

  function getOrCreateClaim(
    interviewId: string,
    kind: PendingKind,
  ): PendingClaim {
    const key = claimKey(interviewId, kind);
    const existing = pendingClaims.get(key);
    if (existing) {
      return existing;
    }

    const claim = { claimId: `delivery-${++claimCounter}`, kind };
    pendingClaims.set(key, claim);
    return claim;
  }

  function acknowledgePending(
    interviewId: string,
    kind: PendingKind,
    claimId: string,
  ): boolean {
    const key = claimKey(interviewId, kind);
    const claim = pendingClaims.get(key);
    if (!claim || claim.claimId !== claimId) return false;
    const entry = stateCache.get(interviewId);
    if (!entry) return false;
    pendingClaims.delete(key);
    if (kind === 'answers') entry.pendingAnswers = null;
    if (kind === 'nudge') entry.nudgeAction = null;
    if (kind === 'block-comment') entry.pendingBlockComment = null;
    if (kind === 'chat') entry.pendingChatMessage = null;
    entry.lastUpdatedAt = Date.now();
    return true;
  }

  function rollbackPending(
    interviewId: string,
    kind: PendingKind,
    claimId: string,
  ): boolean {
    const key = claimKey(interviewId, kind);
    const claim = pendingClaims.get(key);
    if (!claim || claim.claimId !== claimId) return false;
    pendingClaims.delete(key);
    return true;
  }

  // SSE client registry: interviewId → Set<ServerResponse>
  const sseClients = new Map<string, Set<import('node:http').ServerResponse>>();
  const sseHeartbeats = new Map<
    import('node:http').ServerResponse,
    ReturnType<typeof setInterval>
  >();

  function removeSseClient(
    interviewId: string,
    response: ServerResponse,
  ): void {
    const heartbeat = sseHeartbeats.get(response);
    if (heartbeat) {
      clearInterval(heartbeat);
      sseHeartbeats.delete(response);
    }

    const clients = sseClients.get(interviewId);
    clients?.delete(response);
    if (clients && clients.size === 0) sseClients.delete(interviewId);
  }

  function formatSseState(entry: InterviewStateEntry) {
    const markdownPath = entry.filePath;
    const displayPath = markdownPath
      ? markdownPath.split('/').pop() || markdownPath
      : 'interview.md';
    const document = entry.document ?? '';

    return {
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
        baseMessageCount: 0,
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
      blocks: entry.blocks ?? parseSpecBlocks(document),
    };
  }

  function broadcastSse(interviewId: string, entry: InterviewStateEntry) {
    const clients = sseClients.get(interviewId);
    if (!clients || clients.size === 0) return;
    const payload = `event: state\ndata: ${JSON.stringify(formatSseState(entry))}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        removeSseClient(interviewId, res);
      }
    }
    if (clients.size === 0) sseClients.delete(interviewId);
  }

  // Periodic cleanup: remove terminal entries older than 24h
  const TERMINAL_MODES = new Set([
    'abandoned',
    'completed',
    'session-disconnected',
  ]);
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
  function createCleanupTimer(): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      const cutoff = Date.now() - CACHE_TTL_MS;
      for (const [id, entry] of stateCache) {
        if (TERMINAL_MODES.has(entry.mode) && entry.lastUpdatedAt < cutoff) {
          stateCache.delete(id);
        }
      }
    }, CLEANUP_INTERVAL_MS);
    timer.unref();
    return timer;
  }

  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

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
    // Always scan home directory - interviews may have been created from a
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
      const result = await config.sessionClient.list({ query: {} });
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
      // Session list not available - rely on registered sessions
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
        const fm = parseFrontmatter(content);

        items.push({
          fileName: entry,
          resumeCommand: `/interview ${baseName}`,
          title,
          summary:
            summary.length > 120 ? `${summary.slice(0, 120)}\u2026` : summary,
          sessionID: fm?.sessionID,
          directory: dir,
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

        // Also skip if a live interview already covers this slug.
        const slug = slugify(baseName) || baseName;
        if (hasLiveForSlug(slug, stateCache)) continue;

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
          pendingBlockComment: null,
          pendingChatMessage: null,
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

    // NOTE: No CORS headers. Same-origin only - dashboard pages and
    // API share the same origin (127.0.0.1:port). Cross-origin POST is
    // blocked by browser preflight since we don't send Access-Control
    // headers. Do NOT add them without also adding CSRF protection.

    // ── Health check (no auth required) ────────────────────────────
    if (request.method === 'GET' && pathname === '/api/health') {
      // Stable signature: changes only when stateCache or session count changes
      const sig = [...stateCache.values()]
        .map((e) => `${e.interviewId}:${e.mode}:${e.lastUpdatedAt}`)
        .sort()
        .join('|');
      sendJson(response, 200, {
        status: 'ok',
        sessions: sessions.size,
        interviews: stateCache.size,
        sig,
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
        sessionID?: string;
        directory?: string;
      }> = [...stateCache.values()]
        .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
        .map((entry) => {
          const resumeSlug = extractResumeSlug(entry.interviewId);
          const session = entry.sessionID
            ? sessions.get(entry.sessionID)
            : undefined;
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
            sessionID: entry.sessionID,
            directory: session?.directory,
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

    // ── API: unregister session ────────────────────────────────────
    if (request.method === 'POST' && pathname === '/api/unregister') {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        sendJson(response, 400, { error: 'Invalid JSON' });
        return;
      }
      const { sessionID } = body as { sessionID?: string };
      if (!sessionID || !isValidId(sessionID)) {
        sendJson(response, 400, { error: 'sessionID required' });
        return;
      }
      sessions.delete(sessionID);
      for (const [id, entry] of stateCache) {
        if (entry.sessionID === sessionID) stateCache.delete(id);
      }
      fileCache = null;
      sendJson(response, 200, { status: 'unregistered' });
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
        pendingBlockComment: null,
        pendingChatMessage: null,
      });
      dedupRecovered(interviewId, stateCache);
      fileCache = null;

      const interviewUrl = `${baseUrl}/interview/${interviewId}`;
      sendJson(response, 200, {
        interviewId,
        url: interviewUrl,
      });
      return;
    }

    // ── API: SSE stream (browser → dashboard, real-time push) ────────
    if (
      request.method === 'GET' &&
      pathname.startsWith('/api/interviews/') &&
      pathname.endsWith('/events')
    ) {
      const interviewId = pathname
        .replace('/api/interviews/', '')
        .replace('/events', '');
      if (!interviewId || !isValidId(interviewId)) {
        sendJson(response, 400, { error: 'Invalid interview ID' });
        return;
      }
      const entry = stateCache.get(interviewId);
      if (!entry) {
        sendJson(response, 404, { error: 'Interview not found' });
        return;
      }

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });

      // Register this client
      let clients = sseClients.get(interviewId);
      if (!clients) {
        clients = new Set();
        sseClients.set(interviewId, clients);
      }
      clients.add(response);

      // Send initial state immediately
      response.write(
        `event: state\ndata: ${JSON.stringify(formatSseState(entry))}\n\n`,
      );

      // Heartbeat every 15s to keep connection alive
      const heartbeat = setInterval(() => {
        try {
          response.write(': hb\n\n');
        } catch {
          // will be cleaned up on close
        }
      }, 15000);
      sseHeartbeats.set(response, heartbeat);

      // Cleanup on disconnect
      request.on('close', () => {
        removeSseClient(interviewId, response);
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
        if (state.document !== undefined) existing.document = state.document;
        if (state.blocks !== undefined) existing.blocks = state.blocks;
        existing.lastUpdatedAt = Date.now();
        dedupRecovered(interviewId, stateCache);
        broadcastSse(interviewId, existing);
      } else {
        // New entry
        const entry: InterviewStateEntry = {
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
          pendingBlockComment: state.pendingBlockComment ?? null,
          pendingChatMessage: state.pendingChatMessage ?? null,
          document: state.document,
          blocks: state.blocks,
        };
        stateCache.set(interviewId, entry);
        broadcastSse(interviewId, entry);
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
        blocks: parseSpecBlocks(document),
      });
      return;
    }

    // ── API: acknowledge or roll back a claimed delivery ────────────
    const deliveryMatch = pathname.match(
      /^\/api\/interviews\/([^/]+)\/(pending|nudge|block-comment|chat)\/(ack|rollback)$/,
    );
    if (request.method === 'POST' && deliveryMatch) {
      const interviewId = deliveryMatch[1];
      const kind =
        deliveryMatch[2] === 'pending'
          ? 'answers'
          : (deliveryMatch[2] as PendingKind);
      const operation = deliveryMatch[3];
      if (!isValidId(interviewId)) {
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
      const claimId = (body as { claimId?: unknown }).claimId;
      if (typeof claimId !== 'string' || !claimId) {
        sendJson(response, 400, { error: 'claimId required' });
        return;
      }
      const accepted =
        operation === 'ack'
          ? acknowledgePending(interviewId, kind, claimId)
          : rollbackPending(interviewId, kind, claimId);
      if (!accepted) {
        sendJson(response, 409, { error: 'Unknown or stale delivery claim' });
        return;
      }
      sendJson(response, 200, {
        status: operation === 'ack' ? 'acked' : 'rolled-back',
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
      if (
        !Array.isArray(answers) ||
        answers.length === 0 ||
        !answers.every(
          (a) =>
            typeof a === 'object' &&
            a !== null &&
            typeof a.questionId === 'string' &&
            typeof a.answer === 'string',
        )
      ) {
        sendJson(response, 400, {
          error:
            'answers array required, each item must have string questionId and answer',
        });
        return;
      }

      if (
        entry.pendingAnswers ||
        pendingClaims.has(claimKey(interviewId, 'answers'))
      ) {
        sendJson(response, 409, { error: 'Answers are already queued.' });
        return;
      }
      entry.pendingAnswers = answers;
      entry.mode = 'awaiting-agent';
      entry.lastUpdatedAt = Date.now();
      sendJson(response, 202, { status: 'queued' });
      return;
    }

    // ── API: submit block comment (browser → dashboard) ────────────
    if (
      request.method === 'POST' &&
      pathname.startsWith('/api/interviews/') &&
      pathname.endsWith('/block-comment')
    ) {
      if (!isAuthenticated(request)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      const interviewId = pathname
        .replace('/api/interviews/', '')
        .replace('/block-comment', '');
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

      const { section, comment } = body as {
        section?: string;
        comment?: string;
      };
      if (typeof section !== 'string' || typeof comment !== 'string') {
        sendJson(response, 400, {
          error: 'section and comment must be strings',
        });
        return;
      }

      if (
        entry.pendingBlockComment ||
        pendingClaims.has(claimKey(interviewId, 'block-comment'))
      ) {
        sendJson(response, 409, { error: 'Block feedback is already queued.' });
        return;
      }
      entry.pendingBlockComment = { section, comment };
      entry.mode = 'awaiting-agent';
      entry.lastUpdatedAt = Date.now();
      sendJson(response, 202, { status: 'queued' });
      return;
    }

    // ── API: get pending block comment (session polls, auth required) ─
    if (
      request.method === 'GET' &&
      pathname.startsWith('/api/interviews/') &&
      pathname.endsWith('/block-comment')
    ) {
      if (!isAuthenticated(request)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      const interviewId = pathname
        .replace('/api/interviews/', '')
        .replace('/block-comment', '');
      if (!isValidId(interviewId)) {
        sendJson(response, 400, { error: 'Invalid interview ID' });
        return;
      }
      const entry = stateCache.get(interviewId);
      if (!entry) {
        sendJson(response, 404, { error: 'Interview not found' });
        return;
      }
      const val = entry.pendingBlockComment
        ? {
            claimId: getOrCreateClaim(interviewId, 'block-comment').claimId,
            section: entry.pendingBlockComment.section,
            comment: entry.pendingBlockComment.comment,
          }
        : null;
      sendJson(response, 200, val ?? {});
      return;
    }

    // ── API: submit chat message (browser → dashboard) ──────────────
    if (
      request.method === 'POST' &&
      pathname.startsWith('/api/interviews/') &&
      pathname.endsWith('/chat')
    ) {
      if (!isAuthenticated(request)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      const interviewId = pathname
        .replace('/api/interviews/', '')
        .replace('/chat', '');
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

      const { message } = body as { message?: string };
      if (typeof message !== 'string' || !message.trim()) {
        sendJson(response, 400, {
          error: 'message must be a non-empty string',
        });
        return;
      }

      if (
        entry.pendingChatMessage ||
        pendingClaims.has(claimKey(interviewId, 'chat'))
      ) {
        sendJson(response, 409, { error: 'Chat message is already queued.' });
        return;
      }
      entry.pendingChatMessage = message.trim();
      entry.mode = 'awaiting-agent';
      entry.lastUpdatedAt = Date.now();
      sendJson(response, 202, { status: 'queued' });
      return;
    }

    // ── API: get pending chat message (session polls, auth required) ─
    if (
      request.method === 'GET' &&
      pathname.startsWith('/api/interviews/') &&
      pathname.endsWith('/chat')
    ) {
      if (!isAuthenticated(request)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }
      const interviewId = pathname
        .replace('/api/interviews/', '')
        .replace('/chat', '');
      if (!isValidId(interviewId)) {
        sendJson(response, 400, { error: 'Invalid interview ID' });
        return;
      }
      const entry = stateCache.get(interviewId);
      if (!entry) {
        sendJson(response, 404, { error: 'Interview not found' });
        return;
      }
      const val = entry.pendingChatMessage
        ? {
            claimId: getOrCreateClaim(interviewId, 'chat').claimId,
            message: entry.pendingChatMessage,
          }
        : null;
      sendJson(response, 200, val ?? { message: null });
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
      const claimed = entry.pendingAnswers
        ? {
            claimId: getOrCreateClaim(interviewId, 'answers').claimId,
            answers: entry.pendingAnswers,
          }
        : null;
      sendJson(response, 200, {
        claimId: claimed?.claimId ?? null,
        answers: claimed?.answers ?? null,
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

      if (
        entry.nudgeAction ||
        pendingClaims.has(claimKey(interviewId, 'nudge'))
      ) {
        sendJson(response, 409, { error: 'Nudge action is already queued.' });
        return;
      }
      entry.nudgeAction = action;
      entry.mode = 'awaiting-agent';
      entry.lastUpdatedAt = Date.now();
      sendJson(response, 202, { status: 'queued' });
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
      const claimed = entry.nudgeAction
        ? {
            claimId: getOrCreateClaim(interviewId, 'nudge').claimId,
            action: entry.nudgeAction,
          }
        : null;
      sendJson(response, 200, {
        claimId: claimed?.claimId ?? null,
        action: claimed?.action ?? null,
      });
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

  function closeServer(server: Server): void {
    server.closeAllConnections();
    try {
      server.close();
    } catch {
      // The server may still be in the listen transition.
    }
  }

  function start(): Promise<string> {
    if (baseUrl) return Promise.resolve(baseUrl);
    if (closed) return Promise.reject(new Error('Dashboard server is closed.'));
    if (startPromise) return startPromise;

    if (!cleanupTimer) {
      cleanupTimer = createCleanupTimer();
    }

    startPromise = new Promise((resolve, reject) => {
      const requestHandler = (
        request: IncomingMessage,
        response: ServerResponse,
      ) => {
        handleRequest(request, response).catch((error: unknown) => {
          sendJson(response, 500, {
            error:
              error instanceof Error ? error.message : 'Internal server error',
          });
        });
      };

      // Adopt an already-listening server (deterministic port ownership)
      // or bind a fresh one on config.port.
      const server = config.server ?? createServer(requestHandler);

      server.requestTimeout = 30_000;
      server.headersTimeout = 10_000;

      server.on('error', (error: NodeJS.ErrnoException) => {
        closeServer(server);
        pendingServer = null;
        if (error.code === 'EADDRINUSE') {
          reject(new Error(`Dashboard port ${config.port} is already in use.`));
        } else {
          reject(error);
        }
      });

      if (config.server) {
        // Adoption path: already listening. Swap the placeholder handler
        // for the dashboard handler and read the port from the address.
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to start dashboard server'));
          return;
        }
        server.removeAllListeners('request');
        server.on('request', requestHandler);
        activeServer = server;
        baseUrl = `http://127.0.0.1:${address.port}`;
        if (closed) {
          activeServer = null;
          baseUrl = null;
          closeServer(server);
          reject(new Error('Dashboard server is closed.'));
          return;
        }
        writeAuthFile(config.port, authToken);
        resolve(baseUrl);
        return;
      }

      pendingServer = server;
      server.listen(config.port, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          pendingServer = null;
          reject(new Error('Failed to start dashboard server'));
          return;
        }
        activeServer = server;
        pendingServer = null;
        baseUrl = `http://127.0.0.1:${address.port}`;
        if (closed) {
          activeServer = null;
          baseUrl = null;
          closeServer(server);
          reject(new Error('Dashboard server is closed.'));
          return;
        }
        writeAuthFile(config.port, authToken);
        resolve(baseUrl);
      });
    });

    startPromise.catch(() => {
      startPromise = null;
    });
    return startPromise;
  }

  function close(): void {
    if (closed) return;
    closed = true;

    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }

    for (const clients of sseClients.values()) {
      for (const response of clients) {
        const heartbeat = sseHeartbeats.get(response);
        if (heartbeat) {
          clearInterval(heartbeat);
          sseHeartbeats.delete(response);
        }
        try {
          if (!response.writableEnded && !response.destroyed) {
            response.end();
          }
        } catch {
          try {
            response.destroy();
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    }

    sseClients.clear();
    pendingClaims.clear();

    removeAuthFile(config.port);

    const server = activeServer ?? pendingServer;
    activeServer = null;
    pendingServer = null;
    baseUrl = null;
    if (server) {
      closeServer(server);
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
      // Clean up stateCache entries belonging to this session
      for (const [id, entry] of stateCache) {
        if (entry.sessionID === sessionID) {
          stateCache.delete(id);
          for (const kind of [
            'answers',
            'nudge',
            'block-comment',
            'chat',
          ] as PendingKind[]) {
            pendingClaims.delete(claimKey(id, kind));
          }
        }
      }
      fileCache = null;
    },
    pushState: (entry: InterviewStateEntry) => {
      // Preserve browser-submitted data that the session doesn't know about
      const existing = stateCache.get(entry.interviewId);
      if (existing) {
        if (existing.pendingAnswers)
          entry.pendingAnswers ??= existing.pendingAnswers;
        if (existing.nudgeAction) entry.nudgeAction ??= existing.nudgeAction;
        if (existing.pendingBlockComment)
          entry.pendingBlockComment ??= existing.pendingBlockComment;
        if (existing.pendingChatMessage)
          entry.pendingChatMessage ??= existing.pendingChatMessage;
        if (entry.document === undefined && existing.document !== undefined) {
          entry.document = existing.document;
        }
        if (entry.blocks === undefined && existing.blocks !== undefined) {
          entry.blocks = existing.blocks;
        }
      }
      stateCache.set(entry.interviewId, entry);
      dedupRecovered(entry.interviewId, stateCache);
      broadcastSse(entry.interviewId, entry);
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
    claimPendingAnswers: (id) => {
      const entry = stateCache.get(id);
      if (!entry?.pendingAnswers) return null;
      const claim = getOrCreateClaim(id, 'answers');
      return { claimId: claim.claimId, answers: entry.pendingAnswers };
    },
    claimNudgeAction: (id) => {
      const entry = stateCache.get(id);
      if (!entry?.nudgeAction) return null;
      const claim = getOrCreateClaim(id, 'nudge');
      return { claimId: claim.claimId, action: entry.nudgeAction };
    },
    claimBlockComment: (id) => {
      const entry = stateCache.get(id);
      if (!entry?.pendingBlockComment) return null;
      const claim = getOrCreateClaim(id, 'block-comment');
      return { claimId: claim.claimId, comment: entry.pendingBlockComment };
    },
    claimChatMessage: (id) => {
      const entry = stateCache.get(id);
      if (!entry?.pendingChatMessage) return null;
      const claim = getOrCreateClaim(id, 'chat');
      return { claimId: claim.claimId, message: entry.pendingChatMessage };
    },
    acknowledgePending,
    rollbackPending,
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
    consumeBlockComment: (id: string) => {
      const entry = stateCache.get(id);
      if (!entry?.pendingBlockComment) return null;
      const comment = entry.pendingBlockComment;
      entry.pendingBlockComment = null;
      return comment;
    },
    consumeChatMessage: (id: string) => {
      const entry = stateCache.get(id);
      if (!entry?.pendingChatMessage) return null;
      const message = entry.pendingChatMessage;
      entry.pendingChatMessage = null;
      return message;
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
        dashboard.close();
        // Another process won the race, wait with jitter and retry
        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, jitterMs()));
          continue;
        }
        return null; // All retries exhausted - treat as session
      }
      dashboard.close();
      throw error;
    }
  }

  return null;
}
