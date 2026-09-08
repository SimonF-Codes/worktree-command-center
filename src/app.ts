import { installDomShim } from './ui/dom-shim';
import { toast } from './ui/toast';
import { promptForTopic, promptForConfirm, promptForChoice } from './ui/prompt-dialog';
import { TerminalsGrid, type GridDeps, type RepoConfig } from './terminals/terminals-grid';
import { parseGodSelfImprove } from './terminals/god';
import { parseRoleLibrary } from './terminals/role-library';
import { parseConnectors } from './terminals/connectors';
import { discoverRepos, mergeRepos, reposForWorkspace } from './workspace';
import { SerialWriter } from './serial-writer';
import { normalizeToolbars, setToolbarState, pruneToolbars, type WorkspaceToolbars } from './terminals/toolbar-state';
import { createGitRepo } from './create-repo';
import { UsageProbe } from './terminals/usage-probe';
import { UsageWidget } from './ui/usage-widget';
import { ClaudeWarning } from './ui/claude-warning';
import { PerfMonitor } from './ui/perf-monitor';
import { AttentionWidget } from './ui/attention-widget';
import { WorkspaceBar } from './ui/workspace-bar';
import { SettingsPanel } from './ui/settings-panel';
import { ChangelogPanel } from './ui/changelog-panel';
import { RolesView } from './ui/roles-view';
import { CUSTODIAN_SLUG } from './terminals/role-view-loader';
import { normalizeWorkspaces, addWorkspace, closeWorkspace, nextActiveAfter, type Workspace } from './terminals/workspace-store';
import { pickCloseRecords, summarizeClose, riskProbeTargets, buildCloseConfirm } from './terminals/close-summary';
import { probeWorktreeRisks } from './terminals/close-risk';
import {
	normalizeClosedWorkspaces, archiveWorkspace, archiveSessionsKey, takeClosedWorkspace, insertAt,
	type ClosedWorkspace,
} from './terminals/closed-workspaces';
import { uniqueId } from './terminals/workspace-store';
import { relAge } from './terminals/worktree-registry';
import { THEMES, normalizeTheme, setActiveTheme, activeTerminalPalette } from './terminals/theme-store';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { registerPrivateFeatures } from 'wcc-private';
import type { SessionEnvProvider } from './private-api';

declare global {
	interface Window {
		wcc: {
			paths(): Promise<{ sidecarDir: string; userData: string; appRoot: string; version: string; isDev: boolean }>;
			checkClaude(): Promise<{ found: boolean; path: string | null }>;
			clipboardRead(): Promise<string>;
			clipboardWrite(text: string): Promise<boolean>;
			getConfig(): Promise<any>;
			setConfig(c: any): Promise<boolean>;
			addFolder(): Promise<string | null>;
			newRepoLocation(): Promise<string | null>;
			pushFloorState(s: unknown): void;
			onRemoteAction(cb: (a: { type: string; id?: number; repo?: string; base?: string | null; task?: string }) => void): void;
			remoteInfo(): Promise<{ token: string; port: number; urls: string[] }>;
			onShellDigit(cb: (n: number) => void): void;
		};
	}
}

let repos: RepoConfig[] = [];

/** How long the close toast keeps its Undo on screen. Longer than an info toast: the offer has
 *  to survive noticing it and reaching for the mouse. Hovering holds it open indefinitely. */
const UNDO_TOAST_MS = 9000;

