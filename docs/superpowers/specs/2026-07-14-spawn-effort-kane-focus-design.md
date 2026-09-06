---
status: stable
---

# Spawn Effort + Kane Spawn Flags + Focus Discipline — design

**Date:** 2026-07-14
**Goal:** Five ergonomics upgrades: an Effort dropdown beside the Model dropdown (incl.
ultracode); Kane's `cos-coord spawn` accepts `--model`/`--effort`; typing in Kane no longer
loses focus when a terminal finishes; manual tile navigation holds the spotlight for 30 s;
Alt+K opens/focuses Kane.

## Context

- The model dropdown shipped in `6ec5dba`: `SPAWN_MODELS` (`terminals-grid.ts:47`),
  `modelSel` (`:153`), threaded `play → spawnWorktree → makeTile → TerminalTileOpts.model`,
  emitted as `--model <v>` (`terminal-tile.ts:458`), persisted in `SessionRecord.model`.
- The `claude` CLI supports `--effort <low|medium|high|xhigh|max|ultracode>`; `ultracode`
  is accepted from CLI v2.1.205 (machine runs 2.1.207). The local `--help` text lists only
  five values (stale); implementation empirically verifies `ultracode` is accepted before
  relying on it (see Testing).
- Kane (GodConsole) is invisible to the grid's focus system: `autoCenter()`
  (`terminals-grid.ts:856`) runs on every ready event AND a 1 s timer, and
  `decideCenter`'s only "don't yank" signal is `userTyping = q.composingLen > 0`, which
  only grid tiles feed. `focusCentered()` (`:779`) then steals real DOM focus.
- The menu yank-back (screenshot bug): user clicks away from a tile showing a selection
  menu; on the next `autoCenter()` pass the menu tile outranks the clicked idle tile
  (`NEED: menu=1 < idle=3`, `focus-decider.ts:23`) and drags the spotlight back.

## 1. Effort dropdown

- `god.ts` exports the single source of truth:
  `export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;`
- `terminals-grid.ts`: `SPAWN_EFFORTS` built from it (`Effort: Default` with value `''`,
  then capitalized labels — `Low … Max`, `Ultracode`); `effortSel` `<select>` created
  immediately after `modelSel`, title "Effort for new terminals".
- Threading mirrors `model` exactly: `spawnWorktree` opts gain `effort?`,
  `makeTile(..., effort?)`, `TerminalTileOpts.effort?`, `startSession` pushes
  `--effort <v>` when set, `sessionRecord()` + `SessionRecord.effort` persist it, restore
  passes it back.
- **Dropdown fallback moves into `spawnWorktree`**: when `opts.model`/`opts.effort` are
  undefined it reads `this.modelSel`/`this.effortSel` (empty string → no flag). `play()`
  passes `{}`; Kane/remote spawns get the same inheritance for free, and explicit values
  always win.

## 2. Kane spawn: `--model` and `--effort`

- `coord-cli.cjs` spawn branch: parse `--model`, `--effort` via the existing `flag()`;
  pass to `store.spawn(dir, repo, base, task, model, effort)`. Usage line updated.
- `coord-store.cjs` `spawn()`: outbox JSON gains `model: model || null`,
  `effort: effort || null`.
- `god.ts` `OutboxMessage` spawn variant gains `model: string | null` and
  `effort: string | null`; `parseOutboxMessage` reads them (non-string/empty → null,
  effort lowercased, otherwise passed through raw — validation happens at dispatch so
  Kane gets feedback).
- `terminals-grid.ts` `spawnFromKane(repo, base, task, model, effort)`: if `effort` is
  non-null and not in `EFFORT_LEVELS`, write a god-inbox error naming the valid values
  (mirror of the unknown-repo error) and do NOT spawn. Model strings pass through
  verbatim — the CLI accepts aliases (`opus`, `sonnet`, `haiku`, `fable`) and full ids,
  and validates itself. `spawnFromName` gains optional `model`/`effort` params (its other
  caller, the phone remote in `app.ts`, is unchanged and inherits dropdowns via the
  `spawnWorktree` fallback).
- Kane's system prompt (`god.ts:110`) documents the flags:
  `cos-coord spawn "<repo>" --base "<branch>" --task "…" [--model <alias-or-id>] [--effort low|medium|high|xhigh|max|ultracode]`
  plus one line saying omitted flags inherit the user's toolbar dropdowns.
