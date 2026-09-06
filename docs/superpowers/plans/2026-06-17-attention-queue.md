---
status: stable
---

# Attention Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A topbar `⚠ N` badge + dropdown listing terminals that need you (prompt / menu / errored / idle), click a row to jump to that terminal.

**Architecture:** Pure detectors (`looksErrored`) + a pure `classifyAttention` produce a prioritized list from each tile's recent output + an idle flag the grid maintains; an `AttentionWidget` in the topbar polls a grid-backed provider and reveals a tile on click.

**Tech Stack:** TypeScript, Electron renderer, vitest.

Spec: `docs/superpowers/specs/2026-06-17-attention-queue-design.md`

---

## Task 1: `looksErrored` detector

**Files:** Modify `src/terminals/prompt-detect.ts`; Test `tests/prompt-detect.test.ts`.

- [ ] **Step 1: Failing test** — append to `tests/prompt-detect.test.ts`:

```ts
import { looksErrored } from '../src/terminals/prompt-detect';

describe('looksErrored', () => {
  it('fires on common failure markers', () => {
    expect(looksErrored('Traceback (most recent call last):')).toBe(true);
    expect(looksErrored('Error: ENOENT: no such file')).toBe(true);
    expect(looksErrored('✗ 3 tests failed')).toBe(true);
    expect(looksErrored("'claude' is not recognized as a command")).toBe(true);
    expect(looksErrored('process exited with code 1')).toBe(true);
  });
  it('does not fire on normal output or empty', () => {
    expect(looksErrored('Done. Results saved to run.log')).toBe(false);
    expect(looksErrored('Running the build now…')).toBe(false);
    expect(looksErrored('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run → fail.** `npx vitest run tests/prompt-detect.test.ts` (FAIL: `looksErrored` not exported).

- [ ] **Step 3: Implement** — append to `src/terminals/prompt-detect.ts`:

```ts
/** Best-effort sniff for a terminal that looks like it errored / failed. Fuzzy on purpose —
 *  it only nudges the attention queue, never blocks. */
export function looksErrored(output: string): boolean {
	const t = String(output);
	if (!t.trim()) return false;
	if (/\b(error|exception|fatal|failed|failure)\b/i.test(t)) return true;
	if (/traceback \(most recent call last\)/i.test(t)) return true;
	if (/\bcommand not found\b|is not recognized as/i.test(t)) return true;
	if (/\bexit(?:ed)?\b[^\n]{0,16}\bcode\s*[1-9]/i.test(t)) return true;
	if (/✗/.test(t)) return true;
	return false;
}
```

- [ ] **Step 4: Run → pass.** `npx vitest run tests/prompt-detect.test.ts`.

- [ ] **Step 5: Commit.** `git add src/terminals/prompt-detect.ts tests/prompt-detect.test.ts && git commit -m "feat(attention): looksErrored detector"`

---

## Task 2: `classifyAttention` + `actionCount`

**Files:** Create `src/terminals/attention.ts`; Test `tests/attention.test.ts`.

- [ ] **Step 1: Failing test** — `tests/attention.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyAttention, actionCount } from '../src/terminals/attention';

const t = (id: number, output: string, idle = false, name = `t${id}`, repo = 'app') => ({ id, name, repo, output, idle });

describe('classifyAttention', () => {
  it('classifies by precedence prompt > menu > errored > idle', () => {
    const items = classifyAttention([
      t(1, 'Continue? (y/n)'),
      t(2, 'Enter to select · ↑/↓ to navigate · Esc to cancel'),
      t(3, 'Error: boom'),
      t(4, 'all good', true),
    ]);
    expect(items.map((i) => [i.id, i.state])).toEqual([[1, 'prompt'], [2, 'menu'], [3, 'errored'], [4, 'idle']]);
  });
  it('prompt wins even when the output also looks errored', () => {
    expect(classifyAttention([t(1, 'Error: boom\nContinue? (y/n)')])[0].state).toBe('prompt');
  });
  it('omits busy tiles with nothing to flag', () => {
    expect(classifyAttention([t(1, 'building…', false)])).toEqual([]);
  });
});

