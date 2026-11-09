/**
 * Herdr multiplexer implementation
 *
 * Splits panes for sub-agent sessions in Herdr.
 *
 * Herdr is an agent-aware terminal multiplexer (workspaces → tabs → panes).
 * Pane IDs use the format `w<workspace>:p<pane>`. The CLI outputs
 * newline-delimited JSON; `pane split` returns a `pane_info` result whose
 * `pane.pane_id` field is the new pane's ID.
 *
 * Desktop terminals use `HC_TERMINAL_ID`; older Herdr terminals use
 * `HERDR_PANE_ID` and the legacy CLI.
 *
 * Windows: the pane shell is PowerShell, so the viewer command position
 * carries the call operator.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { isRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import {
  buildViewCommand,
  findBinary,
  gracefulClosePane,
  normalizePathForShell,
  PANE_VIEWER_ENV,
  type PaneShell,
  redactViewerSecretArgs,
  resolveHostOpencodeBinary,
  viewerNeedsPaneCwd,
} from '../shared';
import type { Multiplexer, PaneResult, PaneSpawnOptions } from '../types';
import {
  type EqualizeAgentPanesOptions,
  equalizeAgentPanes,
} from './layout-equalize';

type HerdrPaneDirection = 'right' | 'down';
export type DesktopAdoptionWait = (milliseconds: number) => Promise<void>;

const DESKTOP_ADOPTION_RETRIES = 3;
const DESKTOP_ADOPTION_POLL_MS = 500;
const DESKTOP_ROLLBACK_EMPTY_SCANS = 4;

const defaultDesktopAdoptionWait: DesktopAdoptionWait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

interface DesktopRecoveryRecord {
  spawnToken: string;
  parentId: string;
  title: string;
  spaceId: string;
  tabId: string;
  createdAt: number;
}

function isDesktopRecoveryRecord(
  value: unknown,
): value is DesktopRecoveryRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.spawnToken === 'string' &&
    value.spawnToken.length > 0 &&
    typeof value.parentId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.spaceId === 'string' &&
    typeof value.tabId === 'string'
  );
}

async function readDesktopRecoveryRecords(
  path: string,
): Promise<DesktopRecoveryRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isDesktopRecoveryRecord) : [];
  } catch {
    return [];
  }
}

async function writeDesktopRecoveryRecords(
  path: string,
  records: DesktopRecoveryRecord[],
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(records)}\n`);
  } catch {
    // best-effort recovery journal
  }
}

export type LayoutEqualizer = (
  opts: EqualizeAgentPanesOptions,
) => Promise<boolean>;

export interface HerdrMultiplexerOptions {
  /** Injectable equalizer (tests). Defaults to the real socket client. */
  equalizer?: LayoutEqualizer;
  /** Gates equalization and the main-boundary re-assert. Defaults to true. */
  equalizePanes?: boolean;
  /** Waits between bounded Herdr Desktop pane-adoption checks. */
  desktopAdoptionWait?: DesktopAdoptionWait;
  /**
   * Best-effort journal for unverified desktop spawns (cross-restart
   * recovery). Enabled by default in desktop mode with a stable per-parent
   * path under /tmp/opencode; pass `null` to disable or a string to override.
   * Fail-soft: journal errors never block or kill terminals.
   */
  recoveryJournalPath?: string | null;
}

interface HerdrCliResponse {
  result?: {
    type?: string;
    pane?: { pane_id?: string };
  };
  error?: { code?: string; message?: string };
}

interface DesktopOwnership {
  parentId: string;
  title: string;
  spaceId: string;
  tabId: string;
  spawnToken?: string;
}

interface PendingDesktopRollback {
  hc: string;
  ownership: DesktopOwnership;
  address?: string;
}

export class HerdrMultiplexer implements Multiplexer {
  readonly type = 'herdr' as const;

  private binaryPath: string | null = null;
  private hasChecked = false;
  private layout: MultiplexerLayout;
  private paneDirection: HerdrPaneDirection;
  private stackDirection: HerdrPaneDirection;
  private mainPaneSize: number;
  private agentAreaPaneId: string | null = null;
  private mainPaneId: string | null = null;
  private agentPaneIds = new Set<string>();
  private equalize: LayoutEqualizer;
  private equalizePanes: boolean;
  private desktopAdoptionWait: DesktopAdoptionWait;
  private recoveryJournalPath: string | null;
  private recoveryJournalExplicitlyDisabled: boolean;
  private readonly desktopOwnedTerminals = new Map<string, DesktopOwnership>();
  private readonly desktopSweepCandidates = new Map<string, DesktopOwnership>();
  private readonly pendingDesktopRollbacks = new Map<
    string,
    PendingDesktopRollback
  >();
  // Latch: herdr builds without `pane split --ratio` must keep creating panes.
  private ratioSupported = true;
  private loggedMissingEqualizeEnv = false;
  // ponytail: serialize spawnPane to prevent concurrent races on agentAreaPaneId
  private spawnMutex: Promise<unknown> = Promise.resolve();
  // Serializes equalization passes so a close cannot race a spawn.
  private equalizeMutex: Promise<unknown> = Promise.resolve();

  constructor(
    layout: MultiplexerLayout = 'main-vertical',
    mainPaneSize = 60,
    options: HerdrMultiplexerOptions = {},
  ) {
    this.layout = layout;
    this.paneDirection = getPaneDirection(layout);
    this.stackDirection = getStackDirection(layout);
    this.mainPaneSize = mainPaneSize;
    this.equalize = options.equalizer ?? equalizeAgentPanes;
    this.equalizePanes = options.equalizePanes ?? true;
    this.desktopAdoptionWait =
      options.desktopAdoptionWait ?? defaultDesktopAdoptionWait;
    this.recoveryJournalExplicitlyDisabled =
      options.recoveryJournalPath === null;
    this.recoveryJournalPath = options.recoveryJournalPath ?? null;
  }

  private desktopRecoveryJournalPath(): string | null {
    if (this.recoveryJournalExplicitlyDisabled) return null;
    if (this.recoveryJournalPath) return this.recoveryJournalPath;
    const parentId = process.env.HC_TERMINAL_ID?.trim();
    if (!parentId) return null;
    const safe = parentId.replace(/[^a-zA-Z0-9_-]+/g, '_');
    return join(tmpdir(), 'opencode', `herdr-desktop-recovery-${safe}.json`);
  }

  private async markUnverifiedDesktopSpawn(
    ownership: DesktopOwnership,
  ): Promise<void> {
    const journalPath = this.desktopRecoveryJournalPath();
    if (!journalPath) return;
    try {
      const records = await readDesktopRecoveryRecords(journalPath);
      if (records.some((r) => r.spawnToken === ownership.spawnToken)) return;
      records.push({
        spawnToken: ownership.spawnToken ?? '',
        parentId: ownership.parentId,
        title: ownership.title,
        spaceId: ownership.spaceId,
        tabId: ownership.tabId,
        createdAt: Date.now(),
      });
      await writeDesktopRecoveryRecords(journalPath, records);
    } catch {
      // best-effort recovery journal
    }
  }

  private async resolveUnverifiedDesktopSpawn(
    spawnToken?: string,
  ): Promise<void> {
    const journalPath = this.desktopRecoveryJournalPath();
    if (!journalPath || !spawnToken) return;
    try {
      const records = await readDesktopRecoveryRecords(journalPath);
      const next = records.filter((r) => r.spawnToken !== spawnToken);
      if (next.length !== records.length) {
        await writeDesktopRecoveryRecords(journalPath, next);
      }
    } catch {
      // best-effort recovery journal
    }
  }

