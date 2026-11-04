/**
 * Herdr agent-area equalization
 *
 * Herdr splits a tab into a binary layout tree. A split's `ratio` is the
 * share taken by its FIRST child, and `layout.set_split_ratio` rewrites one
 * node addressed by an array of child choices (false = first, true = second).
 *
 * After a spawn or an agent-pane close, only the AGENT panes are equalized:
 * every split node whose subtree does not contain the main pane is set to
 * `span(first) / (span(first) + span(second))`. `span` counts the panes a
 * subtree occupies ALONG the split's axis; a perpendicular split does not
 * divide that axis, so the larger side wins. Splits that contain the main
 * pane are never rewritten by the equalizer, which keeps the main pane at its
 * `main_pane_size` share.
 *
 * When `mainPaneShare` is supplied, the split that bounds the main pane is
 * additionally re-asserted to that share. This makes the sizing idempotent:
 * it repairs drift and a fallback split that could not be sized, without
 * touching any agent split.
 *
 * The socket protocol is one request per connection: write one
 * `{"id","method","params"}\n` line, read one line back, close.
 *
 * Windows: herdr binds its socket as the named pipe `\\.\pipe\<path>`, so the
 * plain file path is not connectable there — `herdrSocketEndpoint` maps it.
 */

import { createConnection } from 'node:net';
import { isRecord } from '../../utils/guards';
import { log } from '../../utils/logger';

export type HerdrSplitDirection = 'down' | 'right';

interface HerdrLayoutPane {
  type: 'pane';
  pane_id: string;
}

interface HerdrLayoutSplit {
  type: 'split';
  direction: HerdrSplitDirection;
  ratio: number;
  first: HerdrLayoutNode;
  second: HerdrLayoutNode;
}

export type HerdrLayoutNode = HerdrLayoutPane | HerdrLayoutSplit;

interface SplitRatioUpdate {
  /** Child choices from the root: false = first, true = second. */
  path: boolean[];
  ratio: number;
}

