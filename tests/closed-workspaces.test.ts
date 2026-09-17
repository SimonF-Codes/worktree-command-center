import { describe, it, expect } from 'vitest';
import {
	CLOSED_WORKSPACES_CAP, archiveSessionsKey, isArchiveSessionsKey,
	normalizeClosedWorkspaces, archiveWorkspace, takeClosedWorkspace, insertAt,
	type ClosedWorkspace,
} from '../src/terminals/closed-workspaces';

const entry = (id: string, closedAt: number, extra: Partial<ClosedWorkspace> = {}): ClosedWorkspace => ({
	id, name: id, closedAt, sessionsKey: archiveSessionsKey(id, closedAt),
	index: 0, tileCount: 0, ...extra,
});

describe('archiveSessionsKey', () => {
	it('namespaces the archived bucket so it can never collide with a live workspace id', () => {
		expect(archiveSessionsKey('qmk-flasher', 1700)).toBe('closed:qmk-flasher:1700');
		expect(isArchiveSessionsKey('closed:qmk-flasher:1700')).toBe(true);
		expect(isArchiveSessionsKey('qmk-flasher')).toBe(false);
	});
});

describe('normalizeClosedWorkspaces', () => {
	it('orders most recent first and caps', () => {
		const many = Array.from({ length: CLOSED_WORKSPACES_CAP + 4 }, (_, i) => entry(`w${i}`, i));
		const norm = normalizeClosedWorkspaces(many);
		expect(norm).toHaveLength(CLOSED_WORKSPACES_CAP);
		expect(norm[0]!.id).toBe(`w${CLOSED_WORKSPACES_CAP + 3}`);
	});
	it('drops entries that could never be restored, and dedupes by sessions key', () => {
		const raw = [
			entry('good', 5),
			{ id: 'no-key', name: 'x', closedAt: 9 },
			{ sessionsKey: 'closed:no-id:1', closedAt: 9 },
			'junk',
			entry('good', 5),
		];
		expect(normalizeClosedWorkspaces(raw).map((e) => e.id)).toEqual(['good']);
	});
	it('defaults the soft fields rather than rejecting an older entry', () => {
		const [e] = normalizeClosedWorkspaces([{ id: 'a', sessionsKey: 'closed:a:1' }]);
		expect(e).toEqual({ id: 'a', name: 'a', closedAt: 0, sessionsKey: 'closed:a:1', index: 0, tileCount: 0 });
	});
	it('keeps the toolbar state carried on the entry', () => {
		const [e] = normalizeClosedWorkspaces([entry('a', 1, { toolbar: { repo: 'QMK-Flasher', branch: 'main' } })]);
		expect(e!.toolbar).toEqual({ repo: 'QMK-Flasher', branch: 'main' });
	});
	it('survives junk', () => {
		expect(normalizeClosedWorkspaces(undefined)).toEqual([]);
		expect(normalizeClosedWorkspaces({})).toEqual([]);
	});
});

describe('archiveWorkspace', () => {
	it('puts the newest tombstone first and evicts nothing under the cap', () => {
		const r = archiveWorkspace([entry('a', 1)], entry('b', 2));
		expect(r.list.map((e) => e.id)).toEqual(['b', 'a']);
		expect(r.evicted).toEqual([]);
	});
	it('does not mutate the archive it was given', () => {
		const before = [entry('a', 1)];
		archiveWorkspace(before, entry('b', 2));
		expect(before.map((e) => e.id)).toEqual(['a']);
	});
	// The cap exists so config.json cannot grow without bound; the evicted list exists so the
	// tiles that entry pointed at do not linger unreachable in .terminal-sessions.json forever,
	// which is the leak the original hard deletes were added to fix.
	it('evicts the oldest at the cap and names it so its sessions key can be deleted too', () => {
		let list: ClosedWorkspace[] = [];
		for (let i = 0; i < CLOSED_WORKSPACES_CAP; i++) list = archiveWorkspace(list, entry(`w${i}`, i)).list;
		const r = archiveWorkspace(list, entry('newest', 999));
		expect(r.list).toHaveLength(CLOSED_WORKSPACES_CAP);
		expect(r.evicted.map((e) => e.id)).toEqual(['w0']);
		expect(r.evicted[0]!.sessionsKey).toBe(archiveSessionsKey('w0', 0));
		expect(r.list.some((e) => e.id === 'w0')).toBe(false);
	});
	it('replaces an entry with the same sessions key instead of storing it twice', () => {
		const r = archiveWorkspace([entry('a', 1, { tileCount: 1 })], entry('a', 1, { tileCount: 7 }));
		expect(r.list).toHaveLength(1);
		expect(r.list[0]!.tileCount).toBe(7);
	});
});

describe('takeClosedWorkspace', () => {
	it('removes the entry it returns', () => {
		const archive = [entry('b', 2), entry('a', 1)];
		const r = takeClosedWorkspace(archive, archiveSessionsKey('a', 1))!;
		expect(r.entry.id).toBe('a');
		expect(r.list.map((e) => e.id)).toEqual(['b']);
	});
	it('is null for an entry already restored — a second Undo click is a no-op', () => {
		expect(takeClosedWorkspace([], 'closed:a:1')).toBeNull();
	});
});

describe('insertAt', () => {
	it('puts a restored tab back at its old index', () => {
		expect(insertAt(['a', 'c'], 'b', 1)).toEqual(['a', 'b', 'c']);
	});
	it('clamps an index the bar has since outgrown', () => {
		expect(insertAt(['a'], 'b', 9)).toEqual(['a', 'b']);
		expect(insertAt(['a'], 'b', -3)).toEqual(['b', 'a']);
		expect(insertAt(['a'], 'b', NaN)).toEqual(['a', 'b']);
	});
});
