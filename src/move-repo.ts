import * as path from 'path';
import { projectDirName } from './terminals/resume-target';
import { worktreeRootFor, legacyWorktreeRootFor } from './terminals/worktree-manager';
import type { RepoConfig } from './terminals/terminals-grid';

// Moving a repo — the PURE half. Given what is on disk (gathered by move-repo-io.ts), compute
// the whole plan and every reason to refuse it, before a byte is touched.
//
// A repo directory is the least of what a move has to change. Five other things hold its path:
//   1. both ends of every worktree link — <repo>/.git/worktrees/<n>/gitdir and each worktree's
//      own .git file hold absolute paths to each other (`git worktree repair` fixes both);
//   2. the worktrees' own root — worktrees live inside the repo (<repo>/.claude-worktrees) and
//      ride along with it, but ones still in the shared root of builds before 0.12
//      (<parent>/.claude-worktrees/<name>) would be stranded, so they are relocated into it;
//   3. config.json — repos[].path, and every tab linked to it (workspaces[].repo, and the
//      tombstones of closed tabs, which come back linked);
//   4. the sessions file — each saved tile records its worktreePath, and a record whose path is
//      unreachable is retained-but-unrestored forever;
//   5. ~/.claude/projects/<mangled path> — the resumable transcript. Move a worktree without it
//      and the conversation is not deleted, it is ORPHANED, which is much harder to notice.
// This module plans all of them; doing only the first is what makes a move by hand dangerous.
//
// Built from three consolidation moves done by hand on 2026-10-14 (the vault's "Machine — Repo
// Consolidation" design, Phase 1-3 outcomes); every refusal below is a failure hit there.
//
// A RELAYOUT is the same plan with from === to: the repo stays put and only its worktrees in the
// old shared root move into it (`git worktree move`), with their transcripts and saved terminals.
// It is how a machine migrates to the nested layout, one repo at a time — half-migrated is a
// normal state, because everything finds an existing worktree by its recorded path.

/** One worktree as `git worktree list --porcelain` reports it, plus its dirty files. */
export interface WorktreeFact {
	path: string;
	/** Short branch name; '' when detached. */
	branch: string;
	/** The repo's own checkout (the first entry git lists). */
	isMain: boolean;
	/** git has marked it prunable: its directory is gone. */
	prunable: boolean;
	locked: boolean;
	/** `git status --porcelain` lines; [] when clean (or not checked because it is missing). */
	dirty: string[];
}

/** Everything the planner needs, all of it read before anything is decided. */
export interface MoveFacts {
	/** Where the target is registered — the repo's path before the move. */
	from: string;
	/** Where it is going: the repo directory's new full path, not its new parent. */
	to: string;
	/** The target's registered name: the old shared worktree root is keyed on it. */
	repoName: string;
	fromExists: boolean;
	toExists: boolean;
	/** What is at the repo's CURRENT location (`from`, or `to` when resuming a move that already
	 *  moved the directory): `.git` is a directory, a file (a worktree), absent, or no folder. */
	kind: 'repo' | 'worktree' | 'folder' | 'missing';
	/** The target is registered as a plain folder (no git). */
	folderTarget: boolean;
	worktrees: WorktreeFact[];
	/** `git remote` names. */
	remotes: string[];
	/** Submodule checkouts whose `.git` file points at an ABSOLUTE gitdir. */
	absoluteSubmodules: { path: string; gitdir: string }[];
	/** Worktrees with at least one initialized submodule checkout. `git worktree move` refuses
	 *  them outright ("working trees containing submodules cannot be moved or removed"). */
	submoduleWorktrees?: string[];
	/** Worktree relocations an unfinished earlier run of this same move wrote to its journal. A
	 *  worktree found at one's `to` is that relocation, finished — the only way to tell it from one
	 *  that was always there, since both now sit inside the repo. */
	priorRelocations?: PathMove[];
	/** Working directory of every live terminal in the app, any workspace. */
	livePaths: string[];
	/** Directories that cannot be renamed because a process holds them open. */
	heldOpen: { path: string; holders: string[] }[];
	/** Directory names in ~/.claude/projects. */
	transcriptDirs: string[];
	/** Planned destinations (from plannedDestinations) found to exist already. */
	existing: string[];
	/** Every registered target, this one included. */
	targets: RepoConfig[];
	/** Other config.json values that hold a path inside the repo (e.g. `god.sourceRepo`). Not
	 *  rewritten — named in the plan so nobody finds out afterwards. */
	configRefs: string[];
	/** Compare paths and transcript names case-insensitively (Windows). */
	caseInsensitive: boolean;
}

