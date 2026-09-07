/** A prominent banner shown when the `claude` CLI can't be found on PATH. Everything the
 *  app does — every worktree terminal and the usage battery — spawns `claude` through the
 *  sidecar, so without it the app looks broken in confusing ways (blank terminals, a usage
 *  battery stuck on "unavailable"). This turns that silent failure into a clear, actionable
 *  message with a recheck button so the user can fix PATH and confirm without relaunching. */

export interface ClaudeCheck { found: boolean; path: string | null; }

const INSTALL_CMD = 'npm install -g @anthropic-ai/claude-code';

export class ClaudeWarning {
	private el: HTMLElement | null = null;
	private busy = false;

	constructor(private check: () => Promise<ClaudeCheck>) {}

	/** Insert a hidden host at the top of `parent`; call refresh() to populate it. */
	render(parent: HTMLElement): void {
		// Insert as the FIRST child so the warning sits above the workspace tabs and grid,
		// directly under the top bar — impossible to miss.
		this.el = document.createElement('div');
		this.el.className = 'wcc-claude-warn';
		this.el.style.display = 'none';
		parent.insertBefore(this.el, parent.firstChild);
	}

	/** Run the check and show/hide the banner accordingly. Returns whether claude was found. */
	async refresh(): Promise<boolean> {
		if (!this.el) return true;
		let found = false;
		try { found = (await this.check()).found; }
		catch { found = false; } // if the check itself fails, err toward warning
		if (found) { this.el.style.display = 'none'; this.el.empty(); return true; }
		this.paint();
		return false;
	}

	private paint(): void {
		if (!this.el) return;
		this.el.empty();
		this.el.style.display = 'flex';

		this.el.createSpan({ cls: 'wcc-claude-warn-icon', text: '⚠' });
		const body = this.el.createDiv({ cls: 'wcc-claude-warn-body' });
		body.createDiv({
			cls: 'wcc-claude-warn-title',
			text: "Claude Code CLI not found on PATH",
		});
		body.createDiv({
			cls: 'wcc-claude-warn-msg',
			text: 'Worktree terminals and the usage battery both launch the `claude` command — they can’t start until it’s installed and on PATH.',
		});
		const cmd = body.createDiv({ cls: 'wcc-claude-warn-cmd' });
		cmd.createSpan({ text: 'Install it, then reopen a shell so PATH updates: ' });
		cmd.createEl('code', { text: INSTALL_CMD });

		const actions = this.el.createDiv({ cls: 'wcc-claude-warn-actions' });
		const recheck = actions.createEl('button', { cls: 'wcc-claude-warn-btn', text: 'Recheck' });
		recheck.addEventListener('click', () => { void this.doRecheck(recheck); });
		const dismiss = actions.createEl('button', { cls: 'wcc-claude-warn-dismiss', text: 'Dismiss', attr: { title: 'Hide until next launch' } });
		dismiss.addEventListener('click', () => { if (this.el) { this.el.style.display = 'none'; } });
	}

	private async doRecheck(btn: HTMLButtonElement): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const prev = btn.textContent;
		btn.textContent = 'Checking…';
		btn.disabled = true;
		try {
			const ok = await this.refresh();
			if (!ok) { btn.textContent = prev; btn.disabled = false; }
			// If ok, the banner is hidden — nothing to restore.
		} finally {
			this.busy = false;
		}
	}
}