export interface EqualizeAgentPanesOptions {
  socketPath: string;
  tabId: string;
  mainPaneId: string;
  /**
   * Main pane share (0..1). When set, the main/agent boundary is re-asserted
   * to this share so sizing is self-healing.
   */
  mainPaneShare?: number;
  /**
   * Panes this client spawned. When set, only subtrees made up entirely of
   * these panes are equalized, so unrelated user panes keep their sizes.
   */
  agentPaneIds?: ReadonlySet<string>;
  /** Per-request socket timeout. */
  timeoutMs?: number;
  /** Overall budget for one equalization pass (requests run in parallel). */
  budgetMs?: number;
  /** Receives every pane id seen in the exported layout (used for pruning). */
  onPanesSeen?: (paneIds: Set<string>) => void;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_BUDGET_MS = 800;
const RATIO_EPSILON = 0.005;
const MIN_SHARE = 0.2;
const MAX_SHARE = 0.8;

/** Number of panes a subtree occupies along `axis`. */
export function paneSpan(
  node: HerdrLayoutNode,
  axis: HerdrSplitDirection,
): number {
  if (node.type === 'pane') return 1;
  const first = paneSpan(node.first, axis);
  const second = paneSpan(node.second, axis);
  return node.direction === axis ? first + second : Math.max(first, second);
}

function containsPane(node: HerdrLayoutNode, paneId: string): boolean {
  if (node.type === 'pane') return node.pane_id === paneId;
  return containsPane(node.first, paneId) || containsPane(node.second, paneId);
}

/**
 * Split-ratio updates that equalize every agent-only subtree. The split that
 * bounds the main pane is skipped (recursed into, never rewritten).
 *
 * When `agentPaneIds` is given, a subtree is equalized only if every pane in
 * it was spawned by this client. A user pane that happens to live in the same
 * tab is left at its own ratio.
 */
export function equalizeUpdates(
  root: HerdrLayoutNode,
  mainPaneId: string,
  agentPaneIds?: ReadonlySet<string>,
): SplitRatioUpdate[] {
  const updates: SplitRatioUpdate[] = [];

  const isAgentOnly = (node: HerdrLayoutNode): boolean => {
    if (!agentPaneIds) return true;
    for (const id of collectPaneIds(node)) {
      if (!agentPaneIds.has(id)) return false;
    }
    return true;
  };

  const walk = (node: HerdrLayoutNode, path: boolean[]): void => {
    if (node.type !== 'split') return;

    if (!containsPane(node, mainPaneId) && isAgentOnly(node)) {
      const first = paneSpan(node.first, node.direction);
      const second = paneSpan(node.second, node.direction);
      updates.push({ path, ratio: first / (first + second) });
    }

    // Keep descending: a mixed subtree can still contain a pure agent branch.
    walk(node.first, [...path, false]);
    walk(node.second, [...path, true]);
  };

  walk(root, []);
  return updates;
}

/**
 * The split that directly parents the main pane, pinned to `mainPaneShare`.
 * Working with the direct parent (rather than the shallowest split that merely
 * separates main from the rest) means the ratio governs the main pane itself,
 * not a subtree that happens to contain it. Returns null when the main pane is
 * not in the tree (or the share is unusable).
 */
export function mainBoundaryUpdate(
  root: HerdrLayoutNode,
  mainPaneId: string,
  mainPaneShare: number,
): SplitRatioUpdate | null {
  if (!Number.isFinite(mainPaneShare)) return null;
  const share = Math.max(MIN_SHARE, Math.min(MAX_SHARE, mainPaneShare));

  const walk = (
    node: HerdrLayoutNode,
    path: boolean[],
  ): SplitRatioUpdate | null => {
    if (node.type !== 'split') return null;
    if (node.first.type === 'pane' && node.first.pane_id === mainPaneId) {
      return { path, ratio: share };
    }
    if (node.second.type === 'pane' && node.second.pane_id === mainPaneId) {
      // Round the complement so the socket payload carries a clean ratio
      // (1 - 0.8 is 0.19999999999999996 in binary floating point).
      return { path, ratio: Number((1 - share).toFixed(6)) };
    }
    return (
      walk(node.first, [...path, false]) ?? walk(node.second, [...path, true])
    );
  };

  return walk(root, []);
}

/** Current `ratio` of the split at `path`, or null when it is not a split. */
export function ratioAtPath(
  root: HerdrLayoutNode,
  path: boolean[],
): number | null {
  let node: HerdrLayoutNode = root;
  for (const second of path) {
    if (node.type !== 'split') return null;
    node = second ? node.second : node.first;
  }
  return node.type === 'split' ? node.ratio : null;
}

/** Every pane id in the tree, depth-first. */
export function collectPaneIds(root: HerdrLayoutNode): Set<string> {
  const ids = new Set<string>();
  const walk = (node: HerdrLayoutNode): void => {
    if (node.type === 'pane') {
      ids.add(node.pane_id);
      return;
    }
    walk(node.first);
    walk(node.second);
  };
  walk(root);
  return ids;
}

function isLayoutNode(value: unknown): value is HerdrLayoutNode {
  if (!isRecord(value)) return false;
  if (value.type === 'pane') return typeof value.pane_id === 'string';
  if (value.type !== 'split') return false;
  if (value.direction !== 'down' && value.direction !== 'right') return false;
  return (
    typeof value.ratio === 'number' &&
    isLayoutNode(value.first) &&
    isLayoutNode(value.second)
  );
}

function describeHerdrError(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

/**
 * The endpoint to connect to for a herdr socket path. On Windows herdr binds
 * the named pipe `\\.\pipe\<path>`, so the plain file path refuses the
 * connection; on POSIX the path is the socket itself.
 */
export function herdrSocketEndpoint(socketPath: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${socketPath}`
    : socketPath;
}

/** One request per socket connection; resolves with the response `result`. */
function sendHerdrRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(herdrSocketEndpoint(socketPath));
    let buffer = '';
    let settled = false;

    const settle = (error: Error | null, result?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };

    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () =>
      settle(new Error(`${method}: timed out after ${timeoutMs}ms`)),
    );
    socket.on('error', (error) => settle(error));
    socket.on('close', () =>
      settle(new Error(`${method}: connection closed before response`)),
    );
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({ id: `omosc:${method}`, method, params })}\n`,
      );
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;

      const line = buffer.slice(0, newline).trim();
      let response: unknown;
      try {
        response = JSON.parse(line);
      } catch (error) {
        settle(new Error(`${method}: invalid JSON (${String(error)})`));
        return;
      }

      if (!isRecord(response)) {
        settle(new Error(`${method}: malformed response`));
        return;
      }
      if ('error' in response) {
        settle(new Error(`${method}: ${describeHerdrError(response.error)}`));
        return;
      }
      settle(null, response.result);
    });
  });
}

