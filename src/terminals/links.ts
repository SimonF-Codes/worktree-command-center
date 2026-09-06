/** Link handling for the embedded terminals: Ctrl/Cmd+click a URL to open it in the real
 *  browser, while plain clicks and drag-to-select stay untouched. */

export type LinkActivator = (event: MouseEvent, uri: string) => void;

/** Build a WebLinksAddon activation handler that only fires on Ctrl/Cmd+click. */
export function ctrlClickActivator(open: (uri: string) => void): LinkActivator {
	return (event, uri) => { if (event.ctrlKey || event.metaKey) open(uri); };
}

/** Open a URL in the user's real browser via Electron's shell; fall back to window.open. */
export function openExternalUrl(uri: string): void {
	try {
		const req = (window as unknown as { require?: (m: string) => unknown }).require;
		if (req) {
			const shell = (req('electron') as { shell?: { openExternal?: (u: string) => void } }).shell;
			if (shell?.openExternal) { shell.openExternal(uri); return; }
		}
	} catch { /* not running under Electron */ }
	try { window.open(uri, '_blank'); } catch { /* no-op */ }
}

/** Electron's `shell`, or undefined outside Electron (the unit tests, mainly). */
function electronShell(): Record<string, (...a: never[]) => unknown> | undefined {
	try {
		const req = (window as unknown as { require?: (m: string) => unknown }).require;
		return req ? (req('electron') as { shell?: Record<string, (...a: never[]) => unknown> }).shell : undefined;
	} catch { return undefined; }
}

/** Hand a URI to the OS and report whether anything took it. Used for `obsidian://` links, where
 *  a false answer (Obsidian not installed, or the handler refused) is the signal to fall back to
 *  opening the file with its default application instead. */
export async function openUriWithHandler(uri: string): Promise<boolean> {
	const shell = electronShell() as { openExternal?: (u: string) => Promise<void> } | undefined;
	if (!shell?.openExternal) return false;
	try { await shell.openExternal(uri); return true; } catch { return false; }
}

/** Open a FILE with the OS default application. shell.openPath resolves to '' on success and to
 *  an error message otherwise, so an unreadable cloud placeholder reports rather than vanishing. */
export async function openPathWithDefaultApp(filePath: string): Promise<string> {
	const shell = electronShell() as { openPath?: (p: string) => Promise<string> } | undefined;
	if (!shell?.openPath) return 'not running under Electron';
	try { return await shell.openPath(filePath); } catch (e) { return (e as Error)?.message ?? String(e); }
}

/** Reveal a file in Finder/File Explorer with the file itself selected — unlike openPath, which
 *  would open the file in its default app. The secondary affordance for when Obsidian is not the
 *  right tool. */
export function showItemInFolder(filePath: string): boolean {
	const shell = electronShell() as { showItemInFolder?: (p: string) => void } | undefined;
	if (!shell?.showItemInFolder) return false;
	try { shell.showItemInFolder(filePath); return true; } catch { return false; }
}

/** Reveal a folder in Finder/File Explorer via Electron's shell — always available, no editor
 *  install required. Returns whether it looked like it worked (non-empty = an error message). */
export function revealInFileManager(path: string): boolean {
	try {
		const req = (window as unknown as { require?: (m: string) => unknown }).require;
		const shell = req ? (req('electron') as { shell?: { openPath?: (p: string) => Promise<string> } }).shell : undefined;
		if (shell?.openPath) { void shell.openPath(path); return true; }
	} catch { /* not running under Electron */ }
	return false;
}
