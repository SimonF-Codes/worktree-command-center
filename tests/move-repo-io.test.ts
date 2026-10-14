import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { gatherMoveFacts, executeMove, probeRename, verifyMove, describeMoveResult, type GatherContext } from '../src/move-repo-io';
import { planMove, type MovePlan } from '../src/move-repo';
import { projectDirName } from '../src/terminals/resume-target';

// Real git, real directories, all inside a temp root — never a real repo. The fixture is the
// VerticalChess shape: a repo nested one level too deep, two worktrees in the old shared root
// beside it (the layout before 0.12), one loose beside it, one nested INSIDE the repo folder, and transcript folders keyed to
// some of those paths in a stand-in ~/.claude/projects.

// Inherited GIT_* variables point every git call at the repo RUNNING the tests (see
// park-for-session-end.test.ts for the time that happened). Strip them for the whole file.
const savedGitEnv: Record<string, string> = {};
beforeAll(() => {
	for (const k of Object.keys(process.env)) {
		if (k.startsWith('GIT_')) { savedGitEnv[k] = process.env[k]!; delete process.env[k]; }
	}
});
afterAll(() => { Object.assign(process.env, savedGitEnv); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();

let root: string, from: string, to: string, projects: string, journals: string;
let oldRoot: string, newRoot: string, wtA: string, wtB: string, loose: string, inner: string;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-move-repo-')));
	from = path.join(root, 'Nest', 'Repo');
	to = path.join(root, 'Repo');
	oldRoot = path.join(root, 'Nest', '.claude-worktrees', 'Repo');
	newRoot = path.join(to, '.claude-worktrees');
	wtA = path.join(oldRoot, 'wt-main-1');
	wtB = path.join(oldRoot, 'wt-main-2');
	loose = path.join(root, 'Nest', 'wt-loose');
	inner = path.join(from, '.wt', 'inner');
	projects = path.join(root, 'projects');
	journals = path.join(root, 'journals');

	fs.mkdirSync(from, { recursive: true });
	git(from, 'init', '-q', '-b', 'main');
	const gitDir = path.resolve(from, git(from, 'rev-parse', '--git-dir'));
	if (gitDir !== path.resolve(from, '.git')) throw new Error(`refusing to run: temp repo resolved to ${gitDir}, not its own .git`);
	git(from, 'config', 'user.email', 'test@example.com');
	git(from, 'config', 'user.name', 'Test');
	git(from, 'config', 'commit.gpgsign', 'false');
	git(from, 'config', 'core.autocrlf', 'false');
	fs.writeFileSync(path.join(from, 'a.txt'), 'one\n');
	git(from, 'add', '-A');
	git(from, 'commit', '-q', '-m', 'init');
	fs.appendFileSync(path.join(from, '.git', 'info', 'exclude'), '.wt/\n');
	git(from, 'worktree', 'add', '-q', '-b', 'wt/main-1', wtA, 'main');
	git(from, 'worktree', 'add', '-q', '-b', 'wt/main-2', wtB, 'main');
	git(from, 'worktree', 'add', '-q', '-b', 'loose', loose, 'main');
	git(from, 'worktree', 'add', '-q', '-b', 'inner', inner, 'main');
	// A commit only one worktree's branch holds, and a detached HEAD no ref names.
	fs.writeFileSync(path.join(wtA, 'b.txt'), 'two\n');
	git(wtA, 'add', '-A');
	git(wtA, 'commit', '-q', '-m', 'on wt-main-1');
	git(loose, 'checkout', '-q', '--detach');
	fs.writeFileSync(path.join(loose, 'c.txt'), 'three\n');
	git(loose, 'add', '-A');
	git(loose, 'commit', '-q', '-m', 'detached');

	fs.mkdirSync(path.join(projects, projectDirName(from)), { recursive: true });
	fs.writeFileSync(path.join(projects, projectDirName(from), 's1.jsonl'), '{}\n');
	fs.mkdirSync(path.join(projects, projectDirName(wtA)));
	fs.writeFileSync(path.join(projects, projectDirName(wtA), 's2.jsonl'), '{}\n');
	fs.mkdirSync(path.join(projects, 'C--somewhere-else'));
});

