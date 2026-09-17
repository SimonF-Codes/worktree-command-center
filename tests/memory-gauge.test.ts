import { describe, it, expect } from 'vitest';
import {
	barFraction, warningState, gaugeFrom, gaugePending,
	UNATTRIBUTED_WARN_BYTES, UNATTRIBUTED_CRIT_BYTES, TOTAL_WARN_SHARE, TOTAL_CRIT_SHARE,
} from '../src/terminals/memory-gauge';
import type { MemoryReport, MemoryRow } from '../src/terminals/session-memory';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const RAM = 32 * GB; // the machine this was built on: 31.1 GiB

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

describe('gaugeFrom', () => {
	it('labels the used figure over the machine, with no warning glyph when healthy', () => {
		const g = gaugeFrom(report({ total: 2.3 * GB, unattributed: 40 * MB, sessions: 7 }), RAM);
		expect(g.label).toBe('2.3/32 GB');
		expect(g.level).toBe('ok');
		expect(g.fill).toBeCloseTo(2.3 / 32, 4);
	});
	it('keeps the denominator when the same total sits on a different machine', () => {
		// The ratio is the point: 2.3 GB is noise on 64 GB and a third of a 16 GB box. Pinned
		// against two denominators so no future formatter can quietly drop back to a bare total.
		expect(gaugeFrom(report({ total: 2.3 * GB, sessions: 7 }), 16 * GB).label).toBe('2.3/16 GB');
		expect(gaugeFrom(report({ total: 2.3 * GB, sessions: 7 }), 64 * GB).label).toBe('2.3/64 GB');
	});
	it('rounds the machine — a 32 GB box does not read as 31.9 GB', () => {
		// os.totalmem() reports the real 31.9 GiB, not the number on the box.
		expect(gaugeFrom(report({ total: 2.3 * GB, sessions: 7 }), 31.9 * GB).label).toBe('2.3/32 GB');
	});
	it('drops to the used figure alone when the machine size is unknown', () => {
		expect(gaugeFrom(report({ total: 2.3 * GB, sessions: 7 }), 0).label).toBe('2.3 GB');
	});
	it('adds the warning glyph and names the leak in the tooltip', () => {
		const g = gaugeFrom(report({ total: 4 * GB, unattributed: 1 * GB, sessions: 7 }), RAM);
		expect(g.label).toBe('4.0/32 GB ⚠');
		expect(g.reason).toBe('unattributed');
		expect(g.title).toContain('Unattributed memory is high');
		expect(g.title).toContain('7 sessions');
	});
	it('singularises one session', () => {
		expect(gaugeFrom(report({ total: 500 * MB, sessions: 1 }), RAM).title).toContain('1 session ·');
	});
	it('names the machine share in the tooltip', () => {
		expect(gaugeFrom(report({ total: 8 * GB, sessions: 4 }), RAM).title).toContain('(25% of this machine)');
	});
});

describe('gaugePending', () => {
	it('is an empty bar and a dash — never a fake zero', () => {
		expect(gaugePending()).toMatchObject({ fill: 0, level: 'ok', label: '—' });
	});
});
