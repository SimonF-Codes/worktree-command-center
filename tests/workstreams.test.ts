import { describe, it, expect, afterEach } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { foldWorkstreams, planWorkstreamCommand, parseWorkstreamEvent, formatWorkstream, type Workstream } from '../pty-sidecar/workstreams-core.cjs';
import { sanitizeSessionEnv } from '../src/terminals/session-env';
import { makeTempDir } from './temp-dir';

const CLI = path.join(__dirname, '..', 'pty-sidecar', 'coord-cli.cjs');
const BASE_ENV = sanitizeSessionEnv(process.env);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } });
const tmp = () => { const d = makeTempDir('ws-'); dirs.push(d); return d; };

const lines = (...evs: object[]) => evs.map((e) => JSON.stringify({ v: 1, ...e })).join('\n');

/** Plan a command against a running fold and apply it, as the CLI does. */
function apply(text: string, argv: string[], actor: string | null = 'sess-a', now = 1000): { text: string; say?: string; reason?: string } {
	const p = planWorkstreamCommand(argv, foldWorkstreams(text), actor, now);
	if (!p.ok) return { text, reason: p.reason };
	return { text: text + JSON.stringify(p.event) + '\n', say: p.say };
}

describe('workstreams.jsonl — the fold', () => {
	it('a workstream carries its tasks inline, and one with no tasks is still a workstream', () => {
		const all = foldWorkstreams(lines(
			{ ev: 'open', ts: 1, id: 'ws-1', title: 'Lease claims', by: 'sess-a' },
			{ ev: 'open', ts: 2, id: 'ws-2', title: 'Groceries' },
			{ ev: 'task', op: 'add', ts: 3, id: 'ws-1', task: 't1', title: 'Write the store' },
			{ ev: 'task', op: 'add', ts: 4, id: 'ws-1', task: 't2', title: 'Write the hook', owner: 'sess-b' },
			{ ev: 'task', op: 'start', ts: 5, id: 'ws-1', task: 't1', by: 'sess-c' },
			{ ev: 'task', op: 'done', ts: 9, id: 'ws-1', task: 't1' },
		));
		expect(all.map((w) => w.id)).toEqual(['ws-1', 'ws-2']);
		expect(all[1]!.tasks).toEqual([]);
		expect(all[1]!.state).toBe('open');
		const [t1, t2] = all[0]!.tasks;
		expect(t1).toMatchObject({ id: 't1', state: 'done', owner: 'sess-c', opened: 3, closed: 9, changed: 9 });
		expect(t2).toMatchObject({ id: 't2', state: 'todo', owner: 'sess-b' });
		expect(t2!.closed).toBeUndefined();
	});

	it('close, then reopen: the reopen is recorded as rework, and the landing fields are cleared', () => {
		const [w] = foldWorkstreams(lines(
			{ ev: 'open', ts: 1, id: 'ws-1', title: 'x' },
			{ ev: 'close', ts: 5, id: 'ws-1', outcome: 'landed', commit: 'abc1234', branch: 'wt/main-3' },
			{ ev: 'reopen', ts: 8, id: 'ws-1', reason: 'revert abc1234' },
		));
		expect(w).toMatchObject({ state: 'open', reopens: [{ ts: 8, from: 'landed', closed: 5, reason: 'revert abc1234' }] });
		expect(w!.commit).toBeUndefined();
		expect(w!.closed).toBeUndefined();
	});

	it('skips torn lines, unknown events, events for unknown ids, and a duplicate open', () => {
		const text = [
			lines({ ev: 'open', ts: 1, id: 'ws-1', title: 'first' }),
			'{"v":1,"ev":"open","ts":2,"id":"ws-2","ti', // torn
			lines({ ev: 'open', ts: 3, id: 'ws-1', title: 'DUPLICATE' }),
			lines({ ev: 'task', op: 'add', ts: 4, id: 'ws-9', task: 't1', title: 'orphan' }),
			lines({ ev: 'explode', ts: 5, id: 'ws-1' }),
			JSON.stringify({ v: 2, ev: 'open', ts: 6, id: 'ws-3', title: 'future version' }),
			'',
		].join('\n');
		const all = foldWorkstreams(text);
		expect(all.map((w) => [w.id, w.title])).toEqual([['ws-1', 'first']]);
		expect(parseWorkstreamEvent('not json')).toBeNull();
	});

	it('a block carries its reason until the task moves on', () => {
		const [w] = foldWorkstreams(lines(
			{ ev: 'open', ts: 1, id: 'ws-1', title: 'x' },
			{ ev: 'task', op: 'add', ts: 2, id: 'ws-1', task: 't1', title: 'y' },
			{ ev: 'task', op: 'block', ts: 3, id: 'ws-1', task: 't1', reason: 'waiting on Simon' },
		));
		expect(w!.tasks[0]).toMatchObject({ state: 'blocked', blockedReason: 'waiting on Simon' });
		const [w2] = foldWorkstreams(lines(
			{ ev: 'open', ts: 1, id: 'ws-1', title: 'x' },
			{ ev: 'task', op: 'add', ts: 2, id: 'ws-1', task: 't1', title: 'y' },
			{ ev: 'task', op: 'block', ts: 3, id: 'ws-1', task: 't1', reason: 'waiting' },
			{ ev: 'task', op: 'start', ts: 4, id: 'ws-1', task: 't1' },
		));
		expect(w2!.tasks[0]!.blockedReason).toBeUndefined();
	});
});