export interface PathMove { from: string; to: string }
export interface WorktreeMove extends PathMove { branch: string; done: boolean }
/** A transcript directory rename, by name inside ~/.claude/projects. */
export interface TranscriptRename extends PathMove { done: boolean }

export type RefusalCode =
	| 'same-path' | 'inside-itself' | 'cross-volume' | 'missing' | 'destination-exists'
	| 'not-primary' | 'not-a-repo' | 'folder-target' | 'target-taken'
	| 'dirty' | 'live-terminal' | 'held-open' | 'locked-worktree' | 'worktree-destination-exists'
	| 'absolute-submodule' | 'submodule-worktree' | 'transcript-conflict' | 'nothing-to-relayout';

export interface Refusal { code: RefusalCode; path?: string; message: string }

export interface MovePlan {
	from: string;
	to: string;
	repoName: string;
	/** The repo directory already sits at `to`: a previous run got that far. */
	resuming: boolean;
	/** from === to: the repo stays, only its worktrees in the old shared root move into it. */
	relayout: boolean;
	/** The old shared root (legacyWorktreeRootFor) worktrees are relocated OUT of, and the root
	 *  inside the repo's new location (worktreeRootFor) they are relocated INTO. */
	oldWorktreeRoot: string;
	newWorktreeRoot: string;
	/** Worktrees in the old shared root, relocated into the repo with `git worktree move`. */
	worktreeMoves: WorktreeMove[];
	/** Worktrees nested inside the repo directory: they move with it, no step of their own. */
	carried: PathMove[];
	/** Worktrees anywhere else: left where they are, links repaired in place. */
	staying: { path: string; branch: string }[];
	/** Paths handed to `git worktree repair` once the repo directory has moved — each worktree
	 *  where it is AT THAT MOMENT (relocations happen after the repair). */
	repair: string[];
	/** Every old → new absolute path the move implies: the repo, then each relocation. A path
	 *  inside a moved directory maps with it (see remapPath). */
	pathMap: PathMove[];
	transcripts: TranscriptRename[];
	/** Worktrees that resolve before the move and must still resolve after it — what verification
	 *  checks. Excludes worktrees that were already missing (warned about, not our doing). */
	expectedWorktrees: string[];
	refusals: Refusal[];
	warnings: string[];
}

// ---------------------------------------------------------------------------------------------
// Paths

function norm(p: string, ci: boolean): string {
	let r = path.resolve(p);
	if (r.length > path.parse(r).root.length) r = r.replace(/[\\/]+$/, '');
	return ci ? r.toLowerCase() : r;
}

export function samePath(a: string, b: string, ci: boolean): boolean { return norm(a, ci) === norm(b, ci); }

