import { describe, it, expect } from 'vitest';
import {
	barFraction, splitMemory, machinePressure, splitLabel, splitDetail, warningState, gaugeFrom, gaugePending,
	UNATTRIBUTED_WARN_BYTES, UNATTRIBUTED_CRIT_BYTES, TOTAL_WARN_SHARE, TOTAL_CRIT_SHARE,
	FREE_WARN_BYTES, FREE_CRIT_BYTES,
} from '../src/terminals/memory-gauge';
import type { MemoryReport, MemoryRow } from '../src/terminals/session-memory';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const RAM = 32 * GB; // the machine this was built on: 31.1 GiB

/** Plenty of headroom, so a test about something else never trips the pressure tint. */
const FREE = 16 * GB;

/** A report with only the three numbers the gauge reads. */
function report(over: { total: number; unattributed?: number; sessions?: number }): MemoryReport {
	const sessions = Array.from({ length: over.sessions ?? 0 }, (_, i) => ({ key: `s${i}` } as unknown as MemoryRow));
	return {
		sessions,
		unattributed: { rssBytes: over.unattributed ?? 0, procCount: over.unattributed ? 3 : 0, pids: [] },
		appSelfBytes: 0,
		totalBytes: over.total,
	};
}

describe('barFraction', () => {
	it('is the share of physical RAM', () => {
		expect(barFraction(8 * GB, 32 * GB)).toBeCloseTo(0.25, 6);
	});
	it('clamps at a full bar rather than overflowing it', () => {
		expect(barFraction(64 * GB, 32 * GB)).toBe(1);
	});
	it('is empty, not NaN, when the denominator is unknown', () => {
		expect(barFraction(2 * GB, 0)).toBe(0);
		expect(barFraction(2 * GB, Number.NaN)).toBe(0);
		expect(barFraction(Number.NaN, RAM)).toBe(0);
	});
	it('is empty when nothing has been measured', () => {
		expect(barFraction(0, RAM)).toBe(0);
	});
});

describe('splitMemory', () => {
	// THE MEASUREMENT THAT PROMPTED THE REDESIGN, 2026-09-17: the old single-fill bar drew this
	// as 1.1/31 — a 3% bar on a machine with 12.9 GB free, reading as 30 GB of headroom.
	it('cuts the machine the way it was actually measured', () => {
		const s = splitMemory(31.1 * GB, 12.9 * GB, 1.1 * GB);
		expect(s.appBytes / GB).toBeCloseTo(1.1, 6);
		expect(s.otherBytes / GB).toBeCloseTo(17.1, 6);
		expect(s.freeBytes / GB).toBeCloseTo(12.9, 6);
		expect(s.usedBytes / GB).toBeCloseTo(18.2, 6);
		expect(s.freeKnown).toBe(true);
	});
	it('gives fractions that fill the bar exactly', () => {
		const s = splitMemory(31.1 * GB, 12.9 * GB, 1.1 * GB);
		expect(s.appFrac).toBeCloseTo(1.1 / 31.1, 6);
		expect(s.otherFrac).toBeCloseTo(17.1 / 31.1, 6);
		expect(s.freeFrac).toBeCloseTo(12.9 / 31.1, 6);
		expect(s.appFrac + s.otherFrac + s.freeFrac).toBeCloseTo(1, 10);
	});

	// THE SEAM. The app's figure is a sum of working sets and over-counts shared pages — the
	// Electron runtime is counted once per process — so `other` as a remainder can go negative.
	// Free and total come from the OS and win; the app segment is capped at the measured used
	// space and `other` falls to zero rather than rendering backwards.
	it('clamps other at zero when the app claims more than the OS says is in use', () => {
		const s = splitMemory(32 * GB, 28 * GB, 6 * GB); // used is 4 GB; the app claims 6
		expect(s.otherBytes).toBe(0);
		expect(s.otherFrac).toBe(0);
	});
	it('still produces sane fractions that sum to 1 in that case', () => {
		const s = splitMemory(32 * GB, 28 * GB, 6 * GB);
		expect(s.appFrac).toBeCloseTo(4 / 32, 10); // drawn no wider than the used space
		expect(s.appFrac + s.otherFrac + s.freeFrac).toBeCloseTo(1, 10);
		for (const f of [s.appFrac, s.otherFrac, s.freeFrac]) {
			expect(f).toBeGreaterThanOrEqual(0);
			expect(f).toBeLessThanOrEqual(1);
		}
	});
	it('keeps reporting the app figure as measured — only the geometry is reconciled', () => {
		// The label must still say what the working-set sum said. Silently shrinking the number
		// to make the arithmetic close is the reconciliation this design refuses.
		expect(splitMemory(32 * GB, 28 * GB, 6 * GB).appBytes).toBe(6 * GB);
	});

	it('is an empty bar, not NaN, when the machine size is unknown', () => {
		for (const bad of [0, -1, Number.NaN]) {
			const s = splitMemory(bad, 8 * GB, 2 * GB);
			expect(s).toMatchObject({ appFrac: 0, otherFrac: 0, freeFrac: 0, totalBytes: 0, freeKnown: false });
			expect(s.appBytes).toBe(2 * GB); // still the number the label leads with
		}
	});
	it('degrades to the old single fill when free memory cannot be read', () => {
		// Never the other reading — treating an unknown free as zero would draw a full machine.
		for (const bad of [Number.NaN, -1, 40 * GB]) {
			const s = splitMemory(32 * GB, bad, 8 * GB);
			expect(s.freeKnown).toBe(false);
			expect(s.appFrac).toBeCloseTo(0.25, 10);
			expect(s.otherFrac).toBe(0);
			expect(s.freeFrac).toBeCloseTo(0.75, 10);
		}
	});
	it('ignores a nonsensical app figure rather than drawing a negative segment', () => {
		expect(splitMemory(32 * GB, 8 * GB, Number.NaN)).toMatchObject({ appBytes: 0, appFrac: 0 });
		expect(splitMemory(32 * GB, 8 * GB, -5 * GB)).toMatchObject({ appBytes: 0, appFrac: 0 });
	});
	it('handles a machine with nothing free', () => {
		const s = splitMemory(32 * GB, 0, 4 * GB);
		expect(s.otherBytes).toBe(28 * GB);
		expect(s.freeFrac).toBe(0);
		expect(s.appFrac + s.otherFrac + s.freeFrac).toBeCloseTo(1, 10);
	});
});

