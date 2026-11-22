import type { RoleLookup } from '../core/delegation';
import { buildSidebar, liveRanks, parseTeamSort, ResortClock, sidebarSignature, TEAM_SORTS, type DotState, type SidebarGroup, type SidebarLineage, type SidebarRow, type SidebarSession, type SidebarWorkspaceInput, type TeamLine, type TeamSort } from './sidebar-model';

export interface SidebarDeps {
	/** The workspaces, in tab order — the same list the tab strip draws. */
	workspaces: () => Array<{ id: string; name: string; repo?: string }>;
	activeId: () => string;
	/** One workspace's floor: its grid's floorState() and whether its sessions are restored yet.
	 *  Null when the workspace has no grid. */
	floor: (workspaceId: string) => { live: boolean; sessions: SidebarSession[]; lineage?: SidebarLineage[] } | null;
	/** `v2.teamView`, read on every refresh so the setting applies live. */
	teamView?: () => boolean;
	/** `v2.managers` on: the active role files (built by the app, which does the reading). Read on
	 *  every refresh, so the setting and an edited role file both apply live. Undefined = off. */
	delegation?: () => RoleLookup | undefined;
	/** A row was clicked: bring that tile up (switching workspace first when it is elsewhere). */
	onReveal: (workspaceId: string, tileId: number) => void;
}

/** How often the view re-reads floorState(). It renders; it does not classify — the same
 *  cadence the ⚠ widget polls attentionItems() at. */
const REFRESH_MS = 1500;
/** The viewer's chosen team-view ordering — a per-viewer convenience, so browser storage. */
const SORT_KEY = 'wcc-team-sort';
const DOT_TITLE: Record<DotState, string> = { needs: 'Needs you', refused: 'Wants help — looks errored', running: 'Running', idle: 'Done — idle' };

/** V2 UI step 2: a read-only sidebar beside the tab strip. A second VIEW of floorState(), never a
 *  second source of truth — it holds nothing but which groups the viewer collapsed. Clicking a row
 *  reveals that tile; there is no other action. */
export class Sidebar {
	private el: HTMLElement | null = null;
	private timer: number | null = null;
	private lastSig = '';
	private readonly collapsed = new Set<string>();
	private sort: TeamSort = 'lineage';
	/** Order changes wait for this; dots do not. */
	private readonly clock = new ResortClock();

	constructor(private deps: SidebarDeps) {
		try { this.sort = parseTeamSort(window.localStorage.getItem(SORT_KEY)); } catch { /* no storage: Lineage */ }
	}

	get isMounted(): boolean { return this.el !== null; }

	mount(parent: HTMLElement): void {
		if (this.el) return;
		this.el = parent.createDiv({ cls: 'wcc-sidebar', attr: { role: 'navigation', 'aria-label': 'Sessions' } });
		this.lastSig = '';
		this.refresh();
		this.timer = window.setInterval(() => this.refresh(), REFRESH_MS);
	}

