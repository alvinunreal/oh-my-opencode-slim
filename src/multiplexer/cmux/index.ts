/**
 * cmux multiplexer adapter — new-generation TUI (`cmux.protocol/2`).
 *
 * Drives the noun-first public CLI of the cross-platform Rust TUI:
 * - detection: `CMUX_TUI_SOCKET` (preferred) / legacy `CMUX_MUX_SOCKET`;
 * - explicit control plane: `--socket <path>` / `--session <name>`;
 * - anchor: `CMUX_TUI_TERMINAL_ID` → `terminal <id> show` (tab) →
 *   `tab <id> show` (pane);
 * - spawn: `pane <sel> split --right|--down`, then
 *   `pane <sel> run --on-exit keep -- <argv>`;
 * - close: `pane <sel> close`.
 *
 * Availability is a protocol read self-check (`session current ping`), never
 * `--version`: the binary reports its crate version, which is unrelated to the
 * npm distribution. Old-generation action-first binaries (the 0.64.x macOS app
 * surface model) fail the self-check with `unknown resource scope` and are
 * rejected with a distinguishable `old-generation` diagnostic.
 *
 * Deliberately absent: `equalize`/rebalancing, readiness polling, mutation
 * queues, orphan cooldowns, close budgets, deferred spawns, hot-reload
 * takeover, and global pane registries. The client-side lifecycle core owns
 * readiness, per-client dedup, and stable-idle close; this adapter is a
 * stateless command translator that only ever acts on panes it just created.
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import {
  buildOpencodeAttachCommand,
  buildShellLaunchArgs,
  findBinary,
  resolveHostOpencodeBinary,
} from '../shared';
import type { Multiplexer, PaneResult } from '../types';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(argv: string[]): Promise<CommandResult>;
}

/** Client-local cmux environment signals (a `process.env` projection). */
export interface CmuxEnvironment {
  [key: string]: string | undefined;
  /** Current-generation control socket (preferred). */
  CMUX_TUI_SOCKET?: string;
  /** Legacy control socket name kept by the daemon for compatibility. */
  CMUX_MUX_SOCKET?: string;
  /** Session name when no socket path is available. */
  CMUX_TUI_SESSION?: string;
  /** Terminal id injected into every daemon PTY (the anchor hop 1). */
  CMUX_TUI_TERMINAL_ID?: string;
}

/** Explicit control-plane target; `--socket` wins over `--session`. */
export interface CmuxTarget {
  socketPath?: string;
  sessionName?: string;
}

export type CmuxError = 'not_found' | 'unavailable' | 'hard';

/** Distinguishable failure causes for logs (FR-13 diagnostics). */
export type CmuxFailureReason =
  | 'binary-not-found'
  | 'no-control-plane'
  | 'no-anchor'
  | 'old-generation'
  | 'read-selfcheck-failed'
  | 'selector-not-found'
  | 'invalid-response'
  | 'command-failed';

export type CmuxResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CmuxError; reason: CmuxFailureReason };

export interface CmuxAnchor {
  tabId: string;
  paneId: string;
}

export interface CmuxClient {
  /** Protocol read self-check; never `--version`. */
  selfCheck(target: CmuxTarget): Promise<CmuxResult<true>>;
  /** `terminal <id> show` → `tab <id> show` → anchor pane. */
  resolveAnchor(
    target: CmuxTarget,
    terminalId: string,
  ): Promise<CmuxResult<CmuxAnchor>>;
  /** `pane <sel> split --right|--down`; resolves the created pane id. */
  split(
    target: CmuxTarget,
    anchorPaneId: string,
    direction: 'right' | 'down',
  ): Promise<CmuxResult<string>>;
  /** `pane <sel> rename --name <name>` (FR-8 title metadata). */
  rename(
    target: CmuxTarget,
    paneId: string,
    name: string,
  ): Promise<CmuxResult<true>>;
  /** `pane list` → pane ids and names (FR-8 sweep). */
  listPanes(
    target: CmuxTarget,
  ): Promise<CmuxResult<Array<{ paneId: string; name: string }>>>;
  /** `pane <sel> run --on-exit keep -- <argv>`. */
  run(
    target: CmuxTarget,
    paneId: string,
    argv: string[],
  ): Promise<CmuxResult<true>>;
  /** `pane <sel> close`; `not_found` means the pane is already gone. */
  close(
    target: CmuxTarget,
    paneId: string,
  ): Promise<'closed' | 'not_found' | 'failed'>;
}

