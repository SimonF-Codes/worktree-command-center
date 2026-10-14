import * as path from 'path';
import { projectDirName } from './terminals/resume-target';
import { shouldRemoveWorktree } from './terminals/worktree-manager';
import { isInside, samePath } from './move-repo';

// Pruning merged worktrees — the PURE half. Given what is on disk (gathered by
// prune-worktrees-io.ts), decide for every worktree of every repo whether it may be removed, and
// every reason it may not, before anything is touched. The shape is move-repo.ts's: a plan, a
// list of refusals per worktree, and warnings the user reads BEFORE confirming.
//
// A worktree is two things, and they are separate questions:
//   1. CODE — is every commit already in the base branch, and is nothing uncommitted? Then
//      removing the directory loses no work. The branch is never deleted here: it costs nothing,
//      and in a repo with no remote it is the only copy of its history.
//   2. CONVERSATION — ~/.claude/projects/<mangled worktree path> is the session's transcript.
//      Remove the worktree and the transcript is not deleted, it is ORPHANED: the Coordination
//      panel lists worktrees from `git worktree list`, so the session drops off it and Reopen
//      cannot reach it. That is harder to notice than a deletion, so every line of the report
//      says how many conversations it would strand.
//
// "Merged" is established three ways, strongest first, and the report says which one held:
//   ancestor  `git rev-list --count base..HEAD` is 0 — every commit is reachable from base.
//   patch-id  `git cherry base HEAD` marks every commit '-' — each has an equivalent patch on
//             base: the branch was rebased or cherry-picked in.
//   content   `git merge-tree --write-tree base HEAD` gives base's own tree — merging the branch
//             would change nothing. This is the only one that sees a SQUASH of several commits:
//             the squash commit's patch matches none of the originals, so patch-ids miss it.
// The two weaker ones are accepted — not hoarded forever — because nothing a prune does can lose
// a commit: the branch stays, and `git worktree add <path> <branch>` restores the directory at the
// same path, which also makes its transcript reachable again. What still cannot be told apart is
// a squash-merged branch whose lines base has since changed again: it reads as unmerged and is
// kept, and the refusal says so rather than pretending it is unmerged work.

/** How a worktree's commits were found to be in its base. */
export type MergedBy = 'ancestor' | 'patch-id' | 'content';

/** One worktree, with everything the decision needs. Every git answer is nullable: null means
 *  the command failed, and an unanswered question never counts in a worktree's favour. */
export interface PruneWorktreeFact {
	path: string;
	/** Short branch name; '' when detached. */
	branch: string;
	isMain: boolean;
	/** git marks it prunable: its directory is already gone. */
	missing: boolean;
	locked: boolean;
	/** `git status --porcelain` lines; [] when clean. */
	dirty: string[];
	/** Has an initialized submodule checkout: `git worktree remove` refuses those outright. */
	submodules?: boolean;
	/** The base branch it is compared with, or null when none could be resolved. */
	base: string | null;
	/** `git rev-list --count base..HEAD`. */
	ahead: number | null;
	/** Commits `git cherry base HEAD` marks '+' (no equivalent patch on base). Not asked when
	 *  `ahead` is already 0. */
	cherryUnmatched: number | null;
	/** `git merge-tree --write-tree base HEAD` equals base's tree. Not asked when a stronger
	 *  check already held. */
	contentMerged: boolean | null;
	/** Symlinks and junctions inside it (looked for on candidates only). Each is unlinked before
	 *  removal, because git deletes THROUGH a junction into what it points at. */
	links?: { path: string; target: string }[];
}

export interface PruneRepoFacts {
	repoName: string;
	repoPath: string;
	/** `git remote` names: none means every branch exists on this disk only. */
	remotes: string[];
	worktrees: PruneWorktreeFact[];
	/** Set when the repo's worktrees could not be listed at all. */
	error?: string;
}

/** A directory that cannot be removed right now because something holds it open. `code` is the
 *  rename probe's error: EBUSY is a sync engine (OneDrive), EPERM/EACCES a process's working
 *  directory or a service's directory handle — they have different fixes. */
export interface HeldDir { path: string; code: string; holders: string[] }

