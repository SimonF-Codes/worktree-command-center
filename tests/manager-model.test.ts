import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lookupFrom } from '../src/core/delegation';
import type { SpawnProposal } from '../src/core/proposals';
import { buildManagerView, openProposalCounts, DECIDED_SHOWN, type ManagerFloorSession } from '../src/ui/manager-model';
import { buildSidebar, OVERSEER_ID, type SidebarSession } from '../src/ui/sidebar-model';

const lookup = lookupFrom([
	{ slug: 'alpha', authority: 'operator', spawns: [] },
	{ slug: 'team-lead', authority: 'operator', spawns: ['worker-terminal', 'researcher'] },
	{ slug: 'worker-terminal', authority: 'operator', spawns: [] },
	{ slug: 'researcher', authority: 'proposer', spawns: [] },
]);
const ms = (key: number, sessionId: string, name: string, role: string, parent?: string, state = 'running'): ManagerFloorSession =>
	({ key, sessionId, name, role, state, branch: `wt/${name}`, ...(parent ? { parentSessionId: parent } : {}) });
const sessions: ManagerFloorSession[] = [
	ms(-1, 'kane', 'Alpha', 'alpha'),
	ms(1, 'lead', 'Lead', 'team-lead', 'kane'),
	ms(2, 'w2', 'W2', 'worker-terminal', 'lead', 'prompt'),
	ms(3, 'w3', 'W3', 'worker-terminal', 'w2'), // outside delegation: not on Lead's team
	ms(4, 'r4', 'R4', 'researcher', 'lead'),
];
const prop = (id: string, over: Partial<SpawnProposal> = {}): SpawnProposal => ({
	id, ts: 1, from: { sessionId: 'w2', role: 'worker-terminal', name: 'W2' }, to: 'lead', workstreamId: null,
	role: 'researcher', task: `task ${id}`, why: 'it splits', state: 'open', ...over,
});
const view = (proposals: SpawnProposal[] = [], who = 'lead', ss = sessions) =>
	buildManagerView({ managerSessionId: who, lastKnownName: 'Lead', sessions: ss, lookup, proposals });

describe('buildManagerView — a presentation of the role file and the tree', () => {
	it('header: role, rung and spawns: straight from the role file; where it sits', () => {
		const v = view();
		expect(v).toMatchObject({ vacant: false, name: 'Lead', role: 'team-lead', authority: 'operator', rungKnown: true, manager: true, spawns: ['worker-terminal', 'researcher'], placement: 'under Alpha' });
	});
	it('team: every session below it through accepted edges, with depth and state', () => {
		expect(view().team.map((r) => [r.name, r.depth, r.dot])).toEqual([['W2', 0, 'needs'], ['R4', 0, 'running']]);
	});
	it('a session that is not a manager says so (and has no team)', () => {
		const v = view([], 'w2');
		expect(v).toMatchObject({ manager: false, spawns: [], team: [] });
	});
	it('vacant when the manager has left the floor — never a crash, never someone else', () => {
		const v = view([], 'gone');
		expect(v).toMatchObject({ vacant: true, name: 'Lead', team: [], open: [] });
	});
	it('open proposals addressed to it, each with a checkDelegation PREVIEW and the commands to run', () => {
		const v = view([prop('p1'), prop('p2', { role: 'alpha' }), prop('p3', { to: 'kane' })]);
		expect(v.open.map((p) => [p.id, p.verdict.ok])).toEqual([['p1', true], ['p2', false]]);
		expect(v.open[1]!.verdict).toMatchObject({ ok: false, reason: expect.stringContaining('team-lead may not spawn alpha — condition 1 of 3') });
		expect(v.open[0]!.acceptCommand).toBe('cos-coord proposal accept p1');
	});
	it('an open proposal whose proposer has ended reads as stale, among the decided', () => {
		const v = view([prop('p1', { from: { sessionId: 'dead', role: 'worker-terminal', name: 'Gone' } })]);
		expect(v.open).toEqual([]);
		expect(v.decided).toMatchObject([{ id: 'p1', state: 'stale', reason: 'Gone has ended' }]);
	});
	it('keeps only the most recent decided proposals, newest first', () => {
		const many = Array.from({ length: DECIDED_SHOWN + 3 }, (_, i) => prop(`d${i}`, { state: 'declined', reason: 'no', decidedTs: i, decidedByName: 'Lead' }));
		const v = view(many);
		expect(v.decided).toHaveLength(DECIDED_SHOWN);
		expect(v.decided[0]).toMatchObject({ id: `d${DECIDED_SHOWN + 2}`, by: 'Lead', reason: 'no' });
	});
});

