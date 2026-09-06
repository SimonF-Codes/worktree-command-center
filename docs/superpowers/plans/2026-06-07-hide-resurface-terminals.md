---
status: stable
---

# Hide / Resurface Terminals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user hide a terminal tile (keeping its Claude session running in the background) and resurface it later from the Coordination panel.

**Architecture:** A hidden tile is moved out of `TerminalsGrid.tiles` into a separate `hidden[]` array; because layout, chat, badges, and the ready-queue all iterate `tiles`, the hidden tile is excluded from them for free while its DOM node (kept in the stage but `display:none`) and `claude` session stay alive. The Coordination panel (`BoardView`) gains a "Hidden terminals" section driven by an in-memory provider callback.

**Tech Stack:** TypeScript, Electron renderer, xterm.js, esbuild, vitest. DOM helpers come from the Obsidian-style shim (`createDiv`/`createEl`/`setText`/`toggleClass`).

---

### Task 1: Persisted `hidden` flag + pure partition helper

The only pure logic worth unit-testing: splitting persisted session records into visible vs. hidden on restore. Make it a standalone generic helper so it can be tested without a DOM or live session.

**Files:**
- Create: `src/terminals/session-partition.ts`
- Test: `tests/session-partition.test.ts`
- Modify: `src/terminals/terminals-grid.ts:28` (add `hidden?: boolean` to `SessionRecord`)

- [ ] **Step 1: Write the failing test**

Create `tests/session-partition.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { partitionByHidden } from '../src/terminals/session-partition';

describe('partitionByHidden', () => {
	it('splits records into visible vs hidden, preserving order', () => {
		const recs = [
			{ branch: 'a', hidden: false },
			{ branch: 'b', hidden: true },
			{ branch: 'c' },            // absent flag → visible (back-compat)
			{ branch: 'd', hidden: true },
		];
		const { visible, hidden } = partitionByHidden(recs);
		expect(visible.map((r) => r.branch)).toEqual(['a', 'c']);
		expect(hidden.map((r) => r.branch)).toEqual(['b', 'd']);
	});

	it('handles an empty list', () => {
		expect(partitionByHidden([])).toEqual({ visible: [], hidden: [] });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/session-partition.test.ts`
Expected: FAIL — cannot find module `../src/terminals/session-partition`.

- [ ] **Step 3: Write the helper**

Create `src/terminals/session-partition.ts`:

```typescript
// Pure split of persisted session records into the ones that restore onto the
// visible stage vs. the ones restored hidden (off-stage, session still spawned).
// An absent `hidden` flag means visible (back-compatible with older session files).

export function partitionByHidden<T extends { hidden?: boolean }>(records: T[]): { visible: T[]; hidden: T[] } {
	const visible: T[] = [];
	const hidden: T[] = [];
	for (const r of records) (r.hidden ? hidden : visible).push(r);
	return { visible, hidden };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/session-partition.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the `hidden` field to `SessionRecord`**

In `src/terminals/terminals-grid.ts`, line 28, change:

```typescript
interface SessionRecord { worktreePath: string; branch: string; repoName: string; repoPath: string; baseBranch: string; name?: string; }
```

to:

```typescript
interface SessionRecord { worktreePath: string; branch: string; repoName: string; repoPath: string; baseBranch: string; name?: string; hidden?: boolean; }
```

- [ ] **Step 6: Commit**

```bash
git add src/terminals/session-partition.ts tests/session-partition.test.ts src/terminals/terminals-grid.ts
git commit -m "feat(terminals): persisted hidden flag + partition helper"
```

---

### Task 2: `TerminalTile` — Hide button + `setHidden`

Add the per-tile Hide control and the show/hide DOM toggle. The session, bridge, and xterm are never touched, so the background process keeps running.

**Files:**
- Modify: `src/terminals/terminal-tile.ts` (opts interface ~line 19, header render ~line 54-59, new method)

- [ ] **Step 1: Add the `onHide` callback to the opts interface**

In `src/terminals/terminal-tile.ts`, inside `TerminalTileOpts` (after the `onClosed` line, ~line 19), add:

```typescript
	onHide?: (tile: TerminalTile) => void;