describe('actionCount', () => {
  it('counts prompt/menu/errored but not idle', () => {
    const items = classifyAttention([t(1, 'Continue? (y/n)'), t(2, 'ok', true), t(3, 'Error: x')]);
    expect(actionCount(items)).toBe(2);
  });
});
```

- [ ] **Step 2: Run → fail.** `npx vitest run tests/attention.test.ts`.

- [ ] **Step 3: Implement** — `src/terminals/attention.ts`:

```ts
import { looksLikePrompt } from './chat-room';
import { looksLikeMenu, looksErrored } from './prompt-detect';

export type AttentionState = 'prompt' | 'menu' | 'errored' | 'idle';
export interface AttentionInput { id: number; name: string; repo: string; output: string; idle: boolean; }
export interface AttentionItem { id: number; name: string; repo: string; state: AttentionState; }

const RANK: Record<AttentionState, number> = { prompt: 0, menu: 1, errored: 2, idle: 3 };

/** Classify tiles by precedence prompt > menu > errored > idle; drop tiles with nothing to
 *  flag (busy + clean). Sorted by precedence, then id. */
export function classifyAttention(tiles: AttentionInput[]): AttentionItem[] {
	const out: AttentionItem[] = [];
	for (const t of tiles) {
		let state: AttentionState | null = null;
		if (looksLikePrompt(t.output)) state = 'prompt';
		else if (looksLikeMenu(t.output)) state = 'menu';
		else if (looksErrored(t.output)) state = 'errored';
		else if (t.idle) state = 'idle';
		if (state) out.push({ id: t.id, name: t.name, repo: t.repo, state });
	}
	return out.sort((a, b) => RANK[a.state] - RANK[b.state] || a.id - b.id);
}

/** Items that count toward the badge — everything except idle. */
export function actionCount(items: AttentionItem[]): number {
	return items.filter((i) => i.state !== 'idle').length;
}
```

- [ ] **Step 4: Run → pass.** `npx vitest run tests/attention.test.ts`.

- [ ] **Step 5: Commit.** `git add src/terminals/attention.ts tests/attention.test.ts && git commit -m "feat(attention): classifyAttention + actionCount"`

---

## Task 3: Grid wiring (idle tracking, provider, reveal)

**Files:** Modify `src/terminals/terminals-grid.ts`.

- [ ] **Step 1: Import + field.** Add import:

```ts
import { classifyAttention, type AttentionItem } from './attention';
```

Add field near `private idleTiles`/others (after `pendingTask`):

```ts
	private idleTiles = new Set<number>();
```

- [ ] **Step 2: Maintain the idle flag.** In `handleReady(t)`, after the watcher/pendingTask block and before the `hidden` early-return, add:

```ts
		this.idleTiles.add(t.tileId);
```

In `handleSubmit(t)`, at the top (after the `hidden` guard), add:

```ts
		this.idleTiles.delete(t.tileId);
```

In `makeTile(...)`, change the `onInput` callback to also clear idle:

```ts
			onInput: (t, data) => { this.idleTiles.delete(t.tileId); this.q.composingLen = applyKeystroke(this.q.composingLen, data); },
```

In the `onClosed` callback and `hideTile`/`showTile`, drop the id from the set defensively — add `this.idleTiles.delete(t.tileId);` in `onClosed`, and in `showTile` add `this.idleTiles.delete(tile.tileId);` (a resurfaced tile is no longer "done waiting").

- [ ] **Step 3: Provider + reveal methods.** Add near `allSessions()`:

```ts
	/** Snapshot of which terminals need attention, for the topbar queue. */
	attentionItems(): AttentionItem[] {
		return classifyAttention(this.allSessions().map((t) => ({
			id: t.tileId, name: t.name, repo: this.repoNameFor(t),
			output: t.recentOutput(), idle: this.idleTiles.has(t.tileId),
		})));
	}

	/** Jump to a terminal by id: un-hide it if hidden, else center + focus it. */
	revealTile(id: number): void {
		if (this.hidden.some((t) => t.tileId === id)) { this.showTile(id); return; }
		if (this.tiles.some((t) => t.tileId === id)) { this.doCenter(id); this.focusCentered(); }
	}
