import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { main, parseTeamArgs, parseTransfersArgs, parseTranscriptArgs, tailLines, projectRepo, vaultRootOf, logBullets, projectKey, TAIL_BYTES, type TeamMetricsOutput, type TeamTransfersOutput, type TeamTranscriptOutput } from '../src/cli/team-cli';
import { foldTransfers } from '../src/core/transfers';
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

describe('wcc-team transfers', () => {
	const OVERSEER = 'god-1';
	function floor(): { ud: string; sessions: Record<string, unknown[]>; done: string } {
		const ud = tmp();
		const done = path.join(ud, '.coordination', 'default', 'god-outbox', '.done');
		fs.mkdirSync(done, { recursive: true });
		fs.mkdirSync(path.join(ud, '.coordination', 'quiet'), { recursive: true }); // no requests: not listed
		const write = (ts: number, id: string, o: Record<string, unknown>) => fs.writeFileSync(path.join(done, `${ts}-${id}.json`), JSON.stringify({ ts, ...o }));
		write(1795000000000, 'old', { kind: 'spawn', repo: 'r', task: 'before from existed', name: 'Kid' });
		write(1795800000000, 'sp', { kind: 'spawn', repo: 'r', task: 'Build P5a\nthen report', name: 'Kid', role: 'worker-terminal', isolation: 'worktree', from: OVERSEER });
		write(1795800001000, 'tl', { kind: 'tell', target: 'Kid', message: 'rebase first', from: OVERSEER });
		write(1795800002000, 'gone', { kind: 'tell', target: 'Sidecar design', message: 'revision 2', from: OVERSEER });
		write(1795800003000, 'cl', { kind: 'close', target: 'Council: code', from: OVERSEER });
		const sessions = { default: [{ kind: 'god', sessionId: OVERSEER }, { kind: 'terminal', name: 'Kid', sessionId: 'kid-1', parentSessionId: OVERSEER }], other: [] };
		fs.writeFileSync(path.join(ud, '.terminal-sessions.json'), JSON.stringify(sessions));
		return { ud, sessions, done };
	}
	const run = async (argv: string[]) => {
		let out = '', err = '';
		const code = await main(argv, { out: (s) => { out += `${s}\n`; }, err: (s) => { err += `${s}\n`; }, now: () => 42 });
		return { code, out, err };
	};

	it('parses its options; metrics keeps its own parser', () => {
		expect(parseTransfersArgs(['--json', '--session', 's', '--workspace', 'w'])).toEqual({ json: true, session: 's', workspace: 'w' });
		expect(parseTransfersArgs(['--session'])).toMatch(/needs a value/);
		expect(parseTransfersArgs(['--timing'])).toMatch(/unknown option/);
		expect(parseTeamArgs(['transfers'])).toMatch(/unknown command/); // main dispatches before it
	});

	it('--json is foldTransfers over the same two files, in a fixed shape: what the tree will draw', async () => {
		const { ud, sessions, done } = floor();
		const r = await run(['transfers', '--json', '--user-data', ud]);
		expect(r.code).toBe(0);
		const o = JSON.parse(r.out) as TeamTransfersOutput;
		// The shape. A key added or dropped here is a change the tree has to agree to.
		expect(Object.keys(o).sort()).toEqual(['generatedAt', 'schema', 'session', 'workspaces']);
		expect(o).toMatchObject({ schema: 1, generatedAt: 42, session: null });
		expect(o.workspaces.map((w) => w.workspaceId)).toEqual(['default']);
		const w = o.workspaces[0]!;
		expect(Object.keys(w).sort()).toEqual(['fold', 'source', 'workspaceId']);
		expect(Object.keys(w.fold).sort()).toEqual(['counts', 'schema', 'skipped', 'transfers']);
		expect(Object.keys(w.fold.counts).sort()).toEqual(['byKind', 'byState', 'requests']);
		const spawn = w.fold.transfers.find((t) => t.id === '1795800000000-sp')!;
		expect(Object.keys(spawn).sort()).toEqual(['brief', 'delivery', 'drawn', 'from', 'id', 'kind', 'length', 'match', 'subject', 'toName', 'ts']);
		expect(Object.keys(w.fold.transfers.find((t) => t.kind === 'close')!).sort()).toEqual(['delivery', 'drawn', 'from', 'id', 'kind', 'length', 'match', 'subject', 'toName', 'ts']);
		// The same function: the CLI adds nothing and drops nothing.
		const files = fs.readdirSync(done).sort().map((file) => ({ file, text: fs.readFileSync(path.join(done, file), 'utf8') }));
		expect(w.fold).toEqual(foldTransfers({ requests: files, sessions: sessions.default! }));
		expect(w.fold.transfers.map((t) => [t.kind, t.match.state])).toEqual([
			['spawn', 'unattributed'], ['spawn', 'edge'], ['tell', 'edge'], ['tell', 'unmatched'], ['close', 'closed'],
		]);
	});

	it('prints the unmatched as unmatched, the close as not drawn, and the unattributed as a count', async () => {
		const { ud } = floor();
		const r = await run(['transfers', '--user-data', ud]);
		expect(r.code).toBe(0);
		expect(r.out).toMatch(/^default · 5 claimed requests in /);
		expect(r.out).toContain('2 spawn · 2 tell · 0 watch · 1 close · 1 sent before the sender was recorded (plain lineage, not listed)');
		expect(r.out).toMatch(/Z {2}spawn {2}overseer \(god-1\) → Kid \(kid-1\) {2}sent · on its edge · role worker-terminal · isolation worktree\n/);
		expect(r.out).toContain('      "Build P5a" (of 21 chars)');
		expect(r.out).toContain('tell   overseer (god-1) → "Sidecar design"  sent · UNMATCHED: no session on the floor is named "Sidecar design" now');
		expect(r.out).toContain('close  overseer (god-1) → "Council: code"  sent · folded, not drawn: the session it closed is gone');
		expect(r.out).toContain('2 on an edge · 1 unmatched (listed, never drawn, never guessed)');
		expect(r.out).toMatch(/Sent, not delivered/);
		expect(r.out).not.toContain('before from existed');
		expect(r.out).not.toMatch(/quiet/);
	});

	it('--session keeps what that session sent or received', async () => {
		const { ud } = floor();
		const kid = JSON.parse((await run(['transfers', '--json', '--session', 'kid-1', '--user-data', ud])).out) as TeamTransfersOutput;
		expect(kid.session).toBe('kid-1');
		expect(kid.workspaces[0]!.fold.transfers.map((t) => t.id)).toEqual(['1795800000000-sp', '1795800001000-tl']);
		const text = (await run(['transfers', '--session', 'kid-1', '--user-data', ud])).out;
		expect(text).toContain('sent or received by kid-1: 2');
		expect(text).not.toContain('Sidecar design');
	});

	it('an unknown workspace is a usage error; a missing coordination folder is a failure; a named empty one prints', async () => {
		const { ud } = floor();
		const bad = await run(['transfers', '--workspace', 'nope', '--user-data', ud]);
		expect(bad.code).toBe(64);
		expect(bad.err).toMatch(/no workspace "nope" — default, quiet/);
		expect((await run(['transfers', '--user-data', tmp()])).code).toBe(1);
		const quiet = await run(['transfers', '--workspace', 'quiet', '--user-data', ud]);
		expect(quiet.code).toBe(0);
		expect(quiet.out).toMatch(/^quiet · 0 claimed requests/);
	});
});

