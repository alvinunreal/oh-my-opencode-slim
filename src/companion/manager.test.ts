import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  spyOn,
} from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as loggerModule from '../utils/logger';
import { acquirePidFileLock } from '../utils/pid-file-lock';
import { mapV2EventToV1 } from '../v2/event-adapter';
import {
  CompanionManager,
  companionSessionIdForDirectory,
  rememberKnownCompanionProject,
  resolveCompanionBinaryPath,
  resolveKnownCompanionProject,
  stateFilePath,
} from './manager';
import { pruneDisabledCompanionRuntime } from './runtime';
import { normalizeCompanionSessionStatus } from './status';

// Point writes at a temp dir so tests don't touch the real state file.
const TEST_DIR = path.join(os.tmpdir(), `companion-test-${process.pid}`);
const XDG_DIR = path.join(TEST_DIR, 'xdg');
const managers: CompanionManager[] = [];
const attachmentPidsByDirectory = new Map<string, number>();
const attachmentChildren: ChildProcess[] = [];
const usedAttachmentPids = new Set<number>();

function nextAttachmentPid(): number {
  if (!usedAttachmentPids.has(process.pid)) {
    usedAttachmentPids.add(process.pid);
    return process.pid;
  }
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  if (child.pid === undefined) {
    child.kill();
    throw new Error('test attachment process did not start');
  }
  attachmentChildren.push(child);
  if (usedAttachmentPids.has(child.pid)) {
    child.kill();
    throw new Error('test attachment PIDs must be distinct');
  }
  usedAttachmentPids.add(child.pid);
  return child.pid;
}

function testProcessStartTime(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  if (!fields[19])
    throw new Error(`missing start time for live test PID ${pid}`);
  return `linux:${fields[19]}`;
}

function attachmentFile(pid: number): string {
  return path.join(path.dirname(stateFilePath()), 'tui-attach', `${pid}.json`);
}

function writeAttachment(pid: number, cwd: string): void {
  const file = attachmentFile(pid);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      pid,
      startTime: testProcessStartTime(pid),
      cwd: path.resolve(cwd),
    }),
  );
}

function attachAnotherTui(cwd: string): number {
  const pid = nextAttachmentPid();
  writeAttachment(pid, cwd);
  return pid;
}

function detachDirectory(cwd: string): void {
  const pid = attachmentPidsByDirectory.get(path.resolve(cwd));
  if (pid !== undefined) rmSync(attachmentFile(pid), { force: true });
}

function readState() {
  return JSON.parse(readFileSync(stateFilePath(), 'utf8'));
}

const previousXdg = process.env.XDG_DATA_HOME;
const previousXdgConfig = process.env.XDG_CONFIG_HOME;
const previousOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
const previousPresetEnv = process.env.OH_MY_OPENCODE_SLIM_PRESET;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.XDG_DATA_HOME = XDG_DIR;
  attachmentPidsByDirectory.clear();
  usedAttachmentPids.clear();
  process.env.XDG_CONFIG_HOME = path.join(TEST_DIR, 'config');
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  const configDir = path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'oh-my-opencode-slim.json'), '{}');
});

