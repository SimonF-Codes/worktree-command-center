import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathKind, instantiateRepo, probeGitIdentity } from '../src/instantiate-repo';
import { createGitRepo } from '../src/create-repo';
import { defaultNewRepoParams } from '../src/new-repo-params';
import { NO_IDENTITY_REASON, isMissingIdentity } from '../src/new-tab';

// Every git these tests start reads only what is set here: no global or system config, so the
// machine's own identity can neither rescue nor break a case.
const GIT_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
	'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
let saved: Record<string, string | undefined>;
let tmp: string;

function isolateGit(identity: boolean): void {
	const cfg = path.join(tmp, 'gitconfig');
	fs.writeFileSync(cfg, '');
	Object.assign(process.env, { GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' });
	if (identity) {
		Object.assign(process.env, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });
	} else {
		// No identity anywhere, and no guessing one from the hostname either (which succeeds on
		// some machines): the state of a fresh install.
		Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true' });
	}
}

beforeEach(() => {
	saved = Object.fromEntries(GIT_KEYS.map((k) => [k, process.env[k]]));
	for (const k of GIT_KEYS) delete process.env[k];
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'newtab-'));
});
afterEach(() => {
	for (const k of GIT_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('pathKind', () => {
	it('tells missing, empty, content and file apart', () => {
		fs.mkdirSync(path.join(tmp, 'empty'));
		fs.mkdirSync(path.join(tmp, 'full'));
		fs.writeFileSync(path.join(tmp, 'full', 'x'), '');
		fs.writeFileSync(path.join(tmp, 'file'), '');
		expect(pathKind(path.join(tmp, 'nope'))).toBe('missing');
		expect(pathKind(path.join(tmp, 'empty'))).toBe('empty');
		expect(pathKind(path.join(tmp, 'full'))).toBe('nonempty');
		expect(pathKind(path.join(tmp, 'file'))).toBe('file');
	});
});

describe('instantiateRepo (temp fixtures, real git)', () => {
	it('with an identity: one commit holding README + seeds, on the asked-for branch', async () => {
		isolateGit(true);
		const p = { ...defaultNewRepoParams('My Site', tmp), branch: 'trunk', gitignore: 'node' as const };
		const r = await instantiateRepo(p, null);
		expect(r).toMatchObject({ ok: true, committed: true, branch: 'trunk', path: path.join(tmp, 'My-Site'), remote: { state: 'none' } });
		const git = (...a: string[]): string => execFileSync('git', a, { cwd: r.path!, encoding: 'utf8' }).trim();
		expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('trunk');
		expect(git('ls-files').split('\n').sort()).toEqual(['.gitignore', 'CLAUDE.md', 'README.md']);
	}, 30000);

	it('a remote asked for without gh is skipped, and the repo is still made', async () => {
		isolateGit(true);
		const r = await instantiateRepo({ ...defaultNewRepoParams('withremote', tmp), remote: 'private' }, null);
		expect(r).toMatchObject({ ok: true, committed: true, remote: { state: 'no-gh' } });
	}, 30000);

	it('with no identity: refuses before writing anything', async () => {
		isolateGit(false);
		expect(await probeGitIdentity(tmp)).toBe('missing');
		const r = await instantiateRepo(defaultNewRepoParams('nobody', tmp), null);
		expect(r).toEqual({ ok: false, error: NO_IDENTITY_REASON, committed: false, remote: { state: 'none' } });
		expect(fs.existsSync(path.join(tmp, 'nobody'))).toBe(false);
	}, 30000);

	it('a conditional include makes the probe inconclusive, so the commit decides', async () => {
		isolateGit(false);
		fs.appendFileSync(process.env.GIT_CONFIG_GLOBAL!, `[includeIf "gitdir:${tmp.replace(/\\/g, '/')}/"]\n\tpath = nowhere\n`);
		expect(await probeGitIdentity(tmp)).toBe('unknown');
	}, 30000);

	it('createGitRepo reports why the initial commit failed', async () => {
		isolateGit(false);
		const r = await createGitRepo(tmp, 'nocommit');
		expect(r).toMatchObject({ ok: true, committed: false });
		expect(isMissingIdentity(r.commitError ?? '')).toBe(true);
	}, 30000);

	it('never writes into an existing folder', async () => {
		isolateGit(true);
		fs.mkdirSync(path.join(tmp, 'taken'));
		const r = await instantiateRepo(defaultNewRepoParams('taken', tmp), null);
		expect(r).toMatchObject({ ok: false, error: '"taken" already exists in that folder.' });
	}, 30000);
});
