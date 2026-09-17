import type { MemoryMonitor } from '../terminals/memory-monitor';
import {
	idleLongerThan, formatBytes, formatIdle, closeConfirm, bulkConfirm,
	type MemoryReport, type MemoryRow,
} from '../terminals/session-memory';
import { promptForConfirm } from './prompt-dialog';

/** How fast the SHARED poller runs while this panel is open.
 *
 *  The panel no longer owns a timer. It asks the MemoryMonitor for this cadence and gives it
 *  back on close; the monitor runs one timer at the fastest rate anyone has asked for, so
 *  opening the panel pulls the always-on widget's 60s up to 20s and closing it drops back
 *  again. Two pollers would double exactly the cost the tracker exists to bound. */
export const PANEL_POLL_MS = 20_000;

/** Choices for the bulk close. Hours, because the sessions worth closing are hours old. */
const BULK_CHOICES: Array<{ label: string; ms: number }> = [
	{ label: '30 minutes', ms: 30 * 60_000 },
	{ label: '1 hour', ms: 60 * 60_000 },
	{ label: '2 hours', ms: 2 * 60 * 60_000 },
	{ label: '4 hours', ms: 4 * 60 * 60_000 },
];

export interface MemoryPanelDeps {
	/** The one process poller, shared with the top-bar widget. The session claims and the app
	 *  pid live there now, because they belong to whoever takes the snapshot. */
	monitor: MemoryMonitor;
	/** End one session, keeping its worktree and branch. Returns false if it was already gone. */
	endSession: (workspaceId: string, key: string) => Promise<boolean>;
	toast: (msg: string, variant?: 'info' | 'warn' | 'error') => void;
}

/** "Session memory": what every live session is costing in RAM, across every workspace, and
 *  what is running that no session claims.
 *
 *  Attribution comes from the PROCESS TREE, never from the tile list. That is the whole point:
 *  on 2026-09-16 the floor showed five terminals while 81 `claude` processes held 19.5 GB, and
 *  a panel built by summing tiles would have agreed with the floor. */
export class MemoryPanel {
	private el: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private unsubscribe: (() => void) | null = null;
	private report: MemoryReport | null = null;
	private bulkMs = BULK_CHOICES[1]!.ms;

	constructor(private deps: MemoryPanelDeps) {}

	toggle(parent: HTMLElement): void {
		if (this.el) { this.close(); return; }
		this.open(parent);
	}

	open(parent: HTMLElement): void {
		if (this.el) return;
		this.el = parent.createDiv({ cls: 'wcc-mem-panel' });
		this.el.addEventListener('click', (e) => e.stopPropagation());
		this.renderShell();
		// Subscribing hands over the last known report straight away, so the panel opens onto
		// the widget's figure rather than flashing "Measuring…" for a third of a second.
		this.unsubscribe = this.deps.monitor.subscribe(PANEL_POLL_MS, (r) => {
			if (!this.el) return; // closed while a snapshot was in flight
			this.report = r;
			this.renderBody();
		});
		void this.refresh();
	}

	close(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.el?.remove();
		this.el = null;
		this.bodyEl = null;
	}

	private renderShell(): void {
		if (!this.el) return;
		this.el.empty();
		const head = this.el.createDiv({ cls: 'wcc-mem-head' });
		head.createSpan({ cls: 'wcc-mem-title', text: '🧠 Session memory' });
		const refreshBtn = head.createEl('button', { cls: 'wcc-mem-refresh', text: '⟳', attr: { title: 'Measure now' } });
		refreshBtn.addEventListener('click', () => void this.refresh());

		this.bodyEl = this.el.createDiv({ cls: 'wcc-mem-body' });

		// Stated up front, because it is what makes the buttons below easy to press. Verified,
		// not assumed: transcripts in ~/.claude/projects are keyed by worktree path and outlive
		// the process — QMK-Flasher worktrees that no longer exist still have theirs.
		this.el.createDiv({
			cls: 'wcc-mem-note',
			text: 'Closing is cheap. The conversation is kept on disk (~/.claude/projects, keyed by worktree path) '
				+ 'and the worktree and branch are left in place — uncommitted work is parked as a wip commit first. '
				+ 'Reopen in the Coordination panel brings it back. Nothing here ever closes on its own.',
		});

		const foot = this.el.createDiv({ cls: 'wcc-mem-foot' });
		const sel = foot.createEl('select', { cls: 'wcc-mem-bulk-sel', attr: { title: 'Idle threshold for the bulk close' } });
		for (const c of BULK_CHOICES) {
			const o = sel.createEl('option', { text: `idle over ${c.label}`, value: String(c.ms) });
			if (c.ms === this.bulkMs) o.selected = true;
		}
		sel.addEventListener('change', () => { this.bulkMs = Number(sel.value); this.renderBody(); });
		const bulkBtn = foot.createEl('button', { cls: 'wcc-mem-bulk', text: 'Close all idle…' });
		bulkBtn.addEventListener('click', () => void this.closeBulk());
		const closeBtn = foot.createEl('button', { cls: 'wcc-mem-close', text: 'Close' });
		closeBtn.addEventListener('click', () => this.close());
	}

	/** Ask the shared poller to measure now. It coalesces concurrent callers, so ⟳ landing on
	 *  the same moment as a tick still costs one snapshot; the rendering happens in the
	 *  subscription callback either way. */
	private async refresh(): Promise<void> {
		await this.deps.monitor.refreshNow();
	}

