import { describe, it, expect } from 'vitest';
import { ensureSessionIds, restoreIdentity, newIdentity, identityFields, mintSessionId, parseRecordLineage, readLineage } from '../src/terminals/lineage';
import { godRecords, godIndexOf } from '../src/terminals/god-sessions';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseOutboxMessage, spawnExtrasOf } from '../src/terminals/god';
import { sanitizeSessionEnv } from '../src/terminals/session-env';
import { runSpawn, accepted } from './spawn-harness';
import { sessionRoleSlug } from '../src/terminals/role-library';
import { isParentSessionVar } from '../src/terminals/session-env';
const store = require('../pty-sidecar/coord-store.cjs');

/** A counter-backed mint, so a test can see exactly how many ids were created. */
function countingMint(): { mint: () => string; count: () => number } {
	let n = 0;
	return { mint: () => `sess-${++n}`, count: () => n };
}

/** What a terminal record looks like on disk (terminals-grid.ts SessionRecord). */
const terminalRec = (over: Record<string, unknown> = {}) => ({
	kind: 'terminal', worktreePath: 'C:/r/.claude-worktrees/wt-main-1', branch: 'wt/main-1',
	repoName: 'r', repoPath: 'C:/r', baseBranch: 'main', name: 'one', ...over,
});

/** The trip a session makes across a restart: restoreRecord reads the identity off the record,
 *  the tile carries it, persist writes the tile's record (identityFields), the file is JSON. */
function restartOnce<T extends { kind?: string; sessionId?: unknown }>(recs: T[], mint: () => string): T[] {
	const loaded = ensureSessionIds(JSON.parse(JSON.stringify(recs)) as T[], mint).records;
	const written = loaded.map((r) => (r.kind === 'journal' ? r : { ...r, ...identityFields(restoreIdentity(r, mint)) }));
	return JSON.parse(JSON.stringify(written)) as T[];
}

describe('sessionId (E6)', () => {
	it('a record round-trips save → restore with the SAME sessionId, across several restarts', () => {
		const { mint, count } = countingMint();
		const spawned = { ...terminalRec(), ...identityFields(newIdentity({}, mint)) };
		expect(spawned.sessionId).toBe('sess-1');
		let recs = [spawned];
		for (let i = 0; i < 3; i++) recs = restartOnce(recs, mint);
		expect(recs[0]!.sessionId).toBe('sess-1');
		expect(count()).toBe(1); // minted at spawn, never again
	});

	it('restoreIdentity reads the record, it does not re-mint', () => {
		const { mint, count } = countingMint();
		expect(restoreIdentity({ sessionId: 'abc' }, mint)).toEqual({ sessionId: 'abc' });
		expect(count()).toBe(0);
	});

	it('an older build\'s record (no sessionId) gets one on load, once', () => {
		const { mint, count } = countingMint();
		const old = [terminalRec(), terminalRec({ worktreePath: 'C:/r/x', name: 'two' })];
		const first = ensureSessionIds(old, mint);
		expect(first.minted).toBe(2);
		expect(first.records.map((r) => r.sessionId)).toEqual(['sess-1', 'sess-2']);
		expect(old[0]).not.toHaveProperty('sessionId'); // input untouched
		// The healed file, loaded again: nothing new is minted.
		const second = ensureSessionIds(JSON.parse(JSON.stringify(first.records)), mint);
		expect(second.minted).toBe(0);
		expect(second.records.map((r: { sessionId?: unknown }) => r.sessionId)).toEqual(['sess-1', 'sess-2']);
		expect(count()).toBe(2);
	});

	it('folder sessions sharing a path still get distinct ids', () => {
		const { mint } = countingMint();
		const same = terminalRec({ folder: true, worktreePath: 'C:/vault', branch: '' });
		const { records } = ensureSessionIds([same, { ...same }], mint);
		expect(records[0]!.sessionId).not.toBe(records[1]!.sessionId);
	});

	it('journals are not sessions and get no id; junk ids are replaced', () => {
		const { mint } = countingMint();
		const { records, minted } = ensureSessionIds([{ kind: 'journal' }, terminalRec({ sessionId: '  ' }), terminalRec({ sessionId: 7 })], mint);
		expect(records[0]).not.toHaveProperty('sessionId');
		expect(records.slice(1).map((r) => r.sessionId)).toEqual(['sess-1', 'sess-2']);
		expect(minted).toBe(2);
	});

	it('Kane consoles keep their sessionId through godRecords → restore', () => {
		const ids = new Map([[1, 'kane-primary'], [3, 'kane-3']]);
		const recs = JSON.parse(JSON.stringify(godRecords(true, [3], ids))) as Array<{ godIndex?: number; sessionId?: string }>;
		expect(recs.map((r) => [godIndexOf(r), restoreIdentity(r).sessionId])).toEqual([[1, 'kane-primary'], [3, 'kane-3']]);
		// Without ids (an older caller) the records are exactly what they were.
		expect(godRecords(true, [3])).toEqual([
			{ kind: 'god', worktreePath: '', branch: '', repoName: 'god', repoPath: '', baseBranch: '' },
			{ kind: 'god', worktreePath: '', branch: '', repoName: 'god', repoPath: '', baseBranch: '', godIndex: 3 },
		]);
	});

	it('mintSessionId returns distinct uuids', () => {
		const a = mintSessionId(), b = mintSessionId();
		expect(a).toMatch(/^[0-9a-f-]{36}$/);
		expect(a).not.toBe(b);
	});
});

