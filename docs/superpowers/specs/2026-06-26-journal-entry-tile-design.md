---
status: stable
---

# Journal Entry Tile — Design (Phase 1: core)

> Status: approved design, pre-implementation. Date: 2026-06-26.
> Scope: **Phase 1 of 3.** Phase 2 = Format; Phase 3 = Convert to Linear (sketched in §8, not specced here).

## 1. Goal

A note-taking surface that lives in the terminal stage like a terminal, but holds free-form
notes instead of a Claude session. Spawned from a top-bar **Journal Entry** button (which
replaces the terminal filter box). Notes are named (renamable like terminals), saved to disk,
browsable / editable / deletable via a History view, and the tile carries the same chrome as a
terminal: **lock**, **minimize → Coordination**, **close**.

## 2. Decisions (locked)

| Decision | Choice |
| --- | --- |
| Top-bar entry | Replace the `🔍 filter terminals` search input with a `📓 Journal Entry` button. The filter feature is removed. |
| Spawn | Click → a new blank journal tile in the stage (default name `Journal N`), like Play spawns a terminal. Multiple journals may be open at once. |
| Body | A monospace `<textarea>` (plain markdown text), not an xterm. |
| Persistence | One markdown file per journal at `<coordDir>/journals/<slug>.md`, plus `<coordDir>/journals/index.json` mapping `slug → { name, updated }`. |
| Save | Explicit **Save** writes / overwrites the doc under the tile's current name. Renaming the tile re-slugs on next save (old file removed). No autosave. |
| History | A **See History** toggle inside the tile body: editor ⇄ list of saved docs (name · last-saved). Row actions: **Open** (load into the editor), **✕ Delete** (with confirm). |
| Chrome | **🔒 Lock** · **– Minimize** (→ Coordination Hidden) · **× Close** — the same grid handlers terminals use. |
| Centering | Journals are static: they never auto-grab the spotlight; centered only by explicit click. |
| Restore | Journals persist in the session record and restore as journal tiles across app reloads. |

## 3. Architecture — units

### 3.1 `StageTile` interface — `src/terminals/stage-tile.ts` (new)

Extract the structural contract the grid already relies on so terminals and journals are
interchangeable in `tiles` / `hidden` / layout / lock / center:

```ts
export interface StageTile {
  readonly tileId: number;
  readonly name: string;
  readonly branch: string;     // journals: ''
  readonly repoName: string;   // journals: 'journal'
  readonly isJournal: boolean; // discriminator for terminal-only logic
  render(parent: HTMLElement): void;
  setRect(r: { x: number; y: number; w: number; h: number }): void;
  setCentered(on: boolean): void;
  setHidden(on: boolean): void;
  setLocked(on: boolean): void;
  setDimmed(on: boolean): void;
  setBadge(text: string | null): void;
  focus(): void;
  blur(): void;
  kill(): void;
  recentOutput(): string;      // journals: current text (spotlight only; journals classify static)
}
```

`TerminalTile` already satisfies the shape; add `isJournal = false`. `JournalTile` implements
it with `isJournal = true`.

### 3.2 `JournalTile` — `src/terminals/journal-tile.ts` (new)

- Constructor opts mirror the callback shape `TerminalTile` uses, so the grid wires it
  identically: `{ tileId, name, coordDir, slug?, initialText?, onClosed, onHide, onLock,
  onCenter, onRequestRename, onRename }`.
- `render`: a `.cos-term-tile.cos-journal-tile` with a `.cos-term-head` (name + 🔒/–/× cluster,
  same markup as `TerminalTile`) and a body that shows EITHER the editor
  (`<textarea class="cos-journal-text">`) or the History list.
- Footer `.cos-journal-actions`: **Save**, **See History**, plus disabled **Format** and
  **Convert to Linear** placeholders (wired in phases 2/3).
- `save()` → `JournalStore.save(slug, name, value)`; toast on success; clears the dirty flag.
- `toggleHistory()` → swaps the body between editor and the History list.
- Rename: double-click the name → `onRequestRename` (grid reuses `promptForTopic`) → updates
  display name + store.
- `recentOutput()` returns the textarea value; `setRect`/`setCentered`/`setHidden`/`setLocked`/
  `focus`/`blur`/`kill` mirror a tile (no session to kill — `kill` just removes DOM).
- Dirty tracking: `input` on the textarea sets `dirty = true`; `save()` clears it.

### 3.3 `JournalStore` — `src/terminals/journal-store.ts` (new)

IO over `<coordDir>/journals/`:

