import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { startRemoteServer } from './remote-server';
import { pickHosts, accessUrls } from './remote-net';
import { resolveOnPath } from '../src/resolve-on-path';

const REMOTE_PORT = 7420;
let win: BrowserWindow | null = null;

// Dev (`npm start`) vs the installed app. Used only for LABELLING — deliberately NOT for
// `app.setName()`, because the name decides the userData dir: renaming it would split the
// dev build's repos/workspaces/sessions off from the installed app's. Both builds share one
// profile on purpose; they just need to be tellable apart in the taskbar and on screen.
const IS_DEV = !app.isPackaged;
const TITLE = IS_DEV ? 'Worktree Command Center — DEV' : 'Worktree Command Center';

function createWindow(): void {
	const sidecarDir = app.isPackaged
		? path.join(process.resourcesPath, 'pty-sidecar')
		: path.join(__dirname, '..', 'pty-sidecar');
	const userData = app.getPath('userData');
	// Repo root — CHANGELOG.md, package.json, etc. sit here (same pattern as assets/ below).
	const appRoot = path.join(__dirname, '..');

	// App / taskbar icon. .ico (multi-size) on Windows for crisp small sizes; .png elsewhere.
	// __dirname is dist/ in dev and inside app.asar when packaged — assets/ sits one level up in both.
	const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
	const iconPath = path.join(__dirname, '..', 'assets', iconFile);

	win = new BrowserWindow({
		width: 1400,
		height: 900,
		icon: iconPath,
		title: TITLE,
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false,
			// Electron 33 sandboxes renderers by default; a sandboxed renderer has no
			// `require` even with nodeIntegration, so the bundle dies on its first require().
			// We load only local, trusted content, so disable the sandbox.
			sandbox: false,
			preload: path.join(__dirname, 'preload.js'),
		},
	});

	// index.html carries a <title>, and Electron lets the page overwrite the window title —
	// which would wipe the " — DEV" suffix the moment the page loads. Pin our own title.
	win.webContents.on('page-title-updated', (e) => { e.preventDefault(); });
	win.setTitle(TITLE);

	win.loadFile(path.join(__dirname, '..', 'index.html'));

	// Block Electron's default Cmd/Ctrl+R and Cmd/Ctrl+Shift+R (reload / force-reload): every
	// terminal tile's state lives only in this renderer's memory, tied to real spawned `claude`
	// processes it owns — a page reload wipes all of that instantly without ever running the
	// tiles' own kill()/cleanup, orphaning those processes and their worktree locks while the
	// fresh page reconstructs the UI from stale-on-disk config. There's no scenario where
	// reloading this app (as opposed to quitting/relaunching it) is the right call.
	win.webContents.on('before-input-event', (event, input) => {
		const isReloadCombo = (input.meta || input.control) && input.key.toLowerCase() === 'r';
		if (isReloadCombo) event.preventDefault();
	});

	// IPC: return resolved paths (isDev drives the on-screen DEV badge)
	ipcMain.handle('paths', () => ({ sidecarDir, userData, appRoot, version: app.getVersion(), isDev: IS_DEV }));

	// IPC: is the `claude` CLI resolvable on PATH? Every worktree terminal and the usage
	// probe spawn it via the sidecar; if it isn't installed/on PATH they all fail silently,
	// so the renderer surfaces a warning banner. Re-checked on demand (not cached) so a user
	// who installs claude and clicks "recheck" gets an up-to-date answer without relaunching.
	ipcMain.handle('claude:check', () => {
		const resolved = resolveOnPath('claude');
		return { found: resolved !== null, path: resolved };
	});

	// IPC: read config.json from userData
	ipcMain.handle('config:get', () => {
		const configPath = path.join(userData, 'config.json');
		try {
			const raw = fs.readFileSync(configPath, 'utf8');
			return JSON.parse(raw);
		} catch {
			return {};
		}
	});

	// IPC: write config.json to userData
	ipcMain.handle('config:set', (_event: Electron.IpcMainInvokeEvent, cfg: unknown) => {
		const configPath = path.join(userData, 'config.json');
		fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
		return true;
	});

	// IPC: show open-directory dialog
	ipcMain.handle('addFolder', async () => {
		const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
		return r.canceled ? null : r.filePaths[0];
	});

	// IPC: pick where to create a NEW repo — `createDirectory` enables the native "New Folder"
	// button so you can make a fresh folder right in the picker (the New repo flow then git-inits
	// a named subfolder inside whatever you choose).
	ipcMain.handle('newRepoLocation', async () => {
		const r = await dialog.showOpenDialog(win!, {
			title: 'Choose where to create the new repository (New Folder to make one here)',
			buttonLabel: 'Use this location',
			properties: ['openDirectory', 'createDirectory'],
		});
		return r.canceled ? null : r.filePaths[0];
	});

	// Phone floor view: HTTP server (Tailscale-reachable) + the access info for the topbar panel.
	const { token } = startRemoteServer({ port: REMOTE_PORT, getWindow: () => win });
	ipcMain.handle('remote:info', () => ({
		token,
		port: REMOTE_PORT,
		urls: accessUrls(pickHosts(os.networkInterfaces(), os.hostname()), REMOTE_PORT, token),
	}));
}

// Windows groups taskbar buttons by AppUserModelID, so giving dev its own ID keeps the two
// builds as separate taskbar entries (and separate jump lists) instead of stacking them.
if (process.platform === 'win32') {
	app.setAppUserModelId(IS_DEV
		? 'com.ronaldfridlyand.worktree-command-center.dev'
		: 'com.ronaldfridlyand.worktree-command-center');
}

app.whenReady().then(createWindow);

app.on('activate', () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
