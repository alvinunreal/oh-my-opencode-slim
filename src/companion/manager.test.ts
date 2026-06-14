import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CompanionManager, stateFilePath } from './manager';

// Point writes at a temp dir so tests don't touch the real state file.
const TEST_DIR = path.join(os.tmpdir(), `companion-test-${process.pid}`);
const XDG_DIR = path.join(TEST_DIR, 'xdg');
function readState() {
  return JSON.parse(readFileSync(stateFilePath(), 'utf8'));
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.XDG_DATA_HOME = XDG_DIR;
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.XDG_DATA_HOME;
});

function make(
  id = 'test-session',
  cwd = '/home/user/myproject',
  config: any = { enabled: true, position: 'bottom-right', size: 'medium' },
) {
  return new CompanionManager(id, cwd, config);
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
    });
  });

  it('supports custom position and size', () => {
    const m = make('test-custom', '/path', {
      enabled: true,
      position: 'top-left',
      size: 'large',
    });
    m.onLoad();
    const state = readState();
    expect(state.config).toEqual({
      enabled: true,
      position: 'top-left',
      size: 'large',
    });
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
