import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import * as path from 'path';

// One session dying reaches the bridge TWICE: the sidecar sends an {t:'exit'} frame carrying
// claude's code, then exits itself (code 0), which fires the ChildProcess 'exit' event. Measured
// against the real sidecar (2026-10-14): frame code=1 at ~1213ms, process exit code=0 at ~1221ms.
// The fake below replays exactly that shape so the bridge's own handling is what is under test.

class FakeProc extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin = { write: vi.fn() };
	pid = 4242;
	kill = vi.fn();
	frame(obj: object): void { this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n')); }
}

let proc: FakeProc;
const killResult = { ok: true as const, pid: 4242 };

vi.mock('child_process', async (orig) => ({
	...(await orig<typeof import('child_process')>()),
	spawn: vi.fn(() => proc),
}));
vi.mock('../src/terminals/kill-tree', () => ({
	killProcessTree: vi.fn(() => Promise.resolve(killResult)),
	unconfirmedKills: new Set<number>(),
}));

const { SessionBridge } = await import('../src/terminals/session-bridge');

function started() {
	const b = new SessionBridge('sidecar.cjs', '/wt');
	const exits: Array<number | null> = [];
	const data: string[] = [];
	b.onExit((c) => exits.push(c));
	b.onData((d) => data.push(d));
	b.start();
	return { b, exits, data };
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

beforeEach(() => { proc = new FakeProc(); });

describe('SessionBridge exit delivery', () => {
	it('reports ONE exit when the sidecar sends its exit frame and then exits itself', () => {
		const { exits } = started();
		proc.frame({ t: 'exit', code: 1 }); // claude's own code
		proc.emit('exit', 0);               // the sidecar's process.exit(0) right after
		expect(exits).toEqual([1]);
	});

	it('reports one death whichever signal happens to arrive first', () => {
		const { exits } = started();
		proc.emit('exit', 0);
		proc.frame({ t: 'exit', code: 1 });
		// The first signal wins; what matters is that the owner hears about ONE death.
		expect(exits).toEqual([0]);
	});

	it('reports a spawn failure once, not again on the exit that follows it', () => {
		const { exits } = started();
		proc.emit('error', new Error('ENOENT'));
		proc.emit('exit', null);
		expect(exits).toEqual([1]);
	});

	it('goes quiet once its owner has asked for the kill — a replaced session is not news', async () => {
		// restartInPlace/refresh: kill the old bridge, start a new one in the SAME tile. The old
		// one's death used to arrive afterwards and mark the tile "[session ended (code 1)]" (code 1
		// is taskkill /F) over the live replacement.
		const { b, exits, data } = started();
		await b.killTree();
		proc.frame({ t: 'data', d: b64('stale repaint') });
		proc.emit('exit', 1);
		expect(exits).toEqual([]);
		expect(data).toEqual([]);
	});

	it('still reports deaths nobody asked for', () => {
		const { exits, data } = started();
		proc.frame({ t: 'data', d: b64('hello') });
		proc.emit('exit', 1); // e.g. something else tree-killed it
		expect(data).toEqual(['hello']);
		expect(exits).toEqual([1]);
	});
});

// The same check against the real sidecar and a real PTY, so the double signal above is not an
// assumption about the sidecar but a measurement of it. Windows only: node-pty ships prebuilt
// binaries for win32 here, and this is the platform the app runs on.
describe.skipIf(process.platform !== 'win32')('SessionBridge against the real sidecar', () => {
	it('a session that exits on its own is reported dead exactly once', async () => {
		const real = await vi.importActual<typeof import('child_process')>('child_process');
		const cp = await import('child_process');
		vi.mocked(cp.spawn).mockImplementationOnce(((...a: Parameters<typeof real.spawn>) => real.spawn(...a)) as typeof cp.spawn);
		const sidecar = path.join(__dirname, '..', 'pty-sidecar', 'sidecar.cjs');
		const b = new SessionBridge(sidecar, process.cwd(), 'node', ['-e', 'process.exit(3)']);
		const exits: Array<number | null> = [];
		b.onExit((c) => exits.push(c));
		b.start();
		// Long enough for the PTY to report the exit AND the sidecar process to follow it.
		await new Promise((r) => setTimeout(r, 4000));
		expect(exits).toEqual([3]);
	}, 10_000);
});
