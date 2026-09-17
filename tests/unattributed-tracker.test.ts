import { describe, it, expect } from 'vitest';
import {
	trackUnattributed, closeableUnattributed, STALE_MS, MIN_POLLS,
	EMPTY_UNATTRIBUTED, type UnattributedState,
} from '../src/terminals/unattributed-tracker';
import { attributeMemory, type SessionClaim } from '../src/terminals/session-memory';
import type { ProcRow } from '../src/terminals/process-snapshot';

const MB = 1024 * 1024;
const T0 = 1_700_000_000_000;

function proc(over: Partial<ProcRow> & { pid: number; startedAt?: number }): ProcRow {
	return { ppid: 1, name: 'claude.exe', rssBytes: 100 * MB, startedAt: T0 - 60_000, ...over };
}

/** Feed the tracker a series of (rows, unattributed pids) at a fixed cadence. */
function poll(
	snaps: Array<readonly ProcRow[]>,
	everyMs: number,
	start = T0,
): { state: UnattributedState; now: number } {
	let state = EMPTY_UNATTRIBUTED;
	let now = start;
	for (const rows of snaps) {
		state = trackUnattributed(state, rows, rows.map((r) => r.pid), now);
		now += everyMs;
	}
	return { state, now: now - everyMs };
}

/** The same rows every poll, `count` times, at `everyMs`. */
function steady(rows: readonly ProcRow[], count: number, everyMs: number) {
	return poll(Array.from({ length: count }, () => rows), everyMs);
}

describe('trackUnattributed', () => {
	it('counts consecutive polls and remembers when a process was FIRST seen unattributed', () => {
		const rows = [proc({ pid: 500 })];
		const { state } = steady(rows, 3, 20_000);
		const t = [...state.values()][0]!;
		expect(t.polls).toBe(3);
		expect(t.firstSeen).toBe(T0);
	});

	it('drops a process the moment it is missing from a snapshot — the gap IS the reset', () => {
		const a = proc({ pid: 500 });
		const { state } = poll([[a], [a], [], [a]], 20_000);
		expect([...state.values()][0]).toMatchObject({ pid: 500, polls: 1, firstSeen: T0 + 60_000 });
	});

	it('ignores a process whose start time could not be read: no identity, no persistence', () => {
		const anon: ProcRow = { pid: 500, ppid: 1, name: 'x.exe', rssBytes: MB };
		const { state } = steady([anon], 5, 60_000);
		expect(state.size).toBe(0);
	});

	it('tracks only what is unattributed, not everything in the snapshot', () => {
		const rows = [proc({ pid: 500 }), proc({ pid: 600 })];
		const state = trackUnattributed(EMPTY_UNATTRIBUTED, rows, [600], T0);
		expect([...state.values()].map((t) => t.pid)).toEqual([600]);
	});
});

