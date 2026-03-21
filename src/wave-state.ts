import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { generatePlanName } from "./name-generator";

export type Wave = 1 | 2 | 3 | 4;

export type WaveState = {
  wave: Wave;
  planName: string;
  sessionID: string;
  startedAt: string;
  advancedAt: string[];
  oracleReviewedAt?: string;
  oracleReviewCallID?: string;
  acceptedAt?: string;
  acceptedBySessionID?: string;
  accepted?: boolean;
};

export class WaveStateManager {
  private readonly states = new Map<string, WaveState>();

  private readonly stateDir: string;

  constructor(worktree: string) {
    this.stateDir = join(worktree, "tasks", ".wave-state");
  }

  startPlan(sessionID: string): WaveState {
    const timestamp = new Date().toISOString();
    const state: WaveState = {
      wave: 1,
      planName: generatePlanName(),
      sessionID,
      startedAt: timestamp,
      advancedAt: [timestamp]
    };
    this.states.set(sessionID, state);
    this.persist(state);
    return state;
  }

  advanceWave(sessionID: string): WaveState {
    const state = this.getState(sessionID);
    if (!state) {
      throw new Error(`No active plan found for session '${sessionID}'.`);
    }

    if (state.accepted) {
      throw new Error(
        "Plan has already been accepted. No further wave advances are needed. The planning session is complete."
      );
    }

    if (state.wave >= 4) {
      throw new Error("Wave is already at 4 and cannot be advanced further.");
    }

    if (state.wave === 2 && !state.oracleReviewedAt) {
      throw new Error(
        "Cannot advance to Wave 3 before Oracle gap review is completed. Delegate to @oracle with Task (subagent_type: \"oracle\") and then call advance_wave again."
      );
    }

    const nextWave = (state.wave + 1) as Wave;
    const nextState: WaveState = {
      ...state,
      wave: nextWave,
      advancedAt: [...state.advancedAt, new Date().toISOString()]
    };

    this.states.set(sessionID, nextState);
    this.persist(nextState);
    return nextState;
  }

  markOracleReviewed(sessionID: string, callID?: string): WaveState {
    const state = this.getState(sessionID);
    if (!state) {
      throw new Error(`No active plan found for session '${sessionID}'.`);
    }

    if (state.oracleReviewedAt) {
      return state;
    }

    const nextState: WaveState = {
      ...state,
      oracleReviewedAt: new Date().toISOString(),
      oracleReviewCallID: callID
    };

    this.states.set(sessionID, nextState);
    this.persist(nextState);
    return nextState;
  }

  getState(sessionID: string): WaveState | undefined {
    const cached = this.states.get(sessionID);
    if (cached) {
      return cached;
    }

    const loaded = this.loadStateFromDisk(sessionID);
    if (loaded) {
      this.states.set(sessionID, loaded);
    }
    return loaded;
  }

  getWave(sessionID: string): Wave | undefined {
    return this.getState(sessionID)?.wave;
  }

  getPlanName(sessionID: string): string | undefined {
    return this.getState(sessionID)?.planName;
  }

  isWaveAtLeast(sessionID: string, minWave: Wave): boolean {
    const wave = this.getWave(sessionID);
    return wave !== undefined && wave >= minWave;
  }

  markAccepted(sessionID: string, buildSessionID: string): WaveState {
    const state = this.getState(sessionID);
    if (!state) {
      throw new Error(`No active plan found for session '${sessionID}'.`);
    }

    const nextState: WaveState = {
      ...state,
      accepted: true,
      acceptedAt: new Date().toISOString(),
      acceptedBySessionID: buildSessionID
    };
    this.states.set(sessionID, nextState);
    this.persist(nextState);
    return nextState;
  }

  isAcceptedBuildSession(sessionID: string): boolean {
    for (const state of this.states.values()) {
      if (state.acceptedBySessionID === sessionID) {
        return true;
      }
    }

    if (!existsSync(this.stateDir)) {
      return false;
    }

    const entries = readdirSync(this.stateDir).filter((entry) => entry.endsWith(".json"));
    for (const entry of entries) {
      try {
        const path = join(this.stateDir, entry);
        const parsed = JSON.parse(readFileSync(path, "utf8")) as WaveState;
        if (parsed.acceptedBySessionID === sessionID) {
          return true;
        }
      } catch {
        continue;
      }
    }

    return false;
  }

  private persist(state: WaveState): void {
    this.ensureDir();
    const filePath = join(this.stateDir, `${state.planName}.json`);
    writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private ensureDir(): void {
    mkdirSync(this.stateDir, { recursive: true });
  }

  private loadStateFromDisk(sessionID: string): WaveState | undefined {
    if (!existsSync(this.stateDir)) {
      return undefined;
    }

    const entries = readdirSync(this.stateDir).filter((entry) => entry.endsWith(".json"));
    for (const entry of entries) {
      try {
        const path = join(this.stateDir, entry);
        const parsed = JSON.parse(readFileSync(path, "utf8")) as WaveState;
        if (parsed.sessionID === sessionID) {
          return parsed;
        }
      } catch {
        continue;
      }
    }

    return undefined;
  }
}