describe('machinePressure', () => {
	it('is quiet with room to spare', () => {
		expect(machinePressure(splitMemory(RAM, 12.9 * GB, GB))).toBe('ok');
	});
	it('warns and crits at its own thresholds', () => {
		expect(machinePressure(splitMemory(RAM, FREE_WARN_BYTES, GB))).toBe('warn');
		expect(machinePressure(splitMemory(RAM, FREE_WARN_BYTES + 1, GB))).toBe('ok');
		expect(machinePressure(splitMemory(RAM, FREE_CRIT_BYTES, GB))).toBe('crit');
	});
	it('says nothing when free memory could not be read', () => {
		expect(machinePressure(splitMemory(RAM, Number.NaN, GB))).toBe('ok');
		expect(machinePressure(splitMemory(0, 0, GB))).toBe('ok');
	});
});

describe('warningState', () => {
	it('stays quiet on a healthy floor', () => {
		expect(warningState(report({ total: 3 * GB, unattributed: 80 * MB, sessions: 7 }), RAM))
			.toEqual({ level: 'ok', reason: null });
	});

	// THE CASE THIS WIDGET EXISTS FOR. The usage-probe leak ran for hours while the floor looked
	// healthy: seven sessions, a total well inside what 32 GB can carry. Warning on total alone
	// would have stayed silent the whole time.
	it('trips on unattributed growth while the total is nowhere near its own threshold', () => {
		const r = report({ total: 4 * GB, unattributed: 1 * GB, sessions: 7 });
		expect(barFraction(r.totalBytes, RAM)).toBeLessThan(TOTAL_WARN_SHARE);
		expect(warningState(r, RAM)).toEqual({ level: 'warn', reason: 'unattributed' });
	});
	it('escalates unattributed to crit on its own, total still quiet', () => {
		const r = report({ total: 6 * GB, unattributed: 3 * GB, sessions: 9 });
		expect(barFraction(r.totalBytes, RAM)).toBeLessThan(TOTAL_WARN_SHARE);
		expect(warningState(r, RAM)).toEqual({ level: 'crit', reason: 'unattributed' });
	});
	it('does not fire on the transient processes a healthy app spawns between polls', () => {
		const r = report({ total: 3 * GB, unattributed: UNATTRIBUTED_WARN_BYTES - 1, sessions: 7 });
		expect(warningState(r, RAM).level).toBe('ok');
	});
	it('fires exactly at the unattributed threshold', () => {
		expect(warningState(report({ total: GB, unattributed: UNATTRIBUTED_WARN_BYTES }), RAM).level).toBe('warn');
		expect(warningState(report({ total: GB, unattributed: UNATTRIBUTED_CRIT_BYTES }), RAM).level).toBe('crit');
	});

	it('warns on total once the floor holds most of the machine', () => {
		const r = report({ total: TOTAL_WARN_SHARE * RAM, unattributed: 0, sessions: 12 });
		expect(warningState(r, RAM)).toEqual({ level: 'warn', reason: 'total' });
	});
	it('crits on total at its own threshold', () => {
		const r = report({ total: TOTAL_CRIT_SHARE * RAM, unattributed: 0, sessions: 12 });
		expect(warningState(r, RAM)).toEqual({ level: 'crit', reason: 'total' });
	});
	it('twelve legitimate sessions below the total threshold stay quiet', () => {
		expect(warningState(report({ total: 15 * GB, unattributed: 0, sessions: 12 }), RAM).level).toBe('ok');
	});

	it('reports unattributed when both conditions land on the same level — it is the actionable one', () => {
		const r = report({ total: TOTAL_WARN_SHARE * RAM, unattributed: UNATTRIBUTED_WARN_BYTES, sessions: 12 });
		expect(warningState(r, RAM)).toEqual({ level: 'warn', reason: 'unattributed' });
	});
	it('reports total when total is strictly worse', () => {
		const r = report({ total: TOTAL_CRIT_SHARE * RAM, unattributed: UNATTRIBUTED_WARN_BYTES, sessions: 12 });
		expect(warningState(r, RAM)).toEqual({ level: 'crit', reason: 'total' });
	});
	it('never warns on total when the machine size is unknown', () => {
		expect(warningState(report({ total: 900 * GB, unattributed: 0 }), 0)).toEqual({ level: 'ok', reason: null });
	});
});

