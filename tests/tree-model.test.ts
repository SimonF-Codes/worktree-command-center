import { describe, it, expect } from 'vitest';
import { buildTeam, type TeamSession } from '../src/core/team';
import { layoutTree, siblingsOf, stepSelection, readingOrder, minTreeWidth, DEFAULT_TREE_METRICS as M, UNCHECKED_TEXT, type NodeCard } from '../src/core/tree-model';
import type { RoleLookup } from '../src/core/delegation';

const ses = (key: number, sessionId: string, role: string, parentSessionId?: string): TeamSession =>
	({ key, sessionId, role, ...(parentSessionId ? { parentSessionId } : {}) });
const card = (key: number, over: Partial<NodeCard> = {}): NodeCard =>
	({ key, name: `s${key}`, role: 'worker-terminal', branch: `wt/${key}`, isolation: 'wt', dot: 'running', manager: false, proposals: 0, attention: null, ...over });
const cardsFor = (sessions: TeamSession[]) => new Map(sessions.map((s) => [s.key, card(s.key)]));

const ALPHA = ses(-1, 'a', 'alpha');

describe('layoutTree — root at the left, depth running right', () => {
	it('places each depth in its own column and every session exactly once', () => {
		const sessions = [ALPHA, ses(1, 'w1', 'worker-terminal', 'a'), ses(2, 'w2', 'worker-terminal', 'w1'), ses(3, 'w3', 'worker-terminal', 'a')];
		const t = layoutTree(buildTeam(sessions), cardsFor(sessions));
		const x = Object.fromEntries(t.nodes.map((n) => [n.key, n.x]));
		expect(x[-1]).toBe(M.pad);
		expect(x[1]).toBe(M.pad + M.cardW + M.colGap);
		expect(x[3]).toBe(x[1]);
		expect(x[2]).toBe(M.pad + 2 * (M.cardW + M.colGap));
		expect(t.nodes.map((n) => n.key).sort((a, b) => a - b)).toEqual([-1, 1, 2, 3]);
		expect(t.width).toBe(x[2]! + M.cardW + M.pad);
	});

	it('centres a parent on its first and last child', () => {
		const sessions = [ALPHA, ses(1, 'w1', 'w', 'a'), ses(2, 'w2', 'w', 'a'), ses(3, 'w3', 'w', 'a')];
		const t = layoutTree(buildTeam(sessions), cardsFor(sessions));
		const y = Object.fromEntries(t.nodes.map((n) => [n.key, n.y]));
		expect(y[-1]).toBe((y[1]! + y[3]!) / 2);
		expect(y[2]).toBe(y[-1]);
	});

	it('is deterministic: the same input draws the same output', () => {
		const sessions = [ALPHA, ses(1, 'w1', 'w', 'a'), ses(4, 'w4', 'w', 'w1'), ses(2, 'w2', 'w')];
		const a = layoutTree(buildTeam(sessions), cardsFor(sessions));
		const b = layoutTree(buildTeam([...sessions].reverse()), cardsFor(sessions));
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it('draws edges out of the parent\'s right edge into the child\'s left', () => {
		const sessions = [ALPHA, ses(1, 'w1', 'w', 'a')];
		const t = layoutTree(buildTeam(sessions), cardsFor(sessions));
		const [p, c] = [t.nodes.find((n) => n.key === -1)!, t.nodes.find((n) => n.key === 1)!];
		expect(t.edges).toHaveLength(1);
		expect(t.edges[0]!.d).toBe(`M${p.x + p.w} ${p.y + p.h / 2} H${p.x + p.w + M.colGap / 2} V${c.y + c.h / 2} H${c.x}`);
	});
});

describe('one session', () => {
	it('is one card and no edges: a strip one card wide', () => {
		const sessions = [ses(1, 'w1', 'worker-terminal')];
		const t = layoutTree(buildTeam(sessions), cardsFor(sessions));
		expect(t.nodes).toHaveLength(1);
		expect(t.edges).toHaveLength(0);
		expect(t.width).toBe(minTreeWidth());
	});

	it('an empty floor draws nothing and asks for no width', () => {
		const t = layoutTree(buildTeam([]), new Map());
		expect(t).toEqual({ nodes: [], edges: [], width: 0, height: 0, unassignedLabelY: null });
	});
});

describe('twelve siblings under one parent', () => {
	const kids = Array.from({ length: 12 }, (_, i) => ses(i + 1, `w${i + 1}`, 'w', 'a'));
	const sessions = [ALPHA, ...kids];

	it('make a tall column: twelve rows, one column, the parent at its middle', () => {
		const t = layoutTree(buildTeam(sessions), cardsFor(sessions));
		const col = t.nodes.filter((n) => n.depth === 1);
		expect(new Set(col.map((n) => n.x)).size).toBe(1);
		expect(col.map((n) => n.y)).toEqual(Array.from({ length: 12 }, (_, i) => M.pad + i * (M.cardH + M.rowGap)));
		expect(t.height).toBe(M.pad + 11 * (M.cardH + M.rowGap) + M.cardH + M.pad);
		expect(t.nodes.find((n) => n.key === -1)!.y).toBe((col[0]!.y + col[11]!.y) / 2);
	});

	it('collapsing the parent hides the column and says how many it hides', () => {
		const t = layoutTree(buildTeam(sessions), cardsFor(sessions), { collapsed: new Set(['a']) });
		expect(t.nodes).toHaveLength(1);
		expect(t.nodes[0]!.hiddenBelow).toBe(12);
		expect(t.nodes[0]!.hasChildren).toBe(true);
		expect(t.edges).toHaveLength(0);
		expect(t.height).toBe(M.pad + M.cardH + M.pad);
	});

	it('Alt+←/→ steps through the siblings and wraps', () => {
		const t = layoutTree(buildTeam(sessions), cardsFor(sessions));
		expect(siblingsOf(t, 5).map((n) => n.key)).toEqual(kids.map((k) => k.key));
		expect(stepSelection(t, 5, 1)).toBe(6);
		expect(stepSelection(t, 12, 1)).toBe(1);
		expect(stepSelection(t, 1, -1)).toBe(12);
		expect(stepSelection(t, -1, 1)).toBe(-1); // the root has no siblings
		expect(stepSelection(t, null, 1)).toBe(-1); // nothing selected: the first node drawn
	});
});

describe('edges — lineage, the overseer\'s marked unchecked', () => {
	it('marks every edge out of the overseer as unchecked, with its reason', () => {
		const sessions = [ALPHA, ses(1, 'w1', 'mgr', 'a'), ses(2, 'w2', 'w', 'w1')];
		const t = layoutTree(buildTeam(sessions), cardsFor(sessions), { delegationOn: false });
		const e = Object.fromEntries(t.edges.map((x) => [`${x.from}>${x.to}`, x.unchecked]));
		expect(e['-1>1']).toBe('overseer');
		expect(e['1>2']).toBe('delegation-off');
		expect(UNCHECKED_TEXT.overseer).toMatch(/no spawns: key/);
	});

	it('with delegation on, an edge it accepted between two sessions is checked; the overseer\'s still is not', () => {
		const roles: RoleLookup = (slug) => ({
			alpha: { slug: 'alpha', authority: 'autonomous', spawns: ['mgr', 'w'] },
			mgr: { slug: 'mgr', authority: 'operator', spawns: ['w'] },
			w: { slug: 'w', authority: 'operator', spawns: [] },
		} as Record<string, never>)[slug];
		const sessions = [ALPHA, ses(1, 'w1', 'mgr', 'a'), ses(2, 'w2', 'w', 'w1')];
		const tree = buildTeam(sessions, { delegation: roles });
		const t = layoutTree(tree, cardsFor(sessions), { delegationOn: true });
		const e = Object.fromEntries(t.edges.map((x) => [`${x.from}>${x.to}`, x.unchecked]));
		expect(e['1>2']).toBeNull();
		expect(e['-1>1']).toBe('overseer');
	});

	it('an unassigned root carries its reason, in the sidebar\'s words, below a label', () => {
		const sessions = [ALPHA, ses(1, 'w1', 'w'), ses(2, 'w2', 'w', 'gone')];
		const t = layoutTree(buildTeam(sessions), cardsFor(sessions));
		const un = t.nodes.filter((n) => n.group === 'unassigned');
		expect(un.map((n) => [n.key, n.reason])).toEqual([[1, 'no parent — opened by hand'], [2, 'parent session is closed']]);
		expect(t.unassignedLabelY).not.toBeNull();
		expect(Math.min(...un.map((n) => n.y))).toBeGreaterThanOrEqual(t.unassignedLabelY! + M.headerH);
	});

	it('never drops a session it has no card for', () => {
		const sessions = [ALPHA, ses(1, 'w1', 'w', 'a')];
		const t = layoutTree(buildTeam(sessions), new Map());
		expect(t.nodes.map((n) => n.card.name).sort()).toEqual(['-1', '1']);
	});
});

describe('readingOrder', () => {
	it('hands badges out depth first: the root, then its children top to bottom', () => {
		const sessions = [ALPHA, ses(1, 'w1', 'w', 'a'), ses(2, 'w2', 'w', 'a')];
		const t = layoutTree(buildTeam(sessions), cardsFor(sessions));
		expect(readingOrder(t).map((n) => n.key)).toEqual([-1, 1, 2]);
	});
});
