/** The Agent Instruction Interface: a browsable, read-only wiki of every agent role, as a
 *  full-window view (design: the vault's `Personal/Code/Designs/Worktree Command Center — Agent
 *  Instruction Interface.md`).
 *
 *  It is a WIKI, NOT A CONTROL SURFACE. Everything in here is navigation — filter, search, and
 *  open a role's `.md`. Nothing changes the state of an agent. The vault is the single writer
 *  over these files; an edit surface here would be a second one, which is exactly the drift the
 *  Agent Custodian exists to catch, and the first editable field is where that begins.
 *
 *  The one exception is library-level, not per-tile: "Review with Custodian" spawns a terminal
 *  on the Agent Custodian role against the library folder. The Custodian reviews the whole
 *  folder, so a per-tile button would imply a per-role review that does not exist.
 *
 *  This file is the thin DOM half. Every decision it renders — which tiles exist, what their
 *  summary is, which ones a filter keeps, where a link points — is made in role-view.ts and
 *  tested there. */

import {
	EMPTY_FILTERS, facets, filterTiles, groupBySurface, isFiltered,
	resolveOpenTarget, toggleFacet, type RoleFilters, type RoleTile,
} from '../terminals/role-view';
import { readLibrary, roleFilePath, CUSTODIAN_SLUG, type LibrarySnapshot } from '../terminals/role-view-loader';
import { openUriWithHandler, openPathWithDefaultApp, showItemInFolder } from '../terminals/links';
import type { ToastVariant } from './toast-queue';

export interface RolesViewDeps {
	/** config.json's `roleLibrary.path`, or undefined. Read on every open, so adding the key to
	 *  config and reopening the view is enough — no relaunch. */
	libraryPath: () => string | undefined;
	/** Spawn the Custodian terminal. The view hands over the folder and gets out of the way. */
	reviewWithCustodian: (libraryPath: string) => void;
	toast: (msg: string, variant?: ToastVariant) => void;
}

export class RolesView {
	private el: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private filters: RoleFilters = { ...EMPTY_FILTERS };
	private snapshot: LibrarySnapshot | null = null;
	private clearChip: HTMLElement | null = null;
	private onKey: ((e: KeyboardEvent) => void) | null = null;

	constructor(private deps: RolesViewDeps) {}

	get isOpen(): boolean { return this.el !== null; }

	/** Open the view into `host`, which the caller has already made the whole window. Filters are
	 *  pure view state and deliberately not persisted: a filter you set last week, silently still
	 *  applied when you open a wiki looking for a role, is a bug that looks like a missing role. */
	open(host: HTMLElement): void {
		if (this.el) return;
		this.filters = { ...EMPTY_FILTERS };
		this.snapshot = readLibrary(this.deps.libraryPath());
		this.el = host.createDiv({ cls: 'wcc-roles' });
		this.renderChrome();
		this.renderBody();
		this.onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') this.requestClose(); };
		document.addEventListener('keydown', this.onKey, true);
	}

	close(): void {
		if (this.onKey) document.removeEventListener('keydown', this.onKey, true);
		this.onKey = null;
		this.el?.remove();
		this.el = null;
		this.bodyEl = null;
		this.clearChip = null;
	}

	/** Set by the app: leaving the view puts the workspaces back exactly as they were. */
	onClose: (() => void) | null = null;

	private requestClose(): void { this.onClose?.(); }

	/** Re-read the folder. Role files are edited in Obsidian while this is open. */
	private refresh(): void {
		this.snapshot = readLibrary(this.deps.libraryPath());
		this.renderChrome();
		this.renderBody();
	}

	// --- chrome -------------------------------------------------------------------------------

	private renderChrome(): void {
		if (!this.el) return;
		this.el.empty();
		const snap = this.snapshot!;

		const top = this.el.createDiv({ cls: 'wcc-roles-top' });
		const back = top.createEl('button', { cls: 'wcc-roles-back', text: '← Workspaces' });
		back.addEventListener('click', () => this.requestClose());
		top.createSpan({ cls: 'wcc-roles-title', text: '📖 Agent instructions' });

		// Coverage: what this says about the health of the library is worth more than any single
		// tile, so it sits in the chrome rather than at the bottom of a list.
		const { withFile, total } = snap.library.coverage;
		if (total) {
			const cov = top.createSpan({ cls: 'wcc-roles-coverage', text: `${withFile} of ${total} roles have a role file` });
			if (withFile < total) cov.addClass('gap');
			cov.setAttr('title', 'A role with no file lives in some application\'s source or config: invisible to the Custodian, and uneditable without a rebuild.');
		}

		const spacer = top.createDiv({ cls: 'wcc-roles-spacer' });
		spacer.setAttr('aria-hidden', 'true');

		const refresh = top.createEl('button', { cls: 'wcc-roles-btn', text: '⟳ Reread' });
		refresh.setAttr('title', 'Read the library folder again — role files are edited in Obsidian while this is open');
		refresh.addEventListener('click', () => this.refresh());

		const custodian = top.createEl('button', { cls: 'wcc-roles-btn wcc-roles-custodian', text: '🜲 Review with Custodian' });
		custodian.setAttr('title', snap.custodian.ok
			? 'Spawn a terminal on the Agent Custodian role, against the library folder. Its review pass is read-only.'
			: `Unavailable — ${snap.custodian.reason}`);
		if (!snap.custodian.ok) custodian.addClass('disabled');
		custodian.addEventListener('click', () => this.startCustodian());

		if (snap.configured && !snap.error) this.renderFilters();
	}

