---
status: stable
---

# GOD Overseer Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GOD — a privileged, docked Claude console with full-floor visibility and tools — that the user consults on demand, without GOD autonomously running the floor.

**Architecture:** A real `claude` session (`GodConsole`, reusing `SessionBridge` + xterm) docked beside the bubbling stage. `TerminalsGrid` writes per-terminal output snapshots to `coordDir/floor/*.md` while the console is open; GOD reads those + `board.md` + `worktrees.md` with native tools. GOD pushes lines to workers via a new `cos-coord tell` that drops files into `coordDir/god-outbox/`, which the grid drains and delivers.

**Tech Stack:** TypeScript, Electron, xterm.js, node-pty (via sidecar), vitest. Coordination CLI is CommonJS (`pty-sidecar/*.cjs`).

Spec: `docs/superpowers/specs/2026-06-07-god-overseer-console-design.md`

---

## File Structure

- **Create** `src/terminals/god.ts` — pure helpers (no Electron/IO): `slug`, `parseTellRequest`, `resolveTellTarget`, `formatFloorSnapshot`, `formatFloorIndex`, `godSystemPrompt`. Unit-tested.
- **Create** `src/terminals/god-console.ts` — `GodConsole` class: the docked panel DOM + the real `claude` session. I/O-heavy, verified by build + manual run.
- **Create** `tests/god.test.ts` — tests for the pure helpers.
- **Modify** `pty-sidecar/coord-store.cjs` — add `tell(dir, target, message)`.
- **Modify** `pty-sidecar/coord-cli.cjs` — add the `tell` command (GOD-only).
- **Modify** `tests/coord-store.test.ts` and `tests/coord-cli.test.ts` — cover `tell`.
- **Modify** `src/terminals/terminals-grid.ts` — GOD button, dock wrapper, snapshot timer, outbox drain + delivery, watcher ignore-filter fix.
- **Modify** `styles.css` — dock + GOD panel styling.

---

## Task 1: Pure helpers — tell parsing + target resolution

**Files:**
- Create: `src/terminals/god.ts`
- Test: `tests/god.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/god.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseTellRequest, resolveTellTarget, slug } from '../src/terminals/god';

describe('parseTellRequest', () => {
  it('parses a well-formed request', () => {
    expect(parseTellRequest('{"ts":1,"target":"Improver 1","message":"rebase please"}'))
      .toEqual({ target: 'Improver 1', message: 'rebase please' });
  });
  it('rejects missing fields, blank target, and non-JSON', () => {
    expect(parseTellRequest('{"target":"A"}')).toBeNull();
    expect(parseTellRequest('{"target":"  ","message":"x"}')).toBeNull();
    expect(parseTellRequest('not json')).toBeNull();
  });
});

describe('resolveTellTarget', () => {
  it('matches exactly, then case-insensitively, else null', () => {
    expect(resolveTellTarget('A', ['A', 'B'])).toBe('A');
    expect(resolveTellTarget('improver 1', ['Improver 1', 'B'])).toBe('Improver 1');
    expect(resolveTellTarget('ghost', ['A', 'B'])).toBeNull();
  });
});

describe('slug', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(slug('Improver 1')).toBe('improver-1');
    expect(slug('!!!')).toBe('unnamed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/god.test.ts`
Expected: FAIL — cannot find module `../src/terminals/god`.

- [ ] **Step 3: Write minimal implementation**

Create `src/terminals/god.ts`:

```ts
/** Pure helpers for the GOD overseer console — no Electron / no IO, so they unit-test
 *  cleanly (mirrors how chat-room.ts factors planDeliveries / tail). */

/** Filesystem-safe slug for snapshot filenames. Mirrors coord-core.slug. */
export function slug(name: string): string {
	return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

export interface TellRequest { target: string; message: string; }

/** Parse one god-outbox JSON message. Null on malformed / missing fields. */
export function parseTellRequest(text: string): TellRequest | null {
	try {
		const o = JSON.parse(text) as { target?: unknown; message?: unknown };
		if (typeof o.target === 'string' && typeof o.message === 'string' && o.target.trim() && o.message) {
			return { target: o.target, message: o.message };
		}
	} catch { /* not JSON */ }
	return null;
}

/** Resolve a tell target to a live terminal name: exact match, then case-insensitive. */
export function resolveTellTarget(target: string, names: string[]): string | null {
	if (names.includes(target)) return target;
	const lc = target.toLowerCase();
	return names.find((n) => n.toLowerCase() === lc) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/god.test.ts`