// ---- The spawn chain, end to end minus the window: cos-coord argv → god-outbox file →
// parseOutboxMessage → the extras the grid hands spawnFromName → the record the tile writes.

/** Run `cos-coord spawn …` as Kane, with a fake app accepting it, and return the request it sent. */
async function spawnViaCli(args: string[], extraEnv: Record<string, string> = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-'));
	const env = { ...sanitizeSessionEnv(process.env), COS_COORD_DIR: dir, COS_TERMINAL_ID: '0', COS_TERMINAL_NAME: 'Kane', COS_ROLE: 'god', COS_COORD_SPAWN_WAIT_MS: '10000', ...extraEnv };
	const run = await runSpawn(dir, args, env, accepted());
	expect(run.code).toBe(0);
	const raw = run.request!;
	const msg = parseOutboxMessage(JSON.stringify(raw));
	if (!msg || msg.kind !== 'spawn') throw new Error(`not a spawn: ${JSON.stringify(raw)}`);
	return { raw, msg };
}

describe('spawn --workstream', () => {
	it('reaches the spawned session\'s record, and survives a restore', async () => {
		const { raw, msg } = await spawnViaCli(['app', '--task', 'do X', '--workstream', 'ws-12']);
		expect(raw.workstream).toBe('ws-12');
		const extras = spawnExtrasOf(msg);
		expect(extras).toEqual({ workstreamId: 'ws-12' });
		const rec = JSON.parse(JSON.stringify(identityFields(newIdentity(extras))));
		expect(restoreIdentity(rec)).toMatchObject({ workstreamId: 'ws-12' });
	});

	it('omitted, it is null in the request and absent from the record', async () => {
		const { raw, msg } = await spawnViaCli(['app', '--task', 'do X']);
		expect(raw.workstream).toBeNull();
		expect(identityFields(newIdentity(spawnExtrasOf(msg)))).not.toHaveProperty('workstreamId');
	});
});

describe('lineage fields on the record', () => {
	it('parentSessionId and workstreamId round-trip; blanks are dropped, not written', () => {
		const id = newIdentity({ parentSessionId: 'kane-1', workstreamId: 'ws-1' }, () => 's-1');
		const back = restoreIdentity(JSON.parse(JSON.stringify(identityFields(id))));
		expect(back).toEqual({ sessionId: 's-1', parentSessionId: 'kane-1', workstreamId: 'ws-1' });
		expect(identityFields(newIdentity({ parentSessionId: ' ', workstreamId: '' }, () => 's-2'))).toEqual({ sessionId: 's-2' });
	});
});