async function main(): Promise<void> {
	try {
		installDomShim();

		const { sidecarDir, userData, appRoot, version, isDev } = await window.wcc.paths();
		const cfg = await window.wcc.getConfig();

		// Renderer-aging telemetry (perf-log.jsonl in userData) — long-lived instances degrade;
		// this gives the next investigation data instead of guesses.
		const perfMon = new PerfMonitor(path.join(userData, 'perf-log.jsonl'));
		perfMon.begin();
		window.addEventListener('beforeunload', () => perfMon.dispose());
		repos = Array.isArray(cfg.repos) ? cfg.repos : [];

		// Shell theme (2026-07-24 themes spec): applied before any UI builds so the first
		// paint is already themed. 'default' = the :root palette, no attribute needed either
		// way but setting it keeps the switcher and DOM state in lockstep.
		let themeId = normalizeTheme(cfg.theme);
		document.documentElement.dataset.theme = themeId;
		setActiveTheme(themeId); // terminals created from here on take the theme's well palette

		const appEl = document.getElementById('app')!;

		// --- shell slots: generic mount points for the private overlay's portal surfaces
		// (PrivateApi.shellHosts) — `stripHost` above the whole terminal UI, `viewsHost`
		// beneath it. The terminal surface lives in terminalRoot as one swappable unit;
		// both slot divs stay empty unless an overlay populates them. ---
		const stripHost = appEl.createDiv();
		const terminalRoot = appEl.createDiv({ cls: 'wcc-terminal-root' });
		const viewsHost = appEl.createDiv();

		// --- top bar (persistent above the tabs + grid; never wiped by grid.mount()) ---
		const topBar = terminalRoot.createDiv({ cls: 'wcc-topbar' });
		topBar.createSpan({ cls: 'wcc-brand', text: '🌳 Worktree Command Center' });
		// DEV badge: both builds share one profile (same repos/workspaces/sessions), so without a
		// marker it's impossible to tell which one you're typing into. Dev only.
		if (isDev) topBar.createSpan({ cls: 'wcc-devbadge', text: 'DEV', attr: { title: 'Running the dev build from source (npm start) — same profile as the installed app' } });
		const addFolderBtn = topBar.createEl('button', { cls: 'wcc-add', text: '➕ Add folder' });
		const newRepoBtn = topBar.createEl('button', { cls: 'wcc-add', text: '🆕 New repo' });
		const statusSpan = topBar.createSpan({ cls: 'wcc-status', text: `${repos.length} repos` });

		// Theme switcher: applies instantly, persists via the merge below.
		const themeSel = topBar.createEl('select', { cls: 'wcc-theme-sel', attr: { title: 'Shell theme' } });
		for (const t of THEMES) themeSel.createEl('option', { text: t.label, value: t.id });
		themeSel.value = themeId;
		themeSel.addEventListener('change', () => {
			themeId = normalizeTheme(themeSel.value);
			document.documentElement.dataset.theme = themeId;
			setActiveTheme(themeId);
			// Re-tint every live terminal well in every workspace (new ones self-apply).
			const palette = activeTerminalPalette();
			for (const g of grids.values()) g.applyTerminalPalette(palette);
			persist();
		});

		// Missing-`claude` banner: a full-width strip directly under the top bar. Every terminal
		// and the usage battery spawn `claude` via the sidecar, so if it isn't on PATH the app
		// silently does nothing useful — this makes the cause obvious and offers a recheck.
		// Lives in terminalRoot (beneath topBar, above the tabs) so the overlay shell's
		// stripHost/viewsHost slots don't push it away from the bar it explains.
		const claudeWarnHost = terminalRoot.createDiv({ cls: 'wcc-claude-warn-host' });
		const claudeWarning = new ClaudeWarning(() => window.wcc.checkClaude());
		claudeWarning.render(claudeWarnHost);
		void claudeWarning.refresh();

		// --- workspaces ---
		let workspaces: Workspace[] = normalizeWorkspaces(cfg.workspaces);
		// Per-tab spawn-toolbar selection (toolbar-state.ts). Pruned to live workspaces on load so
		// a config that accumulated entries for deleted tabs cleans itself up.
		let workspaceToolbars: WorkspaceToolbars = pruneToolbars(normalizeToolbars(cfg.workspaceToolbars), workspaces.map((w) => w.id));
		// Tombstones for closed tabs (closed-workspaces.ts). Capped, most recent first; each one
		// points at the tiles it left behind in .terminal-sessions.json under a `closed:` key.
		let closedWorkspaces: ClosedWorkspace[] = normalizeClosedWorkspaces(cfg.closedWorkspaces);
		let activeId = workspaces.some((w) => w.id === cfg.activeWorkspace) ? (cfg.activeWorkspace as string) : workspaces[0]!.id;
		const grids = new Map<string, TerminalsGrid>();

		// Session-env provider (see docs/superpowers/specs/2026-07-13-session-env-provider-design.md).
		// Overlay-replaceable; consulted lazily at each spawn through safeSessionEnv at the call sites.
		let sessionEnvProvider: SessionEnvProvider = () => ({});
		const wsSwitchCbs: Array<(id: string) => void> = [];

		// Usage battery (follows the ACTIVE workspace's session env; restartable by the overlay).
		const usageHost = topBar.createDiv({ cls: 'wcc-usage-host' });
		let usageProbe: UsageProbe | null = null;
		let usageWidget: UsageWidget | null = null;
		const startUsageProbe = (): void => {
			usageWidget?.dispose(); usageProbe?.dispose();
			usageHost.empty();
			// Dedicated cwd: the probe spawns a session per refresh, and those must not litter a
			// real repo's `claude --resume` history (the old repos[0] cwd did exactly that).
			const probeCwd = path.join(userData, 'usage-probe');
			try { fs.mkdirSync(probeCwd, { recursive: true }); } catch { /* best effort */ }
			usageProbe = new UsageProbe({
				sidecarPath: path.join(sidecarDir, 'sidecar.cjs'),
				cwd: probeCwd,
				sessionEnv: () => sessionEnvProvider({ workspaceId: activeId }),
			});
			usageWidget = new UsageWidget(usageProbe);
			usageWidget.render(usageHost);
		};
		startUsageProbe();
		window.addEventListener('beforeunload', () => { usageWidget?.dispose(); usageProbe?.dispose(); });

		// Kane self-improvement (see docs/superpowers/specs/2026-07-15-kane-self-improvement-design.md):
		// config names the app's own source repo; toolsDir defaults beside the user's home.
		const siCfg = parseGodSelfImprove(cfg.god);
		const godSelfImprove = siCfg ? { sourceRepo: siCfg.sourceRepo, toolsDir: siCfg.toolsDir ?? path.join(os.homedir(), 'kane-tools') } : undefined;

		// Connectors registered for the external request/receipt channel (see README "External
		// dispatch"). App-wide, like repos — every workspace's grid gets the same list.
		const connectors = parseConnectors(cfg.connectors);

		// Agent role files (see the vault's _meta/agents/Charter.md): when config.json names a
		// folder, each session's system prompt comes from the role file there instead of the
		// compiled-in builder. Absent key = built-ins, which is every existing config.
		const roleLibrary = parseRoleLibrary(cfg.roleLibrary);

		const sessionsFile = path.join(userData, '.terminal-sessions.json');
		const depsFor = (id: string): GridDeps => ({
			// Scoped, not the whole list: a repo tagged with a `group` belongs to that workspace
			// alone. Untagged repos (every existing config) still appear everywhere.
			repos: reposForWorkspace(repos, id),
			group: id,
			initialToolbar: workspaceToolbars[id],
			onToolbarChange: (state) => { workspaceToolbars = setToolbarState(workspaceToolbars, id, state); persist(); },
			coordDir: path.join(userData, '.coordination', id),
			sidecarPath: path.join(sidecarDir, 'sidecar.cjs'),
			notifyScriptPath: path.join(sidecarDir, 'notify-ready.cjs'),
			coordHookPath: path.join(sidecarDir, 'coord-hook.cjs'),
			sessionsFile,
			bypassPermissions: true,
			godSelfImprove,
			roleLibrary,
			connectors,
			sessionEnv: () => sessionEnvProvider({ workspaceId: id }),
			overseerName: typeof cfg.overseerName === 'string' ? cfg.overseerName : undefined,
			toast,
			promptForTopic,
			openSettings: () => void settingsPanel.open(appEl),
		});
		const gridFor = (id: string): TerminalsGrid => {
			let g = grids.get(id);
			if (!g) { g = new TerminalsGrid(depsFor(id)); grids.set(id, g); }
			return g;
		};
		let activeGrid = gridFor(activeId);
		// Construct (NOT mount) every other workspace's grid too, right away. Its sessions stay
		// unrestored until you actually switch to it — but the grid's GOD outbox watcher arms in its
		// constructor, so a workspace nobody has opened this launch still drains external dispatches
		// (Kane's outbox channel — see README "External dispatch") instead of leaving them unread.
		for (const w of workspaces) gridFor(w.id);

		// Merge over a FRESH read: other writers (e.g. the private overlay via PrivateApi.config.set)
		// must not have their keys clobbered by this startup-snapshot spread.
		//
		// SERIALIZED (see SerialWriter): this used to be a bare fire-and-forget read-then-write, so
		// two overlapping persists — a theme change and a tab add, say — both read the old config
		// and the slower one wrote its stale snapshot last, silently reverting the other. That is
		// the same race TerminalsGrid.persistChain was added to fix for the sessions file after it
		// cost CARDTSAR every terminal record; config.json never got the same treatment. Snapshot
		// the mutable state INSIDE the job so the last queued write is the newest one.
		const configWriter = new SerialWriter();
		const persist = (): void => void configWriter.push(async () => {
			const fresh = await window.wcc.getConfig();
			await window.wcc.setConfig({ ...fresh, repos, workspaces, activeWorkspace: activeId, theme: themeId, workspaceToolbars, closedWorkspaces });
		});

		// Attention queue reads whichever grid is ACTIVE (closures over the mutable activeGrid).
		const attention = new AttentionWidget(() => activeGrid.attentionItems(), (tileId) => activeGrid.revealTile(tileId));
		attention.render(topBar);
		window.addEventListener('beforeunload', () => attention.dispose());

		const phoneBtn = topBar.createEl('button', { cls: 'wcc-phone', text: '📱 Phone' });
		const settingsBtn = topBar.createEl('button', { cls: 'wcc-settings-btn', text: '⚙ Settings' });

		// ⚙ Settings button → panel to configure journal "Convert to…" destinations. Created early
		// (before depsFor/grids) so GridDeps.openSettings can reference it.
		const settingsPanel = new SettingsPanel({
			addFolder: () => window.wcc.addFolder(),
			getConfig: () => window.wcc.getConfig(),
			setConfig: (c) => window.wcc.setConfig(c),
			toast,
			onOverseerNameChange: (name) => grids.forEach((g) => g.setOverseerName(name)),
		});
		settingsBtn.addEventListener('click', () => { void settingsPanel.toggle(appEl); });

		// 📋 Changelog button → panel with the current version + CHANGELOG.md.
		const changelogBtn = topBar.createEl('button', { cls: 'wcc-changelog-btn', text: '📋 Changelog' });
		const changelogPanel = new ChangelogPanel({ appRoot, version });
		changelogBtn.addEventListener('click', () => changelogPanel.toggle(appEl));


		// --- workspace tab bar ---
		const bar = new WorkspaceBar({
			list: () => workspaces,
			activeId: () => activeId,
			onSwitch: (id) => void switchTo(id),
			onAdd: () => void onAdd(),
			onClose: (id) => void onClose(id),
			closedCount: () => closedWorkspaces.length,
			onRecentlyClosed: () => void onRecentlyClosed(),
		});
		bar.render(terminalRoot);

		// Grid container: the active grid mounts its controls + board + stage into here.
		const gridContainer = terminalRoot.createDiv({ cls: 'wcc-grid-container' });

		async function switchTo(id: string): Promise<void> {
			if (id === activeId || !workspaces.some((w) => w.id === id)) return;
			activeGrid.unmount();
			activeId = id;
			activeGrid = gridFor(id);
			await activeGrid.mount(gridContainer);
			bar.refresh();
			persist();
			for (const cb of wsSwitchCbs) { try { cb(id); } catch { /* overlay callback must not break switching */ } }
		}

		// Terminal-surface visibility, controlled by the overlay (PrivateApi.hideTerminal /
		// showTerminal). Hiding rides the workspace-switch machinery: the grid unmounts, so
		// every tile suspends its output parsing while something else owns the window.
		let terminalShown = true;
		const hideTerminal = (): void => {
			if (!terminalShown) return;
			terminalShown = false;
			activeGrid.unmount();
			terminalRoot.style.display = 'none';
		};
		const showTerminal = async (): Promise<void> => {
			if (terminalShown) return;
			terminalShown = true;
			terminalRoot.style.display = '';
			await activeGrid.mount(gridContainer); // resume tiles (the workspace-switch path)
		};

		// --- 📖 Agent instructions: a FULL-WINDOW view, not a panel and not a workspace tab.
		// It rides the same hide/show machinery an overlay surface uses, so the terminal grid
		// unmounts (every tile suspends) while something else owns the window, and leaving puts
		// the workspaces back exactly as they were.
		const rolesBtn = topBar.createEl('button', { cls: 'wcc-settings-btn', text: '📖 Roles' });
		// The library path is re-read from config on every open rather than captured at startup:
		// adding the roleLibrary key should show up in the wiki without relaunching the app.
		// (Running SESSIONS still pick a role file up at session start only, by design.)
		let viewLibraryPath = roleLibrary?.path;
		let terminalWasShownBeforeRoles = true;
		const rolesView = new RolesView({
			libraryPath: () => viewLibraryPath,
			toast,
			// The one state-changing action in the whole view, and it is library-level: a terminal
			// on the Agent Custodian role, in the library folder. Close first, so the terminal it
			// spawns is the thing you are looking at.
			reviewWithCustodian: (libPath) => {
				closeRoles();
				void activeGrid.spawnRoleTerminal(libPath, CUSTODIAN_SLUG, {
					name: 'Agent Custodian',
					task: `Run a review pass over the agent role library at ${libPath}.`,
				}).then((tile) => {
					if (tile) toast('Agent Custodian started on the role library — its review pass is read-only', 'success');
					else toast(`Couldn't start the Custodian — ${libPath} is unreachable`, 'error');
				});
			},
		});
		const closeRoles = (): void => {
			if (!rolesView.isOpen) return;
			rolesView.close();
			if (terminalWasShownBeforeRoles) void showTerminal();
		};
		rolesView.onClose = closeRoles;
		const openRoles = async (): Promise<void> => {
			const fresh = await window.wcc.getConfig().catch(() => ({} as Record<string, unknown>));
			viewLibraryPath = parseRoleLibrary(fresh.roleLibrary)?.path ?? roleLibrary?.path;
			terminalWasShownBeforeRoles = terminalShown;
			hideTerminal();
			rolesView.open(appEl);
		};
		rolesBtn.addEventListener('click', () => { if (rolesView.isOpen) closeRoles(); else void openRoles(); });

		async function onAdd(): Promise<void> {
			const name = await promptForTopic('New workspace', 'workspace name', '', 'Create');
			if (!name || !name.trim()) return;
			const r = addWorkspace(workspaces, name);
			if (!r) return;
			workspaces = r.list;
			persist();
			bar.refresh();
			await switchTo(r.id);
		}

		/** ALWAYS confirms — an empty tab gets one line, a tab with dirty worktrees gets a warning.
		 *  The count comes from the PERSISTED sessions file unless the grid has actually restored
		 *  its sessions: the old guard asked the live grid, which reports zero tiles for any tab
		 *  not visited this launch, so the confirm never fired for exactly the tabs most at risk
		 *  (that is how the QMK-Flasher tab was lost). */
		async function onClose(id: string): Promise<void> {
			if (workspaces.length <= 1) return;
			const ws = workspaces.find((w) => w.id === id);
			const g = grids.get(id);
			const live = g && g.sessionsAreLive() ? g.closeRecords() : null;
			const persisted = await TerminalsGrid.readGroupRecords(sessionsFile, id);
			const picked = pickCloseRecords(live, persisted);
			const summary = summarizeClose(picked.records, picked.source);
			const risks = await probeWorktreeRisks(riskProbeTargets(summary));
			const dlg = buildCloseConfirm(ws?.name ?? id, summary, risks);
			if (!await promptForConfirm(dlg.title, dlg.message, dlg.okLabel)) return;
			// State can have moved while the dialog was open (a spawn, another close).
			if (!workspaces.some((w) => w.id === id) || workspaces.length <= 1) return;
			const target = nextActiveAfter(workspaces, id, activeId);
			const closedAt = Date.now();
			const entry: ClosedWorkspace = {
				id, name: ws?.name ?? id, closedAt,
				sessionsKey: archiveSessionsKey(id, closedAt),
				index: Math.max(0, workspaces.findIndex((w) => w.id === id)),
				tileCount: summary.total,
				...(workspaceToolbars[id] ? { toolbar: workspaceToolbars[id] } : {}),
			};
			// Queue the rename BEFORE tearing the grid down: everything here shares one persist
			// chain, so archiving first guarantees the tombstone captures the real records rather
			// than whatever an emptied grid might write afterwards.
			void TerminalsGrid.renameGroup(sessionsFile, id, entry.sessionsKey);
			const archived = archiveWorkspace(closedWorkspaces, entry);
			closedWorkspaces = archived.list;
			// The archive is capped, so something eventually falls off the end — and an evicted
			// tombstone MUST take its sessions key with it. Closing a tab used to leak its bucket
			// forever (the live file still carries a `test-2` bucket for a tab deleted weeks ago);
			// that cleanup was right, and keeping records nothing can reach would restore the leak.
			for (const e of archived.evicted) void TerminalsGrid.forgetGroup(sessionsFile, e.sessionsKey);
			g?.dispose();
			grids.delete(id);
			workspaces = closeWorkspace(workspaces, id);
			// The toolbar state rides on the tombstone, so pruning the live map still just drops a
			// dead id rather than throwing the selection away.
			workspaceToolbars = pruneToolbars(workspaceToolbars, workspaces.map((w) => w.id));
			if (id === activeId) { void switchTo(target); } else { persist(); bar.refresh(); }
			// The near-range half of restore: an Undo right where the misclick happened. Hovering
			// holds the toast open, and clicking Undo twice is a no-op (takeClosedWorkspace).
			toast(`Closed "${entry.name}"`, 'info', {
				durationMs: UNDO_TOAST_MS,
				action: { label: 'Undo', run: () => void restoreWorkspace(entry.sessionsKey) },
			});
		}

		/** Bring a closed tab back: its entry (at the index it sat at), its toolbar state and its
		 *  tiles, which move back out of the `closed:` bucket under the tab's id.
		 *
		 *  It does NOT start its sessions. The grid is CONSTRUCTED and not mounted, which is
		 *  exactly how every workspace comes back after an app restart — tiles present, sessions
		 *  unrestored until you switch to the tab. Eighteen claude processes launching because
		 *  someone clicked Restore would be a worse surprise than the bug this fixes. */
		async function restoreWorkspace(sessionsKey: string): Promise<void> {
			const taken = takeClosedWorkspace(closedWorkspaces, sessionsKey);
			if (!taken) { toast('That workspace has already been restored', 'warn'); return; }
			closedWorkspaces = taken.list;
			const entry = taken.entry;
			// A new tab may have claimed the old id in the meantime; the tiles follow the new one.
			const id = uniqueId(entry.id, workspaces.map((w) => w.id));
			const movedTiles = await TerminalsGrid.renameGroup(sessionsFile, entry.sessionsKey, id);
			workspaces = insertAt(workspaces, { id, name: entry.name }, entry.index);
			// Before gridFor: depsFor reads initialToolbar when it constructs the grid.
			if (entry.toolbar) workspaceToolbars = setToolbarState(workspaceToolbars, id, entry.toolbar);
			gridFor(id);
			persist();
			bar.refresh();
			toast(movedTiles
				? `Restored "${entry.name}" — its terminals are saved, not started. Open the tab to resume them.`
				: `Restored "${entry.name}" — it had no saved terminals.`, 'success');
		}

		/** The far-range half: pick any tab still in the archive. promptForChoice is the app's own
		 *  list dialog, so this needs no popup of its own. */
		async function onRecentlyClosed(): Promise<void> {
			if (!closedWorkspaces.length) { toast('Nothing has been closed yet', 'info'); return; }
			const now = Date.now();
			const chosen = await promptForChoice(
				'Recently closed',
				'Reopen a closed workspace. Its terminals come back saved but not started — switch to the tab to resume them.',
				closedWorkspaces.map((e) => ({
					id: e.sessionsKey,
					label: e.name,
					sublabel: `${e.tileCount} session${e.tileCount === 1 ? '' : 's'} · closed ${relAge(Math.max(0, now - e.closedAt))} ago`,
				})),
			);
			if (chosen) await restoreWorkspace(chosen);
		}

		// Private overlay (see README "Private extensions"): must never take down the app.
		// Runs BEFORE the first mount so a provider set here applies to restored sessions.
		try {
			registerPrivateFeatures({
				topBar,
				shellHosts: { above: stripHost, terminalRoot, below: viewsHost },
				hideTerminal,
				showTerminal,
				terminalVisible: () => terminalShown,
				activeGrid: () => activeGrid,
				config: { get: () => window.wcc.getConfig(), set: (c) => window.wcc.setConfig(c) },
				initialConfig: cfg,
				toast,
				promptForTopic,
				promptForConfirm,
				userData,
				sidecarDir,
				setSessionEnv: (p) => { sessionEnvProvider = p; },
				activeWorkspaceId: () => activeId,
				onWorkspaceSwitch: (cb) => { wsSwitchCbs.push(cb); },
				restartUsageProbe: () => startUsageProbe(),
				workspaceIds: () => workspaces.map((w) => w.id),
				restartSessions: (ids) => { for (const id of ids) grids.get(id)?.restartSessions(); },
			});
		} catch (e) {
			toast(`Private features failed to load — the app still works without them: ${e}`, 'error');
		}

		await activeGrid.mount(gridContainer);

		// Alt+↑ / Alt+↓ cycle WORKSPACES (Alt+←/→ cycle terminals within the active workspace).
		// Capture-phase so it beats the terminal; only acts when there's more than one workspace.
		document.addEventListener('keydown', (e) => {
			if (!terminalShown) return; // an overlay surface is up: the terminal UI is hidden
			if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
			if (workspaces.length < 2) return;
			e.preventDefault();
			const i = Math.max(0, workspaces.findIndex((w) => w.id === activeId));
			const dir = e.key === 'ArrowDown' ? 1 : -1;
			void switchTo(workspaces[(i + dir + workspaces.length) % workspaces.length]!.id);
		}, true);

		// Phone floor view: push the active workspace's floor to the main-process server every 2s,
		// and run actions the phone sends back (toggle remote-control / spawn).
		window.setInterval(() => window.wcc.pushFloorState({ terminals: activeGrid.floorState(), repos: activeGrid.repoNames() }), 2000);
		window.wcc.onRemoteAction((a) => {
			if (a.type === 'remote' && typeof a.id === 'number') activeGrid.toggleRemoteById(a.id);
			else if (a.type === 'spawn' && a.repo && a.task) void activeGrid.spawnFromName(a.repo, a.base ?? null, a.task);
		});

		// 📱 Phone button → panel with the Tailscale URLs to open on your phone.
		let phonePanel: HTMLElement | null = null;
		phoneBtn.addEventListener('click', () => {
			if (phonePanel) { phonePanel.remove(); phonePanel = null; return; }
			void window.wcc.remoteInfo().then((info) => {
				phonePanel = appEl.createDiv({ cls: 'wcc-phone-panel' });
				const btnRect = phoneBtn.getBoundingClientRect();
				phonePanel.style.top = `${Math.round(btnRect.bottom + 6)}px`;
				phonePanel.createDiv({ cls: 'wcc-phone-h', text: '📱 Phone floor view' });
				phonePanel.createDiv({ cls: 'wcc-phone-sub', text: 'Open one of these on your phone (same Tailscale network):' });
				for (const u of info.urls) phonePanel.createEl('div', { cls: 'wcc-phone-url', text: u });
				const close = phonePanel.createEl('button', { cls: 'wcc-phone-close', text: 'Close' });
				close.addEventListener('click', () => { phonePanel?.remove(); phonePanel = null; });
			});
		});

		addFolderBtn.addEventListener('click', () => {
			void (async () => {
				const folder = await window.wcc.addFolder();
				if (!folder) return;
				const found = discoverRepos(folder);
				const before = repos.length;
				repos = mergeRepos(repos, found);
				const added = repos.length - before; // `found` counts duplicates mergeRepos drops
				// Each grid gets its OWN scoped view of the list (untagged repos go everywhere).
				grids.forEach((g, id) => g.setRepos(reposForWorkspace(repos, id)));
				persist();
				statusSpan.textContent = `${repos.length} targets · ${added} just added`;
				if (added === 0) toast(`"${path.basename(folder)}" is already on the floor — nothing to add`, 'warn');
				else if (found.every((r) => r.folder)) toast(`Added folder "${found[0]!.name}" — no git here, so its terminals run in the folder itself`, 'success');
				else toast(`Added ${added} repo(s): ${found.slice(0, 3).map((r) => r.name).join(', ')}${added > 3 ? `, +${added - 3} more` : ''}`, 'success');
			})();
		});

		// 🆕 New repo: pick a location, name it, `git init` a fresh repo (README + initial commit so
		// worktrees have a base branch), then add it to the workspace like any other repo.
		newRepoBtn.addEventListener('click', () => {
			void (async () => {
				const parent = await window.wcc.newRepoLocation(); // choose WHERE (New Folder button available)
				if (!parent) return;
				const name = await promptForTopic('New git repository', 'Name for the new repo', '', 'Create');
				if (!name || !name.trim()) return;
				const res = await createGitRepo(parent, name);
				if (!res.ok) { toast(`Couldn't create repo "${name.trim()}": ${res.error}`, 'error'); return; }
				repos = mergeRepos(repos, discoverRepos(res.path!));
				grids.forEach((g, id) => g.setRepos(reposForWorkspace(repos, id)));
				persist();
				statusSpan.textContent = `${repos.length} repos · created ${name.trim()}`;
				if (res.committed) toast(`Created "${name.trim()}" — ready for worktrees`, 'success');
				else toast(`Created "${name.trim()}", but it has no commit yet — set your git user.name/email and commit before using worktrees`, 'warn');
			})();
		});
	} catch (e) {
		document.body.textContent = 'Startup error: ' + e;
	}
}

void main();
