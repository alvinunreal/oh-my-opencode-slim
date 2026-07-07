# Herdr `main-vertical` Layout Fix — Design Spec

**Date:** 2026-07-07
**Issue:** #668 — Herdr: implement proper `main-vertical` layout instead of repeatedly splitting right
**Branch:** `feat/herdr-main-vertical-668`

## Problem

Herdr's `main-vertical` multiplexer layout currently maps to `--direction right` for **every** child pane. This means each newly spawned subagent creates another rightward split from the parent pane, fragmenting the workspace into an increasingly narrow horizontal strip layout. The parent OpenCode pane loses visual priority and agents become hard to read.

Expected behavior (tmux `main-vertical` style):
- Parent OpenCode pane stays large on the left (~60% width, full height)
- First subagent opens in a right-side pane (full height of right column)
- Subsequent subagents stack **vertically** within the right-side column
- Parent pane remains dominant as agents are added

## Approach

Track a single `agentAreaPaneId` — the first child pane created in the right column. Route subsequent child spawns to split **down** from that agent area pane, instead of repeatedly splitting right from the parent.

### State Changes (`HerdrMultiplexer`)

```typescript
private readonly layout: MultiplexerLayout;        // stored from constructor
private readonly paneDirection: HerdrPaneDirection; // kept for non-main layouts
private agentAreaPaneId: string | null = null;      // tracks first child in right column
```

- `layout` is stored (previously discarded after computing `paneDirection`)
- `paneDirection` is retained for non-`main-*` layouts (`even-*`, `tiled`)
- `agentAreaPaneId` is the new tracking field

### `spawnPane` Logic

```
spawnPane(sessionId, description, serverUrl, directory):
  1. Get herdr binary (existing)

  2. Determine split target and direction:
     let target, direction, wasFirstChild = false

     if layout === 'main-vertical' AND agentAreaPaneId is set:
       target = [agentAreaPaneId]
       direction = 'down'
       result = split(target, direction)
       if result failed:
         log('[herdr] agent area split failed, falling back to parent', {stderr})
         agentAreaPaneId = null

     if agentAreaPaneId is null:  // first child OR fallback
       target = targetPaneArg()   // parentPaneId or --current
       direction = paneDirection  // 'right' for main-vertical
       wasFirstChild = true

  3. If we did not already split in step 2: split(target, direction)
  4. Parse pane_id from output
  5. If wasFirstChild AND layout === 'main-vertical':
       agentAreaPaneId = newPaneId
  6. Rename pane, run opencode attach (existing)
```

Key properties:
- **First child** splits parent → right, creating the agent area
- **Subsequent children** split agent area → down, stacking vertically
- **Stale reference** (agent area pane closed externally): split fails → log → clear → fall through to parent split (re-creates agent area)
- **Explicit `wasFirstChild` flag** avoids fragile implicit detection
- **Gated on `main-vertical` only** — other layouts unchanged

### `closePane` Change

```typescript
async closePane(paneId: string): Promise<boolean> {
  if (paneId === this.agentAreaPaneId) {
    this.agentAreaPaneId = null;  // next spawn re-creates from parent
  }
  // ... existing logic unchanged
}
```

### `applyLayout` Change

```typescript
async applyLayout(_layout: MultiplexerLayout, _mainPaneSize: number): Promise<void> {
  // ponytail: herdr has no rebalancing API; clear agent area so a layout
  // switch starts fresh from the parent pane.
  this.agentAreaPaneId = null;
}
```

## Scope

**In scope:**
- `main-vertical` layout for Herdr multiplexer
- Tracking agent area pane, smart split targeting, fallback on stale reference
- `closePane` and `applyLayout` cleanup
- Tests for main-vertical behavior
- Docs update for actual Herdr main-vertical behavior

**Out of scope (YAGNI):**
- `main-horizontal` layout (same pattern, swapped axes — not requested)
- Full pane-list querying of Herdr state
- Layout rebalancing (Herdr has no API for it)
- Concurrent spawn locking (current architecture is sequential)

## Testing

Tests to add in `src/multiplexer/herdr/index.test.ts`:

1. `main-vertical` 1st spawn → split parent → right
2. `main-vertical` 2nd spawn → split agent area → down
3. `main-vertical` 3rd spawn → split agent area → down (same target)
4. Agent area pane closed → next spawn falls back to parent → right
5. `tiled` layout → always splits parent → right (unaffected)
6. `main-horizontal` layout → always splits parent → down (unaffected)
7. Closing a non-agent-area pane does NOT clear `agentAreaPaneId`

## Documentation

Update `docs/multiplexer-integration.md`:
- Clarify Herdr `main-vertical` now stacks agents vertically in a right column
- Parent OpenCode pane stays dominant
- Note any limitations (no exact main-pane-width sizing like tmux)

## Verification

- `bun test src/multiplexer/herdr/index.test.ts` — all tests pass
- `bun run typecheck` — no type errors
- `bun run check:ci` — lint/format clean
