import { describe, it, expect } from 'vitest';
import { buildFloorState, renderFloorState, FLOOR_STATE_VERSION, type FloorStateInput } from '../src/terminals/floor-state';
import type { WorktreeEntry } from '../src/terminals/worktree-registry';

const entry = (over: Partial<WorktreeEntry> = {}): WorktreeEntry => ({
	repo: 'app', branch: 'wt/main-1', path: 'C:/wt/app/wt-main-1', terminal: 'ax-a1', dirtyFiles: [],
	ahead: 0, behind: 0, parked: false, lastActivity: 1, lastCommitAt: 1000, base: 'main', ...over,
});

const input = (over: Partial<FloorStateInput> = {}): FloorStateInput => ({
	workspaceId: 'default', ts: 5000, intervalMs: 4000, scannedAt: 4000, worktrees: [],
	sessions: [
		{ id: 1, name: 'ax-a1', kind: 'terminal', repo: 'app', branch: 'wt/main-1', worktreePath: 'C:/wt/app/wt-main-1', busy: true, hidden: false, snapshotFile: '1-ax-a1.md' },
		{ id: 2, name: 'notes', kind: 'journal', repo: null, branch: null, worktreePath: null, busy: null, hidden: true, snapshotFile: null },
		{ id: 0, name: 'Kane', kind: 'god', repo: null, branch: null, worktreePath: null, busy: null, hidden: false, snapshotFile: null },
	],
	...over,
});

describe('buildFloorState', () => {
	it('stamps the version, workspace, snapshot time and cadence', () => {
		const s = buildFloorState(input());
		expect(s.v).toBe(FLOOR_STATE_VERSION);
		expect(s.v).toBe(1);
		expect(s).toMatchObject({ workspaceId: 'default', ts: 5000, intervalMs: 4000 });
	});

	it('marks only worktree terminals tellable — never a journal or an overseer', () => {
		const s = buildFloorState(input());
		expect(s.terminals.map((t) => [t.name, t.kind, t.tellable])).toEqual([
			['ax-a1', 'terminal', true],
			['notes', 'journal', false],
			['Kane', 'god', false],
		]);
	});

	it('carries every per-terminal field through unchanged', () => {
		const [t] = buildFloorState(input()).terminals;
		expect(t).toEqual({ id: 1, name: 'ax-a1', kind: 'terminal', repo: 'app', branch: 'wt/main-1', worktreePath: 'C:/wt/app/wt-main-1', busy: true, hidden: false, tellable: true, snapshotFile: '1-ax-a1.md' });
	});

	it('flattens worktree entries to counts and a computed state', () => {
		const s = buildFloorState(input({ worktrees: [
			entry({ dirtyFiles: ['a.ts', 'b.ts'] }),
			entry({ branch: 'wt/main-2', terminal: null, parked: true, base: undefined, lastCommitAt: null }),
			entry({ branch: 'wt/main-3', ahead: 2, behind: 1 }),
		] }));
		expect(s.worktrees.scannedAt).toBe(4000);
		expect(s.worktrees.entries).toEqual([
			{ repo: 'app', branch: 'wt/main-1', path: 'C:/wt/app/wt-main-1', terminal: 'ax-a1', state: 'dirty', dirtyFiles: 2, ahead: 0, behind: 0, base: 'main', lastCommitAt: 1000 },
			{ repo: 'app', branch: 'wt/main-2', path: 'C:/wt/app/wt-main-1', terminal: null, state: 'parked', dirtyFiles: 0, ahead: 0, behind: 0, base: null, lastCommitAt: null },
			{ repo: 'app', branch: 'wt/main-3', path: 'C:/wt/app/wt-main-1', terminal: 'ax-a1', state: 'ahead', dirtyFiles: 0, ahead: 2, behind: 1, base: 'main', lastCommitAt: 1000 },
		]);
	});

	it('reports no scan yet as scannedAt null with no entries, not as an empty floor', () => {
		const s = buildFloorState(input({ scannedAt: null, worktrees: [entry()] }));
		expect(s.worktrees).toEqual({ scannedAt: null, entries: [] });
	});

	it('handles an empty floor', () => {
		expect(buildFloorState(input({ sessions: [] })).terminals).toEqual([]);
	});
});

describe('renderFloorState', () => {
	it('round-trips through JSON and ends in a newline', () => {
		const s = buildFloorState(input());
		const text = renderFloorState(s);
		expect(text.endsWith('\n')).toBe(true);
		expect(JSON.parse(text)).toEqual(s);
	});
});