describe('wcc-team transcript', () => {
	const FIXTURE = path.join(__dirname, 'fixtures', 'transcripts', 'v2.1.332.jsonl');
	const run = async (argv: string[]) => {
		let out = '', err = '';
		const code = await main(argv, { out: (s) => { out += `${s}\n`; }, err: (s) => { err += `${s}\n`; }, now: () => 42 });
		return { code, out, err };
	};

	it('parses its options; --tail is required; the other verbs keep their own parsers', () => {
		expect(parseTranscriptArgs(['--tail', 'f.jsonl', '--json', '--bytes', '10', '--items', '0'])).toEqual({ json: true, file: 'f.jsonl', bytes: 10, items: 0 });
		expect(parseTranscriptArgs(['--tail', 'f.jsonl'])).toEqual({ json: false, file: 'f.jsonl', bytes: TAIL_BYTES, items: 40 });
		expect(parseTranscriptArgs([])).toMatch(/needs --tail/);
		expect(parseTranscriptArgs(['--tail'])).toMatch(/needs a value/);
		expect(parseTranscriptArgs(['--tail', 'f', '--bytes', '0'])).toMatch(/whole number above 0/);
		expect(parseTranscriptArgs(['--tail', 'f', '--items', '-1'])).toMatch(/whole number/);
		expect(parseTranscriptArgs(['--tail', 'f', '--follow'])).toMatch(/unknown option/);
		expect(parseTeamArgs(['transcript'])).toMatch(/unknown command/); // main dispatches before it
	});

	it('reads complete lines only: a window\'s partial first line is dropped, an unterminated last line held back', () => {
		const buf = Buffer.from('tail-of-a-line\n{"a":1}\r\n\n{"b":2}\n{"c":');
		expect(tailLines(buf, 100)).toEqual([{ at: 115, text: '{"a":1}' }, { at: 125, text: '{"b":2}' }]);
		expect(tailLines(buf, 0)[0]).toEqual({ at: 0, text: 'tail-of-a-line' });
		expect(tailLines(Buffer.from('no newline at all'), 5)).toEqual([]);
	});

	it('--json is normalise + foldItems over the window, in a fixed shape: what the Chat view will draw', async () => {
		const r = await run(['transcript', '--tail', FIXTURE, '--json', '--items', '0']);
		expect(r.code).toBe(0);
		const o = JSON.parse(r.out) as TeamTranscriptOutput;
		// The shape. A key added or dropped here is a change the panel has to agree to.
		expect(Object.keys(o).sort()).toEqual(['bytesRead', 'file', 'fromStart', 'generatedAt', 'items', 'itemsRead', 'lines', 'schema', 'size', 'skipped']);
		expect(o).toMatchObject({ schema: 1, generatedAt: 42, file: FIXTURE, fromStart: true, lines: 80, itemsRead: 11 });
		expect(o.size).toBe(fs.statSync(FIXTURE).size);
		expect(o.items.map((i) => i.kind)).toEqual(['prompt', 'tool', 'reply', 'tool', 'prompt', 'thinking', 'tool', 'thinking', 'tool', 'reply', 'tool']);
		expect(Object.keys(o.items.find((i) => i.kind === 'tool')!).sort()).toEqual(['id', 'input', 'kind', 'name', 'result', 'status', 'ts']);
		expect(Object.values(o.skipped).reduce((a, b) => a + b, 0)).toBe(64);
		expect(o.skipped['attachment/queued_command-meta']).toBeUndefined();
	});

	it('the text form is one line per item and ends with what it skipped, by label', async () => {
		const r = await run(['transcript', '--tail', FIXTURE, '--items', '3']);
		expect(r.code).toBe(0);
		const lines = r.out.trimEnd().split('\n');
		expect(lines[0]).toMatch(/· 80 lines in the last \d+ of \d+ bytes \(the whole file\) · 11 items, the last 3 shown$/);
		expect(lines).toHaveLength(5);
		expect(lines[1]).toMatch(/^\d\d:\d\d {4}\[Bash\] .* · done → /);
		expect(lines[4]).toMatch(/^skipped 64: api-request 6 · data-flow-records 6 · /);
	});

	it('a byte window starts at a line boundary, so a cut line is never half-parsed', async () => {
		const o = JSON.parse((await run(['transcript', '--tail', FIXTURE, '--json', '--bytes', '20000'])).out) as TeamTranscriptOutput;
		expect(o.fromStart).toBe(false);
		expect(o.bytesRead).toBe(20000);
		expect(o.lines).toBeLessThan(80);
		expect(o.skipped['(unparseable)']).toBeUndefined();
	});

	it('a missing file is a failure; no --tail is a usage error', async () => {
		const missing = await run(['transcript', '--tail', path.join(tmp(), 'nope.jsonl')]);
		expect(missing.code).toBe(1);
		expect(missing.err).toMatch(/cannot read .*nope\.jsonl/);
		const usage = await run(['transcript']);
		expect(usage.code).toBe(64);
		expect(usage.err).toMatch(/transcript needs --tail <file>/);
	});
});
