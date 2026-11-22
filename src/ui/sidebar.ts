import type { RoleLookup } from '../core/delegation';
import { applyCollapseAll, buildSidebar, canCloseWorkspace, collapseAllAction, liveRanks, recentlyClosedLabel, parseTeamSort, ResortClock, sidebarSignature, TEAM_SORTS, type DotState, type SidebarGroup, type SidebarLineage, type SidebarRow, type SidebarSession, type SidebarWorkspaceInput, type TeamLine, type TeamSort } from './sidebar-model';

export interface SidebarDeps {
	/** The workspaces, in tab order — the same list the tab strip draws. */
	workspaces: () => Array<{ id: string; name: string; repo?: string }>;
	activeId: () => string;
	/** A workspace header was clicked: switch to it — what a tab click does. */
	onSwitch: (workspaceId: string) => void;
	/** The × on a workspace header (shown on hover/focus, never on the last workspace). */
	onClose: (workspaceId: string) => void;
	/** The footer's + add — what the tab strip's + add does. */
	onAdd: () => void;
	/** How many closed workspaces sit in the archive; the footer's Recently closed hides at zero. */
	closedCount: () => number;
	/** Open the Recently closed picker. */
	onRecentlyClosed: () => void;
	/** One workspace's floor: its grid's floorState() and whether its sessions are restored yet.
	 *  Null when the workspace has no grid. */
	floor: (workspaceId: string) => { live: boolean; sessions: SidebarSession[]; lineage?: SidebarLineage[]; proposals?: Record<string, number> } | null;
	/** `v2.teamView`, read on every refresh so the setting applies live. */
	teamView?: () => boolean;
	/** `v2.managers` on: the active role files (built by the app, which does the reading). Read on
	 *  every refresh, so the setting and an edited role file both apply live. Undefined = off. */
	delegation?: () => RoleLookup | undefined;
	/** A row was clicked: bring that tile up (switching workspace first when it is elsewhere). */
	onReveal: (workspaceId: string, tileId: number) => void;
	/** A manager's ★ was clicked: open its Manager view (a presentation — it grants nothing). */
	onOpenManager?: (workspaceId: string, tileId: number) => void;
}

/** How often the view re-reads floorState(). It renders; it does not classify — the same
 *  cadence the ⚠ widget polls attentionItems() at. */
const REFRESH_MS = 1500;
/** The viewer's chosen team-view ordering — a per-viewer convenience, so browser storage. */
const SORT_KEY = 'wcc-team-sort';
const DOT_TITLE: Record<DotState, string> = { needs: 'Needs you', refused: 'Wants help — looks errored', running: 'Running', idle: 'Done — idle' };

