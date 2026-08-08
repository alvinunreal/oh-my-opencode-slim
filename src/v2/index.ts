/**
 * OpenCode v2 (`opencode2`) plugin adapter.
 *
 * v2 loads the plugin's `default.setup(ctx)`. This package's default export is
 * `{ id, server, setup }`: v1 calls `.server` (the unchanged v1 factory); v2
 * calls `.setup` (the adapter exported here).
 *
 * The adapter wraps the existing v1 factory to reuse ALL build logic, then
 * translates the returned v1 `Hooks` into v2 registrations (agent/tool/command
 * transforms, session/tool runtime hooks, event stream). Shape conversion and
 * the v1→v2 semantic mappings (task→subagent, permission base, etc.) live in
 * the peer modules. See `codemap.md`.
 */

export { createV2Setup } from './setup';
export type {
  ModelRef,
  V2AgentDraft,
  V2Cleanup,
  V2CommandDraft,
  V2Context,
  V2Registration,
  V2SessionContextEvent,
  V2ToolAfterEvent,
  V2ToolBeforeEvent,
  V2ToolDraft,
} from './types';
