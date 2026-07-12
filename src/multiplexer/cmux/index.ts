import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import {
  buildOpencodeAttachCommand,
  findBinary,
  resolveHostOpencodeBinary,
} from '../shared';
import type { Multiplexer, PaneResult } from '../types';

const MINIMUM_VERSION = '0.64.14';
const READINESS_DELAYS_MS = [50, 100, 200, 400, 500, 500, 250] as const;

export interface CmuxReadinessOptions {
  checkSessionReady?: (
    url: URL,
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
  delay?: (milliseconds: number) => Promise<void>;
  readinessAttemptTimeoutMs?: number;
  opencodeBinary?: string;
  pathExists?: (path: string) => boolean;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(argv: string[]): Promise<CommandResult>;
}

export interface CmuxIdentity {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
  socketPath: string;
}

export interface CmuxClient {
  version(): Promise<string | null>;
  getVersionError?(): 'unavailable' | 'hard';
  identify(): Promise<CmuxIdentity | null>;
  getIdentifyError?(): 'unavailable' | 'hard';
  createSurface(
    input: {
      workspaceId: string;
      targetSurfaceId: string;
      direction: 'right' | 'down';
      focus: false;
    },
    socketPath?: string,
  ): Promise<{ paneId: string; surfaceId: string } | null>;
  getCreateError?(): 'not_found' | 'unavailable' | 'invalid_state' | 'hard';
  respawnSurface(
    workspaceId: string,
    surfaceId: string,
    command: string,
    socketPath?: string,
  ): Promise<boolean>;
  closeSurface(
    workspaceId: string,
    surfaceId: string,
    socketPath?: string,
  ): Promise<'closed' | 'not_found' | 'failed'>;
  equalizeSplits(
    params: {
      workspace_id: string;
      orientation: 'vertical';
    },
    socketPath?: string,
  ): Promise<boolean>;
}

interface Handle {
  v: 1;
  socketPath: string;
  workspaceId: string;
  paneId: string;
  surfaceId: string;
}

interface Registry {
  root: CmuxIdentity;
  agents: Handle[];
}

const registries = new Map<string, Registry>();
let mutationQueue = Promise.resolve();
let mutationSequence = 0;

export class CmuxMultiplexer implements Multiplexer {
  readonly type = 'cmux' as const;
  private versionAvailable = false;
  private availabilityError: 'unavailable' | 'hard' = 'unavailable';

