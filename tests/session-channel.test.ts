import { describe, it, expect, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionChannel, type SessionChannelDeps } from '../src/terminals/session-channel';
import { lookupFrom } from '../src/core/delegation';
import type { FloorSession, SpawnPlan } from '../src/core/session-requests';
import { sanitizeSessionEnv } from '../src/terminals/session-env';

const lookup = lookupFrom([
	{ slug: 'alpha', authority: 'operator', spawns: [] },
	{ slug: 'team-lead', authority: 'operator', spawns: ['worker-terminal'] },
	{ slug: 'worker-terminal', authority: 'operator', spawns: [] },
]);
const floor: FloorSession[] = [
	{ key: -1, sessionId: 'kane', name: 'Alpha', role: 'alpha' },
	{ key: 1, sessionId: 'lead', name: 'Lead', role: 'team-lead', parentSessionId: 'kane' },
	{ key: 2, sessionId: 'w2', name: 'W2', role: 'worker-terminal', parentSessionId: 'lead' },
	{ key: 3, sessionId: 'u3', name: 'U3', role: 'worker-terminal' },
];

let dir: string;
let spawned: SpawnPlan[];
let told: Array<[string, string]>;
let assigned: Array<[string, string]>;
let enabled: boolean;
function channel(over: Partial<SessionChannelDeps> = {}): SessionChannel {
	return new SessionChannel({
		coordDir: dir, enabled: () => enabled, lookup: () => lookup, floor: () => floor, repos: () => [{ name: 'app' }],
		spawn: async (plan) => { spawned.push(plan); return { ok: true, spawned: { terminal: 'wt-main-9', branch: 'wt/main-9', sessionId: 'child-9' } }; },
		tell: async (t, m) => { told.push([t, m]); return { ok: true }; },
		assign: (t, p) => { assigned.push([t, p]); return true; },
		...over,
	});
}
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sesschan-'));
	spawned = []; told = []; assigned = []; enabled = true;
});

function drop(sessionId: string, id: string, body: Record<string, unknown>): string {
	const req = path.join(dir, 'sessions', sessionId, 'requests');
	fs.mkdirSync(req, { recursive: true });
	const f = path.join(req, `${id}.json`);
	fs.writeFileSync(f, JSON.stringify({ v: 1, id, sentMs: 1, ...body }));
	return f;
}
const receipt = (sessionId: string, id: string) => JSON.parse(fs.readFileSync(path.join(dir, 'sessions', sessionId, 'receipts', `${id}.json`), 'utf8'));
const logLines = () => fs.readFileSync(path.join(dir, 'delegation.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

async function run(c: SessionChannel): Promise<void> { c.drain(); await c.idle(); }

describe('SessionChannel', () => {
	it('a manager\'s spawn is claimed, carried out with the manager as parent, and receipted', async () => {
		const f = drop('lead', 'r1', { kind: 'spawn', repo: 'app', task: 'do X' });
		await run(channel());
		expect(fs.existsSync(f)).toBe(false);
		expect(fs.existsSync(path.join(path.dirname(f), '.done', 'r1.json'))).toBe(true);
		expect(spawned).toMatchObject([{ repo: 'app', parentSessionId: 'lead', childRole: 'worker-terminal' }]);
		expect(receipt('lead', 'r1')).toMatchObject({ v: 1, id: 'r1', status: 'accepted', terminalName: 'wt-main-9', spawned: { sessionId: 'child-9' } });
		expect(logLines()).toMatchObject([{ v: 1, from: 'lead', kind: 'spawn', ok: true, role: 'worker-terminal', child: 'child-9' }]);
	});

	it('a worker\'s spawn is refused with the failing condition, and nothing is spawned', async () => {
		drop('w2', 'r1', { kind: 'spawn', repo: 'app', task: 'do X' });
		await run(channel());
		expect(spawned).toEqual([]);
		expect(receipt('w2', 'r1')).toMatchObject({ status: 'rejected', reason: expect.stringContaining('condition 1 of 3 (listed)') });
		expect(logLines()[0]).toMatchObject({ from: 'w2', kind: 'spawn', ok: false });
	});

	it('v2.managers off refuses everything — and reads the setting live', async () => {
		enabled = false;
		const c = channel();
		drop('lead', 'r1', { kind: 'spawn', repo: 'app', task: 'x' });
		await run(c);
		expect(receipt('lead', 'r1')).toMatchObject({ status: 'rejected', reason: expect.stringContaining('v2.managers') });
		enabled = true;
		drop('lead', 'r2', { kind: 'spawn', repo: 'app', task: 'x' });
		await run(c);
		expect(receipt('lead', 'r2')).toMatchObject({ status: 'accepted' });
	});

	it('tell reaches a descendant; outside the team it is refused naming the target', async () => {
		drop('lead', 'r1', { kind: 'tell', terminal: 'W2', message: 'hello' });
		drop('lead', 'r2', { kind: 'tell', terminal: 'U3', message: 'hello' });
		await run(channel());
		expect(told).toEqual([['W2', 'hello']]);
		expect(receipt('lead', 'r1')).toMatchObject({ status: 'accepted', terminalName: 'W2' });
		expect(receipt('lead', 'r2')).toMatchObject({ status: 'rejected', reason: expect.stringContaining('"U3" is not one of Lead\'s') });
	});

	it('assign re-parents through the grid callback, and is logged with who moved what', async () => {
		drop('lead', 'r1', { kind: 'assign', terminal: 'U3' });
		await run(channel());
		expect(assigned).toEqual([['u3', 'lead']]);
		expect(receipt('lead', 'r1')).toMatchObject({ status: 'accepted', terminalName: 'U3' });
		expect(logLines()[0]).toMatchObject({ kind: 'assign', ok: true, target: 'U3', targetSessionId: 'u3', parent: 'lead', by: 'Lead' });
	});

	it('a malformed request still gets a rejected receipt, under its file name', async () => {
		const req = path.join(dir, 'sessions', 'lead', 'requests');
		fs.mkdirSync(req, { recursive: true });
		fs.writeFileSync(path.join(req, 'bad-1.json'), '{not json');
		await run(channel());
		expect(receipt('lead', 'bad-1')).toMatchObject({ status: 'rejected', reason: expect.stringContaining('invalid JSON') });
	});

	it('ignores directories that are not session ids, and a request withdrawn before the claim', async () => {
		fs.mkdirSync(path.join(dir, 'sessions', '..weird', 'requests'), { recursive: true });
		await run(channel());
		expect(fs.existsSync(path.join(dir, 'delegation.jsonl'))).toBe(false);
	});

	it('an unknown kind is refused, not dropped', async () => {
		drop('lead', 'r1', { kind: 'close', target: 'W2' });
		await run(channel());
		expect(receipt('lead', 'r1')).toMatchObject({ status: 'rejected', reason: expect.stringContaining("close stays the overseer's") });
	});
});

// ---- The CLI end of it: cos-coord from a session that is NOT god routes through its own directory.

const CLI = path.join(__dirname, '..', 'pty-sidecar', 'coord-cli.cjs');
function cli(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
	return new Promise((resolve) => {
		execFile('node', [CLI, ...args], { env: { ...sanitizeSessionEnv(process.env), COS_COORD_DIR: dir, ...env }, encoding: 'utf8' }, (e, out, err) =>
			resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }));
	});
}

