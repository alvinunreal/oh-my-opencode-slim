import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DivoomManager, type DivoomSenderCall } from './manager';

function createGifAssets(dir: string, names: string[]): void {
  for (const name of names) {
    writeFileSync(path.join(dir, name), 'gif');
  }
}

describe('DivoomManager', () => {
  let tempDir: string;
  let calls: DivoomSenderCall[];
  let pythonPath: string;
  let scriptPath: string;
  let originalDivoomEnv: string | undefined;

  beforeEach(() => {
    originalDivoomEnv = process.env.OH_MY_OPENCODE_SLIM_DIVOOM;
    delete process.env.OH_MY_OPENCODE_SLIM_DIVOOM;
    tempDir = mkdtempSync(path.join(tmpdir(), 'divoom-test-'));
    calls = [];
    pythonPath = path.join(tempDir, 'python');
    scriptPath = path.join(tempDir, 'divoom_send.py');
    writeFileSync(pythonPath, 'python');
    writeFileSync(scriptPath, 'script');
    createGifAssets(tempDir, [
      'intro.gif',
      'orchestrator.gif',
      'explorer.gif',
      'fixer.gif',
      'oracle.gif',
    ]);
  });

  afterEach(() => {
    if (originalDivoomEnv === undefined) {
      delete process.env.OH_MY_OPENCODE_SLIM_DIVOOM;
    } else {
      process.env.OH_MY_OPENCODE_SLIM_DIVOOM = originalDivoomEnv;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createManager(config: { enabled?: boolean } = {}) {
    return new DivoomManager(
      {
        enabled: config.enabled ?? true,
        python: pythonPath,
        script: scriptPath,
      },
      (call) => {
        calls.push(call);
      },
      { assetDir: tempDir },
    );
  }

  test('does nothing when disabled', async () => {
    const manager = createManager({ enabled: false });

    manager.onPluginLoad();
    manager.onTaskStart({
      parentSessionId: 'parent',
      callId: 'call-1',
      args: { subagent_type: 'explorer' },
    });
    manager.onTaskEnd({ parentSessionId: 'parent', callId: 'call-1' });
    await manager.flush();

    expect(calls).toHaveLength(0);
  });

  test('shows intro on plugin load when enabled', async () => {
    const manager = createManager();

    manager.onPluginLoad();
    await manager.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].args[1]).toBe(path.join(tempDir, 'intro.gif'));
  });

  test('can be enabled for one run with env var', async () => {
    process.env.OH_MY_OPENCODE_SLIM_DIVOOM = '1';
    const manager = new DivoomManager(
      {
        python: pythonPath,
        script: scriptPath,
      },
      (call) => {
        calls.push(call);
      },
      { assetDir: tempDir },
    );

    manager.onPluginLoad();
    await manager.flush();

    expect(calls.map((call) => call.args[1])).toEqual([
      path.join(tempDir, 'intro.gif'),
    ]);
  });

  test('explicit config disabled wins over env var', async () => {
    process.env.OH_MY_OPENCODE_SLIM_DIVOOM = 'true';
    const manager = createManager({ enabled: false });

    manager.onPluginLoad();
    await manager.flush();

    expect(calls).toHaveLength(0);
  });

  test('shows task agent then orchestrator after a single task', async () => {
    const manager = createManager();

    manager.onTaskStart({
      parentSessionId: 'parent',
      callId: 'call-1',
      args: { subagent_type: 'explorer' },
    });
    await manager.flush();
    manager.onTaskEnd({ parentSessionId: 'parent', callId: 'call-1' });
    await manager.flush();

    expect(calls.map((call) => call.args[1])).toEqual([
      path.join(tempDir, 'explorer.gif'),
      path.join(tempDir, 'orchestrator.gif'),
    ]);
  });

  test('shows orchestrator while busy and intro when idle', async () => {
    const manager = createManager();

    manager.onOrchestratorStatus({
      sessionId: 'parent',
      status: 'busy',
      isOrchestrator: true,
    });
    await manager.flush();
    manager.onOrchestratorStatus({
      sessionId: 'parent',
      status: 'idle',
      isOrchestrator: true,
    });
    await manager.flush();

    expect(calls.map((call) => call.args[1])).toEqual([
      path.join(tempDir, 'orchestrator.gif'),
      path.join(tempDir, 'intro.gif'),
    ]);
  });

  test('idle clears active child state and returns to intro', async () => {
    const manager = createManager();

    manager.onTaskStart({
      parentSessionId: 'parent',
      callId: 'call-1',
      args: { subagent_type: 'explorer' },
    });
    await manager.flush();
    manager.onOrchestratorStatus({
      sessionId: 'parent',
      status: 'busy',
      isOrchestrator: true,
    });
    await manager.flush();
    manager.onOrchestratorStatus({
      sessionId: 'parent',
      status: 'idle',
      isOrchestrator: true,
    });
    await manager.flush();
    manager.onTaskEnd({ parentSessionId: 'parent', callId: 'call-1' });
    await manager.flush();
    manager.onOrchestratorStatus({
      sessionId: 'parent',
      status: 'idle',
      isOrchestrator: true,
    });
    await manager.flush();

    expect(calls.map((call) => call.args[1])).toEqual([
      path.join(tempDir, 'explorer.gif'),
      path.join(tempDir, 'intro.gif'),
    ]);
  });

  test('keeps first agent visible for parallel tasks', async () => {
    const manager = createManager();

    manager.onTaskStart({
      parentSessionId: 'parent',
      callId: 'call-1',
      args: { subagent_type: 'explorer' },
    });
    await manager.flush();
    manager.onTaskStart({
      parentSessionId: 'parent',
      callId: 'call-2',
      args: { subagent_type: 'fixer' },
    });
    await manager.flush();
    manager.onTaskEnd({ parentSessionId: 'parent', callId: 'call-1' });
    await manager.flush();
    manager.onTaskEnd({ parentSessionId: 'parent', callId: 'call-2' });
    await manager.flush();

    expect(calls.map((call) => call.args[1])).toEqual([
      path.join(tempDir, 'explorer.gif'),
      path.join(tempDir, 'orchestrator.gif'),
    ]);
  });

  test('falls back to orchestrator gif for unknown agents', async () => {
    const manager = createManager();

    manager.onTaskStart({
      parentSessionId: 'parent',
      callId: 'call-1',
      args: { subagent_type: 'custom-agent' },
    });
    await manager.flush();

    expect(calls.map((call) => call.args[1])).toEqual([
      path.join(tempDir, 'orchestrator.gif'),
    ]);
  });

  test('uses configured sender settings and gif overrides', async () => {
    const customGif = path.join(tempDir, 'custom-oracle.gif');
    const customPython = path.join(tempDir, 'custom-python');
    const customScript = path.join(tempDir, 'custom-divoom-send.py');
    writeFileSync(customGif, 'gif');
    writeFileSync(customPython, 'python');
    writeFileSync(customScript, 'script');
    const manager = new DivoomManager(
      {
        enabled: true,
        python: customPython,
        script: customScript,
        size: 64,
        fps: 12,
        speed: 250,
        maxFrames: 10,
        posterizeBits: 4,
        gifs: { oracle: customGif },
      },
      (call) => {
        calls.push(call);
      },
      { assetDir: tempDir },
    );

    manager.onTaskStart({
      parentSessionId: 'parent',
      callId: 'call-1',
      args: { subagent_type: 'oracle' },
    });
    await manager.flush();

    expect(calls[0]).toEqual({
      command: customPython,
      args: [
        customScript,
        customGif,
        '--size',
        '64',
        '--fps',
        '12',
        '--speed',
        '250',
        '--max-frames',
        '10',
        '--posterize-bits',
        '4',
      ],
    });
  });

  test('drops stale queued sends and keeps latest requested gif', async () => {
    const manager = createManager();

    manager.onPluginLoad();
    manager.onOrchestratorStatus({
      sessionId: 'parent',
      status: 'busy',
      isOrchestrator: true,
    });
    manager.onTaskStart({
      parentSessionId: 'parent',
      callId: 'call-1',
      args: { subagent_type: 'fixer' },
    });
    await manager.flush();

    expect(calls.map((call) => call.args[1])).toEqual([
      path.join(tempDir, 'fixer.gif'),
    ]);
  });

  test('missing executable does not poison future attempts', async () => {
    const manager = new DivoomManager(
      {
        enabled: true,
        python: path.join(tempDir, 'missing-python'),
        script: scriptPath,
      },
      (call) => {
        calls.push(call);
      },
      { assetDir: tempDir },
    );

    manager.onPluginLoad();
    await manager.flush();
    manager.onPluginLoad();
    await manager.flush();

    expect(calls).toHaveLength(0);
  });
});
