---
status: stable
---

# Journal Format (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the journal tile's **Format** button — a headless `claude -p` re-formats the note (fix indentation/nesting, preserve every word), shown as a side-by-side before/after preview with Apply / Discard.

**Architecture:** A `FormatProbe` drives a one-shot `claude -p` via the existing `SessionBridge` (note inline in the prompt, `--output-format text`); pure `buildFormatPrompt`/`parseFormatOutput` helpers are unit-tested. The `JournalTile` gains a `format()` flow + side-by-side preview; the grid owns the probe and passes an `onFormat` callback. Builds on the Phase-1 journal feature already on `main`.

**Tech Stack:** TypeScript, Electron renderer, vitest. Spec: `docs/superpowers/specs/2026-06-26-journal-format-design.md`.

## Global Constraints

- TypeScript strict; verify each task with `npx tsc --noEmit --skipLibCheck` (repo root).
- Reuse `stripAnsi` from `src/terminals/usage-parse.ts` (already exported) in `parseFormatOutput`.
- Reuse the existing `SessionBridge` (`src/terminals/session-bridge.ts`) for the one-shot spawn — do not add a new process abstraction.
- Format must NEVER auto-apply: Apply only stages text into the editor (marks dirty); the user still Saves.
- Commit on `main`, each task scoped via `git add <its files>` (the working tree is clean post-Phase-1).
- Working dir: `C:/Users/User/Dev/worktree-command-center`. Windows; Bash tool is Git Bash.

---

### Task 1: `FormatProbe` + pure helpers

**Files:**
- Create: `src/terminals/format-probe.ts`
- Test: `tests/format-probe.test.ts`

**Interfaces:**
- Produces: `buildFormatPrompt(note: string): string`; `parseFormatOutput(raw: string): string`; `class FormatProbe { constructor(opts: { sidecarPath: string; cwd: string }); format(noteText: string): Promise<string> }`.

- [ ] **Step 1: Write the failing test** — `tests/format-probe.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildFormatPrompt, parseFormatOutput } from '../src/terminals/format-probe';

describe('buildFormatPrompt', () => {
  it('includes the strict instruction and the verbatim note', () => {
    const p = buildFormatPrompt('- a\n  - b');
    expect(p).toContain('Preserve every word');
    expect(p).toContain('- a\n  - b');
  });
});

describe('parseFormatOutput', () => {
  it('strips a wrapping code fence', () => {
    expect(parseFormatOutput('```\n- a\n  - b\n```')).toBe('- a\n  - b');
    expect(parseFormatOutput('```md\n- a\n```')).toBe('- a');
  });
  it('trims outer whitespace but keeps interior lines', () => {
    expect(parseFormatOutput('\n\n- a\n  - b\n\n')).toBe('- a\n  - b');
  });
  it('passes clean text through unchanged', () => {
    expect(parseFormatOutput('- a\n  - b')).toBe('- a\n  - b');
  });
  it('strips ANSI escape codes', () => {
    expect(parseFormatOutput('[2m- a[0m')).toBe('- a');
  });
});
```

- [ ] **Step 2: Run → fail.** `npx vitest run tests/format-probe.test.ts` (FAIL: module not found).

- [ ] **Step 3: Implement** — `src/terminals/format-probe.ts`:

```ts
import { SessionBridge } from './session-bridge';
import { stripAnsi } from './usage-parse';

export interface FormatProbeOpts { sidecarPath: string; cwd: string; }

const FORMAT_INSTRUCTION =
  'Reformat the note below. Fix only indentation and list nesting that became inconsistent ' +
  'during fast typing. Preserve every word, every line, and its meaning EXACTLY — do not add, ' +
  'remove, reword, summarize, reorder, or comment. Output ONLY the reformatted note text: no ' +
  'preamble, no explanation, no code fences.';

/** The strict reformat-only instruction + the note, as one prompt string. */
export function buildFormatPrompt(note: string): string {
  return `${FORMAT_INSTRUCTION}\n\n---\n${note}`;
}

/** Clean Claude's raw stdout into just the note text: strip ANSI, trim outer whitespace, and
 *  remove a wrapping ``` / ```md fence if Claude added one. Interior lines stay intact. */
export function parseFormatOutput(raw: string): string {
  let t = stripAnsi(raw).trim();
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(t);
  if (m) t = m[1]!;
  return t;
}

/** Drives a one-shot headless `claude -p` to reformat note text. No tools, no permissions. */
export class FormatProbe {
  constructor(private opts: FormatProbeOpts) {}

  format(noteText: string): Promise<string> {
    if (noteText.trim() === '') return Promise.resolve(noteText);
    return new Promise<string>((resolve, reject) => {
      const bridge = new SessionBridge(
        this.opts.sidecarPath, this.opts.cwd, 'claude',
        ['-p', buildFormatPrompt(noteText), '--output-format', 'text'], {},
      );
      let buf = '';
      let done = false;
      const finish = (fn: () => void): void => { if (done) return; done = true; window.clearTimeout(timer); fn(); };
      const timer = window.setTimeout(() => finish(() => { bridge.kill(); reject(new Error('format timed out')); }), 30000);
      bridge.onData((d) => { buf += d; });
      bridge.onExit(() => finish(() => {
        const out = parseFormatOutput(buf);
        out ? resolve(out) : reject(new Error('format produced no output'));
      }));
      bridge.start();
    });
  }
}
```

