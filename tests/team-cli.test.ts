import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main, parseTeamArgs, projectRepo, vaultRootOf, logBullets, projectKey, type TeamMetricsOutput } from '../src/cli/team-cli';
import type { RepoConfig } from '../src/terminals/terminals-grid';
import { makeTempDir } from './temp-dir';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } });
const tmp = () => { const d = makeTempDir('team-'); dirs.push(d); return d; };

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

describe('wcc-team — pure helpers', () => {
	it('parses metrics and its options, and refuses anything else', () => {
		expect(parseTeamArgs(['metrics', '--json', '--workspace', 'w'])).toEqual({ json: true, workspace: 'w' });
		expect(parseTeamArgs(['metrics', '--timing'])).toEqual({ json: false });
		expect(parseTeamArgs(['report'])).toMatch(/unknown command/);
		expect(parseTeamArgs(['metrics', '--workspace'])).toMatch(/needs a value/);
	});

	it('picks a workspace\'s repo by link, tag, name, then where its terminals work — never by toolbar habit', () => {
		const repos: RepoConfig[] = [
			{ name: 'worktree-command-center', path: '/dev/wcc' }, { name: 'Brain_2.0', path: '/dev/brain' },
			{ name: 'Music-Generation', path: '/dev/music' }, { name: 'tagged', path: '/dev/t', group: 'w-tag' },
		];
		expect(projectRepo({ id: 'x', name: 'x', repo: '/dev/brain' }, repos, [])!.from).toBe('link');
		expect(projectRepo({ id: 'w-tag', name: 'whatever' }, repos, [])).toMatchObject({ name: 'tagged', from: 'group' });
		expect(projectRepo({ id: 'b', name: 'Brain 2.0' }, repos, [])).toMatchObject({ name: 'Brain_2.0', from: 'name' });
		expect(projectRepo({ id: 'm', name: 'Music Generation' }, repos, ['worktree-command-center'])).toMatchObject({ name: 'Music-Generation', from: 'name' });
		expect(projectRepo({ id: 'default', name: 'default' }, repos, ['worktree-command-center', 'worktree-command-center', 'Brain_2.0'])).toMatchObject({ name: 'worktree-command-center', from: 'sessions' });
		expect(projectRepo({ id: 'g', name: 'Groceries' }, repos, [])).toBeNull();
		expect(projectRepo({ id: 'g', name: 'Groceries' }, repos, ['Brain_2.0', 'worktree-command-center'])).toBeNull(); // a tie decides nothing
	});

	it('finds the vault from a role library', () => {
		expect(vaultRootOf('/v/Simon-Brain/_meta/agents', () => false)).toBe(path.resolve('/v/Simon-Brain'));
		expect(vaultRootOf(undefined, () => true)).toBeNull();
		expect(vaultRootOf('/v/x/roles', (p) => p === path.join(path.resolve('/v/x'), '.obsidian'))).toBe(path.resolve('/v/x'));
	});

	it('reads a vault log\'s top-level bullets, first sentence, bold and links dropped', () => {
		const text = ['---', 'type: reference', '---', '## Log', '', '- **Merged the harvest into `main`.** Seven commits.', '  more detail', '- Set [[Agent Custodian|the Custodian]] active', '  highlight:: yes', '  - nested, not a bullet of its own'].join('\n');
		expect(logBullets(text)).toEqual([
			{ text: 'Merged the harvest into `main`.', highlight: false },
			{ text: 'Set the Custodian active', highlight: true },
		]);
		expect(projectKey('Worktree Command Center')).toBe(projectKey('worktree-command-center'));
	});
});

