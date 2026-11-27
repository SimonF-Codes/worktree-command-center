import type { ConvertDestination, TrackerDestination, VaultDestination } from '../terminals/convert-destinations';
import { newDestinationId } from '../terminals/convert-destinations';
import { promptForChoice, promptForTopic, promptForConfirm } from './prompt-dialog';
import type { ToastVariant } from './toast-queue';
import { parseAutoClose, thresholdLabel, AUTO_CLOSE_CHOICES } from '../terminals/auto-close';
import { parseHideTabs, parseSidebarEnabled, parseTeamView } from './sidebar-model';
import { parseManagersEnabled } from '../core/delegation';
import { parseProjectLanesEnabled, parseProjectPanelEnabled } from '../core/project-panel';
import type { RepoConfig } from '../terminals/terminals-grid';
import type { NestButton } from '../move-repo';
import * as fs from 'fs';

export interface SettingsPanelDeps {
	addFolder: () => Promise<string | null>;
	getConfig: () => Promise<{ convertDestinations?: ConvertDestination[]; [k: string]: unknown }>;
	setConfig: (c: Record<string, unknown>) => Promise<boolean>;
	toast: (msg: string, variant?: ToastVariant) => void;
	/** Apply a changed overseer name live (updates the button + open console immediately). */
	onOverseerNameChange?: (name: string) => void;
	/** Apply a changed auto-close setting live — the raw value just saved as `autoClose`. */
	onAutoCloseChange?: (raw: unknown) => void;
	/** Show or hide the V2 sidebar live — the value just saved as `v2.sidebar`. */
	onSidebarChange?: (enabled: boolean) => void;
	/** Hide or show the tab strip live — the value just saved as `v2.hideTabs`. The app applies it
	 *  only while the sidebar is on (sidebar-model.ts tabsHidden). */
	onHideTabsChange?: (enabled: boolean) => void;
	/** Switch the sidebar's team view live — the value just saved as `v2.teamView`. */
	onTeamViewChange?: (enabled: boolean) => void;
	/** Turn manager delegation on or off live — the value just saved as `v2.managers`. */
	onManagersChange?: (enabled: boolean) => void;
	/** Show or hide 📊 live — the value just saved as `v2.projectPanel`. */
	onProjectPanelChange?: (enabled: boolean) => void;
	/** Draw the Project panel's lanes live — the value just saved as `v2.projectLanes`. */
	onProjectLanesChange?: (enabled: boolean) => void;
	/** The registered targets and what can be done to one. Read from the APP, never from config:
	 *  persist() rewrites the whole `repos` key from the app's memory, so the app has to make
	 *  these edits itself or they are overwritten. Each action resolves once it is finished or
	 *  abandoned; the list is redrawn after it either way. */
	targets?: {
		list: () => RepoConfig[];
		move: (r: RepoConfig) => Promise<void>;
		/** The Nest button for a repo whose worktrees may still sit in the old shared root beside it
		 *  (builds before 0.12): hidden, disabled with the reason, or enabled — move-repo's nestButton. */
		nestButton?: (r: RepoConfig) => Promise<NestButton>;
		/** Move them inside the repo — the same plan-first machinery as move, with the repo staying put. */
		relayout?: (r: RepoConfig) => Promise<void>;
		repoint: (r: RepoConfig) => Promise<void>;
		forget: (r: RepoConfig) => Promise<void>;
		/** Remove merged, clean, unused worktrees across every repo — dry run first, always. */
		prune?: () => Promise<void>;
	};
}

/** Toggleable panel (same open/close pattern as the phone-floor panel): configure the "Convert
 *  to…" destinations a journal note can be sent to. Kept deliberately simple — a flat list +
 *  add/remove, no inline editing (remove and re-add to change one) — since this is a handful of
 *  destinations at most, not a data set that needs a real editor. */
export class SettingsPanel {
	private el: HTMLElement | null = null;

	constructor(private deps: SettingsPanelDeps) {}

	get isOpen(): boolean { return this.el !== null; }

	async toggle(parent: HTMLElement): Promise<void> {
		if (this.el) { this.close(); return; }
		await this.open(parent);
	}