- [ ] **Step 4: Run → pass.** `npx vitest run tests/format-probe.test.ts`.
- [ ] **Step 5: Type-check.** `npx tsc --noEmit --skipLibCheck` → clean.
- [ ] **Step 6: Commit.** `git add src/terminals/format-probe.ts tests/format-probe.test.ts && git commit -m "feat(journal): FormatProbe + prompt/parse helpers"`

---

### Task 2: JournalTile Format flow + preview

**Files:**
- Modify: `src/terminals/journal-tile.ts`

**Interfaces:**
- Consumes: `onFormat: (text: string) => Promise<string>` (new opt, supplied by Task 3).
- Produces: enabled Format button → `format()` → side-by-side preview with Apply/Discard.

- [ ] **Step 1: Add the opt.** In `JournalTileOpts`, add:

```ts
  onFormat: (text: string) => Promise<string>;
```

- [ ] **Step 2: Field refs for the footer buttons.** Add near the other private fields:

```ts
  private fmtBtn: HTMLButtonElement | null = null;
  private saveBtn: HTMLButtonElement | null = null;
  private historyBtn: HTMLButtonElement | null = null;
```

- [ ] **Step 3: Wire the actions row.** Replace the existing `actions` block in `render()` (the Save / See History / disabled Format / disabled Convert lines) with:

```ts
    const actions = this.el.createDiv({ cls: 'cos-journal-actions' });
    this.saveBtn = actions.createEl('button', { text: 'Save', cls: 'cos-journal-save' }) as HTMLButtonElement;
    this.saveBtn.addEventListener('click', (e) => { e.stopPropagation(); this.save(); });
    this.historyBtn = actions.createEl('button', { text: 'See History', cls: 'cos-journal-history' }) as HTMLButtonElement;
    this.historyBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleHistory(); });
    this.fmtBtn = actions.createEl('button', { text: 'Format', cls: 'cos-journal-fmt', attr: { title: 'Reformat with Claude — fixes indentation, keeps your words' } }) as HTMLButtonElement;
    this.fmtBtn.addEventListener('click', (e) => { e.stopPropagation(); void this.format(); });
    actions.createEl('button', { text: 'Convert to Linear', cls: 'cos-journal-soon', attr: { disabled: 'true', title: 'Coming soon (phase 3)' } });
```

- [ ] **Step 4: Add the format flow.** Add these methods (next to `save()`):

```ts
  private setFooterDisabled(on: boolean): void {
    for (const b of [this.saveBtn, this.historyBtn, this.fmtBtn]) if (b) b.disabled = on;
  }

  private async format(): Promise<void> {
    const before = this.textarea?.value ?? this.currentText;
    if (before.trim() === '') { this.opts.toast('Nothing to format'); return; }
    this.currentText = before;
    this.setFooterDisabled(true);
    if (this.bodyEl) { this.bodyEl.empty(); this.bodyEl.createDiv({ cls: 'cos-journal-formatting', text: 'Formatting…' }); }
    let after: string;
    try { after = await this.opts.onFormat(before); }
    catch { this.opts.toast('Format failed'); this.renderEditor(); this.setFooterDisabled(false); return; }
    this.renderFormatPreview(before, after);
  }

  private renderFormatPreview(before: string, after: string): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    const wrap = this.bodyEl.createDiv({ cls: 'cos-journal-preview' });
    const pane = (title: string, text: string): void => {
      const col = wrap.createDiv({ cls: 'cos-journal-pane' });
      col.createDiv({ cls: 'cos-journal-pane-h', text: title });
      const ta = col.createEl('textarea', { cls: 'cos-journal-text' }) as HTMLTextAreaElement;
      ta.value = text; ta.readOnly = true;
    };
    pane('BEFORE', before);
    pane('AFTER', after);
    const bar = this.bodyEl.createDiv({ cls: 'cos-journal-preview-actions' });
    bar.createEl('button', { text: 'Apply', cls: 'cos-journal-save' })
      .addEventListener('click', (e) => { e.stopPropagation(); this.currentText = after; this.dirty = true; this.setFooterDisabled(false); this.renderEditor(); });
    bar.createEl('button', { text: 'Discard' })
      .addEventListener('click', (e) => { e.stopPropagation(); this.setFooterDisabled(false); this.renderEditor(); });
  }
```

