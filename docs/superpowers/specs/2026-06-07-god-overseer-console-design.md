---
status: stable
---

# GOD Overseer Console — Design

> Status: approved design, pre-implementation. Date: 2026-06-07.

## 1. Goal

Add **GOD** — a privileged, always-available Claude session docked in a side console
beside the bubbling terminal stage. GOD has full tools and full visibility into the floor
(live terminal output + the coordination board + the worktree/git registry), and can act
on the floor when asked (run git, edit files, nudge a worker).

GOD is **not** an autonomous orchestrator. Unlike the "GOD" agent in the `munder-difflin`
project that inspired this, GOD here does **not** run the floor. The user stays in the
driver's seat and keeps talking to the individual worker terminals directly. GOD is the
agent you *turn to* on demand — "what's everyone doing?", "why is tile 3 stuck?", "go help
with X" — who can see everything and act when you tell him to.

The existing agent-to-agent group chat (`ChatRoom` / `ChatTile`) is a separate feature and
is left **untouched**. GOD is a new, independent surface.

## 2. Decisions (locked)

| Decision | Choice |
| --- | --- |
| What GOD is | A real `claude` session (full intelligence + tools), not app-code logic |
| GOD vs group chat | A new, separate panel; group chat unchanged |
| GOD's role | Overseer the user consults on demand — does **not** autonomously run the floor |
| GOD's visibility | Live terminal output + `board.md` + worktree/git registry (NOT the group-chat transcript) |
| GOD's capability | Full agent: can run git, edit files, push messages to workers |
| How live output reaches GOD | App writes terminal snapshots to disk; GOD reads them with native tools |
| UI surface | Docked side console (fixed panel beside the stage), toggled by a button |
| Persistence (v1) | Fresh each run — no `--continue` (clean follow-up) |
| Permissions | GOD runs **without** `--dangerously-skip-permissions`; destructive ops prompt in his own console (HITL gate) |

## 3. Architecture

GOD is three cooperating parts: a **session**, a **floor snapshot writer**, and a
**GOD→worker delivery channel**. All three reuse patterns already in the codebase.

### 3.1 The GOD session (`GodConsole`)

A new class `src/terminals/god-console.ts` that wraps a real `claude` process using the
same `SessionBridge` + xterm wiring `TerminalTile` uses, **minus all worktree lifecycle**
(no branch, no worktree, no delete-on-close, no `sessionRecord`).

- **Working directory:** a neutral home dir `userData/.god/<group>/` (e.g.
  `.../.god/default/`), created on first spawn. Repos come from arbitrarily-added folders,
  so there is no single workspace root — GOD `cd`s into a repo to act on it. His home dir
  is outside every repo so his own scratch files never dirty a worktree.
- **Spawn env** (mirrors a worker tile so `cos-coord` works):
  - `COS_COORD_DIR` = the group's coordination dir
  - `COS_TERMINAL_NAME` = `GOD`
  - `COS_TERMINAL_ID` = `0` (reserved; worker tiles start at 1)
  - `COS_ROLE` = `god` (gates the new `cos-coord tell` command — see §3.3)
  - `PATH` prefixed with the sidecar dir (so `cos-coord` is callable)
- **Args:** none for v1 (no `--continue`). **Not** `--dangerously-skip-permissions` — GOD
  is a normal permissioned Claude, so destructive actions surface an approval prompt in his
  own console for the user to approve. That is the human-in-the-loop gate.
