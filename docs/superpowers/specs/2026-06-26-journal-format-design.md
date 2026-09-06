---
status: stable
---

# Journal Format — Design (Phase 2)

> Status: approved design, pre-implementation. Date: 2026-06-26.
> Builds on Phase 1 (`2026-06-26-journal-entry-tile-design.md`). Phase 3 = Convert to Linear (separate).

## 1. Goal

Enable the journal tile's **Format** button (a disabled placeholder shipped in Phase 1). Clicking
it runs the note through a headless Claude that **re-formats only** — fixes indentation and list
nesting that go sloppy during fast note-taking — while **preserving every word**. The result is
shown as a **side-by-side before/after** preview in the tile; the user **Applies** (replaces the
note text) or **Discards** (keeps the original). Nothing is changed without the preview.

## 2. Decisions (locked)

| Decision | Choice |
| --- | --- |
| What Format does | Re-indent + fix list nesting + tidy structure. **Never** add, remove, reword, summarize, reorder, or comment on content. |
| Claude invocation | One-shot **`claude -p`** (non-interactive print mode) via the existing `SessionBridge`, note passed inline in the prompt, `--output-format text`. No tools, no file writes, no permission prompt. |
| Review UX | **Side-by-side before/after** in the tile body (BEFORE ‖ AFTER), with **Apply / Discard**. |
| Apply | Replaces the textarea content and marks the tile **dirty** (the user still Saves explicitly — Format does not auto-save). |
| Discard | Returns to the editor, original untouched. |
| Safety net | The side-by-side view is the guard against any stray reword — the user sees it and can Discard. |
| Cost | Each Format = one real Claude call (consumes tokens, unlike the local `/usage` probe) and takes a few seconds. |

## 3. Architecture — units

### 3.1 `FormatProbe` — `src/terminals/format-probe.ts` (new)

```ts
export interface FormatProbeOpts { sidecarPath: string; cwd: string; }

export class FormatProbe {
  constructor(opts: FormatProbeOpts);
  /** Reformat note text via a one-shot `claude -p`. Resolves with the reformatted text.
   *  Rejects on timeout / no output. Empty/whitespace input resolves to the input unchanged
   *  (no Claude call). */
  format(noteText: string): Promise<string>;
}

/** The strict reformat-only instruction + the note, as one prompt string. */
export function buildFormatPrompt(note: string): string;

/** Clean Claude's raw stdout into just the note text: trim, strip a wrapping ``` fence and any
 *  one-line preamble Claude might emit despite instructions. */
export function parseFormatOutput(raw: string): string;
```

- `format()`: if `noteText.trim() === ''` → resolve `noteText` (skip). Else spawn a one-shot
  `SessionBridge(sidecarPath, cwd, 'claude', ['-p', buildFormatPrompt(noteText), '--output-format', 'text'], {})`.
  Collect `onData` into a buffer; on `onExit` resolve `parseFormatOutput(buffer)`; guard with a
  ~30s timeout that kills the bridge and rejects. Reject if the buffer is empty at exit.
- `buildFormatPrompt(note)`: returns —
  > "Reformat the note below. Fix only indentation and list nesting that became inconsistent
  > during fast typing. Preserve every word, every line, and its meaning EXACTLY — do not add,
  > remove, reword, summarize, reorder, or comment. Output ONLY the reformatted note text: no
  > preamble, no explanation, no code fences.\n\n---\n" + note
- `parseFormatOutput(raw)`: `trim()`; if it starts with ```` ``` ```` (optionally ```` ```md ````)
  and ends with ```` ``` ````, strip the fences; return.

### 3.2 `JournalTile` changes — `src/terminals/journal-tile.ts`

- `JournalTileOpts` gains `onFormat: (text: string) => Promise<string>`.
- The **Format** button loses `disabled` and gets a click handler → `format()`.
- `private async format()`:
  1. `const before = this.textarea?.value ?? this.currentText`. If `before.trim() === ''` →
     `opts.toast('Nothing to format')`; return.
  2. Enter a **formatting state**: render a "Formatting…" placeholder in the body, disable the
     action buttons.
  3. `let after; try { after = await this.opts.onFormat(before); } catch { opts.toast('Format failed'); this.renderEditor(); return; }`
  4. `renderFormatPreview(before, after)`.
- `private renderFormatPreview(before, after)`: body → `.cos-journal-preview` with two read-only
  panes (BEFORE = `before`, AFTER = `after`) + an actions row: **Apply** → `this.currentText = after;`
  `this.dirty = true;` `this.renderEditor();`  ·  **Discard** → `this.renderEditor();` (currentText
  unchanged).
- `currentText` already tracks the live edit (Phase 1); `renderEditor()` re-seeds the textarea
  from it, so Apply/Discard restore the editor correctly.

### 3.3 Grid wiring — `src/terminals/terminals-grid.ts`

- Construct one `private formatProbe = new FormatProbe({ sidecarPath: this.sidecarPath, cwd: this.coordDir })` (in the constructor, after `coordDir` is set, like `journalStore`).
- Pass `onFormat: (text) => this.formatProbe.format(text)` into **both** `JournalTile` construction
  sites (`spawnJournal()` and the `restoreSessions()` journal branch).

## 4. Visual

```
┌ Journal 1 — Format preview                 🔒 – × ┐
│ BEFORE                  │ AFTER                     │
│ - shipped pay bills     │ - shipped pay bills       │
│ - pushed to dev         │   - pushed to dev         │
│ todo fix migrate        │ - todo: fix migrate       │
│                         │                           │
├─────────────────────────────────────────────────────┤
│   [Apply]   [Discard]                                │
└───────────────────────────────────────────────────────┘
(while running: body shows "Formatting…", actions disabled)
```

## 5. Edge cases & risks

| Risk | Mitigation |
| --- | --- |
| Claude rewords/adds content despite the prompt | Side-by-side preview; user Discards. Apply never auto-fires. |
| Claude wraps output in ``` fences or a preamble | `parseFormatOutput` strips them. |
| Claude unavailable / slow | ~30s timeout → reject → toast "Format failed", editor restored, note untouched. |
| Empty / whitespace note | Short-circuits, no Claude call, toast "Nothing to format". |
| Note has meaningful trailing whitespace | Prompt says preserve every line; `parseFormatOutput` only trims the outer wrapper, not interior lines. |
| User edits mid-format | Buttons disabled during the formatting state; `before` is captured at click time. |
| Apply silently losing the original | Discard restores; and Apply only stages into the textarea (dirty) — a Save is still required to persist. |

## 6. Testing

- `tests/format-probe.test.ts` (pure): `buildFormatPrompt` includes the instruction + the verbatim
  note; `parseFormatOutput` strips ```` ``` ````/```` ```md ```` fences, trims outer whitespace,
  leaves interior lines intact, and passes clean text through unchanged.
- Probe spawn + tile preview DOM = build + manual: Format a sloppy note → preview shows fixed
  indentation, words unchanged → Apply updates the editor (dirty) → Save persists; Discard leaves
  it; empty note toasts; killing Claude mid-run shows the error state.

## 7. Out of scope (Phase 2)

- Summarizing or any content editing. Streaming the formatted output token-by-token. Formatting a
  selection/subset. Auto-format on save. Diff/inline-highlight view (we chose side-by-side).
- Convert to Linear (Phase 3).