- [ ] **Step 5: Type-check.** `npx tsc --noEmit --skipLibCheck` → clean. (Will report `onFormat` missing at the two `new JournalTile({...})` call sites in `terminals-grid.ts` — that is fixed in Task 3; this task's file itself is clean.)
- [ ] **Step 6: Commit.** `git add src/terminals/journal-tile.ts && git commit -m "feat(journal): Format button -> claude reformat with side-by-side preview"`

---

### Task 3: Grid wiring (FormatProbe + onFormat)

**Files:**
- Modify: `src/terminals/terminals-grid.ts`

**Interfaces:**
- Consumes: `FormatProbe` (Task 1), `JournalTile`'s new `onFormat` opt (Task 2).

- [ ] **Step 1: Import + field.** Add the import beside the other `./` imports:

```ts
import { FormatProbe } from './format-probe';
```

Add a field by `journalStore`:

```ts
  private formatProbe!: FormatProbe;
```

Initialize it in the constructor right after the `journalStore` assignment:

```ts
    this.formatProbe = new FormatProbe({ sidecarPath: this.sidecarPath, cwd: this.coordDir });
```

- [ ] **Step 2: Pass `onFormat` at both JournalTile sites.** In `spawnJournal()` AND in the `restoreSessions()` journal branch, add to the `new JournalTile({...})` opts:

```ts
    onFormat: (text) => this.formatProbe.format(text),
```

- [ ] **Step 3: Type-check + tests.** `npx tsc --noEmit --skipLibCheck && npx vitest run` → clean (the 2 pre-existing `coord-cli.test.ts` failures are unrelated; everything else green incl. `format-probe`).
- [ ] **Step 4: Commit.** `git add src/terminals/terminals-grid.ts && git commit -m "feat(journal): wire FormatProbe into journal tiles"`

---

### Task 4: Preview styles

**Files:**
- Modify: `app.css`

- [ ] **Step 1: Append styles** to `app.css`:

```css
/* Journal Format: side-by-side preview + loading state. */
.cos-journal-formatting { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: 12px; }
.cos-journal-preview { flex: 1 1 auto; min-height: 0; display: flex; gap: 6px; }
.cos-journal-pane { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
.cos-journal-pane-h { flex: 0 0 auto; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-faint); padding: 2px 4px; }
.cos-journal-preview .cos-journal-text { flex: 1 1 auto; }
.cos-journal-preview-actions { flex: 0 0 auto; display: flex; gap: 6px; padding: 6px 8px; background: var(--background-secondary); border-top: 1px solid var(--background-modifier-border); }
.cos-journal-preview-actions button { font-size: 11px; padding: 3px 12px; border-radius: 6px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); color: var(--text-normal); cursor: pointer; }
.cos-journal-preview-actions button:hover { border-color: var(--interactive-accent); }
```

- [ ] **Step 2: Build + manual.** `npm run build`, reload. Format a sloppily-indented note → "Formatting…" → side-by-side BEFORE/AFTER (words identical, indentation fixed) → Apply updates the editor (dirty) → Save persists; Discard leaves the original; an empty note toasts "Nothing to format".
- [ ] **Step 3: Commit.** `git add app.css && git commit -m "feat(journal): format preview styles"`

---

## Self-Review

- **Spec coverage:** §3.1 FormatProbe + helpers → T1; §3.2 tile format()/preview/Apply/Discard/disabled-buttons → T2; §3.3 grid probe + onFormat (both sites) → T3; §4 visual + loading state → T2/T4. Side-by-side (not diff) per the locked decision → T2. All covered.
- **Placeholder scan:** none — full code in every step.
- **Type consistency:** `FormatProbe.format(text): Promise<string>` (T1) matches `onFormat` (T2 opt) matches the grid callback `(text) => this.formatProbe.format(text)` (T3). `buildFormatPrompt`/`parseFormatOutput` signatures consistent T1↔tests. `stripAnsi` reused from `usage-parse` (exists). Footer button refs typed `HTMLButtonElement` so `.disabled` is valid.
