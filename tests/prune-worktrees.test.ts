import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
	planPrune, describePrunePlan, mergedBy, baseFor, countCherryUnmatched, stillPrunable, heldMessage,
	type PruneFacts, type PruneWorktreeFact, type PruneRefusalCode,
} from '../src/prune-worktrees';
import { projectDirName } from '../src/terminals/resume-target';

// The floor's shape, as fixtures: a repo with its worktrees nested inside it, some merged, some
// not, one of each way of being kept, and transcript folders keyed to some of their paths.

const R = path.resolve('/dev');
const REPO = path.join(R, 'Repo');
const W = (n: string): string => path.join(REPO, '.claude-worktrees', n);

const wt = (n: string, extra: Partial<PruneWorktreeFact> = {}): PruneWorktreeFact => ({
	path: W(n), branch: `wt/${n.replace(/^wt-/, '')}`, isMain: false, missing: false, locked: false, dirty: [],
	base: 'main', ahead: 0, cherryUnmatched: null, contentMerged: null, ...extra,
});

const MAIN: PruneWorktreeFact = { ...wt('x'), path: REPO, branch: 'main', isMain: true, base: null, ahead: null };

function facts(worktrees: PruneWorktreeFact[], over: Partial<PruneFacts> = {}): PruneFacts {
	return {
		repos: [{ repoName: 'Repo', repoPath: REPO, remotes: ['origin'], worktrees: [MAIN, ...worktrees] }],
		livePaths: [], savedTerminals: [], heldOpen: [], transcripts: {}, caseInsensitive: false,
		...over,
	};
}
const only = (w: PruneWorktreeFact, over: Partial<PruneFacts> = {}) => planPrune(facts([w], over)).repos[0]!;
const codes = (w: PruneWorktreeFact, over: Partial<PruneFacts> = {}): PruneRefusalCode[] => only(w, over).keep.flatMap((e) => e.refusals.map((r) => r.code));

describe('planPrune — what may go', () => {
	it('prunes a clean worktree with no commits ahead of its base', () => {
		const r = only(wt('wt-main-1'));
		expect(r.prune.map((e) => e.path)).toEqual([W('wt-main-1')]);
		expect(r.prune[0]!.mergedBy).toBe('ancestor');
		expect(r.keep).toEqual([]);
	});

	it('never lists the main checkout, as a candidate or otherwise', () => {
		const r = only(wt('wt-main-1'));
		expect([...r.prune, ...r.keep, ...r.stale].some((e) => e.path === REPO)).toBe(false);
	});

	it('accepts a rebased branch by patch-id, and a squashed one by content — and says which', () => {
		const p = planPrune(facts([
			wt('wt-main-1', { ahead: 3, cherryUnmatched: 0 }),
			wt('wt-main-2', { ahead: 4, cherryUnmatched: 4, contentMerged: true }),
		]));
		expect(p.repos[0]!.prune.map((e) => e.mergedBy)).toEqual(['patch-id', 'content']);
		expect(p.totals.byWeakerCheck).toBe(2);
		const text = describePrunePlan(p);
		expect(text).toMatch(/rebase\/cherry-pick/);
		expect(text).toMatch(/squash/);
		expect(text).toMatch(/2 of them merged by rebase or squash/);
	});
});