```ts
list(): Array<{ slug: string; name: string; updated: number }>   // from index.json, newest first
load(slug): { name: string; text: string } | null
save(slug, name, text): void   // writes <slug>.md + upserts index.json (updated = now passed in)
remove(slug): void             // deletes <slug>.md + index entry
slugify(name): string          // filesystem-safe, de-duped with a numeric suffix
```

The `.md` file holds the raw note text; `index.json` carries the display name + `updated` ms
(so spaces / renames survive). `now` is passed in by the caller (no `Date.now()` in pure code).

### 3.4 Grid wiring — `terminals-grid.ts`

- Retype `tiles` / `hidden` to `StageTile[]`. Guard terminal-only paths
  (`handleReady`, `handleSubmit`, `spotlightState`) with `if (t.isJournal) return/skip` so
  journals never enter `idleTiles` or the ready stack → `decideCenter` treats them as static
  (centered only on click, never auto-grabbing).
- New `spawnJournal()`: build a `JournalTile` with the grid callbacks (same set `makeTile`
  wires: `onClosed`/`onHide`/`onLock`/`onCenter`/`onRequestRename`/`onRename`), `render`, push
  to `tiles`, center it. Default name `Journal <n>`.
- Top bar: **remove** the `cos-search` input + its `input` listener (`searchQuery` /
  `refreshSearch` go dormant or are deleted) and add a `📓 Journal Entry` button → `spawnJournal()`.
- Lock (`lockedTileId`), center, layout, **minimize → Coordination** (the hidden list + the
  Show / ✕ just built), and **×** already operate by `tileId` on the array → they work for
  journals unchanged once the array is `StageTile[]`. The Coordination `hiddenProvider` already
  maps `name`/`branch`/`repo`, so hidden journals list correctly.
- Persistence: `SessionRecord` gains `kind?: 'terminal' | 'journal'` + `journalSlug?`.
  `restoreSessions` reconstructs journal tiles from their slug (loading text via `JournalStore`).

## 4. Visual (sketch)

```
top bar:  🌳 …   3 repos   [████▇ 28%] ⟳   📓 Journal Entry
          (filter box removed)

journal tile (editor):                 journal tile (history):
┌ Journal 1                  🔒 – × ┐   ┌ Journal 1 — History         🔒 – × ┐
│ - shipped pay bills                │   │ Journal 1        06-26 14:20 [open][✕]│
│   - pushed to dev                  │   │ standup notes    06-25 09:10 [open][✕]│
│ todo: fix the migrate   (textarea) │   │ …                                     │
│                                    │   │                                       │
├────────────────────────────────────┤   ├───────────────────────────────────────┤
│ [Save] [See History]  Format·Conv· │   │ [← Back]                              │
└────────────────────────────────────┘   └───────────────────────────────────────┘
```

## 5. Edge cases & risks

| Risk | Mitigation |
| --- | --- |
| Retyping `tiles → StageTile` breaks terminal-only call sites | Guard with `isJournal`; `tsc --noEmit` surfaces every site that assumed `TerminalTile`. |
| A journal stealing the spotlight | Journals never enter `idleTiles` / the ready stack → `spotlightState` classifies them static; only a click centers. |
| Duplicate / renamed slugs | `slugify` + de-dup with a numeric suffix; `index.json` is the source of truth for display names. |
| Unsaved text lost on `×` | `×` is "throw away" for terminals; for journals, **confirm if the textarea is dirty** since the last save (reuse `promptForConfirm`). |
| `<coordDir>/journals` missing | Store `mkdir`s on first save / list. |

## 6. Testing

- `tests/journal-store.test.ts` — `slugify`, save→load round-trip, index upsert + ordering,
  `remove`, rename re-slug (pure, over a temp dir passed in).
- `StageTile` retype verified by `tsc --noEmit`.
- Tile + grid wiring is DOM/IO — build + manual: spawn, type, Save, History open/delete, rename,
  lock / minimize / ×, reload-restore.

## 7. Out of scope (Phase 1)

- **Format** (Phase 2). **Convert to Linear** (Phase 3). Rich-text / markdown rendering (plain
  textarea only). Autosave. Full-text search within journals.

## 8. Phases 2 & 3 (sketch — separate specs)

- **Format:** spawn `claude -p` with the note + a "fix indentation / structure, preserve every
  word" prompt; show a before/after preview; apply or discard.
- **Convert to Linear:** spawn `claude` (inherits the `linear` MCP) with the note + a "split
  into 1..N Linear issues" instruction; render the proposed split as a preview; on **approve**,
  the same agent creates the issues and reports back links. One-or-many is the agent's call,
  shown for approval before anything is written.
