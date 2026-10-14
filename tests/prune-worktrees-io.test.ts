import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { gatherPruneFacts, executePrune, readSavedTerminals, explainRemoveFailure } from '../src/prune-worktrees-io';
import { findLinks } from '../src/terminals/worktree-manager';
import { planPrune, describePrunePlan } from '../src/prune-worktrees';
import { projectDirName } from '../src/terminals/resume-target';

// Real git, real directories, all inside a temp root — never a real repo. One repo, its
// worktrees nested inside it, one for each way a branch can have landed (or not).

const savedGitEnv: Record<string, string> = {};
beforeAll(() => {
	for (const k of Object.keys(process.env)) {
		if (k.startsWith('GIT_')) { savedGitEnv[k] = process.env[k]!; delete process.env[k]; }
	}
});
afterAll(() => { Object.assign(process.env, savedGitEnv); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();
const commit = (cwd: string, file: string, text: string, msg: string): void => {
	fs.writeFileSync(path.join(cwd, file), text);
	git(cwd, 'add', '-A');
	git(cwd, 'commit', '-q', '-m', msg);
};

let root: string, repo: string, projects: string, sessions: string;
const W = (n: string): string => path.join(repo, '.claude-worktrees', n);

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-prune-')));
	repo = path.join(root, 'Repo');
	projects = path.join(root, 'projects');
	sessions = path.join(root, 'sessions.json');
	fs.mkdirSync(repo, { recursive: true });
	git(repo, 'init', '-q', '-b', 'main');
	const gitDir = path.resolve(repo, git(repo, 'rev-parse', '--git-dir'));
	if (gitDir !== path.resolve(repo, '.git')) throw new Error(`refusing to run: temp repo resolved to ${gitDir}, not its own .git`);
	for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(repo, 'config', k!, v!);
	fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
	commit(repo, 'a.txt', 'one\n', 'init');
	fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '/.claude-worktrees/\n');
	for (const n of ['wt-main-1', 'wt-main-2', 'wt-main-3', 'wt-main-4', 'wt-main-5', 'wt-main-6']) git(repo, 'worktree', 'add', '-q', '-b', `wt/${n.slice(3)}`, W(n), 'main');

	// 1: nothing of its own — merged by ancestry. 2: rebased onto main (cherry-picked) — patch-id.
	// 3: two commits squashed onto main — content. 4: unmerged. 5: dirty. 6: gone from disk.
	commit(W('wt-main-2'), 'b.txt', 'two\n', 'b');
	// main moves on first: a pick onto the same parent in the same second is the SAME commit.
	commit(repo, 'm.txt', 'main moved\n', 'main moved');
	git(repo, 'cherry-pick', 'wt/main-2');
	commit(W('wt-main-3'), 'c.txt', 'three\n', 'c1');
	commit(W('wt-main-3'), 'd.txt', 'four\n', 'c2');
	git(repo, 'merge', '--squash', '-q', 'wt/main-3');
	git(repo, 'commit', '-q', '-m', 'squash of wt/main-3');
	commit(W('wt-main-4'), 'e.txt', 'five\n', 'unmerged');
	fs.writeFileSync(path.join(W('wt-main-5'), 'f.txt'), 'dirty\n');
	fs.rmSync(W('wt-main-6'), { recursive: true, force: true });

	fs.mkdirSync(path.join(projects, projectDirName(W('wt-main-1'))), { recursive: true });
	fs.writeFileSync(path.join(projects, projectDirName(W('wt-main-1')), 's1.jsonl'), '{}\n');
	fs.writeFileSync(path.join(projects, projectDirName(W('wt-main-1')), 's2.jsonl'), '{}\n');
	fs.mkdirSync(path.join(projects, projectDirName(W('wt-main-6'))));
	fs.writeFileSync(path.join(projects, projectDirName(W('wt-main-6')), 's.jsonl'), '{}\n');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const gather = (over: Partial<Parameters<typeof gatherPruneFacts>[1]> = {}) =>
	gatherPruneFacts([{ name: 'Repo', path: repo }], { livePaths: [], projectsDir: projects, sessionsFile: sessions, caseInsensitive: process.platform === 'win32', ...over });

describe('gatherPruneFacts + planPrune on a real repo', () => {
	it('finds each way of having landed, and keeps what has not', async () => {
		const p = planPrune(await gather());
		const r = p.repos[0]!;
		expect(r.prune.map((e) => [path.basename(e.path), e.mergedBy])).toEqual([
			['wt-main-1', 'ancestor'], ['wt-main-2', 'patch-id'], ['wt-main-3', 'content'],
		]);
		expect(r.keep.map((e) => [path.basename(e.path), e.refusals.map((x) => x.code)])).toEqual([
			['wt-main-4', ['unmerged']], ['wt-main-5', ['dirty']],
		]);
		expect(r.stale.map((e) => path.basename(e.path))).toEqual(['wt-main-6']);
		expect(r.prune[0]!.transcripts).toBe(2);
		expect(p.totals).toMatchObject({ worktrees: 6, prune: 3, survive: 3, transcriptsAtStake: 2, byWeakerCheck: 2 });
		expect(describePrunePlan(p).split('\n')[0]).toBe('3 of 6 worktrees can be removed, stranding 2 conversations. 3 survive.');
	});

	it('refuses everything when the live terminals are not known', async () => {
		const p = planPrune(await gather({ livePaths: null }));
		expect(p.totals.prune).toBe(0);
		expect(p.repos[0]!.keep.find((e) => e.path === W('wt-main-1'))!.refusals.map((x) => x.code)).toEqual(['live-unknown']);
	});

	it('refuses a worktree a live or saved terminal is using', async () => {
		fs.writeFileSync(sessions, JSON.stringify({ t1: [{ worktreePath: W('wt-main-2'), name: 'Kira' }], 'closed:t2': [] }));
		const p = planPrune(await gather({ livePaths: [W('wt-main-1')] }));
		const why = (n: string) => p.repos[0]!.keep.find((e) => e.path === W(n))?.refusals.map((x) => x.code);
		expect(why('wt-main-1')).toEqual(['live-terminal']);
		expect(why('wt-main-2')).toEqual(['saved-terminal']);
	});

	it('reports an unreadable repo instead of skipping it', async () => {
		const p = planPrune(await gatherPruneFacts([{ name: 'Gone', path: path.join(root, 'nope') }], { livePaths: [], projectsDir: projects }));
		expect(p.repos[0]!.error).toMatch(/does not exist/);
		expect(describePrunePlan(p)).toMatch(/Gone: could not be read/);
	});
});

describe('executePrune', () => {
	it('removes exactly the plan, keeps every branch, and leaves the missing worktree listed', async () => {
		const plan = planPrune(await gather());
		const results = await executePrune(plan.repos);
		expect(results.map((r) => [path.basename(r.path), r.ok])).toEqual([['wt-main-1', true], ['wt-main-2', true], ['wt-main-3', true]]);
		for (const n of ['wt-main-1', 'wt-main-2', 'wt-main-3']) expect(fs.existsSync(W(n))).toBe(false);
		for (const n of ['wt-main-4', 'wt-main-5']) expect(fs.existsSync(W(n))).toBe(true);
		const branches = git(repo, 'branch', '--format=%(refname:short)').split('\n');
		for (const b of ['wt/main-1', 'wt/main-2', 'wt/main-3', 'wt/main-4', 'wt/main-5', 'wt/main-6']) expect(branches).toContain(b);
		// No blanket `git worktree prune`: the entry for the one already gone is how Reopen recreates it.
		expect(git(repo, 'worktree', 'list', '--porcelain')).toContain('wt-main-6');
		// The transcript is orphaned, not deleted.
		expect(fs.existsSync(path.join(projects, projectDirName(W('wt-main-1')), 's1.jsonl'))).toBe(true);
		// And the way back works: the branch restores the worktree at the same path.
		git(repo, 'worktree', 'add', '-q', W('wt-main-1'), 'wt/main-1');
		expect(fs.existsSync(path.join(W('wt-main-1'), 'a.txt'))).toBe(true);
	});

	it('lets git refuse a worktree that became dirty after the plan was made', async () => {
		const plan = planPrune(await gather());
		fs.writeFileSync(path.join(W('wt-main-1'), 'late.txt'), 'late\n');
		const results = await executePrune(plan.repos);
		expect(results.find((r) => r.path === W('wt-main-1'))!.ok).toBe(false);
		expect(fs.existsSync(path.join(W('wt-main-1'), 'late.txt'))).toBe(true);
	});

	// The measured hazard: `git worktree remove` deletes THROUGH a directory junction. A worktree
	// whose node_modules is a junction to the primary checkout's would take that with it.
	it.skipIf(process.platform !== 'win32')('unlinks a junction first, so what it points at survives', async () => {
		const shared = path.join(root, 'shared-node_modules');
		fs.mkdirSync(path.join(shared, 'pkg'), { recursive: true });
		fs.writeFileSync(path.join(shared, 'pkg', 'index.js'), 'precious\n');
		fs.symlinkSync(shared, path.join(W('wt-main-1'), 'node_modules'), 'junction');
		const plan = planPrune(await gather());
		const e = plan.repos[0]!.prune.find((x) => x.path === W('wt-main-1'))!;
		expect(e.links.map((l) => path.basename(l.path))).toEqual(['node_modules']);
		expect(describePrunePlan(plan)).toMatch(/node_modules is a link to/);
		const results = await executePrune(plan.repos);
		expect(results.find((r) => r.path === W('wt-main-1'))!.ok).toBe(true);
		expect(() => fs.lstatSync(path.join(W('wt-main-1'), 'node_modules'))).toThrow();
		expect(fs.readFileSync(path.join(shared, 'pkg', 'index.js'), 'utf8')).toBe('precious\n');
	});
});

describe('the parts', () => {
	it.skipIf(process.platform !== 'win32')('findLinks finds nested junctions and never walks into one', async () => {
		const target = path.join(root, 'target');
		fs.mkdirSync(path.join(target, 'deep'), { recursive: true });
		fs.mkdirSync(path.join(W('wt-main-1'), 'a', 'b'), { recursive: true });
		fs.symlinkSync(target, path.join(W('wt-main-1'), 'a', 'b', 'link'), 'junction');
		const links = await findLinks(W('wt-main-1'));
		expect(links.map((l) => path.relative(W('wt-main-1'), l.path))).toEqual([path.join('a', 'b', 'link')]);
	});

	it('readSavedTerminals reads every bucket and survives a missing file', () => {
		expect(readSavedTerminals(path.join(root, 'none.json'))).toEqual([]);
		fs.writeFileSync(sessions, JSON.stringify({ t1: [{ worktreePath: 'x', name: 'A' }], 'closed:t2': [{ worktreePath: 'y' }], bad: 3 }));
		expect(readSavedTerminals(sessions)).toEqual([{ path: 'x', where: 'tab t1 (A)' }, { path: 'y', where: 'closed tab t2' }]);
	});

	it('explainRemoveFailure tells EBUSY from a permission hold', () => {
		expect(explainRemoveFailure("error: failed to delete 'x': Device or resource busy")).toMatch(/sync engine/);
		expect(explainRemoveFailure("error: failed to delete 'x': Permission denied")).toMatch(/working directory/);
	});
});
