import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
	parseNewTabFields, newRepoRefusal, planNewTab, isMissingIdentity, newTabSummary, uncommittedReason,
	GH_MISSING_WARNING, type NewTabFields, type NewTabFacts, type PathKind, type NewTabResult,
} from '../src/new-tab';
import { defaultNewRepoParams } from '../src/new-repo-params';
import { identityVerdict, remoteWarning } from '../src/instantiate-repo';
import { parseConnectors, parseConnectorRequest, evaluateConnectorRequest } from '../src/terminals/connectors';
import { parseOutboxMessage } from '../src/terminals/god';
import type { RepoConfig } from '../src/terminals/terminals-grid';

const DEV = path.resolve('/dev');
const at = (...p: string[]): string => path.join(DEV, ...p);

const fields = (o: Partial<NewTabFields> = {}): NewTabFields => ({
	name: 'Site', repo: null, newRepo: null, parent: null, base: null, gitignore: null, claudeMd: null, remote: null, ...o,
});

/** A floor: two git targets that share a name (as finessedbymannix-site does on Simon's machine),
 *  one grouped to another tab, one plain target, one whose folder is gone. */
const REPOS: RepoConfig[] = [
	{ name: 'app', path: at('app') },
	{ name: 'finessedbymannix-site', path: at('finessedbymannix-site') },
	{ name: 'finessedbymannix-site', path: at('old', 'finessedbymannix-site') },
	{ name: 'private-thing', path: at('private-thing'), group: 'other-tab' },
	{ name: 'gone', path: at('gone') },
];

function facts(disk: Record<string, PathKind> = {}, o: Partial<NewTabFacts> = {}): NewTabFacts {
	const known: Record<string, PathKind> = { [DEV]: 'nonempty', [at('app')]: 'nonempty', [at('finessedbymannix-site')]: 'nonempty', [at('old', 'finessedbymannix-site')]: 'nonempty', [at('private-thing')]: 'nonempty', ...disk };
	return { repos: REPOS, pathKind: (p) => known[path.resolve(p)] ?? 'missing', defaultParent: DEV, ghAvailable: true, ...o };
}

describe('parseNewTabFields — every refusal, in the documented order', () => {
	const reason = (o: Record<string, unknown>): string | null => { const r = parseNewTabFields(o); return r.ok ? null : r.reason; };

	it('needs a tab name, of bounded length', () => {
		expect(reason({})).toBe('malformed new-tab request — "name" (the tab name) is required');
		expect(reason({ name: '   ' })).toContain('"name"');
		expect(reason({ name: 'x'.repeat(81) })).toBe('tab name is too long (81 chars, max 80)');
	});
	it('refuses repo AND newRepo', () => {
		expect(reason({ name: 'a', repo: 'app', newRepo: 'b' })).toContain('mutually exclusive');
	});
	it('refuses a creation parameter sent beside an existing target, rather than ignoring it', () => {
		expect(reason({ name: 'a', repo: 'app', remote: 'private' })).toBe('"remote" only applies when creating a repo — it was sent with "repo" (an existing target)');
		expect(reason({ name: 'a', repo: 'app', claudeMd: false })).toContain('"claudeMd" only applies');
		expect(reason({ name: 'a', repo: 'app', parent: null, base: null })).toBeNull();
	});
	it('checks the enums, the boolean, the parent and the branch', () => {
		expect(reason({ name: 'a', gitignore: 'rust' })).toBe('invalid gitignore "rust". Valid: general, node, python, none');
		expect(reason({ name: 'a', remote: 'internal' })).toBe('invalid remote "internal". Valid: none, private, public');
		expect(reason({ name: 'a', claudeMd: 'yes' })).toBe('"claudeMd" must be true, false or null');
		expect(reason({ name: 'a', parent: 'relative/dir' })).toBe('parent "relative/dir" is not an absolute path');
		expect(reason({ name: 'a', base: 'bad..name' })).toBe('"bad..name" is not a valid git branch name');
	});
	it('needs something to name a folder after', () => {
		expect(reason({ name: '!!!' })).toContain('pass "newRepo"');
		expect(reason({ name: 'ok', newRepo: '///' })).toBe('repo name "///" has no letter or number to make a folder name from');
		expect(reason({ name: '!!!', repo: 'app' })).toBeNull(); // an existing target needs no folder name
	});
	it('normalizes to nulls', () => {
		expect(parseNewTabFields({ name: ' Site ', gitignore: 'node', claudeMd: false })).toEqual({ ok: true, fields: fields({ gitignore: 'node', claudeMd: false }) });
	});
});