```

- [ ] **Step 2: Add the Hide button to the header**

In `render()`, the header currently builds the name span then the close button:

```typescript
		const close = head.createEl('button', { text: '×', attr: { title: 'Close — deletes this worktree + its branch' } });
		close.addEventListener('click', (e) => { e.stopPropagation(); void this.close(); });
```

Insert a Hide button immediately **before** that `close` button:

```typescript
		const hide = head.createEl('button', { text: '–', cls: 'cos-term-hide', attr: { title: 'Hide — keeps the session running; resurface from Coordination' } });
		hide.addEventListener('click', (e) => { e.stopPropagation(); this.opts.onHide?.(this); });
		const close = head.createEl('button', { text: '×', attr: { title: 'Close — deletes this worktree + its branch' } });
		close.addEventListener('click', (e) => { e.stopPropagation(); void this.close(); });
```

- [ ] **Step 3: Add the `setHidden` method**

Add this method to the `TerminalTile` class (next to `setCentered`, ~line 153):

```typescript
	/** Detach/re-attach the tile from the visible stage WITHOUT touching the session.
	 *  Hidden tiles keep their claude process + xterm buffer alive in the background. */
	setHidden(on: boolean): void {
		if (!this.el) return;
		this.el.style.display = on ? 'none' : '';
		if (!on) this.fitSoon(); // re-show: the term was display:none, so refit to the stage
	}
```

- [ ] **Step 4: Verify it type-checks**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: no errors. (No unit test — this is DOM wiring verified by the build and the manual run in Task 7. `fitSoon` is an existing private method.)

- [ ] **Step 5: Commit**

```bash
git add src/terminals/terminal-tile.ts
git commit -m "feat(terminals): Hide button + setHidden on tile"
```

---

### Task 3: `BoardView` — Hidden terminals section

Give the Coordination panel a section that lists hidden terminals with a Show button. Defaults keep it inert until the grid passes real data (Task 5), so this task is safe on its own.

**Files:**
- Modify: `src/terminals/board-view.ts` (constructor ~line 13, `renderAll` ~line 60)

- [ ] **Step 1: Add a hidden-list element field**

In `BoardView`, next to the other element fields (~line 11), add:

```typescript
	private hiddenEl: HTMLElement | null = null;
```

- [ ] **Step 2: Extend the constructor**

Change the constructor (line 13) from:

```typescript
	constructor(private coordDir: string, private onReopen: (branch: string) => void = () => {}) {}
```

to:

```typescript
	constructor(
		private coordDir: string,
		private onReopen: (branch: string) => void = () => {},
		private hiddenProvider: () => Array<{ tileId: number; name: string; branch: string }> = () => [],
		private onShow: (tileId: number) => void = () => {},
	) {}
```

- [ ] **Step 3: Create the hidden section element in `mount`**

In `mount()`, the elements are created in this order:

```typescript
		this.registryEl = this.el.createDiv({ cls: 'cos-coord-registry' });
		this.locksEl = this.el.createDiv({ cls: 'cos-coord-locks' });
		this.feedEl = this.el.createDiv({ cls: 'cos-coord-feed' });
```

Insert the hidden section **before** the registry so it sits at the top:

```typescript
		this.hiddenEl = this.el.createDiv({ cls: 'cos-coord-hidden' });
		this.registryEl = this.el.createDiv({ cls: 'cos-coord-registry' });
		this.locksEl = this.el.createDiv({ cls: 'cos-coord-locks' });
		this.feedEl = this.el.createDiv({ cls: 'cos-coord-feed' });
```

- [ ] **Step 4: Clear the new element in `unmount`**

In `unmount()`, update the null-out line to include `hiddenEl`:

```typescript
		this.el = this.registryEl = this.locksEl = this.feedEl = this.hiddenEl = null;
```

- [ ] **Step 5: Render the hidden rows in `renderAll`**

At the very top of `renderAll()`, after the `if (!this.registryEl ...)` guard, change the guard to include `hiddenEl` and add the render block. The current guard:

```typescript
		if (!this.registryEl || !this.locksEl || !this.feedEl) return;
		const now = Date.now();