  private async recoverJournalSweepCandidates(
    hc: string,
    parentId: string,
    foundCandidates: Map<string, DesktopOwnership>,
    panes: Array<{ paneId: string; title: string }>,
  ): Promise<void> {
    const journalPath = this.desktopRecoveryJournalPath();
    if (!journalPath) return;
    try {
      const staleBefore = Date.now() - 24 * 60 * 60 * 1000;
      const records = (await readDesktopRecoveryRecords(journalPath)).filter(
        (r) => r.parentId === parentId && (r.createdAt ?? 0) >= staleBefore,
      );
      for (const record of records) {
        if (!record.spawnToken) continue;
        const listRead = await readCoreTerminalListWithRetry(
          hc,
          ['--all', '--label', `omosc.spawn=${record.spawnToken}`],
          this.desktopAdoptionWait,
        );
        if (listRead.kind !== 'found' || listRead.addresses.length !== 1)
          continue;
        const address = listRead.addresses[0];
        if (foundCandidates.has(address)) continue;
        const detailRead = await readCoreTerminalWithRetry(
          hc,
          address,
          this.desktopAdoptionWait,
        );
        if (detailRead.kind !== 'found') continue;
        const detail = detailRead.terminal;
        const ownership: DesktopOwnership = {
          parentId,
          title: record.title,
          spaceId: record.spaceId,
          tabId: record.tabId,
          spawnToken: record.spawnToken,
        };
        if (
          detail.address !== address ||
          !matchesDesktopOwnershipMarkers(detail, ownership) ||
          !isSweepTitle(detail.labels.omosc)
        ) {
          continue;
        }
        foundCandidates.set(address, ownership);
        panes.push({ paneId: address, title: detail.labels.omosc });
      }
    } catch {
      // best-effort recovery journal
    }
  }

  async isAvailable(): Promise<boolean> {
    if (this.hasChecked) {
      return this.binaryPath !== null;
    }

    if (process.env.HC_TERMINAL_ID?.trim()) {
      const [hc, app] = await Promise.all([
        findBinary('hc'),
        findBinary('herdr-app'),
      ]);
      this.binaryPath = hc && app ? hc : null;
      this.hasChecked = true;
      return this.binaryPath !== null;
    }

    const configuredBinaryPath = process.env.HERDR_BIN_PATH;
    this.binaryPath =
      configuredBinaryPath && configuredBinaryPath.length > 0
        ? configuredBinaryPath
        : await findBinary('herdr');
    this.hasChecked = true;
    return this.binaryPath !== null;
  }

  isInsideSession(): boolean {
    return !!(process.env.HC_TERMINAL_ID || process.env.HERDR_PANE_ID);
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
    options?: PaneSpawnOptions,
  ): Promise<PaneResult> {
    // ponytail: serialize concurrent spawns to prevent races on agentAreaPaneId
    const prev = this.spawnMutex;
    let release!: () => void;
    this.spawnMutex = new Promise<void>((r) => (release = r));
    await prev;

    try {
      return await this.doSpawn(
        sessionId,
        description,
        serverUrl,
        directory,
        options,
      );
    } finally {
      release();
    }
  }

