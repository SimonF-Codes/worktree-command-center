import { describe, it, expect } from 'vitest';
import { godIndexOf, godRecords, highestGodIndex, PRIMARY_GOD_INDEX } from '../src/terminals/god-sessions';

/** What persist() writes, fed back to what restoreRecord() reads. */
function roundTrip(hasPrimary: boolean, extras: number[]): Array<number | 'primary'> {
	return godRecords(hasPrimary, extras).map((r) => {
		const idx = godIndexOf(r);
		return idx === PRIMARY_GOD_INDEX ? 'primary' : idx;
	});
}

describe('godIndexOf', () => {
	it('reads a record with no godIndex as the primary (back-compat)', () => {
		// Every god record written before duplicates were persisted looks like this — it must keep
		// restoring the primary console, not a duplicate, or existing sessions break on upgrade.
		expect(godIndexOf({ kind: 'god' })).toBe(PRIMARY_GOD_INDEX);
	});

	it('reads a tagged record as that duplicate', () => {
		expect(godIndexOf({ kind: 'god', godIndex: 2 })).toBe(2);
		expect(godIndexOf({ kind: 'god', godIndex: 7 })).toBe(7);
	});

	it('falls back to the primary for unusable values', () => {
		for (const godIndex of [0, 1, -3, 2.5, NaN, undefined, '2' as unknown as number]) {
			expect(godIndexOf({ kind: 'god', godIndex })).toBe(PRIMARY_GOD_INDEX);
		}
	});
});

describe('godRecords', () => {
	it('writes the primary untagged and each duplicate with its number', () => {
		const recs = godRecords(true, [2, 3]);
		expect(recs.map((r) => r.godIndex)).toEqual([undefined, 2, 3]);
		expect(recs.every((r) => r.kind === 'god' && r.repoName === 'god')).toBe(true);
	});

	it('round-trips the primary plus its duplicates', () => {
		expect(roundTrip(true, [2, 3])).toEqual(['primary', 2, 3]);
	});

	it('round-trips duplicates with the primary closed', () => {
		expect(roundTrip(false, [4])).toEqual([4]);
	});

	it('restores an old single untagged record as the primary and nothing else', () => {
		expect(godRecords(true, []).map((r) => r.godIndex)).toEqual([undefined]);
		expect(roundTrip(true, [])).toEqual(['primary']);
	});

	it('writes nothing when no console is open', () => {
		expect(godRecords(false, [])).toEqual([]);
	});

	it('sorts and de-duplicates, and never emits a duplicate record for the primary', () => {
		expect(roundTrip(true, [3, 2, 3, 1, 0])).toEqual(['primary', 2, 3]);
	});
});

describe('highestGodIndex', () => {
	it('is the primary when there is nothing to claim', () => {
		expect(highestGodIndex([], [], 'brain-2-0')).toBe(PRIMARY_GOD_INDEX);
	});

	it('takes the highest persisted duplicate', () => {
		const recs = [{ kind: 'god' }, { kind: 'god', godIndex: 2 }, { kind: 'god', godIndex: 5 }];
		expect(highestGodIndex(recs, [], 'brain-2-0')).toBe(5);
	});

	it('ignores non-god records', () => {
		const recs = [{ kind: 'terminal', godIndex: 9 }, { kind: 'god', godIndex: 2 }];
		expect(highestGodIndex(recs, [], 'brain-2-0')).toBe(2);
	});

	it('claims a .god home that no record mentions', () => {
		// The bug that stranded the conversation: the record was never written, but
		// .god/brain-2-0-2 exists and holds a live transcript. The next duplicate must not take it.
		const dirs = ['brain-2-0', 'brain-2-0-2', 'brain-2-0-3'];
		expect(highestGodIndex([], dirs, 'brain-2-0')).toBe(3);
	});

	it('counts only this group\u2019s homes', () => {
		const dirs = ['brain-2-0', 'brain-2-0-2', 'other', 'other-9', 'brain-2-0-2-4'];
		expect(highestGodIndex([], dirs, 'brain-2-0')).toBe(2);   // other-9 and the nested group are not ours
		expect(highestGodIndex([], dirs, 'brain-2-0-2')).toBe(4); // …and that nested group owns -4
	});

	it('ignores homes with a non-numeric suffix', () => {
		expect(highestGodIndex([], ['brain-2-0-old', 'brain-2-0-'], 'brain-2-0')).toBe(PRIMARY_GOD_INDEX);
	});

	it('takes the max across records and directories', () => {
		expect(highestGodIndex([{ kind: 'god', godIndex: 6 }], ['brain-2-0-2'], 'brain-2-0')).toBe(6);
		expect(highestGodIndex([{ kind: 'god', godIndex: 2 }], ['brain-2-0-6'], 'brain-2-0')).toBe(6);
	});

	it('hands the next duplicate a number nobody owns', () => {
		const recs = [{ kind: 'god' }, { kind: 'god', godIndex: 2 }];
		const dirs = ['brain-2-0', 'brain-2-0-2', 'brain-2-0-3'];
		const next = highestGodIndex(recs, dirs, 'brain-2-0') + 1; // what addKane() claims
		expect(next).toBe(4);
		expect(dirs).not.toContain(`brain-2-0-${next}`);
	});
});