```

becomes:

```typescript
		if (!this.registryEl || !this.locksEl || !this.feedEl || !this.hiddenEl) return;
		const now = Date.now();

		// Hidden-terminals section (in-memory, provided by the grid). Resurface with Show.
		this.hiddenEl.empty();
		const hiddenList = this.hiddenProvider();
		if (hiddenList.length) {
			this.hiddenEl.createDiv({ cls: 'cos-reg-repo', text: 'Hidden' });
			for (const h of hiddenList) {
				const row = this.hiddenEl.createDiv({ cls: 'cos-reg-row' });
				row.createSpan({ cls: 'cos-reg-branch', text: h.name });
				if (h.branch && h.branch !== h.name) row.createSpan({ cls: 'cos-reg-detail', text: h.branch });
				const btn = row.createEl('button', { text: 'Show', cls: 'cos-reopen-btn' });
				btn.addEventListener('click', (e) => { e.stopPropagation(); this.onShow(h.tileId); });
			}
		}
```

- [ ] **Step 6: Keep the hidden section hidden when the panel is collapsed**

In `app.css`, line 85-87, the collapse rule currently lists registry/locks/feed. Add `cos-coord-hidden`:

```css
.cos-coord-board.collapsed .cos-coord-hidden,
.cos-coord-board.collapsed .cos-coord-registry,
.cos-coord-board.collapsed .cos-coord-locks,
.cos-coord-board.collapsed .cos-coord-feed { display: none; }
```

- [ ] **Step 7: Verify it type-checks**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/terminals/board-view.ts app.css
git commit -m "feat(coord): Hidden terminals section in the Coordination panel"
```

---

### Task 4: `TerminalsGrid` — `hidden[]`, `hideTile`, `showTile`, guards

Wire the grid's hide/show logic and protect the centering paths from background tiles.

**Files:**
- Modify: `src/terminals/terminals-grid.ts` (field ~line 39, `makeTile` ~line 408, `handleReady`/`handleSubmit` ~line 392-404, new methods)

- [ ] **Step 1: Add the hidden array field**

Next to `private tiles: TerminalTile[] = [];` (line 39), add:

```typescript
	private hidden: TerminalTile[] = [];
```

- [ ] **Step 2: Wire `onHide` in `makeTile`**

In `makeTile(...)`, the options object passed to `new TerminalTile({...})` has an `onClosed:` line (~line 420). Add an `onHide` entry right after it:

```typescript
			onHide: (t) => this.hideTile(t),
```

- [ ] **Step 3: Guard the centering handlers against hidden tiles**

`handleReady` (line 392) and `handleSubmit` (line 399) must ignore tiles that are hidden, so a background session never yanks the stage. Add a guard as the first line of each.

`handleReady`:

```typescript
	private handleReady(t: TerminalTile): void {
		if (this.hidden.includes(t)) return; // a hidden, background session never steals the center
		if (this.chatRoom) { this.chatRoom.noteIdle(t.name); return; } // chat owns idle while open
		const r = rqReady(this.q, t.tileId);
		this.q = r.state;
		if (!this.locked && r.center !== null) this.doCenter(r.center);
	}
```

`handleSubmit`:

```typescript
	private handleSubmit(t: TerminalTile): void {
		if (this.hidden.includes(t)) return; // background sessions don't drive centering
		const r = rqSubmit(this.q, t.tileId);
		this.q = r.state;
		// Locked: submitting doesn't pull the next terminal to center — centering stays manual.
		if (!this.locked && r.center !== null) this.doCenter(r.center);
	}
```

- [ ] **Step 4: Add `hideTile` and `showTile`**

Add these two methods near `makeTile` (e.g. right before `makeTile`, ~line 406). `hideTile` mirrors the `onClosed` re-centering logic but parks the tile in `hidden` instead of destroying it.