	private renderFilters(): void {
		if (!this.el) return;
		const snap = this.snapshot!;
		const bar = this.el.createDiv({ cls: 'wcc-roles-filters' });

		const search = bar.createEl('input', { cls: 'wcc-roles-search', attr: { type: 'text', placeholder: 'Search name, mission, scope…' } }) as HTMLInputElement;
		search.value = this.filters.search;
		// Typing re-renders the BODY only: re-rendering the chrome would rebuild this input and
		// take the focus away mid-word. The one chip that depends on the query is toggled by hand.
		search.addEventListener('input', () => {
			this.filters = { ...this.filters, search: search.value };
			if (this.clearChip) this.clearChip.hidden = !isFiltered(this.filters);
			this.renderBody();
		});

		const f = facets(snap.library.tiles);
		const chipRow = (label: string, values: string[], key: 'surfaces' | 'authorities' | 'statuses'): void => {
			if (!values.length) return;
			const row = bar.createDiv({ cls: 'wcc-roles-chiprow' });
			row.createSpan({ cls: 'wcc-roles-chiplabel', text: label });
			for (const v of values) {
				const chip = row.createEl('button', { cls: 'wcc-roles-chip', text: v });
				if (key === 'authorities') chip.setAttr('data-rung', v);
				if (this.filters[key].includes(v)) chip.addClass('on');
				chip.addEventListener('click', () => {
					this.filters = { ...this.filters, [key]: toggleFacet(this.filters[key], v) };
					this.renderFiltersAndBody();
				});
			}
		};
		chipRow('Surface', f.surfaces, 'surfaces');
		chipRow('Authority', f.authorities, 'authorities');
		chipRow('Status', f.statuses, 'statuses');

		const last = bar.createDiv({ cls: 'wcc-roles-chiprow' });
		const unmigrated = snap.library.tiles.filter((t) => !t.migrated).length;
		const unm = last.createEl('button', { cls: 'wcc-roles-chip wcc-roles-unmigrated', text: `Un-migrated (${unmigrated})` });
		unm.setAttr('title', 'Roles with no role file. Off by default: they are real agents, but they are not the normal case.');
		if (this.filters.showUnmigrated) unm.addClass('on');
		unm.addEventListener('click', () => {
			this.filters = { ...this.filters, showUnmigrated: !this.filters.showUnmigrated };
			this.renderFiltersAndBody();
		});
		const clear = last.createEl('button', { cls: 'wcc-roles-chip wcc-roles-clear', text: 'Clear filters' });
		clear.hidden = !isFiltered(this.filters);
		clear.addEventListener('click', () => {
			// The un-migrated condition survives a clear: it is a choice about what the library
			// IS, not a narrowing of it, and silently turning it back off would hide roles you
			// deliberately asked to see.
			this.filters = { ...EMPTY_FILTERS, showUnmigrated: this.filters.showUnmigrated };
			this.renderFiltersAndBody();
		});
		this.clearChip = clear;
	}

	/** Chip state lives in the chip row, so a facet toggle re-renders both halves. */
	private renderFiltersAndBody(): void {
		this.renderChrome();
		this.renderBody();
	}

	// --- body ---------------------------------------------------------------------------------

