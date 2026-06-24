/**
 * Tests for HerdrSocketClient and isHerdrError
 *
 * Mocks node:net so the client talks to a controllable fake socket.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type net from 'node:net';

// ---------------------------------------------------------------------------
// Fake socket — controlled by each test
// ---------------------------------------------------------------------------

let lastWrittenChunk: string | null = null;
let currentFakeSocket: FakeSocket | null = null;

/**
 * When true (default), makeFakeSocket emits 'connect' on the next tick,
 * simulating the real net.Socket.connect event that openSocketOnce awaits.
 */
let emitConnectOnCreate = true;

/**
 * The write handler the test sets up; runs inside the fake socket's write().
 * Typically schedules an async response via setTimeout.
 */
let onWrite: ((data: string) => void) | null = null;

class FakeSocket extends EventEmitter {
  destroyed = false;
  readable = true;

  write = mock((data: string, _encoding?: string): boolean => {
    lastWrittenChunk = data;
    if (onWrite) onWrite(data);
    return true;
  });

  setEncoding = mock((_enc: string): void => {});
  end = mock((): void => {
    this.destroyed = true;
    this.readable = false;
  });
  destroy = mock((): void => {
    this.destroyed = true;
    this.readable = false;
  });
}

function makeFakeSocket(): FakeSocket {
  const s = new FakeSocket();
  currentFakeSocket = s;
  if (emitConnectOnCreate) {
    process.nextTick(() => s.emit('connect'));
  }
  return s;
}

const createConnectionMock = mock((_opts: { path: string }): net.Socket => {
  return makeFakeSocket() as unknown as net.Socket;
});

// ---------------------------------------------------------------------------
// Mock node:net before any import of ./client
// ---------------------------------------------------------------------------

mock.module('node:net', () => ({
  createConnection: createConnectionMock,
}));

// ---------------------------------------------------------------------------
// Dynamic import helper (cache-busting)
// ---------------------------------------------------------------------------

let importCounter = 0;

async function freshClient(socketPath?: string) {
  const mod = await import(`./client?test=${importCounter++}`);
  return new mod.HerdrSocketClient(socketPath);
}

