import * as os from 'os';
import type { MemoryMonitor } from '../terminals/memory-monitor';
import { splitMemory, splitDetail } from '../terminals/memory-gauge';
import {
	idleLongerThan, formatBytes, formatIdle, closeConfirm, bulkConfirm, unattributedConfirm,
	unattributedResult, type KillOutcome, type MemoryReport, type MemoryRow,
} from '../terminals/session-memory';
import { STALE_MS, type CloseableTree } from '../terminals/unattributed-tracker';
import { killProcessTree, type KillResult } from '../terminals/kill-tree';
import type { ProcRow } from '../terminals/process-snapshot';
import { ServiceCache } from '../terminals/service-snapshot';
import {
	buildSystemView, hostLabel, outsideCliSummary, svchostCaveat, svchostHeadline, type SystemView,
} from '../terminals/system-memory';
import { promptForConfirm } from './prompt-dialog';

/** The panel's two views. Split by QUESTION, not by data: Sessions is "what can I close",
 *  System is "what is the machine doing". Both render from the one snapshot the panel's single
 *  subscription receives, so they cannot disagree with each other. */
export type MemoryView = 'sessions' | 'system';

/** How many rows of each System list are shown before the rest are folded into a count. */
const SYSTEM_TOP = 8;

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

/** A closeable tree's identity across two plans: the pid alone would let a recycled number
 *  inherit the agreement given for the process that held it. */
const treeKey = (t: CloseableTree): string => `${t.root}@${t.startedAt}`;

/** The age gate in words, derived from the constant so the copy cannot drift away from the
 *  rule it describes. */
function staleLabel(): string {
	const mins = STALE_MS / 60_000;
	if (mins >= 1) return `${mins} minute${mins === 1 ? '' : 's'}`;
	return `${Math.round(STALE_MS / 1000)} seconds`;
}

export interface MemoryPanelDeps {
	/** The one process poller, shared with the top-bar widget. The session claims and the app
	 *  pid live there now, because they belong to whoever takes the snapshot. */
	monitor: MemoryMonitor;
	/** End one session, keeping its worktree and branch. Returns false if it was already gone. */
	endSession: (workspaceId: string, key: string) => Promise<boolean>;
	toast: (msg: string, variant?: 'info' | 'warn' | 'error') => void;
	/** How an unattributed process tree is ended. The app's ONE kill path, injectable only so a
	 *  test never has to spawn taskkill. */
	killTree?: (pid: number) => Promise<KillResult>;
	/** The machine, for the total row's three-way split. Defaults to `os.totalmem()`. */
	totalRamBytes?: number;
	/** Free memory, re-read on every render for the reason the widget re-reads it: unlike the
	 *  total it moves. A function, not a number. Defaults to `os.freemem()`. */
	freeRamBytes?: () => number;
	/** The System view's service map (Win32_Service). Injectable so a test can count the queries
	 *  without spawning PowerShell. */
	services?: ServiceCache;
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
	/** The snapshot `report` was rolled up from — what the System view walks. Never re-queried. */
	private rows: readonly ProcRow[] = [];
	private bulkMs = BULK_CHOICES[1]!.ms;
	private view: MemoryView = 'sessions';
	private readonly services: ServiceCache;