  private readonly checkSessionReady: (
    url: URL,
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly readinessAttemptTimeoutMs: number;
  private readonly opencodeBinary: string | null;

  constructor(
    private readonly client: CmuxClient = new CliCmuxClient(),
    options: CmuxReadinessOptions = {},
  ) {
    this.checkSessionReady = options.checkSessionReady ?? defaultSessionReady;
    this.delay = options.delay ?? defaultDelay;
    this.readinessAttemptTimeoutMs = options.readinessAttemptTimeoutMs ?? 1_000;
    this.opencodeBinary = resolveHostOpencodeBinary({
      override: options.opencodeBinary,
      pathExists: options.pathExists,
    });
  }

  async isAvailable(): Promise<boolean> {
    if (this.versionAvailable) return true;
    const version = await this.client.version().catch(() => null);
    if (version && compareVersions(version, MINIMUM_VERSION) >= 0) {
      this.versionAvailable = true;
      return true;
    }
    this.availabilityError = version
      ? 'hard'
      : (this.client.getVersionError?.() ?? 'unavailable');
    return false;
  }

  isInsideSession(): boolean {
    return Boolean(
      process.env.CMUX_SOCKET_PATH &&
        process.env.CMUX_WORKSPACE_ID &&
        process.env.CMUX_SURFACE_ID,
    );
  }

  async spawnPane(
    sessionId: string,
    _description: string,
    serverUrl: string,
    directory: string,
  ): Promise<PaneResult> {
    if (!this.opencodeBinary) return { success: false, error: 'hard' };
    const opencodeBinary = this.opencodeBinary;
    const statusUrl = new URL('/session/status', serverUrl);
    if (!(await this.waitForSession(statusUrl, sessionId))) {
      log('[cmux] spawnPane failed', {
        stage: 'readinessTimeout',
        sessionId,
      });
      return { success: false, error: 'unavailable' };
    }
    return enqueueMutation('spawn', async (sequence) => {
      if (!(await this.isAvailable())) {
        log('[cmux] spawnPane failed', {
          sequence,
          stage: 'version',
          sessionId,
        });
        return {
          success: false,
          error: this.availabilityError,
        };
      }
      const root = await this.client.identify();
      if (!root) {
        log('[cmux] spawnPane failed', {
          sequence,
          stage: 'identify',
          sessionId,
        });
        return {
          success: false,
          error: this.client.getIdentifyError?.() ?? 'unavailable',
        };
      }
      const key = registryKey(root.socketPath, root.workspaceId);
      const registry = registries.get(key) ?? { root, agents: [] };
      registries.set(key, registry);
      const previous = registry.agents.at(-1);
      const targetSurfaceId = previous?.surfaceId ?? registry.root.surfaceId;
      const direction = previous ? 'down' : 'right';
      const created = await this.client.createSurface(
        {
          workspaceId: root.workspaceId,
          targetSurfaceId,
          direction,
          focus: false,
        },
        root.socketPath,
      );
      if (!created) {
        log('[cmux] spawnPane failed', {
          sequence,
          stage: 'createSurface',
          sessionId,
          workspaceId: root.workspaceId,
          targetSurfaceId,
          direction,
        });
        return {
          success: false,
          error: this.client.getCreateError?.() ?? 'hard',
        };
      }

      const handle: Handle = {
        v: 1,
        socketPath: root.socketPath,
        workspaceId: root.workspaceId,
        paneId: created.paneId,
        surfaceId: created.surfaceId,
      };
      const encodedHandle = encodeHandle(handle);

      const command = buildOpencodeAttachCommand(
        sessionId,
        serverUrl,
        directory,
        opencodeBinary,
      );
      try {
        const started = await this.client.respawnSurface(
          root.workspaceId,
          created.surfaceId,
          command,
          root.socketPath,
        );
        if (!started) {
          log('[cmux] spawnPane failed', {
            sequence,
            stage: 'respawn',
            sessionId,
            workspaceId: root.workspaceId,
            targetSurfaceId,
            direction,
          });
          throw new Error('cmux respawn-pane failed');
        }
      } catch (error) {
        log('[cmux] spawnPane respawn exception', {
          sequence,
          stage: 'respawn',
          sessionId,
          workspaceId: root.workspaceId,
          targetSurfaceId,
          direction,
          errorType: errorName(error),
        });
        const cleaned = await this.cleanupPane(
          root.workspaceId,
          created.surfaceId,
          root.socketPath,
        );
        return cleaned
          ? { success: false, error: 'unavailable' }
          : {
              success: false,
              error: 'unavailable',
              orphanPaneId: encodedHandle,
            };
      }

      registry.agents.push(handle);
      await this.equalize(root.workspaceId, root.socketPath);
      return { success: true, paneId: encodeHandle(handle) };
    });
  }

  closePane(paneId: string): Promise<boolean> {
    const handle = decodeHandle(paneId);
    if (!handle) return Promise.resolve(false);
    return enqueueMutation('close', async () => {
      if (!(await this.isAvailable())) return false;
      const result = await this.client.closeSurface(
        handle.workspaceId,
        handle.surfaceId,
        handle.socketPath,
      );
      if (result === 'failed') return false;
      const key = registryKey(handle.socketPath, handle.workspaceId);
      const registry = registries.get(key);
      if (registry) {
        const index = registry.agents.findIndex(
          (agent) => agent.surfaceId === handle.surfaceId,
        );
        if (index >= 0) registry.agents.splice(index, 1);
        if (registry.agents.length === 0) registries.delete(key);
      }
      await this.equalize(handle.workspaceId, handle.socketPath);
      return true;
    });
  }

  async applyLayout(
    _layout: MultiplexerLayout,
    _mainPaneSize: number,
  ): Promise<void> {
    // cmux layout is maintained by spawnPane and closePane.
  }

  private async cleanupPane(
    workspaceId: string,
    surfaceId: string,
    socketPath: string,
  ): Promise<boolean> {
    try {
      const result = await this.client.closeSurface(
        workspaceId,
        surfaceId,
        socketPath,
      );
      if (result === 'failed') {
        log('[cmux] failed to close pre-respawn surface', {
          workspaceId,
          surfaceId,
        });
        return false;
      }
      return true;
    } catch (error) {
      log('[cmux] failed to close pre-respawn surface', {
        workspaceId,
        surfaceId,
        errorType: errorName(error),
      });
      return false;
    }
  }

  private async waitForSession(url: URL, sessionId: string): Promise<boolean> {
    for (let attempt = 0; attempt <= READINESS_DELAYS_MS.length; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.readinessAttemptTimeoutMs,
      );
      timeout.unref?.();
      try {
        if (
          await Promise.race([
            this.checkSessionReady(url, sessionId, controller.signal),
            new Promise<boolean>((resolve) =>
              controller.signal.addEventListener(
                'abort',
                () => resolve(false),
                {
                  once: true,
                },
              ),
            ),
          ])
        ) {
          return true;
        }
      } catch {
        // A session can briefly be unreachable while OpenCode publishes it.
      } finally {
        clearTimeout(timeout);
      }
      const delay = READINESS_DELAYS_MS[attempt];
      if (delay === undefined) return false;
      await this.delay(delay);
    }
    return false;
  }