describe('planNewTab — an existing target', () => {
	it('binds case-insensitively', () => {
		expect(planNewTab(fields({ repo: 'APP' }), facts())).toEqual({ ok: true, kind: 'existing', repo: REPOS[0] });
	});
	it('refuses an unknown one with the known list', () => {
		const r = planNewTab(fields({ repo: 'ghost' }), facts());
		expect(r).toEqual({ ok: false, reason: expect.stringContaining('unknown repo "ghost". Known: app, finessedbymannix-site') });
	});
	it('refuses a name two checkouts share, naming both paths', () => {
		const r = planNewTab(fields({ repo: 'finessedbymannix-site' }), facts());
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toContain('is ambiguous — 2 registered targets');
			expect(r.reason).toContain(at('old', 'finessedbymannix-site'));
		}
	});
	it('refuses a target grouped to another tab, and one whose folder is gone', () => {
		expect(planNewTab(fields({ repo: 'private-thing' }), facts())).toMatchObject({ ok: false, reason: expect.stringContaining('belongs to the tab "other-tab"') });
		expect(planNewTab(fields({ repo: 'gone' }), facts())).toMatchObject({ ok: false, reason: expect.stringContaining('that folder no longer exists') });
	});
});

describe('planNewTab — a new repo', () => {
	it('defaults to the form\'s own defaults, named after the tab, beside the last repo', () => {
		expect(planNewTab(fields(), facts())).toEqual({ ok: true, kind: 'new', params: defaultNewRepoParams('Site', DEV), warnings: [] });
	});
	it('takes every initial parameter', () => {
		const r = planNewTab(fields({ newRepo: 'api', parent: at('work'), base: 'trunk', gitignore: 'python', claudeMd: false, remote: 'public' }), facts({ [at('work')]: 'empty' }));
		expect(r).toEqual({ ok: true, kind: 'new', warnings: [], params: { name: 'api', parentDir: at('work'), branch: 'trunk', gitignore: 'python', claudeMd: false, remote: 'public' } });
	});
	it('without gh, degrades the remote to none and says so — it never fails the creation', () => {
		const r = planNewTab(fields({ remote: 'private' }), facts({}, { ghAvailable: false }));
		expect(r).toMatchObject({ ok: true, kind: 'new', params: { remote: 'none' }, warnings: [GH_MISSING_WARNING] });
		expect(GH_MISSING_WARNING).toContain('WinGet\\Packages\\GitHub.cli_*\\bin');
	});
	it('refuses with no parent to go in', () => {
		expect(planNewTab(fields(), facts({}, { defaultParent: '' }))).toEqual({ ok: false, reason: 'no parent folder — pass "parent"; no repo is registered yet to put a new one beside' });
	});
	it('refuses a name already on the floor, case-insensitively, even one grouped elsewhere', () => {
		expect(planNewTab(fields({ newRepo: 'App' }), facts())).toMatchObject({ ok: false, reason: expect.stringContaining('a target named "app" is already registered') });
		expect(planNewTab(fields({ newRepo: 'private-thing' }), facts())).toMatchObject({ ok: false, reason: expect.stringContaining('already registered') });
	});
	it('refuses an existing target folder: with content, empty, or a file', () => {
		expect(planNewTab(fields(), facts({ [at('Site')]: 'nonempty' }))).toMatchObject({ ok: false, reason: expect.stringContaining('already exists and has content') });
		expect(planNewTab(fields(), facts({ [at('Site')]: 'empty' }))).toMatchObject({ ok: false, reason: expect.stringContaining('already exists (empty)') });
		expect(planNewTab(fields(), facts({ [at('Site')]: 'file' }))).toMatchObject({ ok: false, reason: expect.stringContaining('already exists as a file') });
	});
	it('refuses a parent that is missing or a file', () => {
		expect(planNewTab(fields({ parent: at('nope') }), facts())).toMatchObject({ ok: false, reason: expect.stringContaining('does not exist — create it first') });
		expect(planNewTab(fields({ parent: at('f') }), facts({ [at('f')]: 'file' }))).toMatchObject({ ok: false, reason: expect.stringContaining('is a file, not a folder') });
	});
	it('checks the name before the folders', () => {
		const r = planNewTab(fields({ newRepo: 'app', parent: at('nope') }), facts());
		expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('already registered') });
	});
});

describe('newRepoRefusal is what the 🆕 form refuses too', () => {
	it('allows a fresh name in a real folder', () => {
		expect(newRepoRefusal(defaultNewRepoParams('fresh', DEV), facts())).toBeNull();
	});
});

