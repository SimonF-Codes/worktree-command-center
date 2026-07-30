import { installDomShim } from './ui/dom-shim';
import { toast } from './ui/toast';
import { promptForTopic } from './ui/prompt-dialog';
import { TerminalsGrid, type GridDeps, type RepoConfig } from './terminals/terminals-grid';
import { discoverRepos, mergeRepos } from './workspace';
import { createGitRepo } from './create-repo';
import { UsageProbe } from './terminals/usage-probe';
import { UsageWidget } from './ui/usage-widget';
import { ClaudeWarning } from './ui/claude-warning';
import { AttentionWidget } from './ui/attention-widget';
import { WorkspaceBar } from './ui/workspace-bar';
import { SettingsPanel } from './ui/settings-panel';
import { ChangelogPanel } from './ui/changelog-panel';
import { normalizeWorkspaces, addWorkspace, closeWorkspace, renameWorkspace, nextActiveAfter, type Workspace } from './terminals/workspace-store';
import { archiveDirFor } from './terminals/worktree-archive';
import * as path from 'path';
import * as fs from 'fs';
import { registerPrivateFeatures } from 'wcc-private';
import type { SessionEnvProvider } from './private-api';

declare global {
	interface Window {
		wcc: {
			paths(): Promise<{ sidecarDir: string; userData: string; appRoot: string; version: string; isDev: boolean }>;
			checkClaude(): Promise<{ found: boolean; path: string | null }>;
			getConfig(): Promise<any>;
			setConfig(c: any): Promise<boolean>;
			addFolder(): Promise<string | null>;
			newRepoLocation(): Promise<string | null>;
			pushFloorState(s: unknown): void;
			onRemoteAction(cb: (a: { type: string; id?: number; repo?: string; base?: string | null; task?: string }) => void): void;
			remoteInfo(): Promise<{ token: string; port: number; urls: string[] }>;
		};
	}
}

let repos: RepoConfig[] = [];

