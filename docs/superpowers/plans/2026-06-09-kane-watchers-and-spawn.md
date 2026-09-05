---
status: stable
---

# Kane Watchers & Spawn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Kane register one-shot "when terminal X finishes, do this" watches and spawn-and-start new worktree terminals, both via Kane-only `cos-coord` verbs.

**Architecture:** Extend the existing `cos-coord` → `god-outbox/` → grid-drain channel with tagged `watch`/`spawn` messages. The grid keeps in-memory watchers fired from `handleReady` (skipping prompt-stalls) that notify Kane's console, and a shared `spawnWorktree` core used by both the Play button and Kane.

**Tech Stack:** TypeScript, Electron, xterm.js, node-pty (sidecar), vitest; coordination CLI is CommonJS.

Spec: `docs/superpowers/specs/2026-06-09-kane-watchers-and-spawn-design.md`

---

## File Structure

- **Modify** `src/terminals/god.ts` — replace `parseTellRequest` with `parseOutboxMessage` (discriminated union); extend `godSystemPrompt`.
- **Modify** `pty-sidecar/coord-store.cjs` — `dropOutbox` helper; `tell`/`watch`/`spawn` writers.
- **Modify** `pty-sidecar/coord-cli.cjs` — `watch` + `spawn` verbs (god-only).
- **Modify** `src/terminals/god-console.ts` — `notify(text)`.
- **Modify** `src/terminals/terminals-grid.ts` — drain dispatch, `watchers` registry + fire in `handleReady`, `spawnWorktree` refactor + `spawnFromKane` + `pendingTask`.
- **Modify** `tests/god.test.ts`, `tests/coord-store.test.ts`, `tests/coord-cli.test.ts`.

---

## Task 1: Generalize the outbox parser

**Files:**
- Modify: `src/terminals/god.ts`
- Test: `tests/god.test.ts`

- [ ] **Step 1: Replace the `parseTellRequest` tests** in `tests/god.test.ts`

Replace the existing `import` line and the `describe('parseTellRequest', …)` block with:

```ts
import {
  parseOutboxMessage, resolveTellTarget, slug,
  formatFloorSnapshot, formatFloorIndex, godSystemPrompt,
} from '../src/terminals/god';

describe('parseOutboxMessage', () => {
  it('parses a tell (and treats an untagged target+message as tell)', () => {
    expect(parseOutboxMessage('{"kind":"tell","target":"Improver 1","message":"rebase"}'))
      .toEqual({ kind: 'tell', target: 'Improver 1', message: 'rebase' });
    expect(parseOutboxMessage('{"ts":1,"target":"A","message":"hi"}'))
      .toEqual({ kind: 'tell', target: 'A', message: 'hi' });
  });
  it('parses a watch', () => {
    expect(parseOutboxMessage('{"kind":"watch","target":"A","note":"run tests"}'))
      .toEqual({ kind: 'watch', target: 'A', note: 'run tests' });
  });
  it('parses a spawn with and without a base', () => {
    expect(parseOutboxMessage('{"kind":"spawn","repo":"app","base":"main","task":"do X"}'))
      .toEqual({ kind: 'spawn', repo: 'app', base: 'main', task: 'do X' });
    expect(parseOutboxMessage('{"kind":"spawn","repo":"app","task":"do X"}'))
      .toEqual({ kind: 'spawn', repo: 'app', base: null, task: 'do X' });
  });
  it('rejects malformed / missing fields', () => {
    expect(parseOutboxMessage('not json')).toBeNull();
    expect(parseOutboxMessage('{"kind":"tell","target":"A"}')).toBeNull();
    expect(parseOutboxMessage('{"kind":"watch","target":"  ","note":"x"}')).toBeNull();
    expect(parseOutboxMessage('{"kind":"spawn","repo":"app"}')).toBeNull();
    expect(parseOutboxMessage('{"kind":"bogus"}')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/god.test.ts`
Expected: FAIL — `parseOutboxMessage` not exported.

- [ ] **Step 3: Replace `parseTellRequest` in `src/terminals/god.ts`**

Replace the `TellRequest` interface + `parseTellRequest` function with:

