/** The Manager view (V2 Team Floor step 10): one manager session opened into the main pane, full
 *  width — its spawns:, its team, and the spawn proposals addressed to it. The same full-window
 *  mechanism the Roles view uses: the terminal surface is hidden while it is open, and leaving it
 *  puts the workspaces back as they were.
 *
 *  It is a PRESENTATION. It grants nothing: there is no accept, no decline, no spawn, no tell in
 *  here — those are the manager's to do, through its own request directory, and the view shows the
 *  command it would run. Clicking a team row only brings that tile up. Every decision it renders is
 *  made in manager-model.ts and tested there; this file draws. */

import { buildManagerView, managerViewSignature, LADDER_TEXT, type ManagerView, type ManagerViewInput } from './manager-model';

export interface ManagerViewDeps {
	/** The view's inputs, read fresh on every refresh. Null when the workspace is gone. */
	input: () => ManagerViewInput | null;
	/** A team row was clicked: bring that tile up (navigation only). */
	onReveal: (tileKey: number) => void;
}

const REFRESH_MS = 1500;
const DOT_TITLE: Record<string, string> = { needs: 'Needs you', refused: 'Wants help — looks errored', running: 'Running', idle: 'Done — idle' };

function ago(ts: number, now: number): string {
	const s = Math.max(0, Math.round((now - ts) / 1000));
	if (s < 90) return `${s}s ago`;
	const m = Math.round(s / 60);
	return m < 90 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

export class ManagerViewPane {
	private el: HTMLElement | null = null;
	private timer: number | null = null;
	private lastSig = '';
	private onKey: ((e: KeyboardEvent) => void) | null = null;

	constructor(private deps: ManagerViewDeps) {}

	/** Set by the app: leaving the view puts the workspaces back exactly as they were. */
	onClose: (() => void) | null = null;

	get isOpen(): boolean { return this.el !== null; }

	open(host: HTMLElement): void {
		if (this.el) return;
		this.el = host.createDiv({ cls: 'wcc-mgr', attr: { role: 'region', 'aria-label': 'Manager view' } });
		this.lastSig = '';
		this.refresh();
		this.timer = window.setInterval(() => this.refresh(), REFRESH_MS);
		this.onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') this.onClose?.(); };
		document.addEventListener('keydown', this.onKey, true);
	}

	close(): void {
		if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; }
		if (this.onKey) document.removeEventListener('keydown', this.onKey, true);
		this.onKey = null;
		this.el?.remove();
		this.el = null;
	}

	refresh(): void {
		if (!this.el) return;
		const input = this.deps.input();
		const view = input ? buildManagerView(input) : null;
		const sig = view ? managerViewSignature(view) : 'none';
		if (sig === this.lastSig) return;
		this.lastSig = sig;
		this.render(view);
	}

	private render(v: ManagerView | null): void {
		const el = this.el!;
		const scroll = el.querySelector('.wcc-mgr-body')?.scrollTop ?? 0;
		el.empty();
		const top = el.createDiv({ cls: 'wcc-mgr-top' });
		const back = top.createEl('button', { cls: 'wcc-roles-back', text: '← Workspaces' });
		back.addEventListener('click', () => this.onClose?.());
		top.createSpan({ cls: 'wcc-mgr-title', text: v ? `★ ${v.name}` : '★ Manager' });
		if (v) {
			top.createSpan({ cls: 'wcc-mgr-role', text: v.role || '—' });
			const rung = top.createSpan({ cls: 'wcc-role-rung', text: v.authority, attr: { title: `authority: from the role file — ${LADDER_TEXT}` } });
			if (v.rungKnown) rung.setAttr('data-rung', v.authority);
		}
		const spacer = top.createDiv({ cls: 'wcc-roles-spacer' });
		spacer.setAttr('aria-hidden', 'true');
		top.createSpan({ cls: 'wcc-mgr-note', text: 'A view — it grants nothing', attr: { title: 'Everything here is read from the role files and the session records. Acting is the manager\'s, through its own request directory.' } });

		const body = el.createDiv({ cls: 'wcc-mgr-body' });
		if (!v) { body.createDiv({ cls: 'wcc-roles-notice', text: 'This workspace is gone.' }); return; }
		if (v.vacant) body.createDiv({ cls: 'wcc-roles-notice', text: `manager: vacant — ${v.name} is no longer on the floor. Its team is shown as the tree now places it.` });
		else if (!v.manager) body.createDiv({ cls: 'wcc-roles-notice', text: `${v.name}'s role (${v.role}) declares no spawns: — it is not a manager, so the app refuses it any spawn, tell or assign.` });

		// What it may start: the role file's spawns:, verbatim.
		const may = body.createDiv({ cls: 'wcc-mgr-section' });
		may.createDiv({ cls: 'wcc-mgr-h', text: 'May spawn' });
		const chips = may.createDiv({ cls: 'wcc-mgr-chips' });
		if (v.spawns.length) for (const s of v.spawns) chips.createSpan({ cls: 'wcc-role-tag', text: s });
		else chips.createSpan({ cls: 'wcc-mgr-empty', text: 'nothing — no spawns: in its role file' });
		may.createDiv({ cls: 'wcc-mgr-sub', text: `Sits ${v.placement}. A child must be listed here, at or below its rung, and spawn nothing this list lacks.` });

		// Its team, through accepted edges only.
		const team = body.createDiv({ cls: 'wcc-mgr-section' });
		team.createDiv({ cls: 'wcc-mgr-h', text: `Team · ${v.team.length}` });
		if (!v.team.length) team.createDiv({ cls: 'wcc-mgr-empty', text: 'No sessions report to it.' });
		for (const r of v.team) {
			const row = team.createDiv({ cls: 'wcc-mgr-row', attr: { role: 'button', tabindex: '0', title: `${r.name} · ${r.role} · ${DOT_TITLE[r.dot]} — click to bring the tile up` } });
			row.style.setProperty('--mgr-depth', String(r.depth));
			row.createSpan({ cls: `wcc-sb-dot dot-${r.dot}`, attr: { 'aria-label': DOT_TITLE[r.dot] } });
			if (r.manager) row.createSpan({ cls: 'wcc-sb-star', text: '★', attr: { 'aria-label': 'manager' } });
			row.createSpan({ cls: 'wcc-mgr-name', text: r.name });
			row.createSpan({ cls: 'wcc-mgr-meta', text: r.role });
			if (r.workstreamId) row.createSpan({ cls: 'wcc-role-tag', text: r.workstreamId, attr: { title: 'workstream' } });
			row.createSpan({ cls: 'wcc-sb-branch', text: r.branch });
			const go = (): void => this.deps.onReveal(r.key);
			row.addEventListener('click', go);
			row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
		}

		// Spawn proposals addressed to it. Inert: nothing here decides one.
		const props = body.createDiv({ cls: 'wcc-mgr-section' });
		props.createDiv({ cls: 'wcc-mgr-h', text: `Open spawn proposals · ${v.open.length}` });
		if (!v.open.length) props.createDiv({ cls: 'wcc-mgr-empty', text: 'None. Ignoring one is a legitimate outcome — nothing escalates or times out.' });
		const now = Date.now();
		for (const p of v.open) {
			const card = props.createDiv({ cls: 'wcc-mgr-card' });
			const h = card.createDiv({ cls: 'wcc-mgr-card-h' });
			h.createSpan({ cls: 'wcc-role-tag', text: p.role });
			h.createSpan({ cls: 'wcc-mgr-task', text: p.task });
			h.createSpan({ cls: 'wcc-mgr-meta', text: `from ${p.from} · ${ago(p.ts, now)}${p.unaddressed ? ' · written while unassigned' : ''}` });
			card.createDiv({ cls: 'wcc-mgr-why', text: `why: ${p.why}` });
			const verdict = card.createDiv({ cls: `wcc-mgr-verdict ${p.verdict.ok ? 'ok' : 'refused'}` });
			verdict.setText(p.verdict.ok ? 'Accepting it would pass checkDelegation.' : `Accepting it would be refused: ${p.verdict.reason}`);
			const cmd = card.createDiv({ cls: 'wcc-mgr-cmd' });
			cmd.createEl('code', { text: p.acceptCommand });
			cmd.createEl('code', { text: p.declineCommand });
		}

		if (v.decided.length) {
			const past = body.createDiv({ cls: 'wcc-mgr-section' });
			past.createDiv({ cls: 'wcc-mgr-h', text: 'Recently decided' });
			for (const d of v.decided) {
				const row = past.createDiv({ cls: 'wcc-mgr-past' });
				row.createSpan({ cls: `wcc-mgr-state state-${d.state}`, text: d.state });
				row.createSpan({ cls: 'wcc-role-tag', text: d.role });
				row.createSpan({ cls: 'wcc-mgr-task', text: d.task });
				row.createSpan({ cls: 'wcc-mgr-meta', text: `from ${d.from}${d.by ? ` · by ${d.by}` : ''}${d.reason ? ` — ${d.reason}` : ''}` });
			}
		}
		body.scrollTop = scroll;
	}
}