export interface CmuxOptions {
  /** Command client override (tests and wiring). */
  client?: CmuxClient;
  /** Environment snapshot; defaults to `process.env`. */
  env?: CmuxEnvironment;
  /** Explicit `--session <name>` when no socket path is available. */
  sessionName?: string;
  /** Explicit cmux binary path (avoids PATH ambiguity with the old app). */
  binary?: string;
  /** Absolute opencode binary for the attach argv. */
  opencodeBinary?: string;
  pathExists?: (path: string) => boolean;
}

export class CmuxMultiplexer implements Multiplexer {
  readonly type = 'cmux' as const;

  private layout: MultiplexerLayout;
  private readonly client: CmuxClient;
  private readonly env: CmuxEnvironment;
  private readonly sessionName: string | undefined;
  private readonly opencodeBinary: string;

  constructor(
    layout: MultiplexerLayout = 'main-vertical',
    _mainPaneSize = 60,
    options: CmuxOptions = {},
  ) {
    this.layout = layout;
    this.client =
      options.client ?? new CliCmuxClient(undefined, options.binary);
    this.env = options.env ?? process.env;
    this.sessionName = options.sessionName;
    this.opencodeBinary =
      options.opencodeBinary ??
      resolveHostOpencodeBinary({ pathExists: options.pathExists }) ??
      'opencode';
  }

  async isAvailable(): Promise<boolean> {
    const target = this.resolveTarget();
    if (!target) {
      log('[cmux] isAvailable: no control-plane target', {
        stage: 'target',
        reason: 'no-control-plane',
      });
      return false;
    }
    const check = await this.client.selfCheck(target);
    if (!check.ok) {
      log('[cmux] isAvailable: unavailable', {
        stage: 'selfCheck',
        reason: check.reason,
        error: check.error,
      });
      return false;
    }
    return true;
  }

  isInsideSession(): boolean {
    return this.resolveTarget() !== null;
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
  ): Promise<PaneResult> {
    const target = this.resolveTarget();
    if (!target) {
      log('[cmux] spawnPane: no control-plane target', {
        stage: 'target',
        reason: 'no-control-plane',
      });
      return { success: false, error: 'not_found' };
    }

    const terminalId = firstNonEmpty(this.env.CMUX_TUI_TERMINAL_ID);
    if (!terminalId) {
      log('[cmux] spawnPane: no anchor terminal id', {
        stage: 'anchor',
        reason: 'no-anchor',
      });
      return { success: false, error: 'not_found' };
    }

    const check = await this.client.selfCheck(target);
    if (!check.ok) {
      log('[cmux] spawnPane: self-check failed', {
        stage: 'selfCheck',
        reason: check.reason,
        error: check.error,
      });
      return { success: false, error: check.error };
    }

    const anchor = await this.client.resolveAnchor(target, terminalId);
    if (!anchor.ok) {
      log('[cmux] spawnPane: anchor resolution failed', {
        stage: 'anchor',
        reason: anchor.reason,
        error: anchor.error,
        terminalId,
      });
      return { success: false, error: anchor.error };
    }

    const direction = cmuxSplitDirection(this.layout);
    const created = await this.client.split(
      target,
      anchor.value.paneId,
      direction,
    );
    if (!created.ok) {
      log('[cmux] spawnPane: split failed', {
        stage: 'split',
        reason: created.reason,
        error: created.error,
        anchorPaneId: anchor.value.paneId,
        direction,
      });
      return { success: false, error: created.error };
    }

    // FR-8 metadata: the description is the encoded owner pid + child session
    // id. A failed rename only costs the crash-leftover sweep for this pane,
    // so it is logged and the spawn continues.
    const renamed = await this.client.rename(
      target,
      created.value,
      description,
    );
    if (!renamed.ok) {
      log('[cmux] spawnPane: pane rename failed (continuing)', {
        stage: 'rename',
        reason: renamed.reason,
        error: renamed.error,
        paneId: created.value,
      });
    }

    const attachArgv = this.buildAttachArgv(sessionId, serverUrl, directory);
    const started = await this.client.run(target, created.value, attachArgv);
    if (!started.ok) {
      log('[cmux] spawnPane: attach run failed', {
        stage: 'run',
        reason: started.reason,
        error: started.error,
        paneId: created.value,
      });
      await this.closeQuietly(target, created.value);
      return { success: false, error: started.error };
    }

    log('[cmux] spawnPane: created', {
      paneId: created.value,
      anchoredTarget: anchor.value.paneId,
      tabId: anchor.value.tabId,
      direction,
    });
    return { success: true, paneId: created.value };
  }

