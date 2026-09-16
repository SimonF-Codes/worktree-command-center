import { describe, it, expect } from 'vitest';
import { attributeMemory, idleLongerThan, formatBytes, formatIdle, closeConfirm, bulkConfirm, type SessionClaim, type MemoryRow } from '../src/terminals/session-memory';
import type { ProcRow } from '../src/terminals/process-snapshot';

const MB = 1024 * 1024;
const p = (pid: number, ppid: number, mb: number, name = 'node.exe'): ProcRow => ({ pid, ppid, name, rssBytes: mb * MB });

function claim(over: Partial<SessionClaim> & { key: string; pid: number | null }): SessionClaim {
	return {
		name: over.key, workspaceId: 'ws', workspaceName: 'Workspace', repo: 'repo', branch: 'b',
		busy: false, idleSince: null, hidden: false, ...over,
	};
}

/** App 100 with two sessions, each a sidecar → cmd → claude chain, as the real tree looks. */
const APP = 100;
const tree: ProcRow[] = [
	p(APP, 1, 120, 'app.exe'),
	p(200, APP, 50), p(201, 200, 2, 'cmd.exe'), p(202, 201, 250, 'claude.exe'),
	p(300, APP, 50), p(301, 300, 2, 'cmd.exe'), p(302, 301, 400, 'claude.exe'),
];

describe('attributeMemory', () => {
	it('rolls a session up from its sidecar pid through the whole subtree', () => {
		const r = attributeMemory(tree, APP, [claim({ key: 'a', pid: 200 })]);
		expect(r.sessions[0]!.rssBytes).toBe(302 * MB); // 50 + 2 + 250
		expect(r.sessions[0]!.procCount).toBe(3);
	});

	it('sorts by RAM, biggest first', () => {
		const r = attributeMemory(tree, APP, [claim({ key: 'small', pid: 200 }), claim({ key: 'big', pid: 300 })]);
		expect(r.sessions.map((s) => s.key)).toEqual(['big', 'small']);
	});

	it('reports what NO session claims — the row that catches a leak', () => {
		// Session 200 is a tile; 300's chain belongs to nothing. That is the 2026-09-16 leak in
		// miniature: the floor would have called this "one healthy terminal".
		const r = attributeMemory(tree, APP, [claim({ key: 'a', pid: 200 })]);
		expect(r.unattributed.procCount).toBe(3);
		expect(r.unattributed.rssBytes).toBe(452 * MB);
		expect(r.unattributed.pids.sort()).toEqual([300, 301, 302]);
	});

	it('reports nothing unattributed when every process is claimed', () => {
		const r = attributeMemory(tree, APP, [claim({ key: 'a', pid: 200 }), claim({ key: 'b', pid: 300 })]);
		expect(r.unattributed).toEqual({ rssBytes: 0, procCount: 0, pids: [] });
	});

	it('keeps the app process out of the sessions and out of unattributed', () => {
		const r = attributeMemory(tree, APP, [claim({ key: 'a', pid: 200 }), claim({ key: 'b', pid: 300 })]);
		expect(r.appSelfBytes).toBe(120 * MB);
		expect(r.unattributed.pids).not.toContain(APP);
		expect(r.totalBytes).toBe((120 + 302 + 452) * MB);
	});

	it('spans workspaces — a session in a tab you are not looking at is still a row', () => {
		const r = attributeMemory(tree, APP, [
			claim({ key: 'a', pid: 200, workspaceId: 'chessedu', workspaceName: 'ChessEdu' }),
			claim({ key: 'b', pid: 300, workspaceId: 'brain', workspaceName: 'Brain 2.0' }),
		]);
		expect(r.sessions.map((s) => s.workspaceName)).toEqual(['Brain 2.0', 'ChessEdu']);
	});

	it('marks a session whose pid is gone as dead, with no memory attributed', () => {
		const r = attributeMemory(tree, APP, [claim({ key: 'ghost', pid: 999 })]);
		expect(r.sessions[0]!.dead).toBe(true);
		expect(r.sessions[0]!.rssBytes).toBe(0);
	});

	it('handles a session that has no pid yet without inventing one', () => {
		const r = attributeMemory(tree, APP, [claim({ key: 'booting', pid: null })]);
		expect(r.sessions[0]!.dead).toBe(false);
		expect(r.sessions[0]!.rssBytes).toBe(0);
	});

	it('terminates on a cyclic parent map (pid reuse) instead of hanging the render loop', () => {
		const cyclic: ProcRow[] = [p(APP, 1, 10, 'app.exe'), p(200, APP, 5), p(201, 200, 5), p(200, 201, 5)];
		const r = attributeMemory(cyclic, APP, []);
		expect(r.unattributed.procCount).toBe(2);
	});

	it('ignores a self-parented row rather than looping on it', () => {
		const r = attributeMemory([p(APP, 1, 10, 'app.exe'), p(7, 7, 5)], APP, []);
		expect(r.unattributed.procCount).toBe(0);
	});

	it('returns an empty report when the snapshot could not be taken', () => {
		const r = attributeMemory([], APP, [claim({ key: 'a', pid: 200 })]);
		expect(r.totalBytes).toBe(0);
		expect(r.unattributed.procCount).toBe(0);
	});
});

