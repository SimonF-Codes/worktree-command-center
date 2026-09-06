---
status: stable
---

# Journal Entry Tile (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a top-bar **📓 Journal Entry** button (replacing the terminal filter box) that spawns a note-taking tile in the stage with Save, See History (edit/delete/resave), rename, and full tile chrome (lock / minimize→Coordination / close).

**Architecture:** A new `JournalTile` (textarea-backed, no Claude session) and `TerminalTile` both implement a shared `StageTile` interface, so the grid holds them in the same `tiles`/`hidden` arrays and its lock/center/hide/close machinery works for both. Notes persist as markdown files via a `JournalStore`. Format (phase 2) and Convert-to-Linear (phase 3) are out of scope here.

**Tech Stack:** TypeScript, Electron renderer, xterm-adjacent DOM, vitest. Spec: `docs/superpowers/specs/2026-06-26-journal-entry-tile-design.md`.

## Global Constraints

- TypeScript strict; verify each task with `npx tsc --noEmit --skipLibCheck` (run from repo root).
- No `Date.now()` inside `journal-store.ts` (pure/testable) — callers pass `now`.
- Reuse the existing `promptForConfirm` (`src/ui/prompt-dialog.ts`) for destructive confirms.
- Follow existing tile DOM classes (`cos-term-tile`, `cos-term-head`, `cos-term-head-btns`).
- Tests are pure units over temp dirs (the codebase does not test DOM); DOM/grid is build+manual.

---

### Task 1: `JournalStore` + `slugify`

**Files:**
- Create: `src/terminals/journal-store.ts`
- Test: `tests/journal-store.test.ts`

**Interfaces:**
- Produces: `slugify(name: string): string`; `class JournalStore` with `list(): JournalMeta[]`, `load(slug): {name,text}|null`, `save(slug, name, text, now): void`, `remove(slug): void`, `uniqueSlug(name, exceptSlug?): string`; `interface JournalMeta { slug: string; name: string; updated: number }`.

- [ ] **Step 1: Write the failing test** — `tests/journal-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JournalStore, slugify } from '../src/terminals/journal-store';

describe('slugify', () => {
  it('makes a filesystem-safe slug', () => {
    expect(slugify('Standup Notes 6/26')).toBe('standup-notes-6-26');
    expect(slugify('  Hello!!  ')).toBe('hello');
  });
  it('falls back to "journal" when empty', () => {
    expect(slugify('   ')).toBe('journal');
    expect(slugify('!!!')).toBe('journal');
  });
});

describe('JournalStore', () => {
  let dir: string; let store: JournalStore;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrnl-')); store = new JournalStore(dir); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('save → load round-trips name + text', () => {
    store.save('a', 'A note', 'line 1\nline 2', 1000);
    expect(store.load('a')).toEqual({ name: 'A note', text: 'line 1\nline 2' });
  });
  it('list returns newest-updated first', () => {
    store.save('a', 'A', 'x', 1000);
    store.save('b', 'B', 'y', 2000);
    expect(store.list().map((m) => m.slug)).toEqual(['b', 'a']);
  });
  it('save overwrites the same slug (no dup)', () => {
    store.save('a', 'A', 'x', 1000);
    store.save('a', 'A2', 'z', 3000);
    expect(store.list()).toEqual([{ slug: 'a', name: 'A2', updated: 3000 }]);
    expect(store.load('a')!.text).toBe('z');
  });
  it('remove deletes the doc + index entry', () => {
    store.save('a', 'A', 'x', 1000);
    store.remove('a');
    expect(store.load('a')).toBeNull();
    expect(store.list()).toEqual([]);
  });
  it('uniqueSlug de-dups against other journals', () => {
    store.save('standup', 'Standup', 'x', 1000);
    expect(store.uniqueSlug('Standup')).toBe('standup-2');
    expect(store.uniqueSlug('Standup', 'standup')).toBe('standup');
  });
  it('load returns null for unknown slug', () => {
    expect(store.load('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run → fail.** `npx vitest run tests/journal-store.test.ts` (FAIL: module not found).

- [ ] **Step 3: Implement** — `src/terminals/journal-store.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

