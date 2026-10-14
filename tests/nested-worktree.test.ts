import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createWorktree, ensureClaudeSettingsIgnored, ensureWorktreesExcluded, worktreePathFor } from '../src/terminals/worktree-manager';

// Real git: worktrees are created INSIDE the repo, so the repo's own checkout must never see them.
// The exclude rule goes to .git/info/exclude (local, never committed) — no tracked file changes.

// Inherited GIT_* variables point every git call at the repo RUNNING the tests (see
// park-for-session-end.test.ts). Strip them for the whole file.
const savedGitEnv: Record<string, string> = {};
beforeAll(() => {
	for (const k of Object.keys(process.env)) {
		if (k.startsWith('GIT_')) { savedGitEnv[k] = process.env[k]!; delete process.env[k]; }
	}
});
afterAll(() => { Object.assign(process.env, savedGitEnv); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();

let root: string, repo: string;
beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-nested-wt-')));
	repo = path.join(root, 'repo');
	fs.mkdirSync(repo);
	git(repo, 'init', '-q', '-b', 'main');
	const gitDir = path.resolve(repo, git(repo, 'rev-parse', '--git-dir'));
	if (gitDir !== path.resolve(repo, '.git')) throw new Error(`refusing to run: temp repo resolved to ${gitDir}, not its own .git`);
	git(repo, 'config', 'user.email', 'test@example.com');
	git(repo, 'config', 'user.name', 'Test');
	git(repo, 'config', 'commit.gpgsign', 'false');
	fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'init');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const exclude = () => fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');

describe('createWorktree — nested inside the repo', () => {
	it('creates <repo>/.claude-worktrees/<slug> and the repo\'s own status stays clean', async () => {
		const wt = await createWorktree(repo, 'main', 'wt/main-1');
		expect(wt.worktreePath).toBe(worktreePathFor(repo, 'wt/main-1'));
		expect(wt.worktreePath).toBe(path.join(repo, '.claude-worktrees', 'wt-main-1'));
		expect(git(wt.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wt/main-1');
		expect(git(repo, 'status', '--porcelain')).toBe('');
		expect(git(repo, 'check-ignore', '.claude-worktrees/wt-main-1')).toBe('.claude-worktrees/wt-main-1');
		// No tracked file was touched to get there.
		expect(fs.existsSync(path.join(repo, '.gitignore'))).toBe(false);
		// Inside the worktree, nothing reads as dirty either.
		expect(git(wt.worktreePath, 'status', '--porcelain')).toBe('');
	});

	it('a second worktree works, and the exclude line is written once', async () => {
		await createWorktree(repo, 'main', 'wt/main-1');
		await createWorktree(repo, 'main', 'wt/main-2');
		expect(exclude().split('\n').filter((l) => l.trim() === '/.claude-worktrees/')).toHaveLength(1);
		expect(git(repo, 'status', '--porcelain')).toBe('');
	});

	it('creating a worktree from inside another worktree still nests it in the primary repo\'s root', async () => {
		// The common dir is shared, so the rule written through a worktree covers the repo too.
		const a = await createWorktree(repo, 'main', 'wt/main-1');
		await ensureWorktreesExcluded(a.worktreePath);
		expect(exclude().split('\n').filter((l) => l.trim() === '/.claude-worktrees/')).toHaveLength(1);
	});

	it('refuses — creating nothing — when the repo cannot be excluded from', async () => {
		const notARepo = path.join(root, 'plain');
		fs.mkdirSync(notARepo);
		await expect(createWorktree(notARepo, 'main', 'wt/main-1')).rejects.toThrow(/info\/exclude/);
		expect(fs.existsSync(path.join(notARepo, '.claude-worktrees'))).toBe(false);
	});
});

describe('the floor scan\'s exclude pass', () => {
	it('covers a repo before its first nested worktree exists, alongside the settings file, idempotently', async () => {
		fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'existing-rule'); // no trailing newline
		await ensureClaudeSettingsIgnored(repo);
		await ensureClaudeSettingsIgnored(repo);
		const lines = exclude().split('\n').map((l) => l.trim());
		expect(lines).toContain('existing-rule');
		expect(lines.filter((l) => l === '.claude/settings.local.json')).toHaveLength(1);
		expect(lines.filter((l) => l === '/.claude-worktrees/')).toHaveLength(1);
		// A worktree made by hand in the root afterwards is already invisible.
		git(repo, 'worktree', 'add', '-q', '-b', 'byhand', path.join(repo, '.claude-worktrees', 'byhand'), 'main');
		expect(git(repo, 'status', '--porcelain')).toBe('');
	});
});
