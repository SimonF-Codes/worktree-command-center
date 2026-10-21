import type { ConvertDestination, TrackerDestination, VaultDestination } from '../terminals/convert-destinations';
import { newDestinationId } from '../terminals/convert-destinations';
import { promptForChoice, promptForTopic, promptForConfirm } from './prompt-dialog';
import type { ToastVariant } from './toast-queue';
import { parseAutoClose, thresholdLabel, AUTO_CLOSE_CHOICES } from '../terminals/auto-close';
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
