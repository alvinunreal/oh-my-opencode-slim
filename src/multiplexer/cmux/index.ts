/**
 * cmux multiplexer adapter — new-generation TUI (`cmux.protocol/2`).
 *
 * Drives the noun-first public CLI of the cross-platform Rust TUI:
 * - detection: `CMUX_TUI_SOCKET` (preferred) / legacy `CMUX_MUX_SOCKET`;
 * - explicit control plane: `--socket <path>` / `--session <name>`;
 * - anchor: `CMUX_TUI_TERMINAL_ID` → `terminal <id> show` (tab) →
 *   `tab <id> show` (pane, tab name, active flag);
 * - spawn: `pane <sel> run --on-exit keep --name <parent/child> -- <argv>`,
 *   which appends a sibling tab inside the parent pane and names it at
 *   creation, then a best-effort `tab <pre-spawn active tab> focus`;
 * - close: `terminal <sel> close` — the only primitive that ends the PTY;
 * - sweep: `terminal list` → `terminal <sel> process show` → scan the launch
 *   argv for the `# omosc:<pid>:<childSessionId>` data marker.
 *
 * Availability is a protocol read self-check (`session current ping`), never
 * `--version`: the binary reports its crate version, which is unrelated to the
 * npm distribution. Old-generation action-first binaries (the 0.64.x macOS app
 * surface model) fail the self-check with `unknown resource scope` and are
 * rejected with a distinguishable `old-generation` diagnostic. `pane run
 * --name` was verified live on cmux-tui 0.13.3 and 0.13.4 (the documented
 * floor is 0.13.3).
 *
 * Deliberately absent: pane-level division primitives, tab reordering, tab
 * renaming, `equalize`/rebalancing, readiness polling, mutation queues, orphan
 * cooldowns, close
 * budgets, deferred spawns, hot-reload takeover, and global pane registries.
 * The client-side lifecycle core owns readiness, per-client dedup, and
 * stable-idle close; this adapter is a stateless command translator that only
 * ever acts on views it just created. It never calls `terminal.project`, so a
 * `terminal close` can only ever remove views this adapter created.
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import {
  buildOpencodeAttachCommand,
  buildShellLaunchArgs,
  findBinary,
  resolveHostOpencodeBinary,
  shellSupportsHashComments,
} from '../shared';
import type { Multiplexer, PaneResult, PaneSpawnOptions } from '../types';
import { childName, displayName, parentName } from './names';

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

/** The parent view's container: the anchor tab and its pane. */
export interface CmuxAnchor {
  tabId: string;
  paneId: string;
  /** Parent tab `name` ('' when the tab has none). */
  tabName: string;
  /** True when the anchor tab was the pane's active tab at read time. */
  tabFocused: boolean;
}

/** One `tab list` entry (only the fields this adapter reads). */
export interface CmuxTab {
  tabId: string;
  paneId: string;
  focused: boolean;
}

/** One `terminal list` entry (sweep candidate discovery). */
export interface CmuxTerminal {
  terminalId: string;
}

/** The handle of a created child view: terminal id plus its tab. */
export interface CmuxRunResult {
  tabId: string;
  terminalId: string;
}

export interface CmuxClient {
  /** Protocol read self-check; never `--version`. */
  selfCheck(target: CmuxTarget): Promise<CmuxResult<true>>;
  /** `terminal <id> show` → `tab <id> show` → anchor pane + parent tab. */
  resolveAnchor(
    target: CmuxTarget,
    terminalId: string,
  ): Promise<CmuxResult<CmuxAnchor>>;
  /** `tab list` (used only to locate the pane's active sibling tab). */
  listTabs(target: CmuxTarget): Promise<CmuxResult<CmuxTab[]>>;
  /** `pane <sel> run --on-exit keep --name <name> -- <argv>`. */
  runInPane(
    target: CmuxTarget,
    paneId: string,
    argv: string[],
    name: string,
  ): Promise<CmuxResult<CmuxRunResult>>;
  /** `tab <sel> focus` (restores the pre-spawn active tab). */
  focusTab(target: CmuxTarget, tabId: string): Promise<CmuxResult<true>>;
  /** `terminal <sel> close`; `not_found` means it is already gone. */
  closeTerminal(
    target: CmuxTarget,
    terminalId: string,
  ): Promise<'closed' | 'not_found' | 'failed'>;
  /** `terminal <sel> process show` → the verbatim launch argv. */
  processShow(
    target: CmuxTarget,
    terminalId: string,
  ): Promise<CmuxResult<{ argv: string[] }>>;
  /** `terminal list` (sweep candidate discovery). */
  listTerminals(target: CmuxTarget): Promise<CmuxResult<CmuxTerminal[]>>;
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
  readonly type = 'cmux-tui' as const;