describe('planPrune — every refusal is its own', () => {
	it('unmerged: commits no check finds in base, and the message admits the squash blind spot', () => {
		const r = only(wt('wt-main-1', { ahead: 2, cherryUnmatched: 2, contentMerged: false }));
		expect(r.keep[0]!.refusals.map((x) => x.code)).toEqual(['unmerged']);
		expect(r.keep[0]!.refusals[0]!.message).toMatch(/2 commits not in main/);
		expect(r.keep[0]!.refusals[0]!.message).toMatch(/squash-merged/);
	});

	it('dirty', () => {
		const r = only(wt('wt-main-1', { dirty: [' M a.txt', '?? b.txt'] }));
		expect(r.keep[0]!.refusals.map((x) => x.code)).toEqual(['dirty']);
		expect(r.keep[0]!.refusals[0]!.message).toMatch(/2 uncommitted changes: a.txt, b.txt/);
	});

	it('live terminal — inside it counts too', () => {
		expect(codes(wt('wt-main-1'), { livePaths: [W('wt-main-1')] })).toEqual(['live-terminal']);
		expect(codes(wt('wt-main-1'), { livePaths: [path.join(W('wt-main-1'), 'sub')] })).toEqual(['live-terminal']);
		// A sibling whose name only shares a prefix is not inside it.
		expect(codes(wt('wt-main-1'), { livePaths: [W('wt-main-10')] })).toEqual([]);
	});

	it('refuses everything when the live terminals are unknown, rather than guessing', () => {
		expect(codes(wt('wt-main-1'), { livePaths: null })).toEqual(['live-unknown']);
	});

	it('saved terminal, held open, locked, submodules, no base, unverified', () => {
		expect(codes(wt('wt-main-1'), { savedTerminals: [{ path: W('wt-main-1'), where: 'tab t1' }] })).toEqual(['saved-terminal']);
		expect(codes(wt('wt-main-1'), { heldOpen: [{ path: W('wt-main-1'), code: 'EPERM', holders: [] }] })).toEqual(['held-open']);
		expect(codes(wt('wt-main-1', { locked: true }))).toEqual(['locked']);
		expect(codes(wt('wt-main-1', { submodules: true }))).toEqual(['submodules']);
		expect(codes(wt('wt-main-1', { base: null, ahead: null }))).toEqual(['no-base']);
		expect(codes(wt('wt-main-1', { ahead: null }))).toEqual(['unverified']);
	});

	it('keeps a detached HEAD merged only by patch-id: no branch would hold those commits', () => {
		expect(codes(wt('wt-main-1', { branch: '', ahead: 1, cherryUnmatched: 0 }))).toEqual(['detached']);
		expect(codes(wt('wt-main-1', { branch: '', ahead: 0 }))).toEqual([]);
	});

	it('collects every reason at once, not the first', () => {
		expect(codes(wt('wt-main-1', { ahead: 1, cherryUnmatched: 1, contentMerged: false, dirty: [' M a'], locked: true }), { livePaths: [W('wt-main-1')] }))
			.toEqual(['unmerged', 'dirty', 'live-terminal', 'locked']);
	});

	it('tells a sync-engine hold from a process or service hold', () => {
		expect(heldMessage({ path: 'x', code: 'EBUSY', holders: [] })).toMatch(/OneDrive/);
		expect(heldMessage({ path: 'x', code: 'EPERM', holders: ['claude (pid 1)'] })).toMatch(/working directory.*reboot.*claude \(pid 1\)/s);
	});
});

