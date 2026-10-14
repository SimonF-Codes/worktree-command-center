import * as fs from 'fs';
import * as path from 'path';
import { runCommand } from './command-runner';
import { parseWorktreePorcelain, parseGitmodulesPaths } from './move-repo';
import { defaultProjectsDir, probeRenameCode, holdersByCommandLine } from './move-repo-io';
import { findLinks, unlinkLinksInside } from './terminals/worktree-manager';
import {
	planPrune, baseFor, countCherryUnmatched,
	type PruneFacts, type PruneRepoFacts, type PruneWorktreeFact, type PrunePlan, type RepoPrunePlan, type HeldDir,
} from './prune-worktrees';

// Pruning merged worktrees — the IO half. gatherPruneFacts reads everything planPrune needs;
// executePrune removes what a confirmed plan says may go, one `git worktree remove` each, and
// reads the result back. All the deciding is in prune-worktrees.ts.
//
// Read-only until executePrune, except for two things worth naming: the held-open probe is a
// rename in place and straight back (move-repo-io's — the only test Windows answers truthfully),
// and `git merge-tree --write-tree` writes the tree it computes into the object store, as loose
// objects nothing references (gc collects them). `git status` runs with --no-optional-locks so a
// scan never takes the index lock out from under a session working in that worktree.

export interface PruneTarget { name: string; path: string }

export interface PruneGatherContext {
	/** Working directory of every live terminal; null when not known (outside the app). */
	livePaths: string[] | null;
	/** The app's sessions file, for saved-but-not-started terminals. */
	sessionsFile?: string;
	projectsDir?: string;
	caseInsensitive?: boolean;
	/** Probe each candidate for a process holding it open (default on). Only candidates: there is
	 *  no reason to touch a directory that is kept anyway. */
	probe?: boolean;
}

const firstLine = (r: { stderr: string; error?: string }): string => (r.error ?? r.stderr).trim().split('\n')[0] || 'failed';
const lines = (s: string): string[] => s.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
const git = (cwd: string, args: string[], timeoutMs = 15000) => runCommand('git', args, { cwd, timeoutMs });