afterEach(() => {
  rmSync(path.join(path.dirname(stateFilePath()), 'tui-attach'), {
    recursive: true,
    force: true,
  });
  for (const manager of managers.splice(0)) {
    manager.onExit();
  }
  for (const child of attachmentChildren.splice(0)) child.kill();
  rmSync(TEST_DIR, { recursive: true, force: true });
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdg;
  if (previousXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdgConfig;
  if (previousOpenCodeConfigDir === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR;
  } else {
    process.env.OPENCODE_CONFIG_DIR = previousOpenCodeConfigDir;
  }
  if (previousPresetEnv === undefined) {
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  } else {
    process.env.OH_MY_OPENCODE_SLIM_PRESET = previousPresetEnv;
  }
});

function make(
  id = 'test-session',
  cwd = '/home/user/myproject',
  config: any = { enabled: true, position: 'bottom-right', size: 'medium' },
) {
  const manager = new CompanionManager(id, cwd, config);
  managers.push(manager);
  if (config?.enabled === true) {
    const key = path.resolve(cwd);
    let pid = attachmentPidsByDirectory.get(key);
    if (pid === undefined) {
      pid = nextAttachmentPid();
      attachmentPidsByDirectory.set(key, pid);
    }
    writeAttachment(pid, cwd);
  }
  return manager;
}

function reconcile(manager: CompanionManager): void {
  (
    manager as unknown as { reconcileCompanion: () => void }
  ).reconcileCompanion();
}

function companionPidFile(): string {
  return path.join(path.dirname(stateFilePath()), 'companion.pid');
}

function companionSpawnFile(): string {
  return path.join(path.dirname(stateFilePath()), 'companion-spawn.json');
}

function readSpawnAttachments(): Array<{ pid: number; startTime?: string }> {
  return (
    JSON.parse(readFileSync(companionSpawnFile(), 'utf8')) as {
      attachments: Array<{ pid: number; startTime?: string }>;
    }
  ).attachments;
}

function companionStateLock(): string {
  return `${stateFilePath()}.lock`;
}

describe('CompanionManager', () => {
  it('retries state removal during logical disposal when a live writer holds the lock', async () => {
    const m = make();
    m.onLoad();
    const release = acquirePidFileLock(stateFilePath());
    expect(release).not.toBeNull();
    jest.useFakeTimers();
    try {
      const disposal = (
        m as unknown as { dispose?: () => Promise<void> }
      ).dispose?.();
      release?.();
      jest.advanceTimersByTime(25);
      await disposal;
      expect(readState().sessions).toHaveLength(0);
    } finally {
      release?.();
      jest.useRealTimers();
    }
  });

  it('does not remove a replacement generation while retrying disposal', async () => {
    const old = make();
    old.onLoad();
    const release = acquirePidFileLock(stateFilePath());
    jest.useFakeTimers();
    try {
      const disposal = old.dispose();
      const replacement = make();
      replacement.onLoad();
      release?.();
      jest.advanceTimersByTime(25);
      await disposal;
      expect(readState().sessions).toHaveLength(1);
      replacement.onSessionStatus({
        sessionId: 'new',
        agent: 'fixer',
        status: 'busy',
      });
      expect(readState().sessions[0].active_agents).toEqual(['fixer']);
    } finally {
      release?.();
      jest.useRealTimers();
    }
  });

  it('does not remove a replacement when an unstarted generation is disposed', async () => {
    const pending = make();
    const replacement = make();
    replacement.onLoad();
    replacement.onSessionStatus({
      sessionId: 'new',
      agent: 'fixer',
      status: 'busy',
    });
    await pending.dispose();
    expect(readState().sessions[0].active_agents).toEqual(['fixer']);
  });

  it('writes an intro entry on load', () => {
    const m = make();
    m.onLoad();
    const state = readState();
    expect(state.version).toBe(1);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].session_id).toBe('test-session');
    expect(state.sessions[0].cwd).toBe('/home/user/myproject');
    expect(state.sessions[0].active_agents).toEqual(['intro']);
    expect(state.sessions[0].active_agent_details).toEqual([]);
    expect(state.sessions[0].status).toBe('idle');
    expect(state.sessions[0].pid).toBe(process.pid);
  });

  it('normalizes all terminal lifecycle forms to idle', () => {
    expect(normalizeCompanionSessionStatus('session.idle')).toBe('idle');
    expect(normalizeCompanionSessionStatus('session.error')).toBe('idle');
    for (const status of ['idle', 'completed', 'stopped', 'error', 'failed']) {
      expect(normalizeCompanionSessionStatus('session.status', status)).toBe(
        'idle',
      );
    }
  });

  it('normalizes retry as active and ignores unrelated lifecycle events', () => {
    expect(normalizeCompanionSessionStatus('session.status', 'busy')).toBe(
      'busy',
    );
    expect(normalizeCompanionSessionStatus('session.status', 'retry')).toBe(
      'busy',
    );
    expect(normalizeCompanionSessionStatus('session.status', 'unknown')).toBe(
      undefined,
    );
    expect(normalizeCompanionSessionStatus('message.updated', 'busy')).toBe(
      undefined,
    );
  });

  it('derives stable distinct manager ids per project directory', () => {
    const alpha = companionSessionIdForDirectory('/projects/alpha');
    const alphaNormalized = companionSessionIdForDirectory(
      path.join('/projects', 'alpha', '..', 'alpha'),
    );
    const beta = companionSessionIdForDirectory('/projects/beta');

    expect(alpha).toBe(alphaNormalized);
    expect(alpha).not.toBe(beta);
    expect(alpha).toStartWith(`proc_${process.pid}_`);
  });

  it('recovers an abandoned state lock before publishing the owner session', () => {
    const lock = companionStateLock();
    mkdirSync(lock, { recursive: true });
    const stale = new Date(Date.now() - 10_000);
    utimesSync(lock, stale, stale);

    const m = make('stale-state-lock');
    m.onLoad();

    expect(existsSync(lock)).toBe(false);
    expect(readState().sessions).toContainEqual(
      expect.objectContaining({ session_id: 'stale-state-lock' }),
    );
  });

  it('does not age-steal a state lock from a live owner', () => {
    const lock = companionStateLock();
    mkdirSync(lock, { recursive: true });
    writeFileSync(path.join(lock, 'owner'), `${process.pid}\nlive-owner`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);

    const m = make('live-state-lock');
    m.onLoad();

    expect(existsSync(lock)).toBe(true);
    expect(existsSync(stateFilePath())).toBe(false);
  });

  it('does not spawn headlessly; an attachment is reconciled on the poll path', () => {
    const m = new CompanionManager('headless', '/headless', { enabled: true });
    managers.push(m);
    const internal = m as unknown as { spawnIfAvailable: () => boolean };
    let spawnAttempts = 0;
    internal.spawnIfAvailable = () => {
      spawnAttempts += 1;
      return true;
    };

    m.onLoad();
    expect(spawnAttempts).toBe(0);
    expect(readState().sessions).toEqual([]);

    writeAttachment(process.pid, '/headless');
    reconcile(m);
    reconcile(m);
    expect(spawnAttempts).toBe(1);
    expect(readState().sessions).toContainEqual(
      expect.objectContaining({ session_id: 'headless' }),
    );
  });

  it('only spawns from the attached project manager', () => {
    const headless = new CompanionManager(
      'headless-project',
      '/headless-project',
      {
        enabled: true,
        binaryPath: path.join(TEST_DIR, 'missing-companion'),
      },
    );
    managers.push(headless);
    headless.onLoad();

    const attached = make('attached-project', '/attached-project', {
      enabled: true,
      binaryPath: path.join(TEST_DIR, 'working-companion-stub'),
    });
    attached.onLoad();
    const internal = attached as unknown as {
      spawnIfAvailable: () => boolean;
    };
    let spawnAttempts = 0;
    internal.spawnIfAvailable = () => {
      spawnAttempts += 1;
      return true;
    };

    reconcile(headless);
    expect(existsSync(companionSpawnFile())).toBe(false);
    reconcile(attached);
    expect(spawnAttempts).toBe(1);
  });

  it('does not record an unpublished attachment, so its later row can spawn', () => {
    const logSpy = spyOn(loggerModule, 'log');
    try {
      const a = make('session-a', '/project-a', {
        enabled: true,
        binaryPath: path.join(TEST_DIR, 'missing-companion'),
      });
      a.onLoad();
      const aPid = attachmentPidsByDirectory.get(path.resolve('/project-a'));
      if (aPid === undefined) throw new Error('missing test attachment');
      // Companion alive: the record update path records A while running.
      writeFileSync(companionPidFile(), String(process.pid));
      reconcile(a);
      expect(readSpawnAttachments().map((entry) => entry.pid)).toEqual([aPid]);
      // Companion exits and takes the record with it.
      rmSync(companionPidFile(), { force: true });
      rmSync(companionSpawnFile(), { force: true });

      // TUI C attaches to another project; its state row is not published yet.
      const c = make('session-c', '/project-c', {
        enabled: true,
        binaryPath: path.join(TEST_DIR, 'missing-companion'),
      });
      reconcile(a); // spawn path records A; C must stay out of the record
      const cPid = attachmentPidsByDirectory.get(path.resolve('/project-c'));
      if (cPid === undefined) throw new Error('missing test attachment');
      expect(readSpawnAttachments().map((entry) => entry.pid)).toEqual([aPid]);
      expect(
        logSpy.mock.calls.filter(([message]) =>
          String(message).includes('companion binary not found'),
        ),
      ).toHaveLength(1);

      // C publishes its row and ticks: one spawn.
      c.onLoad();
      reconcile(c);
      expect(
        logSpy.mock.calls.filter(([message]) =>
          String(message).includes('companion binary not found'),
        ),
      ).toHaveLength(2);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('ignores rows from dead generations when recording spawn attempts', () => {
    const logSpy = spyOn(loggerModule, 'log');
    try {
      const a = make('session-a', '/project-a', {
        enabled: true,
        binaryPath: path.join(TEST_DIR, 'missing-companion'),
      });
      a.onLoad();
      const aPid = attachmentPidsByDirectory.get(path.resolve('/project-a'));
      if (aPid === undefined) throw new Error('missing test attachment');
      // A row for /project-c from a killed generation; only a state write
      // prunes it, so steady-state ticks must not treat it as published.
      const state = readState();
      state.sessions.push({
        session_id: 'stale-generation',
        cwd: path.resolve('/project-c'),
        pid: 999999999,
        active_agents: [],
        active_agent_details: [],
        status: 'idle',
      });
      writeFileSync(stateFilePath(), JSON.stringify(state));

      const c = make('session-c', '/project-c', {
        enabled: true,
        binaryPath: path.join(TEST_DIR, 'missing-companion'),
      });
      writeFileSync(companionPidFile(), String(process.pid));
      reconcile(a);
      const cPid = attachmentPidsByDirectory.get(path.resolve('/project-c'));
      if (cPid === undefined) throw new Error('missing test attachment');
      expect(readSpawnAttachments().map((entry) => entry.pid)).toEqual([aPid]);

      // C publishes its own live row and ticks: one spawn.
      rmSync(companionPidFile(), { force: true });
      c.onLoad();
      reconcile(c);
      expect(
        logSpy.mock.calls.filter(([message]) =>
          String(message).includes('companion binary not found'),
        ),
      ).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does not let a headless manager dispose erase the user-quit guard', () => {
    const logSpy = spyOn(loggerModule, 'log');
    try {
      const a = make('session-a', '/project-a', {
        enabled: true,
        binaryPath: path.join(TEST_DIR, 'missing-companion'),
      });
      a.onLoad();
      writeFileSync(companionPidFile(), String(process.pid));
      reconcile(a);
      expect(readSpawnAttachments()).toHaveLength(1);

      // User quits the Companion: A stays attached, pid file goes stale.
      writeFileSync(companionPidFile(), '999999999');

      // A headless project (no row) disposes; it must not erase the record.
      const headless = new CompanionManager('headless-b', '/project-b', {
        enabled: true,
        binaryPath: path.join(TEST_DIR, 'missing-companion'),
      });
      managers.push(headless);
      headless.onExit();
      expect(readSpawnAttachments()).toHaveLength(1);

      // A's next poll: recorded → no respawn of the window the user closed.
      reconcile(a);
      expect(
        logSpy.mock.calls.filter(([message]) =>
          String(message).includes('companion binary not found'),
        ),
      ).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('removes dead and mismatched attachment records', () => {
    const m = new CompanionManager('crash-leftover', '/crashed', {
      enabled: true,
    });
    managers.push(m);
    const deadFile = attachmentFile(2_000_000_000);
    mkdirSync(path.dirname(deadFile), { recursive: true });
    writeFileSync(
      deadFile,
      JSON.stringify({
        pid: 2_000_000_000,
        startTime: 'dead',
        cwd: '/crashed',
      }),
    );
    if (process.platform === 'linux') {
      writeAttachment(process.pid, '/reused');
      writeFileSync(
        attachmentFile(process.pid),
        JSON.stringify({
          pid: process.pid,
          startTime: 'mismatched-start-time',
          cwd: '/reused',
        }),
      );
    }

    m.onLoad();
    reconcile(m);

    expect(existsSync(deadFile)).toBe(false);
    if (process.platform === 'linux') {
      expect(existsSync(attachmentFile(process.pid))).toBe(false);
    }
    expect(existsSync(companionPidFile())).toBe(false);
    expect(readState().sessions).toEqual([]);
  });

  it('drops only the detached directory row while another directory keeps the window', () => {
    const first = make('first-directory', '/projects/first');
    const second = make('second-directory', '/projects/second');
    first.onLoad();
    second.onLoad();
    writeFileSync(companionPidFile(), String(process.pid));

    detachDirectory('/projects/first');
    for (let tick = 0; tick < 8; tick++) {
      reconcile(first);
      reconcile(second);
    }
    expect(
      readState().sessions.map(
        (session: { session_id: string }) => session.session_id,
      ),
    ).toEqual(['second-directory']);
    expect(readFileSync(companionPidFile(), 'utf8')).toBe(String(process.pid));

    detachDirectory('/projects/second');
    for (let tick = 0; tick < 8; tick++) {
      reconcile(first);
      reconcile(second);
    }
    expect(readState().sessions).toEqual([]);
    expect(readFileSync(companionPidFile(), 'utf8')).toBe(String(process.pid));
  });

  it('never signals a PID when the last attachment removes all rows', () => {
    const m = make('last-tui', '/last');
    m.onLoad();
    writeFileSync(companionPidFile(), String(process.pid));
    const originalKill = process.kill;
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      signals.push(signal);
      return originalKill(pid, signal);
    }) as typeof process.kill;
    try {
      detachDirectory('/last');
      for (let tick = 0; tick < 8; tick++) reconcile(m);
      expect(readState().sessions).toEqual([]);
      expect(signals.every((signal) => signal === 0)).toBe(true);
    } finally {
      process.kill = originalKill;
    }
  });

  it('flush does not recreate a row after the directory detaches', () => {
    const m = make('flush-detached', '/flush');
    m.onLoad();
    detachDirectory('/flush');
    for (let tick = 0; tick < 8; tick++) reconcile(m);
    (m as unknown as { flush: () => boolean }).flush();
    expect(readState().sessions).toEqual([]);
  });

  it('keeps the row through a short TUI reload gap', () => {
    const m = make('reload-gap', '/reload-gap');
    m.onLoad();
    detachDirectory('/reload-gap');
    for (let tick = 0; tick < 7; tick++) reconcile(m);
    expect(readState().sessions).toHaveLength(1);

    const pid = attachmentPidsByDirectory.get(path.resolve('/reload-gap'));
    if (pid === undefined) throw new Error('test attachment PID is missing');
    writeAttachment(pid, '/reload-gap');
    reconcile(m);
    expect(readState().sessions).toHaveLength(1);

    detachDirectory('/reload-gap');
    for (let tick = 0; tick < 7; tick++) reconcile(m);
    expect(readState().sessions).toHaveLength(1);
    reconcile(m);
    expect(readState().sessions).toEqual([]);
  });

  it('does not respawn after Quit through a second project manager', () => {
    const config = {
      enabled: true,
      binaryPath: path.join(TEST_DIR, 'missing-companion'),
    };
    const first = make('spawn-first', '/spawn-first', config);
    const second = make('spawn-second', '/spawn-second', config);
    first.onLoad();
    second.onLoad();
    const logSpy = spyOn(loggerModule, 'log');
    try {
      reconcile(first);
      const history = readSpawnAttachments();
      writeFileSync(companionPidFile(), '999999999');
      reconcile(second);
      expect(readSpawnAttachments()).toEqual(history);
      expect(
        logSpy.mock.calls.filter(([message]) =>
          String(message).includes('companion binary not found'),
        ),
      ).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('retries spawning after plugin reload with unchanged attachments', () => {
    const config = {
      enabled: true,
      binaryPath: path.join(TEST_DIR, 'missing-companion'),
    };
    const original = make('spawn-reload', '/spawn-reload', config);
    original.onLoad();
    const logSpy = spyOn(loggerModule, 'log');
    try {
      reconcile(original);
      expect(existsSync(companionSpawnFile())).toBe(true);
      writeFileSync(companionPidFile(), String(process.pid));
      original.onExit();
      expect(existsSync(companionSpawnFile())).toBe(false);
      expect(readState().sessions).toEqual([]);
      writeFileSync(companionPidFile(), '999999999');

      const replacement = make('spawn-reload', '/spawn-reload', config);
      replacement.onLoad();
      reconcile(replacement);
      expect(
        logSpy.mock.calls.filter(([message]) =>
          String(message).includes('companion binary not found'),
        ),
      ).toHaveLength(2);
      expect(existsSync(companionSpawnFile())).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('remembers TUIs that attach while the Companion is running', () => {
    const m = make('remember-live-tuis', '/remember-live-tuis', {
      enabled: true,
      binaryPath: path.join(TEST_DIR, 'missing-companion'),
    });
    m.onLoad();
    const attachmentA = attachmentPidsByDirectory.get(
      path.resolve('/remember-live-tuis'),
    );
    if (attachmentA === undefined) {
      throw new Error('test attachment PID is missing');
    }
    const logSpy = spyOn(loggerModule, 'log');
    try {
      reconcile(m);
      expect(readSpawnAttachments().map(({ pid }) => pid)).toEqual([
        attachmentA,
      ]);

      writeFileSync(companionPidFile(), String(process.pid));
      const attachmentB = attachAnotherTui('/remember-live-tuis');
      reconcile(m);
      const remembered = readSpawnAttachments().map(({ pid }) => pid);
      expect(remembered).toContain(attachmentA);
      expect(remembered).toContain(attachmentB);

      writeFileSync(companionPidFile(), '999999999');
      reconcile(m);
      expect(
        logSpy.mock.calls.filter(([message]) =>
          String(message).includes('companion binary not found'),
        ),
      ).toHaveLength(1);

      attachAnotherTui('/remember-live-tuis');
      reconcile(m);
      expect(
        logSpy.mock.calls.filter(([message]) =>
          String(message).includes('companion binary not found'),
        ),
      ).toHaveLength(2);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('allows one new spawn attempt when a new TUI PID attaches', () => {
    const m = make('new-tui-spawn', '/new-tui-spawn', {
      enabled: true,
      binaryPath: path.join(TEST_DIR, 'missing-companion'),
    });
    m.onLoad();
    const logSpy = spyOn(loggerModule, 'log');
    try {
      reconcile(m);
      const previous = readSpawnAttachments();
      const newPid = attachAnotherTui('/new-tui-spawn');
      reconcile(m);
      const updated = readSpawnAttachments();
      expect(updated.map((attachment) => attachment.pid)).toContain(newPid);
      expect(updated).not.toEqual(previous);
      reconcile(m);
      expect(
        logSpy.mock.calls.filter(([message]) =>
          String(message).includes('companion binary not found'),
        ),
      ).toHaveLength(2);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('clears spawn history when the attachment set becomes empty', () => {
    const m = make('clear-spawn-history', '/clear-spawn-history', {
      enabled: true,
      binaryPath: path.join(TEST_DIR, 'missing-companion'),
    });
    m.onLoad();
    reconcile(m);
    expect(existsSync(companionSpawnFile())).toBe(true);

    detachDirectory('/clear-spawn-history');
    reconcile(m);
    expect(existsSync(companionSpawnFile())).toBe(false);
  });

  it('retries spawning after a busy PID lock clears without saving spawn history', () => {
    const binary = path.join(TEST_DIR, 'fake-companion');
    writeFileSync(binary, '#!/bin/sh\nexit 0\n');
    chmodSync(binary, 0o755);
    const m = make('lock-retry', '/lock-retry', {
      enabled: true,
      binaryPath: binary,
    });
    m.onLoad();
    const pidFile = companionPidFile();
    const lock = `${pidFile}.lock`;
    mkdirSync(lock);
    writeFileSync(path.join(lock, 'owner'), String(process.pid));

    reconcile(m);
    expect(existsSync(companionSpawnFile())).toBe(false);
    expect(existsSync(pidFile)).toBe(false);

    rmSync(lock, { recursive: true, force: true });
    reconcile(m);
    expect(existsSync(companionSpawnFile())).toBe(true);
    expect(Number(readFileSync(pidFile, 'utf8'))).toBeGreaterThan(0);
  });

  it('keeps an unreadable live attachment and skips reconciliation', () => {
    const m = make('unknown-attachment', '/unknown');
    m.onLoad();
    const file = attachmentFile(process.pid);
    writeFileSync(file, '{not json');

    reconcile(m);

    expect(existsSync(file)).toBe(true);
    expect(readState().sessions).toHaveLength(1);
  });

  it('does not consume a preset request after the eighth unattached tick drops its row', () => {
    const projectDir = path.join(TEST_DIR, 'unattached-preset');
    const projectConfigDir = path.join(projectDir, '.opencode');
    mkdirSync(projectConfigDir, { recursive: true });
    const projectConfigPath = path.join(
      projectConfigDir,
      'oh-my-opencode-slim.jsonc',
    );
    const originalConfig = JSON.stringify({ preset: 'old' });
    writeFileSync(projectConfigPath, originalConfig);
    writeFileSync(
      path.join(TEST_DIR, 'config', 'opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({
        presets: {
          old: { orchestrator: { model: 'old-model' } },
          cheap: { orchestrator: { model: 'cheap-model' } },
        },
      }),
    );

    const m = make('unattached-preset-session', projectDir);
    m.onLoad();
    detachDirectory(projectDir);
    const poll = m as unknown as { pollPresetState: () => void };
    for (let tick = 0; tick < 7; tick++) poll.pollPresetState();
    expect(readState().sessions).toHaveLength(1);

    const state = readState();
    state.preset_requests = [
      {
        request_id: 'removed-row-request',
        session_id: 'unattached-preset-session',
        scope: 'project',
        preset: 'cheap',
      },
    ];
    writeFileSync(stateFilePath(), JSON.stringify(state));

    poll.pollPresetState();

    expect(readState().sessions).toEqual([]);
    expect(readState().preset_requests).toBeUndefined();
    expect(readFileSync(projectConfigPath, 'utf8')).toBe(originalConfig);
  });

  it('publishes presets and applies a project-local preset request', () => {
    const projectDir = path.join(TEST_DIR, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    mkdirSync(projectConfigDir, { recursive: true });
    const projectConfigPath = path.join(
      projectConfigDir,
      'oh-my-opencode-slim.jsonc',
    );
    writeFileSync(
      projectConfigPath,
      `{
        // Project-local preset should remain the controlling layer.
        "preset": "old",
      }`,
    );

    const userConfigPath = path.join(
      path.join(TEST_DIR, 'config'),
      'opencode',
      'oh-my-opencode-slim.json',
    );
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        preset: 'cheap',
        presets: {
          old: { orchestrator: { model: 'old-model' } },
          cheap: { orchestrator: { model: 'cheap-model' } },
        },
      }),
    );

    const m = make('preset-session', projectDir);
    m.onLoad();
    let state = readState();
    expect(state.sessions[0].preset.current).toBe('old');
    expect(state.sessions[0].preset.available).toEqual(['cheap', 'old']);

    state.sessions.push({
      session_id: 'other-session',
      cwd: path.join(TEST_DIR, 'other-project'),
      active_agents: ['intro'],
      status: 'idle',
      pid: process.pid,
    });
    state.preset_requests = [
      {
        request_id: 'req-1',
        session_id: 'preset-session',
        preset: 'cheap',
      },
      {
        request_id: 'req-other',
        session_id: 'other-session',
        preset: 'old',
      },
    ];
    writeFileSync(stateFilePath(), JSON.stringify(state));
    (
      m as unknown as {
        consumePresetRequest: () => boolean;
      }
    ).consumePresetRequest();

    state = readState();
    expect(state.preset_requests).toEqual([
      {
        request_id: 'req-other',
        session_id: 'other-session',
        preset: 'old',
      },
    ]);
    expect(state.sessions[0].preset).toMatchObject({
      current: 'cheap',
      last_request_id: 'req-1',
      result_ok: true,
    });
    expect(readFileSync(projectConfigPath, 'utf8')).toContain(
      '// Project-local preset should remain',
    );
    expect(readFileSync(projectConfigPath, 'utf8')).toContain(
      '"preset": "cheap"',
    );
  });

  it('does not reapply a preset after post-apply acknowledgement failure', () => {
    const projectDir = path.join(TEST_DIR, 'preset-ack-failure');
    const projectConfigDir = path.join(projectDir, '.opencode');
    mkdirSync(projectConfigDir, { recursive: true });
    const projectConfigPath = path.join(
      projectConfigDir,
      'oh-my-opencode-slim.jsonc',
    );
    writeFileSync(projectConfigPath, JSON.stringify({ preset: 'old' }));

    const userConfigPath = path.join(
      TEST_DIR,
      'config',
      'opencode',
      'oh-my-opencode-slim.json',
    );
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        presets: {
          old: { orchestrator: { model: 'old-model' } },
          cheap: { orchestrator: { model: 'cheap-model' } },
        },
      }),
    );

    const m = make('preset-ack-failure-session', projectDir);
    m.onLoad();
    let state = readState();
    state.preset_requests = [
      {
        request_id: 'req-stale-after-apply',
        session_id: 'preset-ack-failure-session',
        scope: 'project',
        preset: 'cheap',
      },
    ];
    writeFileSync(stateFilePath(), JSON.stringify(state));

    const internal = m as unknown as {
      acknowledgePresetRequest: (requestId: string) => boolean;
      consumePresetRequest: () => boolean;
    };
    const realAcknowledge = internal.acknowledgePresetRequest.bind(m);
    let failAcknowledgement = true;
    internal.acknowledgePresetRequest = (requestId: string) => {
      if (failAcknowledgement) {
        failAcknowledgement = false;
        return false;
      }
      return realAcknowledge(requestId);
    };

    internal.consumePresetRequest();
    expect(JSON.parse(readFileSync(projectConfigPath, 'utf8')).preset).toBe(
      'cheap',
    );
    state = readState();
    expect(state.preset_requests).toHaveLength(1);
    expect(state.sessions[0].preset.last_request_id).toBe(
      'req-stale-after-apply',
    );

    // A later manual change must not be overwritten when the stale queue entry
    // is observed again. The second poll only retries acknowledgement.
    writeFileSync(projectConfigPath, JSON.stringify({ preset: 'old' }));
    internal.consumePresetRequest();

    expect(JSON.parse(readFileSync(projectConfigPath, 'utf8')).preset).toBe(
      'old',
    );
    expect(readState().preset_requests).toBeUndefined();
  });

  it('restores the applied-request fence after manager restart', () => {
    const projectDir = path.join(TEST_DIR, 'preset-restart-fence');
    const projectConfigDir = path.join(projectDir, '.opencode');
    mkdirSync(projectConfigDir, { recursive: true });
    const projectConfigPath = path.join(
      projectConfigDir,
      'oh-my-opencode-slim.jsonc',
    );
    // Simulate a later manual edit after the request already applied.
    writeFileSync(projectConfigPath, JSON.stringify({ preset: 'old' }));

    const userConfigPath = path.join(
      TEST_DIR,
      'config',
      'opencode',
      'oh-my-opencode-slim.json',
    );
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        presets: {
          old: { orchestrator: { model: 'old-model' } },
          cheap: { orchestrator: { model: 'cheap-model' } },
        },
      }),
    );

    // Simulate persisted state left by a process that applied the request,
    // published completion, then failed to remove the stale queue entry.
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    writeFileSync(
      stateFilePath(),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            session_id: 'preset-restart-session',
            cwd: projectDir,
            active_agents: ['intro'],
            active_agent_details: [],
            status: 'idle',
            pid: process.pid,
            preset: {
              available: ['cheap', 'old'],
              project_available: ['cheap', 'old'],
              global_available: ['cheap', 'old'],
              last_request_id: 'req-restart-stale',
              result_ok: true,
              last_scope: 'project',
            },
          },
        ],
        preset_requests: [
          {
            request_id: 'req-restart-stale',
            session_id: 'preset-restart-session',
            scope: 'project',
            preset: 'cheap',
          },
        ],
      }),
    );

    const replacement = make('preset-restart-session', projectDir);
    replacement.onLoad();
    (
      replacement as unknown as {
        consumePresetRequest: () => boolean;
      }
    ).consumePresetRequest();

    // Restored last_request_id must fence the stale request: acknowledge only,
    // without reapplying "cheap" over the later manual "old" selection.
    expect(JSON.parse(readFileSync(projectConfigPath, 'utf8')).preset).toBe(
      'old',
    );
    expect(readState().preset_requests).toBeUndefined();
  });

  it('reports the v2 ancestor preset after an Inherit request', () => {
    const workspace = path.join(TEST_DIR, 'workspace');
    const worktree = path.join(workspace, 'worktrees', 'feature');
    mkdirSync(path.join(workspace, '.opencode'), { recursive: true });
    mkdirSync(path.join(worktree, '.opencode'), { recursive: true });
    writeFileSync(path.join(worktree, '.git'), 'gitdir: fixture');
    const ancestorPath = path.join(
      workspace,
      '.opencode',
      'oh-my-opencode-slim.json',
    );
    writeFileSync(
      ancestorPath,
      JSON.stringify({
        preset: 'shared',
        presets: { shared: { fixer: { model: 'test/shared' } } },
      }),
    );
    writeFileSync(
      path.join(worktree, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({ preset: 'local' }),
    );
    const manager = new CompanionManager(
      'inherit-ancestor',
      worktree,
      { enabled: true },
      'v2',
    );
    managers.push(manager);
    writeAttachment(process.pid, worktree);
    manager.onLoad();
    const state = readState();
    state.preset_requests = [
      {
        request_id: 'inherit-request',
        session_id: 'inherit-ancestor',
        scope: 'project',
        inherit: true,
      },
    ];
    writeFileSync(stateFilePath(), JSON.stringify(state));
    (
      manager as unknown as { consumePresetRequest: () => boolean }
    ).consumePresetRequest();
    const preset = readState().sessions.find(
      (session: { session_id: string }) =>
        session.session_id === 'inherit-ancestor',
    ).preset;
    expect(preset).toMatchObject({
      effective: 'shared',
      project: 'shared',
      result_ok: true,
    });
    expect(preset.message).toContain('ancestor');
    expect(JSON.parse(readFileSync(ancestorPath, 'utf-8')).preset).toBe(
      'shared',
    );
  });

  it('keeps per-project overrides isolated while global preset refreshes inheriting projects', () => {
    const projectLocal = path.join(TEST_DIR, 'project-local');
    const projectInherited = path.join(TEST_DIR, 'project-inherited');
    mkdirSync(path.join(projectLocal, '.opencode'), { recursive: true });
    mkdirSync(projectInherited, { recursive: true });
    writeFileSync(
      path.join(projectLocal, '.opencode', 'oh-my-opencode-slim.jsonc'),
      JSON.stringify({ preset: 'local' }),
    );

    const userConfigPath = path.join(
      TEST_DIR,
      'config',
      'opencode',
      'oh-my-opencode-slim.json',
    );
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        preset: 'global-a',
        presets: {
          local: { orchestrator: { model: 'local-model' } },
          'global-a': { orchestrator: { model: 'global-a-model' } },
          'global-b': { orchestrator: { model: 'global-b-model' } },
        },
      }),
    );

    const local = make('local-session', projectLocal);
    const inherited = make('inherited-session', projectInherited);
    local.onLoad();
    inherited.onLoad();

    let state = readState();
    const localEntry = state.sessions.find(
      (session: { session_id: string }) =>
        session.session_id === 'local-session',
    );
    const inheritedEntry = state.sessions.find(
      (session: { session_id: string }) =>
        session.session_id === 'inherited-session',
    );
    expect(localEntry.preset).toMatchObject({
      effective: 'local',
      project: 'local',
      global: 'global-a',
      global_available: ['global-a', 'global-b', 'local'],
    });
    expect(inheritedEntry.preset).toMatchObject({
      effective: 'global-a',
      global: 'global-a',
    });
    expect(inheritedEntry.preset.project).toBeUndefined();

    state.preset_requests = [
      {
        request_id: 'req-global',
        session_id: 'inherited-session',
        scope: 'global',
        preset: 'global-b',
        inherit: false,
      },
    ];
    writeFileSync(stateFilePath(), JSON.stringify(state));
    (
      inherited as unknown as {
        consumePresetRequest: () => boolean;
      }
    ).consumePresetRequest();

    for (let i = 0; i < 4; i++) {
      (
        local as unknown as {
          pollPresetState: () => void;
        }
      ).pollPresetState();
    }

    state = readState();
    const localAfter = state.sessions.find(
      (session: { session_id: string }) =>
        session.session_id === 'local-session',
    );
    const inheritedAfter = state.sessions.find(
      (session: { session_id: string }) =>
        session.session_id === 'inherited-session',
    );
    expect(localAfter.preset).toMatchObject({
      effective: 'local',
      project: 'local',
      global: 'global-b',
    });
    expect(inheritedAfter.preset).toMatchObject({
      effective: 'global-b',
      global: 'global-b',
      last_scope: 'global',
      result_ok: true,
    });
  });

  it('keeps legacy unscoped Companion requests on effective semantics', () => {
    const projectDir = path.join(TEST_DIR, 'legacy-effective-project');
    mkdirSync(projectDir, { recursive: true });
    const userConfigPath = path.join(
      TEST_DIR,
      'config',
      'opencode',
      'oh-my-opencode-slim.json',
    );
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        preset: 'global-a',
        presets: {
          'global-a': { orchestrator: { model: 'global-a-model' } },
          'global-b': { orchestrator: { model: 'global-b-model' } },
        },
      }),
    );

    const m = make('legacy-effective-session', projectDir);
    m.onLoad();

    const state = readState();
    state.preset_requests = [
      {
        request_id: 'legacy-unscoped',
        session_id: 'legacy-effective-session',
        preset: 'global-b',
      },
    ];
    writeFileSync(stateFilePath(), JSON.stringify(state));

    (
      m as unknown as {
        consumePresetRequest: () => boolean;
      }
    ).consumePresetRequest();

    expect(JSON.parse(readFileSync(userConfigPath, 'utf8')).preset).toBe(
      'global-b',
    );
    expect(
      existsSync(
        path.join(projectDir, '.opencode', 'oh-my-opencode-slim.jsonc'),
      ),
    ).toBe(false);
  });

  it('refreshes published preset state after an external config edit', () => {
    const projectDir = path.join(TEST_DIR, 'refresh-project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    mkdirSync(projectConfigDir, { recursive: true });
    const projectConfigPath = path.join(
      projectConfigDir,
      'oh-my-opencode-slim.jsonc',
    );
    writeFileSync(projectConfigPath, JSON.stringify({ preset: 'old' }));

    const userConfigPath = path.join(
      TEST_DIR,
      'config',
      'opencode',
      'oh-my-opencode-slim.json',
    );
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        presets: {
          old: { orchestrator: { model: 'old-model' } },
          cheap: { orchestrator: { model: 'cheap-model' } },
        },
      }),
    );

    const m = make('refresh-session', projectDir);
    m.onLoad();
    expect(readState().sessions[0].preset.current).toBe('old');

    writeFileSync(projectConfigPath, JSON.stringify({ preset: 'cheap' }));
    for (let i = 0; i < 4; i++) {
      (
        m as unknown as {
          pollPresetState: () => void;
        }
      ).pollPresetState();
    }

    expect(readState().sessions[0].preset).toMatchObject({
      current: 'cheap',
      available: ['cheap', 'old'],
    });
  });

  it('preserves request acknowledgement across a racing external refresh', () => {
    const projectDir = path.join(TEST_DIR, 'ack-refresh-project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    mkdirSync(projectConfigDir, { recursive: true });
    const projectConfigPath = path.join(
      projectConfigDir,
      'oh-my-opencode-slim.jsonc',
    );
    writeFileSync(projectConfigPath, JSON.stringify({ preset: 'old' }));

    const userConfigPath = path.join(
      TEST_DIR,
      'config',
      'opencode',
      'oh-my-opencode-slim.json',
    );
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        presets: {
          old: { orchestrator: { model: 'old-model' } },
          cheap: { orchestrator: { model: 'cheap-model' } },
        },
      }),
    );

    const m = make('ack-refresh-session', projectDir);
    m.onLoad();

    let state = readState();
    state.preset_requests = [
      {
        request_id: 'req-ack',
        session_id: 'ack-refresh-session',
        preset: 'cheap',
      },
    ];
    writeFileSync(stateFilePath(), JSON.stringify(state));
    (
      m as unknown as {
        consumePresetRequest: () => boolean;
      }
    ).consumePresetRequest();

    state = readState();
    expect(state.sessions[0].preset).toMatchObject({
      current: 'cheap',
      last_request_id: 'req-ack',
      result_ok: true,
    });

    // External edit lands before the native Companion has observed req-ack.
    writeFileSync(projectConfigPath, JSON.stringify({ preset: 'old' }));
    for (let i = 0; i < 4; i++) {
      (
        m as unknown as {
          pollPresetState: () => void;
        }
      ).pollPresetState();
    }

    state = readState();
    expect(state.sessions[0].preset).toMatchObject({
      current: 'old',
      last_request_id: 'req-ack',
    });
    expect(state.sessions[0].preset.result_ok).toBeUndefined();
  });

  it('keeps the last-known preset state when an external edit is malformed', () => {
    const projectDir = path.join(TEST_DIR, 'malformed-project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    mkdirSync(projectConfigDir, { recursive: true });
    const projectConfigPath = path.join(
      projectConfigDir,
      'oh-my-opencode-slim.jsonc',
    );
    writeFileSync(projectConfigPath, JSON.stringify({ preset: 'old' }));

    const userConfigPath = path.join(
      TEST_DIR,
      'config',
      'opencode',
      'oh-my-opencode-slim.json',
    );
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        presets: {
          old: { orchestrator: { model: 'old-model' } },
        },
      }),
    );

    const m = make('malformed-session', projectDir);
    m.onLoad();
    expect(readState().sessions[0].preset.current).toBe('old');

    writeFileSync(projectConfigPath, '{ invalid json');
    for (let i = 0; i < 4; i++) {
      (
        m as unknown as {
          pollPresetState: () => void;
        }
      ).pollPresetState();
    }

    expect(readState().sessions[0].preset.current).toBe('old');
  });

  it('keeps the last-known preset state when a v2 edit reintroduces a retired mode', () => {
    const projectDir = path.join(TEST_DIR, 'retired-mode-project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    mkdirSync(projectConfigDir, { recursive: true });
    const projectConfigPath = path.join(
      projectConfigDir,
      'oh-my-opencode-slim.jsonc',
    );
    writeFileSync(projectConfigPath, JSON.stringify({ preset: 'old' }));

    const userConfigPath = path.join(
      TEST_DIR,
      'config',
      'opencode',
      'oh-my-opencode-slim.json',
    );
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        presets: {
          old: { orchestrator: { model: 'old-model' } },
          cheap: { orchestrator: { model: 'cheap-model' } },
        },
      }),
    );

    const manager = new CompanionManager(
      'retired-mode-session',
      projectDir,
      { enabled: true },
      'v2',
    );
    managers.push(manager);
    writeAttachment(process.pid, projectDir);
    manager.onLoad();
    expect(readState().sessions[0].preset).toMatchObject({
      current: 'old',
      available: ['cheap', 'old'],
    });

    writeFileSync(
      projectConfigPath,
      JSON.stringify({
        preset: 'cheap',
        backgroundJobs: { mode: 'managed' },
      }),
    );
    for (let i = 0; i < 4; i++) {
      (
        manager as unknown as {
          pollPresetState: () => void;
        }
      ).pollPresetState();
    }

    // The rejected read retains the last good view instead of publishing a
    // fallback or throwing out of the 250ms poll.
    expect(readState().sessions[0].preset).toMatchObject({
      current: 'old',
      available: ['cheap', 'old'],
    });
  });

  it('fails a preset request against a v2 config with retired keys without mutating it', () => {
    const projectDir = path.join(TEST_DIR, 'retired-limit-project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    mkdirSync(projectConfigDir, { recursive: true });
    const projectConfigPath = path.join(
      projectConfigDir,
      'oh-my-opencode-slim.jsonc',
    );
    writeFileSync(projectConfigPath, JSON.stringify({ preset: 'old' }));

    const userConfigPath = path.join(
      TEST_DIR,
      'config',
      'opencode',
      'oh-my-opencode-slim.json',
    );
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        presets: {
          old: { orchestrator: { model: 'old-model' } },
          cheap: { orchestrator: { model: 'cheap-model' } },
        },
      }),
    );

    const manager = new CompanionManager(
      'retired-limit-session',
      projectDir,
      { enabled: true },
      'v2',
    );
    managers.push(manager);
    writeAttachment(process.pid, projectDir);
    manager.onLoad();

    const rejected = JSON.stringify({
      preset: 'old',
      backgroundJobs: { concurrency: { defaultConcurrency: 2 } },
    });
    writeFileSync(projectConfigPath, rejected);
    const state = readState();
    state.preset_requests = [
      {
        request_id: 'req-retired',
        session_id: 'retired-limit-session',
        scope: 'project',
        preset: 'cheap',
      },
    ];
    writeFileSync(stateFilePath(), JSON.stringify(state));

    let consumed: boolean | undefined;
    expect(() => {
      consumed = (
        manager as unknown as {
          consumePresetRequest: () => boolean;
        }
      ).consumePresetRequest();
    }).not.toThrow();

    const after = readState();
    expect(consumed).toBe(true);
    expect(after.preset_requests).toBeUndefined();
    expect(after.sessions[0].preset).toMatchObject({
      current: 'old',
      last_request_id: 'req-retired',
      result_ok: false,
    });
    expect(after.sessions[0].preset.message).toContain(
      'not supported on this host',
    );
    // No file mutation: the rejected config bytes survive untouched.
    expect(readFileSync(projectConfigPath, 'utf8')).toBe(rejected);
  });

  it('shows orchestrator while orchestrator is busy with no specialists', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_orch',
      agent: 'orchestrator',
      status: 'busy',
    });
    expect(readState().sessions[0].active_agents).toEqual(['orchestrator']);
    expect(readState().sessions[0].status).toBe('busy');
  });

  it('keeps the remaining root and its model active when another root finishes', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'root-a',
      agent: 'orchestrator',
      status: 'busy',
    });
    m.onSessionModelChanged({ sessionId: 'root-a', model: 'provider/a' });
    m.onSessionStatus({
      sessionId: 'root-b',
      agent: 'orchestrator',
      status: 'busy',
    });
    m.onSessionModelChanged({ sessionId: 'root-b', model: 'provider/b' });
    m.onSessionStatus({
      sessionId: 'root-b',
      agent: 'orchestrator',
      status: 'idle',
    });
    expect(readState().sessions[0]).toMatchObject({
      status: 'busy',
      active_agents: ['orchestrator'],
      active_agent_details: [
        { session_id: 'root-a', agent: 'orchestrator', model: 'provider/a' },
      ],
    });
  });

  it('removes a provisional v2 root after its agent is identified and it finishes', () => {
    const m = make();
    m.onLoad();
    const project = (type: string, agent?: string) => {
      for (const event of mapV2EventToV1({
        type,
        data: { sessionID: 'root' },
      })) {
        if (event.type === 'session.status') {
          m.onSessionStatus({
            sessionId: 'root',
            agent,
            status: (event.properties as { status: { type: string } }).status
              .type,
          });
        }
      }
    };
    project('session.execution.started');
    m.onSessionStatus({
      sessionId: 'root',
      agent: 'orchestrator',
      status: 'busy',
    });
    project('session.execution.succeeded', 'orchestrator');
    expect(readState().sessions[0]).toMatchObject({
      status: 'idle',
      active_agents: ['intro'],
      active_agent_details: [],
    });
  });

  it('shows a specialist while its session is busy', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_orch',
      agent: 'orchestrator',
      status: 'busy',
    });
    m.onSessionStatus({ sessionId: 'ses_a', agent: 'oracle', status: 'busy' });
    expect(readState().sessions[0].active_agents).toEqual(['oracle']);
  });

  it('ignores a trailing busy for a child whose job already finished', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_orch',
      agent: 'orchestrator',
      status: 'busy',
    });
    m.onSessionStatus({ sessionId: 'ses_a', agent: 'oracle', status: 'busy' });
    m.onSessionStatus({ sessionId: 'ses_a', agent: 'oracle', status: 'idle' });
    m.onSessionStatus({
      sessionId: 'ses_a',
      agent: 'oracle',
      status: 'busy',
      jobFinished: true,
    });
    expect(readState().sessions[0].active_agents).toEqual(['orchestrator']);
  });

  it('publishes live model details without changing the active agent', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_a',
      agent: 'fixer',
      status: 'busy',
    });
    m.onSessionModelChanged({
      sessionId: 'ses_a',
      model: 'provider/model-a',
      variant: 'high',
      variantObserved: true,
    });

    let state = readState();
    expect(state.sessions[0].active_agents).toEqual(['fixer']);
    expect(state.sessions[0].active_agent_details).toEqual([
      {
        session_id: 'ses_a',
        agent: 'fixer',
        model: 'provider/model-a',
        variant: 'high',
      },
    ]);

    m.onSessionModelChanged({
      sessionId: 'ses_a',
      model: 'provider/model-b',
      variant: 'medium',
    });

    state = readState();
    expect(state.sessions[0].active_agents).toEqual(['fixer']);
    expect(state.sessions[0].active_agent_details[0]).toMatchObject({
      session_id: 'ses_a',
      agent: 'fixer',
      model: 'provider/model-b',
      variant: 'medium',
    });
  });

  it('publishes orchestrator model details while it is the visible agent', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_orch',
      agent: 'orchestrator',
      status: 'busy',
    });
    m.onSessionModelChanged({
      sessionId: 'ses_orch',
      model: 'provider/orchestrator',
      variant: 'max',
      variantObserved: true,
    });

    expect(readState().sessions[0].active_agent_details).toEqual([
      {
        session_id: 'ses_orch',
        agent: 'orchestrator',
        model: 'provider/orchestrator',
        variant: 'max',
      },
    ]);
  });

  it('preserves an observed live variant across same-model telemetry and clears it on model change', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_a',
      agent: 'fixer',
      status: 'busy',
    });
    m.onSessionModelChanged({
      sessionId: 'ses_a',
      model: 'provider/model-a',
      variant: 'high',
    });
    m.onSessionModelChanged({
      sessionId: 'ses_a',
      model: 'provider/model-a',
    });

    let detail = readState().sessions[0].active_agent_details[0];
    expect(detail).toMatchObject({
      model: 'provider/model-a',
      variant: 'high',
    });

    m.onSessionModelChanged({
      sessionId: 'ses_a',
      model: 'provider/model-b',
    });
    detail = readState().sessions[0].active_agent_details[0];
    expect(detail.model).toBe('provider/model-b');
    expect(detail.variant).toBeUndefined();
  });

  it('clears a previous variant when chat selection authoritatively omits it', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_a',
      agent: 'fixer',
      status: 'busy',
    });
    m.onSessionModelChanged({
      sessionId: 'ses_a',
      model: 'provider/model-a',
      variant: 'high',
      variantObserved: true,
    });
    m.onSessionModelChanged({
      sessionId: 'ses_a',
      model: 'provider/model-a',
      variantObserved: true,
    });

    const detail = readState().sessions[0].active_agent_details[0];
    expect(detail.model).toBe('provider/model-a');
    expect(detail.variant).toBeUndefined();
  });

  it('does not flush when model metadata is unchanged', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_a',
      agent: 'fixer',
      status: 'busy',
    });

    const internal = m as unknown as {
      flush: () => void;
    };
    let flushes = 0;
    internal.flush = () => {
      flushes += 1;
    };

    m.onSessionModelChanged({
      sessionId: 'ses_a',
      model: 'provider/model-a',
      variant: 'high',
    });
    expect(flushes).toBe(1);

    m.onSessionModelChanged({
      sessionId: 'ses_a',
      model: 'provider/model-a',
      variant: 'high',
    });
    m.onSessionModelChanged({
      sessionId: 'ses_a',
      model: 'provider/model-a',
    });
    expect(flushes).toBe(1);
  });

  it('shows all concurrently busy specialists', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_a',
      agent: 'explorer',
      status: 'busy',
    });
    m.onSessionStatus({ sessionId: 'ses_b', agent: 'fixer', status: 'busy' });
    m.onSessionStatus({
      sessionId: 'ses_c',
      agent: 'oracle',
      status: 'busy',
    });
    const agents = readState().sessions[0].active_agents;
    expect(agents).toHaveLength(3);
    expect(agents).toContain('explorer');
    expect(agents).toContain('fixer');
    expect(agents).toContain('oracle');
  });

  it('removes a specialist when its session goes idle', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_orch',
      agent: 'orchestrator',
      status: 'busy',
    });
    m.onSessionStatus({
      sessionId: 'ses_a',
      agent: 'explorer',
      status: 'busy',
    });
    m.onSessionStatus({ sessionId: 'ses_b', agent: 'fixer', status: 'busy' });
    m.onSessionStatus({
      sessionId: 'ses_a',
      agent: 'explorer',
      status: 'idle',
    });
    expect(readState().sessions[0].active_agents).toEqual(['fixer']);
  });

  it('falls back to orchestrator when last specialist finishes but orchestrator still busy', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_orch',
      agent: 'orchestrator',
      status: 'busy',
    });
    m.onSessionStatus({ sessionId: 'ses_a', agent: 'oracle', status: 'busy' });
    m.onSessionStatus({ sessionId: 'ses_a', agent: 'oracle', status: 'idle' });
    expect(readState().sessions[0].active_agents).toEqual(['orchestrator']);
  });

  it('keeps background specialists visible when orchestrator goes idle', () => {
    // Background orchestration: orchestrator dispatches and idles while the
    // specialist keeps running in its own session.
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_orch',
      agent: 'orchestrator',
      status: 'busy',
    });
    m.onSessionStatus({ sessionId: 'ses_a', agent: 'fixer', status: 'busy' });
    m.onSessionStatus({
      sessionId: 'ses_orch',
      agent: 'orchestrator',
      status: 'idle',
    });
    expect(readState().sessions[0].active_agents).toEqual(['fixer']);
    // Specialist finishes afterwards → back to intro
    m.onSessionStatus({ sessionId: 'ses_a', agent: 'fixer', status: 'idle' });
    expect(readState().sessions[0].active_agents).toEqual(['intro']);
    expect(readState().sessions[0].status).toBe('idle');
  });

  it('removes a finished specialist even when its agent name is unknown', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({ sessionId: 'ses_a', agent: 'oracle', status: 'busy' });
    m.onSessionStatus({ sessionId: 'ses_a', agent: undefined, status: 'idle' });
    expect(readState().sessions[0].active_agents).toEqual(['intro']);
  });

  it('removes a specialist when its session is deleted', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_a',
      agent: 'explorer',
      status: 'busy',
    });
    m.onSessionDeleted('ses_a');
    expect(readState().sessions[0].active_agents).toEqual(['intro']);
  });

  it('ignores status events with unknown status but tracks busy without agent', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({ sessionId: 'ses_x', agent: undefined, status: 'busy' });
    m.onSessionStatus({ sessionId: 'ses_y', agent: 'fixer', status: 'retry' });
    // ses_x is now tracked because Herdr subagents often lack
    // the agent field; the session ID is used as a fallback name.
    expect(readState().sessions[0].active_agents).toEqual(['orchestrator']);
  });

  it('never stores a raw session ID as the agent name', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_eff272862ffe2iolrAumwxISUr',
      agent: undefined,
      status: 'busy',
    });
    const agents = readState().sessions[0].active_agents;
    expect(agents).not.toContain('ses_eff272862ffe2iolrAumwxISUr');
    // still shown as busy, under a name the companion has an asset for
    expect(agents).toEqual(['orchestrator']);
  });

  it('accepts busy sessions from agents without a known name (Herdr subagents)', () => {
    const m = make();
    m.onLoad();
    // Simulate a Herdr subagent: busy event fires but agent is undefined
    m.onSessionStatus({
      sessionId: 'herdr_ses',
      agent: undefined,
      status: 'busy',
    });
    expect(readState().sessions[0].active_agents).toEqual(['orchestrator']);
    // The overall status stays 'idle' — only the orchestrator drives
    // that field. Herdr subagents appear in active_agents.
    // When the session goes idle it is removed even without a known agent name
    m.onSessionStatus({
      sessionId: 'herdr_ses',
      agent: undefined,
      status: 'idle',
    });
    expect(readState().sessions[0].active_agents).toEqual(['intro']);
    expect(readState().sessions[0].status).toBe('idle');
  });

  it('shows input gif while waiting for user input without borrowing orchestrator metadata', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_orch',
      agent: 'orchestrator',
      status: 'busy',
    });
    m.onSessionModelChanged({
      sessionId: 'ses_orch',
      model: 'provider/orchestrator',
      variant: 'high',
    });
    m.onWaitingInput({ sessionId: 'input', kind: 'permission' });
    expect(readState().sessions[0].active_agents).toEqual(['input']);
    expect(readState().sessions[0].active_agent_details).toEqual([]);
    expect(readState().sessions[0].status).toBe('waiting-input');
    m.onInputResolved({ sessionId: 'input', kind: 'permission' });
    expect(readState().sessions[0].status).toBe('busy');
  });

  it('increments attention generation once per distinct input request id', () => {
    const m = make();
    m.onLoad();

    m.onWaitingInput({
      sessionId: 'input',
      kind: 'permission',
      requestId: 'request-1',
    });
    expect(readState().sessions[0].attention_seq).toBe(1);

    // v2 permission asks are delivered raw + synthesized with the same id.
    // The additive bridge copy must not create a second native notification.
    m.onWaitingInput({
      sessionId: 'input',
      kind: 'permission',
      requestId: 'request-1',
    });
    expect(readState().sessions[0].attention_seq).toBe(1);

    // A distinct request must remain distinguishable even if a native watcher
    // never observed an intermediate resolved state.
    m.onInputResolved({
      sessionId: 'input',
      kind: 'permission',
      requestId: 'request-1',
    });
    m.onWaitingInput({
      sessionId: 'input',
      kind: 'permission',
      requestId: 'request-2',
    });
    expect(readState().sessions[0].attention_seq).toBe(2);
  });

  it('preserves attention identity across manager replacement', () => {
    const first = make();
    first.onLoad();
    first.onWaitingInput({
      sessionId: 'input',
      kind: 'permission',
      requestId: 'request-1',
    });
    expect(readState().sessions[0].attention_seq).toBe(1);

    const replacement = make();
    replacement.onLoad();

    // Re-delivery of the request that was already published must remain
    // deduplicated after the replacement manager takes ownership.
    replacement.onWaitingInput({
      sessionId: 'input',
      kind: 'permission',
      requestId: 'request-1',
    });
    expect(readState().sessions[0].attention_seq).toBe(1);

    replacement.onInputResolved({
      sessionId: 'input',
      kind: 'permission',
      requestId: 'request-1',
    });
    replacement.onWaitingInput({
      sessionId: 'input',
      kind: 'permission',
      requestId: 'request-2',
    });
    expect(readState().sessions[0].attention_seq).toBe(2);
    expect(readState().sessions[0].attention_request_id).toBe('request-2');
  });

  it('keeps waiting-input across lifecycle events from another session', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_orch',
      agent: 'orchestrator',
      status: 'busy',
    });
    m.onWaitingInput({ sessionId: 'input', kind: 'permission' });
    m.onSessionStatus({
      sessionId: 'ses_orch',
      agent: 'orchestrator',
      status: 'idle',
    });
    m.onSessionStatus({
      sessionId: 'ses_orch',
      agent: 'orchestrator',
      status: 'busy',
    });
    expect(readState().sessions[0].status).toBe('waiting-input');

    m.onInputResolved({ sessionId: 'input', kind: 'permission' });
    expect(readState().sessions[0].status).toBe('busy');
  });

  it('restores orchestrator busy state after input resolves', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_orch',
      agent: 'orchestrator',
      status: 'busy',
    });
    m.onWaitingInput({ sessionId: 'input', kind: 'permission' });
    expect(readState().sessions[0].status).toBe('waiting-input');

    m.onInputResolved({ sessionId: 'input', kind: 'permission' });
    expect(readState().sessions[0].status).toBe('busy');
    expect(readState().sessions[0].active_agents).toEqual(['orchestrator']);
  });

  it('keeps showing busy specialists over the input gif after input resolves', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_a',
      agent: 'designer',
      status: 'busy',
    });
    m.onWaitingInput({ sessionId: 'input', kind: 'permission' });
    m.onInputResolved({ sessionId: 'input', kind: 'permission' });
    expect(readState().sessions[0].status).toBe('busy');
    expect(readState().sessions[0].active_agents).toEqual(['designer']);
  });

  it('deduplicates by session, not by agent type', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({ sessionId: 'ses_a', agent: 'fixer', status: 'busy' });
    m.onSessionStatus({ sessionId: 'ses_b', agent: 'fixer', status: 'busy' });
    expect(readState().sessions[0].active_agents).toEqual(['fixer', 'fixer']);
  });

  it('keeps at most one process exit listener across reloads', () => {
    const baseline = process.listenerCount('exit');
    for (let i = 0; i < 5; i++) {
      const m = make('reload-session');
      m.onLoad();
    }
    // Re-inits must dedup the exit listener rather than stacking one each time.
    expect(process.listenerCount('exit')).toBeLessThanOrEqual(baseline + 1);
    // onExit releases the live listener again.
    managers.at(-1)?.onExit();
    expect(process.listenerCount('exit')).toBeLessThanOrEqual(baseline);
  });

  it('replaces a manager without a spawner-ownership lifecycle', () => {
    const first = make('reload-session');
    first.onLoad();

    const second = make('reload-session');
    second.onLoad();

    expect(readState().sessions).toHaveLength(1);
    expect(readState().sessions[0].session_id).toBe('reload-session');

    second.onExit();
    expect(readState().sessions).toEqual([]);
  });

  it('cleans up active managers when companion is disabled on reload', () => {
    const enabled = make('disable-session');
    enabled.onLoad();

    const disabled = new CompanionManager('disable-session', '/path', {
      enabled: false,
      position: 'bottom-right',
      size: 'medium',
    });
    disabled.onLoad();

    expect(readState().sessions).toEqual([]);
  });

  it('cold prune disposes a live manager synchronously when its state file is gone', async () => {
    const baseline = process.listenerCount('exit');
    const manager = make('cold-prune-session', '/cold/project');
    manager.onLoad();
    expect(process.listenerCount('exit')).toBe(baseline + 1);

    rmSync(stateFilePath(), { force: true });

    const pending = pruneDisabledCompanionRuntime('cold-prune-session');
    // The missing-state branch invokes the registered manager seam before any
    // await, so timers and the exit listener are gone immediately.
    const internal = manager as unknown as {
      presetPoller: unknown;
      publishRetryTimer: unknown;
    };
    expect(internal.presetPoller).toBeNull();
    expect(internal.publishRetryTimer).toBeNull();
    expect(process.listenerCount('exit')).toBe(baseline);
    await pending;

    expect(existsSync(stateFilePath())).toBe(false);

    // The seam survives disposal: a later generation in this process remains
    // reachable without re-registering it.
    const next = make('cold-prune-next', '/cold/next');
    next.onLoad();
    rmSync(stateFilePath(), { force: true });
    await pruneDisabledCompanionRuntime('cold-prune-next');
    expect(
      (next as unknown as { presetPoller: unknown }).presetPoller,
    ).toBeNull();
    expect(process.listenerCount('exit')).toBe(baseline);
  });

  it('cold prune disposes an unpublished manager and keeps other projects', async () => {
    const live = make('cold-live-session', '/cold/live');
    live.onLoad();

    // Hold the state lock so the next manager registers itself and starts its
    // timers, but cannot publish its owner row.
    const release = acquirePidFileLock(stateFilePath());
    expect(release).not.toBeNull();
    const blocked = make('cold-blocked-session', '/cold/blocked');
    try {
      blocked.onLoad();
      const internal = blocked as unknown as {
        presetPoller: unknown;
        publishRetryTimer: unknown;
      };
      expect(internal.presetPoller).not.toBeNull();
      expect(internal.publishRetryTimer).not.toBeNull();
    } finally {
      release?.();
    }

    // A stale row from an earlier process, plus the unrelated project's row.
    const state = readState();
    state.sessions.push({
      session_id: 'cold-blocked-session',
      cwd: '/cold/blocked',
      active_agents: ['intro'],
      status: 'idle',
      pid: process.pid,
    });
    writeFileSync(stateFilePath(), JSON.stringify(state));

    await pruneDisabledCompanionRuntime('cold-blocked-session');

    const internal = blocked as unknown as {
      presetPoller: unknown;
      publishRetryTimer: unknown;
    };
    expect(internal.presetPoller).toBeNull();
    expect(internal.publishRetryTimer).toBeNull();
    expect(
      (live as unknown as { presetPoller: unknown }).presetPoller,
    ).not.toBeNull();
    expect(
      readState().sessions.map(
        (session: { session_id: string }) => session.session_id,
      ),
    ).toEqual(['cold-live-session']);
  });

  it('removes its entry on exit', () => {
    const m = make('sess-a', '/a');
    const m2 = make('sess-b', '/b');
    m.onLoad();
    m2.onLoad();
    expect(readState().sessions).toHaveLength(2);
    m.onExit();
    const state = readState();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].session_id).toBe('sess-b');
  });

  it('coexists with a second session without clobbering either', () => {
    const a = make('a', '/proj/alpha');
    const b = make('b', '/proj/beta');
    a.onLoad();
    b.onLoad();
    a.onSessionStatus({
      sessionId: 'ses_1',
      agent: 'designer',
      status: 'busy',
    });
    b.onSessionStatus({
      sessionId: 'ses_2',
      agent: 'oracle',
      status: 'busy',
    });
    const state = readState();
    const sa = state.sessions.find(
      (s: { session_id: string }) => s.session_id === 'a',
    );
    const sb = state.sessions.find(
      (s: { session_id: string }) => s.session_id === 'b',
    );
    expect(sa.active_agents).toEqual(['designer']);
    expect(sb.active_agents).toEqual(['oracle']);
  });

  it('prunes dead process sessions while preserving live project sessions', () => {
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    writeFileSync(
      stateFilePath(),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            session_id: 'dead-project',
            cwd: '/dead',
            active_agents: ['intro'],
            status: 'idle',
            pid: 999999999,
          },
          {
            session_id: 'live-peer',
            cwd: '/live-peer',
            active_agents: ['intro'],
            status: 'idle',
            pid: process.pid,
          },
        ],
        preset_requests: [
          {
            request_id: 'dead-request',
            session_id: 'dead-project',
            scope: 'project',
            preset: 'one',
          },
        ],
      }),
    );

    const current = make('current-project', '/current');
    current.onLoad();

    const state = readState();
    expect(
      state.sessions.map(
        (session: { session_id: string }) => session.session_id,
      ),
    ).toEqual(['live-peer', 'current-project']);
    expect(state.preset_requests).toBeUndefined();
  });

  it('is disabled by default and does not write state', () => {
    const m = new CompanionManager('test-disabled', '/path');
    m.onLoad();
    expect(() => readState()).toThrow(); // File shouldn't exist because it's disabled: false by default
  });

  it('enabled writes config defaults', () => {
    const m = make('test-defaults', '/path', {
      enabled: true,
      position: 'bottom-right',
      size: 'medium',
    });
    m.onLoad();
    const state = readState();
    expect(state.config).toEqual({
      enabled: true,
      position: 'bottom-right',
      size: 'medium',
      gifPack: 'default',
      loopStyle: 'classic',
      speed: 1,
      debug: false,
    });
  });

  it('supports custom position, size, and animation settings', () => {
    const m = make('test-custom', '/path', {
      enabled: true,
      position: 'top-left',
      size: 'large',
      gifPack: 'default',
      loopStyle: 'smooth',
      speed: 1.5,
      debug: true,
    });
    m.onLoad();
    const state = readState();
    expect(state.config).toEqual({
      enabled: true,
      position: 'top-left',
      size: 'large',
      gifPack: 'default',
      loopStyle: 'smooth',
      speed: 1.5,
      debug: true,
    });
  });

  it('resolves a configured companion binary path', () => {
    const customBin = path.join(TEST_DIR, 'custom-companion');
    writeFileSync(customBin, '#!/bin/sh\n');

    expect(resolveCompanionBinaryPath({ binaryPath: customBin })).toBe(
      customBin,
    );
  });

  it('returns null when configured companion binary path does not exist', () => {
    expect(
      resolveCompanionBinaryPath({
        binaryPath: path.join(TEST_DIR, 'missing-companion'),
      }),
    ).toBeNull();
  });

  it('methods are no-ops when disabled', () => {
    const m = new CompanionManager('test-noop', '/path', {
      enabled: false,
      position: 'bottom-right',
      size: 'medium',
    });
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_a',
      agent: 'explorer',
      status: 'busy',
    });
    m.onWaitingInput({ sessionId: 'input', kind: 'permission' });
    m.onInputResolved({ sessionId: 'input', kind: 'permission' });
    m.onSessionDeleted('ses_a');
    expect(() => readState()).toThrow();
  });

  it('writes state and allows spawn normally', () => {
    const m = make('test-enabled');
    m.onLoad();

    expect(readState().sessions[0].session_id).toBe('test-enabled');
  });

  it('starts companion normally when enabled', () => {
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    writeFileSync(
      stateFilePath(),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            session_id: 'test-enabled',
            cwd: '/old',
            active_agents: [],
            status: 'idle',
            pid: 1,
          },
        ],
        config: { enabled: true, position: 'bottom-right', size: 'medium' },
      }),
    );

    const m = make('test-enabled');
    m.onLoad();

    const state = readState();
    expect(state.sessions[0].session_id).toBe('test-enabled');
    expect(state.config.enabled).toBe(true);
  });

  it('skips spawn when PID file points to a live process', () => {
    // Write a PID file with our own PID (which is alive)
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    const pidFile = companionPidFile();
    writeFileSync(pidFile, String(process.pid));

    const m = make('test-pid-guard');
    m.onLoad();
    reconcile(m);

    // Should not have spawned — PID file guard prevented it
    // The session should still be written to state
    const state = readState();
    expect(state.sessions[0].session_id).toBe('test-pid-guard');
  });

  it('spawns when PID file contains a dead process', () => {
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    const pidFile = companionPidFile();
    // Use an impossibly high PID that no kernel will ever assign
    writeFileSync(pidFile, '999999999');

    const m = make('test-stale-pid');
    m.onLoad();
    reconcile(m);

    // Stale PID file should have been cleaned up
    expect(existsSync(pidFile)).toBe(false);
    const state = readState();
    expect(state.sessions[0].session_id).toBe('test-stale-pid');
  });

  it('stores the spawned child PID in the PID file', () => {
    const bin = path.join(TEST_DIR, 'fake-companion');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);

    const m = make('test-child-pid', '/path', {
      enabled: true,
      position: 'bottom-right',
      size: 'medium',
      binaryPath: bin,
    });
    m.onLoad();
    reconcile(m);

    const pid = Number(readFileSync(companionPidFile(), 'utf8'));
    expect(Number.isInteger(pid)).toBe(true);
    expect(pid).not.toBe(process.pid);
  });

  it('keeps state published while the poller owns spawning', () => {
    const m = make('test-no-pid');
    m.onLoad();
    const state = readState();
    expect(state.sessions[0].session_id).toBe('test-no-pid');
  });

  it('ordinary disposal removes its row without signaling the companion', () => {
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    const pidFile = companionPidFile();
    writeFileSync(pidFile, String(process.pid));

    const m = make('test-pid-no-cleanup');
    m.onLoad();
    m.onExit();

    expect(existsSync(pidFile)).toBe(true);
    expect(readState().sessions).toEqual([]);
  });

  it('removes disabled session entries on load', () => {
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    writeFileSync(
      stateFilePath(),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            session_id: 'test-disabled',
            cwd: '/old',
            active_agents: ['intro'],
            status: 'idle',
            pid: 1,
          },
        ],
        config: { enabled: false, position: 'bottom-right', size: 'medium' },
      }),
    );

    const m = new CompanionManager('test-disabled', '/path', {
      enabled: false,
      position: 'bottom-right',
      size: 'medium',
    });
    m.onLoad();

    expect(readState().sessions).toEqual([]);
    expect(readState().config).toEqual({
      enabled: false,
      position: 'bottom-right',
      size: 'medium',
    });
  });

  it('recovers from corrupt state file gracefully', () => {
    const statePath = stateFilePath();
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, 'not-valid-json');

    const m = make();
    m.onLoad();

    // Must gracefully degrade to default state
    const state = readState();
    expect(state.version).toBe(1);
    expect(state.sessions).toHaveLength(1);
  });

  it('handles state write failure during disabled onLoad gracefully', () => {
    const statePath = stateFilePath();
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ version: 1, sessions: [] }));
    const originalContent = readFileSync(statePath, 'utf8');
    chmodSync(statePath, 0o444);

    const m = new CompanionManager('test-disabled', '/path', {
      enabled: false,
      position: 'bottom-right',
      size: 'medium',
    });
    m.onLoad();

    // State file must be preserved despite write failure (catch swallowed the error)
    chmodSync(statePath, 0o644);
    expect(readFileSync(statePath, 'utf8')).toBe(originalContent);
  });

  it('handles empty state file gracefully', () => {
    // readState catches JSON parse errors and returns a clean default state
    const statePath = stateFilePath();
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, '');

    const m = make();
    expect(() => {
      m.onLoad();
    }).not.toThrow();

    const state = readState();
    expect(state.version).toBe(1);
    expect(state.sessions).toHaveLength(1);
  });

  it('persists only bounded known workspaces registered by plugin managers', () => {
    const m = make('known-root', path.join(TEST_DIR, 'known-root'));
    m.onLoad();
    const state = readState();
    expect(state.known_projects).toHaveLength(1);
    expect(state.known_projects[0].cwd).toBe(path.join(TEST_DIR, 'known-root'));
    expect(resolveKnownCompanionProject(state, '/tmp/unregistered')).toBeNull();
    expect(resolveKnownCompanionProject(state, '../relative')).toBeNull();

    for (let index = 0; index < 80; index++) {
      rememberKnownCompanionProject(
        state,
        path.join(TEST_DIR, `remembered-${index}`),
        undefined,
        index,
      );
    }
    expect(state.known_projects).toHaveLength(64);
    expect(state.known_projects[63].last_seen).toBe(79);
  });

  it('updates a remembered offline project without changing the relay project', () => {
    const liveDir = path.join(TEST_DIR, 'running');
    const closedDir = path.join(TEST_DIR, 'remembered');
    mkdirSync(path.join(liveDir, '.opencode'), { recursive: true });
    mkdirSync(path.join(closedDir, '.opencode'), { recursive: true });
    const liveFile = path.join(
      liveDir,
      '.opencode',
      'oh-my-opencode-slim.jsonc',
    );
    const closedFile = path.join(
      closedDir,
      '.opencode',
      'oh-my-opencode-slim.jsonc',
    );
    writeFileSync(liveFile, '{ "preset": "old" }');
    writeFileSync(
      closedFile,
      '{\n  // Keep the offline project comment.\n  "preset": "old",\n}',
    );
    const globalPath = path.join(
      TEST_DIR,
      'config',
      'opencode',
      'oh-my-opencode-slim.json',
    );
    writeFileSync(
      globalPath,
      JSON.stringify({
        preset: 'old',
        presets: {
          old: { orchestrator: { model: 'old-model' } },
          cheap: { orchestrator: { model: 'cheap-model' } },
        },
      }),
    );

    const relay = make('live-relay', liveDir);
    relay.onLoad();
    const state = readState();
    rememberKnownCompanionProject(state, closedDir, state.sessions[0].preset);
    state.preset_requests = [
      {
        request_id: 'offline-1',
        session_id: 'live-relay',
        target_cwd: closedDir,
        scope: 'project',
        preset: 'cheap',
      },
    ];
    writeFileSync(stateFilePath(), JSON.stringify(state));
    (
      relay as unknown as { consumePresetRequest: () => boolean }
    ).consumePresetRequest();

    expect(readFileSync(closedFile, 'utf8')).toContain(
      '// Keep the offline project',
    );
    expect(readFileSync(closedFile, 'utf8')).toContain('"preset": "cheap"');
    expect(readFileSync(liveFile, 'utf8')).toContain('"preset": "old"');
    expect(
      readState().known_projects.find(
        (p: { cwd: string }) => p.cwd === closedDir,
      ).preset,
    ).toMatchObject({
      project: 'cheap',
      last_request_id: 'offline-1',
      result_ok: true,
    });
  });

  it('publishes the inherited selection after clearing an offline project override', () => {
    const closedDir = path.join(TEST_DIR, 'closed');
    mkdirSync(path.join(closedDir, '.opencode'), { recursive: true });
    const configFile = path.join(
      closedDir,
      '.opencode',
      'oh-my-opencode-slim.jsonc',
    );
    writeFileSync(configFile, '{ "preset": "local" }');
    writeFileSync(
      path.join(TEST_DIR, 'config', 'opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'global',
        presets: {
          global: { fixer: { model: 'p/g' } },
          local: { fixer: { model: 'p/l' } },
        },
      }),
    );
    const closed = make('closed', closedDir);
    closed.onLoad();
    closed.onExit();
    const relay = make('relay');
    relay.onLoad();
    const state = readState();
    state.preset_requests = [
      {
        request_id: 'inherit',
        session_id: 'relay',
        target_cwd: closedDir,
        scope: 'project',
        inherit: true,
      },
    ];
    writeFileSync(stateFilePath(), JSON.stringify(state));
    (
      relay as unknown as { consumePresetRequest: () => boolean }
    ).consumePresetRequest();
    const preset = readState().known_projects.find(
      (p: { cwd: string }) => p.cwd === closedDir,
    ).preset;
    expect(preset.project).toBeUndefined();
    expect(preset.effective).toBe('global');
    expect(readFileSync(configFile, 'utf8')).not.toContain('local');
  });

  it('rejects unregistered offline target without modifying its JSONC', () => {
    const knownDir = path.join(TEST_DIR, 'unknown-target');
    mkdirSync(path.join(knownDir, '.opencode'), { recursive: true });
    const targetFile = path.join(
      knownDir,
      '.opencode',
      'oh-my-opencode-slim.jsonc',
    );
    writeFileSync(targetFile, '{ "preset": "old" }');
    const manager = make('reject-relay', path.join(TEST_DIR, 'relay'));
    manager.onLoad();
    const state = readState();
    state.preset_requests = [
      {
        request_id: 'invalid-target',
        session_id: 'reject-relay',
        target_cwd: knownDir,
        scope: 'project',
        preset: 'cheap',
      },
    ];
    writeFileSync(stateFilePath(), JSON.stringify(state));
    (
      manager as unknown as { consumePresetRequest: () => boolean }
    ).consumePresetRequest();
    expect(readFileSync(targetFile, 'utf8')).toBe('{ "preset": "old" }');
    expect(readState().sessions[0].preset).toMatchObject({
      last_request_id: 'invalid-target',
      result_ok: false,
    });
  });

  it('refuses to rewrite malformed offline project JSONC and reports failure', () => {
    const projectDir = path.join(TEST_DIR, 'malformed-known');
    const projectConfigDir = path.join(projectDir, '.opencode');
    mkdirSync(projectConfigDir, { recursive: true });
    const projectFile = path.join(
      projectConfigDir,
      'oh-my-opencode-slim.jsonc',
    );
    const original = '{ // Invalid project JSONC\\n "preset": }';
    writeFileSync(projectFile, original);
    const manager = make('malformed-relay', path.join(TEST_DIR, 'relay'));
    manager.onLoad();
    const state = readState();
    rememberKnownCompanionProject(state, projectDir, undefined);
    state.preset_requests = [
      {
        request_id: 'malformed-request',
        session_id: 'malformed-relay',
        target_cwd: projectDir,
        scope: 'project',
        preset: 'cheap',
      },
    ];
    writeFileSync(stateFilePath(), JSON.stringify(state));
    (
      manager as unknown as { consumePresetRequest: () => boolean }
    ).consumePresetRequest();

    expect(readFileSync(projectFile, 'utf8')).toBe(original);
    const known = readState().known_projects.find(
      (entry: { cwd: string }) => entry.cwd === projectDir,
    );
    expect(known?.preset).toMatchObject({
      last_request_id: 'malformed-request',
      result_ok: false,
      message: expect.stringContaining('cannot be read or validated'),
    });
  });

  it('reports a deleted remembered project without touching the relay', () => {
    const missing = path.join(TEST_DIR, 'deleted-project');
    const live = path.join(TEST_DIR, 'live');
    mkdirSync(live, { recursive: true });
    const manager = make('missing-relay', live);
    manager.onLoad();
    const state = readState();
    rememberKnownCompanionProject(state, missing, undefined);
    state.preset_requests = [
      {
        request_id: 'missing-request',
        session_id: 'missing-relay',
        target_cwd: missing,
        scope: 'project',
        preset: 'cheap',
      },
    ];
    writeFileSync(stateFilePath(), JSON.stringify(state));
    (
      manager as unknown as { consumePresetRequest: () => boolean }
    ).consumePresetRequest();
    const next = readState();
    expect(
      next.known_projects.find(
        (entry: { cwd: string }) => entry.cwd === missing,
      )?.preset,
    ).toMatchObject({
      last_request_id: 'missing-request',
      result_ok: false,
      message: expect.stringContaining('not a known accessible'),
    });
    expect(next.sessions[0].cwd).toBe(live);
  });
});
