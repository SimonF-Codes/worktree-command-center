---
status: stable
---

# Hide / Resurface Terminals — Design

**Date:** 2026-06-07
**Status:** Approved, ready for implementation plan

## Problem

A terminal tile can only be removed via the `×` button, which is destructive: it
deletes the worktree **and** its branch. There is no way to declutter the stage by
temporarily removing a terminal you still want. Users need to **hide** a terminal —
get it off the visible stage while keeping its work intact — and **resurface** it
later from the Coordination panel.

## User-facing behavior

- Each terminal tile gets a **Hide** button in its header, positioned **left of the
  `×`** button.
- Hiding a terminal removes it from the visible stage but keeps its `claude` session,
  worktree, and branch **fully alive in the background** (the process keeps running;
  the xterm buffer keeps accumulating output).
- The **Coordination** panel (the existing `🛰 Coordination` collapsible, not a new
  tab) gains a **Hidden terminals** section: one row per hidden terminal showing its
  name and branch, each with a **Show** button.
- **Show** brings the terminal back onto the stage, **centered and focused**, with
  zero state loss (it is the same live session, re-attached).
- The `×` Close button is **unchanged** — it still confirms and then deletes the
  worktree + branch.

## Key decisions

1. **Hidden sessions keep running in the background.** Hiding does not kill or suspend
   the `claude` process; it only detaches the tile from the visible layout. Resurfacing
   re-attaches the existing live session. (Chosen over a suspend/`--continue` approach
   for zero state loss.)
2. **No attention indicator.** The Hidden list shows name + branch + Show only. A
   hidden session going "ready"/idle does not surface a marker. (Chosen for simplicity.)
3. **Hide control lives on the tile header**, left of `×`. The **Hidden list lives
   inside the existing Coordination panel**, not a separate tab.

## Architecture

Because layout, chat membership, badges, and the ready-queue all iterate
`TerminalsGrid.tiles`, the cleanest model is a **separate `hidden` array**. Moving a
tile out of `this.tiles` excludes it from all of those paths for free, while its DOM
node (kept in the stage but `display:none`) and session stay alive.

### 1. `src/terminals/terminal-tile.ts`

- Add `onHide?: (tile: TerminalTile) => void` to `TerminalTileOpts`.
- Add a **Hide** button in the header, inserted **before** the `×` button. Clicking it
  calls `this.opts.onHide?.(this)` and stops propagation (so it does not also center
  the tile).
- Add `setHidden(on: boolean): void` that toggles `this.el.style.display` between
  `'none'` and `''`. The session, bridge, and xterm are untouched, so output keeps
  buffering while hidden. On show, trigger a refit (`fitSoon()`) so the terminal
  resizes to the stage after being `display:none`.

### 2. `src/terminals/terminals-grid.ts`

- New field: `private hidden: TerminalTile[] = [];`
- `hideTile(tile: TerminalTile): void`
  - Remove from `this.tiles`, push to `this.hidden`.
  - `tile.setHidden(true)`.
  - Drop it from the ready-queue (reuse `rqClose`, honoring whether it was centered) so
    it is no longer a centering target.
  - `tile.setSelected(false)` and `updateChatBtn()` (a hidden tile is never a chat
    member).
  - If it was the centered tile, center the ready-queue's next pick (or clear
    `centeredId`); otherwise just `applyLayout()`.
  - `persist()`, then `board.refresh()`.
- `showTile(tileId: number): void`
  - Find in `this.hidden`, remove, push to `this.tiles`.
  - `tile.setHidden(false)`.
  - `centeredId = tileId`, `applyLayout()`, `focusCentered()` (which refits via
    `setRect`).
  - `persist()`, then `board.refresh()`.
- `makeTile(...)`: wire `onHide: (t) => this.hideTile(t)`.
- `handleReady` / `handleSubmit`: **guard** — if the tile is in `this.hidden`, return
  early without centering (a background session must never steal the stage).
- `persist()`: write `[...visible (hidden:false), ...hidden (hidden:true)]`.
- `restoreSessions()`: partition persisted records into visible vs. hidden. Render
  both (sessions spawn via `--continue` as today), but call `setHidden(true)` on the
  hidden ones and place them in `this.hidden` instead of `this.tiles`.
- `scanWorktrees()`: when resolving a worktree's owning terminal name, look in **both**
  `this.tiles` and `this.hidden` so a hidden terminal still shows ownership in the
  registry.
- `dispose()` and `parkAll()`: include `this.hidden` (kill / park those tiles too).
- Provide a `hiddenProvider()` to `BoardView` returning
  `{ tileId, name, branch }` for each hidden tile, and an `onShow(tileId)` that calls
  `showTile`.

### 3. `src/terminals/board-view.ts`

- Constructor gains `hiddenProvider: () => Array<{ tileId: number; name: string; branch: string }>`
  (default `() => []`) and `onShow: (tileId: number) => void` (default no-op).
- `renderAll()` renders a **Hidden terminals** subsection (above the registry section).
  Each row: name + branch + a **Show** button whose click calls `onShow(tileId)` and
  stops propagation. When there are no hidden terminals, the section is omitted (or
  shows nothing).
- The section refreshes on the existing poll timer; hide/show also call `refresh()`
  for immediate feedback.

### 4. `SessionRecord`

- Add `hidden?: boolean`. Absent/false = visible (back-compatible with existing
  persisted files).

## Data flow

```
[Tile header: Hide]
      │ onHide
      ▼
TerminalsGrid.hideTile  ── move tiles→hidden, setHidden(true), rqClose, persist
      │
      ├─► applyLayout()        (hidden tile no longer laid out)
      └─► board.refresh()
                 │ hiddenProvider()
                 ▼
        BoardView Hidden section  ──[Show]──► onShow(tileId)
                                                  │
                                                  ▼
                                   TerminalsGrid.showTile ── move hidden→tiles,
                                   setHidden(false), center+focus, persist, refresh
```

## Edge cases

- **Hiding the centered tile** → ready-queue picks the next center (via `rqClose` with
  `wasCentered=true`); if none remain, `centeredId` clears and the stage empties.
- **Hiding the last visible tile** → stage shows nothing; all work is in the Hidden list.
- **Show** always centers and focuses the resurfaced tile.
- **A hidden tile going "ready"** does not center (guarded in `handleReady`).
- **Chat** never includes hidden tiles (not in `this.tiles`); a selected tile being
  hidden clears its selection first.
- **App restart** restores hidden tiles off-stage (live session via `--continue`,
  `display:none`); same process count as today.

## Testing

- Most wiring is DOM/session-bound and is verified by running the app (`/run`):
  hide a tile, confirm it leaves the stage and appears in the Coordination Hidden
  list, Show it, confirm it returns centered with its conversation intact; confirm
  `×` still deletes.
- Extract and **unit-test the one pure piece**: partitioning persisted
  `SessionRecord[]` into visible vs. hidden on restore (a small pure helper), so the
  restore branch is covered without a live session.
