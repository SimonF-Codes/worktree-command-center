import { spawn } from 'child_process';

/** Outcome of a verified tree-kill. On failure the pid is REPORTED BACK rather than
 *  swallowed, so the caller can keep hold of it and try again — a pid nobody remembers
 *  is a process nobody can kill. */
export type KillResult =
	| { ok: true; pid: number | null }
	| { ok: false; pid: number; detail: string };

/** taskkill's exit code for "the process is not there". That is the state we were asking
 *  for, so it counts as a confirmed kill rather than a failure. (Verified on this machine:
 *  `taskkill /pid <gone> /T /F` → exit 128, "ERROR: The process ... not found".) */
const TASKKILL_NOT_FOUND = 128;

/** Pids whose kill could NOT be confirmed, kept so a later sweep can retry them.
 *  This set is the difference between "we asked it to die" and "it died". */
export const unconfirmedKills = new Set<number>();

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Kill a process and its whole tree, and VERIFY the kill took effect — retrying once
 *  before giving up. Never throws.
 *
 *  The previous fire-and-forget version spawned `taskkill` and immediately forgot the pid,
 *  so a failure at any layer (taskkill missing from PATH, a non-zero exit, a pid that was
 *  never captured) was silent AND unrecoverable. Everything here exists to make that
 *  impossible: the exit code is read, stderr is kept for the message, and the caller is
 *  told whether it worked.
 *
 *  @param fallback POSIX only: kill the ChildProcess directly if the process-group kill
 *                  fails (a non-detached child has no group of its own).
 */
export async function killProcessTree(pid: number, fallback?: () => void): Promise<KillResult> {
	let last = await killOnce(pid, fallback);
	if (!last.ok) {
		await delay(250);
		last = await killOnce(pid, fallback);
	}
	if (last.ok) unconfirmedKills.delete(pid);
	else unconfirmedKills.add(pid);
	return last;
}

function killOnce(pid: number, fallback?: () => void): Promise<KillResult> {
	if (process.platform !== 'win32') return killPosix(pid, fallback);
	return new Promise<KillResult>((resolve) => {
		let settled = false;
		const done = (r: KillResult): void => { if (!settled) { settled = true; resolve(r); } };
		let err = '';
		const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
		// Drain both pipes: an unread pipe that fills would stall taskkill itself, and the
		// stderr text is the only explanation we get when a kill is refused.
		tk.stdout?.on('data', () => { /* drained, not needed */ });
		tk.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
		// spawn() can fail outright (e.g. taskkill not resolvable on PATH). That error was
		// previously not even listened for, which in Node means an unhandled 'error' event.
		tk.on('error', (e: Error) => done({ ok: false, pid, detail: `taskkill failed to start: ${e.message}` }));
		tk.on('exit', (code) => {
			if (code === 0 || code === TASKKILL_NOT_FOUND) done({ ok: true, pid });
			else done({ ok: false, pid, detail: `taskkill exit ${code}${err.trim() ? `: ${err.trim()}` : ''}` });
		});
	});
}

async function killPosix(pid: number, fallback?: () => void): Promise<KillResult> {
	try { process.kill(-pid, 'SIGKILL'); }
	catch { try { fallback?.(); } catch { /* already gone */ } }
	await delay(150);
	// Signal 0 tests for existence: it throws ESRCH once the process is really gone, which
	// is the confirmation we need. No extra process spawned.
	try { process.kill(pid, 0); }
	catch { return { ok: true, pid }; }
	return { ok: false, pid, detail: 'still alive after SIGKILL' };
}