describe('splitLabel', () => {
	it('leads with the app figure, then machine pressure', () => {
		expect(splitLabel(splitMemory(31.1 * GB, 12.9 * GB, 1.1 * GB))).toBe('1.1 GB · 18.2/31 used');
	});
	it('rounds the machine — a 32 GB box does not read as 31.9 GB', () => {
		expect(splitLabel(splitMemory(31.9 * GB, 20 * GB, 2.3 * GB))).toBe('2.3 GB · 11.9/32 used');
	});
	it('drops to the app figure alone when the machine size is unknown', () => {
		expect(splitLabel(splitMemory(0, 0, 2.3 * GB))).toBe('2.3 GB');
	});
	it('falls back to the old ratio when free memory could not be read', () => {
		// Nothing honest to say about the other two quantities, so it says nothing about them.
		expect(splitLabel(splitMemory(31.9 * GB, Number.NaN, 2.3 * GB))).toBe('2.3/32 GB');
	});
});

describe('splitDetail', () => {
	it('gives the panel the same three quantities in the same order', () => {
		const d = splitDetail(splitMemory(31.1 * GB, 12.9 * GB, 1.1 * GB));
		expect(d.main).toBe('1.1 GB this app');
		expect(d.sub).toBe('17.1 GB other · 12.9 GB free of 31.1 GB');
	});
	it('names only what it knows when free memory could not be read', () => {
		const d = splitDetail(splitMemory(31.1 * GB, Number.NaN, 1.1 * GB));
		expect(d.main).toBe('1.1 GB this app');
		expect(d.sub).toBe('of 31.1 GB on this machine');
	});
});

