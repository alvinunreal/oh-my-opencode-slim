import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
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
import {
  CompanionManager,
  companionSessionIdForDirectory,
  normalizeCompanionSessionStatus,
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

const previousXdg = process.env.XDG_DATA_HOME;
const previousXdgConfig = process.env.XDG_CONFIG_HOME;
const previousOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
const previousPresetEnv = process.env.OH_MY_OPENCODE_SLIM_PRESET;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.XDG_DATA_HOME = XDG_DIR;
  process.env.XDG_CONFIG_HOME = path.join(TEST_DIR, 'config');
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  const configDir = path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'oh-my-opencode-slim.json'), '{}');
});

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.onExit();
  }
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

function attachFailingChild(manager: CompanionManager): void {
  (
    manager as unknown as {
      companionProcess: { kill: () => void } | null;
    }
  ).companionProcess = {
    kill: () => {
      throw new Error('mock kill failure');
    },
  };
}

function companionPidFile(): string {
  return path.join(path.dirname(stateFilePath()), 'companion.pid');
}

function companionStateLock(): string {
  return `${stateFilePath()}.lock`;
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

  it('does not spawn native companion until owner state publication succeeds', () => {
    const lock = companionStateLock();
    mkdirSync(lock, { recursive: true });

    const m = make('blocked-owner');
    const internal = m as unknown as {
      spawnIfAvailable: () => void;
      publishAndSpawn: () => void;
    };
    let spawnAttempts = 0;
    internal.spawnIfAvailable = () => {
      spawnAttempts += 1;
    };

    m.onLoad();
    expect(spawnAttempts).toBe(0);
    expect(existsSync(stateFilePath())).toBe(false);

    rmSync(lock, { recursive: true, force: true });
    internal.publishAndSpawn();

    expect(spawnAttempts).toBe(1);
    expect(readState().sessions).toContainEqual(
      expect.objectContaining({ session_id: 'blocked-owner' }),
    );
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
    m.onWaitingInput();
    expect(readState().sessions[0].active_agents).toEqual(['input']);
    expect(readState().sessions[0].active_agent_details).toEqual([]);
    expect(readState().sessions[0].status).toBe('waiting-input');
    m.onInputResolved();
    expect(readState().sessions[0].status).toBe('busy');
  });

  it('increments attention generation once per distinct input request id', () => {
    const m = make();
    m.onLoad();

    m.onWaitingInput('request-1');
    expect(readState().sessions[0].attention_seq).toBe(1);

    // v2 permission asks are delivered raw + synthesized with the same id.
    // The additive bridge copy must not create a second native notification.
    m.onWaitingInput('request-1');
    expect(readState().sessions[0].attention_seq).toBe(1);

    // A distinct request must remain distinguishable even if a native watcher
    // never observed an intermediate resolved state.
    m.onInputResolved();
    m.onWaitingInput('request-2');
    expect(readState().sessions[0].attention_seq).toBe(2);
  });

  it('preserves attention identity across manager replacement', () => {
    const first = make();
    first.onLoad();
    first.onWaitingInput('request-1');
    expect(readState().sessions[0].attention_seq).toBe(1);

    const replacement = make();
    replacement.onLoad();

    // Re-delivery of the request that was already published must remain
    // deduplicated after the replacement manager takes ownership.
    replacement.onWaitingInput('request-1');
    expect(readState().sessions[0].attention_seq).toBe(1);

    replacement.onInputResolved();
    replacement.onWaitingInput('request-2');
    expect(readState().sessions[0].attention_seq).toBe(2);
    expect(readState().sessions[0].attention_request_id).toBe('request-2');
  });

  it('keeps waiting-input sticky across busy and idle lifecycle noise', () => {
    const m = make();
    m.onLoad();
    m.onSessionStatus({
      sessionId: 'ses_orch',
      agent: 'orchestrator',
      status: 'busy',
    });
    m.onWaitingInput();
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

    m.onInputResolved();
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
    m.onWaitingInput();
    expect(readState().sessions[0].status).toBe('waiting-input');

    m.onInputResolved();
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

  it('hands native companion ownership to a superseding manager without restart', () => {
    const first = make('reload-session');
    first.onLoad();
    const firstChild = attachFakeChild(first);
    writeFileSync(companionPidFile(), String(process.pid));
    (first as unknown as { wasSpawner: boolean }).wasSpawner = true;
    (first as unknown as { spawnedCompanionPid: number }).spawnedCompanionPid =
      process.pid;

    const second = make('reload-session');
    second.onLoad();

    expect(firstChild.killed()).toBe(false);
    expect((second as unknown as { wasSpawner: boolean }).wasSpawner).toBe(
      true,
    );
    expect(readState().sessions).toHaveLength(1);
    expect(readState().sessions[0].session_id).toBe('reload-session');

    second.onExit();
    expect(firstChild.killed()).toBe(true);
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

  it('logs and swallows kill() failure gracefully during exit', () => {
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    const pidFile = companionPidFile();
    writeFileSync(pidFile, String(process.pid));

    const m = make('test-kill-failure');
    attachFailingChild(m);
    (m as unknown as { wasSpawner: boolean }).wasSpawner = true;
    (m as unknown as { spawnedCompanionPid: number }).spawnedCompanionPid =
      process.pid;

    // Must not propagate the kill() exception
    expect(() => m.onExit()).not.toThrow();
    expect(existsSync(pidFile)).toBe(false);
  });
});
