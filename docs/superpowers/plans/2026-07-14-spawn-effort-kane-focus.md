---
status: stable
---

# Spawn Effort + Kane Spawn Flags + Focus Discipline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Effort dropdown beside the model dropdown (incl. ultracode), `cos-coord spawn --model/--effort` for Kane, no focus theft while typing in Kane, a 30 s manual-switch hold, and Alt+K to open/focus Kane.

**Architecture:** Effort mirrors the model dropdown's existing threading (`SPAWN_*` const → `<select>` → `spawnWorktree` opts → `TerminalTileOpts` → `--effort` arg → `SessionRecord`), with the dropdown fallback centralized in `spawnWorktree`. Kane's flags ride the existing `coord-cli → coord-store → god-outbox JSON → parseOutboxMessage → dispatchOutbox` pipeline. Focus fixes are grid-local state (`godFocused`, `holdUntil`) consulted by the single `autoCenter()` funnel.

**Tech Stack:** TypeScript (renderer, `src/`), plain CommonJS (`pty-sidecar/*.cjs`), vitest.

**Spec:** `docs/superpowers/specs/2026-07-14-spawn-effort-kane-focus-design.md`

## Global Constraints

- NEVER launch the app (`electron .`, `npm start`, any packaged/unpacked exe) or any `claude` interactive session. The only permitted `claude` invocations are the two non-interactive CLI validation commands in Task 1 Step 4.
- Style: tabs for indentation, single quotes; match each file's existing comment density and voice.
- `pty-sidecar/*.cjs` are plain CJS run by system node — no TypeScript syntax there.
- Effort levels are exactly `['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']`, empty string = inherit CLI default (no flag).
- Two existing exact-equality spawn assertions in `tests/god.test.ts:18-23` are deliberately updated (they gain `model: null, effort: null`) — that is the ONLY permitted change to existing test expectations.
- Other Claude terminals are active in this repo — commit only in this worktree (branch `wt/main-1`), never switch branches.
- Full suite: `npm test` (vitest). Typecheck rides `npm run build`'s `tsc -noEmit` — but do NOT run `npm run build` gratuitously; `npx tsc -noEmit -skipLibCheck` is the check.

---

### Task 1: Effort spawn plumbing (dropdown → `--effort` → persistence)

**Files:**
- Modify: `src/terminals/god.ts` (add `EFFORT_LEVELS` export near the top, after `slug`)
- Modify: `src/terminals/terminals-grid.ts` (`SPAWN_EFFORTS` const, `effortSel` field + mount, `play`, `spawnWorktree`, `makeTile`, `SessionRecord`, session-restore call)
- Modify: `src/terminals/terminal-tile.ts` (`TerminalTileOpts.effort`, `--effort` arg, `sessionRecord()`)
- Test: `tests/god.test.ts` (new `EFFORT_LEVELS` describe)

**Interfaces:**
- Consumes: existing model threading (`SPAWN_MODELS` at `terminals-grid.ts:48`, `modelSel` at `:153`, `--model` at `terminal-tile.ts:458`).
- Produces: `EFFORT_LEVELS: readonly ['low','medium','high','xhigh','max','ultracode']` (from `./god`); `spawnWorktree(repo, base, opts: { task?: string; model?: string; effort?: string })` with dropdown fallback inside; `makeTile(..., model?: string, effort?: string)`; `TerminalTileOpts.effort?: string`. Task 2 relies on all of these.

- [ ] **Step 1: Write the failing test** — in `tests/god.test.ts`, add `EFFORT_LEVELS` to the existing import from `../src/terminals/god`, and add:

```ts
describe('EFFORT_LEVELS', () => {
	it('lists the six claude CLI effort levels, ultracode last', () => {
		expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/god.test.ts`
Expected: FAIL — `EFFORT_LEVELS` is not exported.

- [ ] **Step 3: Implement** — all four files:

`src/terminals/god.ts`, after the `slug` function:

```ts
/** The claude CLI's accepted --effort levels, lowest → highest (ultracode adds
 *  autonomous multi-agent orchestration on top of max). '' (no flag) = CLI default. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;
```

`src/terminals/terminals-grid.ts` — add `EFFORT_LEVELS` to the existing `./god` import. Below `SPAWN_MODELS` (line 54):

```ts
// Effort options for the spawn toolbar dropdown. Empty value = inherit the claude CLI default.
const SPAWN_EFFORTS: { label: string; value: string }[] = [
	{ label: 'Effort: Default', value: '' },
	...EFFORT_LEVELS.map((l) => ({ label: l === 'xhigh' ? 'XHigh' : l[0]!.toUpperCase() + l.slice(1), value: l })),
];
```