  private async equalize(
    workspaceId: string,
    socketPath: string,
  ): Promise<void> {
    try {
      const success = await this.client.equalizeSplits(
        {
          workspace_id: workspaceId,
          orientation: 'vertical',
        },
        socketPath,
      );
      if (!success)
        log('[cmux] workspace.equalize_splits failed', { workspaceId });
    } catch (error) {
      log('[cmux] workspace.equalize_splits failed', {
        workspaceId,
        error: String(error),
      });
    }
  }
}

export class SpawnCommandRunner implements CommandRunner {
  constructor(
    private readonly timeoutMs = 5_000,
    private readonly spawn: typeof crossSpawn = crossSpawn,
  ) {}

  async run(argv: string[]): Promise<CommandResult> {
    const proc = this.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all([proc.exited, proc.stdout(), proc.stderr()]).then(
          ([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }),
        ),
        new Promise<CommandResult>((resolve) => {
          timeout = setTimeout(() => {
            proc.kill('SIGTERM');
            resolve({
              exitCode: 124,
              stdout: '',
              stderr: 'unavailable: cmux command timed out',
            });
          }, this.timeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export class CliCmuxClient implements CmuxClient {
  private binary: string | null = null;
  private versionError: 'unavailable' | 'hard' = 'unavailable';
  private identifyError: 'unavailable' | 'hard' = 'unavailable';
  private lastRunThrew = false;
  private createError: 'not_found' | 'unavailable' | 'invalid_state' | 'hard' =
    'hard';

  constructor(
    private readonly runner: CommandRunner = new SpawnCommandRunner(),
    binary?: string,
  ) {
    this.binary = binary ?? null;
  }

  async version(): Promise<string | null> {
    this.versionError = 'unavailable';
    const result = await this.run(['--version']);
    if (!result || result.exitCode !== 0) {
      this.versionError = 'unavailable';
      return null;
    }
    const version = result.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
    this.versionError = 'hard';
    return version;
  }

  getVersionError(): 'unavailable' | 'hard' {
    return this.versionError;
  }

  async identify(): Promise<CmuxIdentity | null> {
    this.identifyError = 'unavailable';
    const result = await this.run(['--id-format', 'uuids', 'identify']);
    if (!result || result.exitCode !== 0) {
      this.identifyError = 'unavailable';
      return null;
    }
    const value = asRecord(parseJson(result.stdout));
    const caller = asRecord(value?.caller);
    const focused = asRecord(value?.focused);
    const workspaceId =
      stringField(caller, 'workspace_id') ??
      stringField(focused, 'workspace_id');
    const paneId =
      stringField(caller, 'pane_id') ?? stringField(focused, 'pane_id');
    const surfaceId =
      stringField(caller, 'surface_id') ?? stringField(focused, 'surface_id');
    const socketPath = stringField(value, 'socket_path');
    if (workspaceId && paneId && surfaceId && socketPath) {
      return { workspaceId, paneId, surfaceId, socketPath };
    }
    log('[cmux] response parse failed', {
      operation: 'identify',
      reason: value ? 'missing_fields' : 'invalid_json',
      stdoutLength: result.stdout.length,
    });
    this.identifyError = 'hard';
    return null;
  }

  getIdentifyError(): 'unavailable' | 'hard' {
    return this.identifyError;
  }

  async createSurface(
    input: {
      workspaceId: string;
      targetSurfaceId: string;
      direction: 'right' | 'down';
      focus: false;
    },
    socketPath?: string,
  ): Promise<{ paneId: string; surfaceId: string } | null> {
    this.createError = 'hard';
    const result = await this.run(
      withSocket(socketPath, [
        '--json',
        '--id-format',
        'uuids',
        'new-split',
        input.direction,
        '--workspace',
        input.workspaceId,
        '--surface',
        input.targetSurfaceId,
        '--focus',
        'false',
      ]),
    );
    if (!result || result.exitCode !== 0) {
      this.createError = this.lastRunThrew
        ? 'unavailable'
        : classifyCreateError(result?.stderr ?? '');
      return null;
    }
    const value = asRecord(parseJson(result.stdout));
    const resultValue = asRecord(value?.result);
    const pane = asRecord(resultValue?.pane);
    const paneId =
      stringField(value, 'pane_id') ??
      stringField(resultValue, 'pane_id') ??
      stringField(pane, 'pane_id');
    const surfaceId =
      stringField(value, 'surface_id') ??
      stringField(resultValue, 'surface_id') ??
      stringField(pane, 'surface_id');
    if (paneId && surfaceId) return { paneId, surfaceId };
    log('[cmux] response parse failed', {
      operation: 'new-split',
      reason: value ? 'missing_fields' : 'invalid_json',
      stdoutLength: result.stdout.length,
    });
    return null;
  }

  getCreateError(): 'not_found' | 'unavailable' | 'invalid_state' | 'hard' {
    return this.createError;
  }

  async respawnSurface(
    workspaceId: string,
    surfaceId: string,
    command: string,
    socketPath?: string,
  ): Promise<boolean> {
    const result = await this.run(
      withSocket(socketPath, [
        'respawn-pane',
        '--workspace',
        workspaceId,
        '--surface',
        surfaceId,
        '--command',
        command,
      ]),
    );
    return result?.exitCode === 0;
  }

  async closeSurface(
    workspaceId: string,
    surfaceId: string,
    socketPath?: string,
  ): Promise<'closed' | 'not_found' | 'failed'> {
    const result = await this.run(
      withSocket(socketPath, [
        'close-surface',
        '--workspace',
        workspaceId,
        '--surface',
        surfaceId,
      ]),
    );
    if (result?.exitCode === 0) return 'closed';
    return result?.stderr.toLowerCase().includes('not_found') ||
      result?.stderr.toLowerCase().includes('not found')
      ? 'not_found'
      : 'failed';
  }

  async equalizeSplits(
    params: {
      workspace_id: string;
      orientation: 'vertical';
    },
    socketPath?: string,
  ): Promise<boolean> {
    const result = await this.run(
      withSocket(socketPath, [
        'rpc',
        'workspace.equalize_splits',
        JSON.stringify(params),
      ]),
    );
    return result?.exitCode === 0;
  }

  private async run(args: string[]): Promise<CommandResult | null> {
    this.lastRunThrew = false;
    this.binary ??= await findBinary('cmux');
    if (!this.binary) return null;
    let result: CommandResult;
    try {
      result = await this.runner.run([this.binary, ...args]);
    } catch (error) {
      this.lastRunThrew = true;
      log('[cmux] command threw', {
        operation: commandOperation(args),
        errorType: errorName(error),
      });
      return null;
    }
    if (result.exitCode !== 0) {
      const operation = commandOperation(args);
      log('[cmux] command failed', {
        operation,
        exitCode: result.exitCode,
        stderr:
          operation === 'respawn-pane'
            ? '[redacted: may contain attach command]'
            : safeSummary(result.stderr),
      });
    }
    return result;
  }
}

export function resetCmuxStateForTests(): void {
  registries.clear();
  mutationQueue = Promise.resolve();
  mutationSequence = 0;
}

function enqueueMutation<T>(
  operation: 'spawn' | 'close',
  mutation: (sequence: number) => Promise<T>,
): Promise<T> {
  const sequence = ++mutationSequence;
  log('[cmux] mutation enqueue', {
    sequence,
    operation,
    agentCount: registryAgentCount(),
  });
  const run = async (): Promise<T> => {
    log('[cmux] mutation start', {
      sequence,
      operation,
      agentCount: registryAgentCount(),
    });
    try {
      return await mutation(sequence);
    } finally {
      log('[cmux] mutation end', {
        sequence,
        operation,
        agentCount: registryAgentCount(),
      });
    }
  };
  const result = mutationQueue.then(run, run);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function registryAgentCount(): number {
  let count = 0;
  for (const registry of registries.values()) count += registry.agents.length;
  return count;
}

function commandOperation(args: string[]): string {
  return (
    args.find((arg) =>
      [
        'identify',
        'new-split',
        'respawn-pane',
        'close-surface',
        'rpc',
      ].includes(arg),
    ) ?? 'version'
  );
}

function withSocket(socketPath: string | undefined, args: string[]): string[] {
  return socketPath ? ['--socket', socketPath, ...args] : args;
}

function safeSummary(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

function classifyCreateError(
  stderr: string,
): 'not_found' | 'unavailable' | 'invalid_state' | 'hard' {
  const normalized = stderr.toLowerCase();
  if (normalized.includes('not_found') || normalized.includes('not found')) {
    return 'not_found';
  }
  if (normalized.includes('unavailable')) return 'unavailable';
  if (
    normalized.includes('invalid_state') ||
    normalized.includes('invalid state')
  ) {
    return 'invalid_state';
  }
  return 'hard';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function defaultSessionReady(
  url: URL,
  sessionId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const response = await fetch(url, { signal });
  if (!response.ok) return false;
  const statuses = (await response.json()) as Record<
    string,
    { type?: string } | undefined
  >;
  return ['idle', 'running', 'busy', 'retry'].includes(
    statuses[sessionId]?.type ?? '',
  );
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function registryKey(socketPath: string, workspaceId: string): string {
  return `${socketPath}\0${workspaceId}`;
}

function encodeHandle(handle: Handle): string {
  return `cmux:v1:${Buffer.from(JSON.stringify(handle)).toString('base64url')}`;
}

function decodeHandle(value: string): Handle | null {
  if (!value.startsWith('cmux:v1:')) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value.slice('cmux:v1:'.length), 'base64url').toString(),
    ) as Partial<Handle>;
    return parsed.v === 1 &&
      typeof parsed.socketPath === 'string' &&
      typeof parsed.workspaceId === 'string' &&
      typeof parsed.paneId === 'string' &&
      typeof parsed.surfaceId === 'string'
      ? (parsed as Handle)
      : null;
  } catch {
    return null;
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  value: Record<string, unknown> | null,
  field: string,
): string | null {
  const candidate = value?.[field];
  return typeof candidate === 'string' ? candidate : null;
}