  private async doSpawn(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
    options?: PaneSpawnOptions,
  ): Promise<PaneResult> {
    const terminalId = process.env.HC_TERMINAL_ID?.trim();
    if (terminalId) {
      return this.spawnDesktopTerminal(
        terminalId,
        sessionId,
        description,
        serverUrl,
        directory,
        options,
      );
    }

    // The parent pane is required: without HERDR_PANE_ID the anchor is
    // unknowable, so no herdr command may be issued (no `--current` fallback).
    const parentPaneId = process.env.HERDR_PANE_ID?.trim();
    if (!parentPaneId) {
      log('[herdr] spawnPane: HERDR_PANE_ID is not set; cannot resolve target');
      return { success: false, error: 'not_found' };
    }

    const herdr = await this.getBinary();
    if (!herdr) {
      log('[herdr] spawnPane: herdr binary not found');
      return { success: false, error: 'unavailable' };
    }

    try {
      // Normalize Windows backslashes→/ so sh -lc (MSYS2) doesn't
      // corrupt --cwd (issue #568).
      const attachDir = normalizePathForShell(directory);

      // v2 remote hosts: the viewer must authenticate with
      // OPENCODE_PASSWORD. Inject it at split time through herdr's native
      // `--env` mechanism so it never reaches the `pane run` command text
      // (which herdr types into the pane's shell).
      const viewerSecretArgs = [
        '--env',
        `${PANE_VIEWER_ENV}=1`,
        ...(options?.viewerFlavor === 'v2-remote' &&
        options.viewerPassword !== undefined
          ? ['--env', `OPENCODE_PASSWORD=${options.viewerPassword}`]
          : []),
      ];

      let paneId: string | null = null;
      let lastRawOutput = '';
      let fellBackToParent = false;

      if (this.isMainLayout() && this.agentAreaPaneId) {
        let result = await this.runSplit(
          this.agentAreaPaneId,
          this.stackDirection,
          attachDir,
          false,
          viewerSecretArgs,
        );
        if (!result.paneId) {
          // One retry absorbs transient herdr failures before giving up on
          // the agent area.
          result = await this.runSplit(
            this.agentAreaPaneId,
            this.stackDirection,
            attachDir,
            false,
            viewerSecretArgs,
          );
        }
        paneId = result.paneId;
        if (!paneId) {
          log('[herdr] agent area split failed, falling back to parent', {
            agentAreaPaneId: this.agentAreaPaneId,
          });
          this.agentAreaPaneId = null;
          fellBackToParent = true;
        }
      }

      // A split from the parent creates the agent area, so only this split is
      // sized by main_pane_size; siblings inside the area keep herdr's 50/50
      // default. even-*/tiled never create an agent area, so they carry none.
      // The fallback path never sizes: the previous agent area still occupies
      // space, so sizing again would shrink the main pane twice.
      const sized =
        this.isMainLayout() &&
        this.agentAreaPaneId == null &&
        !fellBackToParent;
      if (!paneId) {
        let result = await this.runSplit(
          parentPaneId,
          this.paneDirection,
          attachDir,
          sized,
          viewerSecretArgs,
        );
        // Herdr builds without `pane split --ratio` reject the unknown flag
        // outright. Retry once unsized and latch, so pane creation keeps
        // working (the main pane then keeps herdr's 50/50).
        if (!result.paneId && sized && this.ratioSupported) {
          // Only a genuine flag rejection means this herdr lacks support;
          // an unrelated failure (transient, pane too small) must not disable
          // sizing for the rest of the process.
          const rejectsRatioFlag =
            result.stderr.includes('--ratio') &&
            /unexpected|unknown|unrecogni[sz]ed|invalid/i.test(result.stderr);
          if (rejectsRatioFlag) {
            this.ratioSupported = false;
            log('[herdr] herdr rejects pane split --ratio; sizing disabled', {
              mainPaneSize: this.mainPaneSize,
              stderr: result.stderr,
            });
          } else {
            log('[herdr] sized split failed; retrying without --ratio', {
              mainPaneSize: this.mainPaneSize,
              stderr: result.stderr,
            });
          }
          result = await this.runSplit(
            parentPaneId,
            this.paneDirection,
            attachDir,
            false,
            viewerSecretArgs,
          );
        }
        paneId = result.paneId;
        lastRawOutput = result.rawOutput;
        if (paneId) {
          this.mainPaneId = parentPaneId;
        }
      }

      if (!paneId) {
        log('[herdr] spawnPane: could not parse pane_id from output', {
          stdout: lastRawOutput,
        });
        return { success: false, error: 'hard' };
      }

      // 2. Rename the pane for visibility. `pane rename` writes the `label`
      // field (evidence 1.4); the description is the FR-8 metadata and must
      // survive intact, so it is never truncated.
      await crossSpawn([herdr, 'pane', 'rename', paneId, description], {
        stdout: 'ignore',
        stderr: 'ignore',
      }).exited;

      // 3. Run opencode attach in the new pane. `pane run` types the text into
      //    the pane's own shell.
      //    shortcut: a non-PowerShell `default_shell` is not covered, upgrade
      //    when herdr exposes the pane's shell.
      const shell: PaneShell =
        process.platform === 'win32' ? 'powershell' : 'posix';
      const opencodeCmd = buildViewCommand(sessionId, serverUrl, attachDir, {
        ...options,
        shell,
      });

      const runProc = crossSpawn([herdr, 'pane', 'run', paneId, opencodeCmd], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const runExitCode = await runProc.exited;
      if (runExitCode !== 0) {
        const runStderr = await runProc.stderr();
        const runStdout = await runProc.stdout();
        log('[herdr] spawnPane: run failed', {
          command: opencodeCmd,
          exitCode: runExitCode,
          stdout: runStdout.trim(),
          stderr: runStderr.trim(),
        });
        // ponytail: split succeeded but attach failed; close the orphaned pane
        // so it does not linger in the agent area. Session manager gets no
        // paneId on failure, so we must clean it up here.
        try {
          // Already inside the spawn mutex: use the unlocked variant.
          await this.closePaneInner(paneId);
        } catch (closeErr) {
          log('[herdr] spawnPane: failed to close orphaned pane', {
            paneId,
            error: String(closeErr),
          });
        }
        return { success: false, error: 'hard' };
      }

      // 4. Track agent area pane ID only after successful attach
      if (this.isMainLayout() && !this.agentAreaPaneId) {
        this.agentAreaPaneId = paneId;
      }
      this.agentPaneIds.add(paneId);

      // 5. Even out the agent area only; the main pane keeps its share.
      await this.equalizeAgentArea();

      log('[herdr] spawnPane: SUCCESS', { paneId });
      return { success: true, paneId };
    } catch (err) {
      log('[herdr] spawnPane: exception', { error: String(err) });
      return { success: false, error: 'hard' };
    }
  }

  /**
   * FR-8 sweep capability: every pane herdr knows about, with its `label`
   * (the field `pane rename` writes). Titles that are not plugin metadata are
   * ignored by the sweep.
   */
  async listPanesWithTitles(): Promise<
    | Array<{ paneId: string; title: string }>
    | { panes: Array<{ paneId: string; title: string }>; incomplete: boolean }
  > {
    if (process.env.HC_TERMINAL_ID?.trim()) {
      const hc = await findBinary('hc');
      if (!hc) {
        log('[herdr] desktop sweep: hc binary not found');
        throw new Error('hc binary not found');
      }
      try {
        const parentId = process.env.HC_TERMINAL_ID.trim();
        const listRead = await readCoreTerminalListWithRetry(
          hc,
          ['--all', '--label', `omosc.owner=${parentId}`],
          this.desktopAdoptionWait,
        );
        if (listRead.kind !== 'found') {
          log('[herdr] desktop sweep: core terminal list unavailable', {
            kind: listRead.kind,
            detail: listRead.message,
          });
          throw new Error(`hc ls ${listRead.kind}: ${listRead.message}`);
        }
        const terminals = listRead.addresses;
        const panes: Array<{ paneId: string; title: string }> = [];
        const foundCandidates = new Map<string, DesktopOwnership>();
        let incomplete = false;
        for (const address of terminals) {
          const detailRead = await readCoreTerminalWithRetry(
            hc,
            address,
            this.desktopAdoptionWait,
          );
          if (detailRead.kind === 'missing') continue;
          if (detailRead.kind !== 'found') {
            incomplete = true;
            continue;
          }
          const detail = detailRead.terminal;
          if (
            detail.parent !== parentId ||
            !isSweepTitle(detail.labels.omosc) ||
            typeof detail.labels['herdr.space'] !== 'string' ||
            typeof detail.labels['herdr.tab'] !== 'string' ||
            !matchesDesktopTerminal(detail, address, {
              parentId,
              title: detail.labels.omosc,
              spaceId: detail.labels['herdr.space'],
              tabId: detail.labels['herdr.tab'],
              ...(typeof detail.labels['omosc.spawn'] === 'string'
                ? { spawnToken: detail.labels['omosc.spawn'] }
                : {}),
            })
          ) {
            continue;
          }
          foundCandidates.set(address, {
            parentId,
            title: detail.labels.omosc,
            spaceId: detail.labels['herdr.space'],
            tabId: detail.labels['herdr.tab'],
            spawnToken:
              typeof detail.labels['omosc.spawn'] === 'string'
                ? detail.labels['omosc.spawn']
                : undefined,
          });
          panes.push({ paneId: address, title: detail.labels.omosc });
        }
        await this.recoverJournalSweepCandidates(
          hc,
          parentId,
          foundCandidates,
          panes,
        );
        if (!incomplete) this.desktopSweepCandidates.clear();
        for (const [address, ownership] of foundCandidates) {
          this.desktopSweepCandidates.set(address, ownership);
        }
        return incomplete ? { panes, incomplete: true } : panes;
      } catch (error) {
        log('[herdr] desktop sweep: terminal scan failed', {
          error: String(error),
        });
        throw error;
      }
    }

    const herdr = await this.getBinary();
    if (!herdr) return [];

    try {
      const proc = crossSpawn([herdr, 'pane', 'list'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        proc.stdout(),
        proc.stderr(),
      ]);
      if (exitCode !== 0) {
        log('[herdr] legacy sweep: pane list failed', {
          exitCode,
          stdout: stdout.trim().slice(0, 512),
          stderr: stderr.trim(),
        });
        throw new Error(
          `herdr pane list exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
        );
      }

      const panes: Array<{ paneId: string; title: string }> = [];
      for (const line of stdout.split('\n')) {
        const candidate = line.trim();
        if (!candidate) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(candidate);
        } catch {
          continue; // progress/diagnostic line
        }
        const result = isRecord(parsed) ? parsed.result : undefined;
        const entries =
          isRecord(result) && Array.isArray(result.panes) ? result.panes : [];
        for (const entry of entries) {
          if (!isRecord(entry)) continue;
          const paneId = entry.pane_id;
          if (typeof paneId !== 'string' || paneId.length === 0) continue;
          panes.push({
            paneId,
            title: typeof entry.label === 'string' ? entry.label : '',
          });
        }
      }
      return panes;
    } catch (error) {
      log('[herdr] legacy sweep: pane scan failed', {
        error: String(error),
      });
      throw error;
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    if (process.env.HC_TERMINAL_ID?.trim()) {
      const currentParent = process.env.HC_TERMINAL_ID.trim();
      const ownership =
        this.desktopOwnedTerminals.get(paneId) ??
        this.desktopSweepCandidates.get(paneId);
      if (!ownership) return false;
      const hc = await findBinary('hc');
      if (!hc) return false;
      const terminalRead = await readCoreTerminalWithRetry(
        hc,
        paneId,
        this.desktopAdoptionWait,
      );
      if (terminalRead.kind === 'missing') {
        this.desktopOwnedTerminals.delete(paneId);
        this.desktopSweepCandidates.delete(paneId);
        return true;
      }
      if (terminalRead.kind !== 'found') return false;
      const terminal = terminalRead.terminal;
      if (
        ownership.parentId !== currentParent ||
        !matchesDesktopTerminal(terminal, paneId, ownership)
      ) {
        log('[herdr] desktop close refused terminal with changed ownership', {
          paneId,
          parentMatches: terminal.parent === currentParent,
          ownerMatches: terminal.labels['omosc.owner'] === currentParent,
          sessionMarkerMatches: terminal.labels.omosc === ownership.title,
          spawnTokenMatches:
            ownership.spawnToken === undefined ||
            terminal.labels['omosc.spawn'] === ownership.spawnToken,
        });
        return false;
      }
      try {
        const operation = terminal.state === 'finished' ? 'rm' : 'kill';
        const proc = crossSpawn([hc, operation, paneId, '--json'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          proc.stdout(),
          proc.stderr(),
        ]);
        if (exitCode !== 0) {
          log(`[herdr] desktop close: hc ${operation} failed`, {
            paneId,
            exitCode,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          });
          return false;
        }
        if (operation === 'kill') {
          const afterKill = await readCoreTerminalResult(hc, paneId);
          if (afterKill.kind === 'missing') {
            this.desktopOwnedTerminals.delete(paneId);
            this.desktopSweepCandidates.delete(paneId);
            return true;
          }
          if (afterKill.kind !== 'found') {
            log('[herdr] desktop close: killed terminal state is unverified', {
              paneId,
              readKind: afterKill.kind,
              detail: afterKill.message,
            });
            return false;
          }
          if (!matchesDesktopTerminal(afterKill.terminal, paneId, ownership)) {
            log(
              '[herdr] desktop close: terminal ownership changed after kill',
              {
                paneId,
              },
            );
            return false;
          }
          if (afterKill.terminal.state !== 'finished') {
            log('[herdr] desktop close: hc kill has not finished the program', {
              paneId,
              state: afterKill.terminal.state,
            });
            return false;
          }
        }

        const remove =
          operation === 'kill'
            ? crossSpawn([hc, 'rm', paneId, '--json'], {
                stdout: 'pipe',
                stderr: 'pipe',
              })
            : null;
        if (remove) {
          const [removeExit, removeStdout, removeStderr] = await Promise.all([
            remove.exited,
            remove.stdout(),
            remove.stderr(),
          ]);
          if (removeExit !== 0) {
            log('[herdr] desktop close: hc rm failed', {
              paneId,
              exitCode: removeExit,
              stdout: removeStdout.trim(),
              stderr: removeStderr.trim(),
            });
            return false;
          }
        }
        this.desktopOwnedTerminals.delete(paneId);
        this.desktopSweepCandidates.delete(paneId);
        return true;
      } catch (error) {
        log('[herdr] desktop close: hc operation threw', {
          paneId,
          error: String(error),
        });
        return false;
      }
    }

    // Serialize with spawn: a close must not collapse a branch between another
    // pass's export and its path-based ratio writes.
    const prev = this.spawnMutex;
    let release!: () => void;
    this.spawnMutex = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await this.closePaneInner(paneId);
    } finally {
      release();
    }
  }

  private async closePaneInner(paneId: string): Promise<boolean> {
    const herdr = await this.getBinary();
    const closed = await gracefulClosePane(herdr, paneId, {
      ctrlC: ['pane', 'send-keys', paneId, 'ctrl+c'],
      close: ['pane', 'close', paneId],
      acceptExitCode1: true,
      emptyPaneReturnsTrue: true,
    });
    if (!closed) return false;

    if (paneId === this.agentAreaPaneId) {
      this.agentAreaPaneId = null;
    }
    // Only panes this client spawned live in this set; a sweep-closed
    // leftover must not trigger a rebalance of somebody else's layout.
    const wasAgentPane = this.agentPaneIds.delete(paneId);
    if (wasAgentPane) {
      await this.equalizeAgentArea();
    }
    return true;
  }

  private isMainLayout(): boolean {
    return this.layout === 'main-vertical' || this.layout === 'main-horizontal';
  }

  private async runSplit(
    target: string,
    direction: HerdrPaneDirection,
    directory: string,
    sized: boolean,
    viewerSecretArgs: string[] = [],
  ): Promise<{ paneId: string | null; rawOutput: string; stderr: string }> {
    const herdr = await this.getBinary();
    if (!herdr) return { paneId: null, rawOutput: '', stderr: '' };

    const splitArgs = [
      herdr,
      'pane',
      'split',
      target,
      '--direction',
      direction,
      '--cwd',
      directory,
      '--no-focus',
      ...(sized && this.ratioSupported
        ? ['--ratio', String(agentPaneRatio(this.mainPaneSize))]
        : []),
      ...viewerSecretArgs,
    ];

    log('[herdr] spawnPane: splitting pane', {
      args: redactViewerSecretArgs(splitArgs),
    });

    const splitProc = crossSpawn(splitArgs, {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const splitExitCode = await splitProc.exited;
    const splitStdout = await splitProc.stdout();
    const splitStderr = await splitProc.stderr();

    if (splitExitCode !== 0) {
      log('[herdr] spawnPane: split failed', {
        exitCode: splitExitCode,
        stderr: splitStderr.trim(),
      });
      return {
        paneId: null,
        rawOutput: splitStdout.trim(),
        stderr: splitStderr.trim(),
      };
    }

    return {
      paneId: parsePaneId(splitStdout),
      rawOutput: splitStdout.trim(),
      stderr: '',
    };
  }

  /**
   * Best-effort re-equalization of the agent panes. It never changes the
   * spawn/close result: missing context is skipped silently and any failure
   * is logged only. `multiplexer.equalize_panes: false` disables the step
   * before any environment or socket access.
   */
  private async equalizeAgentArea(): Promise<void> {
    // even-*/tiled have no agent area and no main_pane_size share, so
    // correcting them would turn their even split into an 80/20 one.
    if (!this.equalizePanes || !this.isMainLayout()) return;

    const mainPaneId = this.mainPaneId;
    const tabId = process.env.HERDR_TAB_ID?.trim();
    const socketPath = process.env.HERDR_SOCKET_PATH?.trim();
    if (!mainPaneId || !tabId || !socketPath) {
      if (!this.loggedMissingEqualizeEnv) {
        this.loggedMissingEqualizeEnv = true;
        log('[herdr] equalization skipped: herdr pane environment missing', {
          hasMainPaneId: mainPaneId !== null,
          hasTabId: Boolean(tabId),
          hasSocketPath: Boolean(socketPath),
        });
      }
      return;
    }

    // A close-time pass must not interleave with a spawn-time pass: each
    // computes paths from its own export, so a later write could apply stale
    // ratios.
    const prev = this.equalizeMutex;
    let release!: () => void;
    this.equalizeMutex = new Promise<void>((r) => (release = r));
    await prev;

    try {
      await this.equalize({
        socketPath,
        tabId,
        mainPaneId,
        mainPaneShare: this.mainPaneSize / 100,
        agentPaneIds: this.agentPaneIds,
        onPanesSeen: (paneIds) => {
          for (const id of this.agentPaneIds) {
            if (!paneIds.has(id)) this.agentPaneIds.delete(id);
          }
        },
      });
    } catch (error) {
      log('[herdr] equalizeAgentPanes: unexpected failure', {
        error: String(error),
      });
    } finally {
      release();
    }
  }

  private async getBinary(): Promise<string | null> {
    await this.isAvailable();
    return this.binaryPath;
  }

  private async spawnDesktopTerminal(
    parentId: string,
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
    options?: PaneSpawnOptions,
  ): Promise<PaneResult> {
    const pending = this.pendingDesktopRollbacks.get(sessionId);
    if (pending) {
      let cleaned = pending.address
        ? await this.rollbackDesktopTerminal(pending.address, pending.ownership)
        : await this.rollbackUnreportedDesktopSpawn(
            pending.hc,
            pending.ownership,
            sessionId,
          );
      if (cleaned === 'not-owned') {
        this.pendingDesktopRollbacks.set(sessionId, {
          hc: pending.hc,
          ownership: pending.ownership,
        });
        cleaned = await this.rollbackUnreportedDesktopSpawn(
          pending.hc,
          pending.ownership,
          sessionId,
        );
      }
      if (!cleaned) return { success: false, error: 'hard' };
      this.pendingDesktopRollbacks.delete(sessionId);
    }
    const hc = await findBinary('hc');
    const app = await findBinary('herdr-app');
    if (!hc || !app) return { success: false, error: 'unavailable' };
    if (process.platform === 'win32' || options?.viewerFlavor === 'v2-remote') {
      log('[herdr] desktop spawn: this viewer mode is not supported');
      return { success: false, error: 'unavailable' };
    }

    let spawnedAddress: string | null = null;
    let runAttempted = false;
    const spawnToken = randomUUID();
    const ownTitle = `omosc:${process.pid}:${sessionId}`;
    let parentSpaceId = '';
    let parentTabId = '';
    try {
      const parentRead = await readCoreTerminalWithRetry(
        hc,
        parentId,
        this.desktopAdoptionWait,
      );
      if (parentRead.kind === 'missing') {
        return { success: false, error: 'not_found' };
      }
      if (parentRead.kind !== 'found') {
        log('[herdr] desktop spawn: parent lookup could not be verified', {
          parentId,
          kind: parentRead.kind,
          detail: parentRead.message,
        });
        return {
          success: false,
          error: parentRead.kind === 'temporary-error' ? 'unavailable' : 'hard',
        };
      }
      const parent = parentRead.terminal;
      if (parent.address !== parentId) {
        log('[herdr] desktop spawn: hc returned the wrong parent address', {
          parentId,
          returnedAddress: parent.address,
        });
        return { success: false, error: 'hard' };
      }
      const spaceId = parent.labels['herdr.space'];
      const tabId = parent.labels['herdr.tab'];
      if (!spaceId || !tabId) {
        log('[herdr] desktop spawn: parent has no Herdr space and tab labels');
        return { success: false, error: 'not_found' };
      }
      parentSpaceId = spaceId;
      parentTabId = tabId;
      const ownership: DesktopOwnership = {
        parentId,
        title: ownTitle,
        spaceId,
        tabId,
        spawnToken,
      };

      const executable = resolveHostOpencodeBinary() ?? 'opencode';
      const viewerOptions = {
        ...options,
        executable,
        shell: 'posix' as const,
      };
      const viewerCommand = buildViewCommand(
        sessionId,
        serverUrl,
        directory,
        viewerOptions,
      );
      const name = desktopTerminalName(description, sessionId);
      runAttempted = true;
      await this.markUnverifiedDesktopSpawn(ownership);
      const runProc = crossSpawn(
        [
          hc,
          'run',
          '--json',
          '--bg',
          '--keep',
          '--no-notify',
          '--parent',
          parentId,
          ...(viewerNeedsPaneCwd(viewerOptions) ? ['--cwd', directory] : []),
          '--name',
          name,
          '--label',
          `herdr.space=${spaceId}`,
          '--label',
          `herdr.tab=${tabId}`,
          '--label',
          `omosc.owner=${parentId}`,
          '--label',
          `omosc=omosc:${process.pid}:${sessionId}`,
          '--label',
          `omosc.spawn=${spawnToken}`,
          '--',
          'env',
          `${PANE_VIEWER_ENV}=1`,
          'sh',
          '-lc',
          viewerCommand,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [runExit, runOutput, runStderr] = await Promise.all([
        runProc.exited,
        runProc.stdout(),
        runProc.stderr(),
      ]);
      if (runExit !== 0) {
        log('[herdr] desktop spawn: hc run failed', {
          exitCode: runExit,
          stdout: runOutput.trim().slice(0, 512),
          stderr: runStderr.trim(),
        });
        await this.rollbackUnreportedDesktopSpawn(hc, ownership, sessionId);
        return { success: false, error: 'hard' };
      }

      let terminal: { address?: unknown; parent?: unknown };
      try {
        terminal = JSON.parse(runOutput) as {
          address?: unknown;
          parent?: unknown;
        };
      } catch (error) {
        log('[herdr] desktop spawn: hc run returned invalid JSON', {
          stdout: runOutput.trim().slice(0, 512),
          stderr: runStderr.trim(),
          error: String(error),
        });
        await this.rollbackUnreportedDesktopSpawn(hc, ownership, sessionId);
        return { success: false, error: 'hard' };
      }
      const address = terminal.address;
      if (
        typeof address !== 'string' ||
        !/^t[\w-]+$/.test(address) ||
        terminal.parent !== parentId
      ) {
        log('[herdr] desktop spawn: hc run returned invalid terminal fields', {
          stdout: runOutput.trim().slice(0, 512),
          stderr: runStderr.trim(),
          hasAddress: typeof address === 'string',
          hasExpectedParent: terminal.parent === parentId,
        });
        await this.rollbackUnreportedDesktopSpawn(hc, ownership, sessionId);
        return { success: false, error: 'hard' };
      }
      spawnedAddress = address;
      const createdRead = await readCoreTerminalWithRetry(
        hc,
        address,
        this.desktopAdoptionWait,
      );
      const created =
        createdRead.kind === 'found' ? createdRead.terminal : null;
      if (
        !created ||
        !matchesDesktopTerminal(created, address, ownership) ||
        created.state !== 'live'
      ) {
        log('[herdr] desktop spawn: child ownership or state not verified', {
          paneId: address,
          readKind: createdRead.kind,
          detail:
            createdRead.kind === 'found' ? undefined : createdRead.message,
          state: created?.state,
        });
        await this.rollbackUnreportedDesktopSpawn(hc, ownership, sessionId);
        return { success: false, error: 'hard' };
      }
      this.desktopOwnedTerminals.set(address, ownership);

      const paneVisible = await waitForDesktopPane(
        app,
        hc,
        address,
        ownership,
        this.desktopAdoptionWait,
      );
      if (!paneVisible) {
        log('[herdr] desktop spawn: Herdr did not adopt the labeled child', {
          paneId: address,
          spaceId,
          tabId,
        });
        const rollback = await this.rollbackDesktopTerminal(address, ownership);
        if (rollback === 'not-owned') {
          await this.rollbackUnreportedDesktopSpawn(hc, ownership, sessionId);
        } else if (rollback !== true) {
          this.pendingDesktopRollbacks.set(sessionId, {
            hc,
            ownership,
            address,
          });
        } else {
          await this.resolveUnverifiedDesktopSpawn(spawnToken);
        }
        return { success: false, error: 'hard' };
      }

      await this.resolveUnverifiedDesktopSpawn(spawnToken);
      return { success: true, paneId: address };
    } catch (error) {
      log('[herdr] desktop spawn failed', { error: String(error) });
      if (spawnedAddress) {
        const ownership: DesktopOwnership = {
          parentId,
          title: ownTitle,
          spaceId: parentSpaceId,
          tabId: parentTabId,
          spawnToken,
        };
        const rollback = await this.rollbackDesktopTerminal(
          spawnedAddress,
          ownership,
        );
        if (rollback === 'not-owned') {
          await this.rollbackUnreportedDesktopSpawn(hc, ownership, sessionId);
        } else if (rollback !== true) {
          this.pendingDesktopRollbacks.set(sessionId, {
            hc,
            ownership,
            address: spawnedAddress,
          });
        }
      } else if (runAttempted) {
        const ownership: DesktopOwnership = {
          parentId,
          title: ownTitle,
          spaceId: parentSpaceId,
          tabId: parentTabId,
          spawnToken,
        };
        await this.rollbackUnreportedDesktopSpawn(hc, ownership, sessionId);
      }
      return { success: false, error: 'hard' };
    }
  }

  private async rollbackUnreportedDesktopSpawn(
    hc: string,
    ownership: DesktopOwnership,
    sessionId: string,
  ): Promise<boolean> {
    try {
      for (let scan = 1; scan <= DESKTOP_ROLLBACK_EMPTY_SCANS; scan += 1) {
        if (scan > 1) await this.desktopAdoptionWait(DESKTOP_ADOPTION_POLL_MS);
        const listRead = await readCoreTerminalListWithRetry(
          hc,
          ['--all', '--label', `omosc.spawn=${ownership.spawnToken}`],
          this.desktopAdoptionWait,
        );
        if (listRead.kind !== 'found') {
          log('[herdr] desktop orphan scan could not verify candidates', {
            spawnToken: ownership.spawnToken,
            readKind: listRead.kind,
            detail: listRead.message,
            scan,
          });
          this.pendingDesktopRollbacks.set(sessionId, { hc, ownership });
          return false;
        }
        if (listRead.addresses.length === 0) {
          if (scan === DESKTOP_ROLLBACK_EMPTY_SCANS) {
            log(
              '[herdr] desktop rollback scan window elapsed; no candidate found',
              {
                spawnToken: ownership.spawnToken,
                emptyScans: scan,
              },
            );
            await this.resolveUnverifiedDesktopSpawn(ownership.spawnToken);
            return true;
          }
          continue;
        }
        if (listRead.addresses.length !== 1) {
          log('[herdr] desktop orphan scan did not identify one child', {
            candidateCount: listRead.addresses.length,
            spawnToken: ownership.spawnToken,
            scan,
          });
          this.pendingDesktopRollbacks.set(sessionId, { hc, ownership });
          return false;
        }

        const address = listRead.addresses[0];
        const rollback = await this.rollbackDesktopTerminal(address, ownership);
        if (rollback !== true) {
          this.pendingDesktopRollbacks.set(sessionId, {
            hc,
            ownership,
            ...(rollback === 'not-owned' ? {} : { address }),
          });
          return false;
        }
        log('[herdr] desktop orphan removed after ownership verification', {
          address,
          spawnToken: ownership.spawnToken,
        });
        await this.resolveUnverifiedDesktopSpawn(ownership.spawnToken);
        return true;
      }
      await this.resolveUnverifiedDesktopSpawn(ownership.spawnToken);
      return true;
    } catch (error) {
      log('[herdr] desktop orphan cleanup threw', {
        spawnToken: ownership.spawnToken,
        error: String(error),
      });
      this.pendingDesktopRollbacks.set(sessionId, { hc, ownership });
      return false;
    }
  }

  private async rollbackDesktopTerminal(
    address: string,
    ownership: DesktopOwnership,
  ): Promise<boolean | 'not-owned'> {
    try {
      if (!this.desktopOwnedTerminals.has(address)) {
        const hc = await findBinary('hc');
        const terminalRead = hc
          ? await readCoreTerminalWithRetry(
              hc,
              address,
              this.desktopAdoptionWait,
            )
          : {
              kind: 'temporary-error' as const,
              message: 'hc binary not found',
            };
        const parentId = process.env.HC_TERMINAL_ID?.trim();
        if (terminalRead.kind === 'missing') {
          this.desktopOwnedTerminals.delete(address);
          this.desktopSweepCandidates.delete(address);
          log('[herdr] desktop rollback: owned terminal is already absent', {
            paneId: address,
          });
          return true;
        }
        if (terminalRead.kind !== 'found') {
          log('[herdr] desktop spawn: rollback skipped; owner is unverified', {
            paneId: address,
            readKind: terminalRead.kind,
            detail: terminalRead.message,
          });
          return false;
        }
        const terminal = terminalRead.terminal;
        if (
          !parentId ||
          ownership.parentId !== parentId ||
          terminal.address !== address ||
          !matchesDesktopOwnershipMarkers(terminal, ownership)
        ) {
          log('[herdr] desktop spawn: rollback ownership check failed', {
            paneId: address,
            hasParent: parentId !== undefined,
            state: terminal.state,
          });
          return 'not-owned';
        }
        this.desktopOwnedTerminals.set(address, {
          ...ownership,
        });
      }
      const closed = await this.closePane(address);
      if (closed) {
        log('[herdr] desktop rollback: owned terminal closed', {
          paneId: address,
        });
        return true;
      }
      const hc = await findBinary('hc');
      if (hc) {
        const read = await readCoreTerminalWithRetry(
          hc,
          address,
          this.desktopAdoptionWait,
        );
        if (read.kind === 'missing') {
          this.desktopOwnedTerminals.delete(address);
          this.desktopSweepCandidates.delete(address);
          return true;
        }
        if (read.kind === 'found') {
          const parentId = process.env.HC_TERMINAL_ID?.trim();
          if (
            !parentId ||
            ownership.parentId !== parentId ||
            read.terminal.address !== address ||
            !matchesDesktopOwnershipMarkers(read.terminal, ownership)
          ) {
            log(
              '[herdr] desktop rollback: terminal no longer owned by this session',
              { paneId: address },
            );
            return 'not-owned';
          }
        }
      }
      log('[herdr] desktop spawn: rollback skipped or failed ownership check', {
        paneId: address,
      });
      return false;
    } catch (error) {
      log('[herdr] desktop spawn: rollback threw', {
        paneId: address,
        error: String(error),
      });
      return false;
    }
  }
}

/**
 * Parse the pane_id from a herdr CLI JSON response.
 *
 * Herdr outputs newline-delimited JSON like:
 * {"id":"cli:pane:split","result":{"type":"pane_info","pane":{"pane_id":"w1:p2",...}}}
 */
function parsePaneId(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (!candidate) continue;
    try {
      const response = JSON.parse(candidate) as HerdrCliResponse;
      const paneId = response.result?.pane?.pane_id;
      if (paneId) return paneId;
    } catch {
      // Not a JSON line (e.g. progress/diagnostic); skip and keep scanning.
    }
  }

  log('[herdr] parsePaneId: no pane_id found in output', { stdout: trimmed });
  return null;
}

interface CoreTerminal {
  address: string;
  parent: string | null;
  labels: Record<string, string>;
  state: 'live' | 'finished';
}

function matchesDesktopOwnershipMarkers(
  terminal: CoreTerminal,
  ownership: DesktopOwnership,
): boolean {
  return (
    terminal.parent === ownership.parentId &&
    terminal.labels['omosc.owner'] === ownership.parentId &&
    terminal.labels.omosc === ownership.title &&
    (ownership.spawnToken === undefined ||
      terminal.labels['omosc.spawn'] === ownership.spawnToken)
  );
}

function matchesDesktopTerminal(
  terminal: CoreTerminal,
  address: string,
  ownership: DesktopOwnership,
): boolean {
  return (
    terminal.address === address &&
    terminal.labels['herdr.space'] === ownership.spaceId &&
    terminal.labels['herdr.tab'] === ownership.tabId &&
    matchesDesktopOwnershipMarkers(terminal, ownership)
  );
}

type CoreTerminalRead =
  | { kind: 'found'; terminal: CoreTerminal }
  | { kind: 'missing'; message: string }
  | { kind: 'temporary-error'; message: string }
  | { kind: 'invalid-shape'; message: string };

type CoreTerminalListRead =
  | { kind: 'found'; addresses: string[] }
  | { kind: 'temporary-error'; message: string }
  | { kind: 'invalid-shape'; message: string };

type DesktopSpacesRead =
  | { kind: 'found'; spaces: DesktopListedSpace[] }
  | { kind: 'temporary-error'; message: string }
  | { kind: 'invalid-shape'; message: string };

async function readCoreTerminalWithRetry(
  hc: string,
  address: string,
  wait: DesktopAdoptionWait,
): Promise<CoreTerminalRead> {
  return retryTemporaryRead(
    `hc get ${address}`,
    () => readCoreTerminalResult(hc, address),
    wait,
  );
}

async function readCoreTerminalListWithRetry(
  hc: string,
  filters: string[],
  wait: DesktopAdoptionWait,
): Promise<CoreTerminalListRead> {
  return retryTemporaryRead(
    'hc ls',
    () => readCoreTerminalList(hc, filters),
    wait,
  );
}

async function retryTemporaryRead<T extends { kind: string }>(
  command: string,
  read: () => Promise<T>,
  wait: DesktopAdoptionWait,
): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    const result = await read();
    if (
      result.kind !== 'temporary-error' ||
      retry === DESKTOP_ADOPTION_RETRIES
    ) {
      return result;
    }
    const detail =
      'message' in result && typeof result.message === 'string'
        ? result.message
        : undefined;
    log(`[herdr] ${command} failed transiently; retrying`, {
      retry: retry + 1,
      maxRetries: DESKTOP_ADOPTION_RETRIES,
      detail,
    });
    await wait(DESKTOP_ADOPTION_POLL_MS);
  }
}

async function readCoreTerminalList(
  hc: string,
  filters: string[],
): Promise<CoreTerminalListRead> {
  try {
    const proc = crossSpawn([hc, 'ls', '--json', ...filters], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      proc.stdout(),
      proc.stderr(),
    ]);
    if (exitCode !== 0) {
      const errorText = stderr.trim() || stdout.trim();
      const errorKind = cliErrorKind(stdout) ?? cliErrorKind(stderr);
      log('[herdr] desktop core terminal list failed', {
        exitCode,
        errorKind,
        stdout: stdout.trim().slice(0, 512),
        stderr: stderr.trim(),
      });
      return errorKind === 'invalid_params'
        ? { kind: 'invalid-shape', message: errorText }
        : { kind: 'temporary-error', message: errorText };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      const message = `hc ls returned invalid JSON: ${String(error)}`;
      log('[herdr] desktop core terminal list returned invalid JSON', {
        stdout: stdout.trim().slice(0, 512),
        error: String(error),
      });
      return { kind: 'invalid-shape', message };
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.terminals)) {
      const message = 'hc ls response has no terminals array';
      log('[herdr] desktop core terminal list returned invalid shape', {
        keys: isRecord(parsed) ? Object.keys(parsed) : [],
      });
      return { kind: 'invalid-shape', message };
    }

    const addresses: string[] = [];
    for (const entry of parsed.terminals) {
      if (!isRecord(entry) || typeof entry.address !== 'string') {
        const message = 'hc ls response has an invalid terminal entry';
        log('[herdr] desktop core terminal list returned invalid entry', {
          entryType: typeof entry,
        });
        return { kind: 'invalid-shape', message };
      }
      if (!/^t[\w-]+$/.test(entry.address)) {
        log('[herdr] desktop core terminal list skipped non-local address', {
          address: entry.address,
        });
        continue;
      }
      addresses.push(entry.address);
    }
    return { kind: 'found', addresses };
  } catch (error) {
    log('[herdr] desktop core terminal list threw', { error: String(error) });
    return { kind: 'temporary-error', message: String(error) };
  }
}

async function readCoreTerminalResult(
  hc: string,
  address: string,
): Promise<CoreTerminalRead> {
  try {
    const proc = crossSpawn([hc, 'get', address, '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      proc.stdout(),
      proc.stderr(),
    ]);
    if (exitCode !== 0) {
      const errorText = stderr.trim() || stdout.trim();
      const errorKind = cliErrorKind(stdout) ?? cliErrorKind(stderr);
      log('[herdr] desktop terminal lookup failed', {
        address,
        exitCode,
        errorKind,
        error: errorText.slice(0, 512),
      });
      if (errorKind === 'not_found') {
        return { kind: 'missing', message: errorText };
      }
      if (errorKind === 'invalid_params') {
        return { kind: 'invalid-shape', message: errorText };
      }
      return { kind: 'temporary-error', message: errorText };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      const message = `hc get returned invalid JSON for ${address}`;
      log('[herdr] desktop terminal lookup returned invalid JSON', {
        address,
      });
      return { kind: 'invalid-shape', message };
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.address !== 'string' ||
      parsed.address !== address ||
      (typeof parsed.parent !== 'string' && parsed.parent !== null) ||
      !isRecord(parsed.labels) ||
      (parsed.state !== 'live' && parsed.state !== 'finished')
    ) {
      const message = `hc get returned invalid fields for ${address}`;
      log('[herdr] desktop terminal lookup returned invalid fields', {
        address,
        stdout: stdout.slice(0, 256),
      });
      return { kind: 'invalid-shape', message };
    }
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.labels)) {
      if (typeof value !== 'string') {
        const message = `hc get returned a non-string label for ${address}`;
        log('[herdr] desktop terminal lookup returned invalid labels', {
          address,
        });
        return { kind: 'invalid-shape', message };
      }
      labels[key] = value;
    }
    return {
      kind: 'found',
      terminal: {
        address: parsed.address,
        parent: parsed.parent,
        labels,
        state: parsed.state,
      },
    };
  } catch (error) {
    log('[herdr] desktop terminal lookup threw', {
      address,
      error: String(error),
    });
    return { kind: 'temporary-error', message: String(error) };
  }
}

function cliErrorKind(output: string): string | null {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!isRecord(parsed) || !isRecord(parsed.error)) return null;
    return typeof parsed.error.kind === 'string' ? parsed.error.kind : null;
  } catch {
    return null;
  }
}

interface DesktopListedTerminal {
  terminal: string;
  pane?: unknown;
}

interface DesktopListedTab {
  id: string;
  terminals: DesktopListedTerminal[];
}

interface DesktopListedSpace {
  id: string;
  tabs: DesktopListedTab[];
}

async function waitForDesktopPane(
  app: string,
  hc: string,
  address: string,
  ownership: DesktopOwnership,
  wait: DesktopAdoptionWait,
): Promise<boolean> {
  for (let retry = 0; retry <= DESKTOP_ADOPTION_RETRIES; retry += 1) {
    const terminalRead = await readCoreTerminalResult(hc, address);
    if (terminalRead.kind === 'missing') {
      log('[herdr] desktop spawn: child disappeared before pane adoption', {
        paneId: address,
        detail: terminalRead.message,
      });
      return false;
    }
    if (terminalRead.kind === 'invalid-shape') {
      log('[herdr] desktop spawn: child lookup returned invalid shape', {
        paneId: address,
        detail: terminalRead.message,
      });
      return false;
    }
    if (terminalRead.kind === 'temporary-error') {
      if (retry === DESKTOP_ADOPTION_RETRIES) return false;
      log('[herdr] desktop spawn: temporary core lookup failure', {
        paneId: address,
        retry: retry + 1,
        detail: terminalRead.message,
      });
      await wait(DESKTOP_ADOPTION_POLL_MS);
      continue;
    }
    const terminal = terminalRead.terminal;
    if (!matchesDesktopTerminal(terminal, address, ownership)) {
      log('[herdr] desktop spawn: child ownership changed during adoption', {
        paneId: address,
      });
      return false;
    }
    if (terminal.state !== 'live') {
      log('[herdr] desktop spawn: viewer exited before pane adoption', {
        paneId: address,
        state: terminal.state,
      });
      return false;
    }

    const spacesRead = await readDesktopSpaces(app);
    if (spacesRead.kind === 'invalid-shape') return false;
    if (
      spacesRead.kind === 'found' &&
      spacesRead.spaces.some(
        (space) =>
          space.id === ownership.spaceId &&
          space.tabs.some(
            (tab) =>
              tab.id === ownership.tabId &&
              tab.terminals.some(
                (terminal) =>
                  terminal.terminal === address &&
                  typeof terminal.pane === 'string' &&
                  terminal.pane.length > 0,
              ),
          ),
      ) === true
    ) {
      return true;
    }
    if (retry === DESKTOP_ADOPTION_RETRIES) return false;
    if (spacesRead.kind === 'temporary-error') {
      log('[herdr] desktop spawn: temporary app scan failed during adoption', {
        paneId: address,
        retry: retry + 1,
        detail: spacesRead.message,
      });
    } else {
      log('[herdr] desktop spawn: confirmed pane absence', {
        paneId: address,
        retry: retry + 1,
        maxRetries: DESKTOP_ADOPTION_RETRIES,
      });
    }
    await wait(DESKTOP_ADOPTION_POLL_MS);
  }
  return false;
}

async function readDesktopSpaces(app: string): Promise<DesktopSpacesRead> {
  try {
    const proc = crossSpawn([app, 'ls'], { stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      proc.stdout(),
      proc.stderr(),
    ]);
    if (exitCode !== 0) {
      const message = `herdr-app ls exited ${exitCode}`;
      log('[herdr] desktop pane scan failed', {
        exitCode,
        stderr: stderr.trim(),
        stdout: stdout.trim().slice(0, 256),
      });
      return { kind: 'temporary-error', message };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      const message = `herdr-app ls returned invalid JSON: ${String(error)}`;
      log('[herdr] desktop pane scan returned invalid JSON', {
        error: String(error),
        stdout: stdout.slice(0, 256),
      });
      return { kind: 'invalid-shape', message };
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.spaces)) {
      log('[herdr] desktop pane scan returned invalid shape', {
        responseType: typeof parsed,
        keys: isRecord(parsed) ? Object.keys(parsed) : [],
      });
      return { kind: 'invalid-shape', message: 'missing spaces array' };
    }
    const spaces: DesktopListedSpace[] = [];
    for (const space of parsed.spaces) {
      if (!isRecord(space) || typeof space.id !== 'string') {
        log('[herdr] desktop pane scan found an invalid space entry', {
          entryType: typeof space,
        });
        return { kind: 'invalid-shape', message: 'invalid space entry' };
      }
      if (!Array.isArray(space.tabs)) {
        log('[herdr] desktop pane scan found invalid tabs shape', {
          spaceId: space.id,
        });
        return { kind: 'invalid-shape', message: 'invalid tabs array' };
      }
      const tabs: DesktopListedTab[] = [];
      for (const tab of space.tabs) {
        if (!isRecord(tab) || typeof tab.id !== 'string') {
          log('[herdr] desktop pane scan found an invalid tab entry', {
            spaceId: space.id,
          });
          return { kind: 'invalid-shape', message: 'invalid tab entry' };
        }
        if (!Array.isArray(tab.terminals)) {
          log('[herdr] desktop pane scan found invalid terminals shape', {
            spaceId: space.id,
            tabId: tab.id,
          });
          return { kind: 'invalid-shape', message: 'invalid terminals array' };
        }
        const terminals = tab.terminals.filter(
          (terminal): terminal is DesktopListedTerminal =>
            isRecord(terminal) && typeof terminal.terminal === 'string',
        );
        if (terminals.length !== tab.terminals.length) {
          log('[herdr] desktop pane scan found an invalid terminal entry', {
            spaceId: space.id,
            tabId: tab.id,
          });
          return { kind: 'invalid-shape', message: 'invalid terminal entry' };
        }
        tabs.push({ id: tab.id, terminals });
      }
      spaces.push({ id: space.id, tabs });
    }
    return { kind: 'found', spaces };
  } catch (error) {
    log('[herdr] desktop pane scan threw', { error: String(error) });
    return { kind: 'temporary-error', message: String(error) };
  }
}

function isSweepTitle(title: string | undefined): title is string {
  return (
    typeof title === 'string' && /^omosc:\d{1,10}:[\w-]{1,64}$/.test(title)
  );
}

function desktopTerminalName(description: string, sessionId: string): string {
  const descriptionSlug = description
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/^[^a-z0-9]+/, '');
  const sessionSuffix =
    sessionId
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(-30) || 'session';
  const prefixLength = 31 - sessionSuffix.length;
  const prefix =
    descriptionSlug.slice(0, prefixLength).replace(/[^a-z0-9]+$/g, '') || 'a';
  return `${prefix}-${sessionSuffix}`;
}

function getPaneDirection(layout: MultiplexerLayout): HerdrPaneDirection {
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

/**
 * Direction later children stack inside the agent area. Only the `main-*`
 * layouts create one: below for `main-vertical`, to the right for
 * `main-horizontal` (mirroring the WezTerm agent row).
 */
function getStackDirection(layout: MultiplexerLayout): HerdrPaneDirection {
  return layout === 'main-vertical' ? 'down' : 'right';
}

/**
 * Herdr's `--ratio` is the fraction RETAINED BY THE ANCHOR pane: splitting an
 * anchor with `--ratio 0.8` leaves the anchor at 80% and gives the new pane
 * the remaining 20% (verified against herdr 0.2.x `pane layout` geometry).
 * `main_pane_size` describes that anchor (the main pane), so it maps directly.
 * Clamped to 0.2–0.8 so a hand-edited config can never make either side
 * unusable.
 */
function agentPaneRatio(mainPaneSize: number): number {
  return Math.max(0.2, Math.min(0.8, mainPaneSize / 100));
}
