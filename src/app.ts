import { installDomShim } from './ui/dom-shim';
import { toast } from './ui/toast';
import { promptForTopic, promptForConfirm, promptForChoice } from './ui/prompt-dialog';
import { TerminalsGrid, type GridDeps, type RepoConfig } from './terminals/terminals-grid';
import { parseGodSelfImprove } from './terminals/god';
import { parseRoleLibrary } from './terminals/role-library';
import { parseConnectors } from './terminals/connectors';
import { discoverRepos, mergeRepos, forgetRepo, retargetRepo, reposForWorkspace, linkedRepo, repoOptionLabel } from './workspace';
import { planMove, describeMovePlan, describeRefusals, remapRepoLinks, samePath, isInside, legacyWorktreeRootFor, type PathMove } from './move-repo';
import { gatherMoveFacts, executeMove, describeMoveResult } from './move-repo-io';
import { runCommand } from './command-runner';
import { tabLinkOptions, toolbarForLink, defaultNewRepoParent, tabTitle, type TabLinkKind } from './tab-repo';
import { defaultNewRepoParams, describeNewRepo, seedFiles } from './new-repo-params';
import { findGh, createGitHubRemote } from './gh-cli';
import { promptForNewRepo } from './ui/new-repo-dialog';
import { SerialWriter } from './serial-writer';
import { normalizeToolbars, setToolbarState, pruneToolbars, type WorkspaceToolbars } from './terminals/toolbar-state';
import { createGitRepo, repoDirName } from './create-repo';
import { UsageProbe } from './terminals/usage-probe';
import { reapUsageProbeStrays } from './terminals/stray-reaper';
import { UsageWidget } from './ui/usage-widget';
import { ClaudeWarning } from './ui/claude-warning';
import { PerfMonitor } from './ui/perf-monitor';
import { AttentionWidget } from './ui/attention-widget';
import { WorkspaceBar } from './ui/workspace-bar';
import { SettingsPanel } from './ui/settings-panel';
import { ChangelogPanel } from './ui/changelog-panel';
import { MemoryPanel } from './ui/memory-panel';
import { MemoryWidget } from './ui/memory-widget';
import { MemoryMonitor } from './terminals/memory-monitor';
import { buildFloorReport } from './terminals/floor-report';
import { FloorReportPublisher, vaultReportTarget } from './terminals/floor-report-publisher';
import { AutoCloser } from './terminals/auto-closer';
import { parseAutoClose } from './terminals/auto-close';
import { AutoCloseNoticeView } from './ui/auto-close-notice';
import type { SessionClaim } from './terminals/session-memory';
import { RolesView } from './ui/roles-view';
import { CUSTODIAN_SLUG } from './terminals/role-view-loader';
import { normalizeWorkspaces, addWorkspace, closeWorkspace, nextActiveAfter, linkWorkspaceRepo, type Workspace } from './terminals/workspace-store';
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
			moveRepoLocation(name: string): Promise<string | null>;
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
		// Off unless explicitly opted into — a missing or malformed setting reads as off.
		let autoCloseCfg = parseAutoClose(cfg.autoClose);
		let autoCloser: AutoCloser | null = null;

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
		// Two spans, not one string: on a narrow window the words drop and the tree stays, which
		// buys back ~180px of a bar that otherwise runs off the edge (see .wcc-topbar in app.css).
		const brand = topBar.createSpan({ cls: 'wcc-brand' });
		brand.createSpan({ cls: 'wcc-brand-mark', text: '🌳' });
		brand.createSpan({ cls: 'wcc-brand-text', text: 'Worktree Command Center' });
		// DEV badge: both builds share one profile (same repos/workspaces/sessions), so without a
		// marker it's impossible to tell which one you're typing into. Dev only.
		if (isDev) topBar.createSpan({ cls: 'wcc-devbadge', text: 'DEV', attr: { title: 'Running the dev build from source (npm start) — same profile as the installed app' } });
		/** A top-bar button whose WORD drops on a narrow window, leaving the icon and its tooltip.
		 *  Eleven full-width controls do not fit a 1080px portrait monitor; icon-only gets the bar
		 *  back to a single row there instead of two (see .wcc-topbar in app.css). */
		const barButton = (cls: string, icon: string, label: string): HTMLButtonElement => {
			const b = topBar.createEl('button', { cls, attr: { title: label } });
			b.createSpan({ cls: 'wcc-btn-ico', text: icon });
			b.createSpan({ cls: 'wcc-btn-text', text: label });
			return b;
		};
		const addFolderBtn = barButton('wcc-add', '➕', 'Add folder');
		const newRepoBtn = barButton('wcc-add', '🆕', 'New repo');
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
		// The memory gauge goes immediately after the battery, and is filled in further down —
		// once the grids whose claims it reads exist. The host div is created HERE rather than
		// there so it takes its place in the top bar's flex order next to the battery, instead
		// of after the Phone/Settings/Changelog buttons that follow.
		const memHost = topBar.createDiv({ cls: 'wcc-mem-host' });
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

		// Reap probe sidecars left behind by an earlier run. Each one pins a live `claude`
		// (~250 MB) that nothing else can reach any more — its owner's pid died with the old
		// renderer — so they accumulate until the machine reboots. Deferred past first paint:
		// it costs one process snapshot and must not sit in front of the UI.
		window.setTimeout(() => {
			void reapUsageProbeStrays(path.join(userData, 'usage-probe'), usageProbe?.ownedPids() ?? [])
				.then((r) => {
					if (r.reaped.length) console.info(`[wcc] reaped ${r.reaped.length} stray usage-probe session(s):`, r.reaped);
					for (const f of r.failed) console.error(`[wcc] could NOT kill stray pid ${f.pid}: ${f.detail}`);
				});
		}, 3000);

		// Kane self-improvement (see docs/superpowers/specs/2026-07-15-kane-self-improvement-design.md):
		// config names the app's own source repo; toolsDir defaults beside the user's home.
		const siCfg = parseGodSelfImprove(cfg.god);
		const godSelfImprove = siCfg ? { sourceRepo: siCfg.sourceRepo, toolsDir: siCfg.toolsDir ?? path.join(os.homedir(), 'kane-tools') } : undefined;

		// Connectors registered for the external request/receipt channel (see docs/api.md).
		// App-wide, like repos — every workspace's grid gets the same list.
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
			// Lazy: both fire long after startup, once floorReport below exists.
			onWorktreesScanned: () => void floorReport.publish(),
			requestFloorReport: () => void publishFloorReportNow(),
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
		// (Kane's outbox channel — see docs/architecture.md) instead of leaving them unread.
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

		const phoneBtn = barButton('wcc-phone', '📱', 'Phone');
		const settingsBtn = barButton('wcc-settings-btn', '⚙', 'Settings');

		// ⚙ Settings button → panel to configure journal "Convert to…" destinations. Created early
		// (before depsFor/grids) so GridDeps.openSettings can reference it.
		const settingsPanel = new SettingsPanel({
			addFolder: () => window.wcc.addFolder(),
			getConfig: () => window.wcc.getConfig(),
			setConfig: (c) => window.wcc.setConfig(c),
			toast,
			onOverseerNameChange: (name) => grids.forEach((g) => g.setOverseerName(name)),
			onAutoCloseChange: (raw) => { autoCloseCfg = parseAutoClose(raw); autoCloser?.apply(); },
			targets: {
				list: () => repos,
				move: (r) => moveTargetInteractive(r),
				hasLegacyWorktrees: (r) => fs.existsSync(legacyWorktreeRootFor(r.path, r.name)),
				relayout: (r) => runMoveInteractive(r, r.path),
				repoint: (r) => repointTargetInteractive(r),
				forget: (r) => forgetTargetInteractive(r),
			},
		});
		settingsBtn.addEventListener('click', () => { void settingsPanel.toggle(appEl); });

		// 📋 Changelog button → panel with the current version + CHANGELOG.md.
		const changelogBtn = barButton('wcc-changelog-btn', '📋', 'Changelog');
		const changelogPanel = new ChangelogPanel({ appRoot, version });
		changelogBtn.addEventListener('click', () => changelogPanel.toggle(appEl));

		// 🧠 Session memory → what every live session costs in RAM, ACROSS EVERY WORKSPACE, and
		// what is running under this app that no session claims. It reads the process tree, not
		// the tile list, so it can contradict the floor — which is the only way it could ever
		// have caught the usage-probe leak.
		//
		// ONE poller, shared by the top-bar gauge and the panel. The gauge asks for 60s, the
		// panel for 20s while it is open, and the monitor runs a single timer at the faster of
		// the two — a tracker that spawned two `Win32_Process` queries would be the bug it
		// reports.
		const allClaims = (): SessionClaim[] => {
			const out: SessionClaim[] = [];
			// Every grid, not just the active one. Grids are created lazily per workspace, so
			// this covers exactly the tabs that have ever had sessions — which is exactly the
			// set that can be holding memory.
			for (const [id, g] of grids) {
				out.push(...g.memoryClaims(workspaces.find((w) => w.id === id)?.name ?? id));
			}
			// The usage battery's own probe, named rather than left anonymous. Without this it
			// would land in "unattributed" every five minutes and train you to ignore the one
			// row that matters. A LEAKED probe still shows there, which is the point.
			for (const pid of usageProbe?.ownedPids() ?? []) {
				out.push({
					key: `app:usage-probe:${pid}`, name: 'usage battery', workspaceId: '', workspaceName: 'app',
					repo: 'usage probe', branch: '', pid, busy: true, idleSince: null, hidden: true, system: true,
				});
			}
			return out;
		};
		const memoryMonitor = new MemoryMonitor({ claims: allClaims });
		// The memory panel's close and auto-close share ONE close path: endSessionKeepingWork parks
		// uncommitted work, keeps the branch and worktree, and kills only the process — so the
		// transcript (keyed by worktree path) survives and Reopen brings the session back.
		const endSessionKeepingWork = async (workspaceId: string, key: string): Promise<boolean> => {
			const tileId = Number(key.slice(key.lastIndexOf(':') + 1));
			if (!Number.isFinite(tileId)) return false;
			return (await grids.get(workspaceId)?.endSessionKeepingWork(tileId)) ?? false;
		};
		const memoryPanel = new MemoryPanel({
			monitor: memoryMonitor,
			endSession: endSessionKeepingWork,
			toast,
		});

		// Auto-close finished sessions. OFF unless Settings opted in with a threshold; while off it
		// holds no subscription, so nothing exists that could close a session. auto-close.ts says
		// what it refuses to touch, and why.
		const autoCloseNotice = new AutoCloseNoticeView();
		autoCloser = new AutoCloser({
			config: () => autoCloseCfg,
			subscribe: (ms, fn) => memoryMonitor.subscribe(ms, fn),
			refresh: () => memoryMonitor.refreshNow(),
			facts: (key) => {
				const cut = key.lastIndexOf(':');
				const tileId = Number(key.slice(cut + 1));
				return Number.isFinite(tileId) ? grids.get(key.slice(0, cut))?.autoCloseFacts(tileId) : undefined;
			},
			endSession: endSessionKeepingWork,
			notice: autoCloseNotice,
		});
		autoCloser.apply();
		// The gauge is the ONLY way into the panel now. The old `🧠 Memory` button is gone: a
		// number you have to ask for cannot warn you, and two entry points to one panel is
		// clutter.
		const memoryWidget = new MemoryWidget(memoryMonitor, { onOpen: () => memoryPanel.toggle(appEl) });
		memoryWidget.render(memHost);
		window.addEventListener('beforeunload', () => { memoryPanel.close(); autoCloser?.dispose(); autoCloseNotice.hide(); memoryWidget.dispose(); memoryMonitor.dispose(); });

		// 📊 Floor report (see the vault's "Floor Report and Task Extrapolation" design): one
		// object joining every tab, target, worktree and terminal, written as floor-report.json
		// and floor-report.md. A JOIN over what the app already gathers — each grid's last
		// worktree scan, the memory tracker's claims and LAST snapshot, config and the sessions
		// file. It never scans or snapshots anything itself, and it keeps no timer: it refreshes
		// when a grid's scan lands, and when the 📊 Report button asks.
		//
		// The vault copy (Personal/Code/Floor Report.md + floor-report.json) is how Brain 2.0 sees
		// it: Brain 2.0 already indexes the vault, so no new protocol on either side — and NOT the
		// connector channel, which is a narrow request/receipt path for asking this app to act. It
		// is the app's first write into the vault: two fixed files, no folder created, throttled
		// to one write per few minutes, every failure swallowed. Off without a role library.
		const vaultTarget = vaultReportTarget(roleLibrary?.path);
		const floorReport = new FloorReportPublisher({
			coordRoot: path.join(userData, '.coordination'),
			vault: {
				target: vaultTarget,
				fs: {
					isDirectory: async (d) => { try { return (await fs.promises.stat(d)).isDirectory(); } catch { return false; } },
					writeFile: (f, data) => fs.promises.writeFile(f, data, 'utf8'),
				},
			},
			fs: {
				mkdir: async (d) => { await fs.promises.mkdir(d, { recursive: true }); },
				writeFile: (f, data) => fs.promises.writeFile(f, data, 'utf8'),
				rename: (a, b) => fs.promises.rename(a, b),
			},
			gather: async () => {
				let sessionGroups: Record<string, number> | null = null;
				try {
					const all = JSON.parse(await fs.promises.readFile(sessionsFile, 'utf8')) as Record<string, unknown>;
					sessionGroups = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
				} catch { /* unreadable → the report says "—" rather than guessing */ }
				return buildFloorReport({
					now: Date.now(),
					workspaces,
					activeWorkspaceId: activeId,
					targets: repos,
					scans: [...grids.values()].map((g) => g.floorScan()).filter((s) => s !== null),
					claims: allClaims(),
					memory: memoryMonitor.latest(),
					machine: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
					sessionGroups,
				});
			},
		});
		const publishFloorReportNow = async (): Promise<void> => {
			await activeGrid.rescanWorktrees(); // its scan hook publishes too; this one reports back
			const r = await floorReport.publish({ onDemand: true });
			if (!r) { toast('Floor report could not be built — see the console', 'error'); return; }
			const t = r.totals;
			const vaultNote = vaultTarget ? ' (and to the vault, Personal/Code/Floor Report.md)' : '';
			toast(`Floor report: ${t.worktrees} worktrees, ${t.terminals} terminals → ${path.join(userData, '.coordination', 'floor-report.md')}${vaultNote}`, 'info');
		};


		// --- workspace tab bar ---
		const bar = new WorkspaceBar({
			list: () => workspaces,
			activeId: () => activeId,
			onSwitch: (id) => void switchTo(id),
			onAdd: () => void onAdd(),
			onClose: (id) => void onClose(id),
			closedCount: () => closedWorkspaces.length,
			onRecentlyClosed: () => void onRecentlyClosed(),
			title: (w) => tabTitle(w, repos),
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
		const rolesBtn = barButton('wcc-settings-btn', '📖', 'Roles');
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

		// --- tabs born linked to a repo (tab-repo.ts) ---
		// Where the last new repo went, so the next one is proposed beside it. Written by its own
		// fresh-read job below rather than by persist(), the same way autoClose/roleLibrary are
		// left to their own writers: persist() never re-writes it from a stale snapshot.
		let lastNewRepoParent: unknown = cfg.newRepoParent;

		const registerRepos = (found: RepoConfig[]): void => {
			repos = mergeRepos(repos, found);
			// Each grid gets its OWN scoped view of the list (untagged repos go everywhere).
			grids.forEach((g, id) => g.setRepos(reposForWorkspace(repos, id)));
		};

		/** The one way to make a repo: form → confirm (what and where, before anything is written)
		 *  → createGitRepo → optional GitHub remote. Shared by the 🆕 button and the new-tab flow.
		 *  Resolves the REGISTERED target — looked up by path, since mergeRepos keeps an existing
		 *  entry — or null when nothing was created. */
		async function createRepoInteractive(suggestedName: string): Promise<{ repo: RepoConfig; branch: string } | null> {
			const gh = findGh();
			let params = defaultNewRepoParams(suggestedName, defaultNewRepoParent(lastNewRepoParent, repos));
			let error: string | undefined;
			for (;;) {
				const got = await promptForNewRepo({ initial: params, ghAvailable: !!gh, chooseFolder: () => window.wcc.newRepoLocation(), error });
				if (!got) return null;
				params = got;
				error = undefined;
				// Back to the form (values kept) rather than out of the whole flow.
				if (!await promptForConfirm('Create this repository?', describeNewRepo(params), 'Create')) continue;
				const res = await createGitRepo(params.parentDir, params.name, { branch: params.branch, files: seedFiles(params) });
				if (!res.ok || !res.path) { error = `Couldn't create it: ${res.error ?? 'unknown error'}`; continue; }

				const parent = params.parentDir;
				lastNewRepoParent = parent;
				void configWriter.push(async () => {
					const fresh = await window.wcc.getConfig();
					await window.wcc.setConfig({ ...fresh, newRepoParent: parent });
				});
				registerRepos(discoverRepos(res.path));
				persist();
				const repo = linkedRepo(repos, res.path)!;
				statusSpan.textContent = `${repos.length} repos · created ${repo.name}`;

				if (!res.committed) {
					// Not a quiet state: without a commit there is nothing to branch from, so every
					// terminal on this repo would fail to start. Held on screen long enough to act on.
					toast(`Created "${repo.name}", but it has NO commit yet, so no terminal can start in it — worktrees need a commit to branch from. Set git user.name and user.email, then commit in ${res.path}.${params.remote !== 'none' ? ' The GitHub remote was skipped: there was nothing to push.' : ''}`, 'error', { durationMs: 30000 });
				} else if (params.remote !== 'none' && gh) {
					toast(`Created "${repo.name}" — now creating its GitHub repo…`, 'info');
					const rr = await createGitHubRemote(gh, res.path, repoDirName(params.name), params.remote);
					if (rr.ok) toast(`Created "${repo.name}" with a ${params.remote} GitHub remote${rr.url ? ` — ${rr.url}` : ''}`, 'success');
					else toast(`Created "${repo.name}" locally, but the GitHub remote failed: ${rr.error}. The local repo is fine — add a remote later with \`gh repo create\`.`, 'warn', { durationMs: 20000 });
				} else {
					toast(`Created "${repo.name}" — ready for worktrees`, 'success');
				}
				return { repo, branch: res.branch ?? params.branch };
			}
		}

		/** Ask which repo a new tab is for. Resolves the target (and the branch, for a repo just
		 *  created), 'none' for a deliberately empty tab, or null when the person backed out —
		 *  in which case no tab is made. Backing out of a sub-step returns here, not out. */
		async function chooseTabRepo(tabName: string): Promise<{ repo: RepoConfig; branch?: string } | 'none' | null> {
			// Repos grouped to some other tab belong to it; a new tab offers the shared ones.
			const shared = repos.filter((r) => !r.group);
			for (;;) {
				const kind = await promptForChoice(
					`Link "${tabName}" to a repo`,
					'A tab is a project: its terminals start on this repo. Every other target stays one toolbar pick away.',
					tabLinkOptions(shared.length),
				) as TabLinkKind | null;
				if (!kind) return null;
				if (kind === 'none') return 'none';
				if (kind === 'new') {
					const made = await createRepoInteractive(tabName);
					if (made) return made;
					continue;
				}
				if (kind === 'existing') {
					const chosen = await promptForChoice('Existing repo', `Which target is "${tabName}" for?`,
						shared.map((r) => ({ id: r.path, label: repoOptionLabel(r), sublabel: r.path })));
					const repo = linkedRepo(repos, chosen ?? undefined);
					if (repo) return { repo };
					continue;
				}
				// browse
				const folder = await window.wcc.addFolder();
				if (!folder) continue;
				const found = discoverRepos(folder);
				let pick: RepoConfig | undefined = found[0];
				if (found.length > 1) {
					// A dev root holding several repos: the tab is for ONE of them. Only that one is
					// registered — picking a folder for a tab is not "add everything under it".
					const chosen = await promptForChoice('Which repo?', `${path.basename(folder)} holds ${found.length} git repos. Which one is "${tabName}" for?`,
						found.map((r) => ({ id: r.path, label: r.name, sublabel: r.path })));
					pick = found.find((r) => r.path === chosen);
				}
				if (!pick) continue;
				registerRepos([pick]);
				persist();
				statusSpan.textContent = `${repos.length} targets`;
				if (pick.folder) toast(`"${pick.name}" has no git — its terminals run in the folder itself, without worktrees`, 'info');
				return { repo: linkedRepo(repos, pick.path)! };
			}
		}

		async function onAdd(): Promise<void> {
			const name = await promptForTopic('New workspace', 'workspace name', '', 'Next');
			if (!name || !name.trim()) return;
			const link = await chooseTabRepo(name.trim());
			if (link === null) return;
			const r = addWorkspace(workspaces, name);
			if (!r) return;
			workspaces = r.list;
			if (link !== 'none') {
				workspaces = linkWorkspaceRepo(workspaces, r.id, link.repo.path);
				// Before switchTo → gridFor: depsFor reads initialToolbar when it constructs the grid.
				workspaceToolbars = setToolbarState(workspaceToolbars, r.id, toolbarForLink(link.repo, link.branch));
			}
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
			// Two git commands per worktree, and a busy tab has eighteen of them — enough of a pause
			// before the dialog opens that a silent one reads as a dead button. Say what it is doing.
			const targets = riskProbeTargets(summary);
			if (targets.length > 4) toast(`Checking ${targets.length} worktrees for unsaved work…`, 'info');
			const risks = await probeWorktreeRisks(targets);
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
				...(ws?.repo ? { repo: ws.repo } : {}),
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
			workspaces = insertAt(workspaces, { id, name: entry.name, ...(entry.repo ? { repo: entry.repo } : {}) }, entry.index);
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

		// 🆕 New repo: the same form, confirm and createGitRepo the new-tab flow uses (README +
		// initial commit so worktrees have a base branch), added to the floor like any other repo
		// but not linked to a tab.
		newRepoBtn.addEventListener('click', () => { void createRepoInteractive(''); });
		// --- ⚙ Settings → Targets: move, repoint, forget (move-repo.ts / move-repo-io.ts) ---
		// All three edit the app's OWN in-memory state and persist it: persist() rewrites the whole
		// `repos` key from memory, so a config.json edited from outside while the app runs is
		// overwritten — which is why the first repo move of 2026-10-14 needed a script that refused
		// to run while the app was open, and why this has to live in-process.
		const caseInsensitive = process.platform === 'win32';
		const allLivePaths = (): string[] => [...grids.values()].flatMap((g) => g.livePaths());

		/** Repoint everything the APP stores under a path map — the target, every tab linked to it,
		 *  closed tabs' tombstones, saved terminals on disk and in each grid's memory — then read
		 *  config.json back rather than trusting the write. */
		async function applyPathMap(fromPath: string, toPath: string, map: readonly PathMove[]): Promise<{ ok: boolean; detail: string }> {
			const retargets = !samePath(fromPath, toPath, caseInsensitive); // false for a relayout
			if (retargets) repos = retargetRepo(repos, fromPath, toPath);
			workspaces = remapRepoLinks(workspaces, map, caseInsensitive);
			closedWorkspaces = remapRepoLinks(closedWorkspaces, map, caseInsensitive);
			grids.forEach((g, id) => g.setRepos(reposForWorkspace(repos, id)));
			let inMemory = 0;
			grids.forEach((g) => { inMemory += g.remapUnrestored(map, caseInsensitive); });
			const onDisk = await TerminalsGrid.remapSessionPaths(sessionsFile, map, caseInsensitive);
			persist();
			await configWriter.idle();
			bar.refresh();
			const back = await window.wcc.getConfig().catch(() => ({}));
			const saved: RepoConfig[] = Array.isArray(back.repos) ? back.repos : [];
			if (!saved.some((r) => samePath(r.path, toPath, caseInsensitive)) || (retargets && saved.some((r) => samePath(r.path, fromPath, caseInsensitive)))) {
				return { ok: false, detail: 'config.json does not show the repointed target after writing it' };
			}
			if (onDisk === null) return { ok: false, detail: 'config.json is repointed, but the saved-terminals file could not be rewritten' };
			return { ok: true, detail: `target and linked tabs repointed; ${onDisk} saved terminal record${onDisk === 1 ? '' : 's'} rewritten${inMemory ? ` (+${inMemory} held in memory)` : ''}` };
		}

		/** Move a repo and everything that points at it. Nothing is written until the person has seen
		 *  the whole plan — or every reason it is refused, with a Re-check for after they have closed
		 *  the terminal or parked the work. A move that stops halfway says where, and Re-check picks
		 *  it up from there: the plan is recomputed from what is on disk each time. */
		async function moveTargetInteractive(r: RepoConfig): Promise<void> {
			const parent = await window.wcc.moveRepoLocation(r.name);
			if (!parent) return;
			const dirName = await promptForTopic(`Move ${r.name} into ${parent}`, 'folder name', path.basename(r.path), 'Next');
			if (!dirName || !dirName.trim()) return;
			await runMoveInteractive(r, path.join(parent, dirName.trim()));
		}

		/** Plan, confirm, execute, and on a stop offer to re-check and resume. `to` === the repo's own
		 *  path is a relayout: the repo stays, its worktrees in the old shared root move inside it. */
		async function runMoveInteractive(r: RepoConfig, to: string): Promise<void> {
			const relayout = samePath(r.path, to, caseInsensitive);
			const verb = relayout ? 'nest the worktrees of' : 'move';
			const journalDir = path.join(userData, 'repo-moves');
			for (;;) {
				toast(`Checking ${r.name}: worktrees, uncommitted work, open handles, transcripts…`, 'info');
				let plan;
				try {
					const cfgNow = await window.wcc.getConfig();
					plan = planMove(await gatherMoveFacts(r, to, { livePaths: allLivePaths(), targets: repos, config: cfgNow, journalDir }));
				} catch (e) { toast(`Couldn't read ${r.name}: ${(e as Error).message}`, 'error'); return; }
				if (plan.refusals.length) {
					const told = plan.warnings.length ? `\n\n${plan.warnings.map((w) => `⚠ ${w}`).join('\n')}` : '';
					if (await promptForConfirm(`Can't ${verb} ${r.name} yet`, describeRefusals(plan) + told, 'Re-check')) continue;
					return;
				}
				const go = relayout ? 'Nest worktrees' : plan.resuming ? 'Finish the move' : 'Move';
				if (!await promptForConfirm(relayout ? `Nest ${r.name}'s worktrees inside it?` : `Move ${r.name}?`, describeMovePlan(plan), go)) return;
				const result = await executeMove(plan, {
					journalDir,
					applyAppState: (p) => applyPathMap(p.from, p.to, p.pathMap),
				});
				console.info(`[wcc] repo ${relayout ? 'relayout' : 'move'}`, r.name, result);
				if (result.ok) {
					const n = plan.worktreeMoves.length;
					statusSpan.textContent = `${repos.length} targets · ${relayout ? 'nested the worktrees of' : 'moved'} ${r.name}`;
					toast(`${relayout ? `Nested ${n} worktree${n === 1 ? '' : 's'} inside ${r.name}` : `Moved ${r.name} → ${to}`}. All ${result.verify?.shas ?? 0} commits verified, ${plan.expectedWorktrees.length} worktree${plan.expectedWorktrees.length === 1 ? '' : 's'} resolve, ${plan.transcripts.length} transcript folder${plan.transcripts.length === 1 ? '' : 's'} followed.`, 'success', { durationMs: 15000 });
					return;
				}
				if (await promptForConfirm(`${relayout ? 'Nesting the worktrees of' : 'Move of'} ${r.name} stopped`, describeMoveResult(result), 'Re-check and resume')) continue;
				return;
			}
		}

		/** For a folder already moved by hand: point the target (and tabs and saved terminals) at
		 *  where it is now. Moves nothing. For a repo it also runs `git worktree repair` from the new
		 *  location, which rewrites every linked worktree's pointer back to the repo — idempotent,
		 *  and the one thing that is certainly broken after a hand-move. */
		async function repointTargetInteractive(r: RepoConfig): Promise<void> {
			const folder = await window.wcc.addFolder();
			if (!folder) return;
			if (samePath(folder, r.path, caseInsensitive)) { toast(`${r.name} already points at ${folder}`, 'info'); return; }
			if (!r.folder && !fs.existsSync(path.join(folder, '.git'))) { toast(`${folder} has no .git — that is not the repo. Nothing was changed.`, 'error'); return; }
			const live = allLivePaths().filter((p) => isInside(p, r.path, caseInsensitive));
			if (live.length) { toast(`A terminal is still running in ${live[0]}. Close it before repointing ${r.name}.`, 'error'); return; }
			const stillThere = fs.existsSync(r.path);
			const msg = [
				`${r.path}\n  → ${folder}`,
				'',
				'The target, every tab linked to it, and saved terminals are repointed. Nothing on disk moves.',
				r.folder ? '' : 'git worktree repair runs in the new location so its worktrees find it again.',
				'Claude transcripts are NOT renamed — to have them follow, use Move instead of moving by hand.',
				stillThere ? `\n⚠ ${r.path} still exists. Repointing does not move it — are you sure this is the same repo?` : '',
			].filter((l, i) => i === 1 || l !== '').join('\n');
			if (!await promptForConfirm(`Repoint ${r.name}?`, msg, 'Repoint')) return;
			if (!r.folder) {
				const rep = await runCommand('git', ['worktree', 'repair'], { cwd: folder, timeoutMs: 30000 });
				if (rep.code !== 0) toast(`git worktree repair in ${folder} failed: ${(rep.error ?? rep.stderr).trim().split('\n')[0]}. Repointing anyway — run it by hand.`, 'warn', { durationMs: 15000 });
			}
			const res = await applyPathMap(r.path, folder, [{ from: r.path, to: folder }]);
			statusSpan.textContent = `${repos.length} targets`;
			toast(res.ok ? `Repointed ${r.name} → ${folder}: ${res.detail}` : `Repointing ${r.name} failed: ${res.detail}`, res.ok ? 'success' : 'error');
		}

		/** Drop a target from the floor. Touches nothing on disk; running terminals keep running, and
		 *  a tab linked to it shows as unlinked until the folder is added again. */
		async function forgetTargetInteractive(r: RepoConfig): Promise<void> {
			const linked = workspaces.filter((w) => w.repo && samePath(w.repo, r.path, caseInsensitive)).map((w) => w.name);
			const msg = [
				r.path,
				'',
				'It leaves the floor and every toolbar. Nothing on disk is touched — the repo, its worktrees and their transcripts all stay. Add the folder again to bring it back.',
				linked.length ? `Linked tab${linked.length === 1 ? '' : 's'} (${linked.join(', ')}) will show as unlinked.` : '',
			].filter((l, i) => i === 1 || l !== '').join('\n');
			if (!await promptForConfirm(`Forget ${r.name}?`, msg, 'Forget')) return;
			repos = forgetRepo(repos, r.path);
			grids.forEach((g, id) => g.setRepos(reposForWorkspace(repos, id)));
			persist();
			bar.refresh();
			statusSpan.textContent = `${repos.length} targets`;
			toast(`Forgot ${r.name}`, 'success');
		}
	} catch (e) {
		document.body.textContent = 'Startup error: ' + e;
	}
}

void main();
