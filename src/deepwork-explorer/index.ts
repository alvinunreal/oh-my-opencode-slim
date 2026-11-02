/**
 * Deepwork explorer: a read-only local web view of a running /deepwork
 * session (passes, lanes, agents, oracle verdicts, known issues).
 *
 * Observation only. It reads the skill's own state files and the
 * background job board; it never writes state and adds no bytes to any
 * prompt. The page is the prebuilt single-file bundle from `ui/deepwork`,
 * copied to `dist/deepwork-explorer.html` by the package build.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BackgroundJobRecord } from '../utils/background-job-board';
import { log } from '../utils/logger';
import { openBrowser } from '../utils/open-browser';
import {
  type ExplorerSnapshot,
  projectJobs,
  readDeepworkFiles,
} from './snapshot';

export const DEFAULT_EXPLORER_PORT = 43212;
const HTML_FILE = 'deepwork-explorer.html';
const MAX_TRACKED_SESSIONS = 32;
const MAX_TAGGED_JOBS = 2000;

export interface DeepworkExplorerOptions {
  directory: string;
  /** Job board rows for a parent session; absent when background jobs are off. */
  listJobs?: (sessionID: string) => BackgroundJobRecord[];
  port?: number;
  autoOpenBrowser?: boolean;
  /** Test seams. */
  open?: (url: string) => void;
  now?: () => number;
  html?: () => string;
}

export interface DeepworkExplorer {
  /** Start (once) and return the session's explorer URL. */
  activate(sessionID: string): Promise<string | undefined>;
  /** A job launched under `parentSessionID`: record the deepwork pass
   * from progress.md front matter, if that session runs deepwork. */
  noteLaunch(parentSessionID: string, taskID: string): Promise<void>;
  snapshot(sessionID: string): Promise<ExplorerSnapshot>;
  close(): void;
}

/** Find the bundled page next to the built plugin, wherever the chunk lives. */
function loadBundledHtml(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, HTML_FILE);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    dir = path.dirname(dir);
  }
  return '<!doctype html><meta charset="utf-8"><title>Deepwork Explorer</title><body style="background:#070605;color:#f3ede4;font:14px system-ui;padding:40px">The explorer UI is not built. Run <code>bun run build</code>.</body>';
}

export function createDeepworkExplorer(
  options: DeepworkExplorerOptions,
): DeepworkExplorer {
  const now = options.now ?? Date.now;
  const opener = options.open ?? openBrowser;
  const autoOpen = options.autoOpenBrowser ?? true;
  // Recently activated sessions, oldest first (`/` opens the newest).
  const sessions = new Set<string>();
  // taskID → deepwork pass at launch, oldest first.
  const passAtLaunch = new Map<string, number>();
  // Activation can replay (v2 re-dispatches command markers per context
  // event): open the browser once per session.
  const opened = new Set<string>();
  let html: string | undefined;
  let server: Server | undefined;
  let baseUrl: Promise<string> | undefined;

  function track(sessionID: string) {
    sessions.delete(sessionID);
    if (sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = sessions.values().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    sessions.add(sessionID);
  }

  async function noteLaunch(parentSessionID: string, taskID: string) {
    const files = await readDeepworkFiles(options.directory, parentSessionID);
    const pass = files.progress.pass;
    if (files.status !== 'active' || pass === undefined) return;
    if (passAtLaunch.size >= MAX_TAGGED_JOBS) {
      const oldest = passAtLaunch.keys().next().value;
      if (oldest !== undefined) passAtLaunch.delete(oldest);
    }
    passAtLaunch.set(taskID, pass);
  }

  async function snapshot(sessionID: string): Promise<ExplorerSnapshot> {
    const files = await readDeepworkFiles(options.directory, sessionID);
    const jobs = projectJobs(options.listJobs?.(sessionID) ?? [], (id) =>
      passAtLaunch.get(id),
    );
    return {
      version: 2,
      sessionID,
      slug: files.slug,
      status: files.status,
      now: now(),
      progress: files.progress,
      jobs,
    };
  }

  function send(
    response: ServerResponse,
    status: number,
    type: string,
    body: string,
  ) {
    response.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    // DNS-rebinding guard: only answer requests addressed to loopback.
    const host = (request.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') {
      send(response, 403, 'text/plain', 'Forbidden');
      return;
    }
    if (request.method !== 'GET') {
      send(response, 405, 'text/plain', 'Method not allowed');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/') {
      const latest = [...sessions].pop();
      response.writeHead(latest ? 302 : 404, {
        location: latest ? `/s/${encodeURIComponent(latest)}` : '',
        'content-type': 'text/plain',
      });
      response.end(latest ? '' : 'No deepwork session yet. Run /deepwork.');
      return;
    }

    if (/^\/s\/[^/]+\/?$/.test(url.pathname)) {
      html ??= (options.html ?? loadBundledHtml)();
      send(response, 200, 'text/html; charset=utf-8', html);
      return;
    }

    const api = url.pathname.match(/^\/api\/s\/([^/]+)$/);
    if (api) {
      const sessionID = decodeURIComponent(api[1]);
      if (!/^[\w-]+$/.test(sessionID)) {
        send(response, 400, 'application/json', '{"error":"bad session"}');
        return;
      }
      try {
        const body = JSON.stringify(await snapshot(sessionID));
        send(response, 200, 'application/json', body);
      } catch (error) {
        log('[deepwork-explorer] snapshot failed', { error: String(error) });
        send(response, 500, 'application/json', '{"error":"snapshot failed"}');
      }
      return;
    }

    send(response, 404, 'text/plain', 'Not found');
  }

  function listen(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const s = createServer((req, res) => {
        handle(req, res).catch(() => send(res, 500, 'text/plain', 'Error'));
      });
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => {
        const address = s.address();
        if (!address || typeof address === 'string') {
          reject(new Error('no address'));
          return;
        }
        s.unref();
        server = s;
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }

  function start(): Promise<string> {
    // A second OpenCode process may hold the default port: fall back to an
    // ephemeral one rather than fail.
    baseUrl ??= listen(options.port ?? DEFAULT_EXPLORER_PORT).catch(() =>
      listen(0),
    );
    return baseUrl;
  }

  return {
    async activate(sessionID) {
      track(sessionID);
      try {
        const url = `${await start()}/s/${encodeURIComponent(sessionID)}`;
        log('[deepwork-explorer] serving', { sessionID, url });
        if (autoOpen && !opened.has(sessionID)) {
          opened.add(sessionID);
          opener(url);
        }
        return url;
      } catch (error) {
        baseUrl = undefined;
        log('[deepwork-explorer] failed to start', { error: String(error) });
        return undefined;
      }
    },
    noteLaunch: (parentSessionID, taskID) =>
      noteLaunch(parentSessionID, taskID).catch(() => undefined),
    snapshot,
    close() {
      server?.close();
      server = undefined;
      baseUrl = undefined;
    },
  };
}