Field, after `private modelSel: HTMLSelectElement | null = null;` (line 74):

```ts
	private effortSel: HTMLSelectElement | null = null;
```

In `mount()`, after the `modelSel` block (lines 153-155):

```ts
		this.effortSel = controls.createEl('select');
		this.effortSel.title = 'Effort for new terminals';
		for (const m of SPAWN_EFFORTS) this.effortSel.createEl('option', { text: m.label, value: m.value });
```

`play()` (line 370) — the dropdown fallback moves into `spawnWorktree`, so:

```ts
		await this.spawnWorktree(repo, base, {});
```

`spawnWorktree` (line 375) — new opts type + fallback + threading (the `makeTile` call is line 381):

```ts
	private async spawnWorktree(repo: RepoConfig, base: string, opts: { task?: string; model?: string; effort?: string }): Promise<TerminalTile | null> {
		try {
			const branches = await listBranches(repo.path);
			const branch = this.pendingNewBranch ?? nextWorktreeBranch(branches, base);
			this.pendingNewBranch = null;
			const worktree = await createWorktree(repo.path, repo.name, base, branch, this.notifyScriptPath, this.coordHookPath);
			// Explicit opts win; otherwise inherit the toolbar dropdowns ('' = CLI default = no flag).
			const model = opts.model ?? (this.modelSel?.value || undefined);
			const effort = opts.effort ?? (this.effortSel?.value || undefined);
			const tile = this.makeTile(worktree, repo.name, repo.path, base, false, undefined, model, effort);
```

(rest of the method body unchanged.)

`makeTile` (line 962) — signature gains `effort?: string` after `model?: string`, and the `TerminalTileOpts` object it builds gains `effort,` right after `model,` (line 971).

`SessionRecord` (line 45) — add `effort?: string;` after `model?: string;`. The session-restore `makeTile` call (line 1044) gains `, rec.effort` after `rec.model`.

`src/terminals/terminal-tile.ts`:
- `TerminalTileOpts` — after `model?: string;` (line 33): `effort?: string;`
- `startSession` — after the model line (line 458):

```ts
		if (this.opts.effort) args.push('--effort', this.opts.effort);
```

- `sessionRecord()` (lines 411-421) — return type gains `effort?: string` after `model?: string`, and the object gains, after the model spread:

```ts
			...(this.opts.effort ? { effort: this.opts.effort } : {}),
```

- [ ] **Step 4: CLI acceptance check for `ultracode` (no app, no session)**

