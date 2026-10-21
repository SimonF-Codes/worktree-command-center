import { execFileSync } from 'child_process';

// Is the app running? The worktrees CLI must not write the app's files while it does: persist()
// rewrites config.json and .terminal-sessions.json from the running app's memory, so an edit made
// from outside is silently overwritten — and a relayout that moved a worktree but lost its
// session record leaves a saved terminal pointing at a directory that is no longer there.
//
// Copied from C:/dev/scripts/repoint-verticalchess.mjs, including the lesson of its first
// version: `tasklist` truncates the image-name column to 25 characters, so the real output reads
// "Worktree Command Center.e" and a match on the full "Worktree Command Center.exe" never fired —
// it reported nothing running with the app plainly open. Match the stem. And a process list that
// cannot be read counts as RUNNING: refusing is the safe answer when the question is unanswered.

/** The installed app's executable. `WCC_APP_PROCESS` overrides it — a TEST SEAM, so a test can
 *  point the guard at a process it knows is running (node.exe) and prove the guard fires. */
export const APP_IMAGE = 'Worktree Command Center.exe';

export const appImage = (env: NodeJS.ProcessEnv = process.env): string => env.WCC_APP_PROCESS || APP_IMAGE;

/** The image name without its extension: what survives tasklist's truncation. */
export const imageStem = (image: string): string => image.replace(/\.exe$/i, '');

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does `tasklist /FI "IMAGENAME eq <image>" /NH` output show the process? Matches the stem —
 *  never the full name, which tasklist cuts off. The "INFO: No tasks are running…" line names no
 *  image, so it never matches. */
export function tasklistShows(output: string, image: string): boolean {
	return new RegExp(escapeRe(imageStem(image).slice(0, 25)), 'i').test(output);
}

/** `ps -A -o comm=` output (macOS, Linux): one executable path per line. */
export function psShows(output: string, image: string): boolean {
	const stem = imageStem(image).toLowerCase();
	return output.split('\n').some((l) => l.toLowerCase().includes(stem));
}

export type Exec = (file: string, args: string[]) => string;

const defaultExec: Exec = (file, args) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });

/** True when the app is running — or when the process list could not be read. */
export function appIsRunning(opts: { exec?: Exec; platform?: NodeJS.Platform; image?: string } = {}): boolean {
	const exec = opts.exec ?? defaultExec;
	const image = opts.image ?? appImage();
	try {
		if ((opts.platform ?? process.platform) === 'win32') return tasklistShows(exec('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH']), image);
		return psShows(exec('ps', ['-A', '-o', 'comm=']), image);
	} catch {
		return true; // can't tell → assume it IS running
	}
}

export const APP_RUNNING_REASON = 'Worktree Command Center is running (or the process list could not be read, which counts as running). '
	+ 'The app rewrites config.json and .terminal-sessions.json from memory when it persists, so an edit made now would be silently overwritten. '
	+ 'Close the app, then re-run. (Not detected: a dev build started with `npm start` runs as electron.exe — close that too.)';