	private renderBody(): void {
		if (!this.el) return;
		const snap = this.snapshot!;
		this.bodyEl?.remove();
		this.bodyEl = this.el.createDiv({ cls: 'wcc-roles-body' });
		const body = this.bodyEl;

		if (!snap.configured) { this.renderUnconfigured(body); return; }
		if (snap.error) { this.renderError(body, snap.error); return; }

		this.renderNotices(body, snap);

		const shown = filterTiles(snap.library.tiles, this.filters);
		if (!shown.length) {
			const empty = body.createDiv({ cls: 'wcc-roles-empty' });
			if (!snap.library.tiles.length) {
				empty.createDiv({ cls: 'wcc-roles-empty-h', text: 'No role files in the library folder' });
				empty.createDiv({ cls: 'wcc-roles-empty-p', text: `${snap.path} holds no .md file with a "role:" slug in its frontmatter. Sessions are running their built-in prompts.` });
			} else {
				empty.createDiv({ cls: 'wcc-roles-empty-h', text: 'No roles match these filters' });
				const hidden = snap.library.tiles.filter((t) => !t.migrated).length;
				if (!this.filters.showUnmigrated && hidden) {
					empty.createDiv({ cls: 'wcc-roles-empty-p', text: `${hidden} un-migrated role(s) are hidden by default — turn on the Un-migrated filter to see them.` });
				}
			}
			return;
		}

		for (const group of groupBySurface(shown)) {
			const section = body.createDiv({ cls: 'wcc-roles-group' });
			const head = section.createDiv({ cls: 'wcc-roles-group-h' });
			head.createSpan({ cls: 'wcc-roles-group-name', text: group.surface });
			head.createSpan({ cls: 'wcc-roles-group-count', text: `${group.tiles.length}` });
			const grid = section.createDiv({ cls: 'wcc-roles-grid' });
			for (const t of group.tiles) this.renderTile(grid, t);
		}
	}

	private renderNotices(body: HTMLElement, snap: LibrarySnapshot): void {
		const notice = (cls: string, text: string): void => { body.createDiv({ cls: `wcc-roles-notice ${cls}`, text }); };
		if (!snap.library.registryFound) {
			notice('warn', 'No Agent registry found in Index.md, so this shows only the role files on disk — a role that exists as a string literal somewhere would not appear at all.');
		}
		if (snap.library.duplicates.length) {
			notice('warn', `Two files claim the same role slug: ${snap.library.duplicates.join(', ')}. The last one read wins, so the other is silently dead — one for the Custodian.`);
		}
		if (snap.library.unregistered.length) {
			notice('warn', `Role file(s) with no row in the registry: ${snap.library.unregistered.join(', ')}. Index.md is meant to list every agent on every surface.`);
		}
	}

	private renderTile(parent: HTMLElement, t: RoleTile): void {
		const tile = parent.createDiv({ cls: t.migrated ? 'wcc-role-tile' : 'wcc-role-tile stub' });

		const head = tile.createDiv({ cls: 'wcc-role-head' });
		head.createSpan({ cls: 'wcc-role-name', text: t.name });
		const chips = head.createDiv({ cls: 'wcc-role-chips' });
		if (t.authority) {
			// The rung is the one word that says blast radius, and it is what a wall of tiles is
			// scanned FOR — so it gets colour and position rather than a line of body text.
			const rung = chips.createSpan({ cls: 'wcc-role-rung', text: t.authority });
			rung.setAttr('data-rung', t.authority);
			if (t.origin === 'registry') {
				rung.addClass('proposed');
				rung.setAttr('title', 'Proposed classification, read off this agent\'s behaviour — the file does not declare a rung.');
			}
		}
		if (t.status) {
			const st = chips.createSpan({ cls: 'wcc-role-status', text: t.status });
			st.setAttr('data-status', t.status);
		}

		const meta = tile.createDiv({ cls: 'wcc-role-meta' });
		meta.createSpan({ cls: 'wcc-role-surface', text: t.surface || '(no surface declared)' });
		if (t.migrated && !t.charterFormat) {
			const pre = meta.createSpan({ cls: 'wcc-role-tag', text: 'pre-Charter' });
			pre.setAttr('title', 'This file has a role: slug but none of the Charter frontmatter, so its name, rung and status come from the registry.');
		}
		if (!t.registered) {
			const un = meta.createSpan({ cls: 'wcc-role-tag warn', text: 'unregistered' });
			un.setAttr('title', 'No row for this role in Index.md.');
		}

		tile.createDiv({ cls: 'wcc-role-summary', text: t.summary || '(no Mission written yet)' });

		if (t.migrated) this.renderTileFoot(tile, t);
		else this.renderStubFoot(tile, t);
	}