Expected: PASS (3 describes).

- [ ] **Step 5: Commit**

```bash
git add src/terminals/god.ts tests/god.test.ts
git commit -m "feat(god): tell-request parsing + target resolution helpers"
```

---

## Task 2: Pure helpers — floor snapshot + index formatting

**Files:**
- Modify: `src/terminals/god.ts`
- Test: `tests/god.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/god.test.ts`)

```ts
import { formatFloorSnapshot, formatFloorIndex } from '../src/terminals/god';

describe('formatFloorSnapshot', () => {
  it('renders a header block + fenced recent output', () => {
    const out = formatFloorSnapshot(
      { name: 'Improver 1', repo: 'app', branch: 'wt/main-1', worktreePath: '/w/1', ts: 0 },
      'building...\nok',
    );
    expect(out).toContain('# Improver 1');
    expect(out).toContain('- repo: app');
    expect(out).toContain('- branch: wt/main-1');
    expect(out).toContain('- worktree: /w/1');
    expect(out).toContain('1970-01-01T00:00:00.000Z');
    expect(out).toContain('building...\nok');
  });
});

describe('formatFloorIndex', () => {
  it('lists live terminals with their snapshot filenames', () => {
    const idx = formatFloorIndex([{ id: 2, name: 'Improver 1', repo: 'app', branch: 'wt/main-1' }]);
    expect(idx).toContain('**Improver 1**');
    expect(idx).toContain('2-improver-1.md');
  });
  it('says so when the floor is empty', () => {
    expect(formatFloorIndex([])).toContain('no terminals open');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/god.test.ts`
Expected: FAIL — `formatFloorSnapshot` is not exported.

- [ ] **Step 3: Write minimal implementation** (append to `src/terminals/god.ts`)

```ts
export interface FloorMeta { name: string; repo: string; branch: string; worktreePath: string; ts: number; }

/** One terminal's snapshot file body: a small header + its fenced recent output. */
export function formatFloorSnapshot(meta: FloorMeta, output: string): string {
	return [
		`# ${meta.name}`,
		`- repo: ${meta.repo}`,
		`- branch: ${meta.branch}`,
		`- worktree: ${meta.worktreePath}`,
		`- captured: ${new Date(meta.ts).toISOString()}`,
		'',
		'## recent output',
		'```',
		output,
		'```',
		'',
	].join('\n');
}

export interface FloorTile { id: number; name: string; repo: string; branch: string; }

