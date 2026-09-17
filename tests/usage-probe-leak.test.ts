import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Regression test for the 3 GB/hour leak found on 2026-09-16: 31 live `claude` sessions in
 *  the usage-probe cwd, one for every auto-refresh since the app started.
 *
 *  The mechanism, reproduced below: a refresh whose first pass comes back empty kills its
 *  session and immediately starts a second one. The FIRST session's `exit` event arrives a
 *  few hundred ms later — after the replacement is already installed — and the callback,
 *  which closed over the probe rather than over its own bridge, nulled `this.bridge` out
 *  from under the live session. refreshOnce() then threw before reaching its cleanup, and
 *  the live sidecar's pid was gone from the program forever. */

interface Fake {
	id: number;
	killed: boolean;
	alive: boolean;
	onExitCb?: (code: number | null) => void;
	onReadyCb?: () => void;
	onDataCb?: (d: string) => void;
}

const instances: Fake[] = [];

vi.mock('../src/terminals/session-bridge', () => {
	let seq = 0;
	class FakeBridge implements Fake {
		id = ++seq;
		killed = false;
		alive = true;
		onExitCb?: (code: number | null) => void;
		onReadyCb?: () => void;
		onDataCb?: (d: string) => void;
		constructor() { instances.push(this); }
		get pid(): number | null { return this.alive ? 1000 + this.id : null; }
		onData(cb: (d: string) => void): void { this.onDataCb = cb; }
		onExit(cb: (code: number | null) => void): void { this.onExitCb = cb; }
		onReady(cb: () => void): void { this.onReadyCb = cb; }
		onKillFailure(): void { /* not exercised here */ }
		start(): void { /* spawns nothing */ }
		resize(): void { /* no pty */ }
		write(): void { /* swallowed: the probe never gets a readout, which forces the retry */ }
		kill(): void {
			this.killed = true;
			// The detail that caused the bug: `exit` lands LATER, by which time the probe may
			// already own a different session. A synchronous fake would hide the whole defect.
			setTimeout(() => { this.alive = false; this.onExitCb?.(0); }, 300);
		}
	}
	return { SessionBridge: FakeBridge, safeSessionEnv: () => ({}) };
});

const { UsageProbe } = await import('../src/terminals/usage-probe');

beforeEach(() => {
	instances.length = 0;
	(globalThis as unknown as { window: unknown }).window = globalThis;
	vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

/** Boot the pending session, then run out its scrape window so the pass ends empty. */
async function runOnePassToEmpty(idx: number): Promise<void> {
	instances[idx]!.onReadyCb?.();
	await vi.advanceTimersByTimeAsync(300);   // ensureSession's ready poll
	await vi.advanceTimersByTimeAsync(12500); // the scrape window times out with an empty buffer
}

describe('UsageProbe process cleanup', () => {
	it('kills BOTH sessions when an empty first pass forces a retry (the leak)', async () => {
		const probe = new UsageProbe({ sidecarPath: 's', cwd: 'c' });
		const done = probe.refresh();

		await runOnePassToEmpty(0);
		// The retry's session now exists while the first one's exit is still in flight.
		expect(instances).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(400); // first session's exit lands, targeting a stale bridge
		await runOnePassToEmpty(1);
		await done;
		await vi.advanceTimersByTimeAsync(400); // let the second session's exit land too

		expect(instances).toHaveLength(2);
		expect(instances.map((b) => b.killed)).toEqual([true, true]);
		expect(instances.filter((b) => b.alive)).toEqual([]);
	});

	it('leaves nothing running after a refresh, so pids are never orphaned', async () => {
		const probe = new UsageProbe({ sidecarPath: 's', cwd: 'c' });
		const done = probe.refresh();
		await runOnePassToEmpty(0);
		await vi.advanceTimersByTimeAsync(400);
		await runOnePassToEmpty(1);
		await done;
		await vi.advanceTimersByTimeAsync(1000);

		expect(probe.ownedPids()).toEqual([]);
		expect(instances.some((b) => b.alive)).toBe(false);
	});

	it('reports the pid it currently owns, so the reaper can spare a live refresh', async () => {
		const probe = new UsageProbe({ sidecarPath: 's', cwd: 'c' });
		const done = probe.refresh();
		expect(probe.ownedPids()).toEqual([1000 + instances[0]!.id]);
		await runOnePassToEmpty(0);
		await vi.advanceTimersByTimeAsync(400);
		await runOnePassToEmpty(1);
		await done;
	});
});