describe('wcc-team metrics — end to end against a real repo', () => {
	it('measures, dedupes git across workspaces that share a repo, and prints its own cost', async () => {
		const root = tmp();
		const repo = path.join(root, 'app');
		fs.mkdirSync(repo);
		git(repo, 'init', '-q', '-b', 'main');
		fs.writeFileSync(path.join(repo, 'a'), '1'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
		git(repo, 'checkout', '-qb', 'wt/main-1');
		fs.writeFileSync(path.join(repo, 'b'), '1'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'work');
		git(repo, 'checkout', '-q', 'main');
		git(repo, 'merge', '-q', '--no-ff', 'wt/main-1', '-m', 'Merge wt/main-1: the work');
		git(repo, 'tag', 'v1.0.0');

		const userData = path.join(root, 'ud');
		fs.mkdirSync(path.join(userData, '.coordination', 'w1'), { recursive: true });
		fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
			repos: [{ name: 'app', path: repo }],
			workspaces: [{ id: 'w1', name: 'One', repo }, { id: 'w2', name: 'Two', repo }, { id: 'w3', name: 'Groceries' }],
		}));
		fs.writeFileSync(path.join(userData, '.coordination', 'w1', 'workstreams.jsonl'), JSON.stringify({ v: 1, ev: 'open', ts: Date.now() - 3600_000, id: 'ws-1', title: 'Metrics', by: 's' }) + '\n');

		let out = '';
		let err = '';
		const code = await main(['metrics', '--json', '--user-data', userData], { out: (s) => { out += s; }, err: (s) => { err += `${s}\n`; } });
		expect(code).toBe(0);
		const o = JSON.parse(out) as TeamMetricsOutput;
		expect(o.workspaces.map((w) => w.workspaceId)).toEqual(['w1', 'w2', 'w3']);

		// git ran once per repo — two calls — however many workspaces share it
		expect(o.timing.repos).toBe(1);
		expect(o.timing.gitCalls.map((c) => c.args[0])).toEqual(['for-each-ref', 'log']);
		expect(o.timing.gitCalls.every((c) => c.code === 0 && c.ms >= 0)).toBe(true);
		expect(err).toMatch(/^wcc-team: 3 workspaces, 1 repo · wall \d+ ms \(process \d+ ms\) · 2 git calls, \d+ ms summed/);

		const [w1, , w3] = o.workspaces;
		const m1 = Object.fromEntries(w1!.metrics.map((m) => [m.id, m]));
		expect(m1['lead-time']!.label).toMatch(/proxy\) · median of 1 merges/);
		expect(m1['lead-time']!.value).not.toBeNull();
		expect(m1.highlights!.value).toBe('v1.0.0');
		expect(m1['open-work']).toMatchObject({ value: 1, unit: 'open' });
		expect(w1!.openWork[0]).toMatchObject({ id: 'ws-1', title: 'Metrics' });
		expect(w1!.updates.map((u) => u.kind)).toEqual(expect.arrayContaining(['merge', 'release', 'workstream']));

		// no repo: the git rows say so, and nothing is a zero standing in for it
		const m3 = Object.fromEntries(w3!.metrics.map((m) => [m.id, m]));
		expect(m3['lead-time']!.unavailable).toMatch(/^no repo/);
		expect(m3.suggestions!.unavailable).toBe('vault not configured');
		for (const m of w3!.metrics) if (m.value === 0) throw new Error(`${m.id} is 0 with no source to have measured it`);
	});

	it('one workspace only, and a usage error for an unknown one', async () => {
		const ud = tmp();
		fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ repos: [], workspaces: [{ id: 'a', name: 'A' }] }));
		let err = '';
		expect(await main(['metrics', '--workspace', 'nope', '--user-data', ud], { out: () => {}, err: (s) => { err += s; } })).toBe(64);
		expect(err).toMatch(/no workspace "nope" — a/);
		let out = '';
		expect(await main(['metrics', '--workspace', 'a', '--user-data', ud], { out: (s) => { out += `${s}\n`; }, err: () => {} })).toBe(0);
		expect(out).toMatch(/^A \(a\) · personal · no repo/);
		expect(out).toMatch(/unavailable · no repo/);
	});
});