export interface PruneFacts {
	repos: PruneRepoFacts[];
	/** Working directory of every live terminal. null = not known (outside the app): every
	 *  worktree is then refused, because a pruner that cannot see the terminals must not guess. */
	livePaths: string[] | null;
	/** Saved-but-not-started terminals (the sessions file): resuming one needs its worktree. */
	savedTerminals: { path: string; where: string }[];
	heldOpen: HeldDir[];
	/** Directory name → number of .jsonl conversations in it, for ~/.claude/projects. */
	transcripts: Record<string, number>;
	caseInsensitive: boolean;
}

export type PruneRefusalCode =
	| 'main-checkout' | 'unmerged' | 'no-base' | 'unverified' | 'detached' | 'dirty'
	| 'live-terminal' | 'live-unknown' | 'saved-terminal' | 'held-open' | 'locked' | 'submodules';

export interface PruneRefusal { code: PruneRefusalCode; message: string }

export interface PruneEntry {
	path: string;
	branch: string;
	base: string | null;
	/** Conversations keyed to exactly this path — what removing it strands. */
	transcripts: number;
	/** Transcript folders whose name starts with this path's (a subfolder's session, or a
	 *  sibling whose name merely shares the prefix — a mangled name cannot tell). Counted, never
	 *  claimed. */
	maybeTranscripts: number;
	mergedBy: MergedBy | null;
	links: { path: string; target: string }[];
	refusals: PruneRefusal[];
}

export interface RepoPrunePlan {
	repoName: string;
	repoPath: string;
	/** May be removed: no refusal. */
	prune: PruneEntry[];
	/** Kept, each with every reason. The main checkout is not listed. */
	keep: PruneEntry[];
	/** Directory already gone; git still lists it, which is what lets Reopen recreate it. Left
	 *  alone — `git worktree prune` would clear these, and with them that way back. */
	stale: PruneEntry[];
	warnings: string[];
	error?: string;
}

export interface PrunePlan {
	repos: RepoPrunePlan[];
	totals: { worktrees: number; prune: number; keep: number; stale: number; transcriptsAtStake: number; survive: number; byWeakerCheck: number };
}

// ---------------------------------------------------------------------------------------------

/** The branch a worktree is compared with: the <base> of a wt/<base>-N name when that branch
 *  exists (the convention the floor scan uses too), else main, else master. null when none
 *  exists — and then nothing is claimed about whether it is merged. */
export function baseFor(branch: string, branches: readonly string[]): string | null {
	const m = /^wt\/(.+)-\d+$/.exec(branch);
	if (m && branches.includes(m[1]!) && m[1] !== branch) return m[1]!;
	if (branches.includes('main') && branch !== 'main') return 'main';
	if (branches.includes('master') && branch !== 'master') return 'master';
	return null;
}

/** The entries of a confirmed plan that a fresh plan, computed just before removal, still
 *  agrees may go: anything that changed in between (a commit, a file, a terminal opened) is
 *  dropped rather than removed on the strength of an old answer. */
export function stillPrunable(confirmed: PrunePlan, fresh: PrunePlan, ci: boolean): RepoPrunePlan[] {
	const ok = fresh.repos.flatMap((r) => r.prune);
	return confirmed.repos.map((r) => ({ ...r, prune: r.prune.filter((e) => ok.some((o) => samePath(o.path, e.path, ci) && o.branch === e.branch)) }));
}

/** `git cherry` output: how many commits have no equivalent patch upstream ('+' lines). */
export function countCherryUnmatched(s: string): number {
	return String(s).split('\n').filter((l) => l.startsWith('+')).length;
}

/** How the commits were found to be in base, or null when no check held. */
export function mergedBy(w: Pick<PruneWorktreeFact, 'ahead' | 'cherryUnmatched' | 'contentMerged'>): MergedBy | null {
	if (w.ahead === 0) return 'ancestor';
	if (w.cherryUnmatched === 0) return 'patch-id';
	if (w.contentMerged === true) return 'content';
	return null;
}