```

- [ ] **Step 4: Type-check + tests.** `npx tsc -noEmit -skipLibCheck && npx vitest run` → clean.

- [ ] **Step 5: Commit.** `git add src/terminals/terminals-grid.ts && git commit -m "feat(attention): grid idle tracking + attentionItems/revealTile"`

---

## Task 4: `AttentionWidget`

**Files:** Create `src/ui/attention-widget.ts`.

- [ ] **Step 1: Implement** — `src/ui/attention-widget.ts`:

```ts
import { actionCount, type AttentionItem, type AttentionState } from '../terminals/attention';

const ICON: Record<AttentionState, string> = { prompt: '⏳', menu: '❖', errored: '⚠', idle: '✓' };
const GROUPS: Array<{ title: string; states: AttentionState[] }> = [
	{ title: 'Needs input', states: ['prompt', 'menu'] },
	{ title: 'Errored', states: ['errored'] },
	{ title: 'Idle · done', states: ['idle'] },
];

/** Topbar attention badge + dropdown. Polls the provider; click a row to jump to a terminal. */
export class AttentionWidget {
	private btn: HTMLButtonElement | null = null;
	private menu: HTMLElement | null = null;
	private open = false;
	private timer: number | null = null;
	private onDocClick: ((e: MouseEvent) => void) | null = null;

	constructor(private provider: () => AttentionItem[], private onReveal: (id: number) => void) {}

	render(parent: HTMLElement): void {
		const el = parent.createDiv({ cls: 'wcc-attn' });
		this.btn = el.createEl('button', { cls: 'wcc-attn-btn', text: '⚠', attr: { title: 'Terminals needing attention' } });
		this.btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
		this.menu = el.createDiv({ cls: 'wcc-attn-menu' });
		this.menu.style.display = 'none';
		this.onDocClick = () => { if (this.open) this.toggle(false); };
		document.addEventListener('click', this.onDocClick);
		this.tick();
		this.timer = window.setInterval(() => this.tick(), 1500);
	}

	private tick(): void {
		const items = this.provider();
		const n = actionCount(items);
		if (this.btn) {
			this.btn.setText(n > 0 ? `⚠ ${n}` : '⚠');
			const crit = items.some((i) => i.state === 'prompt' || i.state === 'menu');
			const warn = !crit && items.some((i) => i.state === 'errored');
			this.btn.dataset.level = crit ? 'crit' : warn ? 'warn' : '';
		}
		if (this.open) this.renderMenu(items);
	}

	private toggle(force?: boolean): void {
		this.open = force ?? !this.open;
		if (this.menu) this.menu.style.display = this.open ? 'block' : 'none';
		if (this.open) this.renderMenu(this.provider());
	}

	private renderMenu(items: AttentionItem[]): void {
		if (!this.menu) return;
		this.menu.empty();
		if (!items.length) { this.menu.createDiv({ cls: 'wcc-attn-empty', text: 'Nothing needs you' }); return; }
		for (const g of GROUPS) {
			const rows = items.filter((i) => g.states.includes(i.state));
			if (!rows.length) continue;
			this.menu.createDiv({ cls: 'wcc-attn-group', text: g.title });
			for (const it of rows) {
				const row = this.menu.createDiv({ cls: `wcc-attn-row state-${it.state}` });
				row.createSpan({ cls: 'wcc-attn-ico', text: ICON[it.state] });
				row.createSpan({ cls: 'wcc-attn-name', text: it.name });
				row.createSpan({ cls: 'wcc-attn-repo', text: it.repo });
				row.createSpan({ cls: 'wcc-attn-state', text: it.state });
				row.addEventListener('click', (e) => { e.stopPropagation(); this.onReveal(it.id); this.toggle(false); });
			}
		}
	}