	unmount(): void {
		if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; }
		this.el?.remove();
		this.el = null;
	}

	refresh(): void {
		if (!this.el) return;
		const active = this.deps.activeId();
		const inputs: SidebarWorkspaceInput[] = this.deps.workspaces().map((w) => {
			const f = this.deps.floor(w.id);
			return {
				id: w.id, name: w.name, repo: w.repo, active: w.id === active,
				live: f?.live ?? false, sessions: f?.sessions ?? [], lineage: f?.lineage,
			};
		});
		const teamView = this.deps.teamView?.() ?? false;
		const ranks = teamView && this.sort !== 'lineage' ? this.clock.ranks(liveRanks(inputs), Date.now()) : undefined;
		const delegation = teamView ? this.deps.delegation?.() : undefined;
		const groups = buildSidebar(inputs, this.collapsed, { teamView, sort: this.sort, ranks, delegation });
		const sig = `${teamView ? this.sort : 'flat'}|${sidebarSignature(groups)}`;
		if (sig === this.lastSig) return; // nothing shown changed → leave the DOM (and hover) alone
		this.lastSig = sig;
		this.render(groups, teamView);
	}

	private render(groups: SidebarGroup[], teamView: boolean): void {
		const el = this.el!;
		const scroll = el.scrollTop;
		el.empty();
		if (teamView) this.sortControl(el);
		for (const g of groups) this.renderGroup(el, g);
		el.scrollTop = scroll;
	}

	private renderGroup(parent: HTMLElement, g: SidebarGroup): void {
		const box = parent.createDiv({ cls: 'wcc-sb-group' });
		box.toggleClass('active', g.active);
		const head = box.createDiv({ cls: 'wcc-sb-head', attr: { role: 'button', tabindex: '0', 'aria-expanded': String(!g.collapsed) } });
		head.createSpan({ cls: 'wcc-sb-caret', text: g.collapsed ? '▸' : '▾' });
		// A collapsed group keeps its worst state on the header: collapsing never hides that
		// something needs you.
		if (g.collapsed && g.worst) this.dot(head, g.worst);
		head.createSpan({ cls: 'wcc-sb-ws', text: g.name });
		if (g.repo) head.setAttribute('title', `${g.name} — linked to ${g.repo}`);
		if (g.collapsed) {
			const c = head.createSpan({ cls: 'wcc-sb-counts' });
			if (g.counts.needs) c.createSpan({ cls: 'wcc-sb-count needs', text: `⏳${g.counts.needs}` });
			if (g.counts.done) c.createSpan({ cls: 'wcc-sb-count', text: `✓${g.counts.done}` });
		}
		const toggle = (): void => {
			if (this.collapsed.has(g.id)) this.collapsed.delete(g.id); else this.collapsed.add(g.id);
			this.refresh();
		};
		head.addEventListener('click', toggle);
		head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
		if (g.collapsed) return;

		if (g.repo) box.createDiv({ cls: 'wcc-sb-repo', text: `repo: ${g.repo}`, attr: { title: g.repo } });
		if (g.team) {
			if (g.team.pinned.length) {
				box.createDiv({ cls: 'wcc-sb-section wcc-sb-pin', text: `Needs you · ${g.team.pinned.length}` });
				for (const p of g.team.pinned) {
					this.row(box, g, p.row);
					box.createDiv({ cls: 'wcc-sb-reason', text: `↳ ${p.context}` });
				}
			}
			for (const l of g.team.tree) this.teamLine(box, g, l);
			if (g.team.unassigned.length) {
				box.createDiv({ cls: 'wcc-sb-section', text: `Unassigned · ${g.team.unassigned.length}`, attr: { title: 'Sessions with no live parent to sit under — shown, never hidden' } });
				for (const l of g.team.unassigned) this.teamLine(box, g, l);
			}
		}
		for (const r of g.overseers) this.row(box, g, r);
		for (const s of g.sections) {
			box.createDiv({ cls: 'wcc-sb-section', text: s.title });
			for (const r of s.rows) this.row(box, g, r);
		}
		if (g.total === 0) {
			box.createDiv({
				cls: 'wcc-sb-empty',
				text: g.live ? 'No sessions' : 'Not opened yet',
				attr: g.live ? {} : { title: 'Its saved sessions are restored the first time you switch to this workspace' },
			});
		}
	}

	/** Lineage · Triage · Needs-you pinned. Choosing a mode re-sorts at once — that reorder is
	 *  the user's own; only the ones the attention tick would cause wait for the clock. */
	private sortControl(parent: HTMLElement): void {
		const seg = parent.createDiv({ cls: 'wcc-sb-sort', attr: { role: 'group', 'aria-label': 'Sort order' } });
		for (const m of TEAM_SORTS) {
			const b = seg.createEl('button', { text: m.label, attr: { type: 'button', title: m.title, 'aria-pressed': String(m.id === this.sort) } });
			b.addEventListener('click', () => {
				if (m.id === this.sort) return;
				this.sort = m.id;
				try { window.localStorage.setItem(SORT_KEY, m.id); } catch { /* no storage: this launch only */ }
				this.clock.invalidate();
				this.refresh();
			});
		}
	}

	/** A team-tree row: indentation (12px a level) is the only depth cue — no connector lines, no
	 *  chevrons on leaves. An unassigned root carries its reason on the line below it. */
	private teamLine(parent: HTMLElement, g: SidebarGroup, l: TeamLine): void {
		const row = this.row(parent, g, l.row, l.reason);
		row.style.setProperty('--sb-depth', String(l.depth));
		if (l.reason) {
			const why = parent.createDiv({ cls: 'wcc-sb-reason', text: `↳ ${l.reason}` });
			why.style.setProperty('--sb-depth', String(l.depth));
		}
	}

	private row(parent: HTMLElement, g: SidebarGroup, r: SidebarRow, reason?: string): HTMLElement {
		const title = `${r.name}${r.manager ? ' · ★ manager (its role file declares spawns:)' : ''} · ${r.branch} · ${DOT_TITLE[r.dot]}${reason ? ` · unassigned: ${reason}` : ''}`;
		const row = parent.createDiv({ cls: 'wcc-sb-row', attr: { role: 'button', tabindex: '0', title } });
		row.toggleClass('overseer', r.overseer);
		this.dot(row, r.dot);
		if (r.manager) row.createSpan({ cls: 'wcc-sb-star', text: '★', attr: { 'aria-label': 'manager' } });
		row.createSpan({ cls: 'wcc-sb-name', text: r.name });
		row.createSpan({ cls: 'wcc-sb-branch', text: r.branch });
		for (const c of r.chips) row.createSpan({ cls: `wcc-sb-chip chip-${c}`, text: c });
		const go = (): void => this.deps.onReveal(g.id, r.id);
		row.addEventListener('click', go);
		row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
		return row;
	}

	private dot(parent: HTMLElement, state: DotState): void {
		parent.createSpan({ cls: `wcc-sb-dot dot-${state}`, attr: { 'aria-label': DOT_TITLE[state] } });
	}
}
