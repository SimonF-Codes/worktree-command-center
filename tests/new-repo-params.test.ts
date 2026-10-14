import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
	defaultNewRepoParams, validBranchName, gitignoreFor, seedFiles, newRepoProblem, describeNewRepo,
} from '../src/new-repo-params';
import { createGitRepo } from '../src/create-repo';

describe('validBranchName', () => {
	it('accepts ordinary branch names', () => {
		for (const b of ['main', 'master', 'trunk', 'dev/simon', 'release-1.0']) expect(validBranchName(b)).toBe(true);
	});
	it('rejects what git check-ref-format would', () => {
		for (const b of ['', ' main', 'has space', 'a..b', '-x', 'x/', '/x', 'x.lock', 'x.', 'a//b', 'a@{b', '@', 'a:b', 'a~1', 'a^', 'a?', 'a*', 'a[b', 'a\\b','x/.hidden'])
			expect(validBranchName(b), b).toBe(false);
	});
});

describe('seed files', () => {
	it('defaults to main, a general .gitignore and a CLAUDE.md, no remote', () => {
		const p = defaultNewRepoParams('My App', '/dev');
		expect(p).toMatchObject({ branch: 'main', gitignore: 'general', claudeMd: true, remote: 'none' });
		expect(Object.keys(seedFiles(p))).toEqual(['.gitignore', 'CLAUDE.md']);
		expect(seedFiles(p)['CLAUDE.md']).toMatch(/^# My App\n/);
	});
	it('writes nothing extra when both are turned off', () => {
		expect(seedFiles({ ...defaultNewRepoParams('x', '/d'), gitignore: 'none', claudeMd: false })).toEqual({});
		expect(gitignoreFor('none')).toBeNull();
	});
	it('keeps the usual offenders out of the first commit', () => {
		expect(gitignoreFor('node')).toContain('node_modules/');
		expect(gitignoreFor('python')).toContain('__pycache__/');
		for (const k of ['general', 'node', 'python'] as const) expect(gitignoreFor(k)).toContain('.env');
	});
});

describe('newRepoProblem', () => {
	const ok = defaultNewRepoParams('app', '/dev');
	it('is null for usable params', () => expect(newRepoProblem(ok, false)).toBeNull());
	it('names the first thing wrong', () => {
		expect(newRepoProblem({ ...ok, name: '///' }, false)).toMatch(/name/);
		expect(newRepoProblem({ ...ok, parentDir: '' }, false)).toMatch(/folder/);
		expect(newRepoProblem({ ...ok, branch: 'a b' }, false)).toMatch(/branch/);
	});
	it('refuses a remote when gh is absent, rather than failing after the repo is made', () => {
		expect(newRepoProblem({ ...ok, remote: 'private' }, false)).toMatch(/gh/);
		expect(newRepoProblem({ ...ok, remote: 'private' }, true)).toBeNull();
	});
});

describe('describeNewRepo', () => {
	it('says exactly where and what before anything is written', () => {
		const text = describeNewRepo({ ...defaultNewRepoParams('My App', path.resolve('/dev')), branch: 'trunk', remote: 'private' });
		expect(text).toContain(path.join(path.resolve('/dev'), 'My-App'));
		expect(text).toContain('"trunk"');
		expect(text).toContain('README.md, .gitignore, CLAUDE.md');
		expect(text).toMatch(/private GitHub repo "My-App"/);
	});
});

describe('createGitRepo with initial parameters', () => {
	let tmp = '';
	const saved: Record<string, string | undefined> = {};
	const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
	beforeAll(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wcc-newrepo-'));
		for (const [k, v] of Object.entries(ident)) { saved[k] = process.env[k]; process.env[k] = v; }
	});
	afterAll(() => {
		for (const k of Object.keys(ident)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
		fs.rmSync(tmp, { recursive: true, force: true });
	});
	const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

	it('commits the seed files on the chosen branch, so a worktree can branch from it', async () => {
		const p = { ...defaultNewRepoParams('Seeded', tmp), branch: 'trunk' };
		const r = await createGitRepo(tmp, p.name, { branch: p.branch, files: seedFiles(p) });
		expect(r).toMatchObject({ ok: true, committed: true, branch: 'trunk' });
		expect(git(r.path!, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trunk');
		expect(git(r.path!, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'CLAUDE.md', 'README.md']);
		// The load-bearing part: a worktree can be cut from it.
		git(r.path!, 'worktree', 'add', '-b', 'wt/1', path.join(tmp, 'wt1'), 'trunk');
		expect(fs.existsSync(path.join(tmp, 'wt1', 'CLAUDE.md'))).toBe(true);
	});
	it('two-argument call is unchanged: main, README only', async () => {
		const r = await createGitRepo(tmp, 'Plain');
		expect(r).toMatchObject({ ok: true, committed: true, branch: 'main' });
		expect(git(r.path!, 'ls-files')).toBe('README.md');
	});
	it('never writes into a folder that already exists, and keeps seed files inside the repo', async () => {
		fs.mkdirSync(path.join(tmp, 'Taken'));
		fs.writeFileSync(path.join(tmp, 'Taken', 'keep.txt'), 'mine');
		const r = await createGitRepo(tmp, 'Taken', { files: { 'x.txt': 'x' } });
		expect(r.ok).toBe(false);
		expect(fs.readdirSync(path.join(tmp, 'Taken'))).toEqual(['keep.txt']);
		const esc = await createGitRepo(tmp, 'Escape', { files: { '../outside.txt': 'no' } });
		expect(esc.ok).toBe(true);
		expect(fs.existsSync(path.join(tmp, 'outside.txt'))).toBe(false);
	});
	it('refuses a branch name git will not take instead of falling back to master', async () => {
		const r = await createGitRepo(tmp, 'BadBranch', { branch: 'a..b' });
		expect(r.ok).toBe(false);
	});
});