- **System prompt** via `--append-system-prompt-file` (written to GOD's home, like
  `terminal-tile.ts` writes per-tile context files). Content produced by a pure
  `godSystemPrompt(repos, coordDir)` helper (§3.4), establishing:
  - Identity & stance: you are GOD, the overseer; the **user drives** and talks to the
    workers directly. You do **not** run the floor or initiate work on your own. Be
    available, answer the user's questions about the floor, and act only when asked.
  - Visibility: read the floor at `<coordDir>/floor/INDEX.md` and `<coordDir>/floor/*.md`
    (per-terminal recent output), `<coordDir>/board.md` (locks / activity), and
    `<coordDir>/worktrees.md` (branches, dirty/unpushed, parked work).
  - Acting: you have full tools. To act on a repo, `cd` into its path (listed below) — do
    **not** edit a primary checkout; create a worktree if you need to change code, the same
    rule worker tiles follow. To send a message into a worker terminal, run
    `cos-coord tell "<exact terminal name>" "<message>"` (names come from `floor/INDEX.md`).
  - The repo list with names + absolute paths.

### 3.2 Floor snapshot writer (in `TerminalsGrid`)

The grid already holds every `TerminalTile` and each tile already exposes
`recentOutput()` (last ~20 non-blank lines — used today for prompt detection). So the
snapshot is essentially free:

