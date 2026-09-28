import { describe, it, expect } from 'vitest';
import { buildFloorReport, renderFloorReport, FLOOR_REPORT_SCHEMA, type FloorInputs } from '../src/terminals/floor-report';
import type { WorktreeEntry } from '../src/terminals/worktree-registry';
import type { MemoryReport, SessionClaim } from '../src/terminals/session-memory';

const NOW = Date.parse('2026-09-27T22:00:00Z');
const DAY = 86_400_000;
const MB = 1024 * 1024;
const GB = 1024 * MB;

const wt = (o: Partial<WorktreeEntry>): WorktreeEntry => ({
	repo: 'wcc', branch: 'wt/main-1', path: 'C:/wt/wcc/wt-main-1', terminal: null,
	dirtyFiles: [], ahead: 0, behind: 0, parked: false, lastActivity: NOW, lastCommitAt: NOW - DAY, base: 'main', ...o,
});

const claim = (o: Partial<SessionClaim>): SessionClaim => ({
	key: 'default:1', name: 'T1', workspaceId: 'default', workspaceName: 'default', repo: 'wcc', branch: 'wt/main-15',
	pid: 100, busy: false, idleSince: NOW - 90 * 60_000, hidden: false, ...o,
});

/** A floor shaped like the real one: a shared target scanned by two tabs, a dormant one, a
 *  parked worktree, a folder target, a target no tab has scanned, and a session group whose
 *  tab is long gone. */
function fixture(): FloorInputs {
	const entries: WorktreeEntry[] = [
		wt({ branch: 'wt/main-7', path: 'C:/wt/wcc/wt-main-7', parked: true, ahead: 1, lastCommitAt: Date.parse('2026-09-17T05:30:19Z') }),
		wt({ branch: 'wt/main-15', path: 'C:/wt/wcc/wt-main-15', terminal: 'T1', dirtyFiles: ['a.ts', 'b.ts'] }),
		wt({ branch: 'wt/main-2', path: 'C:/wt/wcc/wt-main-2', ahead: 3 }),
		wt({ repo: 'music', branch: 'wt/main-1', path: 'C:/wt/music/wt-main-1', lastCommitAt: Date.parse('2026-09-06T12:00:00Z') }),
		// Outside wt/<base>-N and held by nothing: the scan compared it with itself.
		wt({ repo: 'music', branch: 'docs/status', path: 'C:/wt/music/docs', base: 'docs/status', lastCommitAt: Date.parse('2026-09-05T12:00:00Z') }),
	];
	return {
		now: NOW,
		workspaces: [{ id: 'default', name: 'default' }, { id: 'music-generation', name: 'Music Generation' }],
		activeWorkspaceId: 'default',
		targets: [
			{ name: 'wcc', path: 'C:\\dev\\wcc' },
			{ name: 'music', path: 'C:\\dev\\music' },
			{ name: 'notes', path: 'C:\\notes', folder: true },
			{ name: 'chess', path: 'C:\\dev\\chess', group: 'chess' },
		],
		scans: [
			// An OLDER sighting of wt-main-2 from another tab, still clean — must lose to the newer.
			{ workspaceId: 'music-generation', scannedAt: NOW - 600_000, entries: [wt({ branch: 'wt/main-2', path: 'c:\\wt\\wcc\\wt-main-2\\' })], repos: [{ repo: 'wcc', branches: 17, lastCommitAt: NOW - 2 * DAY }] },
			{ workspaceId: 'default', scannedAt: NOW - 30_000, entries, repos: [
				{ repo: 'wcc', branches: 18, lastCommitAt: NOW - DAY },
				{ repo: 'music', branches: 4, lastCommitAt: Date.parse('2026-09-06T12:00:00Z') },
			] },
		],
		claims: [
			claim({}),
			// Holds a worktree scanned by the OTHER grid — entry.terminal is null, the claim knows.
			claim({ key: 'music-generation:3', name: 'Composer', workspaceId: 'music-generation', workspaceName: 'Music Generation', repo: 'wcc', branch: 'wt/main-2', busy: true, idleSince: null, hidden: true }),
			claim({ key: 'app:usage-probe:9', name: 'usage battery', system: true, repo: 'usage probe', branch: '' }),
		],
		memory: {
			sessions: [
				{ ...claim({}), rssBytes: 400 * MB, procCount: 4, dead: false },
				{ ...claim({ key: 'music-generation:3', name: 'Composer' }), rssBytes: 600 * MB, procCount: 5, dead: false },
			],
			unattributed: { rssBytes: 50 * MB, procCount: 2, pids: [7, 8] },
			appSelfBytes: 300 * MB,
			totalBytes: 1350 * MB,
		} satisfies MemoryReport,
		machine: { totalBytes: 32 * GB, freeBytes: 12 * GB },
		sessionGroups: { default: 6, 'music-generation': 0, 'test-2': 0, 'closed:old:123': 2 },
	};
}

