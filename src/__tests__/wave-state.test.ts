import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { WaveStateManager } from "../wave-state";

const tempDirs: string[] = [];

function createManager() {
  const root = mkdtempSync(join(tmpdir(), "wave-state-"));
  tempDirs.push(root);
  return { root, manager: new WaveStateManager(root) };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("WaveStateManager", () => {
  test("startPlan creates wave 1 state with valid plan name", () => {
    const { manager } = createManager();
    const state = manager.startPlan("session-1");

    expect(state.wave).toBe(1);
    expect(state.planName).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    expect(state.sessionID).toBe("session-1");
    expect(state.advancedAt.length).toBe(1);
  });

  test("advanceWave increments from 1 to 4", () => {
    const { manager } = createManager();
    manager.startPlan("session-2");

    const wave2 = manager.advanceWave("session-2");
    manager.markOracleReviewed("session-2", "call-session-2");
    const wave3 = manager.advanceWave("session-2");
    const wave4 = manager.advanceWave("session-2");

    expect(wave2.wave).toBe(2);
    expect(wave3.wave).toBe(3);
    expect(wave4.wave).toBe(4);
  });

  test("advanceWave throws at wave 4", () => {
    const { manager } = createManager();
    manager.startPlan("session-3");
    manager.advanceWave("session-3");
    manager.markOracleReviewed("session-3", "call-session-3");
    manager.advanceWave("session-3");
    manager.advanceWave("session-3");

    expect(() => manager.advanceWave("session-3")).toThrow(
      "cannot be advanced further"
    );
  });

  test("advanceWave throws for unknown session", () => {
    const { manager } = createManager();
    expect(() => manager.advanceWave("unknown")).toThrow("No active plan found");
  });

  test("advanceWave blocks Wave 2 -> 3 until oracle is reviewed", () => {
    const { manager } = createManager();
    manager.startPlan("session-oracle");
    manager.advanceWave("session-oracle");

    expect(() => manager.advanceWave("session-oracle")).toThrow("Oracle gap review");

    manager.markOracleReviewed("session-oracle", "call-oracle");
    const wave3 = manager.advanceWave("session-oracle");
    expect(wave3.wave).toBe(3);
  });

  test("isWaveAtLeast returns expected booleans", () => {
    const { manager } = createManager();
    manager.startPlan("session-4");

    expect(manager.isWaveAtLeast("session-4", 1)).toBe(true);
    expect(manager.isWaveAtLeast("session-4", 2)).toBe(false);

    manager.advanceWave("session-4");
    expect(manager.isWaveAtLeast("session-4", 2)).toBe(true);
    expect(manager.isWaveAtLeast("session-4", 3)).toBe(false);
  });

  test("persists state to disk", () => {
    const { root, manager } = createManager();
    const state = manager.startPlan("session-5");
    const filePath = join(root, "tasks", ".wave-state", `${state.planName}.json`);

    expect(existsSync(filePath)).toBe(true);

    const saved = JSON.parse(readFileSync(filePath, "utf8"));
    expect(saved.sessionID).toBe("session-5");
    expect(saved.wave).toBe(1);
    expect(saved.planName).toBe(state.planName);
  });

  test("loads persisted state across manager instances", () => {
    const { root, manager } = createManager();
    const state = manager.startPlan("session-6");

    const reloadedManager = new WaveStateManager(root);
    const reloaded = reloadedManager.getState("session-6");

    expect(reloaded).toBeDefined();
    expect(reloaded?.planName).toBe(state.planName);
    expect(reloaded?.wave).toBe(1);
  });

  test("advanceWave throws after plan is accepted", () => {
    const { manager } = createManager();
    manager.startPlan("session-accepted");
    manager.advanceWave("session-accepted");
    manager.markOracleReviewed("session-accepted", "call-accepted");
    manager.advanceWave("session-accepted");
    manager.advanceWave("session-accepted");
    manager.markAccepted("session-accepted", "build-session");

    expect(() => manager.advanceWave("session-accepted")).toThrow(
      "Plan has already been accepted"
    );
  });

  test("isAcceptedBuildSession returns true for accepted build session", () => {
    const { manager } = createManager();
    manager.startPlan("session-build-match");
    manager.advanceWave("session-build-match");
    manager.markOracleReviewed("session-build-match", "call-build-match");
    manager.advanceWave("session-build-match");
    manager.advanceWave("session-build-match");
    manager.markAccepted("session-build-match", "build-session-match");

    expect(manager.isAcceptedBuildSession("build-session-match")).toBe(true);
    expect(manager.isAcceptedBuildSession("build-session-missing")).toBe(false);
  });

  test("skips malformed JSON files when loading state from disk", () => {
    const { root, manager } = createManager();
    const state = manager.startPlan("session-good");

    const stateDir = join(root, "tasks", ".wave-state");
    writeFileSync(join(stateDir, "corrupted.json"), "not valid json{{{", "utf8");

    const reloaded = new WaveStateManager(root);
    const loaded = reloaded.getState("session-good");

    expect(loaded).toBeDefined();
    expect(loaded?.planName).toBe(state.planName);
    expect(loaded?.wave).toBe(1);
  });
});