```typescript
	/** Hide a tile: pull it off the stage but keep its session + worktree alive.
	 *  Resurface later with showTile() from the Coordination panel. */
	private hideTile(tile: TerminalTile): void {
		if (!this.tiles.includes(tile)) return;
		const wasCentered = this.centeredId === tile.tileId;
		this.tiles = this.tiles.filter((x) => x !== tile);
		this.hidden.push(tile);
		tile.setHidden(true);
		tile.setSelected(false);          // a hidden tile is never a chat member
		this.updateChatBtn();
		const r = rqClose(this.q, tile.tileId, wasCentered); // drop from the ready-queue
		this.q = r.state;
		if (r.center !== null) this.doCenter(r.center);
		else { if (wasCentered) this.centeredId = null; this.applyLayout(); }
		void this.persist();
		this.board?.refresh();
	}

	/** Resurface a hidden tile: put it back on the stage, centered + focused. */
	private showTile(tileId: number): void {
		const tile = this.hidden.find((t) => t.tileId === tileId);
		if (!tile) return;
		this.hidden = this.hidden.filter((t) => t !== tile);
		this.tiles.push(tile);
		tile.setHidden(false);
		this.centeredId = tile.tileId;
		this.applyLayout();
		this.focusCentered();
		void this.persist();
		this.board?.refresh();
	}
```

- [ ] **Step 5: Verify it type-checks**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: no errors. (`this.board` may be null at call time — `?.` guards it. `rqClose` and `rqSubmit` are already imported.)

- [ ] **Step 6: Commit**

```bash
git add src/terminals/terminals-grid.ts
git commit -m "feat(terminals): hideTile/showTile + hidden array + centering guards"
```

---

### Task 5: `TerminalsGrid` — persistence, restore, scan, teardown, BoardView wiring

Make every list-walking path account for `hidden`, and feed the BoardView its provider + Show callback.

**Files:**
- Modify: `src/terminals/terminals-grid.ts` (BoardView construction ~line 121, `persist` ~line 437, `restoreSessions` ~line 444, `scanWorktrees` ~line 498, `dispose` ~line 461, `parkAll` ~line 472, import line 5/12)

- [ ] **Step 1: Import the partition helper**

At the top of `src/terminals/terminals-grid.ts`, add to the imports (after the `ready-queue` import on line 12):

```typescript
import { partitionByHidden } from './session-partition';
```

- [ ] **Step 2: Pass provider + onShow to BoardView**

In `mount()`, the BoardView is constructed (line 121):

```typescript
		if (!this.board) this.board = new BoardView(this.coordDir, (branch) => void this.reopenAndOpen(branch));
```

Change it to:

```typescript
		if (!this.board) this.board = new BoardView(
			this.coordDir,
			(branch) => void this.reopenAndOpen(branch),
			() => this.hidden.map((t) => ({ tileId: t.tileId, name: t.name, branch: t.branch })),
			(tileId) => this.showTile(tileId),
		);
```

- [ ] **Step 3: Persist hidden tiles too**

`persist()` (line 437) currently writes only `this.tiles`. Update it to write both lists, tagging each:

```typescript
	private async persist(): Promise<void> {
		const all = await this.readAllSessions();
		all[this.deps.group] = [
			...this.tiles.map((t) => ({ ...t.sessionRecord(), hidden: false })),
			...this.hidden.map((t) => ({ ...t.sessionRecord(), hidden: true })),
		];
		try { await fs.writeFile(this.sessionsFile, JSON.stringify(all, null, 2), 'utf8'); } catch { /* best effort */ }
	}
```

- [ ] **Step 4: Restore hidden tiles off-stage**

`restoreSessions()` (line 444) currently builds every record into `this.tiles`. Refactor it to render visible records normally and hidden ones off-stage into `this.hidden`. Replace the method body's loop with a partitioned version:

```typescript
	private async restoreSessions(): Promise<void> {
		const all = await this.readAllSessions();
		const recs = all[this.deps.group] ?? [];
		const { visible, hidden } = partitionByHidden(recs);
		for (const rec of [...visible, ...hidden]) {
			let exists = false;
			try { await fs.access(rec.worktreePath); exists = true; } catch { exists = false; }
			if (!exists) continue;
			const tile = this.makeTile({ worktreePath: rec.worktreePath, branch: rec.branch }, rec.repoName, rec.repoPath, rec.baseBranch, true, rec.name);
			try { await writeReadyHook(rec.worktreePath, this.notifyScriptPath, this.coordHookPath); } catch { /* best effort */ }
			if (this.stageEl) tile.render(this.stageEl);
			if (rec.hidden) { tile.setHidden(true); this.hidden.push(tile); }
			else this.tiles.push(tile);
		}
		await this.persist(); // prune records whose worktree no longer exists
		this.applyLayout();
	}
```