describe('buildFloorReport', () => {
	it('joins worktrees across grids, keeping the newest sighting of each path', () => {
		const r = buildFloorReport(fixture());
		expect(r.schema).toBe(FLOOR_REPORT_SCHEMA);
		expect(r.worktrees.map((w) => `${w.repo}:${w.branch}`)).toEqual(['music:docs/status', 'music:wt/main-1', 'wcc:wt/main-2', 'wcc:wt/main-7', 'wcc:wt/main-15']);
		const two = r.worktrees.find((w) => w.branch === 'wt/main-2' && w.repo === 'wcc')!;
		expect(two.state).toBe('ahead'); // the newer scan's answer, not the older clean one
		expect(two.ahead).toBe(3);
	});

	it('states each worktree the way the ledger does, and names who holds it from ANY tab', () => {
		const by = Object.fromEntries(buildFloorReport(fixture()).worktrees.map((w) => [`${w.repo}:${w.branch}`, w]));
		expect(by['wcc:wt/main-7']!.state).toBe('parked');
		expect(by['wcc:wt/main-7']!.lastCommitAt).toBe('2026-09-17T05:30:19.000Z');
		expect(by['wcc:wt/main-15']).toMatchObject({ state: 'dirty', dirtyFiles: 2, heldBy: 'T1' });
		expect(by['wcc:wt/main-2']!.heldBy).toBe('Composer');
		expect(by['music:wt/main-1']!.heldBy).toBeNull();
	});

	it('claims nothing about merging for a branch that was only compared with itself', () => {
		const by = Object.fromEntries(buildFloorReport(fixture()).worktrees.map((w) => [`${w.repo}:${w.branch}`, w]));
		expect(by['music:docs/status']).toMatchObject({ state: 'clean', base: 'docs/status', ahead: null, behind: null });
		expect(by['music:wt/main-1']).toMatchObject({ base: 'main', ahead: 0, behind: 0 });
		const md = renderFloorReport(buildFloorReport(fixture())).markdown;
		expect(md).toContain('| `docs/status` | clean | — | — | — | 0 | 2026-09-05 | — |');
		expect(md).toContain('"—" means no base was known');
	});

	it('aggregates targets, and marks folders and unscanned targets rather than zeroing them', () => {
		const t = Object.fromEntries(buildFloorReport(fixture()).targets.map((x) => [x.name, x]));
		expect(t.wcc).toMatchObject({
			kind: 'git', scanned: true, branches: 18, worktrees: 3, held: 2, dirtyFiles: 2, aheadCommits: 4,
			byState: { clean: 0, dirty: 1, ahead: 1, parked: 1 },
		});
		expect(t.music!.lastCommitAt).toBe('2026-09-06T12:00:00.000Z');
		expect(t.notes).toMatchObject({ kind: 'folder', scanned: false, branches: null });
		expect(t.chess).toMatchObject({ kind: 'git', scanned: false, group: 'chess', worktrees: 0, lastCommitAt: null });
	});

	it('lists terminals with status, idle time and memory, and leaves the app\'s own probe out', () => {
		const r = buildFloorReport(fixture());
		expect(r.terminals.map((x) => x.name)).toEqual(['T1', 'Composer']); // 'default' < 'Music Generation'
		expect(r.terminals[0]).toMatchObject({ status: 'idle', idleMs: 90 * 60_000, memoryBytes: 400 * MB, dead: false });
		expect(r.terminals[1]).toMatchObject({ status: 'busy', idleMs: null, idleSince: null, hidden: true, memoryBytes: 600 * MB });
	});

	it('reports tabs with live and saved counts, and finds session groups no tab owns', () => {
		const r = buildFloorReport(fixture());
		expect(r.tabs).toEqual([
			{ id: 'default', name: 'default', active: true, liveTerminals: 1, savedSessions: 6, repos: ['wcc'] },
			{ id: 'music-generation', name: 'Music Generation', active: false, liveTerminals: 1, savedSessions: 0, repos: ['wcc'] },
		]);
		// A closed-tab archive is not an orphan: Recently Closed owns it.
		expect(r.orphanSessionGroups).toEqual([{ key: 'test-2', savedSessions: 0 }]);
	});

	it('splits memory the three ways the gauge does', () => {
		const m = buildFloorReport(fixture()).totals.memory!;
		expect(m).toMatchObject({ sessionsBytes: 1000 * MB, unattributedBytes: 50 * MB, unattributedProcesses: 2, appSelfBytes: 300 * MB, appTotalBytes: 1350 * MB });
		expect(m.machine).toEqual({ appBytes: 1350 * MB, otherBytes: 20 * GB - 1350 * MB, freeBytes: 12 * GB, totalBytes: 32 * GB });
	});

	it('degrades honestly when nothing has been measured or scanned yet', () => {
		const r = buildFloorReport({ ...fixture(), scans: [], claims: [], memory: null, sessionGroups: null });
		expect(r.totals.memory).toBeNull();
		expect(r.worktrees).toEqual([]);
		expect(r.targets.every((t) => !t.scanned)).toBe(true);
		expect(r.tabs[0]!.savedSessions).toBeNull();
		const md = renderFloorReport(r).markdown;
		expect(md).toContain('Memory: not measured yet this launch');
		expect(md).toContain('Not scanned this launch: wcc, music, chess');
	});
});

