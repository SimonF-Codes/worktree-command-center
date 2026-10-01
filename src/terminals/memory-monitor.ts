import { snapshotProcesses, type ProcRow } from './process-snapshot';
import { attributeMemory, type MemoryReport, type SessionClaim } from './session-memory';
import {
	trackUnattributed, closeableUnattributed, EMPTY_UNATTRIBUTED,
	type CloseablePlan, type UnattributedState,
} from './unattributed-tracker';

/** ONE process snapshot, shared by everything that wants to know about memory.
 *
 *  The tracker's original design said "poll only while the panel is open", for a good reason:
 *  *a memory tracker that itself spawns a process every few seconds is the bug it is
 *  reporting.* An always-visible widget cannot honour that as written, so the rule becomes
 *  **two cadences, one poller** — and this class is the one poller.
 *
 *  Subscribers ask for the cadence they want. The monitor runs a single timer at the FASTEST
 *  one asked for, and no timer at all when nobody is listening. So the widget alone polls at
 *  60s, opening the panel pulls the shared timer up to 20s, closing it drops back, and at no
 *  point do two `Win32_Process` queries exist — which would double exactly the cost this is
 *  trying to bound.
 *
 *  MEASURED, because an interval is meaningless without the price of a poll: on this machine
 *  (16 cores, 416 processes) one snapshot costs ~300 ms wall and ~280 ms of CPU, of which
 *  ~155 ms is PowerShell interpreter startup and ~130 ms the CIM query itself. At 60s that is
 *  0.5% of one core; at the panel's 20s, 1.4%. */
export interface MemoryMonitorDeps {
	/** Claims from EVERY workspace, not just the visible tab — the sessions you forget are by
	 *  definition in tabs you are not looking at. */
	claims: () => SessionClaim[];
	/** This process's pid — the root everything unclaimed is measured against. */
	appPid?: number;
	/** Injectable so tests can drive the monitor without spawning PowerShell. */
	snapshot?: () => Promise<ProcRow[]>;
	/** Injectable timers, for the same reason. Defaults to the host's (window in the renderer). */
	setInterval?: (fn: () => void, ms: number) => number;
	clearInterval?: (handle: number) => void;
	/** Injectable clock. The unattributed record is measured in wall time, so a test that walks
	 *  a process through three minutes of polls must be able to say so without waiting. */
	now?: () => number;
}

/** `rows` is the raw snapshot the report was rolled up from — the SAME rows, not a second look.
 *  The System view needs the whole machine rather than the app's subtree, and handing it this
 *  snapshot is what lets it exist without a `Win32_Process` query of its own. */
export type MemorySubscriber = (report: MemoryReport, rows: readonly ProcRow[]) => void;

interface Sub { id: number; everyMs: number; fn: MemorySubscriber }

export class MemoryMonitor {
	private subs: Sub[] = [];
	private nextId = 1;
	private timer: number | null = null;
	private timerMs: number | null = null;
	private inFlight: Promise<MemoryReport | null> | null = null;
	private last: MemoryReport | null = null;
	private lastRows: readonly ProcRow[] = [];
	private tracking: UnattributedState = EMPTY_UNATTRIBUTED;

	constructor(private deps: MemoryMonitorDeps) {}

	/** Listen at `everyMs`. The last known report is delivered straight away when there is one,
	 *  so a panel opening onto a 60s-old figure paints immediately instead of flashing
	 *  "Measuring…". Returns the unsubscribe; calling it twice is harmless.
	 *
	 *  Deliberately does NOT kick off a measurement. A snapshot costs a third of a second and a
	 *  transient ~120 MB of PowerShell, so who pays for the first one is the caller's decision,
	 *  not a side effect of listening. */
	subscribe(everyMs: number, fn: MemorySubscriber): () => void {
		const sub: Sub = { id: this.nextId++, everyMs, fn };
		this.subs.push(sub);
		this.retune();
		if (this.last) this.deliver(sub, this.last, this.lastRows);
		let gone = false;
		return () => {
			if (gone) return;
			gone = true;
			this.subs = this.subs.filter((s) => s.id !== sub.id);
			this.retune();
		};
	}

	/** Measure now. Concurrent callers share ONE snapshot rather than racing two — the widget's
	 *  tick and the panel's ⟳ landing together must not cost twice. */
	refreshNow(): Promise<MemoryReport | null> {
		if (this.inFlight) return this.inFlight;
		const p = (async (): Promise<MemoryReport | null> => {
			try {
				const rows = await (this.deps.snapshot ?? snapshotProcesses)();
				const report = attributeMemory(rows, this.appPid(), this.deps.claims());
				this.last = report;
				// The record of what has been unattributed, and for how long, is kept HERE rather
				// than in the panel: the gauge polls at 60s with the panel shut, and the evidence a
				// close needs is gathered the whole time the app is open, not from the moment
				// someone looks. An unreadable snapshot arrives as [] and therefore resets every
				// clock — the conservative direction, since the alternative is crediting a process
				// with time nothing observed.
				this.lastRows = rows;
				this.tracking = trackUnattributed(this.tracking, rows, report.unattributed.pids, this.clock());
				// Copy: a subscriber may unsubscribe (the panel closing on a click) mid-delivery.
				for (const s of [...this.subs]) this.deliver(s, report, rows);
				return report;
			} catch {
				// An unreadable snapshot degrades to "no new data", never throws into a render loop.
				return null;
			} finally {
				this.inFlight = null;
			}
		})();
		this.inFlight = p;
		return p;
	}

	/** The most recent report, or null before the first one lands. */
	latest(): MemoryReport | null { return this.last; }

	/** The pid attribution is measured against, so a view walking the same rows agrees with it. */
	appPid(): number { return this.deps.appPid ?? process.pid; }

	/** Which unattributed processes have been unattributed long enough, and often enough, to be
	 *  safe to offer — and which pids to actually kill for them. See unattributed-tracker for
	 *  why age is the safety mechanism and why nothing here ever acts on its own. */
	unattributedPlan(now: number = this.clock()): CloseablePlan {
		return closeableUnattributed(this.lastRows, this.tracking, now);
	}

	/** 0 or 1 — never more. The whole point of the class, and asserted in the tests. */
	pollerCount(): number { return this.timer === null ? 0 : 1; }

	/** The cadence the single timer is running at, or null when nothing is listening. */
	intervalMs(): number | null { return this.timerMs; }

	dispose(): void {
		this.subs = [];
		this.retune();
	}

	private clock(): number { return (this.deps.now ?? Date.now)(); }

	/** Run one timer at the fastest cadence anyone asked for, and none when nobody did.
	 *  Idempotent: an unchanged cadence leaves the existing timer alone rather than restarting
	 *  it, so a subscriber joining at a slower rate cannot keep resetting the clock. */
	private retune(): void {
		const want = this.subs.length ? Math.min(...this.subs.map((s) => s.everyMs)) : null;
		if (want === this.timerMs) return;
		const clear = this.deps.clearInterval ?? ((h: number) => clearInterval(h as unknown as NodeJS.Timeout));
		if (this.timer !== null) { clear(this.timer); this.timer = null; }
		this.timerMs = want;
		if (want === null) return;
		const set = this.deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number);
		this.timer = set(() => void this.refreshNow(), want);
	}

	/** One subscriber throwing must not stop the others hearing about a leak. */
	private deliver(sub: Sub, report: MemoryReport, rows: readonly ProcRow[]): void {
		try { sub.fn(report, rows); } catch { /* a broken view is not the monitor's problem */ }
	}
}
