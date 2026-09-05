---
status: stable
---

# Private Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the app open source while personal features live in a gitignored `private/` overlay backed by a private repo, and genericize the Convert-to-Linear feature so no personal values remain in public code or docs.

**Architecture:** A virtual module `wcc-private` resolves (esbuild alias + tsconfig `paths`) to `private/index.ts` when that folder exists, else to a no-op stub in `src/`. `app.ts` calls `registerPrivateFeatures(api)` once at startup. Separately, `LinearConvertProbe`'s hardcoded team name / team UUID / MCP tool name become a `linearConvert` config object read from the existing userData `config.json` and threaded through `GridDeps`.

**Tech Stack:** Electron 33, TypeScript 5.8 (`tsc -noEmit` + esbuild 0.25 bundling), vitest 4.

**Spec:** `docs/superpowers/specs/2026-07-10-private-overlay-design.md`

## Global Constraints

- **No personal identifiers** (the Linear team name, team UUID, or personal MCP server name — currently in `src/terminals/linear-convert-probe.ts` at commit `442b786`, lines 10–11 and 78) may appear in ANY file committed to the public repo from now on: not in code, tests, docs, commit messages, or this plan's execution notes. Recover them only via `git show 442b786:...` for local-machine steps.
- Build: `npm run build` (runs `tsc -noEmit -skipLibCheck` then esbuild). Tests: `npx vitest run` (no vitest config file exists; defaults apply).
- Windows machine; use the Bash tool (Git Bash) for the shell commands shown.
- Commit after every task. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Tabs for indentation in `src/terminals/terminals-grid.ts` and `src/app.ts`; the probe/tests use 2 spaces. Match each file's existing style.

---

### Task 1: Genericize LinearConvertProbe (config type, prompt params, create guard)

**Files:**
- Modify: `src/terminals/linear-convert-probe.ts`
- Test: `tests/linear-convert-probe.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 2):
  - `export interface LinearConvertConfig { team: string; teamId: string; saveIssueTool: string }`
  - `export function parseLinearConvertConfig(v: unknown): LinearConvertConfig | undefined`
  - `export function buildCreatePrompt(issuesPath: string, team: string, teamId: string): string`
  - `LinearConvertProbeOpts` gains optional `linear?: LinearConvertConfig`
  - `LinearConvertProbe.create()` throws `Error('linear convert not configured')` when `opts.linear` is absent and issues is non-empty.

- [ ] **Step 1: Rewrite the tests to the new API (failing first)**

In `tests/linear-convert-probe.test.ts`, replace the entire `buildCreatePrompt` describe block and the import line, and add two new describe blocks. The file becomes:

```ts
import { describe, it, expect } from 'vitest';
import { buildProposePrompt, buildCreatePrompt, parseIssuesJson, parseLinearConvertConfig, LinearConvertProbe } from '../src/terminals/linear-convert-probe';