```ts
export type OutboxMessage =
	| { kind: 'tell'; target: string; message: string }
	| { kind: 'watch'; target: string; note: string }
	| { kind: 'spawn'; repo: string; base: string | null; task: string };

/** Parse one god-outbox JSON message into a typed command. An untagged {target,message} is
 *  read as a tell (back-compat). Returns null on malformed / missing fields. */
export function parseOutboxMessage(text: string): OutboxMessage | null {
	let o: { kind?: unknown; target?: unknown; message?: unknown; note?: unknown; repo?: unknown; base?: unknown; task?: unknown };
	try { o = JSON.parse(text); } catch { return null; }
	if (!o || typeof o !== 'object') return null;
	const kind = typeof o.kind === 'string' ? o.kind : 'tell';
	if (kind === 'tell') {
		if (typeof o.target === 'string' && typeof o.message === 'string' && o.target.trim() && o.message) {
			return { kind: 'tell', target: o.target, message: o.message };
		}
	} else if (kind === 'watch') {
		if (typeof o.target === 'string' && typeof o.note === 'string' && o.target.trim() && o.note) {
			return { kind: 'watch', target: o.target, note: o.note };
		}
	} else if (kind === 'spawn') {
		if (typeof o.repo === 'string' && typeof o.task === 'string' && o.repo.trim() && o.task) {
			const base = typeof o.base === 'string' && o.base.trim() ? o.base : null;
			return { kind: 'spawn', repo: o.repo, base, task: o.task };
		}
	}
	return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/god.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/terminals/god.ts tests/god.test.ts
git commit -m "feat(god): parseOutboxMessage — typed tell/watch/spawn parsing"
```

---

## Task 2: `cos-coord watch` + `spawn` (store + CLI)

**Files:**
- Modify: `pty-sidecar/coord-store.cjs`
- Modify: `pty-sidecar/coord-cli.cjs`
- Test: `tests/coord-store.test.ts`, `tests/coord-cli.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/coord-store.test.ts` (inside `describe('coord-store', …)`):

```ts
  it('watch + spawn drop tagged outbox files', () => {
    store.watch(dir, 'Improver 1', 'run tests after');
    store.spawn(dir, 'app', 'main', 'do X');
    const files = fs.readdirSync(path.join(dir, 'god-outbox')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(2);
    const msgs = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'god-outbox', f), 'utf8')));
    expect(msgs.find((m) => m.kind === 'watch')).toMatchObject({ target: 'Improver 1', note: 'run tests after' });
    expect(msgs.find((m) => m.kind === 'spawn')).toMatchObject({ repo: 'app', base: 'main', task: 'do X' });
  });
```

Append to `tests/coord-cli.test.ts` (inside `describe('cos-coord CLI', …)`):

```ts
  it('watch/spawn are god-only and drop tagged files', () => {
    // No role → no-op
    execFileSync('node', [CLI, 'watch', 'A', '--note', 'x'], {
      env: { ...process.env, COS_COORD_DIR: dir, COS_TERMINAL_ID: '1', COS_TERMINAL_NAME: 'x' }, encoding: 'utf8',
    });
    expect(fs.existsSync(path.join(dir, 'god-outbox'))).toBe(false);
    // As god → files appear
    const god = { ...process.env, COS_COORD_DIR: dir, COS_TERMINAL_ID: '0', COS_TERMINAL_NAME: 'Kane', COS_ROLE: 'god' };
    execFileSync('node', [CLI, 'watch', 'A', '--note', 'run tests'], { env: god, encoding: 'utf8' });
    execFileSync('node', [CLI, 'spawn', 'app', '--base', 'main', '--task', 'do X'], { env: god, encoding: 'utf8' });
    const msgs = fs.readdirSync(path.join(dir, 'god-outbox')).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'god-outbox', f), 'utf8')));
    expect(msgs.find((m) => m.kind === 'watch')).toMatchObject({ target: 'A', note: 'run tests' });
    expect(msgs.find((m) => m.kind === 'spawn')).toMatchObject({ repo: 'app', base: 'main', task: 'do X' });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/coord-store.test.ts tests/coord-cli.test.ts`
Expected: FAIL — `store.watch is not a function`; no `god-outbox` from CLI.

- [ ] **Step 3: Implement in `pty-sidecar/coord-store.cjs`**

Replace the existing `tell` function with a shared `dropOutbox` + three writers:

```js
// GOD-only outbox: drop one atomic JSON command for the renderer to drain. temp + rename so
// the watcher never reads a half-written file; one file per message.
function dropOutbox(dir, obj) {
  const outbox = path.join(dir, 'god-outbox');
  fs.mkdirSync(outbox, { recursive: true });
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const final = path.join(outbox, `${ts}-${rand}.json`);
  const tmp = path.join(outbox, `.${ts}-${rand}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ ts, ...obj }), 'utf8');
  fs.renameSync(tmp, final);
  return final;
}
function tell(dir, target, message) { return dropOutbox(dir, { kind: 'tell', target, message }); }
function watch(dir, target, note) { return dropOutbox(dir, { kind: 'watch', target, note }); }
function spawn(dir, repo, base, task) { return dropOutbox(dir, { kind: 'spawn', repo, base: base || null, task }); }
```

Update the exports line:

```js
module.exports = { acquire, release, readLocks, readHolder, appendBoard, note, appendChat, tell, watch, spawn, dropOutbox, sleepSync };
```

- [ ] **Step 4: Implement in `pty-sidecar/coord-cli.cjs`**

After the existing `tell` block, add:

```js
  if (cmd === 'watch') {
    if (env('COS_ROLE') !== 'god') process.exit(0);
    const target = resource;
    const note = flag(rest, '--note') || '';
    if (target && note) store.watch(dir, target, note);
    process.exit(0);
  }

  if (cmd === 'spawn') {
    if (env('COS_ROLE') !== 'god') process.exit(0);
    const repo = resource;
    const base = flag(rest, '--base') || '';
    const task = flag(rest, '--task') || '';
    if (repo && task) store.spawn(dir, repo, base, task);
    process.exit(0);
  }
```

Update the usage string:

```js
  console.error('usage: cos-coord <status|acquire|release|note|chat|tell|watch|spawn> [resource] [--reason "…"] [--ttl <sec>] [--note "…"] [--base <branch>] [--task "…"]');
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run tests/coord-store.test.ts tests/coord-cli.test.ts`
Expected: PASS (existing tell tests still pass — extra `kind`/`ts` fields don't break `toMatchObject`).

- [ ] **Step 6: Commit**

```bash
git add pty-sidecar/coord-store.cjs pty-sidecar/coord-cli.cjs tests/coord-store.test.ts tests/coord-cli.test.ts
git commit -m "feat(coord): cos-coord watch + spawn (GOD-only outbox verbs)"
```

---

## Task 3: `GodConsole.notify()`

**Files:**
- Modify: `src/terminals/god-console.ts`

- [ ] **Step 1: Add the method** (after `focus()`/`blur()`)

```ts
	/** Inject a line into Kane's session (text + a separated Enter so ConPTY can't coalesce
	 *  them) — used to ping him when a watch fires. */
	notify(text: string): void {
		this.bridge?.write(text);
		window.setTimeout(() => this.bridge?.write('\r'), 40);
	}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/terminals/god-console.ts
git commit -m "feat(god): GodConsole.notify — inject a line into Kane's session"
```

---

## Task 4: Grid — drain dispatch, watchers, spawn

**Files:**
- Modify: `src/terminals/terminals-grid.ts`

- [ ] **Step 1: Imports + fields**

Change the god import line to use the new parser, and add `looksLikePrompt`:

```ts
import { slug as godSlug, formatFloorSnapshot, formatFloorIndex, parseOutboxMessage, resolveTellTarget } from './god';
import { looksLikeMenu } from './prompt-detect';
import { looksLikePrompt } from './chat-room';
```

Add fields near `private godConsole`:

```ts
	private watchers: Array<{ target: string; note: string }> = [];
	private pendingTask = new Map<number, string>();