describe('renderFloorReport', () => {
	it('the JSON is exactly the report object', () => {
		const r = buildFloorReport(fixture());
		expect(JSON.parse(renderFloorReport(r).json)).toEqual(r);
	});

	it('the markdown carries the facts a person needs', () => {
		const md = renderFloorReport(buildFloorReport(fixture())).markdown;
		expect(md.startsWith('---\ntype: reference\ncreated: 2026-09-27\ngenerated: 2026-09-27T22:00:00.000Z\n')).toBe(true);
		expect(md).toContain('**2** tabs · **4** targets · **5** worktrees (2 clean, 1 dirty, 1 ahead, 1 parked)');
		expect(md).toContain('1.3 GB this app · 18.7 GB other · 12.0 GB free of 32.0 GB');
		expect(md).toContain('Session groups with no tab: `test-2` (0 saved)');
		expect(md).toContain('| `wt/main-7` | **parked** | `main` | 1 | 0 | 0 | 2026-09-17 | — |');
		expect(md).toContain('| wcc | 18 | 3 | 0 | 1 | 1 | 1 | 2 | 2026-09-26 (1d 0h ago) |');
		expect(md).toContain('| chess | — | — | — | — | — | — | — | not scanned |');
		expect(md).toContain('| Composer (hidden) | Music Generation | wcc | `wt/main-2` | **busy** | 600 MB |');
		expect(md).toContain('| T1 | default | wcc | `wt/main-15` | idle 1h 30m | 400 MB |');
	});

	it('both renderings come from the same object: change one input and both change', () => {
		const a = fixture();
		const b = fixture();
		b.scans = b.scans.map((s) => ({ ...s, entries: s.entries.map((e) => (e.branch === 'wt/main-7' ? { ...e, parked: false, dirtyFiles: ['x'] } : e)) }));
		const ra = renderFloorReport(buildFloorReport(a));
		const rb = renderFloorReport(buildFloorReport(b));
		expect(ra.json).not.toBe(rb.json);
		expect(ra.markdown).not.toBe(rb.markdown);
		expect(JSON.parse(rb.json).worktrees.find((w: { branch: string }) => w.branch === 'wt/main-7').state).toBe('dirty');
		expect(rb.markdown).toContain('| `wt/main-7` | **dirty** |');
		// And every worktree in the JSON is a row in the markdown — nothing one has, the other lacks.
		for (const w of JSON.parse(rb.json).worktrees as Array<{ branch: string }>) expect(rb.markdown).toContain(`| \`${w.branch}\` |`);
	});

	it('is deterministic — same inputs, byte-identical output', () => {
		expect(renderFloorReport(buildFloorReport(fixture()))).toEqual(renderFloorReport(buildFloorReport(fixture())));
	});
});