describe('buildProposePrompt', () => {
  it('references the note path and asks for a JSON array', () => {
    const p = buildProposePrompt('/tmp/n.md');
    expect(p).toContain('/tmp/n.md');
    expect(p).toContain('JSON array');
  });
});
describe('buildCreatePrompt', () => {
  it('references the issues path, the team name, and the team id', () => {
    const p = buildCreatePrompt('/tmp/i.json', 'Acme', 'team-uuid-123');
    expect(p).toContain('/tmp/i.json');
    expect(p).toContain('Acme');
    expect(p).toContain('team-uuid-123');
  });
});
describe('parseLinearConvertConfig', () => {
  it('accepts a complete config', () => {
    expect(parseLinearConvertConfig({ team: 'Acme', teamId: 'uuid-1', saveIssueTool: 'mcp__linear__save_issue' }))
      .toEqual({ team: 'Acme', teamId: 'uuid-1', saveIssueTool: 'mcp__linear__save_issue' });
  });
  it('rejects non-objects and missing or empty fields', () => {
    expect(parseLinearConvertConfig(undefined)).toBeUndefined();
    expect(parseLinearConvertConfig('Acme')).toBeUndefined();
    expect(parseLinearConvertConfig({ team: 'Acme' })).toBeUndefined();
    expect(parseLinearConvertConfig({ team: '', teamId: 'x', saveIssueTool: 'y' })).toBeUndefined();
  });
});
describe('LinearConvertProbe.create without config', () => {
  it('rejects when issues are non-empty and no linear config was given', async () => {
    const probe = new LinearConvertProbe({ sidecarPath: 'sidecar.cjs', cwd: '.' });
    await expect(probe.create([{ title: 't', description: 'd' }])).rejects.toThrow('not configured');
  });
  it('resolves [] for an empty issue list even without config', async () => {
    const probe = new LinearConvertProbe({ sidecarPath: 'sidecar.cjs', cwd: '.' });
    await expect(probe.create([])).resolves.toEqual([]);
  });
});
describe('parseIssuesJson', () => {
  it('extracts a well-formed array', () => {
    expect(parseIssuesJson('[{"title":"a","description":"b"}]')).toEqual([{ title: 'a', description: 'b' }]);
  });
  it('tolerates a json fence and a preamble', () => {
    expect(parseIssuesJson('Here are the issues:\n```json\n[{"title":"a"}]\n```')).toEqual([{ title: 'a' }]);
  });
  it('strips ANSI before parsing', () => {
    expect(parseIssuesJson('\x1b[2m[{"title":"a"}]\x1b[0m')).toEqual([{ title: 'a' }]);
  });
  it('returns [] for non-array / malformed / empty', () => {
    expect(parseIssuesJson('{"title":"a"}')).toEqual([]);
    expect(parseIssuesJson('not json')).toEqual([]);
    expect(parseIssuesJson('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/linear-convert-probe.test.ts`
Expected: FAIL — `parseLinearConvertConfig` is not exported; `buildCreatePrompt` called with 3 args.

- [ ] **Step 3: Implement in `src/terminals/linear-convert-probe.ts`**

Delete the two `const` lines at lines 10–11 (the team-name and team-id constants). Add after the existing interfaces:

```ts
export interface LinearConvertConfig { team: string; teamId: string; saveIssueTool: string; }

/** Validate cfg.linearConvert from config.json: three non-empty strings or undefined. */
export function parseLinearConvertConfig(v: unknown): LinearConvertConfig | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const ok = (x: unknown): x is string => typeof x === 'string' && x.trim() !== '';
  return ok(o.team) && ok(o.teamId) && ok(o.saveIssueTool)
    ? { team: o.team, teamId: o.teamId, saveIssueTool: o.saveIssueTool }
    : undefined;
}
```

Change `LinearConvertProbeOpts` to:

```ts
export interface LinearConvertProbeOpts { sidecarPath: string; cwd: string; linear?: LinearConvertConfig; }
```

Change `buildCreatePrompt` to take the team values as parameters:

```ts
export function buildCreatePrompt(issuesPath: string, team: string, teamId: string): string {
  return (
    `Read the JSON array of issues at ${issuesPath}. For EACH issue, create a Linear issue in the ` +
    `"${team}" team (id ${teamId}) using the available Linear tool, with its title and ` +
    'description. Output ONLY a JSON array with one object per issue: {"title": string, "url": ' +
    'string, "ok": true} on success, or {"title": string, "ok": false, "error": string} on ' +
    'failure. No preamble, no explanation, no code fences.'
  );
}
```

Change `create()` to guard and use the config (guard AFTER the empty-list early return, BEFORE `run` so no process spawns unconfigured):

```ts
  async create(issues: ProposedIssue[]): Promise<CreatedIssue[]> {
    if (!issues.length) return [];
    const linear = this.opts.linear;
    if (!linear) throw new Error('linear convert not configured');
    const rows = await this.run(JSON.stringify(issues), (p) => buildCreatePrompt(p, linear.team, linear.teamId), linear.saveIssueTool, 120000);
    return rows
      .filter((r): r is Record<string, unknown> => !!r && typeof (r as Record<string, unknown>).title === 'string')
      .map((r) => ({
        title: String(r.title),
        url: typeof r.url === 'string' ? r.url : undefined,
        ok: r.ok === true,
        error: typeof r.error === 'string' ? r.error : undefined,
      }));
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/linear-convert-probe.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Verify no personal strings remain in src/ or tests/**

Run: `cd /c/Users/User/Dev/worktree-command-center && git grep -n "$(git show 442b786:src/terminals/linear-convert-probe.ts | sed -n '10p' | cut -d\' -f2)" -- src tests || echo CLEAN`
Expected: `CLEAN`

- [ ] **Step 6: Commit**

```bash
git add src/terminals/linear-convert-probe.ts tests/linear-convert-probe.test.ts
git commit -m "refactor(journal): Linear team/tool come from config, not constants

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Thread linearConvert config through app → GridDeps → callbacks; migrate local config

**Files:**
- Modify: `src/terminals/terminals-grid.ts` (GridDeps at :31-42, constructor at :123, journal-tile callbacks at :385-386 and :975-976)
- Modify: `src/app.ts` (imports at top, `depsFor` at :56-67)
- Local machine only (NOT committed): `%APPDATA%/worktree-command-center/config.json` and/or `%APPDATA%/Worktree Command Center/config.json`

**Interfaces:**
- Consumes: `LinearConvertConfig`, `parseLinearConvertConfig` from Task 1.
- Produces: `GridDeps.linearConvert?: LinearConvertConfig` (optional field).

- [ ] **Step 1: Add the field to GridDeps and pass it to the probe**

In `src/terminals/terminals-grid.ts`, extend the import at line 25:

```ts
import { LinearConvertProbe, type LinearConvertConfig } from './linear-convert-probe';
```

Add to `GridDeps` (after `bypassPermissions: boolean;`):

```ts
	linearConvert?: LinearConvertConfig;
```

Change the constructor line 123 to:

```ts
		this.linearProbe = new LinearConvertProbe({ sidecarPath: this.sidecarPath, cwd: this.coordDir, linear: deps.linearConvert });
```

- [ ] **Step 2: Guard both onConvertPropose callbacks with a setup toast**

There are TWO `JournalTile` construction sites (`:385-386` in the spawn path and `:975-976` in the session-restore path). At BOTH, replace:

```ts
				onConvertPropose: (text) => this.linearProbe.propose(text),
```

with:

```ts
				onConvertPropose: (text) => {
					if (!this.deps.linearConvert) {
						this.deps.toast('Convert to Linear is not configured — add linearConvert { team, teamId, saveIssueTool } to config.json in the app userData folder');
						return Promise.reject(new Error('linear convert not configured'));
					}
					return this.linearProbe.propose(text);
				},
```

(Adjust leading tabs to each site's depth. The journal tile's own catch adds a generic "Convert failed" toast after ours — accepted for v1.) Leave `onConvertCreate` unchanged; `create()` has its own guard from Task 1.

- [ ] **Step 3: Read the config in app.ts**

In `src/app.ts`, add to the imports:

```ts
import { parseLinearConvertConfig } from './terminals/linear-convert-probe';
```

In `depsFor` (the object literal at :56-67), add after `bypassPermissions: true,`:

```ts
			linearConvert: parseLinearConvertConfig(cfg.linearConvert),
```

- [ ] **Step 4: Build and test**

Run: `npm run build && npx vitest run`
Expected: build succeeds; all test files pass.

- [ ] **Step 5: Migrate the real values into local userData config (machine-local, never committed)**

```bash
cd /c/Users/User/Dev/worktree-command-center
SRC=$(git show 442b786:src/terminals/linear-convert-probe.ts)
TEAM=$(echo "$SRC" | sed -n '10p' | cut -d"'" -f2)
ID=$(echo "$SRC" | sed -n '11p' | cut -d"'" -f2)
TOOL=$(echo "$SRC" | grep -o "mcp__[a-z-]*__save_issue" | head -1)
echo "team=$TEAM id=$ID tool=$TOOL"   # sanity: a team name, a uuid, an mcp tool name
node -e "
const fs=require('fs'),path=require('path');
const vals={team:process.argv[1],teamId:process.argv[2],saveIssueTool:process.argv[3]};
for(const dir of ['worktree-command-center','Worktree Command Center']){
  const p=path.join(process.env.APPDATA,dir,'config.json');
  if(!fs.existsSync(p)){console.log('absent:',p);continue;}
  const c=JSON.parse(fs.readFileSync(p,'utf8'));
  c.linearConvert=vals;
  fs.writeFileSync(p,JSON.stringify(c,null,2));
  console.log('updated',p);
}" "$TEAM" "$ID" "$TOOL"
```

Expected: at least one `updated <path>` line (dev config exists; installed-app config too if present).

- [ ] **Step 6: Commit**

```bash
git add src/terminals/terminals-grid.ts src/app.ts
git commit -m "feat(journal): wire linearConvert config from userData config.json

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Scrub personal values from public docs; README note

**Files:**
- Modify: `docs/superpowers/plans/2026-06-26-journal-convert-to-linear.md`
- Modify: `docs/superpowers/specs/2026-06-26-journal-convert-to-linear-design.md`
- Modify: `docs/superpowers/specs/2026-06-26-journal-entry-tile-design.md`
- Modify: `README.md`

- [ ] **Step 1: Replace the three personal values with placeholders**

```bash
cd /c/Users/User/Dev/worktree-command-center
SRC=$(git show 442b786:src/terminals/linear-convert-probe.ts)
TEAM=$(echo "$SRC" | sed -n '10p' | cut -d"'" -f2)
ID=$(echo "$SRC" | sed -n '11p' | cut -d"'" -f2)
TOOL=$(echo "$SRC" | grep -o "mcp__[a-z-]*__save_issue" | head -1)
SRV=$(echo "$TOOL" | sed 's/^mcp__//; s/__save_issue$//')
for f in docs/superpowers/plans/2026-06-26-journal-convert-to-linear.md \
         docs/superpowers/specs/2026-06-26-journal-convert-to-linear-design.md \
         docs/superpowers/specs/2026-06-26-journal-entry-tile-design.md; do
  sed -i "s/$TOOL/mcp__linear__save_issue/g; s/$SRV/linear/g; s/$TEAM/<your-team>/g; s/$ID/<team-uuid>/g" "$f"
done
```

(Order matters: the full tool name is replaced before the bare server name it contains.)

- [ ] **Step 2: Hand-fix leftovers (abbreviation-based identifiers)**

The docs also contain the team's 3-letter abbreviation in const names and mock issue keys (e.g., the code snippet consts in the 2026-06-26 plan file around lines 83–84 and the ASCII-mock issue keys in the convert-to-linear design around lines 95–96). Find every remaining hit and neutralize it — consts to `TEAM_NAME` / `TEAM_ID`, issue keys to `ABC-101` / `ABC-102`:

```bash
PREFIX=$(echo "$SRV" | cut -d- -f2)
git grep -inE "$PREFIX" -- docs || echo CLEAN
```

Edit each listed line by hand (Edit tool), then re-run the grep.
Expected final output: `CLEAN`

- [ ] **Step 3: Add the Private extensions section to README.md**

Append to `README.md`:

```md
## Private extensions

The build looks for an optional, gitignored `private/` folder at the repo root. If
`private/index.ts` exists, it is compiled into the app and its exported
`registerPrivateFeatures(api)` runs once at startup; otherwise the no-op stub
`src/private-stub.ts` is used. This lets you keep personal features in a separate
private repo cloned at `private/`, with full TypeScript access to `src/`, without
forking. The hook's surface is defined in `src/private-api.ts`.
```

(If Task 4 has not run yet, this documents files created there — that is fine; both land on main in the same push.)

- [ ] **Step 4: Verify the whole tree is clean of all four identifiers**

```bash
git grep -inE "$TEAM|$ID|$SRV|$PREFIX" -- . ':!docs/superpowers/plans/2026-07-10-private-overlay.md' || echo CLEAN
```

Expected: `CLEAN` (this plan file is excluded — it contains none of the values but the variables would not match it anyway; the exclusion just keeps the check honest if it is later edited).

- [ ] **Step 5: Commit**

```bash
git add docs README.md
git commit -m "docs: neutralize personal Linear identifiers; document private/ overlay

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Private overlay build wiring (api, stub, alias, paths, hook call, gitignore)

**Files:**
- Create: `src/private-api.ts`
- Create: `src/private-stub.ts`
- Modify: `esbuild.config.mjs`
- Modify: `tsconfig.json`
- Modify: `src/app.ts` (import + hook call before the closing `} catch` of `main()`, after the `addFolderBtn` listener at :166-177)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `TerminalsGrid` type.
- Produces (used by Task 5 and all future private features):
  - virtual module `wcc-private` exporting `registerPrivateFeatures(api: PrivateApi): void`
  - `PrivateApi` = `{ topBar: HTMLElement; activeGrid: () => TerminalsGrid; config: { get: () => Promise<any>; set: (c: any) => Promise<boolean> }; toast: (msg: string) => void; promptForTopic: (title: string, placeholder: string, initial?: string, okLabel?: string) => Promise<string | null>; userData: string; sidecarDir: string }`

- [ ] **Step 1: Create `src/private-api.ts`**

```ts
import type { TerminalsGrid } from './terminals/terminals-grid';

/** Surface handed to the private overlay (private/index.ts) at startup.
 *  Grow this only when a private feature actually needs more. */
export interface PrivateApi {
	topBar: HTMLElement;
	activeGrid: () => TerminalsGrid;
	config: { get: () => Promise<any>; set: (c: any) => Promise<boolean> };
	toast: (msg: string) => void;
	promptForTopic: (title: string, placeholder: string, initial?: string, okLabel?: string) => Promise<string | null>;
	userData: string;
	sidecarDir: string;
}
```

- [ ] **Step 2: Create `src/private-stub.ts`**

```ts
import type { PrivateApi } from './private-api';

/** No private overlay present — the wcc-private alias resolves here on public clones. */
export function registerPrivateFeatures(_api: PrivateApi): void {}
```

- [ ] **Step 3: Wire the esbuild alias**

In `esbuild.config.mjs`, add to the imports:

```js
import { existsSync } from 'fs';
import path from 'path';
```

Before the renderer build, add:

```js
// Private overlay: compile private/index.ts into the bundle when present, else the stub.
const privateEntry = existsSync('private/index.ts') ? path.resolve('private/index.ts') : path.resolve('src/private-stub.ts');
```

and change the renderer build call (the `src/app.ts` one) to include the alias:

```js
await esbuild.build({ ...common, entryPoints: ['src/app.ts'], outfile: 'dist/renderer.js', platform: 'node', format: 'iife', external: ['electron', 'node-pty'], alias: { 'wcc-private': privateEntry } });
```

- [ ] **Step 4: Add the tsconfig paths fallback**

In `tsconfig.json` `compilerOptions`, add (tsc tries entries in order; TS ≥4.1 allows `paths` without `baseUrl`, resolved relative to the tsconfig):

```json
    "paths": {
      "wcc-private": ["./private/index.ts", "./src/private-stub.ts"]
    }
```

- [ ] **Step 5: Call the hook in app.ts**

Add to the imports in `src/app.ts`:

```ts
import { registerPrivateFeatures } from 'wcc-private';
```

Inside `main()`, immediately after the `addFolderBtn.addEventListener(...)` block (line ~177) and before the closing `} catch`:

```ts
		// Private overlay (see README "Private extensions"): must never take down the app.
		try {
			registerPrivateFeatures({
				topBar,
				activeGrid: () => activeGrid,
				config: { get: () => window.wcc.getConfig(), set: (c) => window.wcc.setConfig(c) },
				toast,
				promptForTopic,
				userData,
				sidecarDir,
			});
		} catch (e) {
			toast('Private features failed to load: ' + e);
		}
```

- [ ] **Step 6: Gitignore the overlay folder**

Add to `.gitignore` (own line, with the leading slash so only the root folder is ignored):

```
/private/
```

- [ ] **Step 7: Verify the STUB path (no private/ exists yet)**

Run: `npm run build && npx vitest run`
Expected: tsc + esbuild succeed (paths falls through to the stub; alias points at the stub); all tests pass.

Run: `grep -c "registerPrivateFeatures" dist/renderer.js`
Expected: a number ≥ 1 (stub compiled in).

- [ ] **Step 8: Commit**

```bash
git add src/private-api.ts src/private-stub.ts esbuild.config.mjs tsconfig.json src/app.ts .gitignore
git commit -m "feat: private overlay hook — gitignored private/ compiles in when present

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Create the private repo and seed the overlay

**Files (all inside `private/`, which is its own git repo — nothing here touches the public repo):**
- Create: `private/index.ts`
- Create: `private/README.md`
- Create: `private/docs/.gitkeep`

**Interfaces:**
- Consumes: `PrivateApi` from Task 4 (via relative import `../src/private-api`).
- Produces: the live overlay; future personal features register inside `registerPrivateFeatures`.

- [ ] **Step 1: Create and clone the private repo**

```bash
cd /c/Users/User/Dev/worktree-command-center
gh repo create RonaldF444/wcc-private --private -d "Private overlay for worktree-command-center"
git clone https://github.com/RonaldF444/wcc-private.git private
```

Expected: clone succeeds with an "empty repository" warning — fine.

- [ ] **Step 2: Seed `private/index.ts`**

```ts
import type { PrivateApi } from '../src/private-api';

export function registerPrivateFeatures(api: PrivateApi): void {
	// Personal features register here. Marker log proves the overlay compiled in.
	console.log('[wcc-private] overlay loaded');
}
```

- [ ] **Step 3: Seed `private/README.md`**

```md
# wcc-private

Private overlay for [worktree-command-center](https://github.com/RonaldF444/worktree-command-center).
Clone into `private/` at that repo's root; the build compiles `index.ts` in automatically
(see the public repo's README, "Private extensions").

- Feature code: import freely from `../src/**`; register everything in `registerPrivateFeatures`.
- Specs/plans for private features: `docs/` here — never the public repo's `docs/`.
- Tests: `*.test.ts` here are picked up by the public repo's `npx vitest run` when this clone exists.
```

- [ ] **Step 4: Seed `private/docs/.gitkeep`** (empty file)

- [ ] **Step 5: Verify the OVERLAY path**

Run from the public repo root: `npm run build`
Expected: success (tsc resolves `wcc-private` → `./private/index.ts` — first paths entry now exists; esbuild alias picks the overlay).

Run: `grep -c "wcc-private\] overlay loaded" dist/renderer.js`
Expected: `1` (overlay, not stub, is in the bundle).

Run: `git -C /c/Users/User/Dev/worktree-command-center status --porcelain`
Expected: no `private/` entries (gitignore working). `dist/` is already ignored.

- [ ] **Step 6: Commit and push the private repo**

```bash
cd /c/Users/User/Dev/worktree-command-center/private
git add -A
git commit -m "chore: seed overlay (registerPrivateFeatures + docs convention)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin HEAD
```

- [ ] **Step 7: Push the public repo**

```bash
cd /c/Users/User/Dev/worktree-command-center
git push
```

Expected: all Task 1–4 commits (plus the spec/plan docs) land on `origin/main`; nothing private among them (`git log origin/main --stat -5` shows no `private/` paths).

---

## Final verification (whole plan)

- `npm run build && npx vitest run` → green with `private/` present.
- Temporarily rename the overlay and confirm the public path still works: `mv private private-off && npm run build && mv private-off private` → build green both times.
- Launch `npm start`: DevTools console shows the `[wcc-private] overlay loaded` marker; a journal tile's **Convert to Linear** works (config was migrated in Task 2 Step 5).