```

- [ ] **Step 2: Dispatch in `drainOutbox()`**

Replace the body of the `for (const f of files)` loop in `drainOutbox()` with:

```ts
		for (const f of files) {
			const full = path.join(out, f);
			let text = '';
			try { text = fsSync.readFileSync(full, 'utf8'); } catch { continue; }
			const msg = parseOutboxMessage(text);
			if (msg) this.dispatchOutbox(msg, names);
			try { fsSync.renameSync(full, path.join(done, f)); } catch { try { fsSync.unlinkSync(full); } catch { /* ignore */ } }
		}
	}

	/** Act on one parsed Kane command. */
	private dispatchOutbox(msg: import('./god').OutboxMessage, liveNames: string[]): void {
		if (msg.kind === 'tell') {
			const name = resolveTellTarget(msg.target, liveNames);
			const tile = name ? this.allSessions().find((t) => t.name === name) : undefined;
			if (tile) tile.sendLine(msg.message);
			else this.writeGodInbox(`could not deliver to "${msg.target}" — not a live terminal. Live: ${liveNames.join(', ') || '(none)'}`);
		} else if (msg.kind === 'watch') {
			const name = resolveTellTarget(msg.target, liveNames);
			if (name) { this.watchers.push({ target: name, note: msg.note }); }
			else this.writeGodInbox(`cannot watch "${msg.target}" — not a live terminal. Live: ${liveNames.join(', ') || '(none)'}`);
		} else if (msg.kind === 'spawn') {
			void this.spawnFromKane(msg.repo, msg.base, msg.task);
		}
	}
```

(Delete the old inline `parseTellRequest`/resolve/deliver code that this replaces.)

- [ ] **Step 3: Fire watchers + deliver pending task in `handleReady`**

Replace `handleReady` with (watcher fire FIRST, before the early returns):

```ts
	private handleReady(t: TerminalTile): void {
		// Fire any one-shot watch whose target just finished — idle and NOT stalled on a prompt.
		if (this.watchers.some((w) => w.target === t.name)) {
			const out = t.recentOutput();
			if (!looksLikePrompt(out) && !looksLikeMenu(out)) {
				const fired = this.watchers.filter((w) => w.target === t.name);
				this.watchers = this.watchers.filter((w) => w.target !== t.name);
				for (const w of fired) this.godConsole?.notify(`[watch] terminal "${t.name}" finished — you asked: ${w.note}`);
			}
		}
		// Deliver a Kane-spawned terminal's initial task once it's first ready.
		const task = this.pendingTask.get(t.tileId);
		if (task !== undefined) { this.pendingTask.delete(t.tileId); t.sendLine(task); }

		if (this.hidden.includes(t)) return; // a hidden, background session never steals the center
		if (this.chatRoom) { this.chatRoom.noteIdle(t.name); return; } // chat owns idle while open
		const r = rqReady(this.q, t.tileId);
		this.q = r.state;
		// Auto-lock: don't let a sibling going idle steal focus while you're mid-way through a
		// selection menu in the centered tile.
		const cur = this.centeredTile();
		if (cur && cur.tileId !== t.tileId && looksLikeMenu(cur.recentOutput())) return;
		if (!this.locked && r.center !== null) this.doCenter(r.center);
	}
```

- [ ] **Step 4: Refactor `play()` to a shared `spawnWorktree` + add `spawnFromKane`**

Replace `play()` with:

```ts
	private async play(): Promise<void> {
		const repo = this.selectedRepo();
		const base = this.branchSel?.value;
		if (!repo || !base) { this.deps.toast('Pick a repo and branch first'); return; }
		await this.spawnWorktree(repo, base, {});
	}

	/** Shared spawn core: create a worktree + tile, render, persist, layout. Optionally queue an
	 *  initial task to send once the new session is first ready. Returns the tile (or null). */
	private async spawnWorktree(repo: RepoConfig, base: string, opts: { task?: string }): Promise<TerminalTile | null> {
		try {
			const branches = await listBranches(repo.path);
			const branch = this.pendingNewBranch ?? nextWorktreeBranch(branches, base);
			this.pendingNewBranch = null;
			const worktree = await createWorktree(repo.path, repo.name, base, branch, this.notifyScriptPath, this.coordHookPath);
			const tile = this.makeTile(worktree, repo.name, repo.path, base, false);
			if (opts.task) this.pendingTask.set(tile.tileId, opts.task);
			if (this.stageEl) tile.render(this.stageEl);
			this.tiles.push(tile);
			void this.persist();
			this.applyLayout();
			return tile;
		} catch (e) {
			this.deps.toast(`Worktree failed: ${(e as Error).message}`);
			return null;
		}
	}

	/** Kane asked to spawn a terminal: resolve the repo by name, default the base branch, start
	 *  it on the given task. */
	private async spawnFromKane(repoName: string, base: string | null, task: string): Promise<void> {
		const repo = this.repos.find((r) => r.name === repoName)
			?? this.repos.find((r) => r.name.toLowerCase() === repoName.toLowerCase());
		if (!repo) { this.writeGodInbox(`cannot spawn — unknown repo "${repoName}". Known: ${this.repos.map((r) => r.name).join(', ') || '(none)'}`); return; }
		let baseBranch = base;
		if (!baseBranch) { baseBranch = defaultBranch(await listBranches(repo.path)) ?? 'main'; }
		await this.spawnWorktree(repo, baseBranch, { task });
	}