- New method `writeFloorSnapshot()`:
  - Ensures `coordDir/floor/` exists.
  - For each live tile, writes `coordDir/floor/<tileId>-<slug(name)>.md` with a short
    header (terminal name, repo, branch, worktree path, ISO timestamp) followed by the
    tile's `recentOutput()`. Formatting is produced by a pure `formatFloorSnapshot(meta,
    output)` helper (§3.4) so it is unit-testable.
  - Writes `coordDir/floor/INDEX.md` — the roster of live terminals (id, name, repo,
    branch) so GOD has one file to learn the exact names to address.
  - Prunes snapshot files for tiles that have closed (so GOD never reads a stale ghost).
- **Cadence:** a dedicated `floorTimer` running ~every 4s, started **only when the GOD
  console is open** and stopped when it closes. No snapshots are written when GOD isn't
  around. `board.md` and `worktrees.md` already exist on their own cadences.
- Staleness is bounded by the timer interval (~4s) — fine for "what is tile 3 doing." If
  it ever feels laggy, the follow-up `cos-coord peek` (§7) forces an on-demand fresh dump.

### 3.3 GOD→worker delivery channel

Extends the existing `cos-coord` CLI (the file-drop pattern workers already use):

- **New command** `cos-coord tell <target> <message...>` in `coord-cli.cjs`:
  - No-op (exit 0) unless `COS_ROLE === 'god'` — only GOD may inject into worker terminals.
    (Workers still talk to each other via the separate group chat, not this.)
  - Writes one **atomic** JSON file (temp file + `rename`) to `coordDir/god-outbox/`:
    `{ ts, target, message }`. One file per message — never a co-edited shared file.
  - Implemented in `coord-store.cjs` as `tell(dir, target, message)` (mirrors `appendChat`).
- **Delivery (in `TerminalsGrid`):** extend the existing `coordWatcher` (or a sibling
  watcher) to drain `coordDir/god-outbox/`:
  - On a new file: parse with pure `parseTellRequest(json)`; resolve `target`→tile via pure
    `resolveTellTarget(target, tileNames)` (exact name match, case-insensitive fallback).
  - If resolved and the tile is alive: `tile.sendLine(message)` (the same submit path the
    chat relay uses — text then a separated `\r`).
  - Move the processed file to `coordDir/god-outbox/.done/` (audit, idempotent).
  - Unknown/dead target: write `coordDir/god-inbox/<ts>-error.md` describing the failure
    and the valid names, which GOD can read back. (GOD's prompt tells him to check.)

### 3.4 Pure helpers (`src/terminals/god.ts`)

Factored out so the logic is unit-testable without Electron/PTY, exactly as `chat-room.ts`
factored `planDeliveries` / `tail` / `looksLikePrompt`:

- `godSystemPrompt(repos: RepoConfig[], coordDir: string): string`
- `formatFloorSnapshot(meta, output): string` and `formatFloorIndex(tiles): string`
- `parseTellRequest(text: string): { target: string; message: string } | null`
- `resolveTellTarget(target: string, names: string[]): string | null`
- `slug(name: string): string` (safe filename) — or reuse the existing coord slug.

## 4. UI — docked console

- A **🜲 GOD** toggle button is added to the controls bar in `TerminalsGrid.mount()`,
  alongside the existing `💬 Chat` / `⊕ Select` buttons.
- The stage region becomes a flex row: `[ cos-terminals-stage ][ cos-god-panel ]`. When GOD
  is open, the god panel takes a fixed width (~380px) and the stage shrinks to fill the
  rest. Because the bubble layout already derives from `stageEl.clientWidth/clientHeight`,
  shrinking the stage element makes the tiles **auto-reflow** — calling `applyLayout()`
  after the toggle is all that's needed; no new layout math.
- The god panel is a **real terminal** (GOD's xterm). The user types directly into it like
  any tile — there is no separate chat input box (this is a "real claude terminal," per the
  chosen design).
- Header: `🜲 GOD` label + a `×` that **hides** the panel but keeps the session alive
  (re-opening is instant). Toggling the button again re-shows the same live session.
- **Focus handling:** clicking the panel focuses GOD's terminal; the grid's existing
  `focusCentered()` / per-tile `blur()` discipline must treat the god terminal as a
  focusable target so a stray keystroke never lands on a worker tile (same concern the
  chat tile already handles).
- **Lifecycle:** survives tab-switch unmount the way tiles/sidecars do (kept in memory,
  re-attached on re-mount). Full teardown (`dispose()`) kills the GOD session too. Fresh
  each app run (no `--continue` in v1).

## 5. Edge cases & risks

| Risk | Mitigation |
| --- | --- |
| **`coordWatcher` rescan loop** — it re-scans worktrees on any `coordDir` change except `worktrees.md`; writing into `floor/` and `god-outbox/` would loop it | Extend the watcher's ignore filter to skip the `floor/` and `god-outbox/` subdirs (`terminals-grid.ts:127`) |
| Partial reads of an outbox message | Atomic temp-file + `rename`; one file per message |
| Reprocessing a delivered message | Move processed files to `god-outbox/.done/` |
| GOD addresses a non-existent / dead tile | `resolveTellTarget` returns null → error file in `god-inbox/`; prompt tells GOD to re-read `floor/INDEX.md` |
| `recentOutput()` is only ~20 lines | Enough for "what is it doing"; deeper history is a follow-up (larger buffer dump / `peek`) |
| GOD dirtying a repo's primary checkout | Prompt enforces the existing worktree rule; GOD's home cwd is outside all repos |
| Snapshot disk churn | Timer runs only while the console is open |

## 6. Testing

Mirror the existing pure-function test style (`tests/*.test.ts`, e.g. `chat-room.test.ts`,
`coord-store.test.ts`):

- **`tests/god.test.ts`** — `parseTellRequest` (valid/garbage/missing fields),
  `resolveTellTarget` (exact, case-insensitive, miss), `formatFloorSnapshot` /
  `formatFloorIndex` (header + body shape), `godSystemPrompt` (contains repo paths, the
  coord paths, the `cos-coord tell` instruction, and the "user drives / do not run the
  floor" stance).
- **Extend `tests/coord-store.test.ts` / `tests/coord-cli.test.ts`** — `tell` writes a
  well-formed atomic file under `god-outbox/`; the CLI no-ops without `COS_ROLE=god`.
- Manual / integration (documented, not automated): open the console with ≥2 worker tiles,
  confirm GOD can summarize the floor from the snapshot files, and that
  `cos-coord tell "<name>" "..."` lands a line in the right worker terminal.

## 7. Out of scope (v1) — clean follow-ups

- Persisting GOD's conversation across app restarts (`--continue` + a session record).
- `cos-coord peek <tile>` for live on-demand output (needs an IPC channel from the sidecar
  process back into the renderer; snapshots-to-disk is the v1 baseline).
- Panel resize-drag and remembered width.
- Multiple / per-repo GOD instances.
- Larger scrollback dumps than `recentOutput()`'s ~20 lines.