/** `p` is `dir` or somewhere beneath it. Separator-bounded: C:\dev\Repo2 is not inside C:\dev\Repo. */
export function isInside(p: string, dir: string, ci: boolean): boolean {
	const a = norm(p, ci), d = norm(dir, ci);
	return a === d || a.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

/** Where `p` ends up under a path map: the longest `from` that contains it wins, so a worktree
 *  relocated on its own beats the repo it used to sit beside. Unmapped → `p` unchanged. */
export function remapPath(p: string, map: readonly PathMove[], ci: boolean): string {
	let best: PathMove | null = null;
	for (const m of map) {
		if (isInside(p, m.from, ci) && (!best || norm(m.from, ci).length > norm(best.from, ci).length)) best = m;
	}
	if (!best) return p;
	const rel = path.relative(path.resolve(best.from), path.resolve(p));
	return rel ? path.join(best.to, rel) : best.to;
}

export { worktreeRootFor, legacyWorktreeRootFor };

// ---------------------------------------------------------------------------------------------
// Parsing what git and the filesystem say

/** `git worktree list --porcelain`, with the flags the move cares about. Paths come back in git's
 *  spelling (forward slashes on Windows) and are resolved here. A bare entry is skipped. */
export function parseWorktreePorcelain(s: string): Omit<WorktreeFact, 'dirty'>[] {
	const out: Omit<WorktreeFact, 'dirty'>[] = [];
	let cur: Omit<WorktreeFact, 'dirty'> & { bare?: boolean } | null = null;
	const flush = (): void => { if (cur && !cur.bare) out.push({ path: cur.path, branch: cur.branch, isMain: cur.isMain, prunable: cur.prunable, locked: cur.locked }); };
	for (const raw of String(s).split('\n')) {
		const line = raw.replace(/\r$/, '');
		if (line.startsWith('worktree ')) {
			flush();
			cur = { path: path.resolve(line.slice(9)), branch: '', isMain: out.length === 0 && !cur, prunable: false, locked: false };
		} else if (!cur) {
			continue;
		} else if (line.startsWith('branch ')) {
			cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
		} else if (line === 'bare') {
			cur.bare = true;
		} else if (line === 'prunable' || line.startsWith('prunable ')) {
			cur.prunable = true;
		} else if (line === 'locked' || line.startsWith('locked ')) {
			cur.locked = true;
		}
	}
	flush();
	return out;
}

/** Submodule checkout paths from a .gitmodules file. */
export function parseGitmodulesPaths(s: string): string[] {
	const out: string[] = [];
	for (const raw of String(s).split('\n')) {
		const m = /^\s*path\s*=\s*(.+?)\s*$/.exec(raw);
		if (m) out.push(m[1]!);
	}
	return out;
}

/** The target of a `.git` FILE (`gitdir: …`), or null when it is not one. */
export function gitdirOf(dotGitFile: string): string | null {
	const m = /^gitdir:\s*(.+?)\s*$/m.exec(String(dotGitFile));
	return m ? m[1]! : null;
}

/** An absolute gitdir breaks when the tree moves; modern git writes `../.git/modules/<n>`, which
 *  survives untouched (verified on the Scrimba repos). Either OS's absolute form counts: the file
 *  may have been written by a git on the other one. */
export function isAbsoluteGitdir(gitdir: string): boolean {
	return path.isAbsolute(gitdir) || path.win32.isAbsolute(gitdir) || path.posix.isAbsolute(gitdir);
}

// ---------------------------------------------------------------------------------------------
// The plan

/** The worktree destinations a move would create — gathered for existence BEFORE planning, so
 *  the planner can refuse a move onto something already there. */
export function plannedDestinations(f: Pick<MoveFacts, 'from' | 'to' | 'repoName' | 'worktrees' | 'caseInsensitive'>): string[] {
	const oldRoot = legacyWorktreeRootFor(f.from, f.repoName), newRoot = worktreeRootFor(f.to);
	return f.worktrees
		.filter((w) => !w.isMain && !isInside(w.path, f.from, f.caseInsensitive) && isInside(w.path, oldRoot, f.caseInsensitive))
		.map((w) => remapPath(w.path, [{ from: oldRoot, to: newRoot }], f.caseInsensitive));
}

const sample = (xs: readonly string[], n = 3): string => xs.slice(0, n).join(', ') + (xs.length > n ? `, +${xs.length - n} more` : '');

/** Compute the whole move: every directory to move, every link to repair, every transcript to
 *  rename, the path map the config and sessions edits apply — and every reason not to.
 *
 *  Idempotent by construction: it plans from what is on disk NOW, so a move that stopped halfway
 *  replans into exactly the steps left (each carries `done`). A plan with any refusal must not be
 *  executed; warnings are things the user must be told BEFORE confirming, not after. */
export function planMove(f: MoveFacts): MovePlan {
	const ci = f.caseInsensitive;
	const refusals: Refusal[] = [];
	const warnings: string[] = [];
	const refuse = (code: RefusalCode, message: string, p?: string): void => { refusals.push({ code, message, ...(p ? { path: p } : {}) }); };

	const relayout = samePath(f.from, f.to, ci);
	const oldWorktreeRoot = legacyWorktreeRootFor(f.from, f.repoName);
	const newWorktreeRoot = worktreeRootFor(f.to);
	const resuming = !relayout && !f.fromExists && f.toExists;
	const here = resuming ? f.to : f.from;

	const plan: MovePlan = {
		from: f.from, to: f.to, repoName: f.repoName, resuming, relayout,
		oldWorktreeRoot, newWorktreeRoot,
		worktreeMoves: [], carried: [], staying: [], repair: [], pathMap: relayout ? [] : [{ from: f.from, to: f.to }],
		transcripts: [], expectedWorktrees: [], refusals, warnings,
	};

	// --- the shape of the request itself
	if (relayout) {
		if (!f.fromExists) { refuse('missing', `Nothing at ${f.from} — there is no repo here to relayout.`); return plan; }
	} else {
		if (isInside(f.to, f.from, ci)) { refuse('inside-itself', `${f.to} is inside the repo itself.`); return plan; }
		if (path.parse(path.resolve(f.from)).root.toLowerCase() !== path.parse(path.resolve(f.to)).root.toLowerCase()) {
			refuse('cross-volume', `${f.to} is on a different drive. A move across drives is a copy, not a rename — it is not atomic, and a failure halfway leaves two half-repos.`);
			return plan;
		}
		if (!f.fromExists && !f.toExists) { refuse('missing', `Nothing at ${f.from}, and nothing at ${f.to} either — there is no repo here to move.`); return plan; }
		if (f.fromExists && f.toExists) { refuse('destination-exists', `${f.to} already exists. A move never writes over anything.`, f.to); return plan; }
	}
	if (f.folderTarget) { refuse('folder-target', `"${f.repoName}" is a folder target, not a git repo. Move the folder yourself, then use Repoint.`); return plan; }
	if (f.kind === 'worktree') { refuse('not-primary', `${here} is a worktree, not a repo's own checkout. Move the repo, and its worktrees come with it.`, here); return plan; }
	if (f.kind !== 'repo') { refuse('not-a-repo', `${here} has no .git directory — that is not the repo.`, here); return plan; }
	const taken = relayout ? undefined : f.targets.find((t) => samePath(t.path, f.to, ci));
	if (taken) refuse('target-taken', `Another target, "${taken.name}", is already registered at ${f.to}.`, f.to);

	if (resuming) warnings.push(`Resuming: the repo directory is already at ${f.to}. The steps a previous run finished are skipped.`);

	// --- classify every worktree. A relayout touches only the worktrees it relocates: the repo
	// does not move, so its own checkout and every other worktree may be dirty, live, anything.
	const prior = (p: string): PathMove | undefined => f.priorRelocations?.find((r) => samePath(r.to, p, ci));
	const subs = new Set((f.submoduleWorktrees ?? []).map((p) => norm(p, ci)));
	const refuseDirty = (w: WorktreeFact): void => {
		if (w.dirty.length) refuse('dirty', `${w.isMain ? 'The repo' : `Worktree ${w.path}`}${w.branch ? ` (${w.branch})` : ''} has ${w.dirty.length} uncommitted change${w.dirty.length === 1 ? '' : 's'}: ${sample(w.dirty.map((l) => l.slice(3)))}. Commit or park it as wip: first — nothing uncommitted moves.`, w.path);
	};
	let nested = 0;
	for (const w of f.worktrees) {
		if (!relayout) refuseDirty(w);
		if (w.isMain) continue;

		// A relocation an earlier run of this move journaled and finished. Checked first: it now
		// sits inside the repo, where it would otherwise read as one that was always there.
		const done = prior(w.path);
		if (done) {
			plan.worktreeMoves.push({ from: done.from, to: w.path, branch: w.branch, done: true });
			if (!relayout) plan.repair.push(w.path);
			plan.expectedWorktrees.push(w.path);
			continue;
		}
		// Nested inside the repo directory: rides along with it (a relayout leaves it alone).
		// After a resumed move git may report it at either end, depending on whether the repair
		// already ran.
		if (isInside(w.path, f.from, ci) || (resuming && isInside(w.path, f.to, ci))) {
			if (relayout) { nested++; if (!w.prunable) plan.expectedWorktrees.push(w.path); continue; }
			const oldP = isInside(w.path, f.from, ci) ? w.path : remapPath(w.path, [{ from: f.to, to: f.from }], ci);
			const newP = remapPath(oldP, [{ from: f.from, to: f.to }], ci);
			plan.carried.push({ from: oldP, to: newP });
			plan.repair.push(newP);
			plan.expectedWorktrees.push(newP);
			continue;
		}
		if (isInside(w.path, oldWorktreeRoot, ci)) {
			const dest = remapPath(w.path, [{ from: oldWorktreeRoot, to: newWorktreeRoot }], ci);
			if (w.prunable) { warnings.push(`Worktree ${w.path} is already missing (git marks it prunable) — it cannot be moved and is left as it is.`); continue; }
			if (relayout) refuseDirty(w);
			if (w.locked) refuse('locked-worktree', `Worktree ${w.path} is locked (git worktree lock). Unlock it first; git will not move a locked worktree.`, w.path);
			if (subs.has(norm(w.path, ci))) refuse('submodule-worktree', `Worktree ${w.path} has submodules checked out, and git refuses to move a worktree that does ("working trees containing submodules cannot be moved or removed"). Land or park its work, remove it, and re-create it with Reopen.`, w.path);
			if (f.existing.some((e) => samePath(e, dest, ci))) refuse('worktree-destination-exists', `Worktree ${w.path} would move to ${dest}, which already exists.`, dest);
			plan.worktreeMoves.push({ from: w.path, to: dest, branch: w.branch, done: false });
			if (!relayout) plan.repair.push(w.path);
			plan.expectedWorktrees.push(dest);
			continue;
		}
		if (w.prunable) { warnings.push(`Worktree ${w.path} is already missing (git marks it prunable) — not touched.`); continue; }
		plan.staying.push({ path: w.path, branch: w.branch });
		if (!relayout) plan.repair.push(w.path);
		plan.expectedWorktrees.push(w.path);
	}
	for (const m of plan.worktreeMoves) plan.pathMap.push({ from: m.from, to: m.to });
	if (plan.staying.length) warnings.push(`${plan.staying.length} worktree${plan.staying.length === 1 ? ' is' : 's are'} outside ${oldWorktreeRoot} and stay${plan.staying.length === 1 ? 's' : ''} where ${plan.staying.length === 1 ? 'it is' : 'they are'}${relayout ? '' : ', links repaired'}: ${sample(plan.staying.map((s) => s.path))}.`);
	if (relayout && !plan.worktreeMoves.length) {
		refuse('nothing-to-relayout', `No worktree of ${f.repoName} is left in ${oldWorktreeRoot}${nested ? ` — its ${nested} worktree${nested === 1 ? ' already lives' : 's already live'} inside the repo` : ''}. Nothing to do.`);
		return plan;
	}

	// --- live terminals: a session whose cwd is inside anything the move touches. For a move,
	// every worktree counts, the staying ones too: their .git file points into the repo, so their
	// git breaks for the length of the move. A relayout touches only what it relocates.
	const touched = relayout
		? plan.worktreeMoves.flatMap((m) => [m.from, m.to])
		: [f.from, f.to, ...f.worktrees.map((w) => w.path), ...plan.worktreeMoves.map((m) => m.to)];
	for (const live of f.livePaths) {
		if (touched.some((t) => isInside(live, t, ci))) refuse('live-terminal', `A terminal is running in ${live}. Close it first — moving a directory out from under a running session is the worst case.`, live);
	}

	for (const h of f.heldOpen) {
		refuse('held-open', `${h.path} is held open by ${h.holders.length ? sample(h.holders) : 'a process (probably a shell whose working directory is inside it — find it in Resource Monitor → CPU → Associated Handles)'}. Windows refuses to rename a directory in that state, so the move would fail with "Permission denied". Not retried.`, h.path);
	}

	for (const s of f.absoluteSubmodules) {
		if (relayout && !plan.worktreeMoves.some((m) => isInside(s.path, m.from, ci))) continue;
		refuse('absolute-submodule', `Submodule ${s.path} points at an absolute gitdir (${s.gitdir}), which a move breaks. Run \`git submodule absorbgitdirs\` in the repo first.`, s.path);
	}

	// --- transcripts. Exact names only: a mangled name is lossy (every non-alphanumeric becomes
	// '-'), so prefix-matching would hand wt-main-1's sibling wt-main-1-fix the wrong history.
	const has = (name: string): string | undefined => f.transcriptDirs.find((d) => (ci ? d.toLowerCase() === name.toLowerCase() : d === name));
	const candidates: (PathMove & { done?: boolean })[] = [...(relayout ? [] : [{ from: f.from, to: f.to }]), ...plan.carried, ...plan.worktreeMoves];
	for (const c of candidates) {
		const srcName = projectDirName(path.resolve(c.from)), dstName = projectDirName(path.resolve(c.to));
		if (ci ? srcName.toLowerCase() === dstName.toLowerCase() : srcName === dstName) continue;
		const src = has(srcName), dst = has(dstName);
		if (src && dst) refuse('transcript-conflict', `Both ${src} and ${dst} exist in ~/.claude/projects. Renaming would merge two histories; sort that out by hand first.`, src);
		else if (src) plan.transcripts.push({ from: src, to: dstName, done: false });
		else if (dst && (resuming || c.done)) plan.transcripts.push({ from: srcName, to: dst, done: true });
		else if (dst) warnings.push(`${dst} already exists in ~/.claude/projects, keyed to ${c.to} — a history from some earlier worktree at that path. Once ${c.from} moves there, Reopen shows that history, not this worktree's (it has none).`);
	}
	const exact = new Set(candidates.map((c) => projectDirName(path.resolve(c.from))).map((n) => (ci ? n.toLowerCase() : n)));
	const loose = f.transcriptDirs.filter((d) => {
		const k = ci ? d.toLowerCase() : d;
		return !exact.has(k) && candidates.some((c) => {
			const pre = projectDirName(path.resolve(c.from)) + '-';
			return k.startsWith(ci ? pre.toLowerCase() : pre);
		});
	});
	if (loose.length) warnings.push(`${loose.length} transcript folder${loose.length === 1 ? '' : 's'} might belong to a subfolder of something being moved, but a mangled name cannot be reversed with certainty, so ${loose.length === 1 ? 'it is' : 'they are'} NOT renamed: ${sample(loose)}.`);

	if (!f.remotes.length) warnings.push('This repo has no remote: every branch exists on this disk only. Nothing here deletes anything, but there is no other copy if something goes wrong.');
	for (const r of f.configRefs) warnings.push(`config.json ${r} points inside the repo and is NOT rewritten — update it after the move.`);

	return plan;
}

// ---------------------------------------------------------------------------------------------
// Applying the path map to what the app stores

/** A tab, a closed tab's tombstone: anything with an optional linked repo path. */
export function remapRepoLinks<T extends { repo?: string }>(list: readonly T[], map: readonly PathMove[], ci: boolean): T[] {
	return list.map((w) => {
		if (!w.repo) return w;
		const to = remapPath(w.repo, map, ci);
		return to === w.repo ? w : { ...w, repo: to };
	});
}

/** The sessions-file record fields that hold paths. */
export interface PathedRecord { worktreePath: string; repoPath: string }

/** Rewrite every saved tile's worktreePath and repoPath, across every bucket (live tabs and the
 *  `closed:` tombstones alike). Returns the new object and how many records changed. Records
 *  with empty paths (journals) are left alone. */
export function remapSessionRecords<R extends PathedRecord>(all: Record<string, R[]>, map: readonly PathMove[], ci: boolean): { all: Record<string, R[]>; changed: number } {
	let changed = 0;
	const out: Record<string, R[]> = {};
	for (const [k, recs] of Object.entries(all)) {
		if (!Array.isArray(recs)) { out[k] = recs; continue; }
		out[k] = recs.map((r) => {
			const wt = r.worktreePath ? remapPath(r.worktreePath, map, ci) : r.worktreePath;
			const rp = r.repoPath ? remapPath(r.repoPath, map, ci) : r.repoPath;
			if (wt === r.worktreePath && rp === r.repoPath) return r;
			changed++;
			return { ...r, worktreePath: wt, repoPath: rp };
		});
	}
	return { all: out, changed };
}

/** JSON paths of config values that hold a path inside `dir`, skipping the keys the move rewrites
 *  itself. Walks the whole object so a key nobody thought of still gets named. */
export function configPathRefs(cfg: unknown, dir: string, ci: boolean, skip: readonly string[] = ['repos', 'workspaces', 'closedWorkspaces']): string[] {
	const out: string[] = [];
	const walk = (v: unknown, at: string): void => {
		if (typeof v === 'string') {
			if (v.length > 2 && (path.isAbsolute(v) || path.win32.isAbsolute(v)) && isInside(v, dir, ci)) out.push(at);
		} else if (Array.isArray(v)) {
			v.forEach((x, i) => walk(x, `${at}[${i}]`));
		} else if (v && typeof v === 'object') {
			for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
				if (!at && skip.includes(k)) continue;
				walk(x, at ? `${at}.${k}` : k);
			}
		}
	};
	walk(cfg, '');
	return out;
}

