import { buildSidebar, sidebarSignature, type DotState, type SidebarGroup, type SidebarRow, type SidebarSession, type SidebarWorkspaceInput } from './sidebar-model';

export interface SidebarDeps {
	/** The workspaces, in tab order — the same list the tab strip draws. */
	workspaces: () => Array<{ id: string; name: string; repo?: string }>;
	activeId: () => string;
	/** One workspace's floor: its grid's floorState() and whether its sessions are restored yet.
	 *  Null when the workspace has no grid. */
	floor: (workspaceId: string) => { live: boolean; sessions: SidebarSession[] } | null;
	/** A row was clicked: bring that tile up (switching workspace first when it is elsewhere). */
	onReveal: (workspaceId: string, tileId: number) => void;
}

/** How often the view re-reads floorState(). It renders; it does not classify — the same
 *  cadence the ⚠ widget polls attentionItems() at. */
const REFRESH_MS = 1500;
const DOT_TITLE: Record<DotState, string> = { needs: 'Needs you', refused: 'Wants help — looks errored', running: 'Running', idle: 'Done — idle' };

/** V2 UI step 2: a read-only sidebar beside the tab strip. A second VIEW of floorState(), never a
 *  second source of truth — it holds nothing but which groups the viewer collapsed. Clicking a row
 *  reveals that tile; there is no other action. */
export class Sidebar {
	private el: HTMLElement | null = null;
	private timer: number | null = null;
	private lastSig = '';
	private readonly collapsed = new Set<string>();

	constructor(private deps: SidebarDeps) {}

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
				live: f?.live ?? false, sessions: f?.sessions ?? [],
			};
		});
		const groups = buildSidebar(inputs, this.collapsed);
		const sig = sidebarSignature(groups);
		if (sig === this.lastSig) return; // nothing shown changed → leave the DOM (and hover) alone
		this.lastSig = sig;
		this.render(groups);
	}

	private render(groups: SidebarGroup[]): void {
		const el = this.el!;
		const scroll = el.scrollTop;
		el.empty();
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

	private row(parent: HTMLElement, g: SidebarGroup, r: SidebarRow): void {
		const row = parent.createDiv({ cls: 'wcc-sb-row', attr: { role: 'button', tabindex: '0', title: `${r.name} · ${r.branch} · ${DOT_TITLE[r.dot]}` } });
		row.toggleClass('overseer', r.overseer);
		this.dot(row, r.dot);
		row.createSpan({ cls: 'wcc-sb-name', text: r.name });
		row.createSpan({ cls: 'wcc-sb-branch', text: r.branch });
		for (const c of r.chips) row.createSpan({ cls: `wcc-sb-chip chip-${c}`, text: c });
		const go = (): void => this.deps.onReveal(g.id, r.id);
		row.addEventListener('click', go);
		row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
	}

	private dot(parent: HTMLElement, state: DotState): void {
		parent.createSpan({ cls: `wcc-sb-dot dot-${state}`, attr: { 'aria-label': DOT_TITLE[state] } });
	}
}