const children: ChildProcess[] = [];
afterEach(async () => {
	// Wait for each holder to EXIT, not just be signalled: until it does, its cwd still pins the
	// directory and the cleanup below fails with EBUSY.
	for (const c of children.splice(0)) await release(c);
	fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const target = () => ({ name: 'Repo', path: from });
const ctx = (over: Partial<GatherContext> = {}): GatherContext => ({ livePaths: [], targets: [target()], projectsDir: projects, ...over });

/** A process whose working directory is `cwd` — what holds a worktree open on this machine.
 *  Waits for the child to SAY it is running: the 'spawn' event fires before the child's loader
 *  has opened its cwd handle, and a probe in that gap reads 'free' (the first draft of this test
 *  did exactly that). */
async function holdOpen(cwd: string, argv: string[] = []): Promise<ChildProcess> {
	const c = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)', ...argv], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
	children.push(c);
	await new Promise<void>((res, rej) => { c.stdout!.once('data', () => res()); c.once('error', rej); c.once('exit', () => rej(new Error('holder exited early'))); });
	return c;
}
async function release(c: ChildProcess): Promise<void> { // hoisted: afterEach uses it too
	if (c.exitCode !== null || c.signalCode !== null) return; // a killed child has exitCode null
	await new Promise<void>((res) => { c.once('exit', () => res()); c.kill(); });
}

function appState() {
	const calls: MovePlan[] = [];
	return { calls, applyAppState: async (p: MovePlan) => { calls.push(p); return { ok: true, detail: 'stub' }; } };
}

const listedWorktrees = (repo: string) => git(repo, 'worktree', 'list', '--porcelain')
	.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice(9).trim()));