async function freshModule() {
  return import(`./client?test=${importCounter++}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HerdrSocketClient', () => {
  beforeEach(() => {
    lastWrittenChunk = null;
    currentFakeSocket = null;
    onWrite = null;
    emitConnectOnCreate = true;
    createConnectionMock.mockClear();
    createConnectionMock.mockImplementation(
      (_opts: { path: string }) => makeFakeSocket() as unknown as net.Socket,
    );
  });

  afterEach(() => {
    onWrite = null;
  });

  // -----------------------------------------------------------------------
  // call() success path
  // -----------------------------------------------------------------------

  test('call() resolves with result on success', async () => {
    onWrite = (data) => {
      const parsed = JSON.parse(data.trim());
      setTimeout(() => {
        currentFakeSocket?.emit(
          'data',
          `${JSON.stringify({ id: parsed.id, result: { type: 'pong' } })}\n`,
        );
      }, 1);
    };

    const client = await freshClient();
    const result = await client.call('ping', {});

    expect(result).toEqual({ type: 'pong' });

    // Assert written request is valid newline-terminated JSON
    expect(lastWrittenChunk).not.toBeNull();
    expect(lastWrittenChunk).toEndWith('\n');

    const parsed = JSON.parse(lastWrittenChunk?.trim());
    expect(parsed).toHaveProperty('id', 'req_1');
    expect(parsed).toHaveProperty('method', 'ping');
    expect(parsed).toHaveProperty('params');
    expect(parsed.params).toEqual({});
  });

  // -----------------------------------------------------------------------
  // call() error path
  // -----------------------------------------------------------------------

  test('call() rejects on error response', async () => {
    onWrite = (data) => {
      const parsed = JSON.parse(data.trim());
      setTimeout(() => {
        currentFakeSocket?.emit(
          'data',
          `${JSON.stringify({
            id: parsed.id,
            error: { code: 'pane_not_found', message: 'Pane not found' },
          })}\n`,
        );
      }, 1);
    };

    const client = await freshClient();
    let thrown: unknown;
    try {
      await client.call('pane.close', { pane_id: 'w1:p2' });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    const err = thrown as Error & { code?: string };
    expect(err.code).toBe('pane_not_found');
  });

  test('rejected error is recognized by isHerdrError', async () => {
    const mod = await freshModule();

    onWrite = (data) => {
      const parsed = JSON.parse(data.trim());
      setTimeout(() => {
        currentFakeSocket?.emit(
          'data',
          `${JSON.stringify({
            id: parsed.id,
            error: { code: 'pane_not_found', message: 'Pane not found' },
          })}\n`,
        );
      }, 1);
    };

    const client = await freshClient();
    let thrown: unknown;
    try {
      await client.call('pane.close', { pane_id: 'w1:p2' });
    } catch (e) {
      thrown = e;
    }

    expect(mod.isHerdrError(thrown, 'pane_not_found')).toBe(true);
    expect(mod.isHerdrError(thrown, 'invalid_request')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // isHerdrError discriminator (pure function, no socket needed)
  // -----------------------------------------------------------------------

  test('isHerdrError handles all branches', async () => {
    const mod = await freshModule();
    const isHerdr = mod.isHerdrError;

    // (a) Matching code
    const errA = Object.assign(new Error('test'), {
      code: 'pane_not_found',
      message: 'test',
    });
    expect(isHerdr(errA, 'pane_not_found')).toBe(true);

    // (b) Wrong code
    expect(isHerdr(errA, 'invalid_request')).toBe(false);

    // (c) Plain Error (non-herdr, no code property)
    const plain = new Error('plain');
    expect(isHerdr(plain)).toBe(false);

    // (d) null
    expect(isHerdr(null)).toBe(false);

    // (e) Matching shape with no code arg → true
    expect(isHerdr(errA)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Timeout
  // -----------------------------------------------------------------------

  test('call() rejects with timeout when no response arrives', async () => {
    // No onWrite — socket never responds
    const mod = await freshModule();

    const client = await freshClient();
    const start = Date.now();
    let thrown: unknown;
    try {
      await client.call('ping', {}, 50);
    } catch (e) {
      thrown = e;
    }
    const elapsed = Date.now() - start;

    expect(thrown).toBeDefined();
    expect(elapsed).toBeLessThan(500); // should be ~50ms, generous bound
    expect(mod.isHerdrError(thrown, 'timeout')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Multiple concurrent calls
  // -----------------------------------------------------------------------

  test('handles multiple concurrent calls with out-of-order responses', async () => {
    onWrite = (data) => {
      const parsed = JSON.parse(data.trim());
      setTimeout(() => {
        const letterMap: Record<string, string> = {
          req_1: 'A',
          req_2: 'B',
          req_3: 'C',
        };
        currentFakeSocket?.emit(
          'data',
          `${JSON.stringify({
            id: parsed.id,
            result: { letter: letterMap[parsed.id] ?? '?' },
          })}\n`,
        );
      }, 2);
    };

    const client = await freshClient();

    const [r1, r2, r3] = await Promise.all([
      client.call('method.a', {}),
      client.call('method.b', {}),
      client.call('method.c', {}),
    ]);

    const results = [r1, r2, r3].map((r) => (r as { letter: string }).letter);
    expect(results.sort()).toEqual(['A', 'B', 'C']);
  });

  // -----------------------------------------------------------------------
  // Newline framing across multiple data chunks
  // -----------------------------------------------------------------------

  test('handles responses split across multiple data chunks', async () => {
    onWrite = (data) => {
      const parsed = JSON.parse(data.trim());
      const fullLine = `${JSON.stringify({
        id: parsed.id,
        result: { type: 'pong' },
      })}\n`;
      const mid = Math.floor(fullLine.length / 2);
      const chunk1 = fullLine.slice(0, mid);
      const chunk2 = fullLine.slice(mid);

      setTimeout(() => {
        currentFakeSocket?.emit('data', chunk1);
      }, 1);
      setTimeout(() => {
        currentFakeSocket?.emit('data', chunk2);
      }, 5);
    };

    const client = await freshClient();
    const result = await client.call('ping', {});
    expect(result).toEqual({ type: 'pong' });
  });

  // -----------------------------------------------------------------------
  // Reconnect after close
  // -----------------------------------------------------------------------

  test('reconnects after socket is closed', async () => {
    // First call — creates socket
    onWrite = (data) => {
      const parsed = JSON.parse(data.trim());
      setTimeout(() => {
        currentFakeSocket?.emit(
          'data',
          `${JSON.stringify({ id: parsed.id, result: { type: 'pong' } })}\n`,
        );
      }, 1);
    };

    const client = await freshClient();
    await client.call('ping', {});
    expect(createConnectionMock.mock.calls.length).toBe(1);

    // Simulate socket closure
    if (currentFakeSocket) {
      currentFakeSocket.emit('close');
      currentFakeSocket = null;
    }

    // Second call — should create a new socket
    await client.call('ping', {});
    expect(createConnectionMock.mock.calls.length).toBe(2);
  });

  // -----------------------------------------------------------------------
  // ping() returns false on connection failure
  // -----------------------------------------------------------------------

  test('ping() returns false when socket errors on connect', async () => {
    // Suppress auto-connect: the test sends error instead of connect
    emitConnectOnCreate = false;

    // Make createConnection return a socket that emits error
    createConnectionMock.mockImplementation(
      (_opts: { path: string }): net.Socket => {
        const sock = makeFakeSocket() as unknown as net.Socket;
        setTimeout(() => {
          (sock as unknown as FakeSocket).emit(
            'error',
            new Error('connection refused'),
          );
        }, 1);
        return sock;
      },
    );

    const client = await freshClient();
    const result = await client.ping();
    expect(result).toBe(false);
  });

  // -----------------------------------------------------------------------
  // close() rejects pending and marks destroyed
  // -----------------------------------------------------------------------

  test('close() rejects pending calls and marks client destroyed', async () => {
    const mod = await freshModule();

    // No onWrite — call will hang
    const client = await freshClient();
    const pendingCall = client.call('ping', {}, 5000);

    // Give the call time to send and register
    await wait(10);

    // Close the client
    await client.close();

    // The pending call should reject
    let callErr: unknown;
    try {
      await pendingCall;
    } catch (e) {
      callErr = e;
    }
    expect(callErr).toBeDefined();

    // Subsequent calls should throw client_closed
    let closeErr: unknown;
    try {
      await client.call('ping', {});
    } catch (e) {
      closeErr = e;
    }
    expect(closeErr).toBeDefined();
    expect(mod.isHerdrError(closeErr, 'client_closed')).toBe(true);
  });
});
