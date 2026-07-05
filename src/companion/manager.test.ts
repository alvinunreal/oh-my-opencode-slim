import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CompanionManager,
  resolveCompanionBinaryPath,
  stateFilePath,
} from './manager';

// Point writes at a temp dir so tests don't touch the real state file.
const TEST_DIR = path.join(os.tmpdir(), `companion-test-${process.pid}`);
const XDG_DIR = path.join(TEST_DIR, 'xdg');
const managers: CompanionManager[] = [];

function readState() {
  return JSON.parse(readFileSync(stateFilePath(), 'utf8'));
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.XDG_DATA_HOME = XDG_DIR;
});

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.onExit();
  }
  rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.XDG_DATA_HOME;
});

function make(
  id = 'test-session',
  cwd = '/home/user/myproject',
  config: any = { enabled: true, position: 'bottom-right', size: 'medium' },
) {
  const manager = new CompanionManager(id, cwd, config);
  managers.push(manager);
  return manager;
}

function attachFakeChild(manager: CompanionManager): { killed: () => boolean } {
  let killed = false;
  (
    manager as unknown as {
      companionProcess: { kill: () => void } | null;
    }
  ).companionProcess = {
    kill: () => {
      killed = true;
    },
  };
  return { killed: () => killed };
}

function companionPidFile(): string {
  return path.join(path.dirname(stateFilePath()), 'companion.pid');
}

