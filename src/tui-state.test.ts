import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getTuiStatePath,
  readTuiSnapshot,
  recordTuiAgentModel,
  recordTuiAgentModels,
} from './tui-state';

let previousXdgDataHome: string | undefined;
let tempDir: string;

beforeEach(() => {
  previousXdgDataHome = process.env.XDG_DATA_HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-state-'));
  process.env.XDG_DATA_HOME = tempDir;
});

afterEach(() => {
  if (previousXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = previousXdgDataHome;
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('tui-state persistence', () => {
  test('persists enabled agent models', () => {
    recordTuiAgentModels(
      {
        agentModels: {
          explorer: 'openai/gpt-5.6-luna',
          fixer: 'openai/gpt-5.6-luna',
        },
        agentVariants: {
          explorer: 'low',
          fixer: 'high',
        },
      },
      tempDir,
    );

    const snapshot = readTuiSnapshot(tempDir);

    expect(snapshot.agentModels).toEqual({
      explorer: 'openai/gpt-5.6-luna',
      fixer: 'openai/gpt-5.6-luna',
    });
    expect(snapshot.agentVariants).toEqual({
      explorer: 'low',
      fixer: 'high',
    });
  });

  test('updates a single live agent model without dropping others', () => {
    recordTuiAgentModels(
      {
        agentModels: {
          orchestrator: 'default',
          explorer: 'openai/gpt-5.6-luna',
        },
      },
      tempDir,
    );

    recordTuiAgentModel(
      {
        agentName: 'orchestrator',
        model: 'openai/gpt-5.6',
      },
      tempDir,
    );

    expect(readTuiSnapshot(tempDir).agentModels).toEqual({
      orchestrator: 'openai/gpt-5.6',
      explorer: 'openai/gpt-5.6-luna',
    });
  });

  test('updates a single live agent variant without dropping others', () => {
    recordTuiAgentModels(
      {
        agentModels: {
          orchestrator: 'default',
          explorer: 'openai/gpt-5.6-luna',
        },
        agentVariants: {
          explorer: 'low',
        },
      },
      tempDir,
    );

    recordTuiAgentModel(
      {
        agentName: 'orchestrator',
        model: 'openai/gpt-5.6',
        variant: 'high',
      },
      tempDir,
    );

    expect(readTuiSnapshot(tempDir).agentVariants).toEqual({
      orchestrator: 'high',
      explorer: 'low',
    });
  });

  test('ignores legacy config status fields in old snapshots', () => {
    const filePath = getTuiStatePath(tempDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        agentModels: { explorer: 'openai/gpt-5.6-luna' },
        configInvalid: true,
        configInvalidByProject: { old: true },
      }),
    );

    const snapshot = readTuiSnapshot(tempDir);
    expect(snapshot.agentModels).toEqual({
      explorer: 'openai/gpt-5.6-luna',
    });
    expect(snapshot.agentVariants).toEqual({});
  });
});
