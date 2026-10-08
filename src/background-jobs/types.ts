import type { TaskOutputState } from '../utils/task';

export interface ContextFile {
  path: string;
  lineCount: number;
  lineNumbers?: number[];
  lastReadAt: number;
}

export interface BackgroundJobExecution {
  taskID: string;
  generation: number;
  terminalRevision?: number;
}

export type BackgroundJobLeaseKind =
  | 'cancellation'
  | 'relaunch'
  | 'message'
  | 'terminal-notification';

/** Process-local ownership of a remote operation or same-ID relaunch. */
export interface BackgroundJobLease {
  taskID: string;
  generation: number;
  token: string;
  kind: BackgroundJobLeaseKind;
  terminalRevision?: number;
}

export interface BackgroundJobPromptMetadata {
  text: string | undefined;
  terminalUnreconciledTaskIDs: BackgroundJobExecution[];
}

/** Metadata for an accessible reusable session selected from the sidebar. */
export interface ReusableSessionSelection {
  taskID: string;
  alias: string;
  terminalState: TaskOutputState | 'stopped';
  completedAt?: number;
  lastUsedAt: number;
}

export type BackgroundJobState = TaskOutputState | 'stopped' | 'reconciled';

export interface BackgroundJobRecord {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description: string;
  objective?: string;
  state: BackgroundJobState;
  /** Unattributed lifecycle placeholder, not yet delegated work. */
  provisional?: boolean;
  /** True only when the native task call explicitly supplied background:true. */
  background: boolean;
  timedOut: boolean;
  recoverableAfterLiveBusy: boolean;
  statusUncertain: boolean;
  /** When status became unconfirmable; drives stale-uncertain removal from the board render. */
  statusUncertainSince?: number;
  cancellationRequested: boolean;
  terminalUnreconciled: boolean;
  launchedAt: number;
  lastLaunchedAt: number;
  /** Monotonic run identity. Explicit relaunch/reuse increments it. */
  generation: number;
  /** Publication identity within a run, including withdrawn publications. */
  terminalRevision: number;
  activityRevision: number;
  /** Task-local run identity; unlike generation, unrelated tasks do not affect it. */
  taskGeneration: number;
  /** First launch observation for the current generation. */
  runStartedAt: number;
  /** Persistent hard wall-clock marker; distinct from external task wait timeout. */
  deadlineExceededAt?: number;
  updatedAt: number;
  lastLiveBusyAt?: number;
  /** First non-busy runtime observation for the current stop-confirmation grace. */
  stopConfirmationStartedAt?: number;
  completedAt?: number;
  resultSummary?: string;
  lastStatusError?: string;
  alias: string;
  lastUsedAt: number;
  terminalState?: TaskOutputState;
  contextFiles: ContextFile[];
  totalErrors?: number;
  timeoutCount?: number;
  lastErrorAt?: number;
  /** In-memory only: this row is a verified old host round, not a live run. */
  verifiedRetainedRound?: true;
  /** Recovery has not sent a prompt; importing a row does not own host work. */
  recoveredWithoutPrompt?: true;
  /**
   * In-memory provenance: this plugin's own tracked native task call launched
   * this record as a fresh background child. Never set for adopted, restored,
   * provisional, or once-provisional records. Gates terminal-session GC.
   */
  pluginLaunched?: true;
  /**
   * Sticky provenance: the host session was adopted, restored, rehydrated,
   * or first seen as an unattributed placeholder, so this plugin cannot
   * prove it created it. Never cleared; blocks pluginLaunched.
   */
  externalOrigin?: true;
}

export interface BackgroundJobBoardOptions {
  maxReusablePerAgent?: number;
  maxContextLines?: number;
  readContextMinLines?: number;
  readContextMaxFiles?: number;
  /** Delegation tool name for model-visible recovery guidance: `subagent` on
   * v2 hosts, `task` on v1/default. Only the two retained/recovery wording
   * lines vary; the board stays v1 by default. */
  delegationTool?: string;
  /**
   * Production boards number only parents created while they run (see
   * noteSessionCreated); other parents' new records use the task ID as
   * their alias and creation still succeeds. Default false keeps direct
   * fixtures on the historical immediate counter.
   */
  deferNumberedAliases?: boolean;
  /**
   * Fired after a retention trim (trimReusable/trimRetained) evicts a
   * terminal or retained-stopped record. Never fires for clearParent/drop,
   * which can evict running or unreconciled records. Listener throws are
   * contained.
   */
  onEvictedSession?: (evicted: BackgroundJobEvictedSession) => void;
}

/** Snapshot of a record evicted by a retention trim, captured before the
 * delete. Terminal-session GC removes the underlying host child session. */
