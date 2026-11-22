import { describe, it, expect, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lookupFrom, MANAGERS_OFF_REASON } from '../src/core/delegation';
import {
	evaluatePropose, evaluateAccept, evaluateDecline, staleOnEnd, effectiveState, MAX_OPEN_PROPOSALS, type SpawnProposal,
} from '../src/core/proposals';
import { evaluateSessionRequest, parseSessionRequest, type FloorSession, type SessionContext, type SessionRequest } from '../src/core/session-requests';
import { foldProposals, proposalKey, formatProposal } from '../pty-sidecar/proposals-core.cjs';
import { SessionChannel, readProposals } from '../src/terminals/session-channel';
import { sanitizeSessionEnv } from '../src/terminals/session-env';

const lookup = lookupFrom([
	{ slug: 'alpha', authority: 'operator', spawns: [] },
	{ slug: 'team-lead', authority: 'operator', spawns: ['worker-terminal', 'researcher'] },
	{ slug: 'worker-terminal', authority: 'operator', spawns: [] },
	{ slug: 'researcher', authority: 'proposer', spawns: [] },
	{ slug: 'auditor', authority: 'autonomous', spawns: [] },
]);
const floor: FloorSession[] = [
	{ key: -1, sessionId: 'kane', name: 'Alpha', role: 'alpha' },
	{ key: 1, sessionId: 'lead', name: 'Lead', role: 'team-lead', parentSessionId: 'kane' },
	{ key: 2, sessionId: 'w2', name: 'W2', role: 'worker-terminal', parentSessionId: 'lead', repoName: 'app', workstreamId: 'ws-7' },
	{ key: 3, sessionId: 'u3', name: 'U3', role: 'worker-terminal', repoName: 'app' },
	{ key: 4, sessionId: 'w4', name: 'W4', role: 'worker-terminal', parentSessionId: 'kane', repoName: 'app' },
];
const ctx = (requesterId: string, over: Partial<SessionContext> = {}): SessionContext =>
	({ enabled: true, requesterId, sessions: floor, lookup, repos: [{ name: 'app' }], ...over });
function parse<K extends SessionRequest['kind']>(o: Record<string, unknown>): Extract<SessionRequest, { kind: K }> {
	const p = parseSessionRequest(JSON.stringify({ v: 1, id: 'q', sentMs: 1, ...o }));
	if (!p.ok) throw new Error(p.reason);
	return p.request as Extract<SessionRequest, { kind: K }>;
}
const propose = (role: string, task: string) => parse<'propose-spawn'>({ kind: 'propose-spawn', role, task, why: 'it splits' });
const accept = (proposal: string, repo?: string) => parse<'proposal-accept'>({ kind: 'proposal-accept', proposal, ...(repo ? { repo } : {}) });
const decline = (proposal: string, reason: string) => parse<'proposal-decline'>({ kind: 'proposal-decline', proposal, reason });

const prop = (id: string, over: Partial<SpawnProposal> = {}): SpawnProposal => ({
	id, ts: 1, from: { sessionId: 'w2', role: 'worker-terminal', name: 'W2' }, to: 'lead', workstreamId: null,
	role: 'researcher', task: `task ${id}`, why: 'w', state: 'open', ...over,
});

describe('proposals-core fold (append-only, first decision wins)', () => {
	const line = (o: object) => JSON.stringify({ v: 1, ...o });
	const text = [
		line({ ev: 'propose', ts: 1, id: 'p1', from: { sessionId: 'w2', role: 'worker-terminal', name: 'W2' }, to: 'lead', role: 'researcher', task: 't', why: 'y' }),
		line({ ev: 'propose', ts: 2, id: 'p2', from: { sessionId: 'w2', role: 'worker-terminal', name: 'W2' }, to: 'lead', role: 'researcher', task: 't2', why: 'y' }),
		'{torn line',
		line({ ev: 'decline', ts: 3, id: 'p1', by: 'lead', reason: 'not now' }),
		line({ ev: 'accept', ts: 4, id: 'p1', by: 'lead', spawned: 'x' }), // ignored: p1 is no longer open
		line({ ev: 'stale', ts: 5, id: 'p2', reason: 'W2 ended' }),
		line({ ev: 'accept', ts: 6, id: 'nope', by: 'lead' }),
	].join('\n');
	it('folds to one state per proposal, in proposal order', () => {
		const ps = foldProposals(text);
		expect(ps.map((p) => [p.id, p.state, p.reason])).toEqual([['p1', 'declined', 'not now'], ['p2', 'stale', 'W2 ended']]);
		expect(ps[0]).toMatchObject({ decidedBy: 'lead', decidedTs: 3 });
	});
	it('the key folds whitespace and case', () => {
		expect(proposalKey('Researcher', '  survey   the  stores ')).toBe(proposalKey('researcher', 'Survey the stores'));
	});
	it('formats a decline with its reason, so the proposer can read it', () => {
		expect(formatProposal(foldProposals(text)[0]!, { lead: 'Lead' })).toContain('declined by Lead: not now');
	});
});

