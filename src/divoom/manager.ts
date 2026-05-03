import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DivoomConfig } from '../config';
import { log } from '../utils/logger';

type TaskArgs = {
  subagent_type?: unknown;
};

export type DivoomSenderCall = {
  command: string;
  args: string[];
};

export type DivoomSender = (call: DivoomSenderCall) => Promise<void> | void;

type ParentState = {
  activeCalls: Map<string, string>;
  displayedAgent?: string;
};

const AGENT_GIFS: Record<string, string> = {
  council: 'council.gif',
  councillor: 'council.gif',
  designer: 'designer.gif',
  explorer: 'explorer.gif',
  fixer: 'fixer.gif',
  intro: 'intro.gif',
  librarian: 'librarian.gif',
  oracle: 'oracle.gif',
  orchestrator: 'orchestrator.gif',
};

const DEFAULT_DIVOOM_CONFIG: DivoomConfig = {
  enabled: false,
  python:
    '/Applications/Divoom MiniToo.app/Contents/Resources/.venv/bin/python',
  script:
    '/Applications/Divoom MiniToo.app/Contents/Resources/tools/divoom_send.py',
  size: 128,
  fps: 8,
  speed: 125,
  maxFrames: 24,
  posterizeBits: 3,
};

const DIVOOM_ENABLE_ENV = 'OH_MY_OPENCODE_SLIM_DIVOOM';

type DivoomManagerOptions = {
  assetDir?: string | null;
  sender?: DivoomSender;
};

function resolveAssetDir(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    moduleDir,
    path.resolve(moduleDir, 'divoom'),
    path.resolve(moduleDir, '../../src/divoom'),
    path.resolve(process.cwd(), 'src/divoom'),
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'intro.gif'))) {
      return candidate;
    }
  }

  return null;
}

function normalizeAgentName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function isEnvEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export class DivoomManager {
  private assetDir: string | null;
  private config: DivoomConfig;
  private parentStates = new Map<string, ParentState>();
  private latestRequestedGifPath?: string;
  private lastGifPath?: string;
  private sendQueue = Promise.resolve();

  constructor(
    config?: Partial<DivoomConfig>,
    private sender: DivoomSender = defaultSender,
    options: DivoomManagerOptions = {},
  ) {
    this.config = {
      ...DEFAULT_DIVOOM_CONFIG,
      ...config,
      enabled: config?.enabled ?? isEnvEnabled(process.env[DIVOOM_ENABLE_ENV]),
      gifs: config?.gifs,
    };
    this.assetDir = options.assetDir ?? resolveAssetDir();
    if (options.sender) {
      this.sender = options.sender;
    }
  }

  onPluginLoad(): void {
    this.show('intro');
  }

  onTaskStart(input: {
    parentSessionId?: string;
    callId?: string;
    args?: unknown;
  }): void {
    if (!input.parentSessionId || !input.callId) return;
    if (!isTaskArgs(input.args)) return;

    const agent = normalizeAgentName(input.args.subagent_type);
    if (!agent) return;

    const state = this.getParentState(input.parentSessionId);
    const wasIdle = state.activeCalls.size === 0;
    state.activeCalls.set(input.callId, agent);

    if (!wasIdle || state.displayedAgent) return;

    state.displayedAgent = agent;
    this.show(agent);
  }

  onTaskEnd(input: { parentSessionId?: string; callId?: string }): void {
    if (!input.parentSessionId || !input.callId) return;

    const state = this.parentStates.get(input.parentSessionId);
    if (!state) return;

    state.activeCalls.delete(input.callId);
    if (state.activeCalls.size > 0) return;

    this.parentStates.delete(input.parentSessionId);
    this.show('orchestrator');
  }

  onOrchestratorStatus(input: {
    sessionId?: string;
    status?: string;
    isOrchestrator?: boolean;
  }): void {
    if (!input.sessionId || !input.isOrchestrator) return;

    const state = this.parentStates.get(input.sessionId);
    if (input.status === 'busy') {
      if (state && state.activeCalls.size > 0) return;
      this.show('orchestrator');
      return;
    }

    if (input.status === 'idle') {
      this.parentStates.delete(input.sessionId);
      this.show('intro');
    }
  }

  onSessionDeleted(sessionId?: string): void {
    if (!sessionId) return;
    this.parentStates.delete(sessionId);
  }

  private getParentState(parentSessionId: string): ParentState {
    const existing = this.parentStates.get(parentSessionId);
    if (existing) return existing;

    const created: ParentState = {
      activeCalls: new Map(),
    };
    this.parentStates.set(parentSessionId, created);
    return created;
  }

  private show(agent: string): void {
    if (!this.config.enabled) return;

    if (!this.assetDir) {
      log('[divoom] asset directory not found');
      return;
    }

    const fileName =
      this.config.gifs?.[agent] ?? AGENT_GIFS[agent] ?? AGENT_GIFS.orchestrator;
    const gifPath = path.isAbsolute(fileName)
      ? fileName
      : path.join(this.assetDir, fileName);
    if (!existsSync(gifPath)) {
      log('[divoom] gif not found', { agent, gifPath });
      return;
    }

    if (gifPath === this.latestRequestedGifPath) return;
    this.latestRequestedGifPath = gifPath;

    const call = {
      command: this.config.python,
      args: [
        this.config.script,
        gifPath,
        '--size',
        String(this.config.size),
        '--fps',
        String(this.config.fps),
        '--speed',
        String(this.config.speed),
        '--max-frames',
        String(this.config.maxFrames),
        '--posterize-bits',
        String(this.config.posterizeBits),
      ],
    };

    this.sendQueue = this.sendQueue
      .catch(() => {})
      .then(async () => {
        if (gifPath !== this.latestRequestedGifPath) return;
        if (!existsSync(this.config.python)) {
          this.clearLatestIfCurrent(gifPath);
          log('[divoom] python executable not found', this.config.python);
          return;
        }
        if (!existsSync(this.config.script)) {
          this.clearLatestIfCurrent(gifPath);
          log('[divoom] sender script not found', this.config.script);
          return;
        }

        try {
          await this.sender(call);
          this.lastGifPath = gifPath;
          log('[divoom] showing gif', { agent, gifPath });
        } catch (error) {
          this.clearLatestIfCurrent(gifPath);
          log('[divoom] failed to send gif', String(error));
        }
      });
  }

  async flush(): Promise<void> {
    await this.sendQueue.catch(() => {});
  }

  private clearLatestIfCurrent(gifPath: string): void {
    if (this.latestRequestedGifPath === gifPath) {
      this.latestRequestedGifPath = undefined;
    }
    if (this.lastGifPath === gifPath) {
      this.lastGifPath = undefined;
    }
  }
}

function isTaskArgs(value: unknown): value is TaskArgs {
  return typeof value === 'object' && value !== null;
}

function defaultSender(call: DivoomSenderCall): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(call.command, call.args, {
      detached: true,
      stdio: 'ignore',
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export function createDivoomManager(
  config?: Partial<DivoomConfig>,
): DivoomManager {
  return new DivoomManager(config);
}
