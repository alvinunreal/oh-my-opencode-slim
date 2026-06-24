/**
 * JSON-RPC Unix domain socket client for the herdr daemon.
 *
 * Provides a persistent, reconnect-capable client for newline-delimited
 * JSON-RPC over AF_UNIX sockets.
 */

import * as net from 'node:net';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HerdrPaneId = string;

export interface HerdrPaneInfo {
  pane_id: HerdrPaneId;
  workspace_id: string;
  tab_id: string;
  cwd: string;
}

export interface HerdrError {
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Error discriminator
// ---------------------------------------------------------------------------

/**
 * Check whether `e` is a HerdrError-shaped thrown object.
 * When `code` is supplied, additionally checks that the error code matches.
 */
export function isHerdrError(e: unknown, code?: string): boolean {
  if (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof (e as Record<string, unknown>).code === 'string'
  ) {
    if (code !== undefined) {
      return (e as Record<string, unknown>).code === code;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Resolve the herdr socket path using the official priority order:
 * 1. $HERDR_SOCKET_PATH
 * 2. $HOME/.config/herdr/sessions/<HERDR_SESSION>/herdr.sock
 * 3. $HOME/.config/herdr/herdr.sock (default)
 */
function resolveSocketPath(): string {
  const envPath = process.env.HERDR_SOCKET_PATH;
  if (envPath) {
    return envPath;
  }

  const home = process.env.HOME;
  if (!home) {
    // Fall back to default relative to cwd (shouldn't happen on normal systems)
    return '/tmp/herdr.sock';
  }

  const herdrSession = process.env.HERDR_SESSION;
  if (herdrSession) {
    const sessionPath = `${home}/.config/herdr/sessions/${herdrSession}/herdr.sock`;
    return sessionPath;
  }

  return `${home}/.config/herdr/herdr.sock`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class HerdrSocketClient {
  private socketPath: string;
  private buffer = '';
  private pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private destroyed = false;

  constructor(socketPath?: string) {
    this.socketPath = socketPath ?? resolveSocketPath();
    log('[herdr-client] resolved socket path', { path: this.socketPath });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Perform a JSON-RPC call.  Opens / re-opens the socket lazily.
   * Returns the `result` field on success; throws a HerdrError-shaped Error
   * with `code` and `message` properties on error.
   */
  async call<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    this.ensureNotDestroyed();

    const id = `req_${++this.requestCounter}`;

    // This typed wrapper gives us correct return types while the raw
    // sendRequest does the heavy lifting.
    return this.sendRequest<T>(id, method, params, timeoutMs);
  }

  /**
   * Ping the daemon.  Returns `true` when the daemon responds with a pong,
   * `false` on any connection / timeout / protocol error.
   */
  async ping(): Promise<boolean> {
    try {
      await this.call('ping', {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Mark the client destroyed so subsequent calls reject.  Connections
   * are per-call (herdr closes the socket after each response), so there
   * is no persistent socket to tear down here.
   */
  async close(): Promise<void> {
    this.destroyed = true;
    this.rejectAllPending(
      Object.assign(new Error('Client was closed'), {
        code: 'client_closed',
        message: 'Client was closed',
      }),
    );
    this.buffer = '';
  }

  // -----------------------------------------------------------------------
  // Internal wire helpers
  // -----------------------------------------------------------------------

  /**
   * Low-level send + dispatch.  Kept separate from `call` so the typed
   * wrapper can control the return type generically.
   *
   * Note: herdr's daemon closes the socket after each response (no
   * keepalive), so each request opens a fresh connection.  This is still
   * cheaper than the CLI's per-call process spawn (no fork/exec, just a
   * Unix socket round-trip).
   */
  private sendRequest<T>(
    id: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Build the timeout timer
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = Object.assign(new Error('Request timed out'), {
          code: 'timeout',
          message: `Request ${id} (${method}) timed out after ${timeoutMs}ms`,
        });
        reject(err);
      }, timeoutMs);

      // Register the pending request
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      // Write the request. openSocketOnce handles connect, data, errors,
      // and cleanup for this single request.
      const request = `${JSON.stringify({ id, method, params })}\n`;
      log('[herdr-client] ->', { id, method });
      this.openSocketOnce().then(
        (socket) => {
          socket.write(request, 'utf-8');
        },
        (connErr: Error & { code?: string }) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(connErr);
        },
      );
    });
  }

  /**
   * Open a fresh socket connection.  herdr closes the socket after each
   * response, so connections are not reused across calls.
   */
  private openSocketOnce(): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });

      const onError = (err: Error) => {
        cleanup();
        const e = Object.assign(
          new Error(`herdr: connection error — ${err.message}`),
          { code: 'connection_error', message: err.message },
        );
        this.failAllPendingWithConnectionError(err.message);
        reject(e);
      };

      const onConnect = () => {
        cleanup();
        socket.setEncoding('utf-8');
        socket.on('data', (chunk: string) => {
          this.buffer += chunk;
          this.processBuffer();
        });
        socket.on('error', (err: Error) => {
          log('[herdr-client] socket error after connect', {
            error: err.message,
          });
          this.failAllPendingWithConnectionError(err.message);
        });
        resolve(socket);
      };

      const cleanup = () => {
        socket.off('error', onError);
        socket.off('connect', onConnect);
      };

      socket.once('error', onError);
      socket.once('connect', onConnect);
    });
  }

  private processBuffer(): void {
    while (true) {
      const nlIdx = this.buffer.indexOf('\n');
      if (nlIdx === -1) break;

      const line = this.buffer.slice(0, nlIdx);
      this.buffer = this.buffer.slice(nlIdx + 1);

      if (!line.trim()) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        log('[herdr-client] failed to parse response line', { line });
        continue;
      }

      const id = parsed.id as string | undefined;
      if (!id) {
        log('[herdr-client] response missing id', { parsed });
        continue;
      }

      const pending = this.pending.get(id);
      if (!pending) {
        log('[herdr-client] orphaned response for id', { id });
        continue;
      }

      clearTimeout(pending.timer);
      this.pending.delete(id);

      if (parsed.error) {
        const errObj = parsed.error as { code: string; message: string };
        const err = Object.assign(
          new Error(`herdr: ${errObj.code} — ${errObj.message}`),
          { code: errObj.code, message: errObj.message },
        );
        pending.reject(err);
      } else {
        pending.resolve(parsed.result);
      }
    }
  }

  private failAllPendingWithConnectionError(msg: string): void {
    if (this.pending.size === 0) return;
    const err = Object.assign(new Error(`herdr: connection error — ${msg}`), {
      code: 'connection_error',
      message: msg,
    });
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private rejectAllPending(
    err: Error & { code: string; message: string },
  ): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private ensureNotDestroyed(): void {
    if (this.destroyed) {
      throw Object.assign(
        new Error('herdr: client is closed and cannot be reused'),
        {
          code: 'client_closed',
          message: 'Client is closed and cannot be reused',
        },
      );
    }
  }
}
