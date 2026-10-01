import { describe, it, expect } from 'vitest';
import { MemoryMonitor } from '../src/terminals/memory-monitor';
import { WIDGET_POLL_MS } from '../src/ui/memory-widget';
import { PANEL_POLL_MS } from '../src/ui/memory-panel';
import type { ProcRow } from '../src/terminals/process-snapshot';
import type { MemoryReport, SessionClaim } from '../src/terminals/session-memory';

const MB = 1024 * 1024;
const APP = 100;

/** A timer host that records every interval ever created and which are still live, so
 *  "exactly one poller" is an assertion about the world rather than about an internal flag. */
function fakeTimers() {
	const live = new Map<number, { fn: () => void; ms: number }>();
	let next = 1;
	let created = 0;
	return {
		live,
		created: () => created,
		setInterval: (fn: () => void, ms: number): number => { const h = next++; live.set(h, { fn, ms }); created++; return h; },
		clearInterval: (h: number): void => { live.delete(h); },
		/** Fire every live interval once. */
		tick: (): void => { for (const t of [...live.values()]) t.fn(); },
		intervals: (): number[] => [...live.values()].map((t) => t.ms),
	};
}

function claim(pid: number, key = `s${pid}`): SessionClaim {
	return {
		key, name: key, workspaceId: 'ws', workspaceName: 'W', repo: 'r', branch: 'b',
		pid, busy: false, idleSince: null, hidden: false,
	};
}

const T0 = 1_700_000_000_000;

const rows: ProcRow[] = [
	{ pid: APP, ppid: 1, name: 'app.exe', rssBytes: 120 * MB, startedAt: T0 - 3_600_000 },
	{ pid: 200, ppid: APP, name: 'node.exe', rssBytes: 300 * MB, startedAt: T0 - 3_600_000 },
	// Claimed by nobody. Old enough to be a leak rather than a hook's git — but the tracker
	// only counts what IT has watched, so it still has to earn its three minutes below.
	{ pid: 900, ppid: APP, name: 'leak.exe', rssBytes: 700 * MB, startedAt: T0 - 3_600_000 },
];

function build(over: { snapshot?: () => Promise<ProcRow[]>; claims?: () => SessionClaim[]; now?: () => number } = {}) {
	const timers = fakeTimers();
	let snapshots = 0;
	const monitor = new MemoryMonitor({
		appPid: APP,
		claims: over.claims ?? (() => [claim(200)]),
		snapshot: over.snapshot ?? (async () => { snapshots++; return rows; }),
		setInterval: timers.setInterval,
		clearInterval: timers.clearInterval,
		...(over.now ? { now: over.now } : {}),
	});
	return { monitor, timers, snapshots: () => snapshots };
}