  /**
   * FR-8 sweep capability: panes known to cmux with their `name` (the field
   * `pane rename` writes). Returns an empty list when no control plane can be
   * resolved (no command is issued).
   */
  async listPanesWithTitles(): Promise<
    Array<{ paneId: string; title: string }>
  > {
    const target = this.resolveTarget();
    if (!target) return [];

    const listed = await this.client.listPanes(target);
    if (!listed.ok) return [];
    return listed.value.map((pane) => ({
      paneId: pane.paneId,
      title: pane.name,
    }));
  }

  async closePane(paneId: string): Promise<boolean> {
    const target = this.resolveTarget();
    if (!target) {
      log('[cmux] closePane: no control-plane target', {
        stage: 'target',
        reason: 'no-control-plane',
      });
      return false;
    }
    if (!paneId) {
      log('[cmux] closePane: empty pane id', {
        stage: 'close',
        reason: 'no-anchor',
      });
      return false;
    }

    const outcome = await this.client.close(target, paneId);
    if (outcome === 'failed') {
      log('[cmux] closePane: failed', { paneId });
      return false;
    }
    if (outcome === 'not_found') {
      // Already gone: the desired state holds, so the close is a success.
      log('[cmux] closePane: pane already gone', { paneId });
    }
    return true;
  }

  async applyLayout(
    layout: MultiplexerLayout,
    _mainPaneSize: number,
  ): Promise<void> {
    // cmux has no rebalancing primitive (no `equalize`); the layout only
    // selects the split direction used by the next spawn.
    this.layout = layout;
  }

  private resolveTarget(): CmuxTarget | null {
    return resolveCmuxTarget(this.env, this.sessionName);
  }

  private buildAttachArgv(
    sessionId: string,
    serverUrl: string,
    directory: string,
  ): string[] {
    const command = buildOpencodeAttachCommand(
      sessionId,
      serverUrl,
      directory,
      this.opencodeBinary,
    );
    return buildShellLaunchArgs(command);
  }