describe('propose — FR-51: any session, whatever its rung', () => {
	it('a worker proposes; the record is addressed to its parent and carries its workstream', () => {
		const d = evaluatePropose(propose('researcher', 'survey the lease stores'), ctx('w2'), [], { id: 'p-1', ts: 9 });
		expect(d).toEqual({ ok: true, event: {
			ev: 'propose', id: 'p-1', ts: 9, from: { sessionId: 'w2', role: 'worker-terminal', name: 'W2' },
			to: 'lead', toName: 'Lead', workstreamId: 'ws-7', role: 'researcher', task: 'survey the lease stores', why: 'it splits',
		} });
	});
	it('an unassigned session proposes to nobody in particular (to: null)', () => {
		expect(evaluatePropose(propose('researcher', 't'), ctx('u3'), [], { id: 'p', ts: 1 })).toMatchObject({ ok: true, event: { to: null } });
	});
	it('rule 1: a fourth open proposal is refused, naming the open ones', () => {
		const open = [prop('p1'), prop('p2'), prop('p3'), prop('p0', { state: 'declined' })];
		expect(MAX_OPEN_PROPOSALS).toBe(3);
		const d = evaluatePropose(propose('researcher', 'another'), ctx('w2'), open, { id: 'p4', ts: 1 });
		expect(d).toMatchObject({ ok: false });
		if (!d.ok) for (const id of ['p1', 'p2', 'p3']) expect(d.reason).toContain(id);
		if (!d.ok) expect(d.reason).not.toContain('p0');
	});
	it('rule 2: a declined proposal is not re-proposed — refused with the decline\'s reason', () => {
		const prior = [prop('p1', { task: 'Survey the stores', state: 'declined', reason: 'already done in ws-3' })];
		expect(evaluatePropose(propose('researcher', 'survey  the stores'), ctx('w2'), prior, { id: 'p2', ts: 1 }))
			.toEqual({ ok: false, reason: 'this was proposed and declined as p1: "already done in ws-3" — a declined proposal is not re-proposed' });
		// another session may still propose it
		expect(evaluatePropose(propose('researcher', 'survey the stores'), ctx('w4'), prior, { id: 'p3', ts: 1 })).toMatchObject({ ok: true });
	});
	it('v2.managers off refuses it', () => {
		expect(evaluatePropose(propose('researcher', 't'), ctx('w2', { enabled: false }), [], { id: 'p', ts: 1 })).toEqual({ ok: false, reason: MANAGERS_OFF_REASON });
	});
});

describe('accept — FR-52: a proposal changes what the orchestrator is ASKED, never what it MAY do', () => {
	it('the addressed manager accepts: a spawn planned exactly as its own, the manager as parent', () => {
		const d = evaluateAccept(accept('p1'), ctx('lead'), [prop('p1')]);
		expect(d).toMatchObject({ ok: true, action: 'spawn', repo: 'app', childRole: 'researcher', parentSessionId: 'lead', task: 'task p1' });
	});
	it('a role the parent may not spawn is refused with the IDENTICAL message a direct spawn gets', () => {
		const viaProposal = evaluateAccept(accept('p1'), ctx('lead'), [prop('p1', { role: 'auditor' })]);
		const direct = evaluateSessionRequest(parse<'spawn'>({ kind: 'spawn', repo: 'app', task: 'x', role: 'auditor' }), ctx('lead'));
		expect(viaProposal).toMatchObject({ ok: false });
		expect(viaProposal).toEqual(direct);
	});
	it('a parent with no spawns: cannot accept — the same refusal again (Alpha has none yet)', () => {
		const d = evaluateAccept(accept('p1'), ctx('kane'), [prop('p1', { from: { sessionId: 'w4', role: 'worker-terminal', name: 'W4' }, to: 'kane' })]);
		expect(d).toMatchObject({ ok: false, reason: expect.stringContaining('alpha may not spawn researcher — condition 1 of 3 (listed): alpha has no spawns:') });
	});
	it('only the addressee may decide it; an unassigned proposer\'s may be taken by any manager', () => {
		expect(evaluateAccept(accept('p1'), ctx('w4'), [prop('p1')])).toMatchObject({ ok: false, reason: 'proposal p1 is addressed to Lead, not W4' });
		const loose = prop('p9', { from: { sessionId: 'u3', role: 'worker-terminal', name: 'U3' }, to: null });
		expect(evaluateAccept(accept('p9'), ctx('lead'), [loose])).toMatchObject({ ok: true, parentSessionId: 'lead' });
		expect(evaluateDecline(decline('p9', 'no'), ctx('w4'), [loose])).toMatchObject({ ok: false, reason: expect.stringContaining('any manager') });
	});
	it('a decided or stale proposal cannot be decided again', () => {
		expect(evaluateAccept(accept('p1'), ctx('lead'), [prop('p1', { state: 'declined', reason: 'no' })])).toMatchObject({ ok: false, reason: 'proposal p1 is already declined (no)' });
		const gone = prop('p1', { from: { sessionId: 'dead', role: 'worker-terminal', name: 'Gone' } });
		expect(evaluateAccept(accept('p1'), ctx('lead'), [gone])).toMatchObject({ ok: false, reason: expect.stringContaining('stale — Gone, who proposed it, has ended') });
	});
	it('the repo defaults to the proposer\'s; --repo overrides, and is checked', () => {
		expect(evaluateAccept(accept('p1', 'nope'), ctx('lead'), [prop('p1')])).toMatchObject({ ok: false, reason: expect.stringContaining('unknown repo "nope"') });
	});
});