	private renderBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		body.empty();
		const r = this.report;
		if (!r) { body.createDiv({ cls: 'wcc-mem-empty', text: 'Measuring…' }); return; }
		if (!r.sessions.length && !r.unattributed.procCount && !r.appSelfBytes) {
			body.createDiv({ cls: 'wcc-mem-empty', text: 'No process snapshot available on this platform.' });
			return;
		}

		const now = Date.now();
		const totalRow = body.createDiv({ cls: 'wcc-mem-total' });
		totalRow.createSpan({ text: `${formatBytes(r.totalBytes)} total` });
		totalRow.createSpan({ cls: 'wcc-mem-total-sub', text: `${r.sessions.length} session${r.sessions.length === 1 ? '' : 's'} · app itself ${formatBytes(r.appSelfBytes)}` });

		// The unattributed row goes FIRST when it has anything in it. It is the leak detector,
		// and a leak detector below the fold detects nothing.
		if (r.unattributed.procCount > 0) this.renderUnattributed(body, r);

		const selected = new Set(idleLongerThan(r.sessions, this.bulkMs, now).map((s) => s.key));
		for (const s of r.sessions) this.renderRow(body, s, now, selected.has(s.key));
	}

	private renderUnattributed(body: HTMLElement, r: MemoryReport): void {
		const el = body.createDiv({ cls: 'wcc-mem-row wcc-mem-unattributed' });
		const main = el.createDiv({ cls: 'wcc-mem-rowmain' });
		main.createSpan({ cls: 'wcc-mem-name', text: '⚠ Unattributed' });
		main.createSpan({ cls: 'wcc-mem-ram', text: formatBytes(r.unattributed.rssBytes) });
		el.createDiv({
			cls: 'wcc-mem-sub',
			text: `${r.unattributed.procCount} process${r.unattributed.procCount === 1 ? '' : 'es'} under this app that no session owns`,
		});
		el.createDiv({
			cls: 'wcc-mem-sub wcc-mem-hint',
			// No close button here on purpose: these pids belong to nothing the app can name, so
			// the honest action is to report them and let a restart (which reaps them) clear it.
			text: 'Nothing on the floor is holding these. Restarting the app reaps them — and if this keeps growing, something is leaking.',
		});
	}

	private renderRow(body: HTMLElement, s: MemoryRow, now: number, inBulk: boolean): void {
		const el = body.createDiv({ cls: `wcc-mem-row${inBulk ? ' wcc-mem-inbulk' : ''}` });
		const main = el.createDiv({ cls: 'wcc-mem-rowmain' });
		main.createSpan({ cls: 'wcc-mem-name', text: s.name });
		main.createSpan({ cls: 'wcc-mem-ram', text: s.dead ? '—' : formatBytes(s.rssBytes) });

		const bits = [`${s.workspaceName} · ${s.repo}`];
		if (s.branch) bits.push(s.branch);
		el.createDiv({ cls: 'wcc-mem-sub', text: bits.join(' · ') });

		const state = el.createDiv({ cls: 'wcc-mem-sub' });
		if (s.dead) state.createSpan({ cls: 'wcc-mem-dead', text: 'session ended — tile still on the floor' });
		else if (s.busy) state.createSpan({ cls: 'wcc-mem-busy', text: '● working' });
		else state.createSpan({ text: s.idleSince === null ? 'idle' : `idle ${formatIdle(now - s.idleSince)}` });
		if (s.hidden) state.createSpan({ cls: 'wcc-mem-tag', text: 'hidden' });
		if (s.system) state.createSpan({ cls: 'wcc-mem-tag', text: 'app' });

		if (s.system) return; // the usage battery's probe is not the user's to close
		const btn = el.createEl('button', { cls: 'wcc-mem-endbtn', text: 'Close' });
		btn.addEventListener('click', () => void this.closeOne(s));
	}

	private async closeOne(s: MemoryRow): Promise<void> {
		const c = closeConfirm(s);
		const ok = await promptForConfirm(c.title, c.body, c.okLabel);
		if (!ok) return;
		const freed = s.rssBytes;
		const done = await this.deps.endSession(s.workspaceId, s.key);
		if (!done) { this.deps.toast(`"${s.name}" was already gone`, 'warn'); }
		else this.deps.toast(`Closed "${s.name}" — freed about ${formatBytes(freed)}`);
		await this.refresh();
	}

	private async closeBulk(): Promise<void> {
		const r = this.report;
		if (!r) return;
		const label = BULK_CHOICES.find((c) => c.ms === this.bulkMs)?.label ?? 'that long';
		const victims = idleLongerThan(r.sessions, this.bulkMs, Date.now());
		if (!victims.length) { this.deps.toast(`Nothing has been idle over ${label}`, 'warn'); return; }
		const freed = victims.reduce((a, v) => a + v.rssBytes, 0);
		const c = bulkConfirm(victims, label, Date.now());
		const ok = await promptForConfirm(c.title, c.body, c.okLabel);
		if (!ok) return;
		let closed = 0;
		for (const v of victims) if (await this.deps.endSession(v.workspaceId, v.key)) closed++;
		this.deps.toast(`Closed ${closed} session${closed === 1 ? '' : 's'} — freed about ${formatBytes(freed)}`);
		await this.refresh();
	}
}
