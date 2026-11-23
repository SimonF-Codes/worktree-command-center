import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { canonicalPath, inRegisteredSpelling, scannedWorktrees } from '../src/git-spelling';
import { makeTempDir } from './temp-dir';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Real git, inside a temp root. One repository, two spellings: the repo reached through a junction
// (a symlink off Windows), git reporting its canonical path.

const savedGitEnv: Record<string, string> = {};
beforeAll(() => {
	for (const k of Object.keys(process.env)) {
		if (k.startsWith('GIT_')) { savedGitEnv[k] = process.env[k]!; delete process.env[k]; }
	}
});
afterAll(() => { Object.assign(process.env, savedGitEnv); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();
const ci = process.platform === 'win32';

let root: string, repo: string, via: string;
beforeEach(() => {
	root = makeTempDir('wcc-spelling-');
	repo = path.join(root, 'Repo');
	via = path.join(root, 'via');
	fs.mkdirSync(repo);
	git(repo, 'init', '-q', '-b', 'main');
	const gitDir = path.resolve(repo, git(repo, 'rev-parse', '--git-dir'));
	if (gitDir !== path.resolve(repo, '.git')) throw new Error(`refusing to run: temp repo resolved to ${gitDir}, not its own .git`);
	for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false']]) git(repo, 'config', k!, v!);
	fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'init');
	git(repo, 'worktree', 'add', '-q', '-b', 'wt/main-1', path.join(repo, '.claude-worktrees', 'wt-main-1'), 'main');
	fs.symlinkSync(repo, via, 'junction');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('scannedWorktrees — the worktree scan (Coordination panel, ledger, Reopen)', () => {
	it('through a junction: the primary checkout is left out, and each worktree is in the registered spelling', () => {
		const porcelain = git(via, 'worktree', 'list', '--porcelain');
		expect(porcelain).not.toContain('via'); // git answers in its own spelling, whatever the cwd
		expect(scannedWorktrees(porcelain, via, ci)).toEqual([
			{ path: path.join(via, '.claude-worktrees', 'wt-main-1'), branch: 'wt/main-1' },
		]);
	});

	it('a repo registered as git spells it: unchanged, exactly as git printed it', () => {
		const porcelain = git(repo, 'worktree', 'list', '--porcelain');
		const printed = /^worktree (.*)$/m.exec(porcelain.split('\n\n')[1]!)![1]!;
		expect(scannedWorktrees(porcelain, repo, ci)).toEqual([{ path: printed, branch: 'wt/main-1' }]);
	});
});

describe('canonicalPath / inRegisteredSpelling', () => {
	it('resolves a path that does not exist through its nearest existing parent, never throwing', () => {
		expect(canonicalPath(path.join(via, 'gone', 'deeper'))).toBe(path.join(repo, 'gone', 'deeper'));
		expect(inRegisteredSpelling([via], ci)(path.join(repo, 'gone'))).toBe(path.join(via, 'gone'));
	});

	it('leaves a path under no anchor alone', () => {
		const elsewhere = path.join(root, 'elsewhere', 'x');
		expect(inRegisteredSpelling([via], ci)(elsewhere)).toBe(elsewhere);
	});
});
