import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { listBranches, createWorktree, writeWorktreeSettings, ensureClaudeSettingsIgnored, defaultBranch, parkWorktree, reopenWorktree, type WorktreeInfo } from './worktree-manager';
import { nextWorktreeBranch, parseWorktreeList, parseStatusPorcelain, parseAheadBehind, isParkCommitSubject, formatRegistryMarkdown, type WorktreeEntry } from './worktree-registry';
import { repoOptionLabel } from '../workspace';
import { runCommand } from '../command-runner';
import type { TerminalPalette } from './theme-store';
import { TerminalTile } from './terminal-tile';
import { BoardView } from './board-view';
import { promptForConfirm, promptForChoice } from '../ui/prompt-dialog';
import { openExternalUrl, revealInFileManager } from './links';
import { EDITORS, FILE_BROWSER, CUSTOM_EDITOR, resolveEditorCommand, type EditorDef } from './editor-launch';
import { ChatRoom } from './chat-room';
import { ChatTile } from './chat-tile';
import { settledLayout, centeredLayout, keyForIndex, keyToIndex, physicalKeyLabel, nextSpotlight } from './bubble-layout';
import { emptyState, applyKeystroke, onReady as rqReady, onSubmit as rqSubmit, onClose as rqClose, onClick as rqClick, onOverview as rqOverview } from './ready-queue';
import { decideCenter, type SpotlightState } from './focus-decider';
import { partitionByHidden } from './session-partition';
import { SPAWN_MODELS } from './spawn-models';
import { normalizeToolbarState, type ToolbarState } from './toolbar-state';
import { GodConsole } from './god-console';
import { godIndexOf, godRecords, highestGodIndex, PRIMARY_GOD_INDEX } from './god-sessions';
import { slug as godSlug, formatFloorSnapshot, formatFloorIndex, parseOutboxMessage, resolveTellTarget, remapWatchers, EFFORT_LEVELS, type OutboxMessage, type GodSelfImprove } from './god';
import { evaluateConnectorRequest, receiptFilename, isReceiptStale, type ConnectorConfig, type ConnectorReceipt } from './connectors';
import type { RoleLibraryConfig } from './role-library';
import { looksLikeMenu, looksErrored, looksBusy } from './prompt-detect';
import { looksLikePrompt } from './chat-room';
import { classifyAttention, classifyOne, attentionKind, type AttentionItem, type AttentionKind } from './attention';
import type { ToastVariant } from '../ui/toast';
import { JournalTile } from './journal-tile';
import { JournalStore } from './journal-store';
import { FormatProbe } from './format-probe';
import { ConvertProbe } from './convert-probe';
import { vaultNoteFilename, vaultNoteContent, type ConvertDestination, type VaultDestination } from './convert-destinations';
import type { StageTile } from './stage-tile';

/** A target on the floor. `folder: true` marks a NON-git directory: its terminals run directly
 *  in `path` with no worktree and no branch (see spawnFolder). Absent/false = a git repo, the
 *  worktree-backed default — so configs written before folder targets existed keep behaving
 *  exactly as they did. */
export interface RepoConfig { name: string; path: string; remote?: string; group?: string; folder?: boolean; }

export interface RemoteTerminal { id: number; name: string; repo: string; branch: string; state: string; output: string; remoteOn: boolean; }

export interface GridDeps {
	repos: RepoConfig[];
	coordDir: string;
	sidecarPath: string;
	notifyScriptPath: string;
	coordHookPath: string;
	sessionsFile: string;
	group: string;
	bypassPermissions: boolean;
	sessionEnv?: () => Record<string, string>;
	overseerName?: string;   // configurable name of the overseer console (default 'Kane')
	godSelfImprove?: GodSelfImprove;
	/** config.json's `roleLibrary` — the vault folder every session's role file is read from.
	 *  Absent means every session uses its compiled-in system prompt. */
	roleLibrary?: RoleLibraryConfig;
	/** Connectors registered in config.json — a request from an unregistered id gets a rejected
	 *  receipt rather than being honoured. See README "External dispatch". */
	connectors?: ConnectorConfig[];
	toast: (msg: string, variant?: ToastVariant) => void;
	promptForTopic: (title: string, placeholder: string, initial?: string, okLabel?: string) => Promise<string | null>;
	openSettings: () => void;
	/** This workspace's remembered spawn-toolbar selection, restored on mount. */
	initialToolbar?: ToolbarState;
	/** Called when the user changes a toolbar dropdown, so the app can persist it per workspace. */
	onToolbarChange?: (state: ToolbarState) => void;
}
interface SessionRecord { worktreePath: string; branch: string; repoName: string; repoPath: string; baseBranch: string; name?: string; hidden?: boolean; kind?: 'terminal' | 'journal' | 'god'; journalSlug?: string; godIndex?: number; folder?: boolean; model?: string; effort?: string; }

// Effort options for the spawn toolbar dropdown. Empty value = inherit the claude CLI default.
const SPAWN_EFFORTS: { label: string; value: string }[] = [
	{ label: 'Effort: Default', value: '' },
	...EFFORT_LEVELS.map((l) => ({ label: l === 'xhigh' ? 'XHigh' : l[0]!.toUpperCase() + l.slice(1), value: l })),
];

// How long a manual tile choice (click / Alt+F-key / resurfacing) suppresses auto-centering.
const MANUAL_HOLD_MS = 30_000;
const STEAL_GRACE_MS = 4_000; // hands-off window before a fresh finisher may steal the center

// --- Kane personality mode (toggled by his /personality command) ---
const kanePersonaOn = (name: string): string =>
	`[personality: ON] Speak as ${name} the forge-master from now on — terse, gruff, dry, in command ` +
	'of the floor; the worker terminals are your smiths and their branches are iron on the anvil. ' +
	'Drop the odd forge/river turn of phrase, never flowery. Keep doing your job exactly as before ' +
	'(same tools, same restraint — you still do not run the floor unprompted), just in that voice. ' +
	'Periodically you will get a line starting "[pulse]" — answer each with ONE punchy sentence on ' +
	'the floor\'s state right now. Confirm now with a single line, in character.';
const KANE_PERSONA_OFF =
	'[personality: OFF] Drop the forge-master voice — back to your plain, neutral overseer tone. ' +
	'The "[pulse]" nudges have stopped; ignore any you still see. Acknowledge in one short line.';
const KANE_PULSE = '[pulse] One line, in character: what\'s the floor doing right now?';

/** Controls bar + a bubbling stage of embedded claude terminals, scoped to one repo group. */
export class TerminalsGrid {
	private repos: RepoConfig[] = [];
	/** Remembered dropdown selection for THIS workspace (toolbar-state.ts). */
	private toolbar: ToolbarState = {};
	private repoSel: HTMLSelectElement | null = null;
	private branchSel: HTMLSelectElement | null = null;
	private modelSel: HTMLSelectElement | null = null;
	private effortSel: HTMLSelectElement | null = null;
	private stageEl: HTMLElement | null = null;
	private maxBtn: HTMLElement | null = null;
	private controlsEl: HTMLElement | null = null;
	private board: BoardView | null = null;
	private tiles: StageTile[] = [];
	private hidden: StageTile[] = [];
	private journalStore!: JournalStore;
	private formatProbe!: FormatProbe;
	private convertProbe!: ConvertProbe;
	private journalSeq = 0;
	private nextTileId = 1;
	private pendingNewBranch: string | null = null;
	private lastEntries: WorktreeEntry[] = [];
	private claudeSettingsIgnoredFor = new Set<string>(); // repo paths already patched into .git/info/exclude
	private centeredId: number | null = null;
	private maximized = false;
	private locked = false;
	private lockedTileId: number | null = null; // individual lock: this tile is pinned to center until you navigate away
	private searchQuery = '';
	private selecting = false;
	private selectBtn: HTMLButtonElement | null = null;
	private chatBtn: HTMLButtonElement | null = null;
	private chatTile: ChatTile | null = null;
	private chatRoom: ChatRoom | null = null;
	private godBtn: HTMLButtonElement | null = null;
	private godConsole: GodConsole | null = null;
	private godVisible = false;
	private focusedKane: GodConsole | null = null;   // which Kane console (primary or duplicate) holds keyboard focus
	private extraKanes: Array<{ n: number; console: GodConsole }> = []; // with the instance number naming each one's .god home
	// Highest instance number claimed. Seeded at restore from the persisted records AND the .god
	// homes on disk, so a new duplicate can never land on an existing transcript.
	private kaneSeq = PRIMARY_GOD_INDEX;
	private holdUntil = 0;               // epoch ms: autoCenter is suppressed until then
	private kanePersonality = false;          // off = Kane behaves exactly as today (no persona, no pulses)
	private pulseTimer: number | null = null;
	private readonly pulseMs = 12 * 60 * 1000; // proactive floor-pulse cadence while personality is on
	private watchers: Array<{ target: string; note: string }> = [];
	private pendingTask = new Map<number, string>();
	private idleTiles = new Set<number>();
	// Per-tab (+ Alpha, keyed -1) last attention bucket — so the per-tab markers update and a pop-up
	// notification fires only on a TRANSITION into a new bucket, never repeatedly while it persists.
	// `undefined` = never seen yet (seeds silently, so a floor restore doesn't burst toasts).
	private lastAttn = new Map<number, AttentionKind | 'none'>();
	private stageWrapEl: HTMLElement | null = null;
	private floorTimer: number | null = null;
	private spotlightTimer: number | null = null;
	private godOutboxWatcher: import('fs').FSWatcher | null = null;
	private connectorsWatcher: import('fs').FSWatcher | null = null;
	private connectors: ConnectorConfig[] = [];
	private parentEl: HTMLElement | null = null;
	private readonly sidecarPath: string;
	private readonly notifyScriptPath: string;
	private readonly sessionsFile: string;
	private readonly coordDir: string;
	private readonly coordHookPath: string;
	private q = emptyState();
	// Steal grace (2026-07-24 queue spec): a fresh finisher only steals the center when the
	// user has been hands-off this long — typing/clicking means it queues (and pulses) instead.
	private lastActivityAt = 0;
	private keydown: ((e: KeyboardEvent) => void) | null = null;
	private keyup: ((e: KeyboardEvent) => void) | null = null;
	private onWinFocus: (() => void) | null = null;
	private onWinBlur: (() => void) | null = null;
	private scanTimer: number | null = null;
	private coordWatcher: import('fs').FSWatcher | null = null;
	private scanDebounce: number | null = null;
	private lastScanAt = 0; // rate-limits watcher-triggered scans (see the coordWatcher comment)
	private stageResizeObs: ResizeObserver | null = null;
	private layoutRaf: number | null = null;
	private overseerName: string;

	constructor(private deps: GridDeps) {
		this.overseerName = (deps.overseerName && deps.overseerName.trim()) || 'Kane';
		this.toolbar = normalizeToolbarState(deps.initialToolbar);
		this.sidecarPath = deps.sidecarPath;
		this.notifyScriptPath = deps.notifyScriptPath;
		this.sessionsFile = deps.sessionsFile;
		this.coordDir = deps.coordDir;
		this.coordHookPath = deps.coordHookPath;
		this.repos = deps.repos; // set here (not just loadRepos() at mount) so a spawn dispatched
		// through the outbox before this workspace is ever mounted still resolves a known repo.
		this.connectors = deps.connectors ?? [];
		// One shared settings file for every session, written beside the sidecar — never into a
		// worktree. Synchronous + here in the constructor so it exists before any tile spawns.
		try { writeWorktreeSettings(path.dirname(this.sidecarPath), this.notifyScriptPath, this.coordHookPath); } catch { /* best effort */ }
		this.journalStore = new JournalStore(path.join(this.coordDir, 'journals'));
		this.formatProbe = new FormatProbe({ sidecarPath: this.sidecarPath, cwd: this.coordDir, sessionEnv: deps.sessionEnv });
		this.convertProbe = new ConvertProbe({ sidecarPath: this.sidecarPath, cwd: this.coordDir, sessionEnv: deps.sessionEnv });
		// Arm the GOD outbox from the moment this workspace exists — not gated on the overseer
		// console ever being opened here. A dispatcher outside the app (Kane's own outbox channel,
		// documented as a supported integration point — see README "External dispatch") must not
		// have its commands pile up unread just because nobody has opened Kane in this workspace.
		this.armOutbox();
		// Same guarantee for the connector channel (a separate, narrower path for a non-overseer
		// local app — see README "External dispatch"): armed from construction too, independent
		// of both the overseer console and of whether the connector that dropped a request is
		// even registered yet (an unregistered drop still needs to be answered with a rejection).
		this.armConnectors();
	}

