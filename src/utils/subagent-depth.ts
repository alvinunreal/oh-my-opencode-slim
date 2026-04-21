import { DEFAULT_MAX_SUBAGENT_DEPTH } from '../config';
import { log } from './logger';

/**
 * Tracks subagent spawn depth to prevent excessive nesting.
 *
 * Depth 0 = root session (user's main conversation)
 * Depth 1 = agent spawned by root (e.g., explorer, council)
 * Depth 2 = agent spawned by depth-1 agent (e.g., councillor spawned by council)
 * Depth 3 = agent spawned by depth-2 agent (max depth by default)
 *
 * When max depth is exceeded, the spawn is blocked.
 */
export class SubagentDepthTracker {
  private depthBySession = new Map<string, number>();
  private readonly _maxDepth: number;

  constructor(maxDepth: number = DEFAULT_MAX_SUBAGENT_DEPTH) {
    this._maxDepth = maxDepth;
  }

  /** Maximum allowed depth. */
  get maxDepth(): number {
    return this._maxDepth;
  }

  /**
   * Get the current depth of a session.
   * Root sessions (not tracked) have depth 0.
   */
  getDepth(sessionId: string): number {
    return this.depthBySession.get(sessionId) ?? 0;
  }

  /**
   * Register a child session and check if the spawn is allowed.
   * @returns true if allowed, false if max depth exceeded
   */
  registerChild(parentSessionId: string, childSessionId: string): boolean {
    const parentDepth = this.getDepth(parentSessionId);
    const childDepth = parentDepth + 1;

    if (childDepth > this.maxDepth) {
      log('[subagent-depth] spawn blocked: max depth exceeded', {
        parentSessionId,
        parentDepth,
        childDepth,
        maxDepth: this.maxDepth,
      });
      return false;
    }

    this.depthBySession.set(childSessionId, childDepth);
    log('[subagent-depth] child registered', {
      parentSessionId,
      childSessionId,
      childDepth,
    });
    return true;
  }

  /**
   * Clean up session tracking when a session is deleted.
   */
  cleanup(sessionId: string): void {
    this.depthBySession.delete(sessionId);
  }

  /**
   * Clean up all tracking data.
   */
  cleanupAll(): void {
    this.depthBySession.clear();
  }
}