async function main(): Promise<void> {
	try {
		installDomShim();

		const { sidecarDir, userData, appRoot, version, isDev } = await window.wcc.paths();
		const cfg = await window.wcc.getConfig();
		repos = Array.isArray(cfg.repos) ? cfg.repos : [];

		const appEl = document.getElementById('app')!;

		// --- top bar (persistent above the tabs + grid; never wiped by grid.mount()) ---
		const topBar = appEl.createDiv({ cls: 'wcc-topbar' });
		topBar.createSpan({ cls: 'wcc-brand', text: '🌳 Worktree Command Center' });
		// DEV badge: both builds share one profile (same repos/workspaces/sessions), so without a
		// marker it's impossible to tell which one you're typing into. Dev only.
		if (isDev) topBar.createSpan({ cls: 'wcc-devbadge', text: 'DEV', attr: { title: 'Running the dev build from source (npm start) — same profile as the installed app' } });
		const addFolderBtn = topBar.createEl('button', { cls: 'wcc-add', text: '➕ Add folder' });
		const newRepoBtn = topBar.createEl('button', { cls: 'wcc-add', text: '🆕 New repo' });
		const statusSpan = topBar.createSpan({ cls: 'wcc-status', text: `${repos.length} repos` });

		// Missing-`claude` banner: a full-width strip directly under the top bar. Every terminal
		// and the usage battery spawn `claude` via the sidecar, so if it isn't on PATH the app
		// silently does nothing useful — this makes the cause obvious and offers a recheck.
		const claudeWarnHost = appEl.createDiv({ cls: 'wcc-claude-warn-host' });
		const claudeWarning = new ClaudeWarning(() => window.wcc.checkClaude());
		claudeWarning.render(claudeWarnHost);
		void claudeWarning.refresh();

		// --- workspaces ---
		let workspaces: Workspace[] = normalizeWorkspaces(cfg.workspaces);
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

		const depsFor = (id: string): GridDeps => ({
			repos,
			group: id,
			coordDir: path.join(userData, '.coordination', id),
			sidecarPath: path.join(sidecarDir, 'sidecar.cjs'),
			notifyScriptPath: path.join(sidecarDir, 'notify-ready.cjs'),
			coordHookPath: path.join(sidecarDir, 'coord-hook.cjs'),
			sessionsFile: path.join(userData, '.terminal-sessions.json'),
			archiveDir: archiveDirFor(userData),
			bypassPermissions: true,
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

		// Merge over a FRESH read: other writers (e.g. the private overlay via PrivateApi.config.set)
		// must not have their keys clobbered by this startup-snapshot spread.
		const persist = (): void => void window.wcc.getConfig().then((fresh) => window.wcc.setConfig({ ...fresh, repos, workspaces, activeWorkspace: activeId }));

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
			onClose: (id) => onClose(id),
			onRename: (id) => void onRename(id),
		});
		bar.render(appEl);

		// Grid container: the active grid mounts its controls + board + stage into here.
		const gridContainer = appEl.createDiv({ cls: 'wcc-grid-container' });

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

		// Rename a tab. Only the LABEL changes — the workspace id stays put, so the running
		// terminals, the coordination dir and the persisted sessions all keep working (see
		// renameWorkspace). No switch, no remount: just persist and redraw the bar.
		async function onRename(id: string): Promise<void> {
			const current = workspaces.find((w) => w.id === id);
			if (!current) return;
			const name = await promptForTopic('Rename tab', 'workspace name', current.name, 'Rename');
			if (name === null) return;
			const next = renameWorkspace(workspaces, id, name);
			if (!next) return; // blank or unchanged
			workspaces = next;
			persist();
			bar.refresh();
		}

		function onClose(id: string): void {
			if (workspaces.length <= 1) return;
			const ws = workspaces.find((w) => w.id === id);
			const g = grids.get(id);
			const count = g ? g.terminalCount() : 0;
			if (count > 0 && !window.confirm(`Close workspace "${ws?.name ?? id}"? Its ${count} terminal(s) will be stopped.`)) return;
			const target = nextActiveAfter(workspaces, id, activeId);
			g?.dispose();
			grids.delete(id);
			workspaces = closeWorkspace(workspaces, id);
			if (id === activeId) { void switchTo(target); } else { persist(); bar.refresh(); }
		}

		// Private overlay (see README "Private extensions"): must never take down the app.
		// Runs BEFORE the first mount so a provider set here applies to restored sessions.
		try {
			registerPrivateFeatures({
				topBar,
				activeGrid: () => activeGrid,
				config: { get: () => window.wcc.getConfig(), set: (c) => window.wcc.setConfig(c) },
				initialConfig: cfg,
				toast,
				promptForTopic,
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
			toast('Private features failed to load: ' + e);
		}

		await activeGrid.mount(gridContainer);

		// Alt+↑ / Alt+↓ cycle WORKSPACES (Alt+←/→ cycle terminals within the active workspace).
		// Capture-phase so it beats the terminal; only acts when there's more than one workspace.
		document.addEventListener('keydown', (e) => {
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
				repos = mergeRepos(repos, found);
				grids.forEach((g) => g.setRepos(repos)); // every workspace shares the repo list
				persist();
				statusSpan.textContent = `${repos.length} repos · ${found.length} just added`;
				toast(`Added ${found.length} repo(s)`);
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
				if (!res.ok) { toast(`Couldn't create repo: ${res.error}`); return; }
				repos = mergeRepos(repos, discoverRepos(res.path!));
				grids.forEach((g) => g.setRepos(repos));
				persist();
				statusSpan.textContent = `${repos.length} repos · created ${name.trim()}`;
				toast(res.committed
					? `Created "${name.trim()}"`
					: `Created "${name.trim()}" — set your git user.name/email and make a commit to use worktrees`);
			})();
		});
	} catch (e) {
		document.body.textContent = 'Startup error: ' + e;
	}
}

void main();