describe('a whole move, on real git', () => {
	it('moves the repo, relocates the canonical worktrees, repairs every link, renames transcripts, and verifies', async () => {
		const refsBefore = git(from, 'for-each-ref', '--format=%(objectname) %(refname)');
		const detached = git(loose, 'rev-parse', 'HEAD');

		const facts = await gatherMoveFacts(target(), to, ctx());
		const plan = planMove(facts);
		expect(plan.refusals).toEqual([]);
		expect(plan.warnings.join('\n')).toMatch(/no remote/);

		const state = appState();
		const r = await executeMove(plan, { projectsDir: projects, journalDir: journals, applyAppState: state.applyAppState });
		expect(r.ok, describeMoveResult(r)).toBe(true);
		expect(r.verify).toMatchObject({ ok: true, missingShas: [], changedRefs: [], brokenWorktrees: [] });

		// The directory and both ends of every link.
		expect(fs.existsSync(from)).toBe(false);
		expect(git(to, 'for-each-ref', '--format=%(objectname) %(refname)')).toBe(refsBefore);
		const newA = path.join(newRoot, 'wt-main-1'), newB = path.join(newRoot, 'wt-main-2'), newInner = path.join(to, '.wt', 'inner');
		expect(listedWorktrees(to).sort()).toEqual([to, newA, newB, loose, newInner].sort());
		expect(git(to, 'worktree', 'list', '--porcelain')).not.toMatch(/prunable/);
		for (const [wt, branch] of [[newA, 'wt/main-1'], [newB, 'wt/main-2'], [newInner, 'inner']] as const) {
			expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
			expect(git(wt, 'status', '--porcelain')).toBe('');
		}
		// The worktree that stayed still works — its .git file was repaired to the new repo.
		expect(git(loose, 'rev-parse', 'HEAD')).toBe(detached);
		expect(fs.readFileSync(path.join(loose, '.git'), 'utf8')).toContain(to.replace(/\\/g, '/'));
		// The emptied old root is gone, and the shared root above it; the folder that still holds a
		// worktree is not.
		expect(fs.existsSync(oldRoot)).toBe(false);
		expect(fs.existsSync(path.dirname(oldRoot))).toBe(false);
		// The worktrees now inside the repo do not show in its own status.
		expect(git(to, 'status', '--porcelain')).toBe('');
		expect(fs.readFileSync(path.join(to, '.git', 'info', 'exclude'), 'utf8')).toContain('/.claude-worktrees/');
		expect(fs.existsSync(path.join(root, 'Nest'))).toBe(true);

		// Transcripts followed their paths; the unrelated one was not touched.
		expect(fs.readdirSync(projects).sort()).toEqual([projectDirName(to), projectDirName(newA), 'C--somewhere-else'].sort());
		expect(fs.existsSync(path.join(projects, projectDirName(newA), 's2.jsonl'))).toBe(true);

		// The app was asked to repoint config + sessions exactly once, with the full map.
		expect(state.calls).toHaveLength(1);
		expect(state.calls[0]!.pathMap.map((m) => m.to)).toEqual([to, newA, newB]);
	});

	it('refuses — and touches nothing — when a worktree is dirty', async () => {
		fs.writeFileSync(path.join(wtB, 'wip.txt'), 'unsaved\n');
		const plan = planMove(await gatherMoveFacts(target(), to, ctx()));
		expect(plan.refusals.map((r) => r.code)).toEqual(['dirty']);
		expect(plan.refusals[0]!.message).toContain('wip.txt');
		const r = await executeMove(plan, { projectsDir: projects, journalDir: journals, ...appState() });
		expect(r.ok).toBe(false);
		expect(fs.existsSync(from)).toBe(true);
		expect(fs.existsSync(journals)).toBe(false);
	});

	it('refuses when a terminal is live in a worktree', async () => {
		const plan = planMove(await gatherMoveFacts(target(), to, ctx({ livePaths: [wtA] })));
		expect(plan.refusals.map((r) => r.code)).toEqual(['live-terminal']);
	});

	it('resumes a move whose directory step already happened, and finishes it', async () => {
		const refsBefore = git(from, 'for-each-ref', '--format=%(objectname) %(refname)');
		// Stopped right after step 1: the directory moved, nothing else did.
		fs.renameSync(from, to);
		const facts = await gatherMoveFacts(target(), to, ctx());
		expect(facts.fromExists).toBe(false);
		const plan = planMove(facts);
		expect(plan.refusals).toEqual([]);
		expect(plan.resuming).toBe(true);
		const r = await executeMove(plan, { projectsDir: projects, journalDir: journals, ...appState() });
		expect(r.ok, describeMoveResult(r)).toBe(true);
		expect(git(to, 'for-each-ref', '--format=%(objectname) %(refname)')).toBe(refsBefore);
		expect(git(to, 'worktree', 'list', '--porcelain')).not.toMatch(/prunable/);
		expect(fs.existsSync(path.join(projects, projectDirName(to)))).toBe(true);
	});
});