export interface BackgroundJobEvictedSession {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description: string;
  state: BackgroundJobState;
  /** Record was a background launch (foreground task children are false). */
  background: boolean;
  /** Record was still an unattributed session.created placeholder. */
  provisional: boolean;
  /** This plugin's own tracked native task call launched the session. */
  pluginLaunched: boolean;
  /** Session was adopted, restored, rehydrated, or once provisional. */
  externalOrigin: boolean;
  terminalState?: TaskOutputState;
  resultSummary?: string;
  alias: string;
  lastUsedAt: number;
}

/**
 * Terminal-session GC eligibility: only a background, non-provisional record
 * that this plugin's own native task call launched, with no adopted,
 * restored, rehydrated, or placeholder provenance. Everything else keeps its
 * host session.
 */
export function isPrunableEvictedSession(
  evicted: BackgroundJobEvictedSession,
): boolean {
  return (
    evicted.background &&
    !evicted.provisional &&
    evicted.pluginLaunched &&
    !evicted.externalOrigin
  );
}

/** Verified host session placed directly into a terminal retained state.
 * This is a cache observation, not a new model run. */
export interface RestoreRetainedSessionInput {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description: string;
  objective?: string;
  state: 'completed' | 'error' | 'cancelled' | 'stopped';
  background: boolean;
  resultSummary?: string;
  /** Trusted historical alias. Omit to display the exact session id. */
  alias?: string;
  /** Evidence timestamp. Omitted values stay 0; never the recovery clock. */
  launchedAt?: number;
  completedAt?: number;
}

export interface BackgroundJobLaunchInput {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description?: string;
  objective?: string;
  background?: boolean;
  /** Only unattributed session.created placeholders opt in. */
  provisional?: true;
  /** An existing host child keeps its task ID; numbers are for new children. */
  adopted?: true;
  /** Preserve the current run when this is a duplicate lifecycle observation. */
  preserveRun?: boolean;
  /**
   * This plugin's own tracked native task call launched a fresh background
   * child (not a resume). Ignored for adopted/provisional input and for
   * records with external provenance.
   */
  pluginLaunched?: true;
  /** Lease proving that this is an authorized same-ID relaunch observation. */
  relaunchLease?: BackgroundJobLease;
  /** Backwards-compatible generic spelling for the relaunch lease. */
  lease?: BackgroundJobLease;
  now?: number;
}

export interface BackgroundJobStatusInput {
  taskID: string;
  state: TaskOutputState;
  /** Ignore native output from an older run of the same task ID. */
  expectedGeneration?: number;
  timedOut?: boolean;
  statusUncertain?: boolean;
  resultSummary?: string;
  lastStatusError?: string;
  now?: number;
}

export interface BackgroundJobAdoptionInput {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description: string;
  terminalState: 'completed' | 'error';
  resultSummary?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WallClockTimeoutClaimInput {
  taskID: string;
  generation: number;
  now?: number;
  resultSummary?: string;
}

export interface BackgroundJobTerminalInput {
  taskID: string;
  state: 'completed' | 'error' | 'cancelled' | 'stopped';
  resultSummary: string;
  cancellationLease?: BackgroundJobLease;
  now?: number;
}

export interface WallClockTimeoutFinalizeInput {
  taskID: string;
  generation: number;
  now?: number;
  statusUncertain: boolean;
  resultSummary: string;
}

export class BackgroundJobLaunchConflictError extends Error {
  constructor(taskID: string, message: string) {
    super(`Cannot register launch for ${taskID}: ${message}`);
    this.name = 'BackgroundJobLaunchConflictError';
  }
}

/**
 * Unconfirmable-runtime age after which a running job leaves the board
 * render (#1314). No existing stale/TTL constant family fits this scale.
 */
export const STATUS_UNCERTAIN_DEMOTE_AFTER_MS = 30 * 60_000;

/**
 * Render-only discoverability window (store survives for reconciler/revive;
 * only real retrieval via markUsed refreshes it, rendering never does).
 * Different layer than STATUS_UNCERTAIN_DEMOTE_AFTER_MS (lifecycle grace).
 */
export const AGED_ENTRY_RENDER_TTL_MS = 6 * 60 * 60_000;

export function deriveTaskSessionLabel(input: {
  description?: string;
  prompt?: string;
  agentType: string;
}): string {
  const preferred = normalizeWhitespace(input.description ?? '');
  if (preferred) return preferred.slice(0, 48);
  const firstPromptLine = (input.prompt ?? '')
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .find(Boolean);
  return firstPromptLine
    ? firstPromptLine.slice(0, 48)
    : `recent ${input.agentType} task`;
}
/**
 * Full objective text before deriveTaskSessionLabel truncates it: the
 * whitespace-normalized description, else the first non-empty prompt line.
 * Board records store this untruncated so the duplicate-spawn guard can
 * match long exact duplicates without colliding on shared 48-char prefixes.
 */
export function deriveFullObjective(input: {
  description?: string;
  prompt?: string;
}): string | undefined {
  const preferred = normalizeWhitespace(input.description ?? '');
  if (preferred) return preferred;
  const firstPromptLine = (input.prompt ?? '')
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .find(Boolean);
  return firstPromptLine ?? undefined;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