	/** Idempotent open — unlike toggle(), never closes an already-open panel. Used when something
	 *  else (e.g. a journal's "no destinations configured" path) needs Settings visible, not
	 *  flipped. */
	async open(parent: HTMLElement): Promise<void> {
		if (this.el) return;
		this.el = parent.createDiv({ cls: 'wcc-settings-panel' });
		await this.renderBody();
	}

	close(): void { this.el?.remove(); this.el = null; }

	private async destinations(): Promise<ConvertDestination[]> {
		const cfg = await this.deps.getConfig();
		return Array.isArray(cfg.convertDestinations) ? cfg.convertDestinations : [];
	}

	private async saveDestinations(list: ConvertDestination[]): Promise<void> {
		const cfg = await this.deps.getConfig();
		await this.deps.setConfig({ ...cfg, convertDestinations: list });
	}

	private async renderBody(): Promise<void> {
		if (!this.el) return;
		this.el.empty();
		this.el.createDiv({ cls: 'wcc-settings-h', text: '⚙ Settings' });

		// --- Overseer name ---
		const nameSection = this.el.createDiv({ cls: 'wcc-settings-section' });
		nameSection.createDiv({ cls: 'wcc-settings-sub', text: 'Overseer console name — what the 🜲 button and the overseer call themselves' });
		const cfg0 = await this.deps.getConfig();
		const nameRow = nameSection.createDiv({ cls: 'wcc-settings-row' });
		const nameInput = nameRow.createEl('input', { cls: 'wcc-settings-input', attr: { type: 'text', placeholder: 'Kane' } }) as HTMLInputElement;
		nameInput.value = typeof cfg0.overseerName === 'string' ? cfg0.overseerName : '';
		const saveName = nameRow.createEl('button', { cls: 'wcc-settings-remove', text: 'Save' });
		saveName.addEventListener('click', (e) => {
			e.stopPropagation();
			void (async () => {
				const cfg = await this.deps.getConfig();
				const val = nameInput.value.trim();
				await this.deps.setConfig({ ...cfg, overseerName: val || undefined });
				this.deps.onOverseerNameChange?.(val || 'Kane');
				this.deps.toast(val ? `Overseer renamed to "${val}"` : 'Overseer name reset to Kane', 'success');
			})();
		});

		this.renderSidebar(this.el, cfg0.v2);
		this.renderAutoClose(this.el, cfg0.autoClose);
		await this.renderTargets(this.el);

		const section = this.el.createDiv({ cls: 'wcc-settings-section' });
		section.createDiv({ cls: 'wcc-settings-sub', text: 'Convert destinations — where a journal note\'s "Convert to…" can send it' });

		const list = await this.destinations();
		const listEl = section.createDiv({ cls: 'wcc-settings-list' });
		if (!list.length) listEl.createDiv({ cls: 'wcc-settings-empty', text: 'None configured yet — add one below.' });
		for (const d of list) {
			const row = listEl.createDiv({ cls: 'wcc-settings-row' });
			const info = row.createDiv({ cls: 'wcc-settings-row-info' });
			info.createDiv({ cls: 'wcc-settings-row-label', text: `${d.label} · ${d.kind === 'tracker' ? 'tracker' : 'vault'}` });
			info.createDiv({ cls: 'wcc-settings-row-sub', text: d.kind === 'tracker' ? d.target : d.vaultPath });
			const removeBtn = row.createEl('button', { cls: 'wcc-settings-remove', text: 'Remove' });
			removeBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				void (async () => {
					const ok = await promptForConfirm(`Remove "${d.label}"?`, 'It will no longer appear in "Convert to…".', 'Remove');
					if (!ok) return;
					await this.saveDestinations(list.filter((x) => x.id !== d.id));
					await this.renderBody();
				})();
			});
		}

		const addBtn = section.createEl('button', { cls: 'wcc-settings-add', text: '+ Add destination' });
		addBtn.addEventListener('click', (e) => { e.stopPropagation(); void this.addDestination(); });

		const closeBtn = this.el.createEl('button', { cls: 'wcc-settings-close', text: 'Close' });
		closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
	}

	/** Targets — the repos and folders on the floor. Until this existed a target could only ever
	 *  be ADDED (mergeRepos appends), so one whose folder moved stayed in config.json forever.
	 *  Move does the whole move in one go; Repoint is for a folder already moved by hand; Forget
	 *  drops the entry and touches nothing on disk. */
	private async renderTargets(parent: HTMLElement): Promise<void> {
		const t = this.deps.targets;
		if (!t) return;
		const s = parent.createDiv({ cls: 'wcc-settings-section' });
		s.createDiv({ cls: 'wcc-settings-sub', text: 'Targets — move a repo (worktrees, transcripts and config follow it), repoint one moved by hand, or forget one' });
		if (t.prune) {
			const prune = t.prune;
			const b = s.createEl('button', { cls: 'wcc-settings-remove', text: 'Prune merged worktrees…', attr: { title: 'Remove worktrees whose work is already in their base branch, that are clean and that no terminal uses. Shows every worktree first — why it qualifies or is kept, and the Claude conversations each removal would orphan. Branches are never deleted.' } });
			b.addEventListener('click', (e) => {
				e.stopPropagation();
				void (async () => {
					try { await prune(); } catch (err) { this.deps.toast(`Prune failed: ${(err as Error).message}`, 'error'); }
					await this.renderBody();
				})();
			});
		}
		const listEl = s.createDiv({ cls: 'wcc-settings-list' });
		const repos = t.list();
		// Asked before the first row is drawn: each is one git call, and a row must not change under the cursor.
		const nest = await Promise.all(repos.map((r) => (!r.folder && t.relayout && t.nestButton ? t.nestButton(r).catch((): NestButton => ({ show: false })) : Promise.resolve<NestButton>({ show: false }))));
		if (!repos.length) listEl.createDiv({ cls: 'wcc-settings-empty', text: 'No targets yet — use ➕ Add folder.' });
		for (const [i, r] of repos.entries()) {
			const row = listEl.createDiv({ cls: 'wcc-settings-row' });
			const info = row.createDiv({ cls: 'wcc-settings-row-info' });
			const missing = !fs.existsSync(r.path);
			info.createDiv({ cls: 'wcc-settings-row-label', text: `${r.folder ? '📁 ' : ''}${r.name}${missing ? ' · ⚠ folder not found' : ''}` });
			info.createDiv({ cls: 'wcc-settings-row-sub', text: r.path });
			const act = (label: string, title: string, run: (r: RepoConfig) => Promise<void>, enabled = true): void => {
				const b = row.createEl('button', { cls: 'wcc-settings-remove', text: label, attr: { title } }) as HTMLButtonElement;
				b.disabled = !enabled;
				b.addEventListener('click', (e) => {
					e.stopPropagation();
					void (async () => {
						try { await run(r); } catch (err) { this.deps.toast(`${label.replace('…', '')} failed: ${(err as Error).message}`, 'error'); }
						await this.renderBody();
					})();
				});
			};
			if (!r.folder) act('Move…', 'Move this repo and everything that points at it — shows the full plan first', t.move);
			const nb = nest[i]!;
			if (nb.show && t.relayout) act('Nest worktrees…', nb.title, t.relayout, nb.enabled);
			act('Repoint…', 'The folder was moved by hand: point this target at where it is now', t.repoint);
			act('Forget', 'Remove this target from the floor. Nothing on disk is touched', t.forget);
		}
	}

	/** V2 UI step 2: the read-only sidebar beside the tab strip. Default OFF — off is the app
	 *  exactly as it was. Saved inside the `v2` block, beside `recordLineage`, which is kept. */
	private renderSidebar(parent: HTMLElement, v2: unknown): void {
		const s = parent.createDiv({ cls: 'wcc-settings-section' });
		s.createDiv({ cls: 'wcc-settings-sub', text: 'Sidebar — every workspace and its sessions, beside the tabs (preview, off by default)' });
		const row = s.createDiv({ cls: 'wcc-settings-row' });
		const label = row.createEl('label', { cls: 'wcc-settings-row-label' });
		const box = label.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
		box.checked = parseSidebarEnabled(v2);
		label.append(' Show the sidebar');
		s.createDiv({
			cls: 'wcc-settings-note',
			text: 'A second view of the same state the tabs and the ⚠ queue show. Click a workspace to switch to it, a session '
				+ 'to bring its tile up; the caret collapses a workspace, which keeps its worst state on the header. × closes, '
				+ '+ add and Recently closed sit at the foot.',
		});
		box.addEventListener('change', () => {
			void (async () => {
				const on = box.checked;
				const cfg = await this.deps.getConfig();
				const prev = cfg.v2 && typeof cfg.v2 === 'object' ? (cfg.v2 as Record<string, unknown>) : {};
				await this.deps.setConfig({ ...cfg, v2: { ...prev, sidebar: on } });
				this.deps.onSidebarChange?.(on);
				this.deps.toast(on ? 'Sidebar on' : 'Sidebar off', 'success');
			})();
		});

		// The sidebar replaces the tab strip. Its own key, default OFF — and it does nothing while the
		// sidebar is off (the app enforces that in tabsHidden), so it can never strand you without either.
		const hrow = s.createDiv({ cls: 'wcc-settings-row' });
		const hlabel = hrow.createEl('label', { cls: 'wcc-settings-row-label' });
		const hbox = hlabel.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
		hbox.checked = parseHideTabs(v2);
		hlabel.append(' Hide the tab strip — the sidebar replaces it');
		s.createDiv({
			cls: 'wcc-settings-note',
			text: 'Only while the sidebar is shown: with the sidebar off the tab strip always stays, so there is always a way to '
				+ 'change workspace.',
		});
		hbox.addEventListener('change', () => {
			void (async () => {
				const on = hbox.checked;
				const cfg = await this.deps.getConfig();
				const prev = cfg.v2 && typeof cfg.v2 === 'object' ? (cfg.v2 as Record<string, unknown>) : {};
				await this.deps.setConfig({ ...cfg, v2: { ...prev, hideTabs: on } });
				this.deps.onHideTabsChange?.(on);
				const sidebarOn = parseSidebarEnabled(prev);
				this.deps.toast(on ? (sidebarOn ? 'Tab strip hidden — the sidebar replaces it' : 'Saved — the tab strip hides once the sidebar is on') : 'Tab strip shown', 'success');
			})();
		});

		// V2 Team Floor step 7: the team view. Its own key, default OFF — off is the flat status order.
		const trow = s.createDiv({ cls: 'wcc-settings-row' });
		const tlabel = trow.createEl('label', { cls: 'wcc-settings-row-label' });
		const tbox = tlabel.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
		tbox.checked = parseTeamView(v2);
		tlabel.append(' Team view — nest sessions under the session that spawned them');
		s.createDiv({
			cls: 'wcc-settings-note',
			text: "Built from each session's recorded parent, never from where its tile sits. A session with no live parent "
				+ 'is listed under Unassigned with the reason. Needs the sidebar on to show.',
		});
		tbox.addEventListener('change', () => {
			void (async () => {
				const on = tbox.checked;
				const cfg = await this.deps.getConfig();
				const prev = cfg.v2 && typeof cfg.v2 === 'object' ? (cfg.v2 as Record<string, unknown>) : {};
				await this.deps.setConfig({ ...cfg, v2: { ...prev, teamView: on } });
				this.deps.onTeamViewChange?.(on);
				this.deps.toast(on ? 'Team view on' : 'Team view off', 'success');
			})();
		});

		// V2 Team Floor step 10: managers and delegation. Its own key, default OFF — off is today exactly.
		const mrow = s.createDiv({ cls: 'wcc-settings-row' });
		const mlabel = mrow.createEl('label', { cls: 'wcc-settings-row-label' });
		const mbox = mlabel.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
		mbox.checked = parseManagersEnabled(v2);
		mlabel.append(' Managers — sessions whose role file declares spawns: may delegate');
		s.createDiv({
			cls: 'wcc-settings-note',
			text: 'A session acts through its own request directory, and the app checks every spawn, tell and assign against '
				+ 'the role files (listed in spawns:, no higher rung, spawns a subset). The ★ comes from spawns:; a session its parent '
				+ 'could not have spawned is shown as Unassigned with the reason. Off, the app refuses every non-overseer spawn, as before.',
		});
		mbox.addEventListener('change', () => {
			void (async () => {
				const on = mbox.checked;
				const cfg = await this.deps.getConfig();
				const prev = cfg.v2 && typeof cfg.v2 === 'object' ? (cfg.v2 as Record<string, unknown>) : {};
				await this.deps.setConfig({ ...cfg, v2: { ...prev, managers: on } });
				this.deps.onManagersChange?.(on);
				this.deps.toast(on ? 'Managers on — delegation is checked against the role files' : 'Managers off — only the overseer may spawn', 'success');
			})();
		});

		// V2 Team Floor step 11: the Project panel. Its own key, default OFF. Off hides 📊 only: the
		// attention and workstream logs keep being written, so turning it on later has history.
		const prow = s.createDiv({ cls: 'wcc-settings-row' });
		const plabel = prow.createEl('label', { cls: 'wcc-settings-row-label' });
		const pbox = plabel.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
		pbox.checked = parseProjectPanelEnabled(v2);
		plabel.append(' Project panel — 📊 metrics, open work, tasks and spawn proposals for the active tab');
		s.createDiv({
			cls: 'wcc-settings-note',
			text: 'Computed by wcc-team in a child process when the panel opens, then at most every 5 minutes. A metric that cannot be '
				+ 'computed shows why instead of a number. Pins beside the stage only while one usable terminal still fits; otherwise it '
				+ 'opens in the main pane. Off hides 📊; attention.jsonl and workstreams.jsonl keep being written either way.',
		});
		pbox.addEventListener('change', () => {
			void (async () => {
				const on = pbox.checked;
				const cfg = await this.deps.getConfig();
				const prev = cfg.v2 && typeof cfg.v2 === 'object' ? (cfg.v2 as Record<string, unknown>) : {};
				await this.deps.setConfig({ ...cfg, v2: { ...prev, projectPanel: on } });
				this.deps.onProjectPanelChange?.(on);
				this.deps.toast(on ? 'Project panel on — 📊 in the top bar' : 'Project panel off — the logs keep being written', 'success');
			})();
		});

		// Tree Stage P7: lanes in the Project panel. Its own key, default OFF; off leaves the panel's
		// open-work list exactly as it was. Applied live, like the panel's own setting.
		const lrow = s.createDiv({ cls: 'wcc-settings-row' });
		const llabel = lrow.createEl('label', { cls: 'wcc-settings-row-label' });
		const lbox = llabel.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
		lbox.checked = parseProjectLanesEnabled(v2);
		llabel.append(' Project panel lanes — one lane per open workstream, in place of the open-work list');
		s.createDiv({
			cls: 'wcc-settings-note',
			text: 'A lane shows its tasks done ÷ total, the sessions serving it now with their state, how long it has been open, and '
				+ 'how long those sessions waited on you where attention.jsonl says. Sessions in no open workstream are one line under '
				+ 'the lanes, not a lane. Token cost reads unavailable: nothing records it. Read-only — joining a workstream is a spawn '
				+ 'with --workstream. Needs the Project panel on to be seen.',
		});
		lbox.addEventListener('change', () => {
			void (async () => {
				const on = lbox.checked;
				const cfg = await this.deps.getConfig();
				const prev = cfg.v2 && typeof cfg.v2 === 'object' ? (cfg.v2 as Record<string, unknown>) : {};
				await this.deps.setConfig({ ...cfg, v2: { ...prev, projectLanes: on } });
				this.deps.onProjectLanesChange?.(on);
				this.deps.toast(on ? 'Project lanes on — one per open workstream' : 'Project lanes off — the open-work list is back', 'success');
			})();
		});
	}

	/** Auto-close finished sessions. OFF unless a threshold is chosen here: the memory tracker's
	 *  design refuses auto-closing outright, and this is that refusal overridden knowingly — so
	 *  it is never on for anyone who has not opted in, and the row says exactly what it will and
	 *  will not touch. */
	private renderAutoClose(parent: HTMLElement, raw: unknown): void {
		const cur = parseAutoClose(raw);
		const s = parent.createDiv({ cls: 'wcc-settings-section' });
		s.createDiv({ cls: 'wcc-settings-sub', text: 'Auto-close finished sessions — off unless you pick a threshold' });
		const row = s.createDiv({ cls: 'wcc-settings-row' });
		const sel = row.createEl('select', { cls: 'wcc-settings-input', attr: { title: 'Auto-close threshold' } });
		const choices = [...AUTO_CLOSE_CHOICES];
		// A threshold written by hand that the list does not offer is still shown as what it is.
		if (cur.enabled && !choices.some((c) => c.ms === cur.idleMs)) choices.push({ label: thresholdLabel(cur.idleMs), ms: cur.idleMs });
		const off = sel.createEl('option', { text: 'Off', value: '0' });
		if (!cur.enabled) off.selected = true;
		for (const c of choices) {
			const o = sel.createEl('option', { text: `after ${c.label} idle and untouched`, value: String(c.ms) });
			if (cur.enabled && c.ms === cur.idleMs) o.selected = true;
		}
		s.createDiv({
			cls: 'wcc-settings-note',
			text: 'Only worker sessions that have finished and been left alone that long — never one waiting on a question '
				+ 'or a menu, never one showing an error, never the overseer or a journal. Typing into a tile, centering it '
				+ 'or resurfacing it resets its clock. Every batch is named a minute before it closes, with a Keep button. '
				+ 'Closing parks uncommitted work and keeps the worktree, branch and conversation: Coordination panel → '
				+ 'its branch → Reopen brings a session back.',
		});
		sel.addEventListener('change', () => {
			void (async () => {
				const ms = Number(sel.value);
				const next = ms > 0 ? { enabled: true, idleMs: ms } : { enabled: false };
				const cfg = await this.deps.getConfig();
				await this.deps.setConfig({ ...cfg, autoClose: next });
				this.deps.onAutoCloseChange?.(next);
				this.deps.toast(ms > 0
					? `Auto-close on — finished sessions left alone over ${thresholdLabel(ms)} are closed after a warning`
					: 'Auto-close off — nothing closes on its own', 'success');
			})();
		});
	}

	private async addDestination(): Promise<void> {
		const kindChoice = await promptForChoice('Add destination', 'What kind of destination?', [
			{ id: 'linear', label: 'Linear', sublabel: 'Task tracker — via an MCP tool' },
			{ id: 'clickup', label: 'ClickUp', sublabel: 'Task tracker — via an MCP tool' },
			{ id: 'obsidian', label: 'Obsidian', sublabel: 'Notes vault — a local folder' },
			{ id: 'custom-tracker', label: 'Custom tracker…', sublabel: 'Any other MCP-based issue tracker' },
		]);
		if (!kindChoice) return;

		const existing = await this.destinations();
		if (kindChoice === 'obsidian') {
			await this.addVaultDestination(existing, 'Obsidian');
		} else {
			await this.addTrackerDestination(existing, kindChoice === 'linear' ? 'Linear' : kindChoice === 'clickup' ? 'ClickUp' : '');
		}
	}

	private async addVaultDestination(existing: ConvertDestination[], presetLabel: string): Promise<void> {
		const label = await promptForTopic('Destination name', 'e.g. Obsidian', presetLabel, 'Choose folder');
		if (!label) return;
		const folder = await this.deps.addFolder();
		if (!folder) return;
		const dest: VaultDestination = { kind: 'vault', id: newDestinationId(label, existing), label, vaultPath: folder };
		await this.saveDestinations([...existing, dest]);
		this.deps.toast(`Added "${label}" — journals can now be saved to ${folder}`, 'success');
		await this.renderBody();
	}

	private async addTrackerDestination(existing: ConvertDestination[], presetLabel: string): Promise<void> {
		const label = await promptForTopic('Destination name', 'e.g. Linear', presetLabel, 'Next');
		if (!label) return;
		const mcpTool = await promptForTopic('MCP tool name', 'Exactly as Claude Code exposes it, e.g. mcp__linear__create_issue', '', 'Next');
		if (!mcpTool) return;
		const target = await promptForTopic('Target', 'Where issues land, e.g. the Linear team "Engineering" (id abc-123)', '', 'Save');
		if (!target) return;
		const dest: TrackerDestination = { kind: 'tracker', id: newDestinationId(label, existing), label, mcpTool, target };
		await this.saveDestinations([...existing, dest]);
		this.deps.toast(`Added "${label}" — issues will go to ${target}`, 'success');
		await this.renderBody();
	}
}