	/** Journal destinations configured in Settings (app-wide, not scoped to this workspace/group). */
	private async getConvertDestinations(): Promise<ConvertDestination[]> {
		const cfg = await window.wcc.getConfig();
		return Array.isArray(cfg.convertDestinations) ? cfg.convertDestinations : [];
	}

	/** "Convert to" a vault destination: no Claude/MCP involved, just write the note as a new
	 *  markdown file. Filename de-duped against whatever's already in the folder. */
	private async saveToVault(dest: VaultDestination, title: string, body: string): Promise<{ ok: boolean; path?: string; error?: string }> {
		try {
			await fs.mkdir(dest.vaultPath, { recursive: true });
			const existing = await fs.readdir(dest.vaultPath).catch(() => [] as string[]);
			const filename = vaultNoteFilename(title, new Date(), existing);
			const filePath = path.join(dest.vaultPath, filename);
			await fs.writeFile(filePath, vaultNoteContent(title, body), 'utf8');
			return { ok: true, path: filePath };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	/** Mount the grid into a page container. Sessions PERSIST across mounts (tab switches):
	 *  the stage + tiles + sidecar processes are created once and re-attached, never killed. */
	async mount(parent: HTMLElement): Promise<void> {
		await this.loadRepos();
		const controls = parent.createDiv({ cls: 'cos-terminals-controls' });
		this.controlsEl = controls;
		this.parentEl = parent;

		// Restore this tab's remembered selection as each select is built. Sessions already
		// survived a tab switch; the toolbar did not, so returning to a tab silently re-pointed
		// Play at the first repo in the list and main/master.
		const saved = this.toolbar;

		this.repoSel = controls.createEl('select');
		for (const r of this.repos) this.repoSel.createEl('option', { text: repoOptionLabel(r), value: r.name });
		if (saved.repo && this.repos.some((r) => r.name === saved.repo)) this.repoSel.value = saved.repo;
		this.repoSel.addEventListener('change', () => { this.rememberToolbar(); void this.refreshBranches(); });

		this.branchSel = controls.createEl('select');
		this.branchSel.addEventListener('change', () => this.rememberToolbar());

		this.modelSel = controls.createEl('select');
		this.modelSel.title = 'Model for new terminals';
		for (const m of SPAWN_MODELS) this.modelSel.createEl('option', { text: m.label, value: m.value });
		if (saved.model && SPAWN_MODELS.some((m) => m.value === saved.model)) this.modelSel.value = saved.model;
		this.modelSel.addEventListener('change', () => this.rememberToolbar());

		this.effortSel = controls.createEl('select');
		this.effortSel.title = 'Effort for new terminals';
		for (const m of SPAWN_EFFORTS) this.effortSel.createEl('option', { text: m.label, value: m.value });
		if (saved.effort && SPAWN_EFFORTS.some((m) => m.value === saved.effort)) this.effortSel.value = saved.effort;
		this.effortSel.addEventListener('change', () => this.rememberToolbar());

		const newBranchBtn = controls.createEl('button', { text: '+ New branch' });
		newBranchBtn.addEventListener('click', () => {
			void this.deps.promptForTopic('New branch', 'branch name (based on the selected branch)', '', 'Create').then((name) => {
				if (name && name.trim()) { this.pendingNewBranch = name.trim(); this.deps.toast(`Next Play creates branch "${name.trim()}"`, 'info'); }
			});
		});

		const play = controls.createEl('button', { text: '▶ Play', cls: 'cos-play-btn' });
		play.addEventListener('click', () => void this.play());

		const lockBtn = controls.createEl('button', { text: this.locked ? '🔒 Locked' : '🔓 Lock', cls: 'cos-lock-btn' });
		lockBtn.toggleClass('cos-lock-on', this.locked);
		lockBtn.setAttribute('title', 'When locked, terminals never auto-center — only your click or Alt+F-key centers one');
		lockBtn.addEventListener('click', () => {
			this.locked = !this.locked;
			lockBtn.setText(this.locked ? '🔒 Locked' : '🔓 Lock');
			lockBtn.toggleClass('cos-lock-on', this.locked);
		});

		// Select + Chat buttons intentionally not rendered — the group-chat feature is hidden,
		// and Select only existed to pick chat members. The code paths (setSelecting / openChat /
		// ChatRoom) remain intact, so uncommenting these two lines brings the chat workflow back.
		// this.selectBtn = controls.createEl('button', { text: '⊕ Select' });
		// this.selectBtn.addEventListener('click', () => this.setSelecting(!this.selecting));

		this.godBtn = controls.createEl('button', { text: `🜲 ${this.overseerName}`, cls: 'cos-god-btn' });
		this.godBtn.setAttribute('title', `Open the ${this.overseerName} overseer console — sees the whole floor, acts on request (Alt+K)`);
		this.godBtn.addEventListener('click', () => this.toggleGod());

		const kaneDupBtn = controls.createEl('button', { text: '🜲+', cls: 'cos-god-btn' });
		kaneDupBtn.setAttribute('title', `Add another ${this.overseerName} console — a separate session in its own panel (close it with its ×)`);
		kaneDupBtn.addEventListener('click', () => this.addKane());

		const viewCode = controls.createEl('button', { text: '🧩 View Code' });
		viewCode.addEventListener('click', () => void this.openInEditor());


		const refreshBtn = controls.createEl('button', { text: '⟳ Refresh' });
		refreshBtn.addEventListener('click', () => { void this.scanWorktrees().then(() => this.board?.refresh()); });

		const journalBtn = controls.createEl('button', { text: '📓 Journal Entry', cls: 'cos-journal-btn', attr: { title: 'Open a new journal entry tile (Alt+J)' } });
		journalBtn.addEventListener('click', () => this.spawnJournal());

		if (!this.board) this.board = new BoardView(
			this.coordDir,
			(branch) => void this.reopenAndOpen(branch),
			() => this.hidden.map((t) => ({ tileId: t.tileId, name: t.name, branch: t.branch, repo: t.repoName })),
			(tileId) => this.showTile(tileId),
			(tileId) => void this.closeHiddenTile(tileId),
			(tileId) => (tileId === 0 ? this.focusGod() : this.revealTile(tileId)),
		);
		this.board.mount(parent);

		void this.scanWorktrees();
		this.scanTimer = window.setInterval(() => { void this.scanWorktrees().then(() => this.board?.refresh()); }, 30_000);
		try {
			this.coordWatcher = (await import('fs')).watch(this.coordDir, (_evt, filename) => {
				const fn = String(filename ?? '');
				// Our own ledger write + the GOD feed dirs must never trigger a worktree rescan loop.
				if (fn === 'worktrees.md' || fn.startsWith('floor') || fn.startsWith('god-outbox') || fn.startsWith('god-inbox') || fn.startsWith('connectors')) return;
				if (this.scanDebounce !== null) window.clearTimeout(this.scanDebounce);
				// Rate-limit watcher-triggered scans. A busy floor (chat, locks, ready markers)
				// otherwise refires this every 500ms, and each scan spawns git per repo ON the
				// renderer thread — profiled at 95.7% of renderer time as `spawn` while the fleet
				// ran (2026-07-22), i.e. THE lag. The 30s timer still guarantees freshness.
				const wait = Math.max(500, 10_000 - (Date.now() - this.lastScanAt));
				this.scanDebounce = window.setTimeout(() => { void this.scanWorktrees().then(() => this.board?.refresh()); }, wait);
			});
		} catch { /* coordDir may not exist yet; the timer still covers it */ }

		if (!this.stageEl) {
			// First mount: create the stage (inside a dock row that can hold the GOD panel) +
			// restore button, restore any persisted sessions.
			this.stageWrapEl = parent.createDiv({ cls: 'cos-stage-wrap' });
			this.stageEl = this.stageWrapEl.createDiv({ cls: 'cos-terminals-stage' });
			// Keep Escape inside the terminal: xterm (the focused target) gets it first and
			// forwards it to Claude; stopping it here prevents it bubbling to Obsidian.
			this.stageEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
			// Re-lay-out on ANY stage size change, not just window resize — the Coordination board
			// growing/collapsing resizes the stage with no resize event, which otherwise leaves the
			// bottom row sized for the old (taller) stage and clipped below it.
			this.stageResizeObs = new ResizeObserver(() => this.scheduleLayout());
			this.stageResizeObs.observe(this.stageEl);
			await this.refreshBranches();
			await this.restoreSessions();
		} else {
			// Re-mount (tab switch back): re-attach the live dock row — sessions kept running.
			this.stageEl.toggleClass('cos-terminals-max', this.maximized);
			parent.appendChild(this.stageWrapEl!);
			await this.refreshBranches();
			this.applyLayout();
			this.focusCentered(); // returning to the tab puts the cursor back in the centered terminal
		}

		// Back on stage: resume live parsing (each tile flushes its batched output immediately).
		for (const t of [...this.tiles, ...this.hidden]) if (!t.isJournal) (t as TerminalTile).setDetached(false);

		this.applyMaximizeChrome();
		this.installKeyboard();
		window.addEventListener('resize', this.onResize);
	}

	/** Tab switch away: detach the stage + drop listeners, but KEEP sessions running. */
	unmount(): void {
		if (this.keydown) document.removeEventListener('keydown', this.keydown, true);
		if (this.keyup) document.removeEventListener('keyup', this.keyup, true);
		if (this.spotlightTimer !== null) { window.clearInterval(this.spotlightTimer); this.spotlightTimer = null; }
		if (this.onWinFocus) window.removeEventListener('focus', this.onWinFocus);
		if (this.onWinBlur) window.removeEventListener('blur', this.onWinBlur);
		window.removeEventListener('resize', this.onResize);
		if (this.layoutRaf !== null) { window.cancelAnimationFrame(this.layoutRaf); this.layoutRaf = null; }
		if (this.scanTimer !== null) { window.clearInterval(this.scanTimer); this.scanTimer = null; }
		if (this.scanDebounce !== null) { window.clearTimeout(this.scanDebounce); this.scanDebounce = null; }
		this.coordWatcher?.close(); this.coordWatcher = null;
		this.chatTile?.unmount();
		this.chatTile = null;
		this.chatRoom = null;
		// Deliberately NOT stopping the GOD floor feed here. unmount() only DETACHES the view
		// (tab/workspace switch) — worker sessions keep running — so Kane must keep seeing the
		// floor and receiving outbox commands across switches. The feed is tied to the GOD
		// console's lifetime and torn down only in dispose().
		this.board?.unmount();
		// Drop the controls bar too, so re-mounting this grid (workspace switch) doesn't stack a
		// second one. The stage wrap is detached-but-retained (tiles + sidecars stay alive).
		this.controlsEl?.remove();
		this.controlsEl = null;
		// Detached tiles suspend live xterm parsing (output batches in each tile's hidden buffer)
		// — an inactive workspace must not keep costing renderer CPU per PTY chunk.
		for (const t of [...this.tiles, ...this.hidden]) if (!t.isJournal) (t as TerminalTile).setDetached(true);
		// GOD survives a tab switch (like the tiles): detach with the stage wrap, keep the session.
		this.stageWrapEl?.remove();
	}

	private onResize = (): void => this.scheduleLayout();

	/** Coalesce layout requests into one applyLayout on the next frame. Fired on window resize AND
	 *  by the stage ResizeObserver — the stage shrinks whenever the Coordination board (a flex
	 *  sibling, up to 38vh) populates/expands, which emits no window-resize event. Re-running the
	 *  layout against the stage's CURRENT height keeps the bottom row from overflowing it. */
	private scheduleLayout(): void {
		if (this.layoutRaf !== null) return;
		this.layoutRaf = window.requestAnimationFrame(() => { this.layoutRaf = null; this.applyLayout(); });
	}

	/** Alt+←/→: step the spotlight across every visible tile AND an equal-grid stop (no
	 *  spotlight). Independent of the ready stack, so it reaches the equal grid even when every
	 *  terminal is thinking (the stack is empty then, which is why the old cycle couldn't).
	 *  Landing on a tile pins it so the auto-decider won't immediately yank it back. */
	private cycleSpotlight(dir: 1 | -1): void {
		this.holdUntil = 0; // Alt+←/→ = back in the flow; cycling never pins for long
		const chatId = this.chatTile?.tileId;
		const ids = [...this.tiles.map((t) => t.tileId), ...(chatId !== undefined ? [chatId] : [])];
		if (ids.length === 0) return;
		const want = nextSpotlight(ids, this.centeredId, dir);
		if (want === null) { this.centeredId = null; this.applyLayout(); return; } // equal grid
		this.lastActivityAt = Date.now();
		// Pin so autoCenter keeps it; the clicked-away ready tile gives up its queue turn.
		this.q = rqClick(this.q, want, this.centeredId).state;
		this.doCenter(want);
	}

	private installKeyboard(): void {
		this.keydown = (e: KeyboardEvent) => {
			if (e.key === 'Alt') { this.stageEl?.toggleClass('alt-on', true); this.refreshBadges(); return; }
			// NOTE: Escape is deliberately NOT handled here — it must reach the focused
			// terminal so Claude gets it (double-Esc clears the message). Use the Minimize /
			// Restore buttons to leave fullscreen.
			if (!e.altKey) return;
			if (e.key === 'ArrowRight') { e.preventDefault(); this.cycleSpotlight(1); return; }
			if (e.key === 'ArrowLeft') { e.preventDefault(); this.cycleSpotlight(-1); return; }
			// .code (physical key), not .key: Option composes most letters into accented/special
			// characters on macOS (Option+L composes instead of 'l'/'L'), so .key alone breaks these on
			// Mac. See physicalKeyLabel's doc comment. Same reason Alt+K uses e.code below.
			if (e.code === 'KeyL') { e.preventDefault(); if (this.centeredId !== null) this.toggleLockById(this.centeredId); return; }
			// Alt+K opens/focuses Kane. Kane wins this key — the letter-badge jumps only reach 'K'
			// with 23+ visible tiles, which never happens in practice.
			if (e.code === 'KeyK') { e.preventDefault(); this.openKane(); return; }
			// Alt+J opens a new journal entry. Like Alt+K, this shadows the letter badges only
			// at 22+ visible tiles (badges run F1–F12 then A…), which never happens in practice.
			// e.code for the same macOS Option-composition reason as Alt+L / Alt+K above.
			if (e.code === 'KeyJ') { e.preventDefault(); if (!e.repeat) this.spawnJournal(); return; }
			const idx = keyToIndex(physicalKeyLabel(e));
			if (idx !== null && this.tiles[idx]) { e.preventDefault(); this.handleClick(this.tiles[idx]!.tileId); }
		};
		this.keyup = (e: KeyboardEvent) => { if (e.key === 'Alt') { this.stageEl?.toggleClass('alt-on', false); this.tiles.forEach((t) => t.setBadge(null)); } };
		document.addEventListener('keydown', this.keydown, true);
		document.addEventListener('keyup', this.keyup, true);
		// Re-derive the spotlight from live output ~1x/s so the layout stays honest when a tile
		// resumes work by a route that isn't an in-app Enter (a cos-coord tell, an auto-sent task,
		// bypass-permission auto-continue) — otherwise its idle flag drifts stale and the grid
		// never drops to equal size even though every tile is thinking.
		if (this.spotlightTimer === null) this.spotlightTimer = window.setInterval(() => this.autoCenter(), 1000);
		// When the OS window regains focus (alt-tab back in), put the cursor back into the
		// centered terminal — Electron otherwise restores it to whatever tile had it before.
		this.onWinFocus = () => { if (this.focusedKane) this.focusedKane.focus(); else this.focusCentered(); };
		window.addEventListener('focus', this.onWinFocus);
		// Leaving Obsidian entirely (alt-tab to another app) also releases the typing-hold,
		// so terminals keep bubbling while you're working elsewhere.
		this.onWinBlur = () => { this.q.composingLen = 0; };
		window.addEventListener('blur', this.onWinBlur);
	}

	private refreshBadges(): void {
		this.tiles.forEach((t, i) => t.setBadge(keyForIndex(i)));
	}

	private async loadRepos(): Promise<void> {
		this.repos = this.deps.repos;
	}

	/** Update the repo list and rebuild the dropdown live; preserves the current selection if
	 *  still present, then refreshes branches for the newly-selected repo. */
	setRepos(repos: RepoConfig[]): void {
		this.repos = repos;
		if (!this.repoSel) return;
		const cur = this.repoSel.value;
		this.repoSel.empty();
		for (const r of this.repos) this.repoSel.createEl('option', { text: repoOptionLabel(r), value: r.name });
		if (this.repos.some((r) => r.name === cur)) this.repoSel.value = cur;
		void this.refreshBranches();
	}

	/** Live-rename the overseer (Settings → Overseer console name). Updates the 🜲 button + the
	 *  primary console header instantly; the running session's self-identity refreshes on its next
	 *  start/refresh. Duplicate consoles keep their existing "<oldname> N" label until re-created. */
	setOverseerName(name: string): void {
		this.overseerName = (name && name.trim()) || 'Kane';
		this.godBtn?.setText(`🜲 ${this.overseerName}`);
		this.godBtn?.setAttribute('title', `Open the ${this.overseerName} overseer console — sees the whole floor, acts on request (Alt+K)`);
		this.godConsole?.setDisplayName(this.overseerName);
	}

	private selectedRepo(): RepoConfig | undefined {
		return this.repos.find((r) => r.name === this.repoSel?.value);
	}

	private async refreshBranches(): Promise<void> {
		if (!this.branchSel) return;
		this.branchSel.empty();
		const repo = this.selectedRepo();
		if (!repo) return;
		if (repo.folder) {
			// No git, so no branches to offer. Keep one inert placeholder rather than an empty
			// select, so the toolbar doesn't look broken while a folder target is picked.
			this.branchSel.createEl('option', { text: '(no branch — folder)', value: '' });
			this.branchSel.disabled = true;
			this.rememberToolbar();
			return;
		}
		this.branchSel.disabled = false;
		const branches = await listBranches(repo.path);
		for (const b of branches) this.branchSel.createEl('option', { text: b, value: b });
		// The branch this tab was left on wins; main/master is the fallback for a first visit,
		// or for a remembered branch that has since been deleted.
		const def = defaultBranch(branches); // default to main / master, not git's first-listed
		if (this.toolbar.branch && branches.includes(this.toolbar.branch)) this.branchSel.value = this.toolbar.branch;
		else if (def) this.branchSel.value = def;
		this.rememberToolbar();
	}

	/** Snapshot the four dropdowns into this workspace's remembered state and hand it up to be
	 *  persisted. Called on every change and after each branch refresh — a human changes these
	 *  rarely, and the app's config writer serializes the resulting writes. */
	private rememberToolbar(): void {
		const next = normalizeToolbarState({
			repo: this.repoSel?.value,
			branch: this.branchSel?.value,
			model: this.modelSel?.value,
			effort: this.effortSel?.value,
		});
		this.toolbar = next;
		this.deps.onToolbarChange?.(next);
	}

	private async play(): Promise<void> {
		const repo = this.selectedRepo();
		if (repo?.folder) { await this.spawnFolder(repo, {}); return; } // no branch to require
		const base = this.branchSel?.value;
		if (!repo || !base) { this.deps.toast('Pick a repo and branch first', 'warn'); return; }
		await this.spawnWorktree(repo, base, {});
	}

	/** Spawn core for a FOLDER target: no `git worktree add`, no branch — the tile's working
	 *  directory IS the folder. Mirrors spawnWorktree's tile/persist/layout tail so both kinds of
	 *  terminal behave identically once they exist. */
	private async spawnFolder(repo: RepoConfig, opts: { task?: string; model?: string; effort?: string; name?: string }): Promise<TerminalTile | null> {
		try {
			await fs.access(repo.path); // a moved/unmounted folder should say so, not spawn into nothing
		} catch {
			this.deps.toast(`Folder unreachable — ${repo.path} is missing or on a disconnected drive`, 'error');
			return null;
		}
		const model = opts.model ?? (this.modelSel?.value || undefined);
		const effort = opts.effort ?? (this.effortSel?.value || undefined);
		const tile = this.makeTile({ worktreePath: repo.path, branch: '' }, repo.name, repo.path, '', false, opts.name, model, effort, true);
		if (opts.task) this.pendingTask.set(tile.tileId, opts.task);
		if (this.stageEl) tile.render(this.stageEl);
		this.tiles.push(tile);
		void this.persist();
		this.applyLayout();
		return tile;
	}

	/** Shared spawn core: create a worktree + tile, render, persist, layout. Optionally queue an
	 *  initial task to send once the new session is first ready. Returns the tile (or null). */
	private async spawnWorktree(repo: RepoConfig, base: string, opts: { task?: string; model?: string; effort?: string; name?: string }): Promise<TerminalTile | null> {
		try {
			const branches = await listBranches(repo.path);
			const branch = this.pendingNewBranch ?? nextWorktreeBranch(branches, base);
			this.pendingNewBranch = null;
			const worktree = await createWorktree(repo.path, repo.name, base, branch);
			// Explicit opts win; otherwise inherit the toolbar dropdowns ('' = CLI default = no flag).
			const model = opts.model ?? (this.modelSel?.value || undefined);
			const effort = opts.effort ?? (this.effortSel?.value || undefined);
			const tile = this.makeTile(worktree, repo.name, repo.path, base, false, opts.name, model, effort);
			if (opts.task) this.pendingTask.set(tile.tileId, opts.task);
			if (this.stageEl) tile.render(this.stageEl);
			this.tiles.push(tile);
			void this.persist();
			this.applyLayout();
			return tile;
		} catch (e) {
			this.deps.toast(`Couldn't create a worktree in ${repo.name}: ${(e as Error).message}`, 'error');
			return null;
		}
	}

	/** Kane asked to spawn a terminal: resolve the repo by name, validate the effort, default the
	 *  base branch, start it on the given task. Invalid effort → error note, no spawn. */
	private async spawnFromKane(repoName: string, base: string | null, task: string, model: string | null = null, effort: string | null = null, name: string | null = null): Promise<void> {
		const known = this.repos.some((r) => r.name === repoName || r.name.toLowerCase() === repoName.toLowerCase());
		if (!known) { this.writeGodInbox(`cannot spawn — unknown repo "${repoName}". Known: ${this.repos.map((r) => r.name).join(', ') || '(none)'}`); return; }
		if (effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
			this.writeGodInbox(`cannot spawn — invalid --effort "${effort}". Valid: ${EFFORT_LEVELS.join(', ')}`);
			return;
		}
		await this.spawnFromName(repoName, base, task, model ?? undefined, effort ?? undefined, name ?? undefined);
	}

	/** Spawn a new journal tile, center it, and persist. */
	private spawnJournal(): void {
		const tile = new JournalTile({
			tileId: this.nextTileId++,
			name: `Journal ${++this.journalSeq}`,
			store: this.journalStore,
			toast: this.deps.toast,
			onClosed: (t) => {
				if (this.centeredId === t.tileId) this.centeredId = null;
				this.q = rqClose(this.q, t.tileId).state;
				this.tiles = this.tiles.filter((x) => x !== t); t.kill(); void this.persist();
				this.applyLayout();
				this.autoCenter(); // serve the queue front (or drop to the equal grid)
			},
			onHide: (t) => this.hideTile(t),
			onLock: (t) => this.toggleLockById(t.tileId),
			onCenter: (t) => this.handleClick(t.tileId),
			onRequestRename: (t, cur) => {
				void this.deps.promptForTopic('Rename journal', 'New name', cur, 'Rename')
					.then((name) => { if (name && name.trim()) { t.setName(name.trim()); void this.persist(); } });
			},
			onRename: () => { void this.persist(); },
			onFormat: (text) => this.formatProbe.format(text),
			onGetDestinations: () => this.getConvertDestinations(),
			onConvertPropose: (text) => this.convertProbe.propose(text),
			onConvertCreate: (issues, dest) => this.convertProbe.create(issues, dest),
			onConvertSaveToVault: (dest, title, body) => this.saveToVault(dest, title, body),
			onOpenSettings: () => this.deps.openSettings(),
		});
		if (this.stageEl) tile.render(this.stageEl);
		this.tiles.push(tile);
		this.doCenter(tile.tileId);
		void this.persist();
	}

	/** Try launching one editor on a repo path. Unlike the old `spawn(..., {shell:true})` call,
	 *  this actually waits for the real outcome instead of assuming success the instant spawn()
	 *  returns without throwing — `shell:true` swallows a "command not found" asynchronously
	 *  inside the shell, so the old code showed "Opening…" even when nothing happened. A GUI
	 *  editor launched via `open -a` (mac) typically exits 0 quickly once it's handed off; a CLI
	 *  command may keep running (some fork+detach, some don't), so treat "still running after a
	 *  beat" as success too. */
	private trySpawnEditor(cmd: string, args: string[]): Promise<boolean> {
		return new Promise((resolve) => {
			let settled = false;
			const done = (ok: boolean): void => { if (!settled) { settled = true; resolve(ok); } };
			let proc;
			try { proc = spawn(cmd, args, { windowsHide: true }); } catch { done(false); return; }
			proc.on('error', () => done(false));
			proc.on('exit', (code) => done(code === 0 || code === null));
			window.setTimeout(() => done(true), 1200);
		});
	}

	/** Open the repo selected in the dropdown in the user's preferred editor. First try: the
	 *  saved preference (or VS Code, the historical default, if none saved yet). On failure —
	 *  editor not installed, or never configured — offer a picker of common editors plus a
	 *  Finder/Explorer fallback and a custom-command option; remember whichever one works so
	 *  future clicks skip straight to it. If the newly-picked editor ALSO isn't installed, offer
	 *  to open its download page rather than silently failing again. */
	private async openInEditor(): Promise<void> {
		const repo = this.selectedRepo();
		if (!repo) { this.deps.toast('Pick a repo first', 'warn'); return; }

		const cfg = await window.wcc.getConfig();
		const savedId = typeof cfg.preferredEditorId === 'string' ? cfg.preferredEditorId : null;
		const savedCustomCmd = typeof cfg.preferredEditorCustomCmd === 'string' ? cfg.preferredEditorCustomCmd : null;

		if (savedId === 'file-browser') { revealInFileManager(repo.path); this.deps.toast(`Revealed ${repo.name} in the file manager`, 'success'); return; }
		if (savedId === 'custom' && savedCustomCmd) {
			if (await this.trySpawnEditor(savedCustomCmd, [repo.path])) { this.deps.toast(`Opening ${repo.name}…`, 'info'); return; }
		} else if (savedId) {
			const editor = EDITORS.find((e) => e.id === savedId);
			const launch = editor ? resolveEditorCommand(editor, repo.path, process.platform) : null;
			if (editor && launch && await this.trySpawnEditor(launch.cmd, launch.args)) {
				this.deps.toast(`Opening ${repo.name} in ${editor.label}…`, 'info');
				return;
			}
		} else {
			// No preference saved yet — try the historical default (VS Code) once, silently, before
			// ever bothering the user with a picker.
			const vscode = EDITORS[0]!;
			const launch = resolveEditorCommand(vscode, repo.path, process.platform);
			if (launch && await this.trySpawnEditor(launch.cmd, launch.args)) {
				this.deps.toast(`Opening ${repo.name} in ${vscode.label}…`, 'info');
				await window.wcc.setConfig({ ...(await window.wcc.getConfig()), preferredEditorId: vscode.id });
				return;
			}
		}

		await this.pickAndLaunchEditor(repo.name, repo.path);
	}

	/** The picker shown after a launch attempt fails: choose an editor, remember it, and if it
	 *  ALSO fails to launch (not installed), offer its download page. */
	private async pickAndLaunchEditor(repoName: string, repoPath: string): Promise<void> {
		const options = [
			...EDITORS.map((e) => ({ id: e.id, label: e.label })),
			{ id: FILE_BROWSER.id, label: FILE_BROWSER.label },
			{ id: CUSTOM_EDITOR.id, label: CUSTOM_EDITOR.label },
		];
		const choice = await promptForChoice(
			'Open in…',
			"Couldn't open that editor — pick one to use (remembered for next time):",
			options,
		);
		if (!choice) return;

		if (choice === FILE_BROWSER.id) {
			revealInFileManager(repoPath);
			await window.wcc.setConfig({ ...(await window.wcc.getConfig()), preferredEditorId: choice });
			this.deps.toast(`Revealed ${repoName} in the file manager`, 'success');
			return;
		}

		if (choice === CUSTOM_EDITOR.id) {
			const cmd = await this.deps.promptForTopic('Custom editor command', 'e.g. subl, code, /usr/local/bin/myeditor', '', 'Save');
			if (!cmd) return;
			if (await this.trySpawnEditor(cmd, [repoPath])) {
				await window.wcc.setConfig({ ...(await window.wcc.getConfig()), preferredEditorId: choice, preferredEditorCustomCmd: cmd });
				this.deps.toast(`Opening ${repoName}…`, 'info');
			} else {
				this.deps.toast(`Couldn't run "${cmd}" — check the command in Settings and try again`, 'error');
			}
			return;
		}

		const editor = EDITORS.find((e) => e.id === choice) as EditorDef;
		const launch = resolveEditorCommand(editor, repoPath, process.platform);
		if (launch && await this.trySpawnEditor(launch.cmd, launch.args)) {
			await window.wcc.setConfig({ ...(await window.wcc.getConfig()), preferredEditorId: choice });
			this.deps.toast(`Opening ${repoName} in ${editor.label}…`, 'info');
			return;
		}

		if (editor.downloadUrl) {
			const install = await promptForConfirm(
				`${editor.label} isn't installed`,
				`Couldn't launch ${editor.label} — it doesn't look installed. Open its download page?`,
				'Open download page',
			);
			if (install) {
				openExternalUrl(editor.downloadUrl);
				this.deps.toast(`Opened the ${editor.label} download page — click View Code again once it's installed`, 'warn');
			}
		}
	}

	/** Manual click / Alt-key: in select mode toggle room membership; otherwise center. */
	private handleClick(id: number): void {
		if (this.selecting) {
			const tile = this.tiles.find((t) => t.tileId === id);
			if (tile) { tile.setSelected(!tile.isSelected); this.updateChatBtn(); }
			return;
		}
		this.lastActivityAt = Date.now();
		// Pin the clicked tile; a clicked-away ready center gives up its turn (→ back of queue).
		this.q = rqClick(this.q, id, this.centeredId).state;
		this.q.composingLen = 0;
		this.doCenter(id);
		this.holdUntil = Date.now() + MANUAL_HOLD_MS; // an explicit choice — hold the spotlight here
	}

	private updateChatBtn(): void {
		const n = this.tiles.filter((t) => t.isSelected).length;
		if (this.chatBtn) this.chatBtn.disabled = n < 2;
	}

	/** Toggle select mode + reflect it on the button label ("⊕ Selecting…"). */
	private setSelecting(on: boolean): void {
		this.selecting = on;
		this.selectBtn?.setText(on ? '⊕ Selecting…' : '⊕ Select');
		this.selectBtn?.toggleClass('cos-select-on', on);
		if (!on) this.tiles.forEach((t) => t.setSelected(false));
		this.updateChatBtn();
	}

	/** Open a chat tile in the stage over the selected terminals. */
	private openChat(): void {
		const selected = this.tiles.filter((t) => t.isSelected);
		if (selected.length < 2) { this.deps.toast('Select at least 2 terminals first', 'warn'); return; }
		const members = (selected as TerminalTile[]).map((t) => ({
			name: t.name,
			sendLine: (s: string) => t.sendLine(s),
			sendKeys: (s: string) => t.sendKeys(s),
			isAlive: () => this.tiles.includes(t),
			recentOutput: () => t.recentOutput(),
		}));
		this.chatTile?.unmount();
		// Bypass-permission groups never see a real Claude approval prompt, so
		// don't surface input-request cards there — they'd all be phantoms from conversation.
		const room = new ChatRoom(this.coordDir, members, !this.deps.bypassPermissions);
		this.chatRoom = room;
		const id = this.nextTileId++;
		this.chatTile = new ChatTile(id, room, () => this.closeChat(), () => this.centerChat());
		if (this.stageEl) this.chatTile.render(this.stageEl);
		this.centeredId = id; // open centered, but it's now a normal movable tile (click any tile to move focus)
		this.setSelecting(false);
		this.applyLayout();
		this.chatTile.focus();
	}

	/** Center the chat tile (clicking it, like clicking a terminal, brings it to the middle). */
	private centerChat(): void {
		if (!this.chatTile) return;
		this.centeredId = this.chatTile.tileId;
		this.applyLayout();
		this.chatTile.focus();
	}

	private closeChat(): void {
		this.chatTile?.unmount();
		this.chatTile = null;
		this.chatRoom = null;
		this.applyLayout();
	}

	/** Every live session GOD should see / be able to message (foreground + hidden background). */
	private allSessions(): StageTile[] { return [...this.tiles, ...this.hidden]; }

	/** Number of live terminals (foreground + hidden) — for the close-workspace confirm. */
	terminalCount(): number { return this.tiles.length + this.hidden.length; }

	/** Snapshot of which terminals need attention, for the topbar queue. */
	attentionItems(): AttentionItem[] {
		return classifyAttention((this.allSessions().filter((t) => !t.isJournal) as TerminalTile[]).map((t) => ({
			id: t.tileId, name: t.name, repo: this.repoNameFor(t),
			output: t.recentOutput(), idle: this.idleTiles.has(t.tileId),
		})));
	}

	/** Jump to a terminal by id: un-hide it if hidden, else center + focus it. */
	revealTile(id: number): void {
		if (this.hidden.some((t) => t.tileId === id)) { this.showTile(id); return; }
		if (this.tiles.some((t) => t.tileId === id)) { this.doCenter(id); this.focusCentered(); }
	}

	private tileState(t: StageTile): string {
		const o = t.recentOutput();
		if (looksLikePrompt(o)) return 'prompt';
		if (looksLikeMenu(o)) return 'menu';
		if (looksErrored(o)) return 'errored';
		return this.idleTiles.has(t.tileId) ? 'idle' : 'running';
	}

	/** Floor snapshot for the phone view: every session (+ Kane) with state + recent output. */
	floorState(): RemoteTerminal[] {
		const out: RemoteTerminal[] = (this.allSessions().filter((t) => !t.isJournal) as TerminalTile[]).map((t) => ({
			id: t.tileId, name: t.name, repo: this.repoNameFor(t), branch: t.branch,
			state: this.tileState(t), output: t.recentOutput().split('\n').slice(-12).join('\n'), remoteOn: t.isRemoteOn,
		}));
		if (this.godConsole) {
			const ko = this.godConsole.recentOutput();
			out.unshift({
				id: -1, name: this.overseerName, repo: '—', branch: '—',
				state: looksLikePrompt(ko) ? 'prompt' : looksLikeMenu(ko) ? 'menu' : 'running',
				output: ko.split('\n').slice(-12).join('\n'), remoteOn: false,
			});
		}
		return out;
	}

	repoNames(): string[] { return this.repos.map((r) => r.name); }

	/** Toggle remote-control on a terminal by id (from the phone). */
	toggleRemoteById(id: number): void {
		const t = this.allSessions().find((x) => x.tileId === id);
		if (t && !t.isJournal) (t as TerminalTile).toggleRemoteControl();
	}

	/** Spawn a worktree terminal for a repo by name, on a base, with a kickoff task. Model/effort
	 *  override the toolbar dropdowns when given (spawnWorktree applies the fallback); name
	 *  overrides the default branch-derived terminal name. */
	async spawnFromName(repoName: string, base: string | null, task: string, model?: string, effort?: string, name?: string): Promise<TerminalTile | null> {
		const repo = this.repos.find((r) => r.name === repoName)
			?? this.repos.find((r) => r.name.toLowerCase() === repoName.toLowerCase());
		if (!repo) return null;
		if (repo.folder) return this.spawnFolder(repo, { task, model, effort, name }); // --base is meaningless here
		const baseBranch = base ?? (defaultBranch(await listBranches(repo.path)) ?? 'main');
		return this.spawnWorktree(repo, baseBranch, { task, model, effort, name });
	}

	/** Re-tint every live terminal well for a theme switch (tiles, hidden tiles, Kanes).
	 *  New terminals pick the palette up themselves via activeTerminalPalette(). */
	applyTerminalPalette(p: TerminalPalette): void {
		for (const t of [...this.tiles, ...this.hidden]) if (!t.isJournal) (t as TerminalTile).setTerminalPalette(p);
		this.godConsole?.setTerminalPalette(p);
		for (const k of this.extraKanes) k.console.setTerminalPalette(p);
	}

	/** Toggle the GOD console: spawn on first open, then just show/hide (session persists). */
	private toggleGod(): void {
		if (!this.godConsole) {
			const godHomeDir = path.join(this.coordDir, '..', '.god', this.deps.group);
			const kane: GodConsole = new GodConsole(
				{ repos: this.repos.map((r) => ({ name: r.name, path: r.path, folder: r.folder })), coordDir: this.coordDir, sidecarPath: this.sidecarPath, godHomeDir, sessionEnv: this.deps.sessionEnv, instanceName: this.overseerName, selfImprove: this.deps.godSelfImprove, roleLibraryPath: this.deps.roleLibrary?.path, resume: true, onFocusChange: (f) => { this.focusedKane = f ? kane : (this.focusedKane === kane ? null : this.focusedKane); } },
				() => this.hideGod(),
			);
			this.godConsole = kane;
			void this.persist(); // record Kane's existence so the next launch reopens him
			if (this.stageWrapEl) this.godConsole.render(this.stageWrapEl);
			this.godVisible = true;
			this.startFloorFeed();
			this.godBtn?.toggleClass('cos-god-on', true);
			this.applyLayout();
			this.godConsole.focus();
			return;
		}
		if (this.godVisible) this.hideGod();
		else this.showGod();
	}

	/** Alt+K: open Kane if needed and put the cursor in his terminal. Never closes him. */
	private openKane(): void {
		if (!this.godConsole) { this.toggleGod(); return; } // first open creates + focuses
		if (!this.godVisible) this.showGod();               // setVisible(true) refits + refocuses
		this.godConsole.focus();
	}

	/** Dock an ADDITIONAL Kane console — its own session + home dir. Duplicates persist exactly
	 *  like the primary: the instance number goes into the sessions file and the next launch
	 *  reopens the console, --continue-ing its own .god/<group>-N conversation. The × disposes it
	 *  and drops the record; the transcript on disk is left alone.
	 *  Pass `index` to reopen a persisted duplicate; omit it for a user-created one, which takes
	 *  the next unclaimed number and gets the focus. */
	private addKane(index?: number): void {
		const n = index ?? this.kaneSeq + 1;
		if (this.extraKanes.some((k) => k.n === n)) return; // already live — never two consoles on one home dir
		this.kaneSeq = Math.max(this.kaneSeq, n);
		const godHomeDir = path.join(this.coordDir, '..', '.god', `${this.deps.group}-${n}`);
		const kane = new GodConsole(
			{
				repos: this.repos.map((r) => ({ name: r.name, path: r.path, folder: r.folder })),
				coordDir: this.coordDir,
				sidecarPath: this.sidecarPath,
				godHomeDir,
				sessionEnv: this.deps.sessionEnv,
				selfImprove: this.deps.godSelfImprove,
				roleLibraryPath: this.deps.roleLibrary?.path,
				// Same as the primary: --continue picks this duplicate's own conversation back up,
				// falling back to a fresh session when there is nothing to resume yet.
				resume: true,
				onFocusChange: (f) => { this.focusedKane = f ? kane : (this.focusedKane === kane ? null : this.focusedKane); },
				instanceName: `${this.overseerName} ${n}`,
				terminalId: String(-n),
			},
			() => {
				kane.dispose();
				this.extraKanes = this.extraKanes.filter((k) => k.console !== kane);
				void this.persist(); // × closes it for good — drop the record so it doesn't reopen
				this.applyLayout();
			},
		);
		if (this.stageWrapEl) kane.render(this.stageWrapEl);
		this.extraKanes.push({ n, console: kane });
		void this.persist(); // record its existence so the next launch reopens it
		this.startFloorFeed();
		this.applyLayout();
		if (index === undefined) kane.focus(); // a restore must not steal focus from the tiles coming back
	}

	/** Ping the primary Kane and every duplicate (they share the god role — any of them
	 *  may have registered the watch or flipped the personality). */
	private notifyKanes(text: string): void {
		this.godConsole?.notify(text);
		for (const k of this.extraKanes) k.console.notify(text);
	}

	/** Restart every live claude session in this workspace in place (--continue, fresh
	 *  fallback) — visible + hidden terminals and every Kane console; journals have no
	 *  session. The account switch uses this so ACTIVE terminals move to the new session
	 *  env, not just future spawns. */
	restartSessions(): void {
		for (const t of [...this.tiles, ...this.hidden]) if (!t.isJournal) (t as TerminalTile).restartInPlace();
		this.godConsole?.restartInPlace();
		for (const k of this.extraKanes) k.console.restartInPlace();
	}

	private showGod(): void {
		this.godVisible = true;
		this.godConsole?.setVisible(true);
		this.startFloorFeed();
		this.godBtn?.toggleClass('cos-god-on', true);
		this.applyLayout();
	}

	/** Ensure Kane's panel is open + focused — used by the Coordination panel's background-tasks
	 *  list to jump to Kane's own runs (tileId 0, which isn't a real tile in `this.tiles`). */
	private focusGod(): void {
		if (!this.godConsole || !this.godVisible) this.toggleGod();
		this.godConsole?.focus();
	}

	private hideGod(): void {
		this.godVisible = false;
		this.godConsole?.setVisible(false);
		// Deliberately NOT stopping the feed. Hiding the panel must not blind/mute Kane — his
		// session stays alive while hidden, so snapshots + outbox draining keep running. The feed
		// is started on GOD-console create/show and stopped only in dispose().
		this.godBtn?.toggleClass('cos-god-on', false);
		this.applyLayout();
	}

	private floorDir(): string { return path.join(this.coordDir, 'floor'); }
	private outboxDir(): string { return path.join(this.coordDir, 'god-outbox'); }
	private connectorsRootDir(): string { return path.join(this.coordDir, 'connectors'); }

	/** Drain whatever's waiting in the GOD outbox, then watch for new drops. Idempotent, and
	 *  deliberately independent of the overseer console's lifetime (see the constructor). */
	private armOutbox(): void {
		if (this.godOutboxWatcher) return;
		try {
			const out = this.outboxDir();
			fsSync.mkdirSync(out, { recursive: true });
			this.drainOutbox();
			this.godOutboxWatcher = fsSync.watch(out, () => this.drainOutbox());
		} catch { /* outbox unavailable */ }
	}

	/** Drain whatever's waiting for every connector (registered or not — an unregistered drop
	 *  still needs a rejected receipt), then watch for new drops anywhere under connectors/.
	 *  `recursive: true` picks up requests dropped into a connector id nobody has spawned a
	 *  subdirectory for yet; Node supports it natively on both platforms this app ships for
	 *  (Windows, macOS) so there's no need for a second, per-connector watcher. */
	private armConnectors(): void {
		if (this.connectorsWatcher) return;
		try {
			const root = this.connectorsRootDir();
			fsSync.mkdirSync(root, { recursive: true });
			this.drainConnectors();
			this.connectorsWatcher = fsSync.watch(root, { recursive: true }, () => this.drainConnectors());
		} catch { /* connectors unavailable */ }
	}

	/** Begin writing terminal snapshots while the console is open (the outbox watcher is already
	 *  armed from construction — this only (re-)confirms it, cheaply, via armOutbox's own guard). */
	private startFloorFeed(): void {
		this.writeFloorSnapshot();
		if (this.floorTimer === null) this.floorTimer = window.setInterval(() => this.writeFloorSnapshot(), 4000);
		this.armOutbox();
	}

	private stopFloorFeed(): void {
		if (this.floorTimer !== null) { window.clearInterval(this.floorTimer); this.floorTimer = null; }
		this.godOutboxWatcher?.close(); this.godOutboxWatcher = null;
		this.connectorsWatcher?.close(); this.connectorsWatcher = null;
	}

	/** Dump each live session's recent output to coordDir/floor/<id>-<slug>.md + an INDEX.md;
	 *  prune snapshots for sessions that have since closed. */
	private writeFloorSnapshot(): void {
		try {
			const dir = this.floorDir();
			fsSync.mkdirSync(dir, { recursive: true });
			const now = Date.now();
			const sessions = this.allSessions();
			const live = new Set<string>(['INDEX.md']);
			for (const t of sessions) {
				if (t.isJournal) continue; // journals have no worktree snapshot
				const tt = t as TerminalTile;
				const fname = `${tt.tileId}-${godSlug(tt.name)}.md`;
				live.add(fname);
				const body = formatFloorSnapshot(
					{ name: tt.name, repo: this.repoNameFor(tt), branch: tt.branch, worktreePath: tt.worktreePath, ts: now },
					tt.recentOutput(),
				);
				fsSync.writeFileSync(path.join(dir, fname), body, 'utf8');
			}
			fsSync.writeFileSync(path.join(dir, 'INDEX.md'),
				formatFloorIndex(sessions.map((t) => ({ id: t.tileId, name: t.name, repo: this.repoNameFor(t), branch: t.branch }))), 'utf8');
			for (const f of fsSync.readdirSync(dir)) if (f.endsWith('.md') && !live.has(f)) { try { fsSync.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
		} catch { /* best effort */ }
	}

	/** The repo name a session belongs to (matches the scan/registry mapping).
	 *
	 *  The tile CARRIES the target it was spawned from, and persists it, so trust that first.
	 *  Resolving only through the worktree scan reported '?' for any tile newer than the last
	 *  sweep (it runs every 30s) — and permanently for folder targets, which scanWorktrees skips
	 *  entirely because they have no worktrees to list. The scan stays as the fallback for a
	 *  record restored without a repo name. */
	private repoNameFor(t: StageTile): string {
		if (t.isJournal) return 'journal';
		const tt = t as TerminalTile;
		if (tt.repoName) return tt.repoName;
		const e = this.lastEntries.find((x) => path.resolve(x.path) === path.resolve(tt.worktreePath));
		return e ? e.repo : '?';
	}

	/** Deliver any pending GOD→worker messages, then archive them to .done/. */
	private drainOutbox(): void {
		const out = this.outboxDir();
		let files: string[] = [];
		try { files = fsSync.readdirSync(out).filter((f) => f.endsWith('.json')); } catch { return; }
		if (!files.length) return;
		const sessions = this.allSessions();
		const names = sessions.map((t) => t.name);
		const done = path.join(out, '.done');
		try { fsSync.mkdirSync(done, { recursive: true }); } catch { /* ignore */ }
		for (const f of files) {
			const full = path.join(out, f);
			let text = '';
			try { text = fsSync.readFileSync(full, 'utf8'); } catch { continue; }
			const msg = parseOutboxMessage(text);
			if (msg) this.dispatchOutbox(msg, names);
			try { fsSync.renameSync(full, path.join(done, f)); } catch { try { fsSync.unlinkSync(full); } catch { /* ignore */ } }
		}
	}

	/** Act on one parsed Kane command (tell a worker / register a watch / spawn a terminal). */
	private dispatchOutbox(msg: OutboxMessage, liveNames: string[]): void {
		if (msg.kind === 'tell') {
			const name = resolveTellTarget(msg.target, liveNames);
			const tile = name ? this.allSessions().find((t) => t.name === name) : undefined;
			if (tile && !tile.isJournal) (tile as TerminalTile).sendLine(msg.message);
			else this.writeGodInbox(`could not deliver to "${msg.target}" — not a live terminal. Live: ${liveNames.join(', ') || '(none)'}`);
		} else if (msg.kind === 'watch') {
			const name = resolveTellTarget(msg.target, liveNames);
			if (name) this.watchers.push({ target: name, note: msg.note });
			else this.writeGodInbox(`cannot watch "${msg.target}" — not a live terminal. Live: ${liveNames.join(', ') || '(none)'}`);
		} else if (msg.kind === 'personality') {
			this.togglePersonality();
		} else if (msg.kind === 'rename') {
			const name = resolveTellTarget(msg.target, liveNames);
			const tile = name ? this.allSessions().find((t) => t.name === name) : undefined;
			if (tile && !tile.isJournal) {
				(tile as TerminalTile).setName(msg.name);
				// Watchers match on terminal name — retarget them so a rename can't strand a watch.
				this.watchers = remapWatchers(this.watchers, name!, msg.name);
			} else {
				this.writeGodInbox(`cannot rename "${msg.target}" — not a live terminal. Live: ${liveNames.join(', ') || '(none)'}`);
			}
		} else {
			void this.spawnFromKane(msg.repo, msg.base, msg.task, msg.model, msg.effort, msg.name);
		}
	}

	/** Drain every connector subdirectory's requests, then prune its stale receipts. Both are
	 *  cheap no-ops when there's nothing to do, so re-running this on every fs event is fine. */
	private drainConnectors(): void {
		const root = this.connectorsRootDir();
		let ids: string[] = [];
		try { ids = fsSync.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return; }
		for (const connectorId of ids) {
			this.drainConnectorRequests(connectorId);
			this.pruneConnectorReceipts(connectorId);
		}
	}

	/** Deliver (or reject) whatever's waiting in one connector's requests/, then archive the
	 *  request files to .done/ — same shape as drainOutbox, but the receipt is written separately
	 *  (keyed by the request's own `id`, not the filename) since accepting a spawn needs an await
	 *  before the terminal name it reports back is known. */
	private drainConnectorRequests(connectorId: string): void {
		const reqDir = path.join(this.connectorsRootDir(), connectorId, 'requests');
		let files: string[] = [];
		try { files = fsSync.readdirSync(reqDir).filter((f) => f.endsWith('.json')); } catch { return; }
		if (!files.length) return;
		const done = path.join(reqDir, '.done');
		try { fsSync.mkdirSync(done, { recursive: true }); } catch { /* ignore */ }
		for (const f of files) {
			const full = path.join(reqDir, f);
			let text = '';
			try { text = fsSync.readFileSync(full, 'utf8'); } catch { continue; }
			try { fsSync.renameSync(full, path.join(done, f)); } catch { try { fsSync.unlinkSync(full); } catch { /* ignore */ } }
			void this.handleConnectorRequest(connectorId, text);
		}
	}

	/** Evaluate one connector request (pure decision in connectors.ts), then either act — spawn a
	 *  terminal, or deliver a message into a live one — and report the terminal it actually
	 *  touched, or write a rejected receipt with a reason. Never nothing: that silent-drop shape
	 *  (`cos-coord spawn` used to exit 0 without acting) is the exact failure this channel exists
	 *  to eliminate. */
	private async handleConnectorRequest(connectorId: string, text: string): Promise<void> {
		const outcome = evaluateConnectorRequest(text, {
			connectorId,
			registeredConnectorIds: this.connectors.map((c) => c.id),
			knownRepoNames: this.repos.map((r) => r.name),
			liveTerminals: this.allSessions().map((t) => ({ name: t.name, isJournal: t.isJournal })),
		});
		if (outcome.status === 'rejected') {
			// No recoverable id (unparseable JSON, or no "id" field at all) — nothing to name a
			// receipt file after, so there's nothing more to do than drop it, same as the outbox.
			if (outcome.id) this.writeConnectorReceipt(connectorId, { v: 1, id: outcome.id, status: 'rejected', reason: outcome.reason, handledMs: Date.now() });
			return;
		}
		const { request } = outcome;
		if (request.kind === 'tell') {
			// Resolved against the roster moments ago, in evaluateConnectorRequest — re-check here
			// rather than trust it blindly, since draining is async and the tile could have closed
			// (or been renamed into a journal, impossible today but not worth assuming) in between.
			// No busy/idle check: delivery means "typed into the terminal", same as Kane's own tell —
			// a Claude Code session queues input typed while it's mid-task, it doesn't drop it.
			const tile = this.allSessions().find((t) => t.name === request.terminal);
			if (tile && !tile.isJournal) {
				(tile as TerminalTile).sendLine(request.message);
				this.writeConnectorReceipt(connectorId, { v: 1, id: request.id, status: 'accepted', terminalName: tile.name, handledMs: Date.now() });
			} else {
				this.writeConnectorReceipt(connectorId, { v: 1, id: request.id, status: 'rejected', reason: `"${request.terminal}" is no longer a live terminal`, handledMs: Date.now() });
			}
			return;
		}
		const tile = await this.spawnFromName(request.repo, request.base, request.task, request.model ?? undefined, request.effort ?? undefined, request.name ?? undefined);
		if (tile) {
			this.writeConnectorReceipt(connectorId, { v: 1, id: request.id, status: 'accepted', terminalName: tile.name, handledMs: Date.now() });
		} else {
			this.writeConnectorReceipt(connectorId, { v: 1, id: request.id, status: 'rejected', reason: `couldn't spawn in repo "${request.repo}" — see the app's toast for detail`, handledMs: Date.now() });
		}
	}

	/** Write one receipt, temp-then-renamed like every other atomic write in this file. */
	private writeConnectorReceipt(connectorId: string, receipt: ConnectorReceipt): void {
		try {
			const dir = path.join(this.connectorsRootDir(), connectorId, 'receipts');
			fsSync.mkdirSync(dir, { recursive: true });
			const fname = receiptFilename(receipt.id);
			const tmp = path.join(dir, `.${fname}.tmp`);
			fsSync.writeFileSync(tmp, JSON.stringify(receipt), 'utf8');
			fsSync.renameSync(tmp, path.join(dir, fname));
		} catch { /* best effort */ }
	}

	/** Receipts are the connector's to clean up; prune anything older than ~7 days on drain so
	 *  the directory cannot grow forever if a connector never reads them. */
	private pruneConnectorReceipts(connectorId: string): void {
		const dir = path.join(this.connectorsRootDir(), connectorId, 'receipts');
		let files: string[] = [];
		try { files = fsSync.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return; }
		const now = Date.now();
		for (const f of files) {
			const full = path.join(dir, f);
			try {
				const body = JSON.parse(fsSync.readFileSync(full, 'utf8')) as { handledMs?: unknown };
				const handledMs = typeof body.handledMs === 'number' ? body.handledMs : fsSync.statSync(full).mtimeMs;
				if (isReceiptStale(handledMs, now)) fsSync.unlinkSync(full);
			} catch { /* malformed/unreadable receipt — leave it rather than guess */ }
		}
	}

	/** Flip Kane's personality mode (triggered by his `/personality` command). On = inject the
	 *  forge-master persona + start periodic floor pulses; off = revert to the plain overseer
	 *  voice + stop pulses. State is app-side so the pulse cadence is gated cleanly. */
	private togglePersonality(): void {
		this.kanePersonality = !this.kanePersonality;
		if (this.kanePersonality) {
			this.notifyKanes(kanePersonaOn(this.overseerName));
			this.startPulse();
		} else {
			this.notifyKanes(KANE_PERSONA_OFF);
			this.stopPulse();
		}
	}

	/** Begin nudging Kane for a one-line floor pulse on a fixed cadence (only while he's visible —
	 *  no point pulsing a hidden panel). */
	private startPulse(): void {
		if (this.pulseTimer !== null) return;
		this.pulseTimer = window.setInterval(() => {
			if (this.kanePersonality && this.godVisible) this.notifyKanes(KANE_PULSE);
		}, this.pulseMs);
	}

	private stopPulse(): void {
		if (this.pulseTimer !== null) { window.clearInterval(this.pulseTimer); this.pulseTimer = null; }
	}

	/** Leave GOD an error note he can read back. */
	private writeGodInbox(message: string): void {
		try {
			const inbox = path.join(this.coordDir, 'god-inbox');
			fsSync.mkdirSync(inbox, { recursive: true });
			fsSync.writeFileSync(path.join(inbox, `${Date.now()}-error.md`), message + '\n', 'utf8');
		} catch { /* best effort */ }
	}

	/** Center a tile AND give its terminal keyboard focus (so typing goes there). */
	private doCenter(id: number): void {
		// Navigating to a DIFFERENT tile breaks an individual lock (the only way out of it).
		if (this.lockedTileId !== null && this.lockedTileId !== id) { this.lockedTileId = null; this.refreshLockVisuals(); }
		this.centeredId = id;
		this.applyLayout();
		this.focusCentered();
	}

	/** Toggle the individual lock for a tile: pin it to center until you switch terminals. */
	private toggleLockById(id: number): void {
		if (!this.tiles.some((t) => t.tileId === id)) return; // only real terminal tiles
		if (this.lockedTileId === id) { this.lockedTileId = null; this.refreshLockVisuals(); return; }
		this.lockedTileId = id;
		this.refreshLockVisuals();
		this.doCenter(id); // lockedTileId === id, so doCenter won't break it
	}

	private refreshLockVisuals(): void {
		this.tiles.forEach((t) => t.setLocked(t.tileId === this.lockedTileId));
	}

	/** Dim tiles whose name / repo / branch don't match the filter box (empty = all lit). */
	private refreshSearch(): void {
		const q = this.searchQuery;
		for (const t of this.tiles) {
			const hay = `${t.name} ${t.repoName} ${t.branch}`.toLowerCase();
			t.setDimmed(q !== '' && !hay.includes(q));
		}
	}

	/** Focus the centered tile and blur every other one, so a stray keystroke can never
	 *  land on a stale terminal (the root cause of "I typed but the previous one got it"). */
	private focusCentered(): void {
		if (this.centeredId === null) return;
		if (this.chatTile && this.chatTile.tileId === this.centeredId) {
			for (const t of this.tiles) t.blur();
			this.chatTile.focus();
			return;
		}
		const tile = this.tiles.find((t) => t.tileId === this.centeredId);
		if (!tile) return;
		for (const t of this.tiles) if (t.tileId !== this.centeredId) t.blur();
		tile.focus();
	}

	private applyLayout(): void {
		if (!this.stageEl || (this.tiles.length === 0 && !this.chatTile)) return;
		const W = this.stageEl.clientWidth || 800;
		const H = this.stageEl.clientHeight || 500;
		const chatId = this.chatTile?.tileId;
		const ids = [...this.tiles.map((t) => t.tileId), ...(chatId !== undefined ? [chatId] : [])];
		// The chat tile is a normal movable participant — centered only when it IS centeredId.
		const centerId = this.centeredId !== null && ids.includes(this.centeredId) ? this.centeredId : null;
		const rects = centerId !== null ? centeredLayout(ids, W, H, 8, centerId) : settledLayout(ids, W, H, 8);
		for (const t of this.tiles) {
			const r = rects.find((x) => x.id === t.tileId);
			if (r) t.setRect(r);
			t.setCentered(t.tileId === centerId);
		}
		if (this.chatTile && chatId !== undefined) {
			const r = rects.find((x) => x.id === chatId);
			if (r) this.chatTile.setRect(r);
			this.chatTile.setCentered(chatId === centerId);
		}
		if (this.stageEl.classList.contains('alt-on')) this.refreshBadges();
		if (this.searchQuery) this.refreshSearch(); // keep newly-laid-out tiles consistent with the filter
	}

	private setMaximized(on: boolean): void {
		this.maximized = on;
		this.stageEl?.toggleClass('cos-terminals-max', on);
		this.maxBtn?.setText(on ? '⛶ Restore' : '⛶ Maximize');
		window.setTimeout(() => { this.applyMaximizeChrome(); this.applyLayout(); }, 40);
	}

	/** Keep the controls bar (dropdown, Play, View Code, …) visible above the fullscreen
	 *  stage when maximized, and push the stage down by the bar's height so they don't overlap. */
	private applyMaximizeChrome(): void {
		this.controlsEl?.toggleClass('cos-controls-max', this.maximized);
		if (this.stageEl) this.stageEl.style.top = this.maximized && this.controlsEl ? `${this.controlsEl.offsetHeight}px` : '';
	}

	/** The tile currently in the center (if any). */
	private centeredTile(): StageTile | undefined {
		return this.centeredId === null ? undefined : this.tiles.find((t) => t.tileId === this.centeredId);
	}

	/** A visible tile's state for the spotlight decision. A permission prompt / selection menu
	 *  is "waiting for you" even mid-turn; a settled-but-errored tile outranks a clean idle one.
	 *  Anything still streaming output is `thinking` and never grabs the center on its own.
	 *  (`errored` is gated behind idle so a streaming tile that merely prints the word "error"
	 *  can't steal focus.) */
	private spotlightState(t: StageTile): SpotlightState {
		if (t.isJournal) return 'thinking'; // journals never auto-grab the spotlight; centered only on click
		const o = t.recentOutput();
		if (looksLikePrompt(o)) return 'prompt';
		if (looksLikeMenu(o)) return 'menu';
		// A tile that's actively working ("esc to interrupt" showing) is thinking, even if its
		// idle flag drifted stale — a cos-coord tell / auto-continue starts a turn without the
		// in-app Enter that would otherwise mark it busy.
		const idle = this.idleTiles.has(t.tileId) && !looksBusy(o);
		if (idle && looksErrored(o)) return 'errored';
		return idle ? 'idle' : 'thinking';
	}

	/** Re-derive the spotlight from the floor's CURRENT state and apply it. The single funnel
	 *  every auto (non-click) path runs through, so the center can't get stranded on a thinking
	 *  tile: a tile that needs you wins, and when everyone is thinking the grid drops to equal
	 *  size (no spotlight). Manual clicks/cycles still set the center directly. */
	private autoCenter(): void {
		this.updateAttention(); // markers + notifications refresh every tick, regardless of centering
		if (Date.now() < this.holdUntil) return; // manual-switch hold — the user chose a tile, let it be
		const want = decideCenter({
			tiles: this.tiles.map((t) => ({ id: t.tileId, state: this.spotlightState(t) })),
			centeredId: this.centeredId,
			readyOrder: this.q.queue,
			pinnedId: this.q.pinnedId,
			userTyping: this.q.composingLen > 0 || this.focusedKane !== null,
			globalLock: this.locked,
			lockedTileId: this.lockedTileId,
		});
		if (want === this.centeredId) return;          // no change → don't re-lay-out (avoids flicker)
		if (want === null) { this.centeredId = null; this.applyLayout(); return; } // equal grid
		this.doCenter(want);
	}

	/** Refresh the per-tab attention markers and fire a one-shot notification whenever a tab (or
	 *  Alpha) transitions into needing you — distinct markers/toasts for input, help, and done.
	 *  Runs every autoCenter tick (~1s). De-duped through `lastAttn` so a persistent state is
	 *  flagged once, not every tick; first sighting seeds silently so a restore doesn't spam. */
	private updateAttention(): void {
		const seen = new Set<number>();
		// Visible worker tabs: full input / help / done markers.
		for (const t of this.tiles) {
			seen.add(t.tileId);
			const o = t.recentOutput();
			const idle = this.idleTiles.has(t.tileId) && !looksBusy(o);
			const kind = t.isJournal ? null : attentionKind(classifyOne(o, idle));
			t.setAttention(kind);
			this.noteAttention(t.tileId, kind, t.name);
		}
		// Alpha (the overseer console): input / help only — it's never "done" like a worker.
		if (this.godConsole) {
			seen.add(-1);
			const ko = this.godConsole.recentOutput();
			let kind = attentionKind(classifyOne(ko, false)); // idle=false → never 'done'
			if (kind === 'done') kind = null;
			this.godBtn?.setAttribute('data-attn', kind ?? '');
			this.noteAttention(-1, kind, this.overseerName);
		} else {
			this.godBtn?.setAttribute('data-attn', '');
		}
		// Forget tabs that have gone away, so a reused id can notify again.
		for (const id of [...this.lastAttn.keys()]) if (!seen.has(id)) this.lastAttn.delete(id);
	}

	/** Record a tab's current bucket; toast when it CHANGES into a flagging bucket. */
	private noteAttention(id: number, kind: AttentionKind | null, name: string): void {
		const now = kind ?? 'none';
		const prev = this.lastAttn.get(id);
		this.lastAttn.set(id, now);
		if (prev === undefined || prev === now || !kind) return; // seed silently / unchanged / cleared
		const MSG: Record<AttentionKind, string> = {
			input: `⏳ ${name} needs your input`,
			help: `🆘 ${name} needs help`,
			done: `✓ ${name} finished`,
		};
		this.deps.toast(MSG[kind], kind);
	}

	private handleReady(t: TerminalTile): void {
		// Fire any one-shot watch whose target just finished — idle and NOT stalled on a prompt.
		if (this.watchers.some((w) => w.target === t.name)) {
			const out = t.recentOutput();
			if (!looksLikePrompt(out) && !looksLikeMenu(out)) {
				const fired = this.watchers.filter((w) => w.target === t.name);
				this.watchers = this.watchers.filter((w) => w.target !== t.name);
				for (const w of fired) this.notifyKanes(`[watch] terminal "${t.name}" finished — you asked: ${w.note}`);
			}
		}
		// Deliver an Kane-spawned terminal's initial task once it's first ready.
		const task = this.pendingTask.get(t.tileId);
		if (task !== undefined) { this.pendingTask.delete(t.tileId); t.sendLine(task); }

		// A tile ALREADY idle firing ready again is a RE-FIRE (Claude's periodic waiting-for-input
		// notification re-creates the marker), not a fresh finish. It must never resurrect the
		// queue or steal — dismissed idle tiles re-queueing themselves made the floor "fly around
		// focusing and unfocusing" with zero user input (2026-07-27).
		const wasAlreadyIdle = this.idleTiles.has(t.tileId);
		this.idleTiles.add(t.tileId); // finished a turn → idle/done (also covers hidden background tiles)

		if (this.hidden.includes(t)) return; // a hidden, background session never steals the center
		if (this.chatRoom) { this.chatRoom.noteIdle(t.name); return; } // chat owns idle while open
		if (wasAlreadyIdle) return; // re-fire: no queue change, no steal, no re-derive
		const r = rqReady(this.q, t.tileId); // joins the BACK of the FIFO queue
		this.q = r.state;
		// Steal (event-driven, less obtrusive): a FRESH finisher may take the center, but only
		// when you're hands-off — recent typing/clicks (grace window), locks, a centered menu,
		// or Kane focus mean it just queues (and pulses) instead of yanking the view. Its FIFO
		// position is unchanged either way; Enter always serves the longest-waiting next.
		const curTile = this.tiles.find((x) => x.tileId === this.centeredId);
		const engaged = this.q.composingLen > 0 || this.focusedKane !== null
			|| Date.now() - this.lastActivityAt < STEAL_GRACE_MS
			|| Date.now() < this.holdUntil
			|| this.locked || this.lockedTileId !== null
			|| (curTile !== undefined && this.spotlightState(curTile) === 'menu');
		if (r.added && !engaged && t.tileId !== this.centeredId) {
			this.q = { ...this.q, pinnedId: null }; // a steal supersedes a manual pin
			this.doCenter(t.tileId);
			return;
		}
		this.autoCenter();
	}

	private handleSubmit(t: TerminalTile): void {
		this.idleTiles.delete(t.tileId); // submitting → busy again
		if (this.hidden.includes(t)) return; // background sessions don't drive centering
		// Auto-lock: an Enter inside an on-screen selection menu is toggling an option, NOT
		// submitting a prompt — don't bubble focus away, so a multi-select can be finished in one
		// go. (The Lock button does this globally; this does it automatically for menus.)
		if (looksLikeMenu(t.recentOutput())) return;
		this.holdUntil = 0; // prompt submitted — manual engagement over, the flow resumes
		this.lastActivityAt = Date.now(); // an Enter is activity — no steal right on its heels
		this.q = rqSubmit(this.q, t.tileId).state; // finished with it → out of the queue
		// Re-derive: center the next tile that needs you, or drop to the equal grid if everyone
		// is now thinking (nobody is waiting on you).
		this.autoCenter();
	}

	/** Hide a tile: pull it off the stage but keep its session + worktree alive.
	 *  Resurface later with showTile() from the Coordination panel. */
	private hideTile(tile: StageTile): void {
		if (!this.tiles.includes(tile)) return;
		if (this.lockedTileId === tile.tileId) { this.lockedTileId = null; tile.setLocked(false); }
		const wasCentered = this.centeredId === tile.tileId;
		this.tiles = this.tiles.filter((x) => x !== tile);
		this.hidden.push(tile);
		tile.setHidden(true);
		tile.setSelected(false);          // a hidden tile is never a chat member
		this.updateChatBtn();
		this.q = rqClose(this.q, tile.tileId).state; // drop from the ready-queue
		if (wasCentered) this.centeredId = null;
		this.applyLayout();
		this.autoCenter(); // serve the queue front (or drop to the equal grid)
		void this.persist();
		this.board?.refresh();
	}

	/** Resurface a hidden tile: put it back on the stage, centered + focused. */
	private showTile(tileId: number): void {
		const tile = this.hidden.find((t) => t.tileId === tileId);
		if (!tile) return;
		this.hidden = this.hidden.filter((t) => t !== tile);
		this.tiles.push(tile);
		tile.setHidden(false);
		this.idleTiles.delete(tile.tileId); // resurfaced → you're acting on it, not "done waiting"
		this.centeredId = tile.tileId;
		this.applyLayout();
		this.focusCentered();
		this.holdUntil = Date.now() + MANUAL_HOLD_MS; // resurfacing is an explicit choice too
		void this.persist();
		this.board?.refresh();
	}

	/** Close a hidden tile from the Coordination panel: confirm, then kill its session and
	 *  remove the worktree + branch (same as the tile ×), and drop it from the hidden list. */
	private async closeHiddenTile(tileId: number): Promise<void> {
		const tile = this.hidden.find((t) => t.tileId === tileId);
		if (!tile) return;
		// A folder target has no worktree/branch to remove, so promising to delete one would be
		// both wrong and alarming — say what actually happens instead.
		const isFolder = !tile.isJournal && (tile as TerminalTile).isFolder;
		const ok = await promptForConfirm(
			`Close "${tile.name}"?`,
			isFolder
				? 'This kills the session. The folder and its files are left alone.'
				: `This kills the session and removes its worktree + branch (${tile.branch}). It can't be undone.`,
			'Close',
		);
		if (!ok) return;
		this.hidden = this.hidden.filter((t) => t !== tile);
		this.idleTiles.delete(tile.tileId);
		if (this.lockedTileId === tile.tileId) this.lockedTileId = null;
		if (tile.isJournal) { tile.kill(); }
		else { await (tile as TerminalTile).close(); } // kill + removeWorktreeAndBranch + fires onClosed
		void this.persist();
		this.board?.refresh();
	}

	/** Build a tile with all the grid callbacks wired. `resume` → claude --continue.
	 *  `folder` → a plain-folder target (no worktree, no branch). */
	private makeTile(worktree: WorktreeInfo, repoName: string, repoPath: string, baseBranch: string, resume: boolean, name?: string, model?: string, effort?: string, folder?: boolean): TerminalTile {
		return new TerminalTile({
			tileId: this.nextTileId++,
			repoName, repoPath, baseBranch, worktree, folder,
			sidecarPath: this.sidecarPath,
			coordDir: this.coordDir,
			roleLibraryPath: this.deps.roleLibrary?.path,
			sessionEnv: this.deps.sessionEnv,
			resume,
			bypassPermissions: this.deps.bypassPermissions,
			model,
			effort,
			name,
			onRename: () => { void this.persist(); },
			onRequestRename: (t, cur) => {
				void this.deps.promptForTopic('Rename terminal', 'New name', cur, 'Rename').then((name) => { if (name && name.trim()) t.setName(name.trim()); });
			},
			onClosed: (t) => { this.idleTiles.delete(t.tileId); if (this.lockedTileId === t.tileId) this.lockedTileId = null; if (this.centeredId === t.tileId) this.centeredId = null; this.q = rqClose(this.q, t.tileId).state; this.tiles = this.tiles.filter((x) => x !== t); void this.persist(); this.applyLayout(); this.autoCenter(); },
			onHide: (t) => this.hideTile(t),
			onLock: (t) => this.toggleLockById(t.tileId),
			onCenter: (t) => this.handleClick(t.tileId),
			onReady: (t) => this.handleReady(t),
			// A restored tile whose transcript is gone comes back as a blank welcome screen that
			// looks exactly like a broken start. Say so where the new session can't paint over it.
			onFreshFallback: (t) => this.deps.toast(`${t.name} — no saved conversation to resume, so it started fresh`, 'warn'),
			onInput: (t, data) => { this.idleTiles.delete(t.tileId); this.lastActivityAt = Date.now(); this.q.composingLen = applyKeystroke(this.q.composingLen, data); },
			onEnter: (t) => this.handleSubmit(t),
			// Reset the typing-hold on ANY focus change: gaining focus starts a fresh box,
			// and leaving a terminal means you're no longer typing — so finished terminals
			// should resume shifting instead of being held forever.
			onFocusChange: () => { this.q.composingLen = 0; },
		});
	}

	/** Names of the .god/* home directories that exist on disk, across every group. Best effort:
	 *  no directory yet, or an unreadable one, just means there is nothing extra to claim. */
	private async readGodDirNames(): Promise<string[]> {
		try { return await fs.readdir(path.join(this.coordDir, '..', '.god')); } catch { return []; }
	}

	private async readAllSessions(): Promise<Record<string, SessionRecord[]>> {
		try { return JSON.parse(await fs.readFile(this.sessionsFile, 'utf8')) as Record<string, SessionRecord[]>; } catch { return {}; }
	}

	/** Records that could not be reopened at launch (worktree path unreachable, or the
	 *  restore of that one record threw). They stay in the sessions file and retry on the
	 *  next launch — a transiently unavailable path (moved repo, unmounted drive, slow
	 *  OneDrive) must never DELETE session history. */
	private unrestored: SessionRecord[] = [];

	/** All persists in this renderer — every grid — go through ONE chain. Concurrent
	 *  fire-and-forget persists used to race on the shared file, and a STALE snapshot
	 *  could land last: toggleGod()'s persist fires mid-restore, before the hidden tiles
	 *  exist, and when its write finished after the final restore persist it rewrote the
	 *  group as just [god] — which is how CARDTSAR lost every terminal record
	 *  (2026-07-30). Chaining serializes the read-modify-write AND defers the state
	 *  snapshot to write time, so the last queued persist wins with the newest state. */
	private static persistChain: Promise<void> = Promise.resolve();

	/** Persist THIS group's currently-open sessions (called on play + on close). */
	private persist(): Promise<void> {
		const run = TerminalsGrid.persistChain.then(() => this.persistNow()).catch(() => { /* best effort */ });
		TerminalsGrid.persistChain = run;
		return run;
	}

	/** Drop a workspace's session bucket when its tab is closed. Closing a workspace removed the
	 *  tab but left its records in the sessions file forever — the live file still carries a
	 *  `test-2` bucket for a tab deleted weeks ago. Goes through the same chain as every other
	 *  write so it can never race a grid's persist. */
	static forgetGroup(sessionsFile: string, group: string): Promise<void> {
		const run = TerminalsGrid.persistChain.then(async () => {
			let all: Record<string, unknown>;
			try { all = JSON.parse(await fs.readFile(sessionsFile, 'utf8')) as Record<string, unknown>; } catch { return; }
			if (!(group in all)) return;
			delete all[group];
			try { await fs.writeFile(sessionsFile, JSON.stringify(all, null, 2), 'utf8'); } catch { /* best effort */ }
		}).catch(() => { /* best effort */ });
		TerminalsGrid.persistChain = run;
		return run;
	}

	private async persistNow(): Promise<void> {
		const all = await this.readAllSessions();
		const serializeTile = (t: StageTile, hidden: boolean): SessionRecord => {
			if (t.isJournal) {
				return { kind: 'journal', name: t.name, journalSlug: (t as JournalTile).journalSlug, hidden, worktreePath: '', branch: '', repoName: 'journal', repoPath: '', baseBranch: '' };
			}
			return { kind: 'terminal', ...(t as TerminalTile).sessionRecord(), hidden };
		};
		// Retained unrestored records — minus any worktree the user has since reopened
		// as a live tile (the live tile's record supersedes the stale one).
		const liveWts = new Set([...this.tiles, ...this.hidden].filter((t) => !t.isJournal).map((t) => (t as TerminalTile).worktreePath));
		// A god record whose console is live gets re-emitted below from live state; retaining it as
		// well would restore that same console twice on the next launch.
		const liveGods = new Set<number>([...(this.godConsole ? [PRIMARY_GOD_INDEX] : []), ...this.extraKanes.map((k) => k.n)]);
		const retained = this.unrestored.filter((r) => r.kind === 'god'
			? !liveGods.has(godIndexOf(r))
			: r.kind === 'journal' || !liveWts.has(r.worktreePath));
		all[this.deps.group] = [
			...this.tiles.map((t) => serializeTile(t, false)),
			...this.hidden.map((t) => serializeTile(t, true)),
			...retained,
			// Kane persists like the tiles (2026-07-24): once opened he comes back on the next
			// launch, resumed with --continue. /clear inside his session is the fresh-start path.
			// Every 🜲+ duplicate persists the same way, tagged with its instance number; the
			// primary stays untagged so an older build still reads the file and reopens it.
			...(godRecords(!!this.godConsole, this.extraKanes.map((k) => k.n)) as SessionRecord[]),
		];
		try { await fs.writeFile(this.sessionsFile, JSON.stringify(all, null, 2), 'utf8'); } catch { /* best effort */ }
	}

	/** On open: re-create a tile (claude --continue) for each persisted worktree that still exists. */
	private async restoreSessions(): Promise<void> {
		const all = await this.readAllSessions();
		const recs = all[this.deps.group] ?? [];
		// Claim every instance number already used — by a record or by a .god home on disk — before
		// anything can add a duplicate, so a new one never lands on a live transcript.
		this.kaneSeq = Math.max(this.kaneSeq, highestGodIndex(recs, await this.readGodDirNames(), this.deps.group));
		const { visible, hidden } = partitionByHidden(recs);
		for (const rec of [...visible, ...hidden]) {
			try {
				await this.restoreRecord(rec);
			} catch (e) {
				// One bad record must not abort the loop — the remaining records still
				// restore, and the healing persist below still runs. Keep the failed
				// record for the next launch instead of losing it.
				this.unrestored.push(rec);
				console.warn('[grid] session restore failed for record, retained', rec.worktreePath || rec.kind, e);
			}
		}
		await this.persist(); // heal the file: live tiles + retained unrestored records
		this.applyLayout();
	}

	/** Restore ONE persisted record into a live tile/console. Throws → caller retains it. */
	private async restoreRecord(rec: SessionRecord): Promise<void> {
		{
			if (rec.kind === 'god') {
				// No godIndex — which is every record written before duplicates were persisted —
				// reads as the primary, so existing sessions restore exactly as they did.
				if (godIndexOf(rec) === PRIMARY_GOD_INDEX) { if (!this.godConsole) this.toggleGod(); } // opens + resumes (resume: true in toggleGod)
				else this.addKane(godIndexOf(rec)); // duplicate: --continue-s its own .god/<group>-N
				return;
			}
			if (rec.kind === 'journal') {
				const doc = rec.journalSlug ? this.journalStore.load(rec.journalSlug) : null;
				const tile = new JournalTile({
					tileId: this.nextTileId++, name: rec.name ?? 'Journal', store: this.journalStore,
					slug: rec.journalSlug, initialText: doc?.text ?? '', toast: this.deps.toast,
					onClosed: (t) => { if (this.centeredId === t.tileId) this.centeredId = null; this.q = rqClose(this.q, t.tileId).state; this.tiles = this.tiles.filter((x) => x !== t); t.kill(); void this.persist(); this.applyLayout(); this.autoCenter(); },
					onHide: (t) => this.hideTile(t), onLock: (t) => this.toggleLockById(t.tileId),
					onCenter: (t) => this.handleClick(t.tileId),
					onRequestRename: (t, cur) => { void this.deps.promptForTopic('Rename journal', 'New name', cur, 'Rename').then((n) => { if (n && n.trim()) { t.setName(n.trim()); void this.persist(); } }); },
					onRename: () => { void this.persist(); },
					onFormat: (text) => this.formatProbe.format(text),
					onGetDestinations: () => this.getConvertDestinations(),
					onConvertPropose: (text) => this.convertProbe.propose(text),
					onConvertCreate: (issues, dest) => this.convertProbe.create(issues, dest),
					onConvertSaveToVault: (dest, title, body) => this.saveToVault(dest, title, body),
					onOpenSettings: () => this.deps.openSettings(),
				});
				if (this.stageEl) tile.render(this.stageEl);
				if (rec.hidden) { tile.setHidden(true); this.hidden.push(tile); } else { this.tiles.push(tile); }
				return; // skip the terminal path for this record
			}
			let exists = false;
			try { await fs.access(rec.worktreePath); exists = true; } catch { exists = false; }
			if (!exists) { this.unrestored.push(rec); return; } // retained — retried next launch
			const tile = this.makeTile({ worktreePath: rec.worktreePath, branch: rec.branch }, rec.repoName, rec.repoPath, rec.baseBranch, true, rec.name, rec.model, rec.effort, rec.folder);
			if (this.stageEl) tile.render(this.stageEl);
			if (rec.hidden) { tile.setHidden(true); this.hidden.push(tile); }
			else this.tiles.push(tile);
		}
	}

	/** Full teardown (view close): unmount + kill all sessions. */
	dispose(): void {
		this.unmount();
		this.stageResizeObs?.disconnect(); this.stageResizeObs = null;
		this.board = null;
		this.stopPulse();
		this.stopFloorFeed(); // feed now persists across unmount()/hideGod(), so stop it on real teardown
		this.godConsole?.dispose(); this.godConsole = null;
		for (const k of this.extraKanes) k.console.dispose();
		this.extraKanes = [];
		for (const t of this.tiles) t.kill();
		for (const t of this.hidden) t.kill();
		this.tiles = [];
		this.hidden = [];
		this.stageEl = null;
		this.stageWrapEl = null;
	}

	/** Park every dirty worktree of every live tile (plugin unload: accidental teardown / reload).
	 *  Called from the plugin's onunload — NOT from unmount(), which is a tab-switch that keeps
	 *  sessions + their live agents running. */
	public async parkAll(): Promise<void> {
		const iso = new Date().toISOString();
		for (const t of [...this.tiles, ...this.hidden]) {
			if (t.isJournal) continue; // journals have no worktree to park
			const tt = t as TerminalTile;
			// A folder target has no branch of its own. If it happens to sit inside somebody's
			// repo, parking would `git add -A` + commit THEIR working tree — never do that.
			if (tt.isFolder) continue;
			try {
				const action = await parkWorktree(tt.worktreePath, iso);
				if (action === 'parked') {
					await fs.appendFile(path.join(this.coordDir, 'board.md'),
						`${Date.now()}\t${tt.name}\t-\tNOTE\tauto-parked on teardown\n`, 'utf8').catch(() => {});
				}
			} catch { /* never block teardown */ }
		}
	}

	private registryPath(): string { return path.join(this.coordDir, 'worktrees.md'); }

	/** Scan every added repo's worktrees, map ownership from live tiles, write worktrees.md.
	 *  Best-effort: any git failure degrades that entry and never throws. */
	private async scanWorktrees(): Promise<void> {
		this.lastScanAt = Date.now();
		const entries: WorktreeEntry[] = [];
		const now = Date.now();
		for (const repo of this.repos) {
			if (repo.folder) continue; // no git → no worktrees to list, and nothing to exclude
			if (!this.claudeSettingsIgnoredFor.has(repo.path)) {
				this.claudeSettingsIgnoredFor.add(repo.path);
				await ensureClaudeSettingsIgnored(repo.path); // before git status below, so this scan already reflects it
			}
			const wl = await runCommand('git', ['worktree', 'list', '--porcelain'], { cwd: repo.path, timeoutMs: 8000 });
			if (wl.code !== 0) continue;
			for (const wt of parseWorktreeList(wl.stdout)) {
				if (path.resolve(wt.path) === path.resolve(repo.path)) continue; // skip the primary checkout
				const status = await runCommand('git', ['status', '--porcelain'], { cwd: wt.path, timeoutMs: 8000 });
				const tile = ([...this.tiles, ...this.hidden].filter((t) => !t.isJournal) as TerminalTile[]).find((t) => path.resolve(t.worktreePath) === path.resolve(wt.path));
				const baseRef = tile ? tile.baseBranch : this.baseOf(wt.branch);
				const ab = await runCommand('git', ['rev-list', '--left-right', '--count', `${baseRef}...HEAD`], { cwd: wt.path, timeoutMs: 8000 });
				const subj = await runCommand('git', ['log', '-1', '--pretty=%s'], { cwd: wt.path, timeoutMs: 8000 });
				const counts = parseAheadBehind(ab.code === 0 ? ab.stdout : '');
				entries.push({
					repo: repo.name, branch: wt.branch, path: wt.path,
					terminal: tile ? tile.name : null,
					dirtyFiles: status.code === 0 ? parseStatusPorcelain(status.stdout) : [],
					ahead: counts.ahead, behind: counts.behind,
					parked: subj.code === 0 ? isParkCommitSubject(subj.stdout.trim()) : false,
					lastActivity: now,
				});
			}
		}
		this.lastEntries = entries; // persisted so Reopen (Task 11) can resolve repo+path by branch
		try {
			await fs.mkdir(this.coordDir, { recursive: true });
			await fs.writeFile(this.registryPath(), formatRegistryMarkdown(entries, now), 'utf8');
		} catch { /* best effort */ }
	}

	/** The base branch a wt/<base>-N was cut from, for ahead/behind. Falls back to 'HEAD~0'
	 *  semantics by comparing against the repo's default branch name embedded in the slug. */
	private baseOf(branch: string): string {
		const m = branch.match(/^wt\/(.+)-\d+$/);
		return m ? m[1]! : branch;
	}

	/** Un-park a parked worktree (soft-reset / recreate folder) and attach a new tile for it. */
	private async reopenAndOpen(branch: string): Promise<void> {
		const entry = this.lastEntries.find((e) => e.branch === branch);
		if (!entry) { this.deps.toast(`No scanned worktree for ${branch} — hit Refresh`, 'warn'); return; }
		const repo = this.repos.find((r) => r.name === entry.repo);
		if (!repo) return;
		// Skip if a tile is already attached to this worktree.
		if (this.tiles.some((t) => !t.isJournal && path.resolve((t as TerminalTile).worktreePath) === path.resolve(entry.path))) return;
		await reopenWorktree(repo.path, entry.path, branch);
		const tile = this.makeTile({ worktreePath: entry.path, branch }, repo.name, repo.path, this.baseOf(branch), false);
		if (this.stageEl) tile.render(this.stageEl);
		this.tiles.push(tile);
		this.centeredId = tile.tileId;
		this.applyLayout();
		void this.scanWorktrees().then(() => this.board?.refresh());
	}
}