describe('workstreams — planning a command', () => {
	it('numbers workstreams and tasks from what is on disk', () => {
		let s = apply('', ['open', 'Lease', 'claims']);
		expect(s.say).toBe('ws-1 opened — "Lease claims"');
		s = apply(s.text, ['open', 'Second']);
		s = apply(s.text, ['task', 'add', 'ws-2', 'Do', 'it']);
		expect(s.say).toBe('ws-2/t1 added — "Do it"');
		s = apply(s.text, ['task', 'add', 'ws-2', 'Then', 'this', '--owner', 'sess-z']);
		const all: Workstream[] = foldWorkstreams(s.text);
		expect(all[1]!.tasks.map((t) => [t.id, t.title, t.owner])).toEqual([['t1', 'Do it', null], ['t2', 'Then this', 'sess-z']]);
	});

	it('refuses what would be a silent no-op, naming why', () => {
		let s = apply('', ['open', 'x']);
		s = apply(s.text, ['task', 'add', 'ws-1', 'y']);
		expect(apply(s.text, ['close', 'ws-9']).reason).toMatch(/no workstream "ws-9" — this workspace has ws-1/);
		expect(apply('', ['close', 'ws-1']).reason).toMatch(/none has been opened/);
		expect(apply(s.text, ['task', 'done', 'ws-1', 't7']).reason).toMatch(/has no task "t7" — it has t1/);
		expect(apply(s.text, ['assign', 'ws-1', 'none']).reason).toMatch(/already unowned/);
		expect(apply(s.text, ['reopen', 'ws-1', '--reason', 'r']).reason).toMatch(/is open/);
		expect(apply(s.text, ['close', 'ws-1', '--dropped']).reason).toMatch(/needs --reason/);
		s = apply(s.text, ['task', 'start', 'ws-1', 't1']);
		expect(apply(s.text, ['task', 'start', 'ws-1', 't1']).reason).toMatch(/already doing/);
		s = apply(s.text, ['close', 'ws-1']);
		expect(apply(s.text, ['close', 'ws-1']).reason).toMatch(/already landed — reopen it first/);
		expect(apply(s.text, ['reopen', 'ws-1']).reason).toMatch(/needs --reason/);
		expect(apply(s.text, ['frobnicate']).reason).toMatch(/unknown verb/);
	});

	it('assign defaults to the acting session; outside a session it needs a name', () => {
		const s = apply('', ['open', 'x']);
		const p = planWorkstreamCommand(['assign', 'ws-1'], foldWorkstreams(s.text), 'sess-me', 5);
		expect(p.ok && p.event).toMatchObject({ ev: 'assign', to: 'sess-me', by: 'sess-me' });
		const q = planWorkstreamCommand(['assign', 'ws-1'], foldWorkstreams(s.text), null, 5);
		expect(q.ok).toBe(false);
	});

	it('formats a list line with progress over the tasks that still count', () => {
		let s = apply('', ['open', 'Ship'], 'a', 0);
		s = apply(s.text, ['task', 'add', 'ws-1', 'one'], 'a', 0);
		s = apply(s.text, ['task', 'add', 'ws-1', 'two'], 'a', 0);
		s = apply(s.text, ['task', 'add', 'ws-1', 'three'], 'a', 0);
		s = apply(s.text, ['task', 'done', 'ws-1', 't1'], 'a', 0);
		s = apply(s.text, ['task', 'drop', 'ws-1', 't3'], 'a', 0);
		const out = formatWorkstream(foldWorkstreams(s.text)[0]!, 3 * 3600000);
		expect(out.split('\n')[0]).toBe('ws-1  OPEN     Ship  (unowned · 3h · 1/2 tasks)');
	});
});

