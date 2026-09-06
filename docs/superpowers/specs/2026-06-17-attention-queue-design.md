---
status: stable
---

# Attention Queue — Design

> Status: approved design, pre-implementation. Date: 2026-06-17.

## 1. Goal

One in-app "which terminals need me" surface: a topbar badge `⚠ N` + dropdown that lists
terminals waiting on a permission prompt, a selection menu, that look errored, or that are
idle/done — click a row to jump to that terminal. Replaces the now-gone chat input-cards as the
attention surface across many parallel sessions.

## 2. Decisions (locked)

| Decision | Choice |
| --- | --- |
| States surfaced | permission prompt, selection menu, errored, idle/finished |
| Badge count `N` | **action-needed only** (prompt + menu + errored). Idle/done are listed but do NOT inflate `N` (otherwise it's always noisy). |
| Badge color | red if any prompt/menu; amber if only errored; neutral when none. |
| Placement | topbar badge + click-dropdown (same pattern as the usage battery). |
| Click a row | jump to that terminal: center + focus; if it's a hidden/background tile, un-hide it first. |
| Detection | renderer-side, free: `looksLikePrompt` / `looksLikeMenu` / new `looksErrored`, plus an `idle` flag from the ready signal. Recomputed on a ~1.5s poll. |
| Priority order | prompt > menu > errored > idle. |

## 3. Architecture — units

### 3.1 `looksErrored(output)` — pure (`src/terminals/prompt-detect.ts`)

Best-effort error sniff over recent output:

```ts
export function looksErrored(output: string): boolean;
```

Matches common failure markers — `error`, `exception`, `traceback`, `fatal`, `✗`, `failed`,
`command not found`, a non-zero `exit code N` — case-insensitive. Explicitly fuzzy; false
positives are acceptable (it only nudges, never blocks). Does NOT fire on an empty string.

### 3.2 `classifyAttention(tiles)` — pure (`src/terminals/attention.ts`)

```ts
export type AttentionState = 'prompt' | 'menu' | 'errored' | 'idle';
export interface AttentionInput { id: number; name: string; repo: string; output: string; idle: boolean; }
export interface AttentionItem { id: number; name: string; repo: string; state: AttentionState; }

/** Classify each tile by precedence prompt > menu > errored > idle; drop tiles that are
 *  none of these (busy, nothing to flag). Sorted by that precedence, then by id. */
export function classifyAttention(tiles: AttentionInput[]): AttentionItem[];

/** How many items count toward the badge (prompt + menu + errored; idle excluded). */
export function actionCount(items: AttentionItem[]): number;
```

Composition: `looksLikePrompt(output)` → `prompt`; else `looksLikeMenu(output)` → `menu`; else
`looksErrored(output)` → `errored`; else `idle === true` → `idle`; else omitted. Importing
`looksLikePrompt` from `chat-room.ts` and `looksLikeMenu`/`looksErrored` from `prompt-detect.ts`.

### 3.3 Grid wiring (`terminals-grid.ts`)

- **Idle tracking:** `private idleTiles = new Set<number>()`. In `handleReady(t)` add `t.tileId`;
  in `handleSubmit(t)` and `onInput` for a tile, delete it (it's busy again). Hidden tiles can
  also be idle, so the set spans both lists.
- **Provider:** `attentionItems(): AttentionItem[]` — build `AttentionInput[]` from
  `allSessions()` (`{ id, name: t.name, repo: this.repoNameFor(t), output: t.recentOutput(), idle: this.idleTiles.has(t.tileId) }`) and return `classifyAttention(...)`.
- **Reveal:** `revealTile(id)` — if the id is a hidden tile → `showTile(id)`; else `doCenter(id)`
  then `focusCentered()`. (Both already exist.)

### 3.4 `AttentionWidget` (`src/ui/attention-widget.ts`)

- `constructor(provider: () => AttentionItem[], onReveal: (id: number) => void)`.
- `render(parent)`: a `⚠ N` button (the badge) + a hidden dropdown panel.
- A ~1.5s poll recomputes `provider()`; updates the badge text to `actionCount(items)` (hidden/0
  when none) and its color class (`crit` if any prompt/menu, `warn` if only errored, else none).
- Click the badge → toggle the dropdown, rebuilt from the latest items, grouped **Needs input /
  Errored / Idle · done**; each row: state icon · name · repo pill · state label; click row →
  `onReveal(id)` + close. Outside-click closes. The poll also live-updates an open dropdown.

### 3.5 Wiring (`app.ts`)

After the usage widget in the topbar: `new AttentionWidget(() => grid.attentionItems(), (id) => grid.revealTile(id)).render(topBar)`. `grid.attentionItems` / `grid.revealTile` are new public methods. Stop the widget's poll on `beforeunload`.

## 4. Visual

```
🌳 …   3 repos   [████▇ 28%] ⟳        ⚠ 2 ▾
                                   ┌──────────────────────────┐
                                   │ NEEDS INPUT              │
                                   │ ⏳ Improver 1  ‹app› prompt│
                                   │ ❖ daria        ‹pp›  menu │
                                   │ ERRORED                 │
                                   │ ⚠ CJ43-44     ‹fe›  error│
                                   │ IDLE · DONE             │
                                   │ ✓ Live Research ‹app› idle│
                                   └──────────────────────────┘
```

## 5. Edge cases & risks

| Risk | Mitigation |
| --- | --- |
| Idle noise dominating the badge | Idle excluded from `N`; listed muted at the bottom only. |
| `looksErrored` false positives | Fuzzy by design; it's a nudge, lands in its own group, never blocks. A terminal on a prompt/menu is classified there first (precedence), so an error line under a prompt still reads as "prompt". |
| Stale idle flag | Cleared on submit/input; recomputed each poll. Worst case a just-finished tile shows idle briefly after you start typing — harmless. |
| Revealing a hidden tile | `revealTile` routes hidden ids through `showTile` (un-hide + center) and visible ids through `doCenter`. |
| Empty queue | Badge hidden (or shows nothing); dropdown shows "nothing needs you". |
| Poll cost | Pure `recentOutput()` scrape of ≤N tiles every 1.5s — renderer-only, no tokens, negligible. |

## 6. Testing

- **`tests/prompt-detect.test.ts`** (extend) — `looksErrored`: fires on `Traceback (most recent…)`,
  `Error: ENOENT`, `✗ 3 failed`, `command not found`; does NOT fire on normal output or `''`.
- **`tests/attention.test.ts`** — `classifyAttention`: precedence (a tile whose output is both a
  prompt and has an error → `prompt`); idle tile with clean output → `idle`; busy tile (not idle,
  no markers) → omitted; sort order prompt→menu→errored→idle. `actionCount` excludes idle.
- Widget + grid wiring are DOM/IO — verified by build + manual (badge count, click-to-jump,
  hidden-tile reveal).

## 7. Out of scope (v1)

- Desktop/OS notifications (the AHK popup already covers external alerting).
- "Acknowledge / since last looked" tracking (idle reflects current state, not unread).
- Configurable which states count toward the badge.
- Sound.
