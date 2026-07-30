/** The 🗄 Archive browser: what's been archived, what each conversation was about, and Revive.
 *
 *  Everything shown here comes from the small `.json` / `.md` sidecars written next to each zip, so
 *  opening this panel and reading a summary never inflates an archive — only Revive touches the zip.
 */

import { promptForConfirm } from './prompt-dialog';
import { humanBytes, type ArchiveManifest } from '../terminals/worktree-archive';

export interface ArchivePanelDeps {
	archiveDir: string;
	list: () => Promise<ArchiveManifest[]>;
	readSummary: (base: string) => Promise<string>;
	revive: (m: ArchiveManifest) => Promise<void>;
	remove: (base: string) => Promise<void>;
	reveal: (dir: string) => void;
	toast: (msg: string) => void;
}

/** "2 conversations · 41 messages" — the one-line conversation stat for a row. */
export function conversationLabel(m: ArchiveManifest): string {
	const convos = m.conversations ?? [];
	if (!convos.length) return 'no conversation captured';
	const msgs = convos.reduce((n, c) => n + (Number(c.userMessages) || 0) + (Number(c.assistantMessages) || 0), 0);
	const n = convos.length;
	return `${n} conversation${n === 1 ? '' : 's'} · ${msgs} message${msgs === 1 ? '' : 's'}`;
}

/** The headline for a row: the conversation's opening ask if we captured one, else the branch. */
export function archiveTitle(m: ArchiveManifest): string {
	const first = (m.conversations ?? [])[0];
	const t = first && typeof first.title === 'string' ? first.title.trim() : '';
	return t && !t.startsWith('(no user prompt') ? t : m.branch;
}

/** Local date+time, or the raw string if it isn't parseable. */
export function archiveWhen(m: ArchiveManifest): string {
	const d = new Date(m.archivedAt);
	return Number.isNaN(d.getTime()) ? String(m.archivedAt ?? '') : d.toLocaleString();
}

export class ArchivePanel {
	private el: HTMLElement | null = null;
	private expanded = new Set<string>(); // bases whose summary is open — kept across re-renders

	constructor(private deps: ArchivePanelDeps) {}

	get isOpen(): boolean { return this.el !== null; }

	async toggle(parent: HTMLElement): Promise<void> {
		if (this.el) { this.close(); return; }
		this.el = parent.createDiv({ cls: 'wcc-archive-panel' });
		await this.renderBody();
	}

	close(): void { this.el?.remove(); this.el = null; }

	/** Re-read the archive folder and redraw, if open. Called after an archive or a revive. */
	async refresh(): Promise<void> {
		if (this.el) await this.renderBody();
	}

	private async renderBody(): Promise<void> {
		if (!this.el) return;
		this.el.empty();

		const head = this.el.createDiv({ cls: 'wcc-archive-head' });
		head.createSpan({ text: '🗄 Archived worktrees' });
		const revealBtn = head.createEl('button', { cls: 'wcc-archive-reveal', text: 'Open folder' });
		revealBtn.addEventListener('click', (e) => { e.stopPropagation(); this.deps.reveal(this.deps.archiveDir); });

		const list = await this.deps.list();
		const totalZip = list.reduce((n, m) => n + (Number(m.zipBytes) || 0), 0);
		const totalRaw = list.reduce((n, m) => n + (Number(m.rawBytes) || 0), 0);
		this.el.createDiv({
			cls: 'wcc-archive-sub',
			text: list.length
				? `${list.length} archive(s) · ${humanBytes(totalZip)} on disk (${humanBytes(totalRaw)} uncompressed) · ${this.deps.archiveDir}`
				: `Nothing archived yet · ${this.deps.archiveDir}`,
		});

		if (!list.length) {
			this.el.createDiv({
				cls: 'wcc-archive-empty',
				text: 'Stale worktrees are swept here automatically, and the Coordination panel has an Archive button on every worktree row. Reviving one recreates it and resumes its conversation.',
			});
		}

		const listEl = this.el.createDiv({ cls: 'wcc-archive-list' });
		for (const m of list) this.renderRow(listEl, m);

		const closeBtn = this.el.createEl('button', { cls: 'wcc-archive-close', text: 'Close' });
		closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
	}

	private renderRow(parent: HTMLElement, m: ArchiveManifest): void {
		const row = parent.createDiv({ cls: 'wcc-archive-row' });

		const info = row.createDiv({ cls: 'wcc-archive-row-info' });
		info.createDiv({ cls: 'wcc-archive-row-title', text: archiveTitle(m) });
		const meta = info.createDiv({ cls: 'wcc-archive-row-meta' });
		meta.createSpan({ cls: 'cos-reg-repo-tag', text: m.repo || '?' });
		meta.createSpan({ cls: 'wcc-archive-branch', text: m.branch });
		meta.createSpan({ text: archiveWhen(m) });
		meta.createSpan({ text: humanBytes(Number(m.zipBytes) || 0) });
		meta.createSpan({ text: conversationLabel(m) });
		if (m.reason === 'sweep') meta.createSpan({ cls: 'wcc-archive-tag', text: 'auto-swept' });
		if (m.parked) meta.createSpan({ cls: 'wcc-archive-tag', text: 'work parked as a commit' });

		const actions = row.createDiv({ cls: 'wcc-archive-actions' });

		const open = this.expanded.has(m.base);
		const summaryBtn = actions.createEl('button', { cls: 'cos-reopen-btn', text: open ? 'Hide summary' : 'Summary' });
		summaryBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (this.expanded.has(m.base)) this.expanded.delete(m.base); else this.expanded.add(m.base);
			void this.renderBody();
		});

		const reviveBtn = actions.createEl('button', { cls: 'cos-reopen-btn wcc-archive-revive', text: '⟲ Revive' });
		reviveBtn.setAttribute('title', `Recreate ${m.worktreePath} and resume its conversation with claude --continue`);
		reviveBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			reviveBtn.setAttribute('disabled', 'true'); // reviving twice concurrently would race on the same path
			void this.deps.revive(m).finally(() => reviveBtn.removeAttribute('disabled'));
		});

		const del = actions.createEl('button', { cls: 'cos-close-btn', text: '✕', attr: { title: 'Delete this archive permanently' } });
		del.addEventListener('click', (e) => {
			e.stopPropagation();
			void (async () => {
				const ok = await promptForConfirm(
					`Delete the archive of "${m.branch}"?`,
					'The zip, its summary, and the captured conversation are deleted permanently. Commits already on the branch in the repo are unaffected.',
					'Delete',
				);
				if (!ok) return;
				await this.deps.remove(m.base);
				this.expanded.delete(m.base);
				this.deps.toast(`Deleted archive ${m.base}`);
				await this.renderBody();
			})();
		});

		if (open) {
			const box = parent.createDiv({ cls: 'wcc-archive-summary' });
			box.createSpan({ text: 'loading…' });
			void this.deps.readSummary(m.base).then((text) => {
				box.empty();
				box.createEl('pre', { text: text || 'No summary was written for this archive.' });
			});
		}
	}
}