describe('closeableUnattributed', () => {
	it('never offers a transient: one snapshot is not evidence of anything', () => {
		// `git` from a coordination hook, seen once and gone. This is the process the whole
		// feature is built to not kill.
		const git = proc({ pid: 700, name: 'git.exe', rssBytes: 8 * MB });
		const { state, now } = poll([[git]], 20_000);
		expect(closeableUnattributed([git], state, now).victims).toEqual([]);
	});

	it('offers a process that has been unattributed for long enough AND often enough', () => {
		const leak = proc({ pid: 500, rssBytes: 254 * MB });
		// 12 polls at 20s = 240s: past three minutes and past three polls.
		const { state, now } = steady([leak], 12, 20_000);
		const plan = closeableUnattributed([leak], state, now);
		expect(plan.victims.map((v) => v.pid)).toEqual([500]);
		expect(plan.trees).toEqual([{ root: 500, pids: [500], rssBytes: 254 * MB }]);
		expect(plan.totalBytes).toBe(254 * MB);
	});

	it('requires BOTH gates — enough time is not enough polls', () => {
		// Two polls at the widget's 60s cadence: 60s apart is not the 3 minutes either, so push
		// the clock instead. Long enough by time, one sample short by count.
		const leak = proc({ pid: 500 });
		const { state } = steady([leak], MIN_POLLS - 1, 60_000);
		expect(closeableUnattributed([leak], state, T0 + 10 * STALE_MS).victims).toEqual([]);
	});

	it('requires BOTH gates — enough polls is not enough time', () => {
		// Ten polls one second apart: plenty of samples, barely ten seconds of evidence.
		const leak = proc({ pid: 500 });
		const { state, now } = steady([leak], 10, 1_000);
		expect(closeableUnattributed([leak], state, now).victims).toEqual([]);
	});

	it('does NOT let a recycled pid inherit the age of the process that held the number', () => {
		// The bug this test exists for: pid 500 is unattributed for twenty minutes, dies, and
		// Windows hands 500 to something new. Keyed on the pid alone, the newcomer would arrive
		// already eligible and be killed four seconds into its life.
		const old = proc({ pid: 500, startedAt: T0 - 3_600_000 });
		const fresh = proc({ pid: 500, startedAt: T0 + 600_000 });
		let state = EMPTY_UNATTRIBUTED;
		let now = T0;
		for (let i = 0; i < 30; i++) { state = trackUnattributed(state, [old], [500], now); now += 20_000; }
		expect(closeableUnattributed([old], state, now).victims.map((v) => v.pid)).toEqual([500]);

		state = trackUnattributed(state, [fresh], [500], now);
		const t = [...state.values()][0]!;
		expect(state.size).toBe(1);
		expect(t.polls).toBe(1);
		expect(t.firstSeen).toBe(now);
		expect(closeableUnattributed([fresh], state, now).victims).toEqual([]);
	});

	it('refuses a whole tree when anything inside it is still young', () => {
		// A stale sidecar that has just spawned a `git` for a coordination hook. Tree-killing the
		// parent would take the `git` with it and can leave an index.lock in a shared repo.
		const parent = proc({ pid: 500, name: 'cmd.exe', rssBytes: 2 * MB });
		const old = Array.from({ length: 12 }, () => [parent]);
		const git = proc({ pid: 700, ppid: 500, name: 'git.exe', rssBytes: 8 * MB });
		const { state, now } = poll([...old, [parent, git]], 20_000);
		expect(closeableUnattributed([parent, git], state, now).victims).toEqual([]);
	});

	it('offers the parent again once the young child is gone', () => {
		const parent = proc({ pid: 500, name: 'cmd.exe' });
		const git = proc({ pid: 700, ppid: 500, name: 'git.exe' });
		const { state, now } = poll([...Array.from({ length: 12 }, () => [parent]), [parent, git], [parent]], 20_000);
		expect(closeableUnattributed([parent], state, now).victims.map((v) => v.pid)).toEqual([500]);
	});

	it('kills the ROOT once, not every pid in the tree — the tree comes with it', () => {
		const rows = [
			proc({ pid: 500, name: 'node.exe', rssBytes: 50 * MB }),
			proc({ pid: 501, ppid: 500, name: 'cmd.exe', rssBytes: 2 * MB }),
			proc({ pid: 502, ppid: 501, name: 'claude.exe', rssBytes: 250 * MB }),
		];
		const { state, now } = steady(rows, 12, 20_000);
		const plan = closeableUnattributed(rows, state, now);
		expect(plan.trees.map((t) => t.root)).toEqual([500]);
		expect(plan.trees[0]!.pids.sort()).toEqual([500, 501, 502]);
		expect(plan.trees[0]!.rssBytes).toBe(302 * MB);
		// Listed one by one all the same: the confirm names what dies, not what is spawned to
		// kill it.
		expect(plan.victims.map((v) => v.pid)).toEqual([502, 500, 501]);
		expect(plan.totalBytes).toBe(302 * MB);
	});

	it('drops a pid that died between the last poll and the click', () => {
		const leak = proc({ pid: 500 });
		const { state, now } = steady([leak], 12, 20_000);
		expect(closeableUnattributed([], state, now).victims).toEqual([]);
	});
});

describe('nothing a session claims is ever eligible', () => {
	const APP = 100;
	const rows: ProcRow[] = [
		proc({ pid: APP, ppid: 1, name: 'app.exe', rssBytes: 120 * MB }),
		// A live session: sidecar → cmd → claude, claimed by a tile.
		proc({ pid: 200, ppid: APP, name: 'node.exe', rssBytes: 50 * MB }),
		proc({ pid: 201, ppid: 200, name: 'cmd.exe', rssBytes: 2 * MB }),
		proc({ pid: 202, ppid: 201, name: 'claude.exe', rssBytes: 250 * MB }),
		// A leak: the same shape, claimed by nothing.
		proc({ pid: 300, ppid: APP, name: 'node.exe', rssBytes: 50 * MB }),
		proc({ pid: 301, ppid: 300, name: 'claude.exe', rssBytes: 400 * MB }),
	];
	const claim: SessionClaim = {
		key: 'ws:1', name: 'live', workspaceId: 'ws', workspaceName: 'Workspace', repo: 'repo',
		branch: 'b', pid: 200, busy: false, idleSince: null, hidden: false,
	};

	it('runs the real attribution for hours and still only offers the unclaimed tree', () => {
		let state = EMPTY_UNATTRIBUTED;
		let now = T0;
		for (let i = 0; i < 60; i++) {
			const report = attributeMemory(rows, APP, [claim]);
			state = trackUnattributed(state, rows, report.unattributed.pids, now);
			now += 60_000;
		}
		const plan = closeableUnattributed(rows, state, now);
		expect(plan.victims.map((v) => v.pid).sort()).toEqual([300, 301]);
		expect(plan.trees.map((t) => t.root)).toEqual([300]);
		// The session's own processes, and the app itself, are not in the plan at all.
		for (const safe of [APP, 200, 201, 202]) {
			expect(plan.victims.some((v) => v.pid === safe)).toBe(false);
			expect(plan.trees.some((t) => t.pids.includes(safe))).toBe(false);
		}
	});

	it('refuses the app tree itself even though the app is nobody\'s session', () => {
		// attributeMemory excludes the app pid from unattributed, so it is never tracked, and a
		// tree containing an untracked process is refused whole. Belt and braces: killing the app
		// pid would close the floor.
		let state = EMPTY_UNATTRIBUTED;
		let now = T0;
		for (let i = 0; i < 60; i++) {
			state = trackUnattributed(state, rows, attributeMemory(rows, APP, []).unattributed.pids, now);
			now += 60_000;
		}
		expect(closeableUnattributed(rows, state, now).trees.some((t) => t.pids.includes(APP))).toBe(false);
	});
});