describe('FR-53: the open-proposal count on the addressee\'s sidebar row', () => {
	it('counts open proposals per addressee; decided, stale and unaddressed ones are not counted', () => {
		const live = new Set(['lead', 'w2', 'kane']);
		const ps = [prop('a'), prop('b'), prop('c', { state: 'declined' }), prop('d', { to: null }), prop('e', { from: { sessionId: 'dead', role: 'x', name: 'x' } })];
		expect(openProposalCounts(ps, live)).toEqual({ lead: 2 });
	});
	it('is drawn on the row as ◆N, team view only', () => {
		const ss: SidebarSession[] = [{ id: OVERSEER_ID, name: 'Alpha', branch: '', state: 'running', remoteOn: false }, { id: 1, name: 'Lead', branch: '', state: 'idle', remoteOn: false }];
		const lineage = [{ tileId: OVERSEER_ID, sessionId: 'kane', role: 'alpha' }, { tileId: 1, sessionId: 'lead', role: 'team-lead', parentSessionId: 'kane' }];
		const [g] = buildSidebar([{ id: 'w', name: 'w', active: true, live: true, sessions: ss, lineage, proposals: { lead: 2 } }], new Set(), { teamView: true, delegation: lookup });
		expect(g!.team!.tree.map((l) => [l.row.name, l.row.manager, l.row.proposals])).toEqual([['Alpha', false, 0], ['Lead', true, 2]]);
	});
});

// ---- "Pure logic in src/core/. The UI may not import child_process, fs or any IO module." For this
// step's modules, checked transitively: follow every relative import and require from each file.
const IO = /^(node:)?(fs|fs\/promises|child_process|net|http|https|os|electron|crypto)$/;
function importsOf(file: string): string[] {
	const src = fs.readFileSync(file, 'utf8');
	const out: string[] = [];
	for (const m of src.matchAll(/^\s*import\s+(?!type\b)[^'"]*['"]([^'"]+)['"]/gm)) out.push(m[1]!);
	for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
	return out;
}
function resolveRel(from: string, spec: string): string | null {
	const base = path.resolve(path.dirname(from), spec);
	for (const c of [base, `${base}.ts`, `${base}/index.ts`]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
	return null;
}
function ioReachable(entry: string): string[] {
	const seen = new Set<string>();
	const bad: string[] = [];
	const visit = (f: string): void => {
		if (seen.has(f)) return;
		seen.add(f);
		for (const spec of importsOf(f)) {
			if (spec.startsWith('.')) { const r = resolveRel(f, spec); if (r) visit(r); }
			else if (IO.test(spec)) bad.push(`${path.relative(path.join(__dirname, '..'), f)} → ${spec}`);
		}
	};
	visit(entry);
	return bad;
}

describe('no IO in this step\'s pure and UI modules (transitively)', () => {
	const root = path.join(__dirname, '..', 'src');
	for (const f of ['core/delegation.ts', 'core/team.ts', 'core/session-requests.ts', 'core/proposals.ts', 'ui/manager-model.ts', 'ui/manager-view.ts', 'ui/sidebar-model.ts', 'ui/sidebar.ts']) {
		it(f, () => { expect(ioReachable(path.join(root, f))).toEqual([]); });
	}
	it('the scan is not vacuous: the IO half (session-channel.ts) is flagged', () => {
		expect(ioReachable(path.join(root, 'terminals/session-channel.ts')).join(' | ')).toMatch(/→ fs/);
	});
});