Run: `claude --effort bogus -p x --model claude-haiku-4-5-20251001`
Expected: immediate LOCAL error (non-zero exit, no API output) whose message lists the valid effort values. Confirm `ultracode` is among them → done, record the message in your report.
If (and only if) the CLI does NOT reject locally (it starts printing a response — let the tiny haiku call finish, do not kill your shell), run: `claude --effort ultracode -p "reply with just: ok" --model claude-haiku-4-5-20251001` — Expected: exit 0 and a response, proving acceptance.
If `ultracode` is rejected: remove it from `EFFORT_LEVELS` (and Step 1's expected array), note it prominently in your report, and continue — the feature stands without it.

- [ ] **Step 5: Typecheck + tests**

Run: `npx tsc -noEmit -skipLibCheck` → clean. Then `npm test` → all pass (185+ tests).

- [ ] **Step 6: Commit**

```powershell
git add src/terminals/god.ts src/terminals/terminals-grid.ts src/terminals/terminal-tile.ts tests/god.test.ts
git commit -m @'
feat(spawn): effort dropdown — pick the reasoning effort for new terminals

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 2: Kane spawn `--model` / `--effort` / `--name` + `rename` verb

**Files:**
- Modify: `pty-sidecar/coord-cli.cjs` (spawn branch lines 57-64, new rename branch, usage line 87)
- Modify: `pty-sidecar/coord-store.cjs` (`spawn` function line 108, new `rename` function + export)
- Modify: `src/terminals/god.ts` (`OutboxMessage` line 12, `parseOutboxMessage` lines 17-39, `godSystemPrompt` lines 109-111)
- Modify: `src/terminals/terminals-grid.ts` (`dispatchOutbox` lines 693-708, `spawnFromKane` lines 394-400, `spawnFromName` lines 572-579)
- Test: `tests/god.test.ts`, `tests/coord-cli.test.ts`, `tests/coord-store.test.ts`

Line numbers above are pre-Task-1; Task 1 added ~25 lines to `terminals-grid.ts` — locate by the quoted code, not the number.

**Interfaces:**
- Consumes: `EFFORT_LEVELS` and `spawnWorktree`'s `{ task, model, effort, name }` opts from Task 1 (Task 1 shipped `{ task, model, effort }`; this task adds `name?: string` to the opts type and threads it to `makeTile`'s existing 6th parameter).
- Consumes: `TerminalTile.setName(name)` (`terminal-tile.ts:405`) — sets displayName, fires `onRename` (grid persists). `resolveTellTarget` from `./god`.
- Produces: `store.spawn(dir, repo, base, task, model, effort, name)`; `store.rename(dir, target, to)`; outbox JSONs `{ kind:'spawn', repo, base, task, model: string|null, effort: string|null, name: string|null }` and `{ kind:'rename', target, name }`; `OutboxMessage` spawn variant with `model`/`effort`/`name` + new rename variant; `spawnFromName(repoName, base, task, model?: string, effort?: string, name?: string)`.

- [ ] **Step 1: Write the failing tests**

`tests/god.test.ts` — UPDATE the two exact-equality assertions in the existing `'parses a spawn with and without a base'` test (lines 18-23) to expect `model: null, effort: null`:

```ts
	it('parses a spawn with and without a base', () => {
		expect(parseOutboxMessage('{"kind":"spawn","repo":"app","base":"main","task":"do X"}'))
			.toEqual({ kind: 'spawn', repo: 'app', base: 'main', task: 'do X', model: null, effort: null, name: null });
		expect(parseOutboxMessage('{"kind":"spawn","repo":"app","task":"do X"}'))
			.toEqual({ kind: 'spawn', repo: 'app', base: null, task: 'do X', model: null, effort: null, name: null });
	});
```

ADD below it:

```ts
	it('parses spawn model/effort/name, lowercasing effort and nulling junk', () => {
		expect(parseOutboxMessage('{"kind":"spawn","repo":"app","task":"x","model":"opus","effort":"MAX","name":"Linehaul"}'))
			.toEqual({ kind: 'spawn', repo: 'app', base: null, task: 'x', model: 'opus', effort: 'max', name: 'Linehaul' });
		expect(parseOutboxMessage('{"kind":"spawn","repo":"app","task":"x","model":"  ","effort":42,"name":" "}'))
			.toEqual({ kind: 'spawn', repo: 'app', base: null, task: 'x', model: null, effort: null, name: null });
	});
	it('parses a rename and rejects blank fields', () => {
		expect(parseOutboxMessage('{"kind":"rename","target":"wt-1","name":"Linehaul fix"}'))
			.toEqual({ kind: 'rename', target: 'wt-1', name: 'Linehaul fix' });
		expect(parseOutboxMessage('{"kind":"rename","target":"wt-1","name":"  "}')).toBeNull();
		expect(parseOutboxMessage('{"kind":"rename","target":"","name":"x"}')).toBeNull();
	});
```

In the `godSystemPrompt` describe (near line 93), extend the spawn-docs test:

```ts
	it('documents the watch, spawn, and rename commands', () => {
		expect(p).toContain('cos-coord watch');
		expect(p).toContain('cos-coord spawn');
		expect(p).toContain('--model');
		expect(p).toContain('--effort low|medium|high|xhigh|max|ultracode');
		expect(p).toContain('--name');
		expect(p).toContain('cos-coord rename');
	});
```

`tests/coord-cli.test.ts` — in the `'watch/spawn are god-only and drop tagged files'` test, after the existing spawn exec (line 75), add a flagged spawn and extend the assertions:

```ts
		execFileSync('node', [CLI, 'spawn', 'app', '--base', 'main', '--task', 'do Y', '--model', 'opus', '--effort', 'max', '--name', 'Linehaul'], { env: god, encoding: 'utf8' });
		execFileSync('node', [CLI, 'rename', 'wt-1', '--to', 'Linehaul fix'], { env: god, encoding: 'utf8' });
```

and after the existing `expect(msgs.find((m) => m.kind === 'spawn'))...` line:

```ts
		expect(msgs.find((m) => m.kind === 'spawn' && m.task === 'do X')).toMatchObject({ model: null, effort: null, name: null });
		expect(msgs.find((m) => m.kind === 'spawn' && m.task === 'do Y')).toMatchObject({ model: 'opus', effort: 'max', name: 'Linehaul' });
		expect(msgs.find((m) => m.kind === 'rename')).toMatchObject({ target: 'wt-1', name: 'Linehaul fix' });
```

`tests/coord-store.test.ts` — add one test inside the file's existing describe, using its existing temp-dir setup variable (read the file; it already exercises `store.spawn`-adjacent outbox helpers — follow its local pattern for `dir`):

```ts
	it('spawn records model/effort/name (null when omitted); rename drops a tagged file', () => {
		store.spawn(dir, 'app', '', 'do X');
		store.spawn(dir, 'app', 'main', 'do Y', 'opus', 'max', 'Linehaul');
		store.rename(dir, 'wt-1', 'Linehaul fix');
		const msgs = fs.readdirSync(path.join(dir, 'god-outbox')).filter((f) => f.endsWith('.json'))
			.map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'god-outbox', f), 'utf8')));
		expect(msgs.find((m) => m.task === 'do X')).toMatchObject({ model: null, effort: null, name: null });
		expect(msgs.find((m) => m.task === 'do Y')).toMatchObject({ model: 'opus', effort: 'max', name: 'Linehaul' });
		expect(msgs.find((m) => m.kind === 'rename')).toMatchObject({ target: 'wt-1', name: 'Linehaul fix' });
	});