	dispose(): void {
		if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; }
		if (this.onDocClick) document.removeEventListener('click', this.onDocClick);
	}
}
```

- [ ] **Step 2: Type-check.** `npx tsc -noEmit -skipLibCheck` → clean.

- [ ] **Step 3: Commit.** `git add src/ui/attention-widget.ts && git commit -m "feat(attention): AttentionWidget — topbar badge + dropdown"`

---

## Task 5: Wire into the topbar + styling

**Files:** Modify `src/app.ts`, `app.css`.

- [ ] **Step 1: app.ts.** Import:

```ts
import { AttentionWidget } from './ui/attention-widget';
```

After the `new UsageWidget(...).render(topBar)` line, add:

```ts
		const attention = new AttentionWidget(() => grid.attentionItems(), (id) => grid.revealTile(id));
		attention.render(topBar);
		window.addEventListener('beforeunload', () => attention.dispose());
```

(The `grid` is constructed a few lines below in current code — move the `grid` construction ABOVE the topbar widgets, or construct the widget after `const grid = new TerminalsGrid(deps)`. Concretely: in `app.ts`, the `const grid = new TerminalsGrid(deps)` line currently sits after the topbar block; move that single line up to just before the UsageWidget/AttentionWidget mounts so both can reference `grid`. `grid.mount(gridContainer)` stays where it is.)

- [ ] **Step 2: app.css** — append:

```css
/* Attention queue badge + dropdown. */
.wcc-attn { position: relative; }
.wcc-attn-btn { background: transparent; border: 1px solid var(--background-modifier-border); color: var(--text-muted); cursor: pointer; font-size: 12px; border-radius: 6px; padding: 3px 9px; }
.wcc-attn-btn:hover { color: var(--text-normal); }
.wcc-attn-btn[data-level='warn'] { color: var(--color-yellow); border-color: var(--color-yellow); }
.wcc-attn-btn[data-level='crit'] { color: #fff; background: #d2453e; border-color: #d2453e; }
.wcc-attn-menu { position: absolute; right: 0; top: 28px; z-index: 1200; min-width: 240px; max-height: 60vh; overflow-y: auto; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.45); padding: 6px; }
.wcc-attn-group { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: var(--text-faint); padding: 6px 8px 2px; }
.wcc-attn-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; }
.wcc-attn-row:hover { background: var(--background-modifier-hover); }
.wcc-attn-name { color: var(--text-normal); font-weight: 600; }
.wcc-attn-repo { font-size: 11px; color: var(--text-muted); background: rgba(154,160,180,0.14); padding: 1px 7px; border-radius: 999px; white-space: nowrap; }
.wcc-attn-state { margin-left: auto; font-size: 11px; color: var(--text-faint); }
.wcc-attn-row.state-prompt .wcc-attn-state, .wcc-attn-row.state-menu .wcc-attn-state { color: var(--color-yellow); }
.wcc-attn-row.state-errored .wcc-attn-state { color: #d2453e; }
.wcc-attn-empty { padding: 10px 8px; color: var(--text-faint); font-size: 12px; }
```

- [ ] **Step 3: Build + full test.** `npm run build && npm test` → clean, all green.

- [ ] **Step 4: Commit.** `git add src/app.ts app.css && git commit -m "feat(attention): mount the attention queue in the topbar"`

- [ ] **Step 5: Manual (`npm start`).** Badge shows action count; click → grouped dropdown; click a row jumps + focuses the terminal; a hidden tile gets un-hidden; idle terminals listed but don't inflate the count.

---

## Self-Review

- **Spec coverage:** §3.1 looksErrored → T1. §3.2 classify/actionCount → T2. §3.3 grid (idle set, provider, reveal) → T3. §3.4 widget → T4. §3.5 wiring + §4 visual → T5.
- **Type consistency:** `AttentionItem`/`AttentionState` defined T2, consumed by grid (T3) and widget (T4). `classifyAttention`/`actionCount` signatures match call sites. `looksErrored` exported T1, imported by `attention.ts` (T2). `revealTile`/`attentionItems` defined T3, called in app.ts T5. `showTile`/`doCenter`/`focusCentered`/`repoNameFor`/`allSessions` already exist on the grid.
- **Placeholder scan:** none.
- **Note:** T5 requires moving the `const grid = new TerminalsGrid(deps)` line above the topbar-widget mounts so the widgets can close over `grid`.
