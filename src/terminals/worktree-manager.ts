import * as path from 'path';
import * as fs from 'fs';
import { runCommand } from '../command-runner';
import { isParkCommitSubject, parkCommitSubject } from './worktree-registry';

export interface WorktreeInfo {
	worktreePath: string;
	branch: string;
}

export function slugify(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function autoBranchName(baseBranch: string, n: number): string {
	return `wt/${slugify(baseBranch)}-${n}`;
}

/** The branch a repo's dropdown should default to: prefer `main`, then `master`
 *  (e.g. Backend), else the first listed branch. */
export function defaultBranch(branches: string[]): string | undefined {
	if (branches.includes('main')) return 'main';
	if (branches.includes('master')) return 'master';
	return branches[0];
}

export const WORKTREES_DIR = '.claude-worktrees';

/** Where a repo's worktrees are created: INSIDE the repo, `<repo>/.claude-worktrees`, so a repo's
 *  worktrees sit with it, move with it, and need no per-repo grouping folder. It is inside the
 *  working tree, so ensureWorktreesExcluded keeps it out of git — createWorktree will not nest a
 *  worktree in a repo it could not exclude it from. */
export function worktreeRootFor(repoPath: string): string {
	return path.join(repoPath, WORKTREES_DIR);
}

/** Where builds before 0.12 created them: a shared root beside the repo,
 *  `<parent>/.claude-worktrees/<repo name>`. Never created any more, still resolved — a machine is
 *  half-migrated for a while, and everything that finds an existing worktree does so by its
 *  recorded path (git's worktree list, the sessions file), never by recomputing it. The relayout
 *  (planMove with from === to) moves worktrees out of here. */
export function legacyWorktreeRootFor(repoPath: string, repoName: string): string {
	return path.join(path.dirname(repoPath), WORKTREES_DIR, repoName);
}

export function worktreePathFor(repoPath: string, branch: string): string {
	return path.join(worktreeRootFor(repoPath), slugify(branch));
}

export function shouldRemoveWorktree(statusPorcelain: string, revListCount: number): boolean {
	return statusPorcelain.trim() === '' && revListCount === 0;
}

/** System-prompt text injected into each spawned session so the terminal knows
 *  what it is, that sibling terminals share the repo, and the cross-repo rule. */
export function terminalSystemPrompt(repoName: string, branch: string, worktreePath: string): string {
	return [
		'You are a Claude Code session running inside a dedicated git worktree that was created for you by the Worktree Command Center app. Keep these facts in mind for the whole session:',
		'',
		`- Identity: you are working in repo "${repoName}", on branch "${branch}", in the working directory "${worktreePath}". This worktree is yours — do your work here, on this branch.`,
		`- Parallelism: other Claude Code terminals are very likely open AT THE SAME TIME in this same "${repoName}" repo, each on its own separate worktree and branch. You are not the only one working in this repo. Do not assume exclusive ownership, expect branches and worktrees you did not create, and prefer rebasing/merging over assuming a clean shared state.`,
		'- Cross-repo rule: if your task requires changing a DIFFERENT repository, do NOT edit that other repo\'s primary checkout directly. Create a new git worktree in that repo (e.g. `git worktree add -b <branch> <path> <base>`) and make the changes there, mirroring how this terminal was set up. One worktree per repo you touch.',
		'',
		'Coordinating with the other terminals (they share resources with you):',
		'- A `cos-coord` command is on your PATH. Before any DESTRUCTIVE or EXCLUSIVE operation on a shared resource (a DB reset, a backtest/replay, an A/B run, a migration), first run `cos-coord status` to see what is active.',
		'- Then wrap the operation in a lock: `cos-coord acquire <area>:<thing> --reason "..." [--ttl <seconds>] && <your command> ; cos-coord release <area>:<thing>`. Resource names are lowercase `<area>:<thing>`, e.g. `db:reset`. If acquire fails, another terminal holds it — wait and retry, do not force it.',
		'- When a long task finishes, run `cos-coord note "..."` so other terminals stop waiting.',
		'- `git push` and `git worktree add` are locked for you automatically; if one is denied, wait a few seconds and retry.',
		'- `<coordDir>/worktrees.md` is the shared ledger of everyone\'s in-flight work — read it to see what other terminals have uncommitted before you touch shared files. Abandoned work is auto-parked as `wip:` commits on its branch.',
	].join('\n');
}

/** System-prompt text for a FOLDER target — a plain directory with no git repo, so there is no
 *  worktree, no branch, and no "your own isolated copy" guarantee. The isolation paragraph from
 *  terminalSystemPrompt would be an outright lie here, so this says the opposite: you are in the
 *  real directory and other terminals may be in it too. The coordination paragraph is kept
 *  verbatim — locks matter MORE without worktree isolation, not less. */
export function folderSystemPrompt(folderName: string, folderPath: string): string {
	return [
		'You are a Claude Code session running inside a plain FOLDER target of the Worktree Command Center app. Keep these facts in mind for the whole session:',
		'',
		`- Identity: you are working in the folder "${folderName}", whose working directory is "${folderPath}".`,
		'- This is NOT a git worktree. It may not be a git repository at all, so do not assume `git` commands work here, and do not expect a branch of your own. There is no isolated copy and no cheap undo — every edit lands directly on the real files.',
		`- Parallelism: other Claude Code terminals may be open AT THE SAME TIME in this same folder, working on the SAME files (there are no per-terminal worktrees to separate you). Re-read a file before editing it, keep your edits narrow, and never assume you are the only writer.`,
		'- Cross-repo rule: if your task requires changing a git REPOSITORY, do NOT edit that repo\'s primary checkout directly. Create a new git worktree in it (e.g. `git worktree add -b <branch> <path> <base>`) and make the changes there. One worktree per repo you touch.',
		'',
		'Coordinating with the other terminals (they share resources with you):',
		'- A `cos-coord` command is on your PATH. Before any DESTRUCTIVE or EXCLUSIVE operation on a shared resource (a DB reset, a backtest/replay, an A/B run, a migration), first run `cos-coord status` to see what is active.',
		'- Then wrap the operation in a lock: `cos-coord acquire <area>:<thing> --reason "..." [--ttl <seconds>] && <your command> ; cos-coord release <area>:<thing>`. Resource names are lowercase `<area>:<thing>`, e.g. `db:reset`. If acquire fails, another terminal holds it — wait and retry, do not force it.',
		'- When a long task finishes, run `cos-coord note "..."` so other terminals stop waiting.',
		'- Because this folder has no worktree isolation, treat a batch of edits to shared files here as an exclusive operation and take a lock for it.',
	].join('\n');
}

/** Branch names from `git branch`, current-branch marker and whitespace stripped. */
export async function listBranches(repoPath: string): Promise<string[]> {
	const r = await runCommand('git', ['branch', '--format=%(refname:short)'], { cwd: repoPath, timeoutMs: 8000 });
	if (r.code !== 0) return [];
	return r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/** The session settings content: the .cos-ready marker hook (Stop/Notification), the
 *  coordination hooks (PreToolUse acquire / PostToolUse release) on Bash, a Task-matcher hook
 *  that logs background Task/Agent runs to the board (for the Coordination panel's
 *  background-tasks list), and a pre-approval of `cos-coord` so agents chat/coordinate with
 *  each other without prompting. */
export function worktreeSettingsJson(notifyScriptAbsPath: string, coordHookAbsPath: string): string {
	const ready = [{ hooks: [{ type: 'command', command: `node "${notifyScriptAbsPath}"` }] }];
	const coord = (extra: string) => ({ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${coordHookAbsPath}"${extra}` }] });
	const task = (extra: string) => ({ matcher: 'Task', hooks: [{ type: 'command', command: `node "${coordHookAbsPath}" --task${extra}` }] });
	return JSON.stringify({
		permissions: { allow: ['Bash(cos-coord:*)'] }, // chatting/coordinating never needs approval
		hooks: { Stop: ready, Notification: ready, PreToolUse: [coord(''), task('')], PostToolUse: [coord(' --release'), task(' --release')] },
	}, null, 2);
}

/** Where the shared settings file lives: beside the sidecar, NEVER inside a worktree.
 *  The content is identical for every terminal (it depends only on the two script paths),
 *  so one file serves them all and is passed to each session via `claude --settings`. */
export function worktreeSettingsPath(sidecarDir: string): string {
	return path.join(sidecarDir, 'settings', 'worktree-settings.json');
}

/** Write the shared settings file. Writing it OUTSIDE the worktree is the point: a repo may
 *  legitimately TRACK its own `.claude/settings.local.json`, and writing ours on top of that
 *  clobbered the repo's shared config, left every worktree permanently dirty with that one
 *  file, and let parkWorktree(`git add -A`) commit the deletion onto the branch. Mirrors
 *  writeContextFile's "never dirty the worktree" rule. Synchronous so the file is guaranteed
 *  present before any session spawns. */
export function writeWorktreeSettings(sidecarDir: string, notifyScriptAbsPath: string, coordHookAbsPath: string): string {
	const file = worktreeSettingsPath(sidecarDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, worktreeSettingsJson(notifyScriptAbsPath, coordHookAbsPath), 'utf8');
	return file;
}

/** Append each missing line to `<git common dir>/info/exclude`. That file is shared by every
 *  worktree of the repo, local to this clone, and never committed, so this never touches a
 *  tracked file. Idempotent — checked before appending. Throws when it cannot. */
export async function ensureExcluded(repoPath: string, entries: readonly string[]): Promise<void> {
	const gitDir = await runCommand('git', ['rev-parse', '--git-common-dir'], { cwd: repoPath, timeoutMs: 8000 });
	if (gitDir.code !== 0) throw new Error(`git rev-parse --git-common-dir failed in ${repoPath}: ${(gitDir.error ?? gitDir.stderr).trim().split('\n')[0]}`);
	const excludePath = path.join(path.resolve(repoPath, gitDir.stdout.trim()), 'info', 'exclude');
	let existing = '';
	try { existing = fs.readFileSync(excludePath, 'utf8'); } catch { /* doesn't exist yet */ }
	const have = new Set(existing.split('\n').map((l) => l.trim()));
	const missing = entries.filter((e) => !have.has(e));
	if (!missing.length) return;
	fs.mkdirSync(path.dirname(excludePath), { recursive: true });
	const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
	fs.appendFileSync(excludePath, `${sep}${missing.join('\n')}\n`, 'utf8');
}

/** The exclude line for the nested worktree root: anchored to the repo root, directories only. */
export const WORKTREES_EXCLUDE = `/${WORKTREES_DIR}/`;

/** Keep the nested worktree root out of the repo's own `git status`. Without it every primary
 *  checkout shows `?? .claude-worktrees/` — which reads as dirty to the floor scan and makes every
 *  repo Move refuse — and tools that honour git's ignores walk into every worktree.
 *
 *  `info/exclude`, not a committed .gitignore line: the folder exists only on a clone where this
 *  app makes worktrees, so the rule belongs to the clone, not to the repo's shared history — no
 *  commit per repo, nothing to merge, and it works the same in a repo with no remote or one that
 *  is not ours to commit to. A .gitignore line would protect nothing extra: measured on
 *  2026-10-14, `git clean -fdx` already SKIPS a nested worktree ("Would skip repository"), and
 *  `-ffdx` deletes it with or without any ignore rule. */
export async function ensureWorktreesExcluded(repoPath: string): Promise<void> {
	await ensureExcluded(repoPath, [WORKTREES_EXCLUDE]);
}

/** Keep `.claude/settings.local.json` — and the nested worktree root — out of `git status`.
 *  Nothing writes that file into a worktree any more (writeWorktreeSettings puts one shared copy
 *  beside the sidecar instead), but worktrees created by earlier builds still carry one, and it's
 *  our own bookkeeping, not the user's work — it shouldn't make an untouched worktree read as
 *  "dirty". Run on every repo the floor scan reaches, so a target is covered before its first
 *  nested worktree exists. Best-effort: a failure here never blocks the scan (createWorktree
 *  checks the worktree root again itself, and refuses). */
export async function ensureClaudeSettingsIgnored(repoPath: string): Promise<void> {
	try { await ensureExcluded(repoPath, ['.claude/settings.local.json', WORKTREES_EXCLUDE]); }
	catch { /* best effort */ }
}

/** Create a fresh worktree on a NEW branch based on baseBranch, inside the repo. Throws on git
 *  failure — and before creating anything if the worktree root cannot be excluded from git. */
export async function createWorktree(repoPath: string, baseBranch: string, branch: string): Promise<WorktreeInfo> {
	const worktreePath = worktreePathFor(repoPath, branch);
	try { await ensureWorktreesExcluded(repoPath); }
	catch (e) { throw new Error(`could not add ${WORKTREES_EXCLUDE} to .git/info/exclude, so no worktree was nested in the repo: ${(e as Error).message}`); }
	const r = await runCommand('git', ['worktree', 'add', worktreePath, '-b', branch, baseBranch], { cwd: repoPath, timeoutMs: 20000 });
	if (r.code !== 0) {
		throw new Error((r.error ?? r.stderr).split('\n')[0] || 'git worktree add failed');
	}
	return { worktreePath, branch };
}

export interface LinkInfo { path: string; target: string }

/** Every symlink and junction inside `dir`, never descending into one (Node's lstat reports a
 *  junction as a symbolic link). The worktree's own `.git` is skipped. */
export async function findLinks(dir: string): Promise<LinkInfo[]> {
	const out: LinkInfo[] = [];
	const walk = async (d: string): Promise<void> => {
		let ents: fs.Dirent[];
		try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
		for (const e of ents) {
			const p = path.join(d, e.name);
			if (e.isSymbolicLink()) {
				let target = '?';
				try { target = await fs.promises.readlink(p); } catch { /* unreadable target: still a link */ }
				out.push({ path: p, target });
			} else if (e.isDirectory() && !(d === dir && e.name === '.git')) {
				await walk(p);
			}
		}
	};
	await walk(dir);
	return out;
}

/** Drop every link inside `dir` — the LINK only — so that a recursive delete of `dir` afterwards
 *  has no link to cross.
 *
 *  Why: `git worktree remove` (with or without --force) deletes THROUGH a directory junction, into
 *  its target. Reproduced on 2026-10-14 (exit 0, target emptied), and it is how the primary
 *  checkout's node_modules was wiped once: a worktree's node_modules was a junction to it.
 *
 *  Each link goes with a NON-recursive call: rmdir (RemoveDirectoryW — what .NET's
 *  Directory.Delete(path, false) calls), which removes a directory junction or symlink itself and
 *  can never descend; unlink for a file symlink. Never `cmd /c rmdir`: from Git Bash the /c is
 *  path-mangled and it silently does nothing. A link still there afterwards is in `stuck`, and a
 *  caller must then NOT delete the directory. */
export async function unlinkLinksInside(dir: string): Promise<{ unlinked: LinkInfo[]; stuck: LinkInfo[] }> {
	const unlinked: LinkInfo[] = [], stuck: LinkInfo[] = [];
	for (const l of await findLinks(dir)) {
		try { fs.rmdirSync(l.path); } catch { try { fs.unlinkSync(l.path); } catch { /* checked below */ } }
		let gone = false;
		try { fs.lstatSync(l.path); } catch { gone = true; }
		(gone ? unlinked : stuck).push(l);
	}
	return { unlinked, stuck };
}

/** Remove the worktree only if pristine; otherwise keep it. Returns the action taken. Links inside
 *  it are dropped first (unlinkLinksInside); one that will not go keeps the worktree. */
export async function removeWorktreeIfPristine(
	repoPath: string, worktreePath: string, baseBranch: string,
): Promise<'removed' | 'kept'> {
	const status = await runCommand('git', ['status', '--porcelain'], { cwd: worktreePath, timeoutMs: 8000 });
	const revs = await runCommand('git', ['rev-list', '--count', `${baseBranch}..HEAD`], { cwd: worktreePath, timeoutMs: 8000 });
	// Fail safe on both probes: if status OR rev-list errored, treat as NOT pristine so we never delete work we couldn't verify.
	const count = revs.code === 0 ? (parseInt(revs.stdout.trim() || '0', 10) || 0) : 1;
	if (!shouldRemoveWorktree(status.code === 0 ? status.stdout : ' M', count)) return 'kept';
	if ((await unlinkLinksInside(worktreePath)).stuck.length) return 'kept';
	const rm = await runCommand('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath, timeoutMs: 15000 });
	return rm.code === 0 ? 'removed' : 'kept';
}

/** `git cherry` output: how many commits have no equivalent patch upstream ('+' lines). */
export function countCherryUnmatched(s: string): number {
	return String(s).split('\n').filter((l) => l.startsWith('+')).length;
}

/** Would merging `sha` into `base` leave base's tree exactly as it is? Exit 1 is a conflict —
 *  certainly not merged; anything else unexpected is unknown (null). */
export async function mergesToNothing(repo: string, base: string, sha: string): Promise<boolean | null> {
	const mt = await runCommand('git', ['merge-tree', '--write-tree', base, sha], { cwd: repo, timeoutMs: 30000 });
	if (mt.code === 1) return false;
	if (mt.code !== 0) return null;
	const tree = await runCommand('git', ['rev-parse', `${base}^{tree}`], { cwd: repo, timeoutMs: 8000 });
	if (tree.code !== 0) return null;
	return mt.stdout.split('\n')[0]!.trim() === tree.stdout.trim();
}

/** How a branch's commits were found to be in its base — the prune's three checks, strongest
 *  first (prune-worktrees.ts explains each). */
export type MergedBy = 'ancestor' | 'patch-id' | 'content';

/** Is every commit of `branch` already in `base`? `merged` is how that held, or null when no check
 *  did; `ahead` is `rev-list --count base..branch`, null when git could not say (a base that no
 *  longer resolves, say). Never throws, and an unanswered question never counts as merged.
 *
 *  Why three checks and not `git branch -d`'s one: -d, like `branch --merged` and rev-list, asks
 *  only about ancestry, so a branch landed by rebase or squash reads as unmerged. `git cherry`
 *  compares patch-ids and sees a rebase, a cherry-pick, or a squash of ONE commit; only merge-tree
 *  sees a squash of several. What none of them can tell from unmerged work is a squashed branch
 *  whose lines base has changed again since — that reads as unmerged, which errs toward keeping. */
export async function branchMergedInto(repoPath: string, base: string, branch: string): Promise<{ merged: MergedBy | null; ahead: number | null }> {
	try {
		if (!base) return { merged: null, ahead: null };
		const sha = await runCommand('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath, timeoutMs: 8000 });
		if (sha.code !== 0) return { merged: null, ahead: null };
		const head = sha.stdout.trim();
		const revs = await runCommand('git', ['rev-list', '--count', `${base}..${head}`], { cwd: repoPath, timeoutMs: 8000 });
		const n = parseInt(revs.stdout.trim(), 10);
		if (revs.code !== 0 || !Number.isFinite(n)) return { merged: null, ahead: null };
		if (n === 0) return { merged: 'ancestor', ahead: 0 };
		const cherry = await runCommand('git', ['cherry', base, head], { cwd: repoPath, timeoutMs: 15000 });
		if (cherry.code === 0 && countCherryUnmatched(cherry.stdout) === 0) return { merged: 'patch-id', ahead: n };
		if (await mergesToNothing(repoPath, base, head) === true) return { merged: 'content', ahead: n };
		return { merged: null, ahead: n };
	} catch {
		return { merged: null, ahead: null };
	}
}

/** What the tile × actually did. */
export interface CloseOutcome {
	worktree: 'removed' | 'kept';
	branch: 'deleted' | 'kept';
	/** Uncommitted work was committed onto the branch first (parkWorktree). */
	parked: boolean;
	/** Why the branch or worktree was kept, in words for the user; '' when both went. */
	reason: string;
}

/** The tile × — remove a worktree, and delete its branch only when that loses nothing.
 *
 *  It used to be `worktree remove --force` + `branch -D`, a force delete that never looked. On
 *  2026-10-21 that took a branch holding three unmerged commits, which survived only because a
 *  remote happened to have them. Now, in order:
 *   1. Links inside are dropped (unlinkLinksInside); one that will not go keeps EVERYTHING — git
 *      would delete through it, and the branch is still checked out there.
 *   2. Uncommitted work is parked onto the branch (parkWorktree), so removing the worktree does
 *      not discard it. A park that fails keeps the worktree: --force would throw that work away.
 *   3. The worktree is removed. The directory is the cheap part — `git worktree add` restores it.
 *   4. The branch is deleted only when branchMergedInto finds every commit in `baseBranch`. If any
 *      commit would be lost, or merged-ness cannot be established, the branch is KEPT and the
 *      outcome says why — the promise parkForSessionEnd already makes: ending a session never
 *      destroys work. Never throws. */
export async function removeWorktreeAndBranch(
	repoPath: string, worktreePath: string, branch: string, baseBranch: string, nowIso = new Date().toISOString(),
): Promise<CloseOutcome> {
	const out: CloseOutcome = { worktree: 'kept', branch: 'kept', parked: false, reason: '' };
	try {
		const { stuck } = await unlinkLinksInside(worktreePath);
		if (stuck.length) { out.reason = `could not unlink ${stuck[0]!.path}, and git would delete through it`; return out; }
		if (fs.existsSync(worktreePath)) {
			const park = await parkWorktree(worktreePath, nowIso);
			if (park === 'failed') { out.reason = 'its uncommitted work could not be committed, so the worktree was left as it is'; return out; }
			out.parked = park === 'parked';
		}
		const rm = await runCommand('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath, timeoutMs: 15000 });
		if (rm.code === 0) out.worktree = 'removed';
		if (!branch) return out;
		const m = await branchMergedInto(repoPath, baseBranch, branch);
		if (m.merged === null) {
			out.reason = m.ahead === null
				? `could not tell whether it is merged into ${baseBranch || 'its base'}`
				: `${m.ahead} commit${m.ahead === 1 ? '' : 's'} not in ${baseBranch}${out.parked ? ', including its parked uncommitted work' : ''}`;
			return out;
		}
		if (out.worktree !== 'removed') { out.reason = 'the worktree could not be removed, and the branch is still checked out in it'; return out; }
		const del = await runCommand('git', ['branch', '-D', branch], { cwd: repoPath, timeoutMs: 8000 });
		if (del.code === 0) out.branch = 'deleted';
		else out.reason = `git branch -D failed: ${(del.error ?? del.stderr).trim().split('\n')[0]}`;
	} catch (e) {
		out.reason = `the close failed part-way: ${(e as Error).message}`;
	}
	return out;
}

/** Auto-save a dirty worktree as a recoverable commit on ITS OWN branch. Returns the
 *  action taken. Never throws and never deletes — a failure keeps the worktree intact. */
export async function parkWorktree(worktreePath: string, nowIso: string): Promise<'parked' | 'clean' | 'failed'> {
	const status = await runCommand('git', ['status', '--porcelain'], { cwd: worktreePath, timeoutMs: 8000 });
	if (status.code !== 0) return 'failed';
	if (status.stdout.trim() === '') return 'clean';
	const add = await runCommand('git', ['add', '-A'], { cwd: worktreePath, timeoutMs: 15000 });
	if (add.code !== 0) return 'failed';
	const commit = await runCommand('git', ['commit', '-m', parkCommitSubject(nowIso), '--no-verify'], { cwd: worktreePath, timeoutMs: 15000 });
	return commit.code === 0 ? 'parked' : 'failed';
}

/** The ONLY git step of ending a session without losing it (TerminalsGrid.endSessionKeepingWork).
 *  It parks uncommitted work on the worktree's own branch and does nothing else: it never removes
 *  the worktree or deletes the branch, because the transcript in ~/.claude/projects is keyed by
 *  worktree PATH and either would make the session unresumable. A folder target is never parked:
 *  its directory is the user's own, and `git add -A` there would commit their working tree into
 *  whatever repo happens to contain it (the same reason parkAll() skips them). Never throws. */
export async function parkForSessionEnd(worktreePath: string, isFolder: boolean, nowIso: string): Promise<'parked' | 'clean' | 'failed' | 'skipped'> {
	if (isFolder) return 'skipped';
	try { return await parkWorktree(worktreePath, nowIso); }
	catch { return 'failed'; } // parking is a safety net, not a precondition for ending the session
}

/** Restore parked work to uncommitted: if HEAD is a park commit, soft-reset it so the
 *  changes come back as they were. Recreates the worktree from the branch if its folder
 *  is gone. Safe — only ever soft-resets our own park commit. */
export async function reopenWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
	const probe = await runCommand('git', ['rev-parse', '--git-dir'], { cwd: worktreePath, timeoutMs: 8000 });
	if (probe.code !== 0) {
		await runCommand('git', ['worktree', 'add', worktreePath, branch], { cwd: repoPath, timeoutMs: 20000 });
	}
	const subj = await runCommand('git', ['log', '-1', '--pretty=%s'], { cwd: worktreePath, timeoutMs: 8000 });
	if (subj.code === 0 && isParkCommitSubject(subj.stdout.trim())) {
		await runCommand('git', ['reset', '--soft', 'HEAD~1'], { cwd: worktreePath, timeoutMs: 8000 });
	}
}