/** The floor roster GOD reads first to learn the exact terminal names to address. */
export function formatFloorIndex(tiles: FloorTile[]): string {
	const lines = ['# Floor — live terminals', ''];
	if (tiles.length === 0) {
		lines.push('_no terminals open_');
	} else {
		for (const t of tiles) lines.push(`- **${t.name}** — ${t.repo} · ${t.branch}  (snapshot: ${t.id}-${slug(t.name)}.md)`);
	}
	return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/god.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/terminals/god.ts tests/god.test.ts
git commit -m "feat(god): floor snapshot + index formatters"
```

---

## Task 3: Pure helper — GOD system prompt

**Files:**
- Modify: `src/terminals/god.ts`
- Test: `tests/god.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/god.test.ts`)

```ts
import { godSystemPrompt } from '../src/terminals/god';

describe('godSystemPrompt', () => {
  const p = godSystemPrompt([{ name: 'app', path: '/repos/app' }], '/coord');
  it('states the non-autonomous overseer stance', () => {
    expect(p).toMatch(/do not run the floor/i);
    expect(p).toMatch(/user drives/i);
    expect(p).toMatch(/never start work|do not start work|only when asked/i);
  });
  it('tells GOD where to read the floor', () => {
    expect(p).toContain('/coord/floor/INDEX.md');
    expect(p).toContain('/coord/board.md');
    expect(p).toContain('/coord/worktrees.md');
  });
  it('documents cos-coord tell and lists repo paths', () => {
    expect(p).toContain('cos-coord tell');
    expect(p).toContain('/repos/app');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/god.test.ts`
Expected: FAIL — `godSystemPrompt` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `src/terminals/god.ts`)

```ts
export interface GodRepo { name: string; path: string; }

/** GOD's appended system prompt — the entire control surface for "overseer, not boss". */
export function godSystemPrompt(repos: GodRepo[], coordDir: string): string {
	const repoLines = repos.length
		? repos.map((r) => `  - ${r.name} → ${r.path}`).join('\n')
		: '  (no repos added yet)';
	return [
		'You are GOD, the overseer of the Worktree Command Center floor — a single Claude Code',
		'session the user opens in a side console to consult on demand.',
		'',
		'STANCE (important): you do NOT run the floor. The user drives: they talk to the worker',
		'terminals directly and decide what gets done. You do not start work on your own, you do',
		'not assign tasks unprompted, and you do not act until the user asks. Be available, answer',
		'questions about what is happening across the floor, and take action only on request.',
		'',
		'WHAT YOU CAN SEE (read these files with your normal tools):',
		`  - ${coordDir}/floor/INDEX.md — the roster of live worker terminals + their exact names.`,
		`  - ${coordDir}/floor/*.md — each terminal's recent on-screen output (refreshed every few seconds).`,
		`  - ${coordDir}/board.md — the coordination board: locks, START/DONE/NOTE activity.`,
		`  - ${coordDir}/worktrees.md — every worktree's branch, dirty/unpushed counts, and parked work.`,
		'',
		'ACTING (you have full tools):',
		'  - To send a message into a worker terminal, run:  cos-coord tell "<exact terminal name>" "<message>"',
		'    Use the exact names from floor/INDEX.md. The message is typed into that terminal and submitted.',
		'  - To change code in a repo, cd into its path below. Do NOT edit a repo\'s primary checkout',
		'    directly — create a git worktree for your change, the same rule the worker terminals follow.',
		'  - Destructive actions will prompt you for permission right here in this console; that is expected.',
		'',
		'REPOS ON THE FLOOR (name → path):',
		repoLines,
	].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/god.test.ts`
Expected: PASS (all describes).

- [ ] **Step 5: Commit**

```bash
git add src/terminals/god.ts tests/god.test.ts
git commit -m "feat(god): GOD system prompt (overseer, not autonomous boss)"
```

---

## Task 4: `cos-coord tell` — store + CLI

**Files:**
- Modify: `pty-sidecar/coord-store.cjs:88` (after `appendChat`)
- Modify: `pty-sidecar/coord-cli.cjs:36` (after the `chat` command) and the usage string at `:56`
- Test: `tests/coord-store.test.ts`, `tests/coord-cli.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/coord-store.test.ts` (inside the `describe('coord-store', …)` block):

```ts
  it('tell writes one atomic JSON message into god-outbox', () => {
    const file = store.tell(dir, 'Improver 1', 'rebase please');
    expect(fs.existsSync(file)).toBe(true);
    const msg = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(msg.target).toBe('Improver 1');
    expect(msg.message).toBe('rebase please');
    const files = fs.readdirSync(path.join(dir, 'god-outbox')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1); // no leftover .tmp
  });
```

Append to `tests/coord-cli.test.ts` (inside the `describe('cos-coord CLI', …)` block). Note `run()` needs a way to pass `COS_ROLE`; add an optional param:

```ts
  it('tell is a no-op without COS_ROLE=god', () => {
    execFileSync('node', [CLI, 'tell', 'A', 'hello'], {
      env: { ...process.env, COS_COORD_DIR: dir, COS_TERMINAL_ID: '1', COS_TERMINAL_NAME: 'x' }, encoding: 'utf8',
    });
    expect(fs.existsSync(path.join(dir, 'god-outbox'))).toBe(false);
  });
  it('tell from GOD drops a message file', () => {
    execFileSync('node', [CLI, 'tell', 'A', 'hello'], {
      env: { ...process.env, COS_COORD_DIR: dir, COS_TERMINAL_ID: '0', COS_TERMINAL_NAME: 'GOD', COS_ROLE: 'god' }, encoding: 'utf8',
    });
    const files = fs.readdirSync(path.join(dir, 'god-outbox')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const msg = JSON.parse(fs.readFileSync(path.join(dir, 'god-outbox', files[0]), 'utf8'));
    expect(msg).toMatchObject({ target: 'A', message: 'hello' });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/coord-store.test.ts tests/coord-cli.test.ts`
Expected: FAIL — `store.tell is not a function`; CLI tells produce no `god-outbox`.

- [ ] **Step 3: Write minimal implementation**

In `pty-sidecar/coord-store.cjs`, add after `appendChat` (before `module.exports`):

```js
// GOD-only: drop one message for a worker terminal. Atomic temp-file + rename so the
// renderer's outbox watcher never reads a half-written file. One file per message.
function tell(dir, target, message) {
  const outbox = path.join(dir, 'god-outbox');
  fs.mkdirSync(outbox, { recursive: true });
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const final = path.join(outbox, `${ts}-${rand}.json`);
  const tmp = path.join(outbox, `.${ts}-${rand}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ ts, target, message }), 'utf8');
  fs.renameSync(tmp, final);
  return final;
}
```

Update the exports line to include `tell`:

```js
module.exports = { acquire, release, readLocks, readHolder, appendBoard, note, appendChat, tell, sleepSync };
```

In `pty-sidecar/coord-cli.cjs`, add after the `chat` block (after line 39):

```js
  if (cmd === 'tell') {
    if (env('COS_ROLE') !== 'god') process.exit(0); // only GOD may inject into worker terminals
    const target = resource;
    const message = rest.join(' ');
    if (target && message) store.tell(dir, target, message);
    process.exit(0);
  }
```

Update the usage string at the bottom:

```js
  console.error('usage: cos-coord <status|acquire|release|note|chat|tell> [resource] [--reason "…"] [--ttl <sec>]');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/coord-store.test.ts tests/coord-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pty-sidecar/coord-store.cjs pty-sidecar/coord-cli.cjs tests/coord-store.test.ts tests/coord-cli.test.ts
git commit -m "feat(coord): cos-coord tell — GOD-only worker message drop"
```

---

## Task 5: `GodConsole` — docked panel + real claude session

**Files:**
- Create: `src/terminals/god-console.ts`

This is an Electron/xterm component (no unit test); verified by the build in Task 8 and the manual run. It mirrors `terminal-tile.ts`'s session wiring but drops all worktree lifecycle.

- [ ] **Step 1: Write the implementation**

Create `src/terminals/god-console.ts`:

```ts
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import * as fs from 'fs';
import * as path from 'path';
import { SessionBridge } from './session-bridge';
import { godSystemPrompt, type GodRepo } from './god';

export interface GodConsoleOpts {
	repos: GodRepo[];
	coordDir: string;
	sidecarPath: string;
	godHomeDir: string;   // a neutral cwd outside every repo
}

/** GOD: a single privileged claude session in a docked side panel. Real terminal — the
 *  user types directly into it. Hidden (not killed) when toggled off, so re-opening is
 *  instant. No worktree, no branch, no delete-on-close. */
export class GodConsole {
	private el: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private term: Terminal | null = null;
	private fit: FitAddon | null = null;
	private bridge: SessionBridge | null = null;
	private resizeObs: ResizeObserver | null = null;

	constructor(private opts: GodConsoleOpts, private onHide: () => void) {}

	/** The panel root, so the grid can place it in the dock and toggle visibility. */
	get element(): HTMLElement | null { return this.el; }

	render(parent: HTMLElement): void {
		this.el = parent.createDiv({ cls: 'cos-god-panel' });
		const head = this.el.createDiv({ cls: 'cos-god-head' });
		head.createSpan({ text: '🜲 GOD' });
		const hide = head.createEl('button', { text: '×', attr: { title: 'Hide GOD (session keeps running)' } });
		hide.addEventListener('click', (e) => { e.stopPropagation(); this.onHide(); });

		this.bodyEl = this.el.createDiv({ cls: 'cos-god-body' });
		this.term = new Terminal({ fontSize: 12, convertEol: false, cursorBlink: true, scrollback: 5000, theme: { background: '#0e0f17' } });
		this.fit = new FitAddon();
		this.term.loadAddon(this.fit);
		this.term.open(this.bodyEl);
		this.fitSoon();

		const ctxFile = this.writeSystemPromptFile();
		const args: string[] = [];
		if (ctxFile) args.push('--append-system-prompt-file', ctxFile);
		const sidecarDir = path.dirname(this.opts.sidecarPath);
		const env: Record<string, string> = {
			COS_COORD_DIR: this.opts.coordDir,
			COS_TERMINAL_ID: '0',
			COS_TERMINAL_NAME: 'GOD',
			COS_ROLE: 'god',
			PATH: sidecarDir + path.delimiter + (process.env.PATH ?? ''),
		};
		fs.mkdirSync(this.opts.godHomeDir, { recursive: true });
		this.bridge = new SessionBridge(this.opts.sidecarPath, this.opts.godHomeDir, 'claude', args, env);
		this.bridge.onData((d) => this.term?.write(d));
		this.bridge.onExit((code) => this.term?.write(`\r\n[GOD session ended (code ${code ?? '?'})]\r\n`));
		this.term.onData((d) => this.bridge?.write(d));
		this.bridge.start();

		this.resizeObs = new ResizeObserver(() => this.fitSoon());
		this.resizeObs.observe(this.bodyEl);
	}

	/** Show/hide the panel WITHOUT killing the session. Refits on show. */
	setVisible(on: boolean): void {
		if (!this.el) return;
		this.el.style.display = on ? '' : 'none';
		if (on) { this.fitSoon(); this.focus(); }
	}

	focus(): void { this.term?.focus(); }
	blur(): void { this.term?.blur(); }

	private fitSoon(): void {
		window.setTimeout(() => {
			try { this.fit?.fit(); if (this.term) this.bridge?.resize(this.term.cols, this.term.rows); } catch { /* not visible yet */ }
		}, 30);
	}

	/** Write GOD's appended system prompt to his home dir; return the path (or null). */
	private writeSystemPromptFile(): string | null {
		try {
			fs.mkdirSync(this.opts.godHomeDir, { recursive: true });
			const file = path.join(this.opts.godHomeDir, 'god-system-prompt.md');
			fs.writeFileSync(file, godSystemPrompt(this.opts.repos, this.opts.coordDir), 'utf8');
			return file;
		} catch { return null; }
	}

	/** Full teardown — kills the session. */
	dispose(): void {
		this.resizeObs?.disconnect(); this.resizeObs = null;
		this.bridge?.kill(); this.bridge = null;
		this.term?.dispose(); this.term = null;
		this.el?.remove(); this.el = this.bodyEl = null;
	}
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: no errors from `god-console.ts`. (If `SessionBridge`'s constructor/methods differ, align the calls to `src/terminals/session-bridge.ts`.)

- [ ] **Step 3: Commit**

```bash
git add src/terminals/god-console.ts
git commit -m "feat(god): GodConsole — docked privileged claude session"
```

---

## Task 6: Wire GOD into `TerminalsGrid`

**Files:**
- Modify: `src/terminals/terminals-grid.ts`

Adds: import, fields, the 🜲 GOD button, a dock wrapper around the stage, snapshot timer, outbox watcher + delivery, and the watcher ignore-filter fix.

- [ ] **Step 1: Imports + fields**

At the top imports, add:

```ts
import { GodConsole } from './god-console';
import { slug as godSlug, formatFloorSnapshot, formatFloorIndex, parseTellRequest, resolveTellTarget } from './god';
```

Add fields near the other private fields (after `private chatRoom`):

```ts
	private godBtn: HTMLButtonElement | null = null;
	private godConsole: GodConsole | null = null;
	private godVisible = false;
	private stageWrapEl: HTMLElement | null = null;
	private floorTimer: number | null = null;
	private godOutboxWatcher: import('fs').FSWatcher | null = null;
```

- [ ] **Step 2: Add the GOD button** (in `mount()`, right after the `chatBtn` block, before `viewCode`)

```ts
		this.godBtn = controls.createEl('button', { text: '🜲 GOD', cls: 'cos-god-btn' });
		this.godBtn.setAttribute('title', 'Open the GOD overseer console — sees the whole floor, acts on request');
		this.godBtn.addEventListener('click', () => this.toggleGod());
```

- [ ] **Step 3: Wrap the stage in a dock row** (in `mount()`, the first-mount branch `if (!this.stageEl) { … }`)

Replace the stage creation line:

```ts
			this.stageEl = parent.createDiv({ cls: 'cos-terminals-stage' });
```

with a wrapper that holds the stage + (later) the GOD panel side by side:

```ts
			this.stageWrapEl = parent.createDiv({ cls: 'cos-stage-wrap' });
			this.stageEl = this.stageWrapEl.createDiv({ cls: 'cos-terminals-stage' });
```

And in the re-mount `else` branch, replace `parent.appendChild(this.stageEl);` with:

```ts
			parent.appendChild(this.stageWrapEl!);
```

- [ ] **Step 4: Toggle / open / hide GOD** (add these methods near `openChat`)

```ts
	/** Toggle the GOD console: spawn on first open, then just show/hide (session persists). */
	private toggleGod(): void {
		if (!this.godConsole) {
			const godHomeDir = path.join(this.coordDir, '..', '.god', this.deps.group);
			this.godConsole = new GodConsole(
				{ repos: this.repos.map((r) => ({ name: r.name, path: r.path })), coordDir: this.coordDir, sidecarPath: this.sidecarPath, godHomeDir },
				() => this.hideGod(),
			);
			if (this.stageWrapEl) this.godConsole.render(this.stageWrapEl);
			this.godVisible = true;
			this.startFloorFeed();
			this.applyLayout();
			this.godBtn?.toggleClass('cos-god-on', true);
			this.godConsole.focus();
			return;
		}
		if (this.godVisible) this.hideGod();
		else this.showGod();
	}

	private showGod(): void {
		this.godVisible = true;
		this.godConsole?.setVisible(true);
		this.startFloorFeed();
		this.godBtn?.toggleClass('cos-god-on', true);
		this.applyLayout();
	}

	private hideGod(): void {
		this.godVisible = false;
		this.godConsole?.setVisible(false);
		this.stopFloorFeed();
		this.godBtn?.toggleClass('cos-god-on', false);
		this.applyLayout();
	}
```

- [ ] **Step 5: Floor feed (snapshots + outbox)** (add these methods)

```ts
	private floorDir(): string { return path.join(this.coordDir, 'floor'); }
	private outboxDir(): string { return path.join(this.coordDir, 'god-outbox'); }

	/** Begin writing terminal snapshots + watching the GOD outbox while the console is open. */
	private startFloorFeed(): void {
		this.writeFloorSnapshot();
		if (this.floorTimer === null) this.floorTimer = window.setInterval(() => this.writeFloorSnapshot(), 4000);
		try {
			const out = this.outboxDir();
			(require('fs') as typeof import('fs')).mkdirSync(out, { recursive: true });
			this.drainOutbox();
			if (!this.godOutboxWatcher) {
				this.godOutboxWatcher = (require('fs') as typeof import('fs')).watch(out, () => this.drainOutbox());
			}
		} catch { /* outbox unavailable — snapshots still work */ }
	}

	private stopFloorFeed(): void {
		if (this.floorTimer !== null) { window.clearInterval(this.floorTimer); this.floorTimer = null; }
		this.godOutboxWatcher?.close(); this.godOutboxWatcher = null;
	}

	/** Dump each live tile's recent output to coordDir/floor/<id>-<slug>.md + an INDEX.md;
	 *  prune snapshots for tiles that have since closed. */
	private writeFloorSnapshot(): void {
		const fsmod = require('fs') as typeof import('fs');
		try {
			const dir = this.floorDir();
			fsmod.mkdirSync(dir, { recursive: true });
			const now = Date.now();
			const live = new Set<string>(['INDEX.md']);
			for (const t of this.tiles) {
				const fname = `${t.tileId}-${godSlug(t.name)}.md`;
				live.add(fname);
				const body = formatFloorSnapshot(
					{ name: t.name, repo: this.repoNameFor(t), branch: t.branch, worktreePath: t.worktreePath, ts: now },
					t.recentOutput(),
				);
				fsmod.writeFileSync(path.join(dir, fname), body, 'utf8');
			}
			fsmod.writeFileSync(path.join(dir, 'INDEX.md'),
				formatFloorIndex(this.tiles.map((t) => ({ id: t.tileId, name: t.name, repo: this.repoNameFor(t), branch: t.branch }))), 'utf8');
			for (const f of fsmod.readdirSync(dir)) if (f.endsWith('.md') && !live.has(f)) { try { fsmod.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
		} catch { /* best effort */ }
	}

	/** The repo name a tile belongs to (matches the scan/registry mapping). */
	private repoNameFor(t: TerminalTile): string {
		const e = this.lastEntries.find((x) => path.resolve(x.path) === path.resolve(t.worktreePath));
		return e ? e.repo : '?';
	}

	/** Deliver any pending GOD→worker messages, then archive them to .done/. */
	private drainOutbox(): void {
		const fsmod = require('fs') as typeof import('fs');
		const out = this.outboxDir();
		let files: string[] = [];
		try { files = fsmod.readdirSync(out).filter((f) => f.endsWith('.json')); } catch { return; }
		if (!files.length) return;
		const names = this.tiles.map((t) => t.name);
		const done = path.join(out, '.done');
		try { fsmod.mkdirSync(done, { recursive: true }); } catch { /* ignore */ }
		for (const f of files) {
			const full = path.join(out, f);
			let text = '';
			try { text = fsmod.readFileSync(full, 'utf8'); } catch { continue; }
			const req = parseTellRequest(text);
			if (req) {
				const name = resolveTellTarget(req.target, names);
				const tile = name ? this.tiles.find((t) => t.name === name) : undefined;
				if (tile) tile.sendLine(req.message);
				else this.writeGodInbox(`could not deliver to "${req.target}" — not a live terminal. Live: ${names.join(', ') || '(none)'}`);
			}
			try { fsmod.renameSync(full, path.join(done, f)); } catch { try { fsmod.unlinkSync(full); } catch { /* ignore */ } }
		}
	}

	/** Leave GOD an error note he can read back. */
	private writeGodInbox(message: string): void {
		const fsmod = require('fs') as typeof import('fs');
		try {
			const inbox = path.join(this.coordDir, 'god-inbox');
			fsmod.mkdirSync(inbox, { recursive: true });
			fsmod.writeFileSync(path.join(inbox, `${Date.now()}-error.md`), message + '\n', 'utf8');
		} catch { /* best effort */ }
	}
```

- [ ] **Step 6: Fix the coordWatcher rescan loop** (in `mount()`, the `fs.watch(this.coordDir, …)` callback at ~line 127)

Replace the first guard line inside the callback:

```ts
					if (filename === 'worktrees.md') return; // our own ledger write — don't rescan-loop
```

with:

```ts
					const fn = String(filename ?? '');
					// Our own writes / GOD feed dirs must never trigger a worktree rescan loop.
					if (fn === 'worktrees.md' || fn.startsWith('floor') || fn.startsWith('god-outbox') || fn.startsWith('god-inbox')) return;
```

- [ ] **Step 7: Teardown** — fold GOD into `unmount()` and `dispose()`

In `unmount()`, after the chat teardown lines, add:

```ts
		this.stopFloorFeed();
		// GOD survives a tab switch (like the tiles): detach with the stage wrap, keep the session.
		this.stageWrapEl?.remove();
```

Replace the existing `this.stageEl?.remove();` line in `unmount()` with nothing (the wrap removal above replaces it).

In `dispose()`, after the loop that kills tiles, add:

```ts
		this.godConsole?.dispose(); this.godConsole = null;
```

- [ ] **Step 8: Type-check + full test run**

Run: `npx tsc -noEmit -skipLibCheck && npx vitest run`
Expected: no type errors; all tests pass (existing + Tasks 1–4).

- [ ] **Step 9: Commit**

```bash
git add src/terminals/terminals-grid.ts
git commit -m "feat(god): dock GOD console into the grid — feed, delivery, toggle"
```

---

## Task 7: Dock + GOD panel styling

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: Add styles** (append to `styles.css`)

```css
/* GOD overseer console — docked beside the bubbling stage. */
.cos-stage-wrap { display: flex; flex: 1; min-height: 0; position: relative; }
.cos-stage-wrap > .cos-terminals-stage { flex: 1 1 auto; min-width: 0; }
.cos-god-panel {
	flex: 0 0 380px; display: flex; flex-direction: column;
	border-left: 1px solid #2a2c3a; background: #0e0f17; min-width: 0;
}
.cos-god-head {
	display: flex; align-items: center; justify-content: space-between;
	padding: 4px 8px; background: #171925; color: #e7c97a;
	font-weight: 600; letter-spacing: 0.04em;
}
.cos-god-head button { background: transparent; border: none; color: #aab; cursor: pointer; font-size: 14px; }
.cos-god-head button:hover { color: #fff; }
.cos-god-body { flex: 1 1 auto; min-height: 0; padding: 4px; }
.cos-god-btn.cos-god-on { background: #3a2d10; color: #f4d35e; }
```

- [ ] **Step 2: Commit**

```bash
git add styles.css
git commit -m "style(god): dock layout + GOD panel chrome"
```

---

## Task 8: Build + manual integration verification

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: `tsc` clean, esbuild bundles with no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all green (existing suites + `god`, `coord-store`, `coord-cli` additions).

- [ ] **Step 3: Manual run** (documented checklist — requires a real machine with `claude` on PATH)

Run: `npm start`. Then:
- Add a folder, hit ▶ Play twice to get two worker terminals.
- Click 🜲 GOD — the stage shrinks and a GOD console docks on the right with a live claude session; tiles reflow.
- In GOD, ask "what's on the floor?" — confirm he reads `floor/INDEX.md` + the snapshot files and answers with the terminal names/branches.
- In GOD, run `cos-coord tell "<one terminal name>" "say hello in one word"` — confirm the line appears and submits in that worker terminal.
- Click × on the GOD header — panel hides, stage reclaims width, session keeps running; click 🜲 GOD again — same session reappears.
- Verify no runaway worktree rescanning (the board/registry aren't refreshing in a tight loop).

- [ ] **Step 4: Confirm the floor dir is not committed into any repo**

GOD's home + the floor/outbox dirs live under the app's `userData/.coordination` and `.god` — outside every repo — so nothing dirties a worktree. Confirm `git status` in a worker's repo shows only that worktree's own work.

---

## Self-Review

- **Spec coverage:** §3.1 GOD session → Task 5 + Task 6 toggle. §3.2 snapshot writer → Task 6 Step 5. §3.3 tell channel → Task 4 (CLI/store) + Task 6 (drain/deliver). §3.4 pure helpers → Tasks 1–3. §4 UI dock → Task 6 Steps 2–4 + Task 7. §5 rescan-loop risk → Task 6 Step 6; atomic writes → Task 4; .done archive + unknown-target inbox → Task 6 Step 5. §6 testing → Tasks 1–4 + Task 8. §7 out-of-scope items are not implemented (correct).
- **Type consistency:** `GodRepo {name,path}` defined in Task 3, consumed by `GodConsole` (Task 5) and built from `RepoConfig` in Task 6. `slug` imported as `godSlug` in the grid to avoid colliding with any local name. `formatFloorSnapshot`/`formatFloorIndex`/`parseTellRequest`/`resolveTellTarget` signatures match their Task 1–2 definitions and Task 6 call sites. `tell` exported from `coord-store.cjs` and called in `coord-cli.cjs`.
- **Placeholder scan:** none — every code step is concrete.
- **Known dependency to verify during execution:** `SessionBridge`'s exact constructor/method names (Task 5 Step 2 type-check catches any mismatch against `session-bridge.ts`).
