import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { parkForSessionEnd, reopenWorktree } from '../src/terminals/worktree-manager';
import { isParkCommitSubject } from '../src/terminals/worktree-registry';

// Real git, real worktree: the property under test is that ending a session leaves the worktree
// and its branch on disk, because the transcript in ~/.claude/projects is keyed by worktree PATH.
// parkForSessionEnd is the only git step TerminalsGrid.endSessionKeepingWork takes (the memory
// panel's End and the overseer's `cos-coord close` both go through that method).

// Git exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE to hooks and to `rebase --exec`. Inherited,
// they point every git call below — including parkWorktree's own, via runCommand — at the repo
// RUNNING the tests: `git init` then flips its shared config to bare, `git config` sets its author,
// and the "temp" commits land on its HEAD. That happened once (2026-09-29, a `rebase -x "npm test"`).
// So strip them for the whole file, and refuse to run if the temp repo isn't its own repo.
const savedGitEnv: Record<string, string> = {};
beforeAll(() => {
	for (const k of Object.keys(process.env)) {
		if (k.startsWith('GIT_')) { savedGitEnv[k] = process.env[k]!; delete process.env[k]; }
	}
});
afterAll(() => { Object.assign(process.env, savedGitEnv); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();

let root: string, repo: string, wt: string;
const BRANCH = 'wt/main-1';

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-park-end-'));
	repo = path.join(root, 'repo');
	wt = path.join(root, 'wt-main-1');
	fs.mkdirSync(repo);
	git(repo, 'init', '-q', '-b', 'main');
	const gitDir = path.resolve(repo, git(repo, 'rev-parse', '--git-dir'));
	if (gitDir !== path.resolve(repo, '.git')) throw new Error(`refusing to run: temp repo resolved to ${gitDir}, not its own .git`);
	git(repo, 'config', 'user.email', 'test@example.com');
	git(repo, 'config', 'user.name', 'Test');
	git(repo, 'config', 'commit.gpgsign', 'false');
	git(repo, 'config', 'core.autocrlf', 'false');
	fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'init');
	git(repo, 'worktree', 'add', '-q', '-b', BRANCH, wt, 'main');
});

afterEach(() => {
	try { git(repo, 'worktree', 'remove', '--force', wt); } catch { /* already gone */ }
	fs.rmSync(root, { recursive: true, force: true });
});

const worktreeListed = () => git(repo, 'worktree', 'list', '--porcelain')
	.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice('worktree '.length)))
	.includes(path.resolve(wt));
const branchExists = () => { try { git(repo, 'rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`); return true; } catch { return false; } };

describe('parkForSessionEnd', () => {
	it('parks dirty work as a wip: commit and keeps the worktree AND its branch', async () => {
		fs.writeFileSync(path.join(wt, 'a.txt'), 'two\n');
		fs.writeFileSync(path.join(wt, 'new.txt'), 'untracked\n');

		expect(await parkForSessionEnd(wt, false, '2026-09-29T12:00:00.000Z')).toBe('parked');

		expect(fs.existsSync(wt)).toBe(true);
		expect(worktreeListed()).toBe(true);
		expect(branchExists()).toBe(true);
		expect(isParkCommitSubject(git(wt, 'log', '-1', '--pretty=%s'))).toBe(true);
		expect(git(wt, 'status', '--porcelain')).toBe('');
	});

	it('is reversible: reopening restores the parked work as uncommitted', async () => {
		fs.writeFileSync(path.join(wt, 'a.txt'), 'two\n');
		await parkForSessionEnd(wt, false, '2026-09-29T12:00:00.000Z');
		await reopenWorktree(repo, wt, BRANCH);
		expect(git(wt, 'log', '-1', '--pretty=%s')).toBe('init');
		expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8')).toBe('two\n');
	});

	it('leaves a clean worktree untouched and still on disk', async () => {
		const head = git(wt, 'rev-parse', 'HEAD');
		expect(await parkForSessionEnd(wt, false, '2026-09-29T12:00:00.000Z')).toBe('clean');
		expect(git(wt, 'rev-parse', 'HEAD')).toBe(head);
		expect(worktreeListed()).toBe(true);
		expect(branchExists()).toBe(true);
	});

	it('never commits in a folder target, even when the folder is inside a repo', async () => {
		fs.writeFileSync(path.join(wt, 'a.txt'), 'two\n');
		const head = git(wt, 'rev-parse', 'HEAD');
		expect(await parkForSessionEnd(wt, true, '2026-09-29T12:00:00.000Z')).toBe('skipped');
		expect(git(wt, 'rev-parse', 'HEAD')).toBe(head);
		expect(git(wt, 'status', '--porcelain')).toBe('M a.txt');
	});

	it('reports failed instead of throwing when the path is not a git checkout', async () => {
		const plain = path.join(root, 'plain');
		fs.mkdirSync(plain);
		// A dir under os.tmpdir() is not inside any repo, so `git status` fails there.
		expect(await parkForSessionEnd(plain, false, '2026-09-29T12:00:00.000Z')).toBe('failed');
	});
});
