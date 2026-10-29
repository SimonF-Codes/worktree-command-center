import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { removeWorktreeAndBranch, branchMergedInto } from '../src/terminals/worktree-manager';

// The regression: the tile × ran `git branch -D`, a force delete that never looked, and on
// 2026-10-21 it took apartment-planner's wt/main-2 with three unmerged commits. Closing a tile must
// never make a commit unreachable. Real git, real worktree, the same fixture shape as
// worktree-remove-links.test.ts; GIT_* is stripped for the reason park-for-session-end.test.ts gives.

const savedGitEnv: Record<string, string> = {};
beforeAll(() => {
	for (const k of Object.keys(process.env)) {
		if (k.startsWith('GIT_')) { savedGitEnv[k] = process.env[k]!; delete process.env[k]; }
	}
});
afterAll(() => { Object.assign(process.env, savedGitEnv); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();
const BRANCH = 'wt/main-1';

let root: string, repo: string, wt: string;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-wt-close-')));
	repo = path.join(root, 'Repo');
	wt = path.join(repo, '.claude-worktrees', 'wt-main-1');
	fs.mkdirSync(repo, { recursive: true });
	git(repo, 'init', '-q', '-b', 'main');
	const gitDir = path.resolve(repo, git(repo, 'rev-parse', '--git-dir'));
	if (gitDir !== path.resolve(repo, '.git')) throw new Error(`refusing to run: temp repo resolved to ${gitDir}, not its own .git`);
	for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(repo, 'config', k!, v!);
	fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'init');
	fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '/.claude-worktrees/\n');
	git(repo, 'worktree', 'add', '-q', '-b', BRANCH, wt, 'main');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** Commit `file` = `body` in `dir`; returns the new commit's sha. */
const commit = (dir: string, file: string, body: string, msg: string): string => {
	fs.writeFileSync(path.join(dir, file), body);
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', msg);
	return git(dir, 'rev-parse', 'HEAD');
};
const reachable = (sha: string): boolean => git(repo, 'branch', '--contains', sha).length > 0;
const branchExists = (): boolean => { try { git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`); return true; } catch { return false; } };

describe('the tile × never discards unmerged commits', () => {
	it('an unmerged commit: the worktree goes, the branch and the commit stay', async () => {
		const sha = commit(wt, 'layout.ts', 'export const viewer = 1;\n', 'Add the 2D layout viewer');
		const r = await removeWorktreeAndBranch(repo, wt, BRANCH, 'main');
		expect(fs.existsSync(wt)).toBe(false);
		expect(branchExists()).toBe(true);
		expect(reachable(sha)).toBe(true);
		expect(r).toMatchObject({ worktree: 'removed', branch: 'kept', parked: false });
		expect(r.reason).toBe('1 commit not in main');
	});

	it('uncommitted work is parked onto the branch, which is then kept', async () => {
		fs.writeFileSync(path.join(wt, 'draft.txt'), 'half done\n');
		const r = await removeWorktreeAndBranch(repo, wt, BRANCH, 'main');
		expect(r).toMatchObject({ worktree: 'removed', branch: 'kept', parked: true });
		expect(git(repo, 'show', `${BRANCH}:draft.txt`)).toBe('half done');
	});

	it('a base that does not resolve keeps the branch — unknown is never merged', async () => {
		const sha = commit(wt, 'b.txt', 'x\n', 'work');
		const r = await removeWorktreeAndBranch(repo, wt, BRANCH, 'no-such-base');
		expect(r.branch).toBe('kept');
		expect(r.reason).toMatch(/could not tell/);
		expect(reachable(sha)).toBe(true);
	});

	it('a clean branch with nothing ahead of base is deleted', async () => {
		const r = await removeWorktreeAndBranch(repo, wt, BRANCH, 'main');
		expect(r).toEqual({ worktree: 'removed', branch: 'deleted', parked: false, reason: '' });
		expect(branchExists()).toBe(false);
	});

	it('a branch merged by fast-forward is deleted', async () => {
		commit(wt, 'b.txt', 'x\n', 'work');
		git(repo, 'merge', '-q', '--ff-only', BRANCH);
		expect((await removeWorktreeAndBranch(repo, wt, BRANCH, 'main')).branch).toBe('deleted');
	});

	it('a branch landed by rebase / cherry-pick is deleted (patch-ids match)', async () => {
		const sha = commit(wt, 'b.txt', 'x\n', 'work');
		commit(repo, 'c.txt', 'main moved on\n', 'unrelated');
		git(repo, 'cherry-pick', sha);
		expect(await branchMergedInto(repo, 'main', BRANCH)).toEqual({ merged: 'patch-id', ahead: 1 });
		expect((await removeWorktreeAndBranch(repo, wt, BRANCH, 'main')).branch).toBe('deleted');
	});

	it('a branch landed by SQUASH of several commits is deleted (merging it changes nothing)', async () => {
		commit(wt, 'b.txt', 'one\n', 'first');
		commit(wt, 'b.txt', 'one\ntwo\n', 'second');
		git(repo, 'merge', '-q', '--squash', BRANCH);
		git(repo, 'commit', '-q', '-m', 'squash');
		expect(await branchMergedInto(repo, 'main', BRANCH)).toEqual({ merged: 'content', ahead: 2 });
		expect((await removeWorktreeAndBranch(repo, wt, BRANCH, 'main')).branch).toBe('deleted');
	});

	it('the named limit: squashed, then base changed those lines again — reads as unmerged, so kept', async () => {
		commit(wt, 'b.txt', 'one\n', 'first');
		commit(wt, 'b.txt', 'one\ntwo\n', 'second');
		git(repo, 'merge', '-q', '--squash', BRANCH);
		git(repo, 'commit', '-q', '-m', 'squash');
		commit(repo, 'b.txt', 'rewritten\n', 'base moved those lines');
		expect((await branchMergedInto(repo, 'main', BRANCH)).merged).toBeNull();
		expect((await removeWorktreeAndBranch(repo, wt, BRANCH, 'main')).branch).toBe('kept');
	});
});