describe('CompanionManager', () => {
  it('writes an intro entry on load', () => {
    const m = make();
    m.onLoad();
    const state = readState();
    expect(state.version).toBe(1);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].session_id).toBe('test-session');
    expect(state.sessions[0].cwd).toBe('/home/user/myproject');
    expect(state.sessions[0].active_agents).toEqual(['intro']);
    expect(state.sessions[0].status).toBe('idle');
    expect(state.sessions[0].pid).toBe(process.pid);
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
      agent: 'librarian',
      status: 'busy',
    });
    const agents = readState().sessions[0].active_agents;
    expect(agents).toHaveLength(3);
    expect(agents).toContain('explorer');
    expect(agents).toContain('fixer');
    expect(agents).toContain('librarian');
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

  it('ignores status events without agent or with unknown status', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({ sessionId: 'ses_x', agent: undefined, status: 'busy' });
    m.onSessionStatus({ sessionId: 'ses_y', agent: 'fixer', status: 'retry' });
    expect(readState().sessions[0].active_agents).toEqual(['intro']);
  });

  it('shows input gif while waiting for user input', () => {
    const m = make();
    m.onLoad();
    m.onWaitingInput();
    expect(readState().sessions[0].active_agents).toEqual(['input']);
    expect(readState().sessions[0].status).toBe('waiting-input');
    m.onInputResolved();
    expect(readState().sessions[0].status).toBe('idle');
  });

  it('keeps showing busy specialists over the input gif after input resolves', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_a',
      agent: 'designer',
      status: 'busy',
    });
    m.onWaitingInput();
    m.onInputResolved();
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

  it('cleans up a superseded manager for the same session on reload', () => {
    const first = make('reload-session');
    first.onLoad();
    const firstChild = attachFakeChild(first);
    writeFileSync(companionPidFile(), String(process.pid));
    (first as unknown as { wasSpawner: boolean }).wasSpawner = true;
    (first as unknown as { spawnedCompanionPid: number }).spawnedCompanionPid =
      process.pid;

    const second = make('reload-session');
    second.onLoad();

    expect(firstChild.killed()).toBe(true);
    expect(readState().sessions).toHaveLength(1);
    expect(readState().sessions[0].session_id).toBe('reload-session');

    second.onExit();
  });

  it('cleans up active managers when companion is disabled on reload', () => {
    const enabled = make('disable-session');
    enabled.onLoad();
    const child = attachFakeChild(enabled);
    writeFileSync(companionPidFile(), String(process.pid));
    (enabled as unknown as { wasSpawner: boolean }).wasSpawner = true;
    (
      enabled as unknown as { spawnedCompanionPid: number }
    ).spawnedCompanionPid = process.pid;

    const disabled = new CompanionManager('disable-session', '/path', {
      enabled: false,
      position: 'bottom-right',
      size: 'medium',
    });
    disabled.onLoad();

    expect(child.killed()).toBe(true);
    expect(readState().sessions).toEqual([]);
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
      agent: 'librarian',
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
    expect(sb.active_agents).toEqual(['librarian']);
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
    m.onWaitingInput();
    m.onInputResolved();
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

    // Stale PID file should have been cleaned up
    expect(existsSync(pidFile)).toBe(false);
    const state = readState();
    expect(state.sessions[0].session_id).toBe('test-stale-pid');
  });

  it('skips spawn while another process holds the PID file lock', () => {
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    const pidFile = companionPidFile();
    const lock = `${pidFile}.lock`;
    mkdirSync(lock);
    writeFileSync(path.join(lock, 'owner'), String(process.pid));

    const m = make('test-pending-pid');
    m.onLoad();
    m.onExit();

    expect(existsSync(lock)).toBe(true);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('stores the spawned child PID in the PID file', () => {
    const bin = path.join(TEST_DIR, 'fake-companion');
    writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(bin, 0o755);

    const m = make('test-child-pid', '/path', {
      enabled: true,
      position: 'bottom-right',
      size: 'medium',
      binaryPath: bin,
    });
    m.onLoad();

    const pid = Number(readFileSync(companionPidFile(), 'utf8'));
    expect(Number.isInteger(pid)).toBe(true);
    expect(pid).not.toBe(process.pid);
    expect(pid).toBe(
      (m as unknown as { spawnedCompanionPid: number }).spawnedCompanionPid,
    );
  });

  it('spawns when no PID file exists', () => {
    const m = make('test-no-pid');
    m.onLoad();
    const state = readState();
    expect(state.sessions[0].session_id).toBe('test-no-pid');
  });

  it('cleans up PID file on exit when this manager was the spawner', () => {
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    const pidFile = companionPidFile();
    writeFileSync(pidFile, '999999999'); // stale PID so spawn proceeds

    const m = make('test-pid-cleanup');
    // Simulate a spawner by writing a PID file as if spawn succeeded.
    // In reality the binary doesn't exist so spawn fails before writing,
    // but the cleanup logic only fires when wasSpawner is true.
    writeFileSync(pidFile, String(process.pid));
    (m as unknown as { wasSpawner: boolean }).wasSpawner = true;
    (m as unknown as { spawnedCompanionPid: number }).spawnedCompanionPid =
      process.pid;
    m.onLoad();
    m.onExit();

    expect(existsSync(pidFile)).toBe(false);
  });

  it('does not delete PID file on exit when this manager was not the spawner', () => {
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    const pidFile = companionPidFile();
    writeFileSync(pidFile, String(process.pid));

    const m = make('test-pid-no-cleanup');
    m.onLoad(); // skips spawn because PID is alive, wasSpawner stays false
    m.onExit();

    // Non-spawner must not delete the guard file
    expect(existsSync(pidFile)).toBe(true);
  });

  it('does not delete a PID file owned by a different spawned child', () => {
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    const pidFile = companionPidFile();
    writeFileSync(pidFile, '222222222');

    const m = make('test-pid-different-child');
    (m as unknown as { wasSpawner: boolean }).wasSpawner = true;
    (m as unknown as { spawnedCompanionPid: number }).spawnedCompanionPid =
      111111111;
    m.onExit();

    expect(readFileSync(pidFile, 'utf8')).toBe('222222222');
  });

  it('does not kill the singleton when another session remains in state', () => {
    const first = make('first-session');
    const second = make('second-session');
    first.onLoad();
    second.onLoad();
    const child = attachFakeChild(first);
    const pidFile = companionPidFile();
    writeFileSync(pidFile, String(process.pid));
    (first as unknown as { wasSpawner: boolean }).wasSpawner = true;
    (first as unknown as { spawnedCompanionPid: number }).spawnedCompanionPid =
      process.pid;

    first.onExit();

    expect(child.killed()).toBe(false);
    expect(readFileSync(pidFile, 'utf8')).toBe(String(process.pid));
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
});