describe('gaugeFrom', () => {
	it('labels the app figure and machine pressure, with no warning glyph when healthy', () => {
		const g = gaugeFrom(report({ total: 2.3 * GB, unattributed: 40 * MB, sessions: 7 }), RAM, 20 * GB);
		expect(g.label).toBe('2.3 GB · 12.0/32 used');
		expect(g.level).toBe('ok');
		expect(g.pressure).toBe('ok');
		expect(g.split.appFrac).toBeCloseTo(2.3 / 32, 4);
	});
	it('keeps the denominator when the same app figure sits on a different machine', () => {
		// The ratio is the point: 2.3 GB is noise on 64 GB and a third of a 16 GB box. Pinned
		// against two denominators so no future formatter can quietly drop back to a bare total.
		expect(gaugeFrom(report({ total: 2.3 * GB, sessions: 7 }), 16 * GB, 8 * GB).label).toBe('2.3 GB · 8.0/16 used');
		expect(gaugeFrom(report({ total: 2.3 * GB, sessions: 7 }), 64 * GB, 40 * GB).label).toBe('2.3 GB · 24.0/64 used');
	});
	it('drops to the app figure alone when the machine size is unknown', () => {
		expect(gaugeFrom(report({ total: 2.3 * GB, sessions: 7 }), 0, 0).label).toBe('2.3 GB');
	});
	it('adds the warning glyph and names the leak in the tooltip', () => {
		const g = gaugeFrom(report({ total: 4 * GB, unattributed: 1 * GB, sessions: 7 }), RAM, FREE);
		expect(g.label).toBe('4.0 GB · 16.0/32 used ⚠');
		expect(g.reason).toBe('unattributed');
		expect(g.title).toContain('Unattributed memory is high');
		expect(g.title).toContain('7 sessions');
	});
	it('singularises one session', () => {
		expect(gaugeFrom(report({ total: 500 * MB, sessions: 1 }), RAM, FREE).title).toContain('1 session ·');
	});
	it('names the machine share in the tooltip', () => {
		expect(gaugeFrom(report({ total: 8 * GB, sessions: 4 }), RAM, FREE).title).toContain('(25% of this machine)');
	});
	it('names all three quantities in the tooltip', () => {
		const g = gaugeFrom(report({ total: 1.1 * GB, sessions: 7 }), 31.1 * GB, 12.9 * GB);
		expect(g.title).toContain('other processes 17.1 GB');
		expect(g.title).toContain('free 12.9 GB');
	});

	// The seam, admitted in the one place a person can read it. Stated whether or not anything
	// is wrong: the app's number is the one compared over time, so its direction of error is
	// owed to whoever is comparing.
	it('always admits that the app figure over-counts shared pages', () => {
		for (const g of [
			gaugeFrom(report({ total: 1.1 * GB, sessions: 7 }), RAM, FREE),
			gaugeFrom(report({ total: 4 * GB, unattributed: 3 * GB, sessions: 7 }), RAM, FREE),
		]) {
			expect(g.title).toContain('sum of process working sets');
			expect(g.title).toContain('reads slightly high');
		}
	});

	// THE RULE THE COLOUR EXISTS FOR: a machine filled by someone else must never colour the
	// app's gauge. If it did, the one reading that has to be trusted would start crying wolf
	// about things nobody can fix from here — the failure the unattributed row was designed
	// around.
	it('does not raise the app level when the MACHINE is nearly full', () => {
		const g = gaugeFrom(report({ total: 1.1 * GB, unattributed: 40 * MB, sessions: 7 }), RAM, 400 * MB);
		expect(g.level).toBe('ok');
		expect(g.reason).toBe(null);
		expect(g.label).not.toContain('⚠');
		// It is reported — on the free segment, and in the tooltip, which says whose it is.
		expect(g.pressure).toBe('crit');
		expect(g.title).toContain('The MACHINE is nearly full');
		expect(g.title).toContain('not this app');
	});
	it('reports both independently when the app is leaking on a full machine', () => {
		const g = gaugeFrom(report({ total: 4 * GB, unattributed: 3 * GB, sessions: 7 }), RAM, 400 * MB);
		expect(g).toMatchObject({ level: 'crit', reason: 'unattributed', pressure: 'crit' });
	});
});

describe('gaugePending', () => {
	it('is an empty bar and a dash — never a fake zero', () => {
		const g = gaugePending();
		expect(g).toMatchObject({ level: 'ok', pressure: 'ok', label: '—' });
		expect(g.split).toMatchObject({ appFrac: 0, otherFrac: 0, freeFrac: 0 });
	});
});