export interface JournalMeta { slug: string; name: string; updated: number; }

/** Filesystem-safe slug from a display name; 'journal' when empty. De-dup is uniqueSlug's job. */
export function slugify(name: string): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return base || 'journal';
}

/** Markdown-file-per-journal store under <coordDir>/journals, with an index.json for display
 *  names + updated timestamps. */
export class JournalStore {
  constructor(private dir: string) {}
  private indexPath(): string { return path.join(this.dir, 'index.json'); }
  private docPath(slug: string): string { return path.join(this.dir, `${slug}.md`); }
  private readIndex(): JournalMeta[] {
    try { return JSON.parse(fs.readFileSync(this.indexPath(), 'utf8')) as JournalMeta[]; } catch { return []; }
  }
  private writeIndex(list: JournalMeta[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.indexPath(), JSON.stringify(list, null, 2), 'utf8');
  }
  list(): JournalMeta[] { return this.readIndex().slice().sort((a, b) => b.updated - a.updated); }
  load(slug: string): { name: string; text: string } | null {
    const meta = this.readIndex().find((m) => m.slug === slug);
    if (!meta) return null;
    let text = '';
    try { text = fs.readFileSync(this.docPath(slug), 'utf8'); } catch { text = ''; }
    return { name: meta.name, text };
  }
  save(slug: string, name: string, text: string, now: number): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.docPath(slug), text, 'utf8');
    const list = this.readIndex().filter((m) => m.slug !== slug);
    list.push({ slug, name, updated: now });
    this.writeIndex(list);
  }
  remove(slug: string): void {
    try { fs.unlinkSync(this.docPath(slug)); } catch { /* already gone */ }
    this.writeIndex(this.readIndex().filter((m) => m.slug !== slug));
  }
  uniqueSlug(name: string, exceptSlug?: string): string {
    const taken = new Set(this.readIndex().map((m) => m.slug).filter((s) => s !== exceptSlug));
    const base = slugify(name);
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) { const c = `${base}-${i}`; if (!taken.has(c)) return c; }
  }
}
```

- [ ] **Step 4: Run → pass.** `npx vitest run tests/journal-store.test.ts`.
- [ ] **Step 5: Commit.** `git add src/terminals/journal-store.ts tests/journal-store.test.ts && git commit -m "feat(journal): JournalStore + slugify"`

---

### Task 2: `StageTile` interface + `TerminalTile` conforms

**Files:**
- Create: `src/terminals/stage-tile.ts`
- Modify: `src/terminals/terminal-tile.ts` (class declaration + one field)

**Interfaces:**
- Produces: `interface StageTile` (the contract the grid calls on tiles in `tiles`/`hidden`).
- Consumes: nothing.

- [ ] **Step 1: Create the interface** — `src/terminals/stage-tile.ts`:

```ts
/** The structural contract the terminal grid relies on for any tile it places in the stage —
 *  satisfied by both TerminalTile (a Claude session) and JournalTile (a notes editor). */
