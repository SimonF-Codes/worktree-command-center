import {
	autoCloseCandidates, settleBatch, warningNotice, resultNotice, AUTO_CLOSE_WARN_MS,
	type AutoCloseConfig, type NoticeView, type SessionFacts,
} from './auto-close';
import type { MemoryReport, MemoryRow } from './session-memory';

/** How often auto-close looks for candidates. The same cadence the top-bar gauge already
 *  polls at, so subscribing to the shared monitor costs no extra process snapshot. */
export const AUTO_CLOSE_POLL_MS = 60_000;

/** How often a pending batch is re-checked inside the warning window. A few fresh snapshots
 *  per batch, and batches are rare. */
export const AUTO_CLOSE_RECHECK_MS = 10_000;

/** Where the warning is shown. The renderer owns the countdown; this owns the decisions. */
export interface AutoCloseNotice {
	/** Show — or update in place — the warning naming the batch. */
	warn(view: NoticeView, deadline: number, actions: { keep: () => void; closeNow: () => void }): void;
	/** Replace the warning with what happened. Stays until dismissed. */
	result(view: NoticeView): void;
	/** Take the warning down without a result (cancelled, or the feature turned off). */
	hide(): void;
}

export interface AutoCloserDeps {
	/** The current setting, already parsed — see parseAutoClose. Re-read on every decision. */
	config: () => AutoCloseConfig;
	/** The shared memory monitor's subscription. */
	subscribe: (everyMs: number, fn: (r: MemoryReport) => void) => () => void;
	/** A fresh snapshot, for the re-checks inside the window. Null when none can be taken. */
	refresh: () => Promise<MemoryReport | null>;
	/** What the tile knows about a session (output, last touch, kind), by memory key. */
	facts: (key: string) => SessionFacts | undefined;
	/** The ONE close path for this feature: endSessionKeepingWork, which parks work and keeps the
	 *  branch, worktree and transcript. Never anything that deletes a worktree. */
	endSession: (workspaceId: string, key: string) => Promise<boolean>;
	notice: AutoCloseNotice;
	now?: () => number;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (h: unknown) => void;
}

interface Batch {
	rows: MemoryRow[];
	/** Named at some point, then dropped because it changed — reported, never closed. */
	dropped: MemoryRow[];
	deadline: number;
}

/** Auto-closes finished worker sessions that have been left alone past a threshold.
 *
 *  Off unless the setting is on: while it is off there is no subscription at all, so there is
 *  nothing that COULD close a session. When on, a candidate batch is announced, not acted on:
 *  the notice names every session and stands for AUTO_CLOSE_WARN_MS, the batch is re-checked
 *  against fresh state while it stands, and at the end only the sessions that are STILL
 *  candidates are closed. Anything that went busy, hit a prompt, errored or was touched in the
 *  meantime is dropped from the batch and named as spared. */
export class AutoCloser {
	private unsubscribe: (() => void) | null = null;
	private batch: Batch | null = null;
	private timer: unknown = null;
	private firing = false;
	/** "Keep them" on a notice counts as touching every session it named. */
	private kept = new Map<string, number>();

	constructor(private deps: AutoCloserDeps) {}

	private now(): number { return (this.deps.now ?? Date.now)(); }

	/** Bring the running state in line with the setting. Call once at startup and again
	 *  whenever the setting changes. Turning it off stands down a pending batch unclosed. */
	apply(): void {
		const cfg = this.deps.config();
		if (cfg.enabled) {
			if (!this.unsubscribe) this.unsubscribe = this.deps.subscribe(AUTO_CLOSE_POLL_MS, (r) => this.onReport(r));
			return;
		}
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.batch) { this.clearTimer(); this.batch = null; this.deps.notice.hide(); }
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.clearTimer();
		this.batch = null;
	}

	/** True while a warning is up. */
	get pending(): boolean { return this.batch !== null; }

	private factsFor = (key: string): SessionFacts | undefined => {
		const f = this.deps.facts(key);
		const k = this.kept.get(key);
		if (!f || k === undefined) return f;
		return { ...f, touchedAt: Math.max(f.touchedAt ?? k, k) };
	};

	private candidates(r: MemoryReport | null): MemoryRow[] {
		// No snapshot means no evidence — nothing is a candidate, so a pending batch stands down.
		if (!r) return [];
		return autoCloseCandidates(r.sessions, this.factsFor, this.deps.config(), this.now());
	}

	private onReport(r: MemoryReport): void {
		if (this.batch || this.firing) return; // the window re-checks on its own clock
		const found = this.candidates(r);
		if (!found.length) return;
		this.batch = { rows: found, dropped: [], deadline: this.now() + AUTO_CLOSE_WARN_MS };
		this.showWarning();
		this.schedule();
	}

	private showWarning(): void {
		const b = this.batch;
		if (!b) return;
		this.deps.notice.warn(warningNotice(b.rows, this.deps.config().idleMs, this.now()), b.deadline, {
			keep: () => this.keep(),
			closeNow: () => { void this.fire(); },
		});
	}

	private schedule(): void {
		this.clearTimer();
		const b = this.batch;
		if (!b) return;
		const wait = Math.max(0, Math.min(AUTO_CLOSE_RECHECK_MS, b.deadline - this.now()));
		const set = this.deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
		this.timer = set(() => { this.timer = null; void this.tick(); }, wait);
	}

	private clearTimer(): void {
		if (this.timer === null) return;
		(this.deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
		this.timer = null;
	}

	/** One re-check inside the window, or the close at its end. */
	private async tick(): Promise<void> {
		const b = this.batch;
		if (!b || this.firing) return;
		if (this.now() >= b.deadline) { await this.fire(); return; }
		const r = await this.deps.refresh();
		if (this.batch !== b || this.firing) return; // kept, closed or turned off while measuring
		const { keep, dropped } = settleBatch(b.rows, this.candidates(r));
		if (dropped.length) {
			b.rows = keep;
			b.dropped.push(...dropped);
			if (!keep.length) { this.finish([], b.dropped); return; }
			this.showWarning();
		}
		this.schedule();
	}

	/** Close whatever in the batch is STILL a candidate, from a fresh look. */
	private async fire(): Promise<void> {
		const b = this.batch;
		if (!b || this.firing) return;
		this.firing = true;
		this.clearTimer();
		try {
			const r = await this.deps.refresh();
			if (this.batch !== b) return; // turned off while measuring
			const { keep, dropped } = settleBatch(b.rows, this.candidates(r));
			const closed: MemoryRow[] = [];
			for (const v of keep) {
				try { if (await this.deps.endSession(v.workspaceId, v.key)) closed.push(v); }
				catch { /* a close that throws is a session left running, not one reported closed */ }
			}
			this.finish(closed, [...b.dropped, ...dropped]);
		} finally {
			this.firing = false;
		}
	}

	private finish(closed: MemoryRow[], dropped: MemoryRow[]): void {
		this.clearTimer();
		this.batch = null;
		this.deps.notice.result(resultNotice(closed, dropped, this.now()));
	}

	/** "Keep them": every session named is treated as touched now, so none is offered again
	 *  until it has been left alone for a whole threshold more. */
	private keep(): void {
		const b = this.batch;
		if (!b || this.firing) return;
		const now = this.now();
		for (const r of b.rows) this.kept.set(r.key, now);
		this.clearTimer();
		this.batch = null;
		this.deps.notice.hide();
	}
}