```

- [ ] **Step 2: Run to verify the new expectations fail**

Run: `npx vitest run tests/god.test.ts tests/coord-cli.test.ts tests/coord-store.test.ts`
Expected: the updated/new spawn tests FAIL (parse result lacks `model`/`effort`; outbox JSON lacks the fields; prompt lacks the flag docs).

- [ ] **Step 3: Implement**

`pty-sidecar/coord-store.cjs` — replace line 108 and add `rename` beside it (and add `rename` to the `module.exports` list on line 111):

```js
function spawn(dir, repo, base, task, model, effort, name) { return dropOutbox(dir, { kind: 'spawn', repo, base: base || null, task, model: model || null, effort: effort || null, name: name || null }); }
function rename(dir, target, to) { return dropOutbox(dir, { kind: 'rename', target, name: to }); }
```

`pty-sidecar/coord-cli.cjs` — replace the spawn branch (lines 57-64) and add a rename branch directly below it:

```js
  if (cmd === 'spawn') {
    if (env('COS_ROLE') !== 'god') process.exit(0);
    const repo = resource;
    const base = flag(rest, '--base') || '';
    const task = flag(rest, '--task') || '';
    const model = flag(rest, '--model') || '';
    const effort = flag(rest, '--effort') || '';
    const name = flag(rest, '--name') || '';
    if (repo && task) store.spawn(dir, repo, base, task, model, effort, name);
    process.exit(0);
  }

  if (cmd === 'rename') {
    if (env('COS_ROLE') !== 'god') process.exit(0); // only GOD may rename worker terminals
    const target = resource;
    const to = flag(rest, '--to') || '';
    if (target && to.trim()) store.rename(dir, target, to);
    process.exit(0);
  }
```

Usage line 87 — new verb + flags:

```js
  console.error('usage: cos-coord <status|acquire|release|note|chat|tell|watch|spawn|rename|personality> [resource] [--reason "…"] [--ttl <sec>] [--note "…"] [--base <branch>] [--task "…"] [--model <model>] [--effort <level>] [--name "…"] [--to "…"]');
```

`src/terminals/god.ts` — `OutboxMessage` spawn variant (line 12) plus a rename variant:

```ts
	| { kind: 'spawn'; repo: string; base: string | null; task: string; model: string | null; effort: string | null; name: string | null }
	| { kind: 'rename'; target: string; name: string }
```

`parseOutboxMessage` — extend the local type (line 18) with `model?: unknown; effort?: unknown; name?: unknown`, replace the spawn branch (lines 32-36), and add a rename branch after it:

```ts
	} else if (kind === 'spawn') {
		if (typeof o.repo === 'string' && typeof o.task === 'string' && o.repo.trim() && o.task) {
			const base = typeof o.base === 'string' && o.base.trim() ? o.base : null;
			const model = typeof o.model === 'string' && o.model.trim() ? o.model.trim() : null;
			const effort = typeof o.effort === 'string' && o.effort.trim() ? o.effort.trim().toLowerCase() : null;
			const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : null;
			return { kind: 'spawn', repo: o.repo, base, task: o.task, model, effort, name };
		}
	} else if (kind === 'rename') {
		if (typeof o.target === 'string' && typeof o.name === 'string' && o.target.trim() && o.name.trim()) {
			return { kind: 'rename', target: o.target, name: o.name.trim() };
		}
	}
```

`godSystemPrompt` — replace lines 109-111 (the spawn doc block) with:

```ts
		'  - To open a NEW worktree terminal and start it on a task, run:',
		'    cos-coord spawn "<repo>" --base "<branch>" --task "<first instruction>" [--model <alias-or-id>] [--effort low|medium|high|xhigh|max|ultracode] [--name "<terminal name>"]',
		'    --base is optional (defaults to the repo\'s main). --model takes an alias (opus, sonnet, haiku,',
		'    fable) or a full model id. Flags you omit inherit the user\'s toolbar dropdowns. Repo names +',
		'    paths are listed below.',
		'  - To rename a worker terminal, run:  cos-coord rename "<exact terminal name>" --to "<new name>"',