export interface StageTile {
  readonly tileId: number;
  readonly name: string;
  readonly branch: string;
  readonly repoName: string;
  readonly isJournal: boolean;
  readonly isSelected: boolean;
  render(parent: HTMLElement): void;
  setRect(r: { x: number; y: number; w: number; h: number }): void;
  setCentered(on: boolean): void;
  setHidden(on: boolean): void;
  setLocked(on: boolean): void;
  setDimmed(on: boolean): void;
  setSelected(on: boolean): void;
  setBadge(text: string | null): void;
  focus(): void;
  blur(): void;
  kill(): void;
  recentOutput(): string;
}
```

- [ ] **Step 2: Make TerminalTile implement it.** In `src/terminals/terminal-tile.ts`, add the import and `implements StageTile`, and add the `isJournal` field. Change the class line:

```ts
import type { StageTile } from './stage-tile';
// ...
export class TerminalTile implements StageTile {
  readonly isJournal = false;
```

(Place `readonly isJournal = false;` next to the other field declarations near the top of the class.)

- [ ] **Step 3: Type-check.** `npx tsc --noEmit --skipLibCheck`. Expected: clean. If TS reports a missing member, TerminalTile already has it under a slightly different shape — reconcile by exposing the missing getter/method (e.g., confirm `name`, `branch`, `repoName`, `isSelected`, `setSelected`, `setDimmed`, `setBadge`, `recentOutput` exist; they are already used by the grid, so they should).

- [ ] **Step 4: Commit.** `git add src/terminals/stage-tile.ts src/terminals/terminal-tile.ts && git commit -m "feat(journal): StageTile interface; TerminalTile implements it"`

---

### Task 3: `JournalTile`

**Files:**
- Create: `src/terminals/journal-tile.ts`

**Interfaces:**
- Consumes: `StageTile` (Task 2), `JournalStore` (Task 1), `promptForConfirm` (`../ui/prompt-dialog`).
- Produces: `class JournalTile implements StageTile`; `interface JournalTileOpts`; public `setName(name)`, getter `journalSlug`.

- [ ] **Step 1: Implement** — `src/terminals/journal-tile.ts`:

```ts
import { JournalStore } from './journal-store';
import { promptForConfirm } from '../ui/prompt-dialog';
import type { StageTile } from './stage-tile';

export interface JournalTileOpts {
  tileId: number;
  name: string;
  store: JournalStore;
  slug?: string;
  initialText?: string;
  onClosed: (tile: JournalTile) => void;
  onHide: (tile: JournalTile) => void;
  onLock: (tile: JournalTile) => void;
  onCenter: (tile: JournalTile) => void;
  onRequestRename: (tile: JournalTile, current: string) => void;
  onRename: () => void;
  toast: (msg: string) => void;
}

/** A stage tile holding free-form notes (a textarea), not a Claude session. Saves to the
 *  JournalStore, browses saved notes via History, and carries terminal-like chrome so the grid
 *  treats it as any StageTile. */
export class JournalTile implements StageTile {
  readonly isJournal = true;
  readonly branch = '';
  readonly repoName = 'journal';
  readonly isSelected = false;
  private el: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private nameEl: HTMLElement | null = null;
  private lockBtnEl: HTMLElement | null = null;
  private displayName: string;
  private slug: string | undefined;
  private dirty = false;
  private showingHistory = false;
  private currentText = '';

  constructor(private opts: JournalTileOpts) {
    this.displayName = opts.name;
    this.slug = opts.slug;
    this.currentText = opts.initialText ?? '';
  }

  get tileId(): number { return this.opts.tileId; }
  get name(): string { return this.displayName; }
  get journalSlug(): string | undefined { return this.slug; }