describe('spawn --role (E4)', () => {
	it('reaches the tile\'s resolved role slug, and the record keeps it', async () => {
		const { raw, msg } = await spawnViaCli(['app', '--task', 'research X', '--role', 'researcher']);
		expect(raw.role).toBe('researcher');
		const extras = spawnExtrasOf(msg);
		expect(extras.roleSlug).toBe('researcher');
		// What the tile resolves (terminal-tile sessionPrompt) for a spawned WORKTREE session.
		expect(sessionRoleSlug(extras.roleSlug, false)).toBe('researcher');
	});

	it('without --role a spawned worktree session is still a Worker Terminal, a folder one a Folder Terminal', async () => {
		const { raw, msg } = await spawnViaCli(['app', '--task', 'do X']);
		expect(raw.role).toBeNull();
		expect(sessionRoleSlug(spawnExtrasOf(msg).roleSlug, false)).toBe('worker-terminal');
		expect(sessionRoleSlug(undefined, true)).toBe('folder-terminal');
		expect(sessionRoleSlug('  ', false)).toBe('worker-terminal');
	});

	it('an unknown slug is passed through unvalidated — the role loader is what falls back', async () => {
		const { msg } = await spawnViaCli(['app', '--task', 'x', '--role', 'no-such-role']);
		expect(sessionRoleSlug(spawnExtrasOf(msg).roleSlug, false)).toBe('no-such-role');
	});
});

describe('from on outbox requests (E5)', () => {
	it('a spawn request carries its sender\'s COS_SESSION_ID, and it becomes the child\'s parentSessionId', async () => {
		const { raw, msg } = await spawnViaCli(['app', '--task', 'do X'], { COS_SESSION_ID: 'kane-sess-1' });
		expect(raw.from).toBe('kane-sess-1');
		expect(msg.from).toBe('kane-sess-1');
		const child = restoreIdentity(JSON.parse(JSON.stringify(identityFields(newIdentity(spawnExtrasOf(msg))))));
		expect(child.parentSessionId).toBe('kane-sess-1');
	});

	it('with no COS_SESSION_ID, from is null and the child has no parent', async () => {
		const { raw, msg } = await spawnViaCli(['app', '--task', 'do X']);
		expect(raw.from).toBeNull();
		expect(spawnExtrasOf(msg)).not.toHaveProperty('parentSessionId');
	});

	it('every outbox request kind carries from', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'from-'));
		store.tell(dir, 'A', 'hi', 's1');
		store.watch(dir, 'A', 'n', 's1');
		store.spawn(dir, 'app', '', 'x', '', '', '', { from: 's1' });
		store.rename(dir, 'A', 'B', 's1');
		store.close(dir, 'A', 's1');
		store.personality(dir, 's1');
		store.newTab(dir, { name: 't' }, 's1');
		const out = path.join(dir, 'god-outbox');
		const msgs = fs.readdirSync(out).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')));
		expect(msgs).toHaveLength(7);
		expect(msgs.every((m) => m.from === 's1')).toBe(true);
	});

	it('COS_SESSION_ID is never inherited from the app\'s environment', () => {
		// session-env strips every COS_*; each spawn path sets its own. A tile that inherited the
		// overseer's id would attribute its own spawns to Kane.
		expect(isParentSessionVar('COS_SESSION_ID')).toBe(true);
	});
});

describe('v2.recordLineage', () => {
	it('defaults on; only an explicit false turns it off', () => {
		expect(parseRecordLineage(undefined)).toBe(true);
		expect(parseRecordLineage({})).toBe(true);
		expect(parseRecordLineage('junk')).toBe(true);
		expect(parseRecordLineage({ recordLineage: 'no' })).toBe(true);
		expect(parseRecordLineage({ recordLineage: true })).toBe(true);
		expect(parseRecordLineage({ recordLineage: false })).toBe(false);
	});

	it('off: the fields are still WRITTEN, and simply not read', async () => {
		const off = parseRecordLineage({ recordLineage: false });
		// The whole write path, unchanged by the setting: CLI → outbox → extras → record → disk.
		const { msg } = await spawnViaCli(['app', '--task', 'x', '--workstream', 'ws-9'], { COS_SESSION_ID: 'kane-1' });
		const onDisk = JSON.parse(JSON.stringify(identityFields(newIdentity(spawnExtrasOf(msg)))));
		expect(onDisk).toMatchObject({ parentSessionId: 'kane-1', workstreamId: 'ws-9' });
		// ...and survives a restore with the setting off, so turning it back on finds it intact.
		const restored = restoreIdentity(onDisk);
		expect(restored).toMatchObject({ parentSessionId: 'kane-1', workstreamId: 'ws-9' });
		// The reader sees nothing while it is off, everything once it is back on.
		expect(readLineage(restored, off)).toEqual({});
		expect(readLineage(restored, true)).toEqual({ parentSessionId: 'kane-1', workstreamId: 'ws-9' });
	});
});