/**
 * Equalize the agent panes of `tabId`, leaving the agent splits of the main
 * pane alone and (when `mainPaneShare` is given) re-asserting the main/agent
 * boundary. Best-effort: every failure is logged and reported as `false`,
 * never thrown. Ratio writes are independent, so they run in parallel within
 * one budget; splits already within rounding of their target are skipped.
 */
export async function equalizeAgentPanes(
  opts: EqualizeAgentPanesOptions,
): Promise<boolean> {
  const { socketPath, tabId, mainPaneId } = opts;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const perRequestCap = Math.min(
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    budgetMs,
  );
  // One deadline for the whole pass: the export and the writes share it, so a
  // slow export cannot be followed by a full-length write phase.
  const deadline = Date.now() + budgetMs;
  const remaining = (): number => Math.max(0, deadline - Date.now());
  const requestTimeout = (): number =>
    Math.max(1, Math.min(perRequestCap, remaining()));

  try {
    const exported = await sendHerdrRequest(
      socketPath,
      'layout.export',
      { tab_id: tabId },
      requestTimeout(),
    );
    const layout = isRecord(exported) ? exported.layout : undefined;
    if (!isRecord(layout)) {
      log('[herdr] equalizeAgentPanes: unusable layout export', { tabId });
      return false;
    }
    const root = layout.root;
    if (!isLayoutNode(root)) {
      log('[herdr] equalizeAgentPanes: unusable layout export', { tabId });
      return false;
    }

    if (layout.zoomed === true) {
      log('[herdr] equalizeAgentPanes: skipped (tab is zoomed)', { tabId });
      return true;
    }

    opts.onPanesSeen?.(collectPaneIds(root));

    const boundary =
      opts.mainPaneShare === undefined
        ? null
        : mainBoundaryUpdate(root, mainPaneId, opts.mainPaneShare);
    const requested = [
      ...(boundary ? [boundary] : []),
      ...equalizeUpdates(root, mainPaneId, opts.agentPaneIds),
    ];

    // Skip splits that already sit at their target: a steady-state spawn then
    // costs one export instead of rewriting every split on the column.
    const updates = requested.filter((update) => {
      const current = ratioAtPath(root, update.path);
      return (
        current === null || Math.abs(current - update.ratio) > RATIO_EPSILON
      );
    });

    if (updates.length === 0) return true;

    if (remaining() <= 0) {
      log('[herdr] equalizeAgentPanes: budget exhausted before ratio writes', {
        tabId,
      });
      return false;
    }
    const writeTimeout = requestTimeout();

    const results = await Promise.allSettled(
      updates.map((update) =>
        sendHerdrRequest(
          socketPath,
          'layout.set_split_ratio',
          { tab_id: tabId, path: update.path, ratio: update.ratio },
          writeTimeout,
        ),
      ),
    );

    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length > 0) {
      log('[herdr] equalizeAgentPanes: some ratio writes failed', {
        tabId,
        applied: updates.length - failures.length,
        failed: failures.length,
        error: describeHerdrError(failures[0]?.reason),
      });
      return false;
    }

    log('[herdr] equalizeAgentPanes: applied', {
      tabId,
      splits: updates.length,
      boundary: boundary !== null,
    });
    return true;
  } catch (error) {
    log('[herdr] equalizeAgentPanes: failed', {
      tabId,
      error: describeHerdrError(error),
    });
    return false;
  }
}