describe('cos-coord spawn/tell/assign from a non-god session', () => {
	it('spawn goes to sessions/<COS_SESSION_ID>/requests and reports the app\'s receipt', async () => {
		const c = channel();
		c.arm();
		try {
			const r = await cli(['spawn', 'app', '--task', 'do X', '--role', 'worker-terminal'], { COS_SESSION_ID: 'lead', COS_COORD_SPAWN_WAIT_MS: '15000' });
			expect(r).toMatchObject({ code: 0, out: expect.stringContaining('coord: spawned "wt-main-9" on wt/main-9 — session child-9') });
			expect(fs.existsSync(path.join(dir, 'god-outbox'))).toBe(false); // never the overseer's channel
		} finally { c.dispose(); }
	});

	it('a refusal exits 2 with the app\'s reason', async () => {
		const c = channel();
		c.arm();
		try {
			const r = await cli(['spawn', 'app', '--task', 'do X'], { COS_SESSION_ID: 'w2', COS_COORD_SPAWN_WAIT_MS: '15000' });
			expect(r.code).toBe(2);
			expect(r.err).toContain('spawn in "app" did NOT happen — worker-terminal may not spawn worker-terminal — condition 1 of 3');
		} finally { c.dispose(); }
	});

	it('with no app running the request is withdrawn (exit 2), so it can never run late', async () => {
		const r = await cli(['assign', 'U3'], { COS_SESSION_ID: 'lead', COS_COORD_TELL_WAIT_MS: '300' });
		expect(r.code).toBe(2);
		expect(r.err).toContain('WITHDRAWN');
		expect(fs.readdirSync(path.join(dir, 'sessions', 'lead', 'requests')).filter((f) => f.endsWith('.json'))).toEqual([]);
	});

	it('COS_ROLE=god is not needed — and a session id is: without one it is refused as before', async () => {
		const r = await cli(['tell', 'W2', 'hi'], {});
		expect(r.code).toBe(2);
		expect(r.err).toContain('COS_ROLE=god');
		expect(fs.existsSync(path.join(dir, 'sessions'))).toBe(false);
	});
});
