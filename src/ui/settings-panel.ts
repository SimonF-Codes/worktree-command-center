import type { ConvertDestination, TrackerDestination, VaultDestination } from '../terminals/convert-destinations';
import { newDestinationId } from '../terminals/convert-destinations';
import { promptForChoice, promptForTopic, promptForConfirm } from './prompt-dialog';
import type { ToastVariant } from './toast-queue';

export interface SettingsPanelDeps {
	addFolder: () => Promise<string | null>;
	getConfig: () => Promise<{ convertDestinations?: ConvertDestination[]; [k: string]: unknown }>;
	setConfig: (c: Record<string, unknown>) => Promise<boolean>;
	toast: (msg: string, variant?: ToastVariant) => void;
	/** Apply a changed overseer name live (updates the button + open console immediately). */
	onOverseerNameChange?: (name: string) => void;
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