	constructor(private deps: MemoryPanelDeps) {
		this.services = deps.services ?? new ServiceCache();
	}

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
		//
		// ONE subscription for both views. Switching view never subscribes, never unsubscribes and
		// never measures: the System view is a different reading of the same rows, which is what
		// makes it impossible for the two to disagree — and impossible for it to add a poller.
		this.unsubscribe = this.deps.monitor.subscribe(PANEL_POLL_MS, (r, rows) => {
			if (!this.el) return; // closed while a snapshot was in flight
			this.report = r;
			this.rows = rows;
			if (this.view === 'system') void this.refreshServices(false);
			this.renderBody();
		});
		void this.refresh();
	}

	close(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		// The service map is only ever held while someone is looking at it.
		this.services.clear();
		this.el?.remove();
		this.el = null;
		this.bodyEl = null;
	}

	/** Which view is showing. For tests and for the app; switching is a click on the tab. */
	currentView(): MemoryView { return this.view; }

	showView(v: MemoryView): void {
		if (v === this.view) return;
		this.view = v;
		// Leaving System drops the service map, for the same reason closing the panel does.
		if (v === 'system') void this.refreshServices(false);
		else this.services.clear();
		this.renderShell();
		this.renderBody();
	}

	private renderShell(): void {
		if (!this.el) return;
		this.el.empty();
		const head = this.el.createDiv({ cls: 'wcc-mem-head' });
		head.createSpan({ cls: 'wcc-mem-title', text: '🧠 Memory' });
		const tabs = head.createDiv({ cls: 'wcc-mem-tabs' });
		for (const [v, label, title] of [
			['sessions', 'Sessions', 'What every session costs, and what can be closed'],
			['system', 'System', 'What the whole machine is spending memory on — read-only'],
		] as const) {
			const t = tabs.createEl('button', {
				cls: `wcc-mem-tab${this.view === v ? ' is-active' : ''}`, text: label, attr: { title, 'data-view': v },
			});
			t.addEventListener('click', () => this.showView(v));
		}
		const refreshBtn = head.createEl('button', { cls: 'wcc-mem-refresh', text: '⟳', attr: { title: 'Measure now' } });
		refreshBtn.addEventListener('click', () => void this.refresh());

		this.bodyEl = this.el.createDiv({ cls: 'wcc-mem-body' });

		if (this.view === 'system') {
			// Said where the buttons would be, because their absence is a decision, not a gap.
			this.el.createDiv({
				cls: 'wcc-mem-note',
				text: 'Read-only, deliberately. Nothing here stops, disables or ends a Windows service or process: '
					+ 'closing a session is reversible and Reopen brings it back, but stopping a service can take '
					+ 'audio, networking or the firewall down with no undo.',
			});
			const foot = this.el.createDiv({ cls: 'wcc-mem-foot' });
			const closeBtn = foot.createEl('button', { cls: 'wcc-mem-close', text: 'Close' });
			closeBtn.addEventListener('click', () => this.close());
			return;
		}

		// Stated up front, because it is what makes the buttons below easy to press. Verified,
		// not assumed: transcripts in ~/.claude/projects are keyed by worktree path and outlive
		// the process — QMK-Flasher worktrees that no longer exist still have theirs.
		this.el.createDiv({
			cls: 'wcc-mem-note',
			text: 'Closing is cheap. The conversation is kept on disk (~/.claude/projects, keyed by worktree path) '
				+ 'and the worktree and branch are left in place — uncommitted work is parked as a wip commit first. '
				+ 'Reopen in the Coordination panel brings it back. Nothing closes on its own unless auto-close is '
				+ 'turned on in ⚙ Settings — and then only finished, untouched sessions, named a minute before.',
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
		// ⟳ on the System view asks the services too — the one way to see a service that just
		// started without waiting out the cache's floor.
		if (this.view === 'system') await this.refreshServices(true);
	}

	/** Ask Win32_Service if the cache says it is worth it, then repaint. Only ever called while the
	 *  System view is showing. */
	private async refreshServices(force: boolean): Promise<void> {
		const before = this.services.latest();
		const after = await this.services.refresh(this.rows, force);
		if (after !== before && this.el && this.view === 'system') this.renderBody();
	}

	private renderBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		body.empty();
		if (this.view === 'system') { this.renderSystem(body); return; }
		const r = this.report;
		if (!r) { body.createDiv({ cls: 'wcc-mem-empty', text: 'Measuring…' }); return; }
		if (!r.sessions.length && !r.unattributed.procCount && !r.appSelfBytes) {
			body.createDiv({ cls: 'wcc-mem-empty', text: 'No process snapshot available on this platform.' });
			return;
		}

		const now = Date.now();
		// "X total" carried the same ambiguity the top-bar gauge did — it said nothing about
		// whether the rest of the machine was free or spoken for. Same three quantities, same
		// order, same clamp, from the same pure function the gauge uses.
		const split = splitMemory(
			this.deps.totalRamBytes ?? os.totalmem(),
			this.deps.freeRamBytes ? this.deps.freeRamBytes() : os.freemem(),
			r.totalBytes,
		);
		const detail = splitDetail(split);
		const box = body.createDiv({ cls: 'wcc-mem-total' });
		const totalRow = box.createDiv({ cls: 'wcc-mem-total-line' });
		totalRow.createSpan({ text: detail.main });
		totalRow.createSpan({ cls: 'wcc-mem-total-sub', text: detail.sub });
		box.createDiv({
			cls: 'wcc-mem-total-meta',
			text: `${r.sessions.length} session${r.sessions.length === 1 ? '' : 's'} · app itself ${formatBytes(r.appSelfBytes)}`
				+ ' · this app\'s figure is a sum of process working sets, so pages shared between them are counted'
				+ ' once each — it reads slightly high, and "other" is the remainder.',
		});

		// The unattributed row goes FIRST when it has anything in it. It is the leak detector,
		// and a leak detector below the fold detects nothing.
		if (r.unattributed.procCount > 0) this.renderUnattributed(body, r);

		const selected = new Set(idleLongerThan(r.sessions, this.bulkMs, now).map((s) => s.key));
		for (const s of r.sessions) this.renderRow(body, s, now, selected.has(s.key));
	}

	/** "What is this machine spending memory on."
	 *
	 *  READ-ONLY, and it must stay that way: no row in this view carries a button. The symmetry with
	 *  the Sessions view's Close is superficial — closing a finished session is reversible, while
	 *  stopping a Windows service can break audio, networking or the firewall with no undo. If a
	 *  control is ever added here for consistency, that is the mistake this comment exists to stop.
	 *
	 *  Rendered from the monitor's rows, never from a snapshot of its own. */
	private renderSystem(body: HTMLElement): void {
		if (!this.report) { body.createDiv({ cls: 'wcc-mem-empty', text: 'Measuring…' }); return; }
		if (!this.rows.length) {
			body.createDiv({ cls: 'wcc-mem-empty', text: 'No process snapshot available on this platform.' });
			return;
		}
		const v: SystemView = buildSystemView(this.rows, this.deps.monitor.appPid(), this.services.latest());
		const total = this.deps.totalRamBytes ?? os.totalmem();
		const free = this.deps.freeRamBytes ? this.deps.freeRamBytes() : os.freemem();

		const box = body.createDiv({ cls: 'wcc-mem-total' });
		const line = box.createDiv({ cls: 'wcc-mem-total-line' });
		line.createSpan({ text: `${formatBytes(Math.max(0, total - free))} in use of ${formatBytes(total)}` });
		line.createSpan({ cls: 'wcc-mem-total-sub', text: `${formatBytes(free)} free` });
		box.createDiv({
			cls: 'wcc-mem-total-meta',
			text: `${this.rows.length} processes, working sets summing to ${formatBytes(v.machine.totalBytes)}. `
				+ 'Shared pages count once per process, so the sum is not the same figure as "in use".',
		});

		// Before anything else: it is often the single biggest line, and the worst one to chase.
		if (v.compression) {
			const el = this.sysRow(body, 'Memory Compression', v.compression.rssBytes, 'wcc-sys-symptom', 'symptom');
			el.createDiv({ cls: 'wcc-mem-sub', text: v.compression.label });
		}

		this.section(body, 'By owner — attributed by process tree, never by name');
		const m = v.machine;
		this.sysRow(body, 'This app (Worktree Command Center)', m.wcc.rssBytes)
			.createDiv({ cls: 'wcc-mem-sub', text: `${m.wcc.procCount} process${m.wcc.procCount === 1 ? '' : 'es'} — every session on the floor, see Sessions` });
		if (m.desktop.procCount) {
			this.sysRow(body, 'Claude desktop app', m.desktop.rssBytes)
				.createDiv({ cls: 'wcc-mem-sub', text: `${m.desktop.procCount} processes — its own helpers, not leaked subagents` });
		}
		const outside = outsideCliSummary(m);
		if (outside) {
			const el = this.sysRow(body, '⚠ Claude CLI outside this app', m.outsideCliTotal.rssBytes, 'wcc-sys-outside');
			el.createDiv({ cls: 'wcc-mem-sub', text: outside });
			for (const c of m.outsideCli) {
				const from = c.parentName ? `started from ${c.parentName}` : 'its parent has exited';
				el.createDiv({
					cls: 'wcc-mem-sub wcc-sys-item',
					text: `pid ${c.rootPid} · ${from} · ${c.procCount} process${c.procCount === 1 ? '' : 'es'} · ${formatBytes(c.rssBytes)}`,
				});
			}
		}
		const shown = m.programs.slice(0, SYSTEM_TOP);
		for (const p of shown) {
			this.sysRow(body, p.name, p.rssBytes)
				.createDiv({ cls: 'wcc-mem-sub', text: `${p.procCount} process${p.procCount === 1 ? '' : 'es'}` });
		}
		this.more(body, m.programs.slice(SYSTEM_TOP), 'program');

		this.section(body, 'svchost — by the services it hosts');
		const s = v.svchost;
		body.createDiv({ cls: 'wcc-mem-sub wcc-sys-lede', text: svchostHeadline(s) });
		const caveat = svchostCaveat(s);
		if (caveat) body.createDiv({ cls: 'wcc-mem-sub wcc-mem-hint', text: caveat });
		for (const h of s.hosts.slice(0, SYSTEM_TOP)) {
			const el = this.sysRow(body, hostLabel(h, s.servicesKnown), h.rssBytes);
			const bits = [`pid ${h.pid}`];
			if (h.group) bits.push(`-k ${h.group}`);
			if (s.servicesKnown && h.services.length === 1) bits.push(h.services[0]!.displayName);
			el.createDiv({ cls: 'wcc-mem-sub', text: bits.join(' · ') });
		}
		if (s.groups.length) {
			body.createDiv({ cls: 'wcc-sys-subhead', text: 'Per -k group' });
			for (const g of s.groups.slice(0, SYSTEM_TOP)) {
				this.sysRow(body, g.group, g.rssBytes).createDiv({
					cls: 'wcc-mem-sub',
					text: `${g.hosts} process${g.hosts === 1 ? '' : 'es'} · ${g.services} service${g.services === 1 ? '' : 's'}`,
				});
			}
			this.more(body, s.groups.slice(SYSTEM_TOP).map((g) => ({ rssBytes: g.rssBytes })), 'group');
		}

		this.section(body, 'VM-backed memory');
		const vm = v.vm;
		const vmEl = this.sysRow(body, vm.entries.length ? vm.entries.map((e) => e.name).join(', ') : 'vmmem', vm.entries.length ? vm.totalBytes : null);
		vmEl.createDiv({ cls: 'wcc-mem-sub', text: vm.behind });
		for (const f of vm.facts) vmEl.createDiv({ cls: 'wcc-mem-sub wcc-sys-item', text: f });
	}

	/** A System row: a name and a figure, and deliberately nothing to press. */
	private sysRow(body: HTMLElement, name: string, bytes: number | null, extra = '', tag = ''): HTMLElement {
		const el = body.createDiv({ cls: `wcc-mem-row wcc-sys-row${extra ? ` ${extra}` : ''}` });
		const main = el.createDiv({ cls: 'wcc-mem-rowmain' });
		const nameEl = main.createSpan({ cls: 'wcc-mem-name', text: name });
		if (tag) nameEl.createSpan({ cls: 'wcc-mem-tag wcc-sys-tag', text: tag });
		main.createSpan({ cls: 'wcc-mem-ram', text: bytes === null ? '—' : formatBytes(bytes) });
		return el;
	}

	private section(body: HTMLElement, text: string): void {
		body.createDiv({ cls: 'wcc-sys-head', text });
	}

	private more(body: HTMLElement, rest: ReadonlyArray<{ rssBytes: number }>, noun: string): void {
		if (!rest.length) return;
		body.createDiv({
			cls: 'wcc-mem-sub wcc-sys-more',
			text: `…and ${rest.length} more ${noun}${rest.length === 1 ? '' : 's'} · ${formatBytes(rest.reduce((a, x) => a + x.rssBytes, 0))}`,
		});
	}

	/** The leak row, and the only place on the floor that offers to end a process no session
	 *  claims.
	 *
	 *  This row used to carry a comment refusing a close button — "these pids belong to nothing
	 *  the app can name, so the honest action is to report them and let a restart (which reaps
	 *  them) clear it". The objection behind it stands, and is now written into the rule below.
	 *  What did not stand is the remedy: restarting kills every session on the floor to reclaim
	 *  memory held by things that are not sessions, which is why the usage-probe leak was left
	 *  running for hours — the only cure cost more than the disease.
	 *
	 *  So there is a button, and AGE is what makes it safe. Unattributed is not a synonym for
	 *  leaked: git invoked by the coordination hooks, cos-coord and their conhosts pass through
	 *  this row constantly, and a git killed mid-write can leave an index.lock in a repo eight
	 *  terminals share — damage that surfaces much later, somewhere else. Only processes that
	 *  have been unattributed in EVERY snapshot for over three minutes and at least three polls,
	 *  with nothing younger anywhere in their tree, are ever offered. A transient never lives
	 *  long enough to qualify; a leak has been there for hours.
	 *
	 *  Never automatic, at any threshold. Which processes matter is a judgement only the person
	 *  looking at the floor has, and an auto-reaper that gets it wrong corrupts a shared repo. */
	private renderUnattributed(body: HTMLElement, r: MemoryReport): void {
		const el = body.createDiv({ cls: 'wcc-mem-row wcc-mem-unattributed' });
		const main = el.createDiv({ cls: 'wcc-mem-rowmain' });
		main.createSpan({ cls: 'wcc-mem-name', text: '⚠ Unattributed' });
		main.createSpan({ cls: 'wcc-mem-ram', text: formatBytes(r.unattributed.rssBytes) });
		el.createDiv({
			cls: 'wcc-mem-sub',
			text: `${r.unattributed.procCount} process${r.unattributed.procCount === 1 ? '' : 'es'} under this app that no session owns`,
		});

		const plan = this.deps.monitor.unattributedPlan();
		const n = plan.victims.length;
		el.createDiv({
			cls: 'wcc-mem-sub wcc-mem-hint',
			text: n
				? `${n} of them ${n === 1 ? 'has' : 'have'} been unattributed on every poll for over ${staleLabel()} — `
					+ `${formatBytes(plan.totalBytes)}, safe to close. The rest are too young to be sure about, and are left alone.`
				: `Nothing here has been unattributed for over ${staleLabel()} yet. Short-lived processes — git from the `
					+ 'coordination hooks, cos-coord, their conhosts — pass through this row constantly, and killing one '
					+ 'mid-write can lock up a repo the other terminals share. If this keeps growing, something is leaking.',
		});
		if (!n) return;
		const btn = el.createEl('button', { cls: 'wcc-mem-endbtn', text: `Close ${n} stale…` });
		btn.addEventListener('click', () => void this.closeUnattributed());
	}

	/** End the processes that have earned it. Measures twice, kills once.
	 *
	 *  The plan is rebuilt from a FRESH snapshot before the confirm, and again after it, and only
	 *  the trees in both — same root, same start time — are killed. That window is exactly when a
	 *  stale process can spawn a git for a coordination hook, and killProcessTree takes the whole
	 *  tree: a plan agreed to a minute ago is not evidence about the tree as it stands now. A pid
	 *  recycled in between is a different process and fails the start-time check. Whatever changed
	 *  is reported as left alone rather than killed on the strength of the older look. */
	private async closeUnattributed(): Promise<void> {
		await this.deps.monitor.refreshNow();
		const planned = this.deps.monitor.unattributedPlan();
		if (!planned.victims.length) {
			this.deps.toast(`Nothing has been unattributed for over ${staleLabel()}`, 'warn');
			return;
		}
		const c = unattributedConfirm(planned, Date.now(), staleLabel());
		if (!await promptForConfirm(c.title, c.body, c.okLabel)) return;

		await this.deps.monitor.refreshNow();
		const agreed = new Set(planned.trees.map(treeKey));
		const trees = this.deps.monitor.unattributedPlan().trees.filter((t) => agreed.has(treeKey(t)));

		// The app's ONE kill path: verified, retried once, and it remembers a pid whose death it
		// could not confirm so a later sweep can try again.
		const kill = this.deps.killTree ?? killProcessTree;
		const outcome: KillOutcome = { ended: 0, freedBytes: 0, failed: [], skipped: planned.trees.length - trees.length };
		for (const t of trees) {
			const res = await kill(t.root);
			if (res.ok) { outcome.ended += t.pids.length; outcome.freedBytes += t.rssBytes; }
			else outcome.failed.push({ pid: t.root, detail: res.detail });
		}
		const { message, variant } = unattributedResult(outcome);
		this.deps.toast(message, variant);
		await this.refresh();
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
		// The confirm names the way back; so does this. The confirm is read under pressure with a
		// list in front of you — the toast is what is still on screen ten seconds later, when you
		// wonder what you just did.
		else this.deps.toast(`Closed "${s.name}" — freed about ${formatBytes(freed)} · reopen it from the Coordination panel`);
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
		this.deps.toast(`Closed ${closed} session${closed === 1 ? '' : 's'} — freed about ${formatBytes(freed)}`
			+ ' · reopen them from the Coordination panel');
		await this.refresh();
	}
}
