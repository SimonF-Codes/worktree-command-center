import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { removeWorktreeAndBranch, removeWorktreeIfPristine, unlinkLinksInside } from '../src/terminals/worktree-manager';

// The regression: a recursive delete that walks INTO a directory junction deletes the junction's
// TARGET. `git worktree remove --force` does exactly that — it is how the primary checkout's
// node_modules was wiped once, by removing a worktree whose node_modules was a junction to it.
// Each fixture is a worktree holding a junction to a directory with a sentinel file OUTSIDE the
// worktree; after removal the junction must be gone and the sentinel still there.

const savedGitEnv: Record<string, string> = {};
beforeAll(() => {
	for (const k of Object.keys(process.env)) {
		if (k.startsWith('GIT_')) { savedGitEnv[k] = process.env[k]!; delete process.env[k]; }
	}
});
afterAll(() => { Object.assign(process.env, savedGitEnv); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();

let root: string, repo: string, wt: string, shared: string, sentinel: string;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-wt-links-')));
	repo = path.join(root, 'Repo');
	wt = path.join(repo, '.claude-worktrees', 'wt-main-1');
	shared = path.join(root, 'primary-node_modules');
	sentinel = path.join(shared, 'pkg', 'SENTINEL');
	fs.mkdirSync(repo, { recursive: true });
	git(repo, 'init', '-q', '-b', 'main');
	const gitDir = path.resolve(repo, git(repo, 'rev-parse', '--git-dir'));
	if (gitDir !== path.resolve(repo, '.git')) throw new Error(`refusing to run: temp repo resolved to ${gitDir}, not its own .git`);
	for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(repo, 'config', k!, v!);
	fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\nvendor\n');
	fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'init');
	fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '/.claude-worktrees/\n');
	git(repo, 'worktree', 'add', '-q', '-b', 'wt/main-1', wt, 'main');

	fs.mkdirSync(path.dirname(sentinel), { recursive: true });
	fs.writeFileSync(sentinel, 'must survive\n');
	// 'junction' on Windows (what the floor's worktrees use); a plain dir symlink elsewhere.
	fs.symlinkSync(shared, path.join(wt, 'node_modules'), 'junction');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const isGone = (p: string): boolean => { try { fs.lstatSync(p); return false; } catch { return true; } };

describe('removing a worktree never deletes through a link inside it', () => {
	it('removeWorktreeAndBranch: the junction goes, its target survives', async () => {
		await removeWorktreeAndBranch(repo, wt, 'wt/main-1');
		expect(isGone(path.join(wt, 'node_modules'))).toBe(true);
		expect(fs.existsSync(wt)).toBe(false);
		expect(fs.readFileSync(sentinel, 'utf8')).toBe('must survive\n');
	});

	it('removeWorktreeAndBranch: a junction nested deep inside, too', async () => {
		fs.mkdirSync(path.join(wt, 'vendor', 'deep'), { recursive: true });
		fs.symlinkSync(shared, path.join(wt, 'vendor', 'deep', 'link'), 'junction');
		await removeWorktreeAndBranch(repo, wt, 'wt/main-1');
		expect(fs.existsSync(wt)).toBe(false);
		expect(fs.readFileSync(sentinel, 'utf8')).toBe('must survive\n');
	});

	it('removeWorktreeIfPristine: the junction goes, its target survives', async () => {
		expect(await removeWorktreeIfPristine(repo, wt, 'main')).toBe('removed');
		expect(isGone(path.join(wt, 'node_modules'))).toBe(true);
		expect(fs.readFileSync(sentinel, 'utf8')).toBe('must survive\n');
	});

	it('removeWorktreeIfPristine: a worktree that is kept keeps its links', async () => {
		fs.writeFileSync(path.join(wt, 'dirty.txt'), 'x\n');
		expect(await removeWorktreeIfPristine(repo, wt, 'main')).toBe('kept');
		expect(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink()).toBe(true);
	});

	it('unlinkLinksInside never walks into a link, and reports what it dropped', async () => {
		const r = await unlinkLinksInside(wt);
		expect(r.stuck).toEqual([]);
		expect(r.unlinked.map((l) => path.relative(wt, l.path))).toEqual(['node_modules']);
		expect(fs.readFileSync(sentinel, 'utf8')).toBe('must survive\n');
	});
});
