import { describe, it, expect } from 'vitest';
import { buildTeam, triageTeam, OVERSEER_ROLE, UNASSIGNED_TEXT, type TeamNode, type TeamSession, type TeamTree } from '../src/core/team';

const ses = (key: number, parent?: string, role = 'worker-terminal'): TeamSession =>
	({ key, sessionId: `s${key}`, role, ...(parent ? { parentSessionId: parent } : {}) });
const alpha = (key = -1): TeamSession => ses(key, undefined, OVERSEER_ROLE);

/** The tree as nested keys, for readable assertions. */
type Shape = Array<number | [number, Shape]>;
const shape = (ns: readonly TeamNode[]): Shape => ns.map((n) => (n.children.length ? [n.session.key, shape(n.children)] : n.session.key));
const allKeys = (t: TeamTree): number[] => {
	const out: number[] = [];
	const walk = (n: TeamNode): void => { out.push(n.session.key); n.children.forEach(walk); };
	t.overseers.forEach(walk); t.unassigned.forEach(walk);
	return out.sort((a, b) => a - b);
};

describe('buildTeam — placement', () => {
	it('pins a role-alpha session as an overseer root and nests what it spawned', () => {
		const t = buildTeam([ses(1, 's-1'), alpha(), ses(2, 's-1')]);
		expect(shape(t.overseers)).toEqual([[-1, [1, 2]]]);
		expect(t.unassigned).toEqual([]);
	});

	it('nests grandchildren under their own parent, not the overseer', () => {
		const t = buildTeam([alpha(), ses(1, 's-1'), ses(2, 's1'), ses(3, 's2')]);
		expect(shape(t.overseers)).toEqual([[-1, [[1, [[2, [3]]]]]]]);
	});

	it('ignores an overseer\'s own parent — it is always a root', () => {
		const t = buildTeam([ses(1), { ...alpha(5), parentSessionId: 's1' }]);
		expect(shape(t.overseers)).toEqual([5]);
		expect(shape(t.unassigned)).toEqual([1]);
	});

	it('puts a session with no parent in UNASSIGNED with the reason', () => {
		const t = buildTeam([alpha(), ses(1)]);
		expect(t.unassigned.map((u) => [u.session.key, u.reason])).toEqual([[1, 'no-parent']]);
	});

	it('puts a session whose parent is closed in UNASSIGNED, and keeps its own children under it', () => {
		const t = buildTeam([alpha(), ses(1, 's99'), ses(2, 's1')]);
		expect(t.unassigned.map((u) => u.reason)).toEqual(['parent-closed']);
		expect(shape(t.unassigned)).toEqual([[1, [2]]]);
	});

	it('flags a session that names itself as its parent', () => {
		const t = buildTeam([ses(1, 's1')]);
		expect(t.unassigned.map((u) => u.reason)).toEqual(['self-parent']);
	});

	it('cuts a lineage loop at its first-opened member instead of losing the loop', () => {
		const t = buildTeam([ses(3, 's2'), ses(2, 's3'), ses(7, 's3')]);
		expect(t.unassigned.map((u) => [u.session.key, u.reason])).toEqual([[2, 'cycle']]);
		expect(shape(t.unassigned)).toEqual([[2, [[3, [7]]]]]);
	});

	it('has readable text for every reason', () => {
		for (const r of ['no-parent', 'parent-closed', 'self-parent', 'cycle'] as const) expect(UNASSIGNED_TEXT[r]).toMatch(/\w/);
	});
});

describe('buildTeam — invariants', () => {
	it('returns every session exactly once, whatever the edges', () => {
		const input = [alpha(), ses(1, 's-1'), ses(2, 's1'), ses(3, 'gone'), ses(4), ses(5, 's6'), ses(6, 's5'), ses(8, 's8'), ses(9, 's3')];
		expect(allKeys(buildTeam(input))).toEqual(input.map((s) => s.key).sort((a, b) => a - b));
	});

	it('keeps a duplicated sessionId placeable — the lower key owns it, the other still appears', () => {
		const t = buildTeam([ses(1), { ...ses(2), sessionId: 's1' }, ses(3, 's1')]);
		expect(allKeys(t)).toEqual([1, 2, 3]);
		expect(shape(t.unassigned)).toEqual([[1, [3]], 2]);
	});

	it('orders every level by key (declared order), whatever order the input came in', () => {
		const t = buildTeam([ses(9, 's-1'), ses(4), alpha(), ses(2, 's-1'), ses(1)]);
		expect(shape(t.overseers)).toEqual([[-1, [2, 9]]]);
		expect(shape(t.unassigned)).toEqual([1, 4]);
	});

	it('is deterministic and does not mutate its input', () => {
		const input = Object.freeze([alpha(), ses(2, 's-1'), ses(1, 'x')].map((s) => Object.freeze(s)));
		const a = buildTeam(input), b = buildTeam(input);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it('handles an empty floor', () => {
		expect(buildTeam([])).toEqual({ overseers: [], unassigned: [] });
	});
});

describe('triageTeam', () => {
	// Lower = worse: 0 needs you, 1 refused, 2 running, 3 idle.
	const sev = (m: Record<number, number>) => (s: TeamSession) => m[s.key] ?? 3;

	it('sorts within each level only — a blocked grandchild pulls its branch up and keeps its parent', () => {
		// overseer → 1 (idle) → 3 (blocked); overseer → 2 (running)
		const t = buildTeam([alpha(), ses(1, 's-1'), ses(2, 's-1'), ses(3, 's1')]);
		const sorted = triageTeam(t.overseers, sev({ 2: 2, 3: 0 }));
		expect(shape(sorted)).toEqual([[-1, [[1, [3]], 2]]]);
	});

	it('never moves a row to another parent', () => {
		const t = buildTeam([alpha(), ses(1, 's-1'), ses(2, 's-1'), ses(3, 's2'), ses(4, 's1')]);
		const sorted = triageTeam(t.overseers, sev({ 3: 0, 4: 2 }));
		const parentOf = (ns: readonly TeamNode[], p: number | null, out = new Map<number, number | null>()) => {
			for (const n of ns) { out.set(n.session.key, p); parentOf(n.children, n.session.key, out); }
			return out;
		};
		expect(parentOf(sorted, null)).toEqual(parentOf(t.overseers, null));
		expect(shape(sorted)).toEqual([[-1, [[2, [3]], [1, [4]]]]]);
	});

	it('is stable: equal branches keep declared order, whatever the input order', () => {
		const t = buildTeam([ses(5), ses(2), ses(9), ses(1)]);
		expect(shape(triageTeam(t.unassigned, () => 2))).toEqual([1, 2, 5, 9]);
		expect(shape(triageTeam(t.unassigned, sev({ 9: 0, 5: 0 })))).toEqual([5, 9, 1, 2]);
	});

	it('keeps the unassigned reason on the sorted copies and leaves the input alone', () => {
		const t = buildTeam([ses(1), ses(2, 'gone')]);
		const before = JSON.stringify(t);
		const sorted = triageTeam(t.unassigned, sev({ 2: 0 }));
		expect(sorted.map((u) => [u.session.key, u.reason])).toEqual([[2, 'parent-closed'], [1, 'no-parent']]);
		expect(JSON.stringify(t)).toBe(before);
	});
});