describe('MemoryMonitor — exactly one poller, in every state', () => {
	it('runs no timer at all when nobody is listening', () => {
		const { monitor, timers } = build();
		expect(monitor.pollerCount()).toBe(0);
		expect(timers.live.size).toBe(0);
		expect(monitor.intervalMs()).toBeNull();
	});

	it('widget only: one poller at the widget cadence', () => {
		const { monitor, timers } = build();
		monitor.subscribe(60_000, () => {});
		expect(monitor.pollerCount()).toBe(1);
		expect(timers.live.size).toBe(1);
		expect(monitor.intervalMs()).toBe(60_000);
	});

	it('both open: still ONE poller, pulled up to the faster cadence', () => {
		const { monitor, timers } = build();
		monitor.subscribe(60_000, () => {}); // widget
		monitor.subscribe(20_000, () => {}); // panel
		expect(monitor.pollerCount()).toBe(1);
		expect(timers.live.size).toBe(1);
		expect(timers.intervals()).toEqual([20_000]);
	});

	it('panel only: one poller at the panel cadence', () => {
		const { monitor, timers } = build();
		const off = monitor.subscribe(60_000, () => {});
		monitor.subscribe(20_000, () => {});
		off();
		expect(monitor.pollerCount()).toBe(1);
		expect(timers.live.size).toBe(1);
		expect(timers.intervals()).toEqual([20_000]);
	});

	it('opening and closing the panel raises then drops the shared cadence', () => {
		const { monitor, timers } = build();
		monitor.subscribe(60_000, () => {});
		expect(monitor.intervalMs()).toBe(60_000);
		const closePanel = monitor.subscribe(20_000, () => {});
		expect(monitor.intervalMs()).toBe(20_000);
		closePanel();
		expect(monitor.intervalMs()).toBe(60_000);
		expect(timers.live.size).toBe(1);
	});

	it('never leaves a stray timer behind across a whole open/close cycle', () => {
		const { monitor, timers } = build();
		const offWidget = monitor.subscribe(60_000, () => {});
		for (let i = 0; i < 5; i++) monitor.subscribe(20_000, () => {})();
		expect(timers.live.size).toBe(1);
		offWidget();
		expect(timers.live.size).toBe(0);
		expect(monitor.pollerCount()).toBe(0);
	});

	it('does not restart the timer when a slower subscriber joins', () => {
		const { monitor, timers } = build();
		monitor.subscribe(20_000, () => {});
		const after = timers.created();
		monitor.subscribe(60_000, () => {});
		monitor.subscribe(90_000, () => {});
		// A slower listener must not reset the clock — otherwise a panel reopening repeatedly
		// could postpone the measurement for ever.
		expect(timers.created()).toBe(after);
		expect(timers.intervals()).toEqual([20_000]);
	});

	it('dispose drops the poller', () => {
		const { monitor, timers } = build();
		monitor.subscribe(60_000, () => {});
		monitor.dispose();
		expect(monitor.pollerCount()).toBe(0);
		expect(timers.live.size).toBe(0);
	});

	it('a double unsubscribe does not tear down someone else', () => {
		const { monitor, timers } = build();
		monitor.subscribe(60_000, () => {});
		const off = monitor.subscribe(20_000, () => {});
		off(); off();
		expect(timers.live.size).toBe(1);
		expect(monitor.intervalMs()).toBe(60_000);
	});
});

/** The same assertions again, but against the cadences the app actually ships, so a change to
 *  either constant has to face this test rather than slipping past made-up numbers. */
describe('the shipped two-cadence wiring', () => {
	it('the panel is the faster of the two — otherwise opening it would slow the gauge down', () => {
		expect(PANEL_POLL_MS).toBeLessThan(WIDGET_POLL_MS);
	});

	it('is one poller in every state the app can be in', () => {
		const { monitor, timers } = build();

		// App launched: the gauge is always on.
		const offWidget = monitor.subscribe(WIDGET_POLL_MS, () => {});
		expect(monitor.pollerCount()).toBe(1);
		expect(monitor.intervalMs()).toBe(WIDGET_POLL_MS);

		// Panel opened on top of it: still one, now at the panel's rate.
		const offPanel = monitor.subscribe(PANEL_POLL_MS, () => {});
		expect(monitor.pollerCount()).toBe(1);
		expect(timers.live.size).toBe(1);
		expect(monitor.intervalMs()).toBe(PANEL_POLL_MS);

		// Panel closed: back down to the gauge's rate, still one.
		offPanel();
		expect(monitor.pollerCount()).toBe(1);
		expect(timers.live.size).toBe(1);
		expect(monitor.intervalMs()).toBe(WIDGET_POLL_MS);

		// App shutting down: none.
		offWidget();
		expect(monitor.pollerCount()).toBe(0);
		expect(timers.live.size).toBe(0);
	});
});