	private renderTileFoot(tile: HTMLElement, t: RoleTile): void {
		const foot = tile.createDiv({ cls: 'wcc-role-foot' });
		const reviewed = foot.createSpan({ cls: 'wcc-role-reviewed', text: t.reviewLabel });
		if (t.reviewLabel.includes('stale') || t.reviewLabel === 'never reviewed') reviewed.addClass('stale');

		const open = foot.createEl('button', { cls: 'wcc-role-open', text: `${t.file} ↗` });
		open.setAttr('title', 'Open in Obsidian — the only place these are read and edited');
		open.addEventListener('click', (e) => { e.stopPropagation(); void this.openRole(t); });

		const reveal = foot.createEl('button', { cls: 'wcc-role-reveal', text: '📁' });
		reveal.setAttr('title', 'Show the file in Explorer');
		reveal.addEventListener('click', (e) => { e.stopPropagation(); this.revealRole(t); });

		// The whole tile is the link: a tile that summarises a role and offers no route to the
		// source is a dead end, and clicking the card is where a person aims first.
		tile.addClass('clickable');
		tile.setAttr('tabindex', '0');
		tile.addEventListener('click', () => void this.openRole(t));
		tile.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void this.openRole(t); });
	}

	/** An un-migrated role renders the steps to migrate it, from its registry row. The gap should
	 *  be actionable where it is visible, not recorded somewhere else and forgotten. */
	private renderStubFoot(tile: HTMLElement, t: RoleTile): void {
		const warn = tile.createDiv({ cls: 'wcc-role-warn' });
		warn.createSpan({ cls: 'wcc-role-warn-h', text: `Not migrated — ${t.slug}` });
		if (t.livesIn) warn.createSpan({ cls: 'wcc-role-warn-where', text: `Lives in ${t.livesIn}` });
		const steps = tile.createEl('ol', { cls: 'wcc-role-steps' });
		for (const step of t.migration) steps.createEl('li', { text: step });
	}

	// --- actions (navigation only) -------------------------------------------------------------

	/** Obsidian first, because that is where these files are read, edited and linked; the OS
	 *  default app when the library is not in a vault, or when nothing answered the URI. */
	private async openRole(t: RoleTile): Promise<void> {
		const lib = this.snapshot?.path;
		if (!lib || !t.file) return;
		const full = roleFilePath(lib, t.file);
		const target = resolveOpenTarget(full, this.snapshot!.vaultRoot);
		if (target.kind === 'obsidian' && await openUriWithHandler(target.uri)) return;
		const err = await openPathWithDefaultApp(full);
		if (err) this.deps.toast(`Couldn't open ${t.file} — ${err}`, 'error');
	}

	private revealRole(t: RoleTile): void {
		const lib = this.snapshot?.path;
		if (!lib || !t.file) return;
		if (!showItemInFolder(roleFilePath(lib, t.file))) this.deps.toast(`Couldn't reveal ${t.file}`, 'error');
	}

	private startCustodian(): void {
		const snap = this.snapshot;
		if (!snap?.path) { this.deps.toast('No role library is configured, so there is nothing for the Custodian to review', 'warn'); return; }
		if (!snap.custodian.ok) {
			this.deps.toast(`Can't spawn the Custodian — ${snap.custodian.reason}. Its role file must be in the library and status: active.`, 'warn');
			return;
		}
		this.deps.reviewWithCustodian(snap.path);
	}

	// --- the two states that are not a wall of tiles --------------------------------------------

	private renderUnconfigured(body: HTMLElement): void {
		const box = body.createDiv({ cls: 'wcc-roles-empty' });
		box.createDiv({ cls: 'wcc-roles-empty-h', text: 'No role library configured' });
		box.createDiv({ cls: 'wcc-roles-empty-p', text: 'This view reads agent role files from a folder on disk — the same folder every session reads its own instructions from at start. Nothing points at one yet, so every session is running the prompts compiled into the app.' });
		box.createDiv({ cls: 'wcc-roles-empty-p', text: 'Add a roleLibrary key to config.json and reopen this view:' });
		box.createEl('pre', { cls: 'wcc-roles-code', text: '"roleLibrary": {\n  "path": "C:/…/Simon-Brain/_meta/agents"\n}' });
		box.createDiv({ cls: 'wcc-roles-empty-p', text: 'The folder holds one markdown file per role, each with a role: slug in its frontmatter. Its format is the vault\'s Charter.md; Index.md beside it is the registry this view reads to find roles that have no file yet.' });
	}

	private renderError(body: HTMLElement, error: string): void {
		const box = body.createDiv({ cls: 'wcc-roles-empty' });
		box.createDiv({ cls: 'wcc-roles-empty-h', text: 'The role library could not be read' });
		box.createDiv({ cls: 'wcc-roles-empty-p', text: error });
		box.createDiv({ cls: 'wcc-roles-empty-p', text: 'If the folder is in OneDrive, a cloud-only file can stall or fail outright on read — making it available offline fixes that. Sessions fall back to their built-in prompts meanwhile; nothing is broken by this.' });
		const retry = box.createEl('button', { cls: 'wcc-roles-btn', text: 'Try again' });
		retry.addEventListener('click', () => this.refresh());
	}
}

export { CUSTODIAN_SLUG };
