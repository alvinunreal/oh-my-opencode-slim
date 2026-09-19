/**
 * Client-side pane lifecycle core (FR-1..FR-13).
 *
 * Wired only from the TUI entry (`src/tui.ts`); the server entry's dependency
 * graph must never reach this directory (invariant I1, task 3.10).
 */

export * from './diagnostics';
export * from './lifecycle';
export * from './pane-title';
export * from './ports';
export * from './sweep';
export * from './types';
