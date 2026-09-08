import { describe, it, expect } from 'vitest';
import {
	pickCloseRecords, summarizeClose, riskProbeTargets, riskReason,
	closeConfirmMessage, buildCloseConfirm, MAX_LISTED, type CloseRecord,
} from '../src/terminals/close-summary';

const term = (name: string, branch: string, extra: Partial<CloseRecord> = {}): CloseRecord => ({
	kind: 'terminal', name, branch, repoName: 'QMK-Flasher',
	worktreePath: `C:/wt/${branch}`, baseBranch: 'main', ...extra,
});

describe('pickCloseRecords', () => {
	// THE BUG: app.ts constructs every workspace's grid at startup but only mounts the active
	// one, so an unvisited tab's live tile list is empty however many terminals it has saved.
	it('uses the persisted records when the grid is not authoritative', () => {
		const persisted = [term('Fix auth', 'wt/main-4'), term('Board view', 'wt/main-7')];
		const picked = pickCloseRecords(null, persisted);
		expect(picked.source).toBe('persisted');
		expect(picked.records).toHaveLength(2);
	});
	it('prefers the live records when the grid has restored its sessions', () => {
		const picked = pickCloseRecords([term('Live', 'wt/main-1')], [term('Stale', 'wt/main-9')]);
		expect(picked.source).toBe('live');
		expect(picked.records[0]!.name).toBe('Live');
	});
	it('trusts an authoritative grid that really is empty', () => {
		expect(pickCloseRecords([], [term('Stale', 'wt/main-9')]).records).toEqual([]);
	});
});

describe('summarizeClose', () => {
	it('splits terminals, journals and consoles', () => {
		const s = summarizeClose([
			term('Fix auth', 'wt/main-4'),
			{ kind: 'journal', name: 'Notes' },
			{ kind: 'god', name: 'Kane' },
			{ name: 'No kind', branch: 'wt/main-2', repoName: 'r', worktreePath: 'p', baseBranch: 'main' },
		], 'persisted');
		expect(s.total).toBe(4);
		expect(s.terminals.map((t) => t.label)).toEqual(['Fix auth', 'No kind']);
		expect(s.journals).toBe(1);
		expect(s.consoles).toBe(1);
	});
	it('labels a terminal by repo / branch, and a folder target by its path', () => {
		const s = summarizeClose([
			term('Fix auth', 'wt/main-4'),
			{ kind: 'terminal', name: 'Docs', folder: true, worktreePath: 'C:/notes', repoName: 'notes' },
		], 'live');
		expect(s.terminals[0]!.detail).toBe('QMK-Flasher / wt/main-4');
		expect(s.terminals[1]!.detail).toBe('C:/notes');
	});
	it('survives junk', () => {
		expect(summarizeClose([], 'persisted').total).toBe(0);
		expect(summarizeClose(undefined as unknown as CloseRecord[], 'persisted').total).toBe(0);
	});
});

describe('riskProbeTargets', () => {
	it('dedupes by path and skips folder targets and pathless records', () => {
		const s = summarizeClose([
			term('A', 'wt/main-4'),
			term('B', 'wt/main-4'),
			{ kind: 'terminal', name: 'Docs', folder: true, worktreePath: 'C:/notes' },
		], 'persisted');
		expect(riskProbeTargets(s)).toEqual([{ worktreePath: 'C:/wt/wt/main-4', baseBranch: 'main' }]);
	});
});

describe('riskReason', () => {
	it('names uncommitted files and unmerged commits', () => {
		expect(riskReason({ dirtyFiles: 4, unpushed: 0 })).toBe('4 uncommitted files');
		expect(riskReason({ dirtyFiles: 0, unpushed: 1 })).toBe('1 unmerged commit');
		expect(riskReason({ dirtyFiles: 1, unpushed: 2 })).toBe('1 uncommitted file, 2 unmerged commits');
	});
	it('is empty for a clean worktree, and never silent about an unverified one', () => {
		expect(riskReason({ dirtyFiles: 0, unpushed: 0 })).toBe('');
		expect(riskReason(undefined)).toBe('');
		expect(riskReason({ dirtyFiles: 0, unpushed: 0, unknown: true })).toBe('could not be checked');
	});
});

describe('closeConfirmMessage', () => {
	it('still confirms an empty tab, with one line', () => {
		const msg = closeConfirmMessage('scratch', summarizeClose([], 'persisted'));
		expect(msg).toBe('"scratch" has no saved terminals. Closing removes the tab.');
	});

	// ACCEPTANCE: the tab that was lost — never visited this launch, so the live grid says 0.
	it('describes an unmounted workspace from its persisted tiles', () => {
		const picked = pickCloseRecords(null, [term('Flash', 'wt/main-1'), term('Layout', 'wt/main-2')]);
		const msg = closeConfirmMessage('QMK-Flasher', summarizeClose(picked.records, picked.source));
		expect(msg).toContain('"QMK-Flasher" has 2 terminals saved');
		expect(msg).toContain('• Flash — QMK-Flasher / wt/main-1');
		expect(msg).toContain('• Layout — QMK-Flasher / wt/main-2');
	});

	it('warns specifically about the worktrees git cannot give back', () => {
		const s = summarizeClose([term('Flash', 'wt/main-1'), term('Layout', 'wt/main-2')], 'persisted');
		const msg = closeConfirmMessage('QMK-Flasher', s, {
			'C:/wt/wt/main-1': { dirtyFiles: 3, unpushed: 0 },
			'C:/wt/wt/main-2': { dirtyFiles: 0, unpushed: 0 },
		});
		expect(msg).toContain('⚠ 1 worktree has work git cannot give back');
		expect(msg).toContain('• Flash — 3 uncommitted files');
		expect(msg).not.toContain('• Layout — 0');
	});

	it('says so when every worktree is clean', () => {
		const s = summarizeClose([term('Flash', 'wt/main-1')], 'live');
		expect(closeConfirmMessage('QMK-Flasher', s, { 'C:/wt/wt/main-1': { dirtyFiles: 0, unpushed: 0 } }))
			.toContain('Every worktree is clean');
	});

	it('collapses a long tile list instead of running off the dialog', () => {
		const many = Array.from({ length: 18 }, (_, i) => term(`T${i}`, `wt/main-${i}`));
		const msg = closeConfirmMessage('big', summarizeClose(many, 'persisted'));
		expect(msg).toContain(`+${18 - MAX_LISTED} more`);
		expect(msg).not.toContain('T17 —');
	});

	it('names journals and consoles alongside the terminals', () => {
		const s = summarizeClose([term('Flash', 'wt/main-1'), { kind: 'journal' }, { kind: 'god' }], 'persisted');
		expect(closeConfirmMessage('mix', s)).toContain('1 terminal, 1 journal and a workspace console');
	});
});

describe('buildCloseConfirm', () => {
	it('scales the OK label to what is being destroyed', () => {
		expect(buildCloseConfirm('scratch', summarizeClose([], 'persisted')).okLabel).toBe('Close');
		const two = buildCloseConfirm('qmk', summarizeClose([term('a', 'x'), term('b', 'y')], 'persisted'));
		expect(two.okLabel).toBe('Close and stop 2 sessions');
		expect(two.title).toBe('Close workspace "qmk"?');
	});
});
