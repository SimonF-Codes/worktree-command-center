import { describe, it, expect, afterEach } from 'vitest';
import { lookupFrom, MANAGERS_OFF_REASON, type DelegationRole } from '../src/core/delegation';
import {
	evaluateSessionRequest, parseSessionRequest, resolveSession, MAX_SESSION_MESSAGE_LEN,
	type FloorSession, type SessionContext, type SessionRequest,
} from '../src/core/session-requests';
import { MAX_TELL_MESSAGE_LEN } from '../src/terminals/connectors';

const r = (slug: string, authority: string, spawns: string[] = []): DelegationRole => ({ slug, authority, spawns });
const lookup = lookupFrom([
	r('alpha', 'operator'),
	r('team-lead', 'operator', ['worker-terminal', 'researcher']),
	r('worker-terminal', 'operator'),
	r('folder-terminal', 'operator'),
	r('researcher', 'proposer'),
	r('auditor', 'autonomous'),
]);
const fs_ = (key: number, name: string, role: string, parent?: string): FloorSession =>
	({ key, sessionId: `s${key}`, name, role, ...(parent ? { parentSessionId: parent } : {}) });

// Alpha ─ Lead(1, team-lead) ─ W2 ─ (W3 under W2: outside delegation)
//       └ W4 (worker)          └ R5 (researcher)
// U6: unassigned worker (opened by hand)
const floor: FloorSession[] = [
	fs_(-1, 'Alpha', 'alpha'),
	fs_(1, 'Lead', 'team-lead', 's-1'),
	fs_(2, 'W2', 'worker-terminal', 's1'),
	fs_(3, 'W3', 'worker-terminal', 's2'),
	fs_(4, 'W4', 'worker-terminal', 's-1'),
	fs_(5, 'R5', 'researcher', 's1'),
	fs_(6, 'U6', 'worker-terminal'),
	fs_(7, 'Audit', 'auditor'),
];
const ctx = (requesterId: string, over: Partial<SessionContext> = {}): SessionContext =>
	({ enabled: true, requesterId, sessions: floor, lookup, repos: [{ name: 'app' }, { name: 'Vault', folder: true }], ...over });

const req = (o: Record<string, unknown>) => {
	const p = parseSessionRequest(JSON.stringify({ v: 1, id: 'q1', sentMs: 1, ...o }));
	if (!p.ok) throw new Error(p.reason);
	return p.request as Extract<SessionRequest, { kind: 'spawn' | 'tell' | 'assign' }>;
};
const spawn = (o: Record<string, unknown> = {}) => req({ kind: 'spawn', repo: 'app', task: 'do it', ...o });
const tell = (terminal: string) => req({ kind: 'tell', terminal, message: 'hi' });
const assign = (terminal: string) => req({ kind: 'assign', terminal });

describe('parseSessionRequest', () => {
	it('recovers the id for a rejected receipt wherever it can', () => {
		expect(parseSessionRequest('nope')).toEqual({ ok: false, id: null, reason: 'malformed request — invalid JSON' });
		expect(parseSessionRequest(JSON.stringify({ v: 1, id: 'x', sentMs: 1, kind: 'close', target: 'W2' })))
			.toMatchObject({ ok: false, id: 'x', reason: expect.stringContaining("close stays the overseer's") });
		expect(parseSessionRequest(JSON.stringify({ v: 1, id: 'x', sentMs: 1, kind: 'spawn', repo: 'app' }))).toMatchObject({ ok: false, id: 'x' });
	});
	it('caps a tell message at the connector channel\'s limit', () => {
		expect(MAX_SESSION_MESSAGE_LEN).toBe(MAX_TELL_MESSAGE_LEN);
		expect(parseSessionRequest(JSON.stringify({ v: 1, id: 'x', sentMs: 1, kind: 'tell', terminal: 'W2', message: 'a'.repeat(MAX_SESSION_MESSAGE_LEN + 1) })))
			.toMatchObject({ ok: false, reason: expect.stringContaining('too long') });
	});
	it('a decline without a reason is refused — the proposer must be able to read why', () => {
		expect(parseSessionRequest(JSON.stringify({ v: 1, id: 'x', sentMs: 1, kind: 'proposal-decline', proposal: 'p1' }))).toMatchObject({ ok: false });
	});
});