// The migration: the repo stays at `from`; its worktrees in the old shared root move inside it.
describe('a relayout (from === to), on real git', () => {
	const nestRoot = () => path.join(from, '.claude-worktrees');

	it('moves the old-root worktrees inside the repo, keeps git status clean, renames transcripts, and verifies', async () => {
		const refsBefore = git(from, 'for-each-ref', '--format=%(objectname) %(refname)');
		// A dirty repo checkout and a dirty staying worktree do not block it — neither moves.
		fs.writeFileSync(path.join(from, 'scratch.txt'), 'mine\n');
		fs.writeFileSync(path.join(loose, 'scratch.txt'), 'mine\n');

		const plan = planMove(await gatherMoveFacts(target(), from, ctx({ journalDir: journals })));
		expect(plan.refusals).toEqual([]);
		expect(plan.relayout).toBe(true);

		const state = appState();
		const r = await executeMove(plan, { projectsDir: projects, journalDir: journals, applyAppState: state.applyAppState });
		expect(r.ok, describeMoveResult(r)).toBe(true);
		expect(r.steps.map((s) => s.label).join('\n')).not.toMatch(/repair|Moving /);

		const newA = path.join(nestRoot(), 'wt-main-1'), newB = path.join(nestRoot(), 'wt-main-2');
		expect(listedWorktrees(from).sort()).toEqual([from, newA, newB, loose, inner].sort());
		expect(git(from, 'for-each-ref', '--format=%(objectname) %(refname)')).toBe(refsBefore);
		for (const [wt, branch] of [[newA, 'wt/main-1'], [newB, 'wt/main-2']] as const) {
			expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
			expect(git(wt, 'status', '--porcelain')).toBe('');
			// Both ends of the link were rewritten by git worktree move.
			expect(fs.readFileSync(path.join(wt, '.git'), 'utf8')).toContain(from.replace(/\\/g, '/'));
		}
		// The repo's own status shows only the user's file, never .claude-worktrees/.
		expect(git(from, 'status', '--porcelain')).toBe('?? scratch.txt');
		expect(fs.existsSync(oldRoot)).toBe(false);
		expect(fs.existsSync(path.dirname(oldRoot))).toBe(false);

		// wt-main-1's transcript followed it; the repo's own did not move.
		expect(fs.readdirSync(projects).sort()).toEqual([projectDirName(from), projectDirName(newA), 'C--somewhere-else'].sort());
		expect(state.calls[0]!.pathMap).toEqual([{ from: wtA, to: newA }, { from: wtB, to: newB }].sort((a, b) => a.from.localeCompare(b.from)));

		// Run again: nothing left to do.
		const again = planMove(await gatherMoveFacts(target(), from, ctx({ journalDir: journals })));
		expect(again.refusals.map((x) => x.code)).toEqual(['nothing-to-relayout']);
	});

	it('refuses a dirty worktree it would move, and touches nothing', async () => {
		fs.writeFileSync(path.join(wtB, 'wip.txt'), 'unsaved\n');
		const plan = planMove(await gatherMoveFacts(target(), from, ctx()));
		expect(plan.refusals.map((r) => r.code)).toEqual(['dirty']);
		expect(fs.existsSync(nestRoot())).toBe(false);
	});

	it('refuses a worktree with a submodule checked out, which git will not move', async () => {
		const sub = path.join(root, 'sub');
		fs.mkdirSync(sub);
		git(sub, 'init', '-q', '-b', 'main');
		git(sub, '-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 's');
		git(wtB, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'lib');
		git(wtB, 'commit', '-q', '-m', 'add lib');
		const facts = await gatherMoveFacts(target(), from, ctx());
		expect(facts.submoduleWorktrees).toEqual([wtB]);
		expect(planMove(facts).refusals.map((r) => r.code)).toEqual(['submodule-worktree']);
	});

	it.runIf(process.platform === 'win32')('stops atomically on a held worktree, and a re-run picks up from its journal', async () => {
		const plan = planMove(await gatherMoveFacts(target(), from, ctx({ journalDir: journals })));
		const c = await holdOpen(wtB);
		const first = await executeMove(plan, { projectsDir: projects, journalDir: journals, ...appState() });
		expect(first.ok).toBe(false);
		expect(first.stoppedAt).toContain(wtB);
		expect(git(wtB, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wt/main-2');
		await release(c);

		const again = planMove(await gatherMoveFacts(target(), from, ctx({ journalDir: journals })));
		expect(again.refusals).toEqual([]);
		expect(again.worktreeMoves.map((m) => [path.basename(m.to), m.done]).sort()).toEqual([['wt-main-1', true], ['wt-main-2', false]]);
		const second = await executeMove(again, { projectsDir: projects, journalDir: journals, ...appState() });
		expect(second.ok, describeMoveResult(second)).toBe(true);
		expect(listedWorktrees(from)).toContain(path.join(nestRoot(), 'wt-main-2'));
		expect(fs.existsSync(path.join(projects, projectDirName(path.join(nestRoot(), 'wt-main-1')), 's2.jsonl'))).toBe(true);
	}, 30000);
});

describe('verification', () => {
	it('catches a commit that is gone', async () => {
		const plan = planMove(await gatherMoveFacts(target(), to, ctx()));
		const fake = 'deadbeef'.repeat(5);
		fs.renameSync(from, to);
		git(to, 'worktree', 'repair', ...plan.repair);
		const v = await verifyMove({ ...plan, expectedWorktrees: [] }, { refs: { 'refs/heads/ghost': fake }, heads: [] });
		expect(v.ok).toBe(false);
		expect(v.missingShas).toEqual([fake]);
		expect(v.changedRefs).toEqual(['refs/heads/ghost']);
	});
});

// The decisive diagnosis of 2026-10-14: a directory whose rename-in-place fails is held by a
// process — almost always one whose cwd is inside. These prove the detection FIRES against a
// real holder, not merely that it runs. (Only Windows refuses to rename a process's cwd.)
describe.runIf(process.platform === 'win32')('held-open directories (Windows)', () => {
	it('probeRename says held while a process has its cwd inside, and free once it exits', async () => {
		const c = await holdOpen(wtB);
		expect(await probeRename(wtB)).toBe('held');
		expect(fs.existsSync(wtB)).toBe(true);
		await release(c);
		expect(await probeRename(wtB)).toBe('free');
		expect(fs.existsSync(wtB)).toBe(true);
		expect(fs.readdirSync(path.dirname(wtB)).some((n) => n.includes('wcc-move-probe'))).toBe(false);
	});

	it('the plan refuses a held worktree and names the holder when its command line shows it', async () => {
		await holdOpen(wtB, [wtB]);
		const plan = planMove(await gatherMoveFacts(target(), to, ctx()));
		expect(plan.refusals.map((r) => r.code)).toEqual(['held-open']);
		expect(plan.refusals[0]!.path).toBe(wtB);
		expect(plan.refusals[0]!.message).toMatch(/node(\.exe)? \(pid \d+\)/i);
	}, 30000);

	it('a move that fails halfway stops atomically, says where, and a re-run finishes it', async () => {
		const refsBefore = git(from, 'for-each-ref', '--format=%(objectname) %(refname)');
		const plan = planMove(await gatherMoveFacts(target(), to, ctx()));
		expect(plan.refusals).toEqual([]);
		// Something takes hold of wt-main-2 after the plan was confirmed.
		const c = await holdOpen(wtB);
		const first = await executeMove(plan, { projectsDir: projects, journalDir: journals, ...appState() });
		expect(first.ok).toBe(false);
		expect(first.stoppedAt).toContain(wtB);
		expect(describeMoveResult(first)).toMatch(/Stopped at: git worktree move .*wt-main-2/);
		// Atomic: wt-main-2 is exactly where it was, and still works.
		expect(fs.existsSync(wtB)).toBe(true);
		expect(git(wtB, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wt/main-2');

		await release(c);
		const again = planMove(await gatherMoveFacts(target(), to, ctx({ journalDir: journals })));
		expect(again.refusals).toEqual([]);
		expect(again.resuming).toBe(true);
		expect(again.worktreeMoves.map((m) => [path.basename(m.to), m.done]).sort()).toEqual([['wt-main-1', true], ['wt-main-2', false]]);
		const second = await executeMove(again, { projectsDir: projects, journalDir: journals, ...appState() });
		expect(second.ok, describeMoveResult(second)).toBe(true);
		expect(second.steps[0]!.label).toMatch(/^Resuming/);
		expect(git(to, 'for-each-ref', '--format=%(objectname) %(refname)')).toBe(refsBefore);
		expect(listedWorktrees(to)).toContain(path.join(newRoot, 'wt-main-2'));
	}, 30000);
});