  private async closeQuietly(
    target: CmuxTarget,
    paneId: string,
  ): Promise<void> {
    try {
      const outcome = await this.client.close(target, paneId);
      if (outcome === 'failed') {
        log('[cmux] spawnPane: failed to close pane after run failure', {
          paneId,
        });
      }
    } catch {
      // Cleanup is best-effort; the spawn already failed.
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
  private binary: string | null;

  constructor(
    private readonly runner: CommandRunner = new SpawnCommandRunner(),
    binary?: string,
  ) {
    this.binary = binary ?? null;
  }

  async selfCheck(target: CmuxTarget): Promise<CmuxResult<true>> {
    const executed = await this.exec(target, ['session', 'current', 'ping']);
    if (!executed.ok) return executed;
    const result = executed.value;
    if (result.exitCode !== 0) {
      const failure = classifyFailure(result);
      return failure.reason === 'old-generation'
        ? { ok: false, ...failure }
        : { ok: false, error: 'unavailable', reason: 'read-selfcheck-failed' };
    }

    const payload = asRecord(parseJson(result.stdout));
    if (payload?.alive !== true) {
      log('[cmux] selfCheck: invalid ping payload', {
        stage: 'selfCheck',
        detail: 'invalid-ping-payload',
        stdoutLength: result.stdout.length,
      });
      return {
        ok: false,
        error: 'unavailable',
        reason: 'read-selfcheck-failed',
      };
    }
    return { ok: true, value: true };
  }

  async resolveAnchor(
    target: CmuxTarget,
    terminalId: string,
  ): Promise<CmuxResult<CmuxAnchor>> {
    const terminal = await this.exec(target, ['terminal', terminalId, 'show']);
    if (!terminal.ok) return terminal;
    if (terminal.value.exitCode !== 0) {
      return { ok: false, ...classifyFailure(terminal.value) };
    }

    const terminalRecord = asRecord(parseJson(terminal.value.stdout));
    const tabId =
      stringField(terminalRecord, 'tab_id') ??
      firstStringItem(terminalRecord?.tab_ids);
    if (!tabId) {
      log('[cmux] resolveAnchor: no tab_id in terminal show', {
        stage: 'anchor',
        reason: 'invalid-response',
        terminalId,
        stdoutLength: terminal.value.stdout.length,
      });
      return { ok: false, error: 'hard', reason: 'invalid-response' };
    }

    const tab = await this.exec(target, ['tab', tabId, 'show']);
    if (!tab.ok) return tab;
    if (tab.value.exitCode !== 0) {
      return { ok: false, ...classifyFailure(tab.value) };
    }

    const paneId = stringField(
      asRecord(parseJson(tab.value.stdout)),
      'pane_id',
    );
    if (!paneId) {
      log('[cmux] resolveAnchor: no pane_id in tab show', {
        stage: 'anchor',
        reason: 'invalid-response',
        tabId,
        stdoutLength: tab.value.stdout.length,
      });
      return { ok: false, error: 'hard', reason: 'invalid-response' };
    }
    return { ok: true, value: { tabId, paneId } };
  }

  async split(
    target: CmuxTarget,
    anchorPaneId: string,
    direction: 'right' | 'down',
  ): Promise<CmuxResult<string>> {
    const result = await this.exec(target, [
      'pane',
      anchorPaneId,
      'split',
      `--${direction}`,
    ]);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) {
      return { ok: false, ...classifyFailure(result.value) };
    }

    const envelope = asRecord(parseJson(result.value.stdout));
    const payload = asRecord(envelope?.value) ?? envelope;
    const paneId = stringField(payload, 'pane_id');
    if (!paneId) {
      log('[cmux] split: no pane_id in response', {
        stage: 'split',
        reason: 'invalid-response',
        anchorPaneId,
        stdoutLength: result.value.stdout.length,
      });
      return { ok: false, error: 'hard', reason: 'invalid-response' };
    }
    return { ok: true, value: paneId };
  }

  async rename(
    target: CmuxTarget,
    paneId: string,
    name: string,
  ): Promise<CmuxResult<true>> {
    const result = await this.exec(target, [
      'pane',
      paneId,
      'rename',
      '--name',
      name,
    ]);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) {
      return { ok: false, ...classifyFailure(result.value) };
    }
    return { ok: true, value: true };
  }

  async listPanes(
    target: CmuxTarget,
  ): Promise<CmuxResult<Array<{ paneId: string; name: string }>>> {
    const result = await this.exec(target, ['pane', 'list']);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) {
      return { ok: false, ...classifyFailure(result.value) };
    }

    const parsed = parseJson(result.value.stdout);
    const envelope = asRecord(parsed);
    const entries = Array.isArray(parsed)
      ? parsed
      : Array.isArray(envelope?.value)
        ? envelope.value
        : [];