- Back-compat: old outbox JSONs (no model/effort) parse to nulls → dropdown inheritance.

## 3. Kane focus fix (typing in Kane is never interrupted)

- `GodConsoleOpts` gains `onFocusChange?: (focused: boolean) => void`; `render()` wires
  `focusin`/`focusout` on the panel root (same pattern as `terminal-tile.ts:184-185`).
- `TerminalsGrid` tracks `private focusedKane: GodConsole | null` — the instance (primary
  or duplicate) that holds keyboard focus — set by each console's callback.
- `autoCenter()` passes `userTyping: this.q.composingLen > 0 || this.focusedKane !== null` — Kane
  holding focus now rides the same tested "mid-type → hold" rule in `decideCenter`
  (`focus-decider.ts:38`). No layout yank, no focus steal, ready-stack state unaffected
  (the ready tile still gets the spotlight once Kane is blurred).
- Window-refocus handler becomes: if `focusedKane` → `focusedKane.focus()`, else
  `focusCentered()` (OS blur doesn't fire `focusout` inside the document, so the flag
  survives alt-tab and restores correctly).
- Hiding Kane naturally fires `focusout` → flag clears.

## 4. Manual-switch hold (30 s)

- `MANUAL_HOLD_MS = 30_000` module const; `private holdUntil = 0` on the grid.
- **Set** (now + 30 s) by explicit tile choice:
  - `handleClick()` (`:453`) — covers both real clicks and Alt+F-key/letter jumps;
  - `showTile()` (`:927`) — resurfacing a hidden tile is an explicit choice too.
- **Cleared** (0):
  - `cycleSpotlight()` (`:289`) — Alt+←/→ means "back in the flow" (its existing
    rqClick pin stays as-is);
  - `handleSubmit()` (`:894`) — after the menu-toggle early-return (an Enter inside a
    menu is still interacting), right before `rqSubmit`: submitting a prompt ends the
    manual engagement.
- **Enforced**: `autoCenter()` first line — `if (Date.now() < this.holdUntil) return;`.
  This covers every auto path (ready events, the 1 s spotlight timer) and therefore kills
  the menu yank-back. Manual actions bypass it by construction (they don't go through
  `autoCenter`). Locks are unaffected and stronger: global lock and per-tile lock behave
  exactly as today.

## 5. Alt+K → Kane

- In `installKeyboard()` (`:299`), after the Alt+L branch and BEFORE the `keyToIndex`
  letter mapping: Alt+K → `preventDefault()` + `openKane()`. (Letter-badge jumps only
  reach 'K' with 23+ visible tiles; Kane wins that key. Code comment notes it.)
- `private openKane()`: no console yet → `toggleGod()` (creates + shows + focuses);
  hidden → `showGod()` (its `setVisible(true)` already focuses); visible →
  `godConsole.focus()`. Never toggles closed.
- Kane button title gains "(Alt+K)".

## 6. Kane names terminals (`--name` at spawn + `rename` verb)