async function gatherRepo(t: PruneTarget): Promise<PruneRepoFacts> {
	const out: PruneRepoFacts = { repoName: t.name, repoPath: t.path, remotes: [], worktrees: [] };
	if (!fs.existsSync(t.path)) { out.error = `${t.path} does not exist`; return out; }
	const list = await git(t.path, ['worktree', 'list', '--porcelain']);
	if (list.code !== 0) { out.error = `git worktree list failed: ${firstLine(list)}`; return out; }
	const refs = await git(t.path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
	const branches = refs.code === 0 ? lines(refs.stdout).map((l) => l.trim()) : [];
	const remotes = await git(t.path, ['remote'], 8000);
	out.remotes = remotes.code === 0 ? lines(remotes.stdout).map((l) => l.trim()) : [];

	for (const w of parseWorktreePorcelain(list.stdout)) {
		const base = baseFor(w.branch, branches);
		const f: PruneWorktreeFact = { path: w.path, branch: w.branch, isMain: w.isMain, missing: w.prunable || !fs.existsSync(w.path), locked: w.locked, dirty: [], base, ahead: null, cherryUnmatched: null, contentMerged: null };
		out.worktrees.push(f);
		if (f.isMain || f.missing) continue;

		const st = await git(w.path, ['--no-optional-locks', 'status', '--porcelain']);
		f.dirty = st.code === 0 ? lines(st.stdout) : [`?? (git status failed, so this is treated as dirty: ${firstLine(st)})`];
		f.submodules = hasSubmoduleCheckout(w.path);
		if (!base) continue;
		const head = await git(w.path, ['rev-parse', 'HEAD'], 8000);
		if (head.code !== 0) continue;
		const sha = head.stdout.trim();
		const ahead = await git(t.path, ['rev-list', '--count', `${base}..${sha}`]);
		f.ahead = ahead.code === 0 ? (Number.isFinite(parseInt(ahead.stdout.trim(), 10)) ? parseInt(ahead.stdout.trim(), 10) : null) : null;
		if (f.ahead === null || f.ahead === 0) continue;
		const cherry = await git(t.path, ['cherry', base, sha]);
		f.cherryUnmatched = cherry.code === 0 ? countCherryUnmatched(cherry.stdout) : null;
		if (f.cherryUnmatched === 0) continue;
		f.contentMerged = await mergesToNothing(t.path, base, sha);
	}
	return out;
}

/** Would merging `sha` into `base` leave base's tree exactly as it is? Exit 1 is a conflict —
 *  certainly not merged; anything else unexpected is unknown (null). */
async function mergesToNothing(repo: string, base: string, sha: string): Promise<boolean | null> {
	const mt = await git(repo, ['merge-tree', '--write-tree', base, sha], 30000);
	if (mt.code === 1) return false;
	if (mt.code !== 0) return null;
	const tree = await git(repo, ['rev-parse', `${base}^{tree}`], 8000);
	if (tree.code !== 0) return null;
	return mt.stdout.split('\n')[0]!.trim() === tree.stdout.trim();
}

function hasSubmoduleCheckout(dir: string): boolean {
	let gm = '';
	try { gm = fs.readFileSync(path.join(dir, '.gitmodules'), 'utf8'); } catch { return false; }
	return parseGitmodulesPaths(gm).some((sub) => fs.existsSync(path.join(dir, sub, '.git')));
}

/** Directory name → number of .jsonl conversations in it. */
export function readTranscriptCounts(projectsDir: string): Record<string, number> {
	const out: Record<string, number> = {};
	let dirs: fs.Dirent[] = [];
	try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
	for (const d of dirs) {
		try { out[d.name] = fs.readdirSync(path.join(projectsDir, d.name)).filter((f) => f.endsWith('.jsonl')).length; }
		catch { out[d.name] = 0; }
	}
	return out;
}

/** Every saved terminal record's worktree path, from every bucket of the sessions file (open
 *  tabs and closed tabs' tombstones). An unreadable file gives none. */
export function readSavedTerminals(sessionsFile: string | undefined): { path: string; where: string }[] {
	if (!sessionsFile) return [];
	let all: Record<string, unknown> = {};
	try { all = JSON.parse(fs.readFileSync(sessionsFile, 'utf8')) as Record<string, unknown>; } catch { return []; }
	const out: { path: string; where: string }[] = [];
	for (const [k, recs] of Object.entries(all)) {
		if (!Array.isArray(recs)) continue;
		for (const r of recs as { worktreePath?: unknown; name?: unknown }[]) {
			if (typeof r?.worktreePath === 'string' && r.worktreePath) out.push({ path: r.worktreePath, where: `${k.startsWith('closed:') ? 'closed tab' : 'tab'} ${k.replace(/^closed:/, '')}${typeof r.name === 'string' && r.name ? ` (${r.name})` : ''}` });
		}
	}
	return out;
}

/** Read the world for every target. A repo git cannot list is reported with its error, never
 *  skipped silently; every other unanswerable question fails SAFE (dirty, or unknown). */
export async function gatherPruneFacts(targets: readonly PruneTarget[], ctx: PruneGatherContext): Promise<PruneFacts> {
	const ci = ctx.caseInsensitive ?? process.platform === 'win32';
	const repos: PruneRepoFacts[] = [];
	for (const t of targets) repos.push(await gatherRepo(t));
	const facts: PruneFacts = {
		repos, livePaths: ctx.livePaths, savedTerminals: readSavedTerminals(ctx.sessionsFile), heldOpen: [],
		transcripts: readTranscriptCounts(ctx.projectsDir ?? defaultProjectsDir()), caseInsensitive: ci,
	};
	// Only the candidates get the expensive looks: a walk for links, and the held-open probe.
	const candidates = planPrune(facts).repos.flatMap((r) => r.prune.map((e) => e.path));
	const byPath = new Map(repos.flatMap((r) => r.worktrees).map((w) => [w.path, w]));
	for (const c of candidates) { const w = byPath.get(c); if (w) w.links = await findLinks(c); }
	if (ctx.probe !== false) facts.heldOpen = await probeHeld(candidates);
	return facts;
}

async function probeHeld(dirs: string[]): Promise<HeldDir[]> {
	const held: { path: string; code: string }[] = [];
	for (const d of dirs) {
		const r = await probeRenameCode(d);
		if (r !== 'free' && r !== 'absent') held.push({ path: d, code: r });
	}
	if (!held.length) return [];
	const holders = await holdersByCommandLine(held.map((h) => h.path));
	return held.map((h) => ({ ...h, holders: holders.get(h.path) ?? [] }));
}

// ---------------------------------------------------------------------------------------------
// Executing

export interface PruneResult {
	repoName: string;
	path: string;
	branch: string;
	ok: boolean;
	detail: string;
}

/** Remove every entry in `prune` of each repo plan — and nothing else. `git worktree remove`
 *  without --force, so git itself refuses one that became dirty or locked since the plan.
 *  Branches are left alone. No blanket `git worktree prune` afterwards: it would also clear
 *  entries for worktrees already gone from disk, which are how Reopen recreates them (`git
 *  worktree remove` deletes its own entry). Each removal is read back: the directory is gone,
 *  git no longer lists it, and the branch still resolves. */
export async function executePrune(repos: readonly RepoPrunePlan[]): Promise<PruneResult[]> {
	const out: PruneResult[] = [];
	for (const r of repos) {
		for (const e of r.prune) {
			const res: PruneResult = { repoName: r.repoName, path: e.path, branch: e.branch, ok: false, detail: '' };
			out.push(res);
			// Links first (unlinkLinksInside): git would delete through them into their targets.
			// Any that will not go, and the worktree is not removed at all.
			const { unlinked: links, stuck } = await unlinkLinksInside(e.path);
			if (stuck.length) { res.detail = `not removed: could not unlink ${stuck.length} link${stuck.length === 1 ? '' : 's'} inside it (${stuck[0]!.path}), and git would delete through ${stuck.length === 1 ? 'it' : 'them'} into what ${stuck.length === 1 ? 'it points' : 'they point'} at`; continue; }
			const rm = await git(r.repoPath, ['worktree', 'remove', e.path], 60000);
			if (rm.code !== 0) { res.detail = explainRemoveFailure(firstLine(rm)) + (links.length ? ` (its ${links.length} link${links.length === 1 ? ' was' : 's were'} already unlinked)` : ''); continue; }
			const list = await git(r.repoPath, ['worktree', 'list', '--porcelain']);
			const stillListed = list.code !== 0 || parseWorktreePorcelain(list.stdout).some((w) => path.resolve(w.path).toLowerCase() === path.resolve(e.path).toLowerCase());
			const branchOk = !e.branch || (await git(r.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${e.branch}`], 8000)).code === 0;
			if (fs.existsSync(e.path)) res.detail = 'git reported success but the directory is still there';
			else if (stillListed) res.detail = 'removed, but git still lists it';
			else if (!branchOk) res.detail = `removed, but branch ${e.branch} no longer resolves`;
			else { res.ok = true; res.detail = `removed; branch ${e.branch || '(detached)'} kept`; }
		}
	}
	return out;
}

/** git's error for a held directory does not say which kind of hold it is; the errno word does. */
export function explainRemoveFailure(msg: string): string {
	if (/resource busy|EBUSY/i.test(msg)) return `${msg} — busy (EBUSY): a sync engine such as OneDrive holds it`;
	if (/permission denied|EACCES|EPERM/i.test(msg)) return `${msg} — held: a process's working directory is inside it, or a service holds the folder`;
	return msg;
}

/** The outcome, for the dialog after a run. */
export function describePruneResults(results: readonly PruneResult[], plan: PrunePlan): string {
	const ok = results.filter((r) => r.ok), bad = results.filter((r) => !r.ok);
	const lines: string[] = [`Removed ${ok.length} of ${results.length} worktree${results.length === 1 ? '' : 's'}. ${plan.totals.worktrees - ok.length} remain. Every branch is kept.`];
	for (const r of bad) lines.push(`✗ ${r.repoName} ${path.basename(r.path)}: ${r.detail}`);
	return lines.join('\n');
}