/** V2 UI step 2: a sidebar beside (or, with `v2.hideTabs`, instead of) the tab strip. A second VIEW
 *  of floorState(), never a second source of truth — it holds nothing but which groups the viewer
 *  collapsed. Clicking a workspace header switches to it; only its caret collapses it. Clicking a
 *  row reveals that tile. */
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
				live: f?.live ?? false, sessions: f?.sessions ?? [], lineage: f?.lineage, proposals: f?.proposals,
			};
		});
		const teamView = this.deps.teamView?.() ?? false;
		const ranks = teamView && this.sort !== 'lineage' ? this.clock.ranks(liveRanks(inputs), Date.now()) : undefined;
		const delegation = teamView ? this.deps.delegation?.() : undefined;
		const groups = buildSidebar(inputs, this.collapsed, { teamView, sort: this.sort, ranks, delegation });
		const closed = this.deps.closedCount();
		const sig = `${teamView ? this.sort : 'flat'}|${closed}|${sidebarSignature(groups)}`;
		if (sig === this.lastSig) return; // nothing shown changed → leave the DOM (and hover) alone
		this.lastSig = sig;
		this.render(groups, teamView, closed);
	}

	private render(groups: SidebarGroup[], teamView: boolean, closed: number): void {
		const el = this.el!;
		const scroll = el.scrollTop;
		el.empty();
		this.tools(el, groups);
		if (teamView) this.sortControl(el);
		const closable = canCloseWorkspace(groups.length);
		for (const g of groups) this.renderGroup(el, g, closable);
		this.footer(el, closed);
		el.scrollTop = scroll;
	}

	/** The tab strip's + add and ↩ Recently closed, so the sidebar can stand in for it. */
	private footer(parent: HTMLElement, closed: number): void {
		const foot = parent.createDiv({ cls: 'wcc-sb-foot' });
		const add = foot.createEl('button', { cls: 'wcc-sb-tool', text: '+ add', attr: { type: 'button', title: 'Add a workspace' } });
		add.addEventListener('click', () => this.deps.onAdd());
		const label = recentlyClosedLabel(closed);
		if (label) {
			const recent = foot.createEl('button', {
				cls: 'wcc-sb-tool', text: label,
				attr: { type: 'button', title: 'Reopen a closed workspace — its terminals come back saved, not started' },
			});
			recent.addEventListener('click', () => this.deps.onRecentlyClosed());
		}
	}

	private renderGroup(parent: HTMLElement, g: SidebarGroup, closable: boolean): void {
		const box = parent.createDiv({ cls: 'wcc-sb-group' });
		box.toggleClass('active', g.active);
		const head = box.createDiv({ cls: 'wcc-sb-head', attr: { role: 'button', tabindex: '0', title: `Switch to ${g.name}` } });
		// The caret is its own button and the only thing that collapses; the header switches.
		const verb = g.collapsed ? 'Expand' : 'Collapse';
		const caret = head.createEl('button', {
			cls: 'wcc-sb-caret', text: g.collapsed ? '▸' : '▾',
			attr: { type: 'button', 'aria-expanded': String(!g.collapsed), 'aria-label': `${verb} ${g.name}`, title: `${verb} ${g.name}` },
		});
		this.ownButton(caret, () => {
			if (this.collapsed.has(g.id)) this.collapsed.delete(g.id); else this.collapsed.add(g.id);
			this.refresh();
		});
		// A collapsed group keeps its worst state on the header: collapsing never hides that
		// something needs you.
		if (g.collapsed && g.worst) this.dot(head, g.worst);
		head.createSpan({ cls: 'wcc-sb-ws', text: g.name });
		if (g.repo) head.setAttribute('title', `Switch to ${g.name} — linked to ${g.repo}`);
		if (g.collapsed) {
			const c = head.createSpan({ cls: 'wcc-sb-counts' });
			if (g.counts.needs) c.createSpan({ cls: 'wcc-sb-count needs', text: `⏳${g.counts.needs}` });
			if (g.counts.done) c.createSpan({ cls: 'wcc-sb-count', text: `✓${g.counts.done}` });
		}
		if (closable) {
			const x = head.createEl('button', {
				cls: 'wcc-sb-close', text: '×',
				attr: { type: 'button', 'aria-label': `Close ${g.name}`, title: `Close ${g.name}` },
			});
			this.ownButton(x, () => this.deps.onClose(g.id));
		}
		const go = (): void => this.deps.onSwitch(g.id);
		head.addEventListener('click', go);
		head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
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

	/** The sidebar's own header area: one collapse-all / expand-all button whose label follows
	 *  whether anything is still expanded. */
	private tools(parent: HTMLElement, groups: SidebarGroup[]): void {
		const bar = parent.createDiv({ cls: 'wcc-sb-tools' });
		const ids = groups.map((g) => g.id);
		const collapse = collapseAllAction(ids, this.collapsed) === 'collapse';
		const b = bar.createEl('button', {
			cls: 'wcc-sb-tool', text: collapse ? '▾ Collapse all' : '▸ Expand all',
			attr: { type: 'button', title: collapse ? 'Collapse every workspace — each keeps its worst state on its header' : 'Expand every workspace' },
		});
		b.addEventListener('click', () => {
			const next = applyCollapseAll(ids, this.collapsed);
			this.collapsed.clear();
			for (const id of next) this.collapsed.add(id);
			this.refresh();
		});
	}

	/** A real <button> nested in the clickable header: its click and its Enter/Space are its own,
	 *  never the header's. Enter/Space are left to the button's native activation (which fires its
	 *  click) and only kept from bubbling to the header, so one key press acts exactly once. */
	private ownButton(b: HTMLElement, act: () => void): void {
		b.addEventListener('click', (e) => { e.stopPropagation(); act(); });
		b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
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
		if (r.manager) {
			const open = this.deps.onOpenManager;
			const star = row.createSpan({ cls: 'wcc-sb-star', text: '★', attr: open
				? { role: 'button', tabindex: '0', 'aria-label': `Open ${r.name}'s Manager view`, title: `Open ${r.name}'s Manager view — its team, its spawns: and its open proposals` }
				: { 'aria-label': 'manager' } });
			if (open) {
				const go = (e: Event): void => { e.stopPropagation(); open(g.id, r.id); };
				star.addEventListener('click', go);
				star.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } });
			}
		}
		row.createSpan({ cls: 'wcc-sb-name', text: r.name });
		row.createSpan({ cls: 'wcc-sb-branch', text: r.branch });
		for (const c of r.chips) row.createSpan({ cls: `wcc-sb-chip chip-${c}`, text: c });
		if (r.proposals) row.createSpan({ cls: 'wcc-sb-chip chip-proposals', text: `◆${r.proposals}`, attr: { title: `${r.proposals} open spawn proposal${r.proposals === 1 ? '' : 's'} addressed to ${r.name} — never obliged; ignoring one is a legitimate outcome` } });
		const go = (): void => this.deps.onReveal(g.id, r.id);
		row.addEventListener('click', go);
		row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
		return row;
	}

	private dot(parent: HTMLElement, state: DotState): void {
		parent.createSpan({ cls: `wcc-sb-dot dot-${state}`, attr: { 'aria-label': DOT_TITLE[state] } });
	}
}
