import { describe, it, expect } from 'vitest';
import { ensureSessionIds, restoreIdentity, newIdentity, identityFields, mintSessionId } from '../src/terminals/lineage';
import { godRecords, godIndexOf } from '../src/terminals/god-sessions';

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
		const spawned = { ...terminalRec(), ...identityFields(newIdentity(mint)) };
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
