/** 📊 The Project panel (V2 Team Floor step 11). A main-pane view, PINNED as a column beside the
 *  stage only while that still leaves one usable terminal (core/project-panel.ts panelPlacement —
 *  the minTileSize inequality, never a pixel breakpoint). Every decision it draws is made in
 *  project-model.ts; this file draws.
 *
 *  It imports no IO module, and for this step that is the point (D11): its numbers come from a
 *  `wcc-team metrics` child process the app runs, and its live sections from file reads the app
 *  does. Accept and Decline go back to the app, which evaluates them as the proposal's addressee.
 *
 *  A MetricCell is three lines, always in this order — value, label, source — with tabular numerals.
 *  A value that cannot be computed is replaced by its REASON, in italic: never 0, never a dash,
 *  never a hidden row (design system, components/MetricCell). */

import { buildProjectView, projectViewSignature, type MetricCell, type ProjectView, type ProjectViewInput } from './project-model';
import { lanesOf, type LaneFloor, type LaneSession, type LanesView } from './project-lanes';

export type PanelMode = 'column' | 'pane';

export interface ProjectPanelDeps {
	/** The view's inputs, read fresh on every refresh. Null when there is no active workspace. */
	input: () => ProjectViewInput | null;
	/** Re-run wcc-team now. */
	onRefresh: () => void;
	onAccept: (proposalId: string) => void;
	onDecline: (proposalId: string) => void;
	/** `v2.projectLanes` (Tree Stage P7): the floor the lanes read, or null while the setting is off.
	 *  Off, the panel draws exactly what it drew before lanes existed. Read on every refresh, so the
	 *  setting applies live. */
	lanes?: () => LaneFloor | null;
	/** Bring a session's tile up, from a lane or the "outside any open workstream" line. */
	onReveal?: (tileKey: number) => void;
}

const DOT_TITLE: Record<string, string> = { needs: 'Needs you', refused: 'Wants help — looks errored', running: 'Running', idle: 'Done — idle' };

const REFRESH_MS = 1500;
const STATE_DOT: Record<string, string> = { blocked: 'needs', doing: 'running', todo: 'idle', open: 'idle' };

export class ProjectPanel {
	private el: HTMLElement | null = null;
	private timer: number | null = null;
	private lastSig = '';
	private onKey: ((e: KeyboardEvent) => void) | null = null;
	private busy = new Set<string>();
	/** Whether the "outside any open workstream" line is expanded into its sessions. */
	private outsideOpen = false;
	mode: PanelMode = 'pane';

	constructor(private deps: ProjectPanelDeps) {}

	/** Set by the app: the × / ← Workspaces button and Escape (in the pane). */
	onClose: (() => void) | null = null;

	get isOpen(): boolean { return this.el !== null; }

	open(host: HTMLElement, mode: PanelMode): void {
		if (this.el) this.close();
		this.mode = mode;
		this.el = host.createDiv({ cls: `wcc-proj wcc-proj-${mode}`, attr: { role: 'region', 'aria-label': 'Project panel' } });
		this.lastSig = '';
		this.refresh();
		this.timer = window.setInterval(() => this.refresh(), REFRESH_MS);
		if (mode === 'pane') {
			this.onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') this.onClose?.(); };
			document.addEventListener('keydown', this.onKey, true);
		}
	}