const MERGED_LABEL: Record<MergedBy, string> = {
	ancestor: 'merged',
	'patch-id': 'merged by rebase/cherry-pick (patch-ids match)',
	content: 'merged by squash (merging it would change nothing)',
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const sample = (xs: readonly string[], n = 3): string => xs.slice(0, n).join(', ') + (xs.length > n ? `, +${xs.length - n} more` : '');

function transcriptCounts(p: string, transcripts: Record<string, number>, ci: boolean): { exact: number; maybe: number } {
	const name = projectDirName(path.resolve(p));
	const k = ci ? name.toLowerCase() : name;
	let exact = 0, maybe = 0;
	for (const [d, n] of Object.entries(transcripts)) {
		const dk = ci ? d.toLowerCase() : d;
		if (dk === k) exact += n;
		else if (dk.startsWith(k + '-')) maybe += n;
	}
	return { exact, maybe };
}

/** Decide every worktree of every repo. Pure: the same facts give the same plan, and a plan
 *  computed for a dry run is exactly the one a confirmed run executes. */
export function planPrune(f: PruneFacts): PrunePlan {
	const ci = f.caseInsensitive;
	const repos: RepoPrunePlan[] = [];
	for (const r of f.repos) {
		const plan: RepoPrunePlan = { repoName: r.repoName, repoPath: r.repoPath, prune: [], keep: [], stale: [], warnings: [], ...(r.error ? { error: r.error } : {}) };
		repos.push(plan);
		for (const w of r.worktrees) {
			const t = transcriptCounts(w.path, f.transcripts, ci);
			const by = mergedBy(w);
			const e: PruneEntry = { path: w.path, branch: w.branch, base: w.base, transcripts: t.exact, maybeTranscripts: t.maybe, mergedBy: by, links: w.links ?? [], refusals: [] };
			const refuse = (code: PruneRefusalCode, message: string): void => { e.refusals.push({ code, message }); };

			if (w.isMain || samePath(w.path, r.repoPath, ci)) {
				// Never a candidate, so never listed as one — but said, so the count adds up.
				continue;
			}
			if (w.missing) { plan.stale.push(e); continue; }

			// --- the code question
			if (!w.base) refuse('no-base', `No base branch to compare ${w.branch || 'its HEAD'} with (none of its wt/<base>-N name, main or master exists).`);
			else if (w.ahead === null) refuse('unverified', `git could not count its commits against ${w.base}, so whether it is merged is unknown.`);
			else if (!by) {
				refuse('unmerged', `${plural(w.ahead, 'commit')} not in ${w.base} — by ancestry, by patch-id${w.cherryUnmatched === null ? ' (git cherry failed)' : ` (${w.cherryUnmatched} unmatched)`}, and by content${w.contentMerged === null ? ' (merge-tree failed)' : ''}. If it was squash-merged and ${w.base} has changed those lines since, this cannot be told from unmerged work: check it and remove it by hand.`);
			} else if (by !== 'ancestor' && !w.branch) {
				refuse('detached', `Detached HEAD whose commits are in ${w.base} only as equivalent patches: no branch holds them, and removing the worktree discards its HEAD reflog — the last reference to them.`);
			}
			if (w.dirty.length) refuse('dirty', `${plural(w.dirty.length, 'uncommitted change')}: ${sample(w.dirty.map((l) => l.slice(3)))}.`);
			// Belt and braces: the rule the app already uses when a session closes. Each failure
			// above has its own message; this only guards against the checks drifting apart.
			if (!e.refusals.length && !shouldRemoveWorktree(w.dirty.join('\n'), by ? 0 : (w.ahead ?? 1))) refuse('unverified', 'Not provably clean and merged.');

			// --- what is using it
			if (f.livePaths === null) refuse('live-unknown', 'Which terminals are running is not known here — only the app knows. Run the prune from ⚙ Settings.');
			else {
				const live = f.livePaths.filter((p) => isInside(p, w.path, ci));
				if (live.length) refuse('live-terminal', `A terminal is running in it${samePath(live[0]!, w.path, ci) ? '' : ` (${live[0]})`}. Close it first.`);
			}
			const saved = f.savedTerminals.filter((s) => isInside(s.path, w.path, ci));
			if (saved.length) refuse('saved-terminal', `A saved terminal on ${sample([...new Set(saved.map((s) => s.where))])} resumes here. Close that terminal first, or it can never come back.`);
			if (w.locked) refuse('locked', 'Locked (git worktree lock): git will not remove it until it is unlocked.');
			if (w.submodules) refuse('submodules', 'Has submodules checked out, and git refuses to remove a worktree that does.');
			const held = f.heldOpen.find((h) => samePath(h.path, w.path, ci));
			if (held) refuse('held-open', heldMessage(held));

			(e.refusals.length ? plan.keep : plan.prune).push(e);
		}
		if (!r.remotes.length && !r.error) plan.warnings.push(`${r.repoName} has no remote: its branches exist on this disk only. They are all kept — nothing here deletes a branch.`);
		if (plan.stale.length) plan.warnings.push(`${plural(plan.stale.length, 'worktree')} of ${r.repoName} ${plan.stale.length === 1 ? 'is' : 'are'} already gone from disk but still listed by git — which is how Reopen recreates ${plan.stale.length === 1 ? 'it' : 'them'}. Left alone; \`git worktree prune\` would clear ${plan.stale.length === 1 ? 'that entry' : 'those entries'}${sumStaleT(plan) ? ` and orphan ${plural(sumStaleT(plan), 'conversation')}` : ''}.`);
	}
	const all = repos.flatMap((r) => [...r.prune, ...r.keep, ...r.stale]);
	const prune = repos.flatMap((r) => r.prune);
	return {
		repos,
		totals: {
			worktrees: all.length,
			prune: prune.length,
			keep: repos.reduce((n, r) => n + r.keep.length, 0),
			stale: repos.reduce((n, r) => n + r.stale.length, 0),
			transcriptsAtStake: prune.reduce((n, e) => n + e.transcripts, 0),
			survive: all.length - prune.length,
			byWeakerCheck: prune.filter((e) => e.mergedBy !== 'ancestor').length,
		},
	};
}

const sumStaleT = (r: RepoPrunePlan): number => r.stale.reduce((n, e) => n + e.transcripts, 0);

/** Why a held directory is held, as far as the error code can say — and what fixes each. */
export function heldMessage(h: HeldDir): string {
	const who = h.holders.length ? ` Named: ${sample(h.holders)}.` : '';
	if (h.code === 'EBUSY') return `Busy (EBUSY) — a sync engine such as OneDrive has it. Pause syncing, or keep worktrees out of synced folders.${who}`;
	return `Held open (${h.code || 'Permission denied'}) — a process's working directory is inside it (C:/dev/scripts/find-cwd-holder.ps1 names it), or a service (antivirus, Search indexer) holds the folder; a reboot clears that one.${who}`;
}

// ---------------------------------------------------------------------------------------------
// Saying it

function entryLine(e: PruneEntry): string {
	const conv = `${plural(e.transcripts, 'conversation')} orphaned${e.maybeTranscripts ? ` (+${e.maybeTranscripts} in similarly named folders)` : ''}`;
	const what = `${path.basename(e.path)}${e.branch ? ` [${e.branch}]` : ' [detached]'}`;
	return `${what} — ${e.mergedBy ? MERGED_LABEL[e.mergedBy] : 'not merged'} into ${e.base ?? '?'} — ${conv}`;
}

/** The dry run: grouped by repo, every worktree on a line with what it would strand. The first
 *  line is the sentence a decision is made on. */
export function describePrunePlan(p: PrunePlan): string {
	const t = p.totals;
	const lines: string[] = [];
	lines.push(`${t.prune} of ${t.worktrees} worktrees can be removed, stranding ${plural(t.transcriptsAtStake, 'conversation')}. ${t.survive} survive.`);
	lines.push('Branches are never deleted. A removed worktree comes back with `git worktree add <path> <branch>`, and its conversation with it.');
	if (t.byWeakerCheck) lines.push(`⚠ ${t.byWeakerCheck} of them merged by rebase or squash, not ancestry — matched by patch-id or by content. Check those names before confirming.`);
	for (const r of p.repos) {
		const n = r.prune.length + r.keep.length + r.stale.length;
		lines.push('');
		if (r.error) { lines.push(`${r.repoName}: could not be read — ${r.error}`); continue; }
		const at = r.prune.reduce((s, e) => s + e.transcripts, 0);
		lines.push(`${r.repoName}: ${r.prune.length} of ${n} worktree${n === 1 ? '' : 's'} prunable, holding ${plural(at, 'conversation')}`);
		for (const e of r.prune) {
			lines.push(`  ✓ ${entryLine(e)}`);
			for (const l of e.links) lines.push(`      ${path.relative(e.path, l.path)} is a link to ${l.target} — unlinked first, so what it points at is untouched`);
		}
		for (const e of r.keep) {
			lines.push(`  ✗ ${entryLine(e)}`);
			for (const x of e.refusals) lines.push(`      ${x.message}`);
		}
		for (const e of r.stale) lines.push(`  · ${path.basename(e.path)}${e.branch ? ` [${e.branch}]` : ''} — already gone from disk, entry kept — ${plural(e.transcripts, 'conversation')}`);
		for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
	}
	return lines.join('\n');
}