    const panes: Array<{ paneId: string; name: string }> = [];
    for (const entry of entries) {
      const record = asRecord(entry);
      const paneId = stringField(record, 'id');
      if (!paneId) continue;
      panes.push({
        paneId,
        name: typeof record?.name === 'string' ? record.name : '',
      });
    }
    return { ok: true, value: panes };
  }

  async run(
    target: CmuxTarget,
    paneId: string,
    argv: string[],
  ): Promise<CmuxResult<true>> {
    const result = await this.exec(target, [
      'pane',
      paneId,
      'run',
      '--on-exit',
      'keep',
      '--',
      ...argv,
    ]);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) {
      return { ok: false, ...classifyFailure(result.value) };
    }
    return { ok: true, value: true };
  }

  async close(
    target: CmuxTarget,
    paneId: string,
  ): Promise<'closed' | 'not_found' | 'failed'> {
    const result = await this.exec(target, ['pane', paneId, 'close']);
    if (!result.ok) return 'failed';
    if (result.value.exitCode === 0) return 'closed';
    const failure = classifyFailure(result.value);
    return failure.error === 'not_found' ? 'not_found' : 'failed';
  }

  private async exec(
    target: CmuxTarget,
    args: string[],
  ): Promise<CmuxResult<CommandResult>> {
    this.binary ??= await findBinary('cmux');
    if (!this.binary) {
      log('[cmux] command skipped: binary not found', {
        operation: args[0],
      });
      return { ok: false, error: 'unavailable', reason: 'binary-not-found' };
    }

    let result: CommandResult;
    try {
      result = await this.runner.run([
        this.binary,
        ...controlPlaneArgs(target),
        '--json',
        ...args,
      ]);
    } catch (error) {
      log('[cmux] command threw', {
        operation: args[0],
        errorType: errorName(error),
      });
      return { ok: false, error: 'unavailable', reason: 'command-failed' };
    }

    if (result.exitCode !== 0) {
      log('[cmux] command failed', {
        operation: args[0],
        exitCode: result.exitCode,
        stderr: args.includes('run')
          ? '[redacted: may contain attach command]'
          : safeSummary(result.stderr),
      });
    }
    return { ok: true, value: result };
  }
}

/**
 * Resolve the client-local control-plane target. The current-generation
 * socket wins over the legacy name; an explicit session name is only used
 * when no socket path exists (the CLI gives `--socket` precedence anyway).
 */
export function resolveCmuxTarget(
  env: CmuxEnvironment,
  sessionName?: string,
): CmuxTarget | null {
  const socketPath = firstNonEmpty(env.CMUX_TUI_SOCKET, env.CMUX_MUX_SOCKET);
  const name = firstNonEmpty(sessionName, env.CMUX_TUI_SESSION);
  if (!socketPath && !name) return null;
  return { socketPath, sessionName: name };
}

/**
 * Fixed FR-14 layout mapping: cmux only has a single split direction, so each
 * standard layout picks the nearest `--right` / `--down` expression. The
 * documentation records this approximation.
 */
export function cmuxSplitDirection(
  layout: MultiplexerLayout,
): 'right' | 'down' {
  switch (layout) {
    case 'main-horizontal':
    case 'even-vertical':
      return 'down';
    case 'main-vertical':
    case 'even-horizontal':
    case 'tiled':
      return 'right';
  }
}

function controlPlaneArgs(target: CmuxTarget): string[] {
  if (target.socketPath) return ['--socket', target.socketPath];
  if (target.sessionName) return ['--session', target.sessionName];
  return [];
}

function classifyFailure(result: CommandResult): {
  error: CmuxError;
  reason: CmuxFailureReason;
} {
  const text = `${result.stdout}\n${result.stderr}`;
  if (OLD_GENERATION_PATTERN.test(text)) {
    return { error: 'unavailable', reason: 'old-generation' };
  }
  if (NOT_FOUND_PATTERN.test(text)) {
    return { error: 'not_found', reason: 'selector-not-found' };
  }
  if (UNAVAILABLE_PATTERN.test(text)) {
    return { error: 'unavailable', reason: 'command-failed' };
  }
  return { error: 'hard', reason: 'command-failed' };
}

const OLD_GENERATION_PATTERN =
  /unknown resource scope|usage\.invalid|unknown option|unknown command|unrecognized (?:subcommand|argument)|unexpected argument/i;
const NOT_FOUND_PATTERN = /selector\.not_found|not[_ ]found/i;
const UNAVAILABLE_PATTERN =
  /connection refused|connection reset|broken pipe|timed out|timeout|no such file or directory|failed to connect|unavailable/i;

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function firstStringItem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) return item;
  }
  return undefined;
}

function safeSummary(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
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
): string | undefined {
  const candidate = value?.[field];
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : undefined;
}