	close(): void {
		if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; }
		if (this.onKey) document.removeEventListener('keydown', this.onKey, true);
		this.onKey = null;
		this.el?.remove();
		this.el = null;
	}

	/** Mark a proposal as being decided (its buttons disable until the app answers). */
	setBusy(proposalId: string, on: boolean): void {
		if (on) this.busy.add(proposalId); else this.busy.delete(proposalId);
		this.lastSig = '';
		this.refresh();
	}

	refresh(): void {
		if (!this.el) return;
		const input = this.deps.input();
		const view = input ? buildProjectView(input) : null;
		const floor = view ? this.deps.lanes?.() ?? null : null;
		const lanes = view && floor ? lanesOf(view, floor) : null;
		// Off, the signature is the one it always was: lanes add to it only while they are drawn.
		const sig = `${view ? projectViewSignature(view) : 'none'}|${[...this.busy].join(',')}${lanes ? `|lanes:${JSON.stringify(lanes)}|${this.outsideOpen}` : ''}`;
		if (sig === this.lastSig) return;
		this.lastSig = sig;
		this.render(view, lanes);
	}

	private metricCell(parent: HTMLElement, c: MetricCell, headline = false): void {
		const box = parent.createDiv({ cls: `wcc-metric${headline ? ' headline' : ''}${c.value === null ? ' unavailable' : ''}`, attr: { 'data-metric': c.id } });
		// Line 1: the value — or, when it cannot be computed, the reason in its place.
		if (c.value === null) box.createDiv({ cls: 'wcc-metric-reason', text: `unavailable · ${c.reason}` });
		else box.createDiv({ cls: 'wcc-metric-value', text: c.value });
		// Line 2: what is measured.
		box.createDiv({ cls: 'wcc-metric-label', text: c.label });
		// Line 3: literal source, then when and how fresh.
		box.createDiv({ cls: 'wcc-metric-source', text: `${c.source} · ${c.asOf ? `${c.asOf} · ` : ''}${c.freshness}` });
	}

	private section(body: HTMLElement, title: string): HTMLElement {
		const s = body.createDiv({ cls: 'wcc-proj-section' });
		s.createDiv({ cls: 'wcc-proj-h', text: title });
		return s;
	}

	private untrackedSection(body: HTMLElement, untracked: NonNullable<ProjectView['untracked']>): void {
		const s = this.section(body, `Untracked work · ${untracked.length}`);
		s.createDiv({ cls: 'wcc-proj-note', text: 'No workstream has been opened here, so this is the worktree ledger\'s dirty, ahead and parked entries.' });
		if (!untracked.length) s.createDiv({ cls: 'wcc-mgr-empty', text: 'Nothing dirty, ahead or parked in this workspace\'s repo.' });
		for (const u of untracked) {
			const row = s.createDiv({ cls: 'wcc-proj-row' });
			row.createSpan({ cls: 'wcc-proj-mono', text: u.branch });
			row.createSpan({ cls: 'wcc-proj-state', text: u.state });
			row.createSpan({ cls: 'wcc-proj-meta', text: u.heldBy ?? 'nobody holds it' });
		}
		s.createDiv({ cls: 'wcc-metric-source', text: 'floor-report.json worktrees · ≤30s' });
	}

	private laneSession(parent: HTMLElement, s: LaneSession): void {
		const row = parent.createDiv({ cls: 'wcc-proj-lane-session', attr: { role: 'button', tabindex: '0', title: `${s.name} · ${DOT_TITLE[s.dot] ?? s.dot} — click to bring the tile up` } });
		row.createSpan({ cls: `wcc-sb-dot dot-${s.dot}`, attr: { 'aria-label': DOT_TITLE[s.dot] ?? s.dot } });
		row.createSpan({ cls: 'wcc-proj-name', text: s.name });
		const go = (): void => this.deps.onReveal?.(s.key);
		row.addEventListener('click', go);
		row.addEventListener('keydown', (e) => { const k = (e as KeyboardEvent).key; if (k === 'Enter' || k === ' ') { e.preventDefault(); go(); } });
	}

	/** Tree Stage §7: one lane per OPEN workstream. Sessions with none are one line, never a lane. */
	private lanesSection(body: HTMLElement, l: LanesView): void {
		const s = this.section(body, `Lanes · ${l.lanes.length}`);
		if (l.empty) s.createDiv({ cls: 'wcc-mgr-empty wcc-proj-lanes-empty', text: l.empty });
		for (const lane of l.lanes) {
			const box = s.createDiv({ cls: 'wcc-proj-lane', attr: { 'data-lane': lane.id } });
			const h = box.createDiv({ cls: 'wcc-proj-ws-h' });
			h.createSpan({ cls: `wcc-sb-dot dot-${STATE_DOT[lane.state] ?? 'idle'}`, attr: { 'aria-label': lane.state } });
			h.createSpan({ cls: 'wcc-proj-mono wcc-proj-id', text: lane.id });
			h.createSpan({ cls: 'wcc-proj-name', text: lane.title });
			h.createSpan({ cls: 'wcc-proj-num', text: lane.total ? `${lane.done}/${lane.total}` : 'no tasks', attr: { title: 'tasks done ÷ tasks, dropped ones left out' } });
			h.createSpan({ cls: 'wcc-proj-num', text: lane.age, attr: { title: `open for ${lane.age}` } });
			if (lane.total) {
				const bar = box.createDiv({ cls: 'wcc-proj-bar', attr: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(lane.total), 'aria-valuenow': String(lane.done) } });
				bar.createDiv({ cls: 'wcc-proj-bar-fill' }).style.width = `${Math.round((100 * lane.done) / lane.total)}%`;
			}
			box.createDiv({ cls: `wcc-proj-meta${lane.ownerName ? '' : ' vacant'}`, text: lane.ownerName ? `owner · ${lane.ownerName}` : 'owner · vacant' });
			const who = box.createDiv({ cls: 'wcc-proj-lane-sessions' });
			if (!lane.sessions.length) who.createDiv({ cls: 'wcc-proj-note', text: 'No session on it now.' });
			for (const x of lane.sessions) this.laneSession(who, x);
			this.metricCell(box, lane.blocked);
		}
		if (l.outside.length) {
			const n = l.outside.length;
			const line = s.createEl('button', {
				cls: 'wcc-proj-btn wcc-proj-lanes-outside',
				text: `${this.outsideOpen ? '▾' : '▸'} ${n} session${n === 1 ? '' : 's'} outside any open workstream`,
				attr: { 'aria-expanded': String(this.outsideOpen), title: 'Not a lane: these sessions serve no open workstream. A session joins one when it is spawned with --workstream <id>.' },
			});
			line.addEventListener('click', () => { this.outsideOpen = !this.outsideOpen; this.lastSig = ''; this.refresh(); });
			if (this.outsideOpen) {
				const list = s.createDiv({ cls: 'wcc-proj-lane-sessions' });
				for (const x of l.outside) this.laneSession(list, x);
			}
		}
		this.metricCell(s, l.cost);
		s.createDiv({ cls: 'wcc-metric-source', text: 'workstreams.jsonl · the sessions file · attention.jsonl · live' });
	}

	private render(v: ProjectView | null, lanes: LanesView | null = null): void {
		const el = this.el!;
		const scroll = el.querySelector('.wcc-proj-body')?.scrollTop ?? 0;
		el.empty();
		const top = el.createDiv({ cls: 'wcc-proj-top' });
		if (this.mode === 'pane') {
			const back = top.createEl('button', { cls: 'wcc-roles-back', text: '← Workspaces' });
			back.addEventListener('click', () => this.onClose?.());
		}
		const titles = top.createDiv({ cls: 'wcc-proj-titles' });
		titles.createDiv({ cls: 'wcc-proj-title', text: v?.title ?? 'Project' });
		if (v) titles.createDiv({ cls: 'wcc-proj-sub', text: v.subtitle });
		const spacer = top.createDiv({ cls: 'wcc-roles-spacer' });
		spacer.setAttr('aria-hidden', 'true');
		const refresh = top.createEl('button', { cls: 'wcc-proj-btn', text: v?.running ? 'Computing…' : '↻', attr: { title: 'Re-run wcc-team metrics now (otherwise it re-runs at most every 5 minutes while the panel is open)', 'aria-label': 'Refresh metrics' } });
		if (v?.running) refresh.setAttr('disabled', 'true');
		refresh.addEventListener('click', () => this.deps.onRefresh());
		if (this.mode === 'column') {
			const x = top.createEl('button', { cls: 'wcc-proj-btn', text: '×', attr: { title: 'Close the Project panel', 'aria-label': 'Close' } });
			x.addEventListener('click', () => this.onClose?.());
		}

		const body = el.createDiv({ cls: 'wcc-proj-body' });
		if (!v) { body.createDiv({ cls: 'wcc-roles-notice', text: 'No workspace is active.' }); return; }

		this.metricCell(body, v.headline, true);

		// Open work: a list, not a count. Until a workstream exists, the ledger's untracked work.
		// With lanes on (Tree Stage P7), the lanes take the open-work list's place; the untracked
		// fallback still follows them, since a lane cannot show work no workstream holds.
		if (lanes) {
			this.lanesSection(body, lanes);
			if (v.untracked) this.untrackedSection(body, v.untracked);
		} else if (v.untracked) {
			this.untrackedSection(body, v.untracked);
		} else {
			const s = this.section(body, `Open work · ${v.openWork.length}`);
			if (!v.openWork.length) s.createDiv({ cls: 'wcc-mgr-empty', text: 'Every workstream here has landed or been dropped.' });
			for (const w of v.openWork) {
				const row = s.createDiv({ cls: 'wcc-proj-row', attr: { title: `${w.id} · ${w.state} · opened ${w.age} ago` } });
				row.createSpan({ cls: `wcc-sb-dot dot-${STATE_DOT[w.state] ?? 'idle'}`, attr: { 'aria-label': w.state } });
				row.createSpan({ cls: 'wcc-proj-mono wcc-proj-id', text: w.id });
				row.createSpan({ cls: 'wcc-proj-name', text: w.title });
				row.createSpan({ cls: `wcc-proj-meta${w.ownerName ? '' : ' vacant'}`, text: w.ownerName ?? 'vacant' });
				row.createSpan({ cls: 'wcc-proj-num', text: w.total ? `${w.done}/${w.total}` : '' });
				row.createSpan({ cls: 'wcc-proj-num', text: w.age });
			}
			s.createDiv({ cls: 'wcc-metric-source', text: 'workstreams.jsonl · live' });
		}

		const flow = this.section(body, 'Flow');
		for (const m of v.metrics) this.metricCell(flow, m);

		// §D: progress that never touches git.
		const tasks = this.section(body, 'Tasks');
		for (const m of v.tasks) this.metricCell(tasks, m);
		for (const w of v.workstreams) {
			const box = tasks.createDiv({ cls: 'wcc-proj-ws' });
			const h = box.createDiv({ cls: 'wcc-proj-ws-h' });
			h.createSpan({ cls: 'wcc-proj-mono wcc-proj-id', text: w.id });
			h.createSpan({ cls: 'wcc-proj-name', text: w.title });
			h.createSpan({ cls: 'wcc-proj-state', text: w.state });
			h.createSpan({ cls: 'wcc-proj-num', text: w.total ? `${w.done}/${w.total}` : 'no tasks' });
			if (w.total) {
				const bar = box.createDiv({ cls: 'wcc-proj-bar', attr: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(w.total), 'aria-valuenow': String(w.done) } });
				bar.createDiv({ cls: 'wcc-proj-bar-fill' }).style.width = `${Math.round((100 * w.done) / w.total)}%`;
			}
			for (const t of w.tasks) {
				const row = box.createDiv({ cls: `wcc-proj-task state-${t.state}${t.stale ? ' stale' : ''}`, attr: { title: t.blockedReason ? `blocked: ${t.blockedReason}` : t.stale ? 'doing, unchanged for 3 days or more' : '' } });
				row.createSpan({ cls: 'wcc-proj-mono', text: t.id });
				row.createSpan({ cls: 'wcc-proj-state', text: t.state });
				row.createSpan({ cls: 'wcc-proj-name', text: t.title });
				row.createSpan({ cls: 'wcc-proj-meta', text: t.ownerName ?? '' });
				row.createSpan({ cls: 'wcc-proj-num', text: t.age });
			}
		}

		const upd = this.section(body, 'Updates · append-only');
		if (!v.updates.length) upd.createDiv({ cls: 'wcc-mgr-empty', text: 'Nothing landed, released, opened or logged here in the last 7 days.' });
		for (const u of v.updates) {
			const row = upd.createDiv({ cls: 'wcc-proj-feed' });
			row.createEl('time', { cls: 'wcc-proj-num', text: u.when });
			row.createSpan({ cls: 'wcc-proj-feed-text', text: u.text });
			if (u.ref && u.kind === 'merge') row.createSpan({ cls: 'wcc-proj-mono wcc-proj-faint', text: u.ref });
		}

		// FR-53's second half: the proposals, each with its why and an accept / decline.
		const props = this.section(body, `Spawn proposals · ${v.proposals.length}`);
		if (!v.proposals.length) props.createDiv({ cls: 'wcc-mgr-empty', text: 'None open. Ignoring one is a legitimate outcome — nothing escalates or times out.' });
		for (const p of v.proposals) {
			const card = props.createDiv({ cls: 'wcc-mgr-card' });
			const h = card.createDiv({ cls: 'wcc-mgr-card-h' });
			h.createSpan({ cls: 'wcc-role-tag', text: p.role });
			h.createSpan({ cls: 'wcc-mgr-task', text: p.task });
			card.createDiv({ cls: 'wcc-mgr-meta', text: `${p.from} → ${p.to} · ${p.age} ago` });
			card.createDiv({ cls: 'wcc-mgr-why', text: `why: ${p.why}` });
			if (p.refusal) card.createDiv({ cls: 'wcc-mgr-verdict refused', text: `Accept is unavailable: ${p.refusal}` });
			const acts = card.createDiv({ cls: 'wcc-proj-acts' });
			const busy = this.busy.has(p.id);
			const accept = acts.createEl('button', { cls: 'wcc-proj-btn accept', text: busy ? 'Working…' : 'Accept', attr: { title: p.acceptable ? `Spawn it as ${p.to} would — the same delegation check runs against ${p.to}'s role file` : (p.refusal ?? '') } });
			if (!p.acceptable || busy) accept.setAttr('disabled', 'true');
			accept.addEventListener('click', () => this.deps.onAccept(p.id));
			const decline = acts.createEl('button', { cls: 'wcc-proj-btn', text: 'Decline…', attr: { title: 'Decline with a reason the proposer can read' } });
			if (busy) decline.setAttr('disabled', 'true');
			decline.addEventListener('click', () => this.deps.onDecline(p.id));
		}

		el.createDiv({ cls: 'wcc-proj-cost', text: v.cost, attr: { title: 'What the last refresh cost (NFR-2). wcc-team runs as a child process; git never runs in this window\'s process.' } });
		body.scrollTop = scroll;
	}
}