describe('decline — FR-54, and the rules that keep it quiet', () => {
	it('the addressee declines, whatever its rung', () => {
		const toKane = prop('p1', { from: { sessionId: 'w4', role: 'worker-terminal', name: 'W4' }, to: 'kane' });
		expect(evaluateDecline(decline('p1', 'later'), ctx('kane'), [toKane])).toMatchObject({ ok: true });
	});
	it('rule 3: a proposer\'s open proposals go stale with it; decided ones are left alone', () => {
		const ps = [prop('p1'), prop('p2', { state: 'accepted' }), prop('p3', { from: { sessionId: 'w4', role: 'worker-terminal', name: 'W4' } })];
		expect(staleOnEnd(ps, 'w2').map((p) => p.id)).toEqual(['p1']);
		expect(effectiveState(prop('p1'), new Set(['lead']))).toBe('stale');
		expect(effectiveState(prop('p1'), new Set(['w2']))).toBe('open');
	});
});

// ---- The channel and the CLI, end to end on disk.

let dir: string;
let spawned: unknown[];
function channel(): SessionChannel {
	return new SessionChannel({
		coordDir: dir, enabled: () => true, lookup: () => lookup, floor: () => floor, repos: () => [{ name: 'app' }],
		spawn: async (plan) => { spawned.push(plan); return { ok: true, spawned: { terminal: 'wt-r', branch: 'wt/r', sessionId: 'child-r' } }; },
		tell: async () => ({ ok: true }), assign: () => true,
	});
}
const CLI = path.join(__dirname, '..', 'pty-sidecar', 'coord-cli.cjs');
function cli(args: string[], sessionId: string): Promise<{ code: number; out: string; err: string }> {
	return new Promise((resolve) => {
		execFile('node', [CLI, ...args], { env: { ...sanitizeSessionEnv(process.env), COS_COORD_DIR: dir, COS_SESSION_ID: sessionId, COS_COORD_TELL_WAIT_MS: '15000', COS_COORD_SPAWN_WAIT_MS: '15000' }, encoding: 'utf8' },
			(e, out, err) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }));
	});
}
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proposals-')); spawned = []; });

describe('propose → decline → read the reason, through cos-coord', () => {
	it('the whole loop, and the re-proposal refusal', async () => {
		const c = channel();
		c.arm();
		try {
			const p = await cli(['propose-spawn', '--role', 'researcher', '--task', 'survey the stores', '--why', 'blocks me 40m'], 'w2');
			expect(p.code).toBe(0);
			const id = /proposal (p-\S+) recorded/.exec(p.out)![1]!;
			expect(spawned).toEqual([]); // inert: proposing spawned nothing
			const d = await cli(['proposal', 'decline', id, '--reason', 'ws-3 already has it'], 'lead');
			expect(d).toMatchObject({ code: 0, out: expect.stringContaining(`proposal ${id} declined`) });
			const list = await cli(['proposals'], 'w2');
			expect(list.out).toContain('declined by Lead: ws-3 already has it');
			const again = await cli(['propose-spawn', '--role', 'researcher', '--task', 'Survey the stores', '--why', 'still'], 'w2');
			expect(again.code).toBe(2);
			expect(again.err).toContain('ws-3 already has it');
		} finally { c.dispose(); }
	});
});

describe('propose → accept, through the channel', () => {
	it('accept spawns once, records it, and a second accept is refused', async () => {
		const c = channel();
		c.arm();
		try {
			const p = await cli(['propose-spawn', '--role', 'researcher', '--task', 't', '--why', 'w'], 'w2');
			const id = /proposal (p-\S+) recorded/.exec(p.out)![1]!;
			const a = await cli(['proposal', 'accept', id], 'lead');
			expect(a).toMatchObject({ code: 0, out: expect.stringContaining(`spawned "wt-r" on wt/r — session child-r (proposal ${id} accepted)`) });
			expect(spawned).toMatchObject([{ childRole: 'researcher', parentSessionId: 'lead', workstreamId: 'ws-7' }]);
			expect(readProposals(dir)).toMatchObject([{ id, state: 'accepted', decidedBy: 'lead', spawned: 'child-r' }]);
			const b = await cli(['proposal', 'accept', id], 'lead');
			expect(b.code).toBe(2);
			expect(b.err).toContain('already accepted');
			expect(spawned).toHaveLength(1);
		} finally { c.dispose(); }
	});

	it('a proposer that ends leaves its open proposals stale', async () => {
		const c = channel();
		c.arm();
		try {
			await cli(['propose-spawn', '--role', 'researcher', '--task', 't', '--why', 'w'], 'w2');
			c.proposerEnded('w2');
			expect(readProposals(dir)).toMatchObject([{ state: 'stale', reason: 'W2 ended' }]);
		} finally { c.dispose(); }
	});
});