- [ ] **Step 5: Resolve owner name from hidden tiles too in `scanWorktrees`**

In `scanWorktrees()` (line 498), the line that finds the owning tile:

```typescript
				const tile = this.tiles.find((t) => path.resolve(t.worktreePath) === path.resolve(wt.path));
```

becomes (search both lists so a hidden terminal still shows ownership):

```typescript
				const tile = [...this.tiles, ...this.hidden].find((t) => path.resolve(t.worktreePath) === path.resolve(wt.path));
```

- [ ] **Step 6: Include hidden tiles in `dispose`**

`dispose()` (line 461) kills `this.tiles`. Also kill and clear `this.hidden`:

```typescript
	dispose(): void {
		this.unmount();
		this.board = null;
		for (const t of this.tiles) t.kill();
		for (const t of this.hidden) t.kill();
		this.tiles = [];
		this.hidden = [];
		this.stageEl = null;
	}
```

- [ ] **Step 7: Include hidden tiles in `parkAll`**

`parkAll()` (line 472) loops `for (const t of this.tiles)`. Change it to cover both:

```typescript
		for (const t of [...this.tiles, ...this.hidden]) {
```

- [ ] **Step 8: Verify it type-checks**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: no errors.

- [ ] **Step 9: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass (including the new `session-partition` test).

- [ ] **Step 10: Commit**

```bash
git add src/terminals/terminals-grid.ts
git commit -m "feat(terminals): persist/restore/scan/teardown account for hidden tiles"
```

---

### Task 6: Styling for the Hide button + Hidden section

**Files:**
- Modify: `app.css` (Coordination block, ~line 102)

- [ ] **Step 1: Add styles**

In `app.css`, after the `.cos-reopen-btn` rule (line 102), add:

```css
.cos-coord-hidden { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
.cos-term-hide { font-size: 15px !important; line-height: 1; }
```

- [ ] **Step 2: Verify the bundle builds**

Run: `npm run build`
Expected: `tsc -noEmit -skipLibCheck` passes, then esbuild writes the bundle with no errors.

- [ ] **Step 3: Commit**

```bash
git add app.css
git commit -m "style(terminals): Hide button + Hidden section styling"
```

---

### Task 7: Manual verification

No automated test covers the DOM/session wiring, so verify by running the app.

**Files:** none (verification only)

- [ ] **Step 1: Launch the app**

Run: `npm start`
Expected: the app opens; the terminals view shows the controls bar, the `🛰 Coordination` panel, and the stage.

- [ ] **Step 2: Create at least two terminals**

Pick a repo + branch, hit ▶ Play twice (two tiles). Type something distinctive into one of them (e.g. `echo hello-hidden`).

- [ ] **Step 3: Hide one terminal**

Click the `–` (Hide) button on the tile you typed into.
Expected: that tile leaves the stage; the remaining tile re-lays out to fill; the Coordination panel shows a **Hidden** section with a row for the hidden terminal and a **Show** button. The `×` button is unaffected on the visible tile.

- [ ] **Step 4: Confirm the session kept running**

Wait a few seconds (optionally have that session produce output before hiding).
Expected: no crash; the hidden session's process is still alive (it was never killed).

- [ ] **Step 5: Resurface it**

Click **Show** in the Coordination panel.
Expected: the terminal returns to the stage, centered and focused, with its prior scrollback intact (the `echo hello-hidden` line still visible) — same live session, zero state loss. The Hidden section row disappears.

- [ ] **Step 6: Confirm × still destroys**

Click `×` on a tile, confirm the dialog.
Expected: standard close — the worktree + branch are deleted (unchanged behavior).

- [ ] **Step 7: Restart persistence check**

Hide a terminal, then fully quit and relaunch the app.
Expected: the hidden terminal restores off-stage and reappears in the Coordination Hidden section (not on the stage); clicking Show brings it back.

- [ ] **Step 8: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "fix(terminals): verification fixups for hide/resurface"
```

(Skip if nothing needed fixing.)