describe('git identity and remotes', () => {
	const NO_ID = 'Author identity unknown\n\n*** Please tell me who you are.\nfatal: unable to auto-detect email address';
	it('recognizes git\'s own complaint', () => {
		expect(isMissingIdentity(NO_ID)).toBe(true);
		expect(isMissingIdentity('fatal: not a git repository')).toBe(false);
	});
	it('is only conclusive without conditional includes', () => {
		expect(identityVerdict([{ code: 0, output: '' }, { code: 0, output: '' }], false)).toBe('ok');
		expect(identityVerdict([{ code: 128, output: NO_ID }, { code: 0, output: '' }], false)).toBe('missing');
		expect(identityVerdict([{ code: 128, output: NO_ID }], true)).toBe('unknown');
		expect(identityVerdict([{ code: 1, output: 'something else' }], false)).toBe('ok'); // not ours to judge — the commit will
	});
	it('words each remote outcome that needs a warning', () => {
		expect(remoteWarning({ state: 'none' })).toBeNull();
		expect(remoteWarning({ state: 'created', url: 'https://github.com/x/y' })).toBeNull();
		expect(remoteWarning({ state: 'no-gh' })).toBe(GH_MISSING_WARNING);
		expect(remoteWarning({ state: 'failed', error: 'not logged in' })).toContain('the GitHub remote failed: not logged in');
		expect(remoteWarning({ state: 'no-commit' })).toContain('no commit to push');
	});
	it('a missing initial commit is loud and says how to recover', () => {
		const r = uncommittedReason(at('Site'), 'Site', 'Site', 'Author identity unknown');
		expect(r).toContain('no tab was made');
		expect(r).toContain('new-tab "Site" --repo Site');
	});
});

describe('newTabSummary', () => {
	const res: NewTabResult = { workspaceId: 'site', tab: 'Site', repo: 'Site', repoPath: at('Site'), branch: 'main', created: true, coordDir: 'c', remoteUrl: null, warnings: [] };
	it('names the asker, the tab and the repo', () => {
		expect(newTabSummary(res, 'Kane')).toBe(`Kane opened tab "Site" on a new repo Site (${at('Site')}, branch main)`);
		expect(newTabSummary({ ...res, created: false, branch: null })).toBe(`opened tab "Site" on Site (${at('Site')})`);
	});
});

describe('the channels carry new-tab', () => {
	const env = { v: 1, id: 'r1', connector: 'brain-2-0', sentMs: 1, kind: 'new-tab' };
	it('god-outbox passes the body through for the app to validate', () => {
		expect(parseOutboxMessage(JSON.stringify({ kind: 'new-tab', name: 'x' }))).toEqual({ kind: 'new-tab', request: { kind: 'new-tab', name: 'x' } });
	});
	it('connector config keeps only known grants', () => {
		expect(parseConnectors([{ id: 'a', label: 'A', grants: ['new-tab', 'root'] }, { id: 'b', label: 'B' }])).toEqual([
			{ id: 'a', label: 'A', grants: ['new-tab'] }, { id: 'b', label: 'B' },
		]);
	});
	it('a connector request validates the same fields', () => {
		expect(parseConnectorRequest(JSON.stringify({ ...env, name: 'x', gitignore: 'rust' }))).toEqual({ ok: false, id: 'r1', reason: 'invalid gitignore "rust". Valid: general, node, python, none' });
		expect(parseConnectorRequest(JSON.stringify({ ...env, kind: 'watch' }))).toMatchObject({ reason: 'kind "watch" is not permitted for connectors — only "spawn", "tell" or "new-tab" is' });
	});
	it('registration is checked before the grant, and the grant before anything the app knows', () => {
		const text = JSON.stringify({ ...env, name: 'x', repo: 'app' });
		const base = { connectorId: 'brain-2-0', knownRepoNames: ['app'] };
		expect(evaluateConnectorRequest(text, { ...base, registeredConnectorIds: [], grants: ['new-tab'] })).toMatchObject({ status: 'rejected', reason: 'connector "brain-2-0" is not registered' });
		expect(evaluateConnectorRequest(text, { ...base, registeredConnectorIds: ['brain-2-0'] })).toMatchObject({ status: 'rejected', reason: expect.stringContaining('is not granted "new-tab"') });
		expect(evaluateConnectorRequest(text, { ...base, registeredConnectorIds: ['brain-2-0'], grants: ['new-tab'] })).toMatchObject({ status: 'accepted', request: { kind: 'new-tab', fields: { name: 'x', repo: 'app' } } });
	});
});