```

`src/terminals/terminals-grid.ts` — `dispatchOutbox`: the else branch becomes the spawn call below, AND a rename branch is added before it (after the personality branch):

```ts
		} else if (msg.kind === 'rename') {
			const name = resolveTellTarget(msg.target, liveNames);
			const tile = name ? this.allSessions().find((t) => t.name === name) : undefined;
			if (tile && !tile.isJournal) (tile as TerminalTile).setName(msg.name);
			else this.writeGodInbox(`cannot rename "${msg.target}" — not a live terminal. Live: ${liveNames.join(', ') || '(none)'}`);
		} else {
			void this.spawnFromKane(msg.repo, msg.base, msg.task, msg.model, msg.effort, msg.name);
		}
```

`spawnFromKane` (lines 394-400):

```ts
	/** Kane asked to spawn a terminal: resolve the repo by name, validate the effort, default the
	 *  base branch, start it on the given task. Invalid effort → error note, no spawn. */
	private async spawnFromKane(repoName: string, base: string | null, task: string, model: string | null = null, effort: string | null = null, name: string | null = null): Promise<void> {
		const known = this.repos.some((r) => r.name === repoName || r.name.toLowerCase() === repoName.toLowerCase());
		if (!known) { this.writeGodInbox(`cannot spawn — unknown repo "${repoName}". Known: ${this.repos.map((r) => r.name).join(', ') || '(none)'}`); return; }
		if (effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
			this.writeGodInbox(`cannot spawn — invalid --effort "${effort}". Valid: ${EFFORT_LEVELS.join(', ')}`);
			return;
		}
		await this.spawnFromName(repoName, base, task, model ?? undefined, effort ?? undefined, name ?? undefined);
	}
```

`spawnFromName` (lines 572-579):

```ts
	/** Spawn a worktree terminal for a repo by name, on a base, with a kickoff task. Model/effort
	 *  override the toolbar dropdowns when given (spawnWorktree applies the fallback); name
	 *  overrides the default branch-derived terminal name. */
	async spawnFromName(repoName: string, base: string | null, task: string, model?: string, effort?: string, name?: string): Promise<TerminalTile | null> {
		const repo = this.repos.find((r) => r.name === repoName)
			?? this.repos.find((r) => r.name.toLowerCase() === repoName.toLowerCase());
		if (!repo) return null;
		const baseBranch = base ?? (defaultBranch(await listBranches(repo.path)) ?? 'main');
		return this.spawnWorktree(repo, baseBranch, { task, model, effort, name });
	}
```

`spawnWorktree` — the opts type gains `name?: string` (full type: `{ task?: string; model?: string; effort?: string; name?: string }`), and its `makeTile` call passes it through the existing 6th (name) parameter, which Task 1 left as `undefined`:

```ts
			const tile = this.makeTile(worktree, repo.name, repo.path, base, false, opts.name, model, effort);
```

- [ ] **Step 4: Run the three test files**

Run: `npx vitest run tests/god.test.ts tests/coord-cli.test.ts tests/coord-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc -noEmit -skipLibCheck` → clean. `npm test` → all pass.

- [ ] **Step 6: Commit**

```powershell
git add pty-sidecar/coord-cli.cjs pty-sidecar/coord-store.cjs src/terminals/god.ts src/terminals/terminals-grid.ts tests/god.test.ts tests/coord-cli.test.ts tests/coord-store.test.ts
git commit -m @'
feat(kane): spawn accepts --model/--effort/--name; new rename verb

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 3: Focus discipline — Kane focus guard, 30 s manual hold, Alt+K

**Files:**
- Modify: `src/terminals/god-console.ts` (`GodConsoleOpts` line 13-19, `render()` after line 41)
- Modify: `src/terminals/terminals-grid.ts` (module const, two fields, `toggleGod` line 585, `autoCenter` line 856, `handleClick` line 453, `showTile` line 927, `cycleSpotlight` line 289, `handleSubmit` line 894, `installKeyboard` lines 299-329, `godBtn` title line 183, new `openKane` method)