describe('cos-coord workstream', () => {
	const run = (dir: string, args: string[], sessionId = 'sess-cli') => {
		try {
			const out = execFileSync('node', [CLI, 'workstream', ...args], { env: { ...BASE_ENV, COS_COORD_DIR: dir, COS_SESSION_ID: sessionId }, encoding: 'utf8' });
			return { code: 0, out, err: '' };
		} catch (e: unknown) {
			const err = e as { status: number; stdout: string; stderr: string };
			return { code: err.status, out: err.stdout, err: err.stderr };
		}
	};

	it('writes append-only events the fold reads back, and exits 2 on a refusal', () => {
		const dir = path.join(tmp(), 'ws-coord'); // not created yet
		expect(run(dir, ['open', 'Metrics CLI']).out).toMatch(/ws-1 opened/);
		expect(run(dir, ['task', 'add', 'ws-1', 'Write the fold']).code).toBe(0);
		expect(run(dir, ['task', 'start', 'ws-1', 't1']).code).toBe(0);
		const before = fs.readFileSync(path.join(dir, 'workstreams.jsonl'), 'utf8');
		const bad = run(dir, ['task', 'start', 'ws-1', 't1']);
		expect(bad.code).toBe(2);
		expect(bad.err).toMatch(/workstream refused — ws-1\/t1 is already doing/);
		expect(fs.readFileSync(path.join(dir, 'workstreams.jsonl'), 'utf8')).toBe(before); // nothing written
		const [w] = foldWorkstreams(before);
		expect(w).toMatchObject({ id: 'ws-1', openedBy: 'sess-cli', tasks: [{ id: 't1', state: 'doing', owner: 'sess-cli' }] });
		expect(run(dir, ['list']).out).toMatch(/ws-1 {2}OPEN {5}Metrics CLI/);
		expect(JSON.parse(run(dir, ['list', '--json']).out)).toHaveLength(1);
	});

	it('refuses without a coordination directory rather than failing open', () => {
		const r = (() => {
			try { execFileSync('node', [CLI, 'workstream', 'open', 'x'], { env: { ...BASE_ENV }, encoding: 'utf8' }); return { code: 0, err: '' }; } catch (e: unknown) { const x = e as { status: number; stderr: string }; return { code: x.status, err: x.stderr }; }
		})();
		expect(r.code).toBe(2);
		expect(r.err).toMatch(/needs COS_COORD_DIR/);
	});

	it('two concurrent opens never mint the same id', async () => {
		const dir = tmp();
		const one = (title: string) => new Promise<void>((resolve, reject) => {
			execFile('node', [CLI, 'workstream', 'open', title], { env: { ...BASE_ENV, COS_COORD_DIR: dir } }, (e) => (e ? reject(e) : resolve()));
		});
		await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(one));
		const ids = foldWorkstreams(fs.readFileSync(path.join(dir, 'workstreams.jsonl'), 'utf8')).map((w) => w.id).sort();
		expect(ids).toEqual(['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5', 'ws-6']);
	});
});