describe('MemoryMonitor — one snapshot feeds everyone', () => {
	it('a tick measures once and delivers to every subscriber', async () => {
		const { monitor, timers, snapshots } = build();
		const seen: MemoryReport[] = [];
		monitor.subscribe(60_000, (r) => seen.push(r));
		monitor.subscribe(20_000, (r) => seen.push(r));
		timers.tick();
		await monitor.refreshNow();
		expect(snapshots()).toBe(1);
		expect(seen).toHaveLength(2);
		expect(seen[0]).toBe(seen[1]); // the same report object, not two measurements
	});

	it('hands every subscriber the raw rows of THAT snapshot, so a machine-wide view needs no query of its own', async () => {
		const { monitor, snapshots } = build();
		const seen: Array<readonly ProcRow[]> = [];
		monitor.subscribe(60_000, (_r, rs) => seen.push(rs));
		await monitor.refreshNow();
		// A late subscriber is handed the same rows it would have got on the tick.
		monitor.subscribe(20_000, (_r, rs) => seen.push(rs));
		expect(snapshots()).toBe(1);
		expect(seen).toHaveLength(2);
		expect(seen[0]).toBe(rows);
		expect(seen[1]).toBe(rows);
		expect(monitor.appPid()).toBe(APP);
	});

	it('concurrent refreshes share one snapshot', async () => {
		const { monitor, snapshots } = build();
		const [a, b] = await Promise.all([monitor.refreshNow(), monitor.refreshNow()]);
		expect(snapshots()).toBe(1);
		expect(a).toBe(b);
	});

	it('measures again once the previous one has settled', async () => {
		const { monitor, snapshots } = build();
		await monitor.refreshNow();
		await monitor.refreshNow();
		expect(snapshots()).toBe(2);
	});

	it('attributes the report it hands out, leak included', async () => {
		const { monitor } = build();
		const r = await monitor.refreshNow();
		expect(r!.sessions[0]!.rssBytes).toBe(300 * MB);
		expect(r!.unattributed.rssBytes).toBe(700 * MB);
		expect(r!.totalBytes).toBe((120 + 300 + 700) * MB);
	});

	it('subscribing after a measurement gets the last figure immediately', async () => {
		const { monitor } = build();
		await monitor.refreshNow();
		let got: MemoryReport | null = null;
		monitor.subscribe(60_000, (r) => { got = r; });
		expect(got).toBe(monitor.latest());
	});

	it('subscribing does not itself trigger a measurement', () => {
		const { monitor, snapshots } = build();
		monitor.subscribe(60_000, () => {});
		expect(snapshots()).toBe(0);
		expect(monitor.latest()).toBeNull();
	});

	it('a failed snapshot yields null and keeps the last good report', async () => {
		let fail = false;
		const { monitor } = build({ snapshot: async () => { if (fail) throw new Error('wmi is having a day'); return rows; } });
		const good = await monitor.refreshNow();
		fail = true;
		expect(await monitor.refreshNow()).toBeNull();
		expect(monitor.latest()).toBe(good);
	});

	it('a throwing subscriber does not stop the others hearing about it', async () => {
		const { monitor } = build();
		monitor.subscribe(60_000, () => { throw new Error('broken view'); });
		let reached = false;
		monitor.subscribe(20_000, () => { reached = true; });
		await monitor.refreshNow();
		expect(reached).toBe(true);
	});

	it('a subscriber that unsubscribes during delivery does not break the round', async () => {
		const { monitor } = build();
		let reached = false;
		const off = monitor.subscribe(20_000, () => { off(); });
		monitor.subscribe(60_000, () => { reached = true; });
		await monitor.refreshNow();
		expect(reached).toBe(true);
		expect(monitor.intervalMs()).toBe(60_000);
	});
});

describe('the unattributed record accumulates across polls, panel or no panel', () => {
	it('offers nothing until a process has been unattributed long enough AND often enough', async () => {
		let now = T0;
		const { monitor } = build({ now: () => now });

		await monitor.refreshNow();
		expect(monitor.unattributedPlan(now).victims).toEqual([]); // one poll is not evidence

		// The gauge alone, at 60s: three polls is two minutes, still short of the time gate.
		for (let i = 0; i < 2; i++) { now += 60_000; await monitor.refreshNow(); }
		expect(monitor.unattributedPlan(now).victims).toEqual([]);

		now += 60_000;
		await monitor.refreshNow();
		const plan = monitor.unattributedPlan(now);
		expect(plan.victims.map((v) => v.pid)).toEqual([900]);
		expect(plan.trees.map((t) => t.root)).toEqual([900]);
		expect(plan.totalBytes).toBe(700 * MB);
	});

	it('never offers what a session claims, however long the app has been up', async () => {
		let now = T0;
		const { monitor } = build({ now: () => now });
		for (let i = 0; i < 30; i++) { await monitor.refreshNow(); now += 60_000; }
		const plan = monitor.unattributedPlan(now);
		expect(plan.victims.some((v) => v.pid === 200)).toBe(false);
		expect(plan.trees.some((t) => t.pids.includes(APP))).toBe(false);
	});

	it('has an empty plan before the first snapshot — nothing observed, nothing offered', () => {
		const { monitor } = build();
		expect(monitor.unattributedPlan()).toEqual({ victims: [], trees: [], totalBytes: 0 });
	});
});
