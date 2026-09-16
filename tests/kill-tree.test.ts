import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { EventEmitter } from 'events';

/** Exit codes the fake `taskkill` should return, one per invocation. */
let script: Array<number | { spawnError: string }> = [];
let calls: string[][] = [];

vi.mock('child_process', () => ({
	spawn: (_file: string, args: string[]) => {
		calls.push(args);
		const ee = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
		ee.stdout = new EventEmitter();
		ee.stderr = new EventEmitter();
		const step = script.shift() ?? 0;
		setTimeout(() => {
			if (typeof step === 'object') { ee.emit('error', new Error(step.spawnError)); return; }
			if (step !== 0) ee.stderr.emit('data', Buffer.from('ERROR: something refused\r\n'));
			ee.emit('exit', step);
		}, 0);
		return ee;
	},
}));

const realPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
afterAll(() => Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }));

const { killProcessTree, unconfirmedKills } = await import('../src/terminals/kill-tree');

beforeEach(() => { script = []; calls = []; unconfirmedKills.clear(); });

describe('killProcessTree', () => {
	it('kills the whole TREE, not just the pid', async () => {
		script = [0];
		await killProcessTree(42);
		expect(calls[0]).toEqual(['/pid', '42', '/T', '/F']);
	});

	it('confirms the kill on exit 0 and does not retry', async () => {
		script = [0];
		expect(await killProcessTree(42)).toEqual({ ok: true, pid: 42 });
		expect(calls).toHaveLength(1);
		expect([...unconfirmedKills]).toEqual([]);
	});

	it('treats "process not found" (128) as confirmed — it is the state we asked for', async () => {
		script = [128];
		expect(await killProcessTree(42)).toEqual({ ok: true, pid: 42 });
		expect(calls).toHaveLength(1);
	});

	it('RETRIES ONCE on a non-zero exit, then succeeds', async () => {
		script = [1, 0];
		expect(await killProcessTree(42)).toEqual({ ok: true, pid: 42 });
		expect(calls).toHaveLength(2);
		expect([...unconfirmedKills]).toEqual([]);
	});

	it('reports the failure — with taskkill stderr — instead of swallowing it', async () => {
		script = [1, 1];
		const r = await killProcessTree(42);
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.detail).toContain('taskkill exit 1');
		expect(r.ok === false && r.detail).toContain('something refused');
	});

	it('REMEMBERS a pid it could not kill, so a later sweep can retry it', async () => {
		script = [1, 1];
		await killProcessTree(42);
		expect([...unconfirmedKills]).toEqual([42]);
	});

	it('forgets the pid again once a later kill succeeds', async () => {
		script = [1, 1];
		await killProcessTree(42);
		script = [0];
		await killProcessTree(42);
		expect([...unconfirmedKills]).toEqual([]);
	});

	it('surfaces a spawn failure (taskkill missing from PATH) rather than dropping it', async () => {
		script = [{ spawnError: 'spawn taskkill ENOENT' }, { spawnError: 'spawn taskkill ENOENT' }];
		const r = await killProcessTree(42);
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.detail).toContain('ENOENT');
		expect([...unconfirmedKills]).toEqual([42]);
	});
});
