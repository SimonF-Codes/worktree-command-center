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

// ---- V2 Team Floor step 10: delegation. The ★ from spawns:, and an invalid edge confers nothing.

import { lookupFrom, type DelegationRole } from '../src/core/delegation';
import { findNode, placedParentOf, descendantsOf, isUnassignedRoot, unassignedText, type UnassignedNode } from '../src/core/team';

const drole = (slug: string, authority: string, spawns: string[] = []): DelegationRole => ({ slug, authority, spawns });
const roles = lookupFrom([
	// Alpha's spawns: must list (and cover the spawns: of) every role these tests open under it.
	drole('alpha', 'operator', ['worker-terminal', 'team-lead', 'researcher']),
	drole('team-lead', 'operator', ['worker-terminal', 'researcher']),
	drole('worker-terminal', 'operator'),
	drole('researcher', 'proposer'),
	drole('auditor', 'autonomous'),
]);

describe('buildTeam — with delegation (v2.managers)', () => {
	it('marks ★ from spawns: — a manager with no children keeps it', () => {
		const t = buildTeam([alpha(), ses(1, 's-1', 'team-lead')], { delegation: roles });
		expect(t.overseers[0]!.children[0]!.manager).toBe(true);
		expect(t.overseers[0]!.children[0]!.children).toEqual([]);
	});

	it('a session with children it was not permitted to spawn gets no ★, and the children go unassigned', () => {
		// worker 1 has "children" 2 and 3, but worker-terminal declares no spawns:
		const t = buildTeam([alpha(), ses(1, 's-1'), ses(2, 's1'), ses(3, 's1', 'researcher')], { delegation: roles });
		const w1 = findNode(t, 's1')!;
		expect(w1.manager).toBeUndefined();
		expect(w1.children).toEqual([]);
		expect(t.unassigned.map((u) => [u.session.key, u.reason])).toEqual([[2, 'outside-delegation'], [3, 'outside-delegation']]);
		expect(unassignedText(t.unassigned[0]!)).toBe("outside delegation: worker-terminal may not spawn worker-terminal — condition 1 of 3 (listed): worker-terminal has no spawns:, so it starts nothing");
	});

	it('a valid manager edge nests; each failing condition is named in the reason', () => {
		const t = buildTeam([
			alpha(), ses(1, 's-1', 'team-lead'),
			ses(2, 's1'), // ok: listed, operator ≤ operator
			ses(3, 's1', 'researcher'), // ok
			ses(4, 's1', 'auditor'), // not listed
		], { delegation: roles });
		expect(shape(t.overseers)).toEqual([[-1, [[1, [2, 3]]]]]);
		const four = t.unassigned.find((u) => u.session.key === 4)!;
		expect(four.detail).toContain('condition 1 of 3 (listed)');
	});

	it('a child whose role has no active file is outside delegation (fails closed)', () => {
		const t = buildTeam([alpha(), ses(1, 's-1', 'team-lead'), ses(2, 's1', 'ghost')], { delegation: roles });
		expect(t.unassigned[0]!.reason).toBe('outside-delegation');
		expect((t.unassigned[0] as UnassignedNode).detail).toContain('declares role: ghost');
	});

	it('edges from the overseer are checked against its role file like any other', () => {
		const t = buildTeam([alpha(), ses(1, 's-1'), ses(2, 's-1', 'auditor')], { delegation: roles });
		expect(shape(t.overseers)).toEqual([[-1, [1]]]);
		expect(t.unassigned.map((u) => [u.session.key, u.reason])).toEqual([[2, 'outside-delegation']]);
		expect(unassignedText(t.unassigned[0]!)).toBe("outside delegation: alpha may not spawn auditor — condition 1 of 3 (listed): auditor is not in alpha's spawns: (worker-terminal, team-lead, researcher)");
	});

	it('an overseer whose role file declares no spawns: places no children', () => {
		const bare = lookupFrom([drole('alpha', 'operator'), drole('worker-terminal', 'operator')]);
		const t = buildTeam([alpha(), ses(1, 's-1')], { delegation: bare });
		expect(t.overseers[0]!.children).toEqual([]);
		expect(t.unassigned[0]!.reason).toBe('outside-delegation');
	});

	it('an overseer with no active role file places no children (fails closed)', () => {
		const t = buildTeam([alpha(), ses(1, 's-1')], { delegation: lookupFrom([drole('worker-terminal', 'operator')]) });
		expect((t.unassigned[0] as UnassignedNode).detail).toContain('declares role: alpha');
	});

	it('an invalid edge confers nothing below it either: its own valid children stay with it, unassigned', () => {
		const t = buildTeam([alpha(), ses(1, 's-1'), ses(2, 's1', 'team-lead'), ses(3, 's2')], { delegation: roles });
		expect(shape(t.unassigned)).toEqual([[2, [3]]]);
		expect(findNode(t, 's2')!.manager).toBe(true);
	});

	it('every session still comes back exactly once', () => {
		const ss = [alpha(), ses(1, 's-1', 'team-lead'), ses(2, 's1'), ses(3, 's2'), ses(4, 's3', 'team-lead'), ses(5, 's5'), ses(6, 's7'), ses(7, 's6')];
		expect(allKeys(buildTeam(ss, { delegation: roles }))).toEqual([-1, 1, 2, 3, 4, 5, 6, 7]);
	});

	it('off (no lookup): exactly step 7 — nothing marked, nothing refused', () => {
		const ss = [alpha(), ses(1, 's-1'), ses(2, 's1'), ses(3, 's1', 'team-lead')];
		const t = buildTeam(ss);
		expect(shape(t.overseers)).toEqual([[-1, [[1, [2, 3]]]]]);
		expect(findNode(t, 's3')!.manager).toBeUndefined();
	});
});

describe('reading a built tree', () => {
	const t = buildTeam([alpha(), ses(1, 's-1', 'team-lead'), ses(2, 's1'), ses(3, 's1', 'researcher'), ses(4)], { delegation: roles });
	it('findNode / placedParentOf / descendantsOf / isUnassignedRoot', () => {
		expect(findNode(t, 's2')!.session.key).toBe(2);
		expect(findNode(t, 'nope')).toBeUndefined();
		expect(placedParentOf(t, 's3')!.key).toBe(1);
		expect(placedParentOf(t, 's-1')).toBeNull();
		expect(placedParentOf(t, 's4')).toBeNull();
		expect(descendantsOf(findNode(t, 's1')!).map((s) => s.key)).toEqual([2, 3]);
		expect(isUnassignedRoot(t, 's4')).toBe(true);
		expect(isUnassignedRoot(t, 's3')).toBe(false);
	});
});