describe('v2.managers off: every request is refused, exactly as before this step', () => {
	it('spawn, tell and assign from a manager are all refused with the setting named', () => {
		for (const q of [spawn(), tell('W2'), assign('U6')]) expect(evaluateSessionRequest(q, ctx('s1', { enabled: false }))).toEqual({ ok: false, reason: MANAGERS_OFF_REASON });
	});
});

describe('identity is the directory', () => {
	it('a directory no live session owns is refused', () => {
		expect(evaluateSessionRequest(spawn(), ctx('s-ghost'))).toMatchObject({ ok: false, reason: expect.stringContaining('no live session owns this request directory') });
	});
});

describe('spawn — checkDelegation in full', () => {
	it('a manager spawns a listed role; the child is the requester\'s', () => {
		expect(evaluateSessionRequest(spawn({ role: 'researcher', workstream: 'ws-1' }), ctx('s1'))).toMatchObject({
			ok: true, action: 'spawn', repo: 'app', childRole: 'researcher', roleSlug: 'researcher', parentSessionId: 's1', workstreamId: 'ws-1',
		});
	});
	it('no --role means the target\'s default role, checked the same way', () => {
		expect(evaluateSessionRequest(spawn(), ctx('s1'))).toMatchObject({ ok: true, childRole: 'worker-terminal', roleSlug: null });
		// folder-terminal is not in team-lead's spawns:
		expect(evaluateSessionRequest(spawn({ repo: 'vault' }), ctx('s1'))).toMatchObject({ ok: false, reason: expect.stringContaining('team-lead may not spawn folder-terminal — condition 1 of 3') });
	});
	it('a worker is refused, naming condition 1', () => {
		expect(evaluateSessionRequest(spawn(), ctx('s2'))).toEqual({ ok: false, reason: "worker-terminal may not spawn worker-terminal — condition 1 of 3 (listed): worker-terminal has no spawns:, so it starts nothing" });
	});
	it('the overseer through this channel is checked too — Alpha has no spawns: yet', () => {
		expect(evaluateSessionRequest(spawn(), ctx('s-1'))).toMatchObject({ ok: false, reason: expect.stringContaining('alpha may not spawn worker-terminal — condition 1 of 3') });
	});
	it('an unknown repo or a bad effort is refused before delegation is consulted', () => {
		expect(evaluateSessionRequest(spawn({ repo: 'nope' }), ctx('s1'))).toMatchObject({ ok: false, reason: expect.stringContaining('unknown repo "nope"') });
		expect(evaluateSessionRequest(spawn({ effort: 'huge' }), ctx('s1'))).toMatchObject({ ok: false, reason: expect.stringContaining('invalid effort') });
	});
});

describe('NO authority check reads an environment variable', () => {
	const saved = { ...process.env };
	afterEach(() => { process.env = { ...saved }; });
	it('COS_ROLE=god in this process changes no decision', () => {
		const before = [spawn(), tell('W4'), assign('U6')].map((q) => evaluateSessionRequest(q, ctx('s2')));
		process.env.COS_ROLE = 'god';
		process.env.COS_SESSION_ID = 's1';
		process.env.COS_TERMINAL_NAME = 'Alpha';
		const after = [spawn(), tell('W4'), assign('U6')].map((q) => evaluateSessionRequest(q, ctx('s2')));
		expect(after).toEqual(before);
		expect(after.every((d) => !d.ok)).toBe(true);
	});
});

