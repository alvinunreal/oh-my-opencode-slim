import { afterEach, describe, expect, it, mock } from 'bun:test';

type SpawnResult = {
  exited: Promise<number>;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
};

const crossSpawnMock = mock((_args: string[]): SpawnResult => ({
  exited: Promise.resolve(0),
  stdout: () => Promise.resolve(''),
  stderr: () => Promise.resolve(''),
}));

mock.module('../utils/compat', () => ({
  crossSpawn: crossSpawnMock,
}));

const DELAY_MS = 250;
let importCounter = 0;

async function importShared() {
  return import(`./shared?test=${importCounter++}`);
}

describe('gracefulClosePane', () => {
  afterEach(() => {
    crossSpawnMock.mockReset();
  });

  it('sends Ctrl+C, waits 250ms, then closes, returning true on exit 0', async () => {
    const calls: string[][] = [];
    let ctrlCTime = 0;
    let closeTime = 0;

    crossSpawnMock.mockImplementation((args: string[]) => {
      if (
        args.includes('C-c') ||
        args.includes('\u0003') ||
        args.includes('ctrl+c')
      ) {
        ctrlCTime = Date.now();
      } else {
        closeTime = Date.now();
      }
      calls.push(args);
      return {
        exited: Promise.resolve(0),
        stdout: () => Promise.resolve(''),
        stderr: () => Promise.resolve(''),
      };
    });

    const { gracefulClosePane } = await importShared();
    const ok = await gracefulClosePane('tmux', '%1', {
      ctrlC: ['send-keys', '-t', '%1', 'C-c'],
      close: ['kill-pane', '-t', '%1'],
    });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(closeTime - ctrlCTime).toBeGreaterThanOrEqual(DELAY_MS - 20);
  });

  it('returns true when acceptExitCode1 and exit code is 1', async () => {
    crossSpawnMock.mockImplementation(() => ({
      exited: Promise.resolve(1),
      stdout: () => Promise.resolve(''),
      stderr: () => Promise.resolve(''),
    }));

    const { gracefulClosePane } = await importShared();
    const ok = await gracefulClosePane('zellij', 'terminal_1', {
      ctrlC: ['action', 'write', '--pane-id', 'terminal_1', '\u0003'],
      close: ['action', 'close-pane', '--pane-id', 'terminal_1'],
      acceptExitCode1: true,
    });
    expect(ok).toBe(true);
  });

  it('returns false on exit 1 when acceptExitCode1 is false', async () => {
    crossSpawnMock.mockImplementation(() => ({
      exited: Promise.resolve(1),
      stdout: () => Promise.resolve(''),
      stderr: () => Promise.resolve(''),
    }));

    const { gracefulClosePane } = await importShared();
    const ok = await gracefulClosePane('tmux', '%1', {
      ctrlC: ['send-keys', '-t', '%1', 'C-c'],
      close: ['kill-pane', '-t', '%1'],
    });
    expect(ok).toBe(false);
  });

  it('returns emptyPaneReturnsTrue when paneId is empty', async () => {
    const { gracefulClosePane } = await importShared();
    const ok = await gracefulClosePane('zellij', '', {
      ctrlC: ['action', 'write', '--pane-id', '', '\u0003'],
      close: ['action', 'close-pane', '--pane-id', ''],
      emptyPaneReturnsTrue: true,
    });
    expect(ok).toBe(true);
    expect(crossSpawnMock.mock.calls).toHaveLength(0);
  });

  it('returns false when binary is null', async () => {
    const { gracefulClosePane } = await importShared();
    const ok = await gracefulClosePane(null, '%1', {
      ctrlC: ['x'],
      close: ['y'],
    });
    expect(ok).toBe(false);
  });
});