- `cos-coord spawn` gains optional `--name "<terminal name>"`: rides the same pipeline
  (cli flag → outbox `name: string|null` → parse → `spawnWorktree` opts.name →
  `makeTile`'s existing name parameter). The name persists via the existing
  displayName/sessionRecord path.
- New god-only verb: `cos-coord rename "<exact terminal name>" --to "<new name>"` →
  outbox `{ kind: 'rename', target, name }` → dispatch resolves via `resolveTellTarget`
  and calls `TerminalTile.setName(name)` (`terminal-tile.ts:405` — fires `onRename`, so
  the grid persists it). Target not found or a journal tile → god-inbox error.
- Kane's system prompt documents both.
- Renaming retargets any active watchers registered on the old name (`remapWatchers`), so
  a rename can never strand a watch.

## 7. Duplicate Kane (multiple consoles)

- New topbar button `🜲+` right after the Kane button: each click docks ANOTHER Kane
  panel beside the existing one(s) — a fully separate `claude` session.
- Primary Kane is untouched (Kane button toggle, Alt+K, `godVisible` semantics).
  Duplicates live in `extraKanes: GodConsole[]` with a monotonic sequence (`Kane 2`,
  `Kane 3`, …; a grid-level counter, so closing one never reuses a live number):
  - own home dir `.god/<group>-<n>` → separate conversation; home dirs are reused
    across app restarts (harmless — duplicates start fresh sessions anyway);
  - `GodConsoleOpts` gains `instanceName?: string` (default `'Kane'`) and
    `terminalId?: string` (default `'0'`; duplicates get `String(-n)`) — used for the
    head label, `COS_TERMINAL_NAME`/`COS_TERMINAL_ID`, and the session-ended line;
  - the × on a duplicate disposes it entirely (session killed, panel removed);
    duplicates are NOT persisted across app restarts;
  - `notify()` broadcasts to primary + all duplicates (watch pings, personality
    injections, pulses) — they share the god role and any of them may have registered
    the watch;
  - every instance reports into `focusedKane` (the instance with focus; `focusout` fires
    before the next `focusin`, so the last writer wins correctly), and `GodConsole.dispose()`
    clears it explicitly — removing a focused element fires no `focusout`;
  - creating a duplicate also `startFloorFeed()`s (outbox + floor snapshots are shared).

## 8. Kane panel resize (drag the left edge)

- `.cos-god-panel` is a fixed flex column (`flex:0 0 380px`, `styles.css:854`). Every
  Kane panel gets a 6 px left-edge grip (`.cos-god-resize`, `cursor: ew-resize`; the
  panel gains `position:relative`).
- Drag: `pointerdown` on the grip captures the pointer (`setPointerCapture`), so move/up events keep arriving even when the button is released outside the window — no document-level listeners to leak; new width =
  startWidth + (startX − clientX) (panels dock on the right), clamped to
  [280 px, 70 % of the window], applied as `flex: 0 0 <px>px`. The body's existing
  `ResizeObserver` refits xterm live during the drag.
- On mouseup the width persists to `localStorage['cos-god-width']` and is applied to
  every Kane panel at render (one shared width, not per-instance).

## Error handling

- Invalid `--effort` from Kane → god-inbox error listing valid values; no spawn.
- Invalid `--model` from Kane → passed through; the spawned tile surfaces the CLI's own
  error (visible, recoverable by closing the tile).
- Missing selects (grid not mounted) → optional-chaining fallbacks yield undefined → no
  flags (CLI defaults), same as today.
- `onFocusChange` absent (other GodConsole embeddings) → optional, no-op.
- `rename` target not found or a journal tile → god-inbox error, nothing renamed.
- Blank `--name`/`--to` values → treated as absent (spawn proceeds unnamed; rename is
  dropped by the CLI before reaching the outbox).

## Testing

- `tests/god.test.ts`: `EFFORT_LEVELS` content; spawn parse with model/effort
  (present / absent / non-string / empty → null; effort lowercased); prompt mentions
  `--model` and `--effort`.
- `tests/coord-cli.test.ts`: `spawn` with `--model`/`--effort` lands both in the outbox
  JSON; omitted flags → nulls.
- `tests/coord-store.test.ts`: `spawn()` writes `model`/`effort` fields.
- CLI acceptance check (implementation-time, no app launch): `claude --effort bogus -p x`
  must reject locally listing valid values; confirm `ultracode` is among them (or, if the
  CLI doesn't validate locally, one minimal `-p` call with `--effort ultracode` must
  succeed). If ultracode is NOT accepted, drop it from `EFFORT_LEVELS` and note it — the
  rest of the feature stands.
- Name/rename coverage: parse tests for spawn `name` and the `rename` message
  (`tests/god.test.ts`), CLI tests for `spawn --name` and the `rename` verb
  (`tests/coord-cli.test.ts`), store test for the new outbox fields
  (`tests/coord-store.test.ts`).
- Grid/DOM behaviors (dropdowns, hold timing, Kane focus, Alt+K, duplicate Kanes,
  drag-resize) are manually verified by the user later — nothing in implementation or
  verification may launch the app (standing constraint).
- Full vitest suite stays green.

## Non-goals

- No per-tile model/effort editing after spawn (close and respawn).
- No persistence of the dropdowns' own selections across app restarts (matches the model
  dropdown's current behavior).
- No configurable hold duration; 30 s constant.
- Duplicate Kanes are not persisted across app restarts; no per-duplicate width memory
  (one shared width).
- No rename of Kane consoles themselves; `rename` targets worker terminals only.