// ---------------------------------------------------------------------------------------------
// Saying it

/** The plan as the confirm dialog shows it: what moves, what is repaired, what is renamed, what
 *  is told. A confirm that does not name what it will do is not something anyone can agree to. */
export function describeMovePlan(p: MovePlan): string {
	const lines: string[] = [];
	if (p.relayout) lines.push(`${p.from} stays where it is. Its worktrees move inside it:\n  ${p.oldWorktreeRoot}\n  → ${p.newWorktreeRoot}`);
	else lines.push(`${p.from}\n  → ${p.to}${p.resuming ? '   (already moved — resuming)' : ''}`);
	lines.push('');
	if (p.worktreeMoves.length) {
		lines.push(`Worktrees relocated to ${p.newWorktreeRoot} (git worktree move):`);
		for (const m of p.worktreeMoves) lines.push(`  ${path.basename(m.from)}${m.branch ? ` [${m.branch}]` : ''}${m.done ? '   ✓ already' : ''}`);
		lines.push(`/.claude-worktrees/ is added to the repo's .git/info/exclude first (local, never committed), so the repo's own git status stays clean.`);
	} else {
		lines.push(`New worktrees will be created in ${p.newWorktreeRoot}.`);
	}
	if (p.carried.length) lines.push(`Worktrees inside the repo folder, moving with it: ${p.carried.length}`);
	if (p.repair.length) lines.push(`Worktree links repaired at both ends (git worktree repair): ${p.repair.length}`);
	if (p.transcripts.length) {
		lines.push(`Claude transcripts renamed so Reopen still finds them (~/.claude/projects):`);
		for (const t of p.transcripts) lines.push(`  ${t.from}\n    → ${t.to}${t.done ? '   ✓ already' : ''}`);
	} else {
		lines.push('No Claude transcripts are keyed to these paths.');
	}
	lines.push(p.relayout
		? 'Saved terminals for the relocated worktrees are repointed; the target itself does not change.'
		: 'config.json: the target, every tab linked to it, and saved terminals are repointed.');
	if (p.warnings.length) {
		lines.push('');
		for (const w of p.warnings) lines.push(`⚠ ${w}`);
	}
	return lines.join('\n');
}

/** The refusals, one per line, for the "cannot move" dialog. */
export function describeRefusals(p: MovePlan): string {
	return p.refusals.map((r) => `✗ ${r.message}`).join('\n\n');
}