  private readonly client: CmuxClient;
  private readonly env: CmuxEnvironment;
  private readonly sessionName: string | undefined;
  private readonly opencodeBinary: string;

  constructor(
    _layout: MultiplexerLayout = 'main-vertical',
    _mainPaneSize = 60,
    options: CmuxOptions = {},
  ) {
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
      log('[cmux-tui] isAvailable: no control-plane target', {
        stage: 'target',
        reason: 'no-control-plane',
      });
      return false;
    }
    const check = await this.client.selfCheck(target);
    if (!check.ok) {
      log('[cmux-tui] isAvailable: unavailable', {
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
    options?: PaneSpawnOptions,
  ): Promise<PaneResult> {
    const target = this.resolveTarget();
    if (!target) {
      log('[cmux-tui] spawnPane: no control-plane target', {
        stage: 'target',
        reason: 'no-control-plane',
      });
      return { success: false, error: 'not_found' };
    }

    const terminalId = firstNonEmpty(this.env.CMUX_TUI_TERMINAL_ID);
    if (!terminalId) {
      log('[cmux-tui] spawnPane: no anchor terminal id', {
        stage: 'anchor',
        reason: 'no-anchor',
      });
      return { success: false, error: 'not_found' };
    }

    const check = await this.client.selfCheck(target);
    if (!check.ok) {
      log('[cmux-tui] spawnPane: self-check failed', {
        stage: 'selfCheck',
        reason: check.reason,
        error: check.error,
      });
      return { success: false, error: check.error };
    }

    const anchor = await this.client.resolveAnchor(target, terminalId);
    if (!anchor.ok) {
      log('[cmux-tui] spawnPane: anchor resolution failed', {
        stage: 'anchor',
        reason: anchor.reason,
        error: anchor.error,
        terminalId,
      });
      return { success: false, error: anchor.error };
    }

    // The display name is computed before `run` so the tab is named at
    // creation (`pane run --name`); the name is never rewritten afterwards.
    // It never carries sweep metadata — the argv marker does.
    const name = displayName(
      parentName(anchor.value.tabName, process.pid),
      childName(options?.subagentType, sessionId),
    );

    // `pane run` activates the new tab, so remember what the user was
    // looking at in this pane before the spawn (D4).
    const restoreTabId = await this.resolvePreSpawnActiveTab(
      target,
      anchor.value,
    );

    const attachArgv = this.buildAttachArgv(
      sessionId,
      description,
      serverUrl,
      directory,
    );
    const created = await this.client.runInPane(
      target,
      anchor.value.paneId,
      attachArgv,
      name,
    );
    if (!created.ok) {
      log('[cmux-tui] spawnPane: run failed', {
        stage: 'run',
        reason: created.reason,
        error: created.error,
        paneId: anchor.value.paneId,
      });
      // `not_found` means the parent pane itself is gone: provably nothing
      // was created, so the marker scan is pointless.
      if (created.error !== 'not_found') {
        await this.cleanupFailedRun(target, description);
      }
      return { success: false, error: created.error };
    }

    const restored = await this.client.focusTab(target, restoreTabId);
    if (!restored.ok) {
      // Restoring the user's view is best-effort: the child view lives on.
      log('[cmux-tui] spawnPane: focus restore failed (continuing)', {
        stage: 'focus',
        reason: restored.reason,
        error: restored.error,
        tabId: restoreTabId,
      });
    }

    log('[cmux-tui] spawnPane: created', {
      terminalId: created.value.terminalId,
      tabId: created.value.tabId,
      anchorTabId: anchor.value.tabId,
      anchorPaneId: anchor.value.paneId,
      restoreTabId,
    });
    return { success: true, paneId: created.value.terminalId };
  }

  /**
   * FR-8 sweep capability: discover this plugin's terminals by scanning each
   * terminal's launch argv for the `# omosc:<pid>:<childSessionId>` marker.
   * Returns `{ paneId: <terminal id>, title: <omosc token> }` for matches and
   * nothing for user terminals (no marker). `tab list` is not a scan source:
   * it cannot see terminals whose views were closed.
   *
   * Rejects when `terminal list` itself fails: a clean scan with zero
   * candidates is `[]`, but a failed scan must stay retryable instead of
   * looking like "nothing to do".
   *
   * Per-terminal inspection failures are classified: `not_found` is a
   * definitive answer (nothing addressable to inspect, nothing to close) and
   * only skips that terminal, while `unavailable` / `hard` leave the scan
   * incomplete — reported as `incomplete: true` so the caller retries
   * without discarding the candidates that could be inspected.
   */
  async listPanesWithTitles(): Promise<{
    panes: Array<{ paneId: string; title: string }>;
    incomplete: boolean;
  }> {
    const target = this.resolveTarget();
    if (!target) return { panes: [], incomplete: false };

    const listed = await this.client.listTerminals(target);
    if (!listed.ok) {
      throw new Error(`cmux terminal list failed (${listed.reason})`);
    }

    const candidates: Array<{ paneId: string; title: string }> = [];
    let incomplete = false;
    for (const terminal of listed.value) {
      const shown = await this.client.processShow(target, terminal.terminalId);
      if (!shown.ok) {
        if (shown.error === 'not_found') {
          // Definitive answer: the terminal is not addressable, so there is
          // nothing to inspect and nothing the sweep could ever close.
          log('[cmux-tui] listPanesWithTitles: terminal already gone', {
            terminalId: terminal.terminalId,
            reason: shown.reason,
          });
          continue;
        }
        // Unknown state: the scan could not determine whether this terminal
        // is a leftover. Keep the candidates already collected and mark the
        // scan incomplete so the caller retries.
        incomplete = true;
        log('[cmux-tui] listPanesWithTitles: terminal skipped', {
          terminalId: terminal.terminalId,
          reason: shown.reason,
        });
        continue;
      }
      const title = extractArgvMarker(shown.value.argv);
      if (!title) continue;
      candidates.push({ paneId: terminal.terminalId, title });
    }
    return { panes: candidates, incomplete };
  }

  async closePane(paneId: string): Promise<boolean> {
    const target = this.resolveTarget();
    if (!target) {
      log('[cmux-tui] closePane: no control-plane target', {
        stage: 'target',
        reason: 'no-control-plane',
      });
      return false;
    }
    if (!paneId) {
      log('[cmux-tui] closePane: empty terminal id', {
        stage: 'close',
        reason: 'no-anchor',
      });
      return false;
    }

    const outcome = await this.client.closeTerminal(target, paneId);
    if (outcome === 'failed') {
      log('[cmux-tui] closePane: failed', { paneId });
      return false;
    }
    if (outcome === 'not_found') {
      // Already gone: the desired state holds, so the close is a success.
      log('[cmux-tui] closePane: terminal already gone', { paneId });
    }
    return true;
  }

  async applyLayout(
    _layout: MultiplexerLayout,
    _mainPaneSize: number,
  ): Promise<void> {
    // cmux has no layout expression: the child view is a sibling tab inside
    // the parent pane and never participates in the pane layout, so layout
    // and main-pane-size produce no command at all.
  }

  private resolveTarget(): CmuxTarget | null {
    return resolveCmuxTarget(this.env, this.sessionName);
  }

  /**
   * The tab that was active in the parent pane right before the spawn. The
   * anchor read already answers this when the anchor tab itself was active;
   * otherwise `tab list` names the active sibling. When the active tab cannot
   * be determined — the `tab list` read fails, or the pane has no focused
   * entry — the parent tab is the fallback, so the focus restore is always
   * attempted (best-effort; a failed focus only logs).
   */
  private async resolvePreSpawnActiveTab(
    target: CmuxTarget,
    anchor: CmuxAnchor,
  ): Promise<string> {
    if (anchor.tabFocused) return anchor.tabId;

    const tabs = await this.client.listTabs(target);
    if (!tabs.ok) {
      log('[cmux-tui] spawnPane: tab list failed, restoring the parent tab', {
        stage: 'activeTab',
        reason: tabs.reason,
        error: tabs.error,
        paneId: anchor.paneId,
      });
      return anchor.tabId;
    }
    const active = tabs.value.find(
      (tab) => tab.paneId === anchor.paneId && tab.focused,
    );
    // No focused entry for the pane: fall back to the parent tab.
    return active?.tabId ?? anchor.tabId;
  }

  private buildAttachArgv(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
  ): string[] {
    const command = buildOpencodeAttachCommand(
      sessionId,
      serverUrl,
      directory,
      this.opencodeBinary,
    );
    // FR-8 carrier: a POSIX comment data marker in the launch script. The
    // `cmd` branch has no `#` comments, so the marker is omitted there and
    // the cmux sweep cannot identify those views (documented limitation).
    // Line breaks are rejected first: a newline would end the comment and
    // turn the remainder into executable script. (names.ts sanitizes display
    // names with its own control-char stripper; the marker only needs the
    // line-break guarantee, since nothing else terminates a shell comment.)
    const marker = shellSupportsHashComments()
      ? `# ${description.replace(/[\r\n]/g, ' ')}\n`
      : '';
    return buildShellLaunchArgs(`${marker}${command}`);
  }

  /**
   * Best-effort cleanup after a failed `runInPane`. The terminal id is only
   * known from a successful response, so the exact argv marker identifies any
   * terminal this spawn did create; user terminals carry no marker and are
   * never touched.
   */
  private async cleanupFailedRun(
    target: CmuxTarget,
    description: string,
  ): Promise<void> {
    try {
      const listed = await this.client.listTerminals(target);
      if (!listed.ok) return;
      for (const terminal of listed.value) {
        const shown = await this.client.processShow(
          target,
          terminal.terminalId,
        );
        if (!shown.ok) continue;
        if (extractArgvMarker(shown.value.argv) !== description) continue;
        const outcome = await this.client.closeTerminal(
          target,
          terminal.terminalId,
        );
        if (outcome === 'failed') {
          log('[cmux-tui] spawnPane: cleanup close failed', {
            terminalId: terminal.terminalId,
          });
        }
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
      const settled = Promise.all([
        proc.exited,
        proc.stdout(),
        proc.stderr(),
      ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
      // The timeout can win the race; a rejection on the losing chain (for
      // example EPIPE after SIGTERM) must not surface as an unhandled one.
      settled.catch(() => {});
      return await Promise.race([
        settled,
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
    /**
     * Binary probe seam (defaults to `findBinary`). The resolution order is
     * the explicit `binary` above, then the `cmux-tui` distribution binary,
     * then the legacy `cmux` name. Both probes log under `[cmux-tui]` so no
     * `[cmux]` prefix can leak from the legacy fallback.
     */
    private readonly find: (
      name: string,
      logPrefix?: string,
    ) => Promise<string | null> = (name, logPrefix) =>
      findBinary(name, { logPrefix }),
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
      log('[cmux-tui] selfCheck: invalid ping payload', {
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
      log('[cmux-tui] resolveAnchor: no tab_id in terminal show', {
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

    const tabRecord = asRecord(parseJson(tab.value.stdout));
    const paneId = stringField(tabRecord, 'pane_id');
    if (!paneId) {
      log('[cmux-tui] resolveAnchor: no pane_id in tab show', {
        stage: 'anchor',
        reason: 'invalid-response',
        tabId,
        stdoutLength: tab.value.stdout.length,
      });
      return { ok: false, error: 'hard', reason: 'invalid-response' };
    }
    return {
      ok: true,
      value: {
        tabId,
        paneId,
        tabName: stringField(tabRecord, 'name') ?? '',
        tabFocused: tabRecord?.focused === true,
      },
    };
  }

  async listTabs(target: CmuxTarget): Promise<CmuxResult<CmuxTab[]>> {
    const result = await this.exec(target, ['tab', 'list']);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) {
      return { ok: false, ...classifyFailure(result.value) };
    }

    const tabs: CmuxTab[] = [];
    for (const entry of listPayload(result.value.stdout)) {
      const record = asRecord(entry);
      const tabId = stringField(record, 'id');
      const paneId = stringField(record, 'pane_id');
      if (!tabId || !paneId) continue;
      tabs.push({
        tabId,
        paneId,
        focused: record?.focused === true,
      });
    }
    return { ok: true, value: tabs };
  }

  async runInPane(
    target: CmuxTarget,
    paneId: string,
    argv: string[],
    name: string,
  ): Promise<CmuxResult<CmuxRunResult>> {
    const result = await this.exec(target, [
      'pane',
      paneId,
      'run',
      '--on-exit',
      'keep',
      '--name',
      name,
      '--',
      ...argv,
    ]);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) {
      return { ok: false, ...classifyFailure(result.value) };
    }

    const payload = valuePayload(result.value.stdout);
    const tabId = stringField(payload, 'tab_id');
    const terminalId = stringField(payload, 'terminal_id');
    if (!tabId || !terminalId) {
      log('[cmux-tui] runInPane: response missing tab_id/terminal_id', {
        stage: 'run',
        reason: 'invalid-response',
        paneId,
        stdoutLength: result.value.stdout.length,
      });
      return { ok: false, error: 'hard', reason: 'invalid-response' };
    }
    return { ok: true, value: { tabId, terminalId } };
  }

  async focusTab(target: CmuxTarget, tabId: string): Promise<CmuxResult<true>> {
    const result = await this.exec(target, ['tab', tabId, 'focus']);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) {
      return { ok: false, ...classifyFailure(result.value) };
    }
    return { ok: true, value: true };
  }

  async closeTerminal(
    target: CmuxTarget,
    terminalId: string,
  ): Promise<'closed' | 'not_found' | 'failed'> {
    const result = await this.exec(target, ['terminal', terminalId, 'close']);
    if (!result.ok) return 'failed';
    if (result.value.exitCode === 0) return 'closed';
    const failure = classifyFailure(result.value);
    return failure.error === 'not_found' ? 'not_found' : 'failed';
  }

  async processShow(
    target: CmuxTarget,
    terminalId: string,
  ): Promise<CmuxResult<{ argv: string[] }>> {
    const result = await this.exec(target, [
      'terminal',
      terminalId,
      'process',
      'show',
    ]);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) {
      return { ok: false, ...classifyFailure(result.value) };
    }

    const payload = valuePayload(result.value.stdout);
    const rawArgv = payload?.argv;
    if (!Array.isArray(rawArgv)) {
      log('[cmux-tui] processShow: response missing argv', {
        stage: 'processShow',
        reason: 'invalid-response',
        terminalId,
        stdoutLength: result.value.stdout.length,
      });
      return { ok: false, error: 'hard', reason: 'invalid-response' };
    }
    const argv = rawArgv.filter(
      (item): item is string => typeof item === 'string',
    );
    return { ok: true, value: { argv } };
  }

  async listTerminals(target: CmuxTarget): Promise<CmuxResult<CmuxTerminal[]>> {
    const result = await this.exec(target, ['terminal', 'list']);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) {
      return { ok: false, ...classifyFailure(result.value) };
    }

    const terminals: CmuxTerminal[] = [];
    for (const entry of listPayload(result.value.stdout)) {
      const terminalId = stringField(asRecord(entry), 'id');
      if (!terminalId) continue;
      terminals.push({ terminalId });
    }
    return { ok: true, value: terminals };
  }

  private async exec(
    target: CmuxTarget,
    args: string[],
  ): Promise<CmuxResult<CommandResult>> {
    // Resolution order: explicit `options.binary` (already stored), then the
    // `cmux-tui` distribution binary, then the legacy `cmux` name.
    this.binary ??=
      (await this.find('cmux-tui', 'cmux-tui')) ??
      (await this.find('cmux', 'cmux-tui'));
    if (!this.binary) {
      log('[cmux-tui] command skipped: binary not found', {
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
      log('[cmux-tui] command threw', {
        operation: args[0],
        errorType: errorName(error),
      });
      return { ok: false, error: 'unavailable', reason: 'command-failed' };
    }

    if (result.exitCode !== 0) {
      log('[cmux-tui] command failed', {
        operation: args[0],
        exitCode: result.exitCode,
        stderr: commandCarriesArgv(args)
          ? '[redacted: may contain attach command]'
          : safeSummary(result.stderr),
      });
    }
    return { ok: true, value: result };
  }
}

/**
 * True when the command carries a shell argv payload (the attach script,
 * separated by `--`), whose stderr may echo it. Such stderr is redacted.
 */
export function commandCarriesArgv(args: string[]): boolean {
  return args.includes('--');
}

/**
 * Extract the FR-8 `omosc:<pid>:<childSessionId>` data marker from a terminal
 * launch argv. The marker is written as a POSIX comment line (`# omosc:...`)
 * at the start of the shell script, so it can never be an executable
 * instruction. Returns null for terminals without a marker (user terminals).
 */
const ARGV_MARKER_PATTERN =
  /(?:^|\n)# (omosc:\d{1,10}:[A-Za-z0-9_-]{1,64})(?=\n|$)/;

export function extractArgvMarker(argv: string[]): string | null {
  for (const arg of argv) {
    const match = ARGV_MARKER_PATTERN.exec(arg);
    if (match) return match[1];
  }
  return null;
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

/** Array payload of a list command, accepting an envelope or a bare array. */
function listPayload(stdout: string): unknown[] {
  const parsed = parseJson(stdout);
  if (Array.isArray(parsed)) return parsed;
  const value = asRecord(parsed)?.value;
  return Array.isArray(value) ? value : [];
}

/** `value` object payload of a command response, accepting a bare object. */
function valuePayload(stdout: string): Record<string, unknown> | null {
  const parsed = asRecord(parseJson(stdout));
  return asRecord(parsed?.value) ?? parsed;
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