describe('tell — only into the requester\'s own descendants', () => {
	it('reaches a child and a grandchild of the manager', () => {
		expect(evaluateSessionRequest(tell('W2'), ctx('s1'))).toMatchObject({ ok: true, action: 'tell', terminal: 'W2' });
		expect(evaluateSessionRequest(tell('r5'), ctx('s1'))).toMatchObject({ ok: true, terminal: 'R5' });
	});
	it('refuses a sibling, the overseer and an unassigned session, naming the target and where it sits', () => {
		expect(evaluateSessionRequest(tell('W4'), ctx('s1'))).toEqual({ ok: false, reason: 'tell to "W4" refused — a manager\'s tell reaches only its own descendants, and "W4" is not one of Lead\'s (it sits under Alpha)' });
		expect(evaluateSessionRequest(tell('Alpha'), ctx('s1'))).toMatchObject({ ok: false, reason: expect.stringContaining('(it is an overseer)') });
		expect(evaluateSessionRequest(tell('U6'), ctx('s1'))).toMatchObject({ ok: false, reason: expect.stringContaining('(it is unassigned)') });
	});
	it('an edge the parent could not have made confers nothing: W3 under W2 is not on Lead\'s team', () => {
		expect(evaluateSessionRequest(tell('W3'), ctx('s1'))).toMatchObject({ ok: false, reason: expect.stringContaining('"W3" is not one of Lead\'s') });
	});
	it('a session with no spawns: may not tell at all', () => {
		expect(evaluateSessionRequest(tell('W3'), ctx('s2'))).toEqual({ ok: false, reason: 'W2 (worker-terminal) has no spawns: in its role file, so the app refuses it any tell' });
	});
	it('an unknown or ambiguous target is refused, never guessed', () => {
		expect(evaluateSessionRequest(tell('nobody'), ctx('s1'))).toMatchObject({ ok: false, reason: expect.stringContaining('no such terminal "nobody"') });
		const twins = [...floor, fs_(8, 'w2', 'worker-terminal', 's1')];
		expect(resolveSession('W2', twins)).toMatchObject({ ok: true }); // exact wins
		expect(evaluateSessionRequest(tell('W2'), ctx('s1', { sessions: twins }))).toMatchObject({ ok: true, terminal: 'W2' });
		expect(resolveSession('W', twins)).toMatchObject({ ok: false });
		const caseTwins = [fs_(1, 'Lead', 'team-lead'), fs_(2, 'Abc', 'worker-terminal', 's1'), fs_(3, 'ABC', 'worker-terminal', 's1')];
		expect(evaluateSessionRequest(tell('abc'), ctx('s1', { sessions: caseTwins }))).toMatchObject({ ok: false, reason: expect.stringContaining('ambiguous') });
	});
});

describe('assign — the only way a session moves between groups', () => {
	it('takes an unassigned session under the manager', () => {
		expect(evaluateSessionRequest(assign('U6'), ctx('s1'))).toEqual({ ok: true, action: 'assign', targetSessionId: 's6', terminal: 'U6', parentSessionId: 's1' });
	});
	it('takes a session that is outside delegation (unassigned) too', () => {
		expect(evaluateSessionRequest(assign('W3'), ctx('s1'))).toMatchObject({ ok: true, targetSessionId: 's3' });
	});
	it('refuses a session that belongs to someone else, naming where it sits', () => {
		expect(evaluateSessionRequest(assign('W4'), ctx('s1'))).toMatchObject({ ok: false, reason: expect.stringContaining('it sits under Alpha') });
	});
	it('refuses what the manager could not have spawned — checked by the same function', () => {
		expect(evaluateSessionRequest(assign('Audit'), ctx('s1'))).toMatchObject({ ok: false, reason: expect.stringContaining('team-lead may not spawn auditor — condition 1 of 3') });
	});
	it('refuses itself, the overseer, and a move that would make a loop', () => {
		expect(evaluateSessionRequest(assign('Lead'), ctx('s1'))).toMatchObject({ ok: false, reason: 'Lead cannot assign itself' });
		expect(evaluateSessionRequest(assign('Alpha'), ctx('s1'))).toMatchObject({ ok: false, reason: expect.stringContaining('is an overseer') });
		const nested = [fs_(1, 'Top', 'team-lead'), fs_(2, 'Sub', 'team-lead', 's1')];
		const l2 = lookupFrom([r('team-lead', 'operator', ['team-lead'])]);
		expect(evaluateSessionRequest(assign('Top'), ctx('s2', { sessions: nested, lookup: l2 }))).toMatchObject({ ok: false, reason: expect.stringContaining('would make a loop') });
	});
	it('a worker may not assign', () => {
		expect(evaluateSessionRequest(assign('U6'), ctx('s2'))).toMatchObject({ ok: false, reason: expect.stringContaining('refuses it any assign') });
	});
});