No unit tests are possible for this task (DOM/session wiring; the repo has no tests for `terminals-grid.ts`/`god-console.ts` by design — see the specs' Testing sections). The gate is: typecheck clean, full suite still green, and the code exactly matches this plan. Do NOT launch the app.

**Interfaces:**
- Consumes: `decideCenter`'s `userTyping` hold (`focus-decider.ts:38`); `GodConsole.focus()`, `setVisible()`; `toggleGod`/`showGod`.
- Produces: `GodConsoleOpts.onFocusChange` and the grid's `godFocused` flag — Task 4 wires every duplicate console into the same flag; Task 5 places its resize grip right below Task 3's focusin/focusout listeners in `render()`.

- [ ] **Step 1: GodConsole focus reporting**

`src/terminals/god-console.ts` — add to `GodConsoleOpts` (after `sessionEnv?`):

```ts
	onFocusChange?: (focused: boolean) => void;
```

In `render()`, immediately after `this.el = parent.createDiv({ cls: 'cos-god-panel' });` (line 41):

```ts
		// Report keyboard-focus changes so the grid can hold auto-centering while the user is
		// typing to Kane (mirrors terminal-tile's focusin/focusout wiring).
		this.el.addEventListener('focusin', () => this.opts.onFocusChange?.(true));
		this.el.addEventListener('focusout', () => this.opts.onFocusChange?.(false));
```

- [ ] **Step 2: Grid state + wiring**

`src/terminals/terminals-grid.ts` — below `SPAWN_EFFORTS` (module level):

```ts
// How long a manual tile choice (click / Alt+F-key / resurfacing) suppresses auto-centering.
const MANUAL_HOLD_MS = 30_000;
```

Fields, next to the existing `private godVisible` / `private godConsole` declarations:

```ts
	private godFocused = false;          // Kane's terminal holds keyboard focus right now
	private holdUntil = 0;               // epoch ms: autoCenter is suppressed until then
```

`toggleGod` — the `new GodConsole(...)` opts object (line 586) gains, after `sessionEnv: this.deps.sessionEnv`:

```ts
, onFocusChange: (f) => { this.godFocused = f; }
```

- [ ] **Step 3: autoCenter guard + userTyping OR**

`autoCenter` (line 856) — first line of the body plus the `userTyping` line (861):

```ts
	private autoCenter(): void {
		if (Date.now() < this.holdUntil) return; // manual-switch hold — the user chose a tile, let it be
		const want = decideCenter({
			tiles: this.tiles.map((t) => ({ id: t.tileId, state: this.spotlightState(t) })),
			centeredId: this.centeredId,
			readyOrder: this.q.stack,
			userTyping: this.q.composingLen > 0 || this.godFocused,
			globalLock: this.locked,
			lockedTileId: this.lockedTileId,
		});
```

(rest unchanged.)

- [ ] **Step 4: Hold set/clear points**

`handleClick` (line 453) — in the non-selecting branch, after `this.doCenter(r.center);`:

```ts
		this.holdUntil = Date.now() + MANUAL_HOLD_MS; // an explicit choice — hold the spotlight here
```

`showTile` (line 927) — after `this.focusCentered();`:

```ts
		this.holdUntil = Date.now() + MANUAL_HOLD_MS; // resurfacing is an explicit choice too
```

`cycleSpotlight` (line 289) — first line of the body:

```ts
		this.holdUntil = 0; // Alt+←/→ = back in the flow; cycling never pins for long
```

`handleSubmit` (line 894) — after the `looksLikeMenu` early-return, immediately before the `rqSubmit` line:

```ts
		this.holdUntil = 0; // prompt submitted — manual engagement over, the flow resumes
```

- [ ] **Step 5: Window-refocus + Alt+K + button title**

`installKeyboard` — replace the `onWinFocus` assignment (line 323):

```ts
		this.onWinFocus = () => { if (this.godFocused && this.godVisible) this.godConsole?.focus(); else this.focusCentered(); };
```

In the keydown handler, after the Alt+L line (line 308) and BEFORE the `keyToIndex` mapping:

```ts
			// Alt+K opens/focuses Kane. Kane wins this key — the letter-badge jumps only reach 'K'
			// with 23+ visible tiles, which never happens in practice.
			if (e.key === 'k' || e.key === 'K') { e.preventDefault(); this.openKane(); return; }
```

New method, placed directly after `toggleGod` (line 599):

```ts
	/** Alt+K: open Kane if needed and put the cursor in his terminal. Never closes him. */
	private openKane(): void {
		if (!this.godConsole) { this.toggleGod(); return; } // first open creates + focuses
		if (!this.godVisible) this.showGod();               // setVisible(true) refits + refocuses
		this.godConsole.focus();
	}
```

`godBtn` title (line 183):

```ts
		this.godBtn.setAttribute('title', 'Open the Kane overseer console — sees the whole floor, acts on request (Alt+K)');
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc -noEmit -skipLibCheck` → clean. `npm test` → all pass.

- [ ] **Step 7: Commit**

```powershell
git add src/terminals/god-console.ts src/terminals/terminals-grid.ts
git commit -m @'
fix(focus): Kane keeps focus while you type; 30s manual-switch hold; Alt+K opens Kane

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 4: Duplicate Kane (multiple consoles)

**Files:**
- Modify: `src/terminals/god-console.ts` (`GodConsoleOpts` gains `instanceName`/`terminalId`; head label, env, exit message use them)
- Modify: `src/terminals/terminals-grid.ts` (`extraKanes` field + `kaneSeq` counter, `🜲+` button, `addKane()`, `notifyKanes()` broadcast replacing the three `godConsole?.notify(...)` call sites, extras torn down where the grid disposes the primary)

No unit tests possible (DOM/session wiring — same rationale as Task 3). Gate: typecheck clean, suite green, code matches plan. NEVER launch the app.

**Interfaces:**
- Consumes: `GodConsole` (existing `dispose()` at `god-console.ts:298`, `notify()`, `render()`, `focus()`); Task 3's `onFocusChange` opt and `godFocused` flag; `startFloorFeed()`.
- Produces: nothing later tasks rely on.

- [ ] **Step 1: GodConsole instance identity**

`src/terminals/god-console.ts` — `GodConsoleOpts` gains (after `onFocusChange?`):

```ts
	instanceName?: string;   // head label + COS_TERMINAL_NAME (default 'Kane')
	terminalId?: string;     // COS_TERMINAL_ID for cos-coord identity (default '0')
```

In `render()`, the head label (line 43) becomes:

```ts
		head.createSpan({ text: `🜲 ${this.opts.instanceName ?? 'Kane'}` });
```

In `startSession()`, the env entries (lines 136-137) become:

```ts
			COS_TERMINAL_ID: this.opts.terminalId ?? '0',
			COS_TERMINAL_NAME: this.opts.instanceName ?? 'Kane',
```

and the session-ended line (line 151) becomes:

```ts
			this.term?.write(`\r\n[${this.opts.instanceName ?? 'Kane'} session ended (code ${code ?? '?'})]\r\n`);
```

- [ ] **Step 2: Grid — button, addKane, broadcast, teardown**

`src/terminals/terminals-grid.ts` — fields, next to `extraKanes`-adjacent god fields:

```ts
	private extraKanes: GodConsole[] = [];
	private kaneSeq = 1; // monotonic: duplicates are Kane 2, 3, … — numbers never reused in-session
```

In `mount()`, directly after the `godBtn` block:

```ts
		const kaneDupBtn = controls.createEl('button', { text: '🜲+', cls: 'cos-god-btn' });
		kaneDupBtn.setAttribute('title', 'Add another Kane console — a separate session in its own panel (close it with its ×)');
		kaneDupBtn.addEventListener('click', () => this.addKane());
```

New method, after `openKane()`:

```ts
	/** Dock an ADDITIONAL Kane console — its own session + home dir. Duplicates are cheap:
	 *  the × disposes them entirely and they are not persisted across app restarts. */
	private addKane(): void {
		const n = ++this.kaneSeq;
		const godHomeDir = path.join(this.coordDir, '..', '.god', `${this.deps.group}-${n}`);
		const kane = new GodConsole(
			{
				repos: this.repos.map((r) => ({ name: r.name, path: r.path })),
				coordDir: this.coordDir,
				sidecarPath: this.sidecarPath,
				godHomeDir,
				sessionEnv: this.deps.sessionEnv,
				onFocusChange: (f) => { this.godFocused = f; },
				instanceName: `Kane ${n}`,
				terminalId: String(-n),
			},
			() => {
				kane.dispose();
				this.extraKanes = this.extraKanes.filter((k) => k !== kane);
				this.applyLayout();
			},
		);
		if (this.stageWrapEl) kane.render(this.stageWrapEl);
		this.extraKanes.push(kane);
		this.startFloorFeed();
		this.applyLayout();
		kane.focus();
	}
```

Broadcast helper, next to it:

```ts
	/** Ping the primary Kane and every duplicate (they share the god role — any of them
	 *  may have registered the watch or flipped the personality). */
	private notifyKanes(text: string): void {
		this.godConsole?.notify(text);
		for (const k of this.extraKanes) k.notify(text);
	}
```

Replace the three existing `this.godConsole?.notify(...)` call sites with `this.notifyKanes(...)`: the watch firing in `handleReady` (line 877), both personality branches in `togglePersonality` (lines 716, 719), and the pulse in `startPulse` (line 729).

Teardown: locate where the grid disposes the primary console (`grep -n "godConsole" src/terminals/terminals-grid.ts` — the `dispose()`/unmount path calling `this.godConsole?.dispose()`), and add immediately after it:

```ts
		for (const k of this.extraKanes) k.dispose();
		this.extraKanes = [];
```

- [ ] **Step 3: Typecheck + full suite**

Run: `npx tsc -noEmit -skipLibCheck` → clean. `npm test` → all pass.

- [ ] **Step 4: Commit**

```powershell
git add src/terminals/god-console.ts src/terminals/terminals-grid.ts
git commit -m @'
feat(kane): duplicate Kane — extra overseer consoles, each its own session

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 5: Kane panel drag-resize

**Files:**
- Modify: `src/terminals/god-console.ts` (`render()` — width restore + left-edge grip with drag logic)
- Modify: `styles.css` (line 854 `.cos-god-panel` gains `position:relative;`; new `.cos-god-resize` rules after line 858)

No unit tests possible (DOM drag wiring). Gate: typecheck clean, suite green, code matches plan. NEVER launch the app.

**Interfaces:**
- Consumes: `.cos-god-panel { flex:0 0 380px; … }` (`styles.css:854`); the body's existing `ResizeObserver` (refits xterm on any size change — no extra fit calls needed).
- Produces: `localStorage['cos-god-width']` (shared width, applied to every Kane panel at render).

- [ ] **Step 1: styles.css**

Line 854 — add `position:relative;` to the existing `.cos-god-panel` rule (keep everything else on the line unchanged):

```css
.cos-god-panel { position:relative; flex:0 0 380px; min-height:0; display:flex; flex-direction:column; min-width:0; background:#0e0f17; border:1px solid var(--background-modifier-border); border-radius:10px; overflow:hidden; }
```

After the `.cos-god-body` rule (line 858), add:

```css
.cos-god-resize { position:absolute; left:0; top:0; bottom:0; width:6px; cursor:ew-resize; z-index:5; }
.cos-god-resize:hover, .cos-god-resize.dragging { background:rgba(120,140,255,0.25); }
```

- [ ] **Step 2: grip + drag logic**

`src/terminals/god-console.ts`, in `render()`, immediately after the `focusin`/`focusout` listeners (Task 3 placed them right below `this.el = parent.createDiv(...)`):

```ts
		// Left-edge grip: drag to resize the panel width. One shared width for every Kane
		// panel, persisted across sessions; the body's ResizeObserver refits xterm live.
		const saved = Number(window.localStorage.getItem('cos-god-width'));
		if (Number.isFinite(saved) && saved >= 280) this.el.style.flex = `0 0 ${Math.round(saved)}px`;
		const grip = this.el.createDiv({ cls: 'cos-god-resize' });
		grip.addEventListener('mousedown', (e) => {
			e.preventDefault();
			const startX = e.clientX;
			const startW = this.el!.getBoundingClientRect().width;
			grip.classList.add('dragging');
			const move = (ev: MouseEvent): void => {
				const w = Math.min(Math.max(280, startW + (startX - ev.clientX)), Math.round(window.innerWidth * 0.7));
				this.el!.style.flex = `0 0 ${Math.round(w)}px`;
			};
			const up = (): void => {
				grip.classList.remove('dragging');
				document.removeEventListener('mousemove', move);
				document.removeEventListener('mouseup', up);
				window.localStorage.setItem('cos-god-width', String(Math.round(this.el!.getBoundingClientRect().width)));
			};
			document.addEventListener('mousemove', move);
			document.addEventListener('mouseup', up);
		});
```

- [ ] **Step 3: Typecheck + full suite**

Run: `npx tsc -noEmit -skipLibCheck` → clean. `npm test` → all pass.

- [ ] **Step 4: Commit**

```powershell
git add src/terminals/god-console.ts styles.css
git commit -m @'
feat(kane): drag the left edge to resize the Kane panel (width persists)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 6: Post-merge human verification (user, later — not the implementer)

No files. The user verifies in the running app on their own schedule: effort dropdown appears and a terminal spawned with `Effort: Max` accepts it; Kane `cos-coord spawn ... --model sonnet --effort high --name "Linehaul"` opens a terminal with that name; `cos-coord rename` changes a terminal's name; typing in Kane while another terminal finishes no longer loses focus; clicking off a menu tile sticks for ~30 s; Alt+←/→ still flows; Alt+K opens/focuses Kane; 🜲+ docks a second Kane with its own session and its × removes it; dragging Kane's left edge resizes the panel and the width survives a restart.