describe('idleLongerThan', () => {
	const NOW = 1_000_000_000;
	const row = (over: Partial<MemoryRow> & { key: string }): MemoryRow => ({
		name: over.key, workspaceId: 'ws', workspaceName: 'W', repo: 'r', branch: 'b', pid: 1,
		busy: false, idleSince: NOW - 3_600_000, hidden: false, rssBytes: 0, procCount: 1, dead: false, ...over,
	});

	it('selects only sessions idle at least that long', () => {
		const rows = [row({ key: 'old', idleSince: NOW - 7_200_000 }), row({ key: 'fresh', idleSince: NOW - 60_000 })];
		expect(idleLongerThan(rows, 3_600_000, NOW).map((r) => r.key)).toEqual(['old']);
	});

	it('NEVER includes a busy session — a bulk close must not end a running turn', () => {
		const rows = [row({ key: 'busy', busy: true, idleSince: NOW - 7_200_000 })];
		expect(idleLongerThan(rows, 3_600_000, NOW)).toEqual([]);
	});

	it('never includes the usage probe or a dead row', () => {
		const rows = [
			row({ key: 'probe', system: true, idleSince: NOW - 7_200_000 }),
			row({ key: 'dead', dead: true, idleSince: NOW - 7_200_000 }),
		];
		expect(idleLongerThan(rows, 3_600_000, NOW)).toEqual([]);
	});

	it('skips a session whose idle time is unknown rather than assuming it is idle', () => {
		expect(idleLongerThan([row({ key: 'x', idleSince: null })], 3_600_000, NOW)).toEqual([]);
	});
});

describe('formatting', () => {
	it('shows MB below a gigabyte and GB above', () => {
		expect(formatBytes(250 * MB)).toBe('250 MB');
		expect(formatBytes(1536 * MB)).toBe('1.5 GB');
	});
	it('reads durations the way a person would say them', () => {
		expect(formatIdle(5_000)).toBe('just now');
		expect(formatIdle(12 * 60_000)).toBe('12m');
		expect(formatIdle(60 * 60_000)).toBe('1h');
		expect(formatIdle(220 * 60_000)).toBe('3h 40m');
		expect(formatIdle(30 * 60 * 60_000)).toBe('1d 6h');
	});
});

describe('confirm copy', () => {
	const row = (over: Partial<MemoryRow> & { key: string }): MemoryRow => ({
		name: over.key, workspaceId: 'ws', workspaceName: 'Brain 2.0', repo: 'r', branch: 'b', pid: 1,
		busy: false, idleSince: 0, hidden: false, rssBytes: 200 * MB, procCount: 1, dead: false, ...over,
	});

	it('WARNS that a busy session loses its turn — the one real risk in the feature', () => {
		const c = closeConfirm({ name: 'hidprobe', busy: true });
		expect(c.title).toBe('Close "hidprobe"?');
		expect(c.body).toMatch(/WORKING RIGHT NOW/);
		expect(c.body).toMatch(/loses the turn/);
	});

	it('promises an idle session loses nothing, and says how it comes back', () => {
		const c = closeConfirm({ name: 'hidprobe', busy: false });
		expect(c.body).not.toMatch(/loses the turn/);
		expect(c.body).toMatch(/--continue/);
		expect(c.body).toMatch(/parked/);
	});

	it('NAMES what a bulk close will take, rather than just counting them', () => {
		const c = bulkConfirm([row({ key: 'alpha', idleSince: 0 }), row({ key: 'beta', idleSince: 0 })], '1 hour', 7_200_000);
		expect(c.title).toBe('Close 2 sessions idle over 1 hour?');
		expect(c.body).toContain('• alpha (Brain 2.0, idle 2h)');
		expect(c.body).toContain('• beta (Brain 2.0, idle 2h)');
		expect(c.body).toContain('400 MB');
		expect(c.okLabel).toBe('Close 2');
	});

	it('caps the list at eight and says how many more', () => {
		const c = bulkConfirm(Array.from({ length: 11 }, (_, i) => row({ key: `s${i}` })), '1 hour', 0);
		expect(c.body.match(/^• s\d/gm)).toHaveLength(8);
		expect(c.body).toContain('…and 3 more');
	});

	it('states that working sessions are excluded, so the button can be trusted', () => {
		expect(bulkConfirm([row({ key: 'a' })], '2 hours', 0).body).toMatch(/working are NOT included/);
	});
});