```

(`defaultBranch` is already imported from `./worktree-manager`.)

- [ ] **Step 5: Type-check + full test run**

Run: `npx tsc -noEmit -skipLibCheck && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/terminals/terminals-grid.ts
git commit -m "feat(grid): Kane watchers + spawn — drain dispatch, fire-on-finish, spawnWorktree"
```

---

## Task 5: Document the new commands in Kane's prompt

**Files:**
- Modify: `src/terminals/god.ts`
- Test: `tests/god.test.ts`

- [ ] **Step 1: Extend the `godSystemPrompt` test** (in the `describe('godSystemPrompt', …)` block)

Add:

```ts
  it('documents the watch and spawn commands', () => {
    expect(p).toContain('cos-coord watch');
    expect(p).toContain('cos-coord spawn');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/god.test.ts`
Expected: FAIL — prompt lacks `cos-coord watch`/`spawn`.

- [ ] **Step 3: Extend `godSystemPrompt`** — in the `ACTING` section of `src/terminals/god.ts`, after the `cos-coord tell` bullet, add:

```ts
		'  - To be pinged when a terminal finishes its current work, run:',
		'    cos-coord watch "<exact terminal name>" --note "<what you will do when it finishes>"',
		'    You get a [watch] line here when it goes idle (not while it is just paused on a prompt); then do the thing.',
		'  - To open a NEW worktree terminal and start it on a task, run:',
		'    cos-coord spawn "<repo>" --base "<branch>" --task "<first instruction>"',
		'    --base is optional (defaults to the repo\'s main). Repo names + paths are listed below.',
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/god.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/terminals/god.ts tests/god.test.ts
git commit -m "docs(god): document cos-coord watch + spawn in Kane's prompt"
```

---

## Task 6: Build + manual verification

- [ ] **Step 1: Full build + suite**

Run: `npm run build && npm test`
Expected: tsc + esbuild clean; all tests green.

- [ ] **Step 2: Manual (requires `npm start`, real `claude`)**

- Open Kane; with a worker running a task, in Kane run `cos-coord watch "<worker name>" --note "say done"`. When the worker finishes (and isn't on a prompt), confirm a `[watch] terminal "…" finished — you asked: say done` line appears in Kane and he acts.
- In Kane run `cos-coord spawn "<repo>" --task "print hello and stop"`. Confirm a new worktree tile appears and the task lands once it boots.
- Verify a watch on a terminal that's stalled on a permission prompt does NOT fire until the prompt is answered and it actually finishes.

---

## Self-Review

- **Spec coverage:** §3.1 verbs → Task 2. §3.2 parser → Task 1. §3.3 dispatch → Task 4 Step 2. §3.4 watchers + fire → Task 4 Steps 1,3. §3.5 notify → Task 3. §3.6 spawn (spawnWorktree refactor + spawnFromKane + pendingTask) → Task 4 Steps 1,3,4. §3.7 prompt → Task 5. §5 tests → Tasks 1,2,5 + Task 6 manual.
- **Type consistency:** `OutboxMessage` union defined in Task 1, consumed by `dispatchOutbox` (Task 4) via `import('./god').OutboxMessage`. `parseOutboxMessage` replaces `parseTellRequest` at its sole call site (drainOutbox, Task 4 Step 2). `watchers`/`pendingTask` fields (Task 4 Step 1) used in Steps 3–4. `store.watch/spawn` (Task 2) called by CLI (Task 2). `notify` (Task 3) called in `handleReady` (Task 4 Step 3). `defaultBranch`, `nextWorktreeBranch`, `createWorktree`, `makeTile` already imported in the grid.
- **Placeholder scan:** none — all steps are concrete code.
- **Note:** Task 4 Step 2 removes the old inline tell-delivery code in `drainOutbox`; the engineer must delete those lines when inserting `dispatchOutbox`.