  render(parent: HTMLElement): void {
    this.el = parent.createDiv({ cls: 'cos-term-tile cos-journal-tile' });
    this.el.addEventListener('click', () => this.opts.onCenter(this));
    const head = this.el.createDiv({ cls: 'cos-term-head' });
    this.nameEl = head.createSpan({ cls: 'cos-term-name', text: this.displayName, attr: { title: 'Double-click to rename' } });
    this.nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); this.opts.onRequestRename(this, this.displayName); });
    const btns = head.createDiv({ cls: 'cos-term-head-btns' });
    this.lockBtnEl = btns.createEl('button', { text: '🔒', cls: 'cos-term-lock', attr: { title: 'Lock to center (Alt+L)' } });
    this.lockBtnEl.addEventListener('click', (e) => { e.stopPropagation(); this.opts.onLock(this); });
    const hide = btns.createEl('button', { text: '–', cls: 'cos-term-hide', attr: { title: 'Hide — resurface from Coordination' } });
    hide.addEventListener('click', (e) => { e.stopPropagation(); this.opts.onHide(this); });
    const close = btns.createEl('button', { text: '×', attr: { title: 'Close this journal' } });
    close.addEventListener('click', (e) => { e.stopPropagation(); void this.requestClose(); });

    this.bodyEl = this.el.createDiv({ cls: 'cos-journal-body' });
    this.renderEditor();

    const actions = this.el.createDiv({ cls: 'cos-journal-actions' });
    actions.createEl('button', { text: 'Save', cls: 'cos-journal-save' })
      .addEventListener('click', (e) => { e.stopPropagation(); this.save(); });
    actions.createEl('button', { text: 'See History', cls: 'cos-journal-history' })
      .addEventListener('click', (e) => { e.stopPropagation(); this.toggleHistory(); });
    actions.createEl('button', { text: 'Format', cls: 'cos-journal-soon', attr: { disabled: 'true', title: 'Coming soon (phase 2)' } });
    actions.createEl('button', { text: 'Convert to Linear', cls: 'cos-journal-soon', attr: { disabled: 'true', title: 'Coming soon (phase 3)' } });
  }

  private renderEditor(): void {
    if (!this.bodyEl) return;
    this.showingHistory = false;
    this.bodyEl.empty();
    const ta = this.bodyEl.createEl('textarea', { cls: 'cos-journal-text' }) as HTMLTextAreaElement;
    ta.value = this.currentText;
    ta.spellcheck = false;
    ta.addEventListener('input', () => { this.currentText = ta.value; this.dirty = true; });
    ta.addEventListener('click', (e) => e.stopPropagation());
    this.textarea = ta;
  }

  private renderHistory(): void {
    if (!this.bodyEl) return;
    this.showingHistory = true;
    if (this.textarea) this.currentText = this.textarea.value; // preserve the open edit
    this.bodyEl.empty();
    const list = this.bodyEl.createDiv({ cls: 'cos-journal-hist' });
    const items = this.opts.store.list();
    if (!items.length) list.createDiv({ cls: 'cos-journal-hist-empty', text: 'No saved notes yet' });
    for (const m of items) {
      const row = list.createDiv({ cls: 'cos-journal-hist-row' });
      row.createSpan({ cls: 'cos-journal-hist-name', text: m.name });
      row.createSpan({ cls: 'cos-journal-hist-time', text: new Date(m.updated).toLocaleString() });
      row.createEl('button', { text: 'open', cls: 'cos-reopen-btn' })
        .addEventListener('click', (e) => { e.stopPropagation(); this.openFromHistory(m.slug); });
      row.createEl('button', { text: '✕', cls: 'cos-close-btn', attr: { title: 'Delete this saved note' } })
        .addEventListener('click', async (e) => {
          e.stopPropagation();
          if (await promptForConfirm(`Delete "${m.name}"?`, 'This permanently deletes the saved note.', 'Delete')) {
            this.opts.store.remove(m.slug);
            this.renderHistory();
          }
        });
    }
    list.createEl('button', { text: '← Back', cls: 'cos-journal-back' })
      .addEventListener('click', (e) => { e.stopPropagation(); this.renderEditor(); });
  }

  private toggleHistory(): void { this.showingHistory ? this.renderEditor() : this.renderHistory(); }

  private openFromHistory(slug: string): void {
    const doc = this.opts.store.load(slug);
    if (!doc) return;
    this.slug = slug;
    this.displayName = doc.name;
    this.nameEl?.setText(doc.name);
    this.currentText = doc.text;
    this.dirty = false;
    this.opts.onRename();
    this.renderEditor();
  }

  save(): void {
    if (this.textarea && !this.showingHistory) this.currentText = this.textarea.value;
    const slug = this.opts.store.uniqueSlug(this.displayName, this.slug);
    this.slug = slug;
    this.opts.store.save(slug, this.displayName, this.currentText, Date.now());
    this.dirty = false;
    this.opts.onRename();
    this.opts.toast(`Saved "${this.displayName}"`);
  }

  setName(name: string): void { this.displayName = name; this.nameEl?.setText(name); this.opts.onRename(); }

  private async requestClose(): Promise<void> {
    if (this.dirty) {
      const ok = await promptForConfirm(`Close "${this.displayName}"?`, 'This journal has unsaved changes. Close without saving?', 'Close');
      if (!ok) return;
    }
    this.opts.onClosed(this);
  }

  // --- StageTile ---
  setRect(r: { x: number; y: number; w: number; h: number }): void {
    if (!this.el) return;
    this.el.style.left = `${r.x}px`; this.el.style.top = `${r.y}px`;
    this.el.style.width = `${r.w}px`; this.el.style.height = `${r.h}px`;
  }
  setCentered(on: boolean): void { this.el?.toggleClass('centered', on); }
  setHidden(on: boolean): void { if (this.el) this.el.style.display = on ? 'none' : ''; }
  setLocked(on: boolean): void { this.lockBtnEl?.toggleClass('on', on); }
  setDimmed(on: boolean): void { this.el?.toggleClass('cos-term-dim', on); }
  setSelected(_on: boolean): void { /* journals are never chat members */ }
  setBadge(_text: string | null): void { /* no keyboard-shortcut badge for journals */ }
  focus(): void { this.textarea?.focus(); }
  blur(): void { this.textarea?.blur(); }
  recentOutput(): string { return this.textarea?.value ?? this.currentText; }
  kill(): void { this.el?.remove(); this.el = null; }
}
```

- [ ] **Step 2: Type-check.** `npx tsc --noEmit --skipLibCheck`. Expected: clean. (`createDiv`/`createEl`/`createSpan`/`setText`/`toggleClass` are the Obsidian-style DOM helpers already used by `terminal-tile.ts` — confirm by matching their usage there.)

- [ ] **Step 3: Commit.** `git add src/terminals/journal-tile.ts && git commit -m "feat(journal): JournalTile — editor, history, save, rename, chrome"`

---

### Task 4: Grid integration

**Files:**
- Modify: `src/terminals/terminals-grid.ts`

**Interfaces:**
- Consumes: `JournalTile`, `JournalStore` (Tasks 1+3), `StageTile` (Task 2).
- Produces: `spawnJournal()`; journals participate in `tiles`/`hidden`, lock/center/hide/close, and persistence.

- [ ] **Step 1: Imports + fields.** Add near the other `./` imports:

```ts
import { JournalTile } from './journal-tile';
import { JournalStore } from './journal-store';
import type { StageTile } from './stage-tile';
```

Retype the tile arrays (find their declarations) to `StageTile[]`:

```ts
private tiles: StageTile[] = [];
private hidden: StageTile[] = [];
```

Add a store + a name counter near the other private fields:

```ts
private journalStore = new JournalStore(path.join(this.coordDir, 'journals'));
private journalSeq = 0;
```

- [ ] **Step 2: Guard the spotlight for journals.** At the top of `spotlightState(t)` add:

```ts
if (t.isJournal) return 'thinking'; // journals never auto-grab the spotlight; centered only on click
```

(Retype that method's parameter to `StageTile` if TS asks. `handleReady`/`handleSubmit` are only invoked from `TerminalTile` callbacks, which journals don't have, so they need no guard.)

- [ ] **Step 3: Retype tile-consuming helpers.** Change the parameter types of `hideTile(tile: TerminalTile)` → `hideTile(tile: StageTile)`. Run `npx tsc --noEmit --skipLibCheck` and fix any remaining `TerminalTile`-typed locals the compiler flags to `StageTile` (e.g. in `showTile`, `closeHiddenTile`, the `onClosed`/`onHide` closures). Do not change runtime logic — these are type-only widenings; every method called inside is on the `StageTile` interface.

- [ ] **Step 4: `spawnJournal()`.** Add the method (model it on `makeTile`'s callback set):

```ts
private spawnJournal(): void {
  const tile = new JournalTile({
    tileId: this.nextTileId++,
    name: `Journal ${++this.journalSeq}`,
    store: this.journalStore,
    toast: this.deps.toast,
    onClosed: (t) => {
      const wasCentered = this.centeredId === t.tileId;
      const r = rqClose(this.q, t.tileId, wasCentered); this.q = r.state;
      this.tiles = this.tiles.filter((x) => x !== t); t.kill(); void this.persist();
      if (r.center !== null) this.doCenter(r.center);
      else { if (wasCentered) this.centeredId = null; this.applyLayout(); }
    },
    onHide: (t) => this.hideTile(t),
    onLock: (t) => this.toggleLockById(t.tileId),
    onCenter: (t) => this.handleClick(t.tileId),
    onRequestRename: (t, cur) => {
      void this.deps.promptForTopic('Rename journal', 'New name', cur, 'Rename')
        .then((name) => { if (name && name.trim()) { t.setName(name.trim()); void this.persist(); } });
    },
    onRename: () => { void this.persist(); },
  });
  if (this.stageEl) tile.render(this.stageEl);
  this.tiles.push(tile);
  this.doCenter(tile.tileId);
  void this.persist();
}
```

- [ ] **Step 5: Top-bar button (replace the filter box).** Find the `cos-search` input creation + its `input` listener and DELETE both lines. In their place add:

```ts
const journalBtn = controls.createEl('button', { text: '📓 Journal Entry', cls: 'cos-journal-btn', attr: { title: 'Open a new journal entry tile' } });
journalBtn.addEventListener('click', () => this.spawnJournal());
```

(`this.searchQuery` stays `''` forever, so the `if (this.searchQuery) this.refreshSearch()` guard in `applyLayout` is now dead but harmless — leave it.)

- [ ] **Step 6: Persistence.** Find `interface SessionRecord` and add two optional fields:

```ts
kind?: 'terminal' | 'journal';
journalSlug?: string;
```

In `persist()` (where it builds records from `this.tiles`/`this.hidden`), branch per tile so journals serialize as `{ kind: 'journal', name: t.name, journalSlug: (t as JournalTile).journalSlug, hidden }` and terminals keep their existing record shape (add `kind: 'terminal'`). In `restoreSessions()`, before the existing terminal reconstruction, handle journals:

```ts
if (rec.kind === 'journal') {
  const doc = rec.journalSlug ? this.journalStore.load(rec.journalSlug) : null;
  const tile = new JournalTile({
    tileId: this.nextTileId++, name: rec.name ?? 'Journal', store: this.journalStore,
    slug: rec.journalSlug, initialText: doc?.text ?? '', toast: this.deps.toast,
    onClosed: (t) => { const wc = this.centeredId === t.tileId; const r = rqClose(this.q, t.tileId, wc); this.q = r.state; this.tiles = this.tiles.filter((x) => x !== t); t.kill(); void this.persist(); if (r.center !== null) this.doCenter(r.center); else { if (wc) this.centeredId = null; this.applyLayout(); } },
    onHide: (t) => this.hideTile(t), onLock: (t) => this.toggleLockById(t.tileId),
    onCenter: (t) => this.handleClick(t.tileId),
    onRequestRename: (t, cur) => { void this.deps.promptForTopic('Rename journal', 'New name', cur, 'Rename').then((n) => { if (n && n.trim()) { t.setName(n.trim()); void this.persist(); } }); },
    onRename: () => { void this.persist(); },
  });
  if (this.stageEl) tile.render(this.stageEl);
  if (rec.hidden) { tile.setHidden(true); this.hidden.push(tile); } else { this.tiles.push(tile); }
  continue; // skip the terminal path for this record
}
```

(The onClosed/rename closures duplicate `spawnJournal`'s — acceptable; if you prefer, extract a `makeJournalTile(opts)` helper and call it from both. The plan keeps them inline so each task is self-contained.)

- [ ] **Step 7: Type-check + tests.** `npx tsc --noEmit --skipLibCheck && npx vitest run`. Expected: clean, all green.

- [ ] **Step 8: Commit.** `git add src/terminals/terminals-grid.ts && git commit -m "feat(journal): grid spawns/persists journal tiles; top-bar Journal Entry button"`

---

### Task 5: Styles

**Files:**
- Modify: `app.css`

**Interfaces:** none (CSS only).

- [ ] **Step 1: Add styles.** Append to `app.css`:

```css
/* Journal entry tile. */
.cos-journal-btn { background: var(--background-secondary-alt); color: var(--text-normal); border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 5px 10px; cursor: pointer; font-size: 12px; }
.cos-journal-btn:hover { border-color: var(--interactive-accent); color: var(--text-normal); }
.cos-journal-tile { display: flex; flex-direction: column; }
.cos-journal-body { flex: 1 1 auto; min-height: 0; display: flex; }
.cos-journal-text { flex: 1 1 auto; width: 100%; min-height: 0; resize: none; border: none; outline: none; background: #0e0f17; color: #e0e0e0; font: 12px var(--font-monospace, monospace); padding: 8px; box-sizing: border-box; }
.cos-journal-actions { flex: 0 0 auto; display: flex; gap: 6px; padding: 6px 8px; background: var(--background-secondary); border-top: 1px solid var(--background-modifier-border); }
.cos-journal-actions button { font-size: 11px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); color: var(--text-normal); cursor: pointer; }
.cos-journal-actions button:hover { border-color: var(--interactive-accent); }
.cos-journal-soon[disabled] { opacity: 0.4; cursor: default; }
.cos-journal-hist { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px; width: 100%; }
.cos-journal-hist-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 5px; }
.cos-journal-hist-row:hover { background: var(--background-modifier-hover); }
.cos-journal-hist-name { color: var(--text-normal); font-weight: 600; }
.cos-journal-hist-time { color: var(--text-faint); font-size: 11px; margin-left: auto; }
.cos-journal-hist-empty { color: var(--text-faint); padding: 10px; font-size: 12px; }
.cos-journal-back { margin-top: 8px; font-size: 11px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); color: var(--text-normal); cursor: pointer; }
```

- [ ] **Step 2: Build + manual.** `npm run build`, reload the console. Verify: 📓 Journal Entry button replaces the filter box; clicking spawns a journal tile; type → Save → toast; See History lists it; open loads it; ✕ deletes (with confirm); rename (double-click) sticks; lock/minimize(→Coordination, with Show/✕)/× all work; a journal with unsaved text prompts on ×; reload restores open journals.

- [ ] **Step 3: Commit.** `git add app.css && git commit -m "feat(journal): journal tile + button styles"`

---

## Self-Review

- **Spec coverage:** §2 button-replaces-filter → T4S5; spawn → T4S4; textarea body → T3; persistence model → T1; Save → T3+T1; History (open/delete/resave) → T3; chrome lock/min/× → T3+T4 (StageTile in shared arrays); static centering → T4S2; restore → T4S6; rename → T3.setName + T4 callbacks. Format/Convert explicitly deferred (§7). All covered.
- **Placeholder scan:** none — every code step is complete. The persistence task references the real `persist()`/`restoreSessions()` bodies (executor edits in place); the journal-record code is given in full.
- **Type consistency:** `StageTile` members match calls in grid (`setRect/setCentered/setHidden/setLocked/setDimmed/setSelected/setBadge/focus/blur/kill/recentOutput`, getters `tileId/name/branch/repoName/isJournal/isSelected`). `JournalStore.save(slug,name,text,now)` signature consistent across T1/T3. `journalSlug` getter used in T4 persistence matches T3.