describe('planPrune — the conversations at stake', () => {
	const tx = { [projectDirName(W('wt-main-1'))]: 2, [projectDirName(W('wt-main-1')) + '-sub']: 1, [projectDirName(W('wt-main-10'))]: 5 };

	it('counts conversations keyed to exactly the path, and names similar folders separately', () => {
		const p = planPrune(facts([wt('wt-main-1'), wt('wt-main-2')], { transcripts: tx }));
		const e = p.repos[0]!.prune.find((x) => x.path === W('wt-main-1'))!;
		expect(e.transcripts).toBe(2);
		// A folder under it (…-wt-main-1-sub) is "maybe": the mangling cannot tell a subfolder's
		// session from a sibling named wt-main-1-sub. wt-main-10 is neither: no separator.
		expect(e.maybeTranscripts).toBe(1);
		expect(p.totals.transcriptsAtStake).toBe(2);
	});

	it('puts the count on every line of the dry run, kept ones too', () => {
		const p = planPrune(facts([wt('wt-main-1'), wt('wt-main-2', { dirty: [' M a'] })], { transcripts: tx }));
		const rows = describePrunePlan(p).split('\n').filter((l) => /^ {2}[✓✗·]/.test(l));
		expect(rows).toHaveLength(2);
		for (const l of rows) expect(l).toMatch(/\d+ conversations? orphaned/);
	});

	it('opens with the sentence a decision is made on, and gives the per-repo totals', () => {
		const p = planPrune(facts([wt('wt-main-1'), wt('wt-main-2', { dirty: [' M a'] }), wt('wt-main-3')], { transcripts: tx }));
		const text = describePrunePlan(p);
		expect(text.split('\n')[0]).toBe('2 of 3 worktrees can be removed, stranding 2 conversations. 1 survive.');
		expect(text).toMatch(/Repo: 2 of 3 worktrees prunable, holding 2 conversations/);
		expect(p.totals).toMatchObject({ worktrees: 3, prune: 2, keep: 1, survive: 1 });
	});

	it('leaves a worktree already gone from disk alone, and counts what clearing it would orphan', () => {
		const p = planPrune(facts([wt('wt-main-1', { missing: true })], { transcripts: tx }));
		expect(p.repos[0]!.stale.map((e) => e.path)).toEqual([W('wt-main-1')]);
		expect(p.repos[0]!.prune).toEqual([]);
		expect(p.repos[0]!.warnings.join(' ')).toMatch(/git worktree prune.*orphan 2 conversations/);
	});

	it('warns that a repo with no remote has its branches on this disk only', () => {
		const f = facts([wt('wt-main-1')]);
		f.repos[0]!.remotes = [];
		expect(planPrune(f).repos[0]!.warnings.join(' ')).toMatch(/no remote/);
	});

	it('names the links it will unlink before removing', () => {
		const p = planPrune(facts([wt('wt-main-1', { links: [{ path: path.join(W('wt-main-1'), 'node_modules'), target: path.join(REPO, 'node_modules') }] })]));
		expect(describePrunePlan(p)).toMatch(/node_modules is a link to .* unlinked first/);
	});
});

describe('the parts', () => {
	it('mergedBy takes the strongest check that held', () => {
		expect(mergedBy({ ahead: 0, cherryUnmatched: null, contentMerged: null })).toBe('ancestor');
		expect(mergedBy({ ahead: 2, cherryUnmatched: 0, contentMerged: null })).toBe('patch-id');
		expect(mergedBy({ ahead: 2, cherryUnmatched: 1, contentMerged: true })).toBe('content');
		expect(mergedBy({ ahead: 2, cherryUnmatched: 1, contentMerged: false })).toBeNull();
		expect(mergedBy({ ahead: null, cherryUnmatched: null, contentMerged: null })).toBeNull();
	});

	it('baseFor reads wt/<base>-N, then main, then master — never the branch itself', () => {
		expect(baseFor('wt/develop-3', ['main', 'develop'])).toBe('develop');
		expect(baseFor('wt/gone-3', ['main'])).toBe('main');
		expect(baseFor('feature', ['master', 'feature'])).toBe('master');
		expect(baseFor('main', ['main'])).toBeNull();
		expect(baseFor('x', ['x'])).toBeNull();
	});

	it('countCherryUnmatched counts the + lines', () => {
		expect(countCherryUnmatched('- aaa\n+ bbb\n+ ccc\n')).toBe(2);
		expect(countCherryUnmatched('')).toBe(0);
	});

	it('stillPrunable drops whatever a fresh plan no longer agrees on', () => {
		const before = planPrune(facts([wt('wt-main-1'), wt('wt-main-2')]));
		const after = planPrune(facts([wt('wt-main-1'), wt('wt-main-2', { dirty: [' M a'] })]));
		expect(stillPrunable(before, after, false)[0]!.prune.map((e) => e.path)).toEqual([W('wt-main-1')]);
	});
});
