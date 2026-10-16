import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

// Why a directory would not move. Measured on this machine, four different causes, and the error
// text alone does not tell them apart:
//
//   cwd-holder      Permission denied   a process's working directory is inside it
//   service-handle  Permission denied   a service (antivirus, Search) holds the directory; its
//                                       contents stay writable; nothing built-in names it, a
//                                       reboot clears it
//   sync-engine     EBUSY               OneDrive or another sync engine
//   parent-missing  No such file…       `git worktree move` will not create the destination's
//                                       parent
//
// That table is git's wording. Node's own rename — the held-open probe — says something else for
// the SAME hold: a process's cwd inside the folder comes back as EBUSY, not EPERM (measured
// 2026-10-16: node EBUSY, `git worktree move` "Permission denied", one held directory). So no
// errno is trusted to name the cause. Every hold is split the same way, strongest evidence first:
//   1. who has their cwd there — find-cwd-holder.ps1 (copied beside this CLI from
//      C:/dev/scripts, where it was validated) reads each process's current directory out of its
//      PEB, the only place it lives. NOT who-holds.ps1: it is blind to directory handles and said
//      "no holders" for a directory that was definitely held;
//   2. whether the folder sits under a sync root (the OneDrive* environment variables), or git
//      itself said "Device or resource busy" — the sync engine's measured signature;
//   3. otherwise, a service's handle on the directory.

export type FailureMode = 'cwd-holder' | 'service-handle' | 'sync-engine' | 'parent-missing';

export interface Diagnosis {
	/** null when the error is none of the four, or when Permission denied could not be split
	 *  (the detector could not run) — the message then names both candidates. */
	mode: FailureMode | null;
	message: string;
}

export type ErrorKind = 'EBUSY' | 'EPERM' | 'ENOENT';

/** Which of the three errno families an error message is. */
export function errorKind(text: string): ErrorKind | null {
	if (/resource busy|EBUSY/i.test(text)) return 'EBUSY';
	if (/permission denied|EPERM|EACCES|access is denied/i.test(text)) return 'EPERM';
	if (/no such file or directory|ENOENT|cannot find the path/i.test(text)) return 'ENOENT';
	return null;
}

/** What find-cwd-holder.ps1 found: the processes whose cwd is inside, and how many it could not
 *  read (a holder could be among those). */
export interface CwdScan { holders: string[]; unreadable: number }

/** Parse find-cwd-holder.ps1's output. */
export function parseCwdHolderOutput(out: string): CwdScan {
	const holders: string[] = [];
	for (const l of out.split('\n')) {
		const m = /^\s+pid (\d+)\s+(.+?)\s*$/.exec(l.replace(/\r$/, ''));
		if (m) holders.push(`${m[2]} (pid ${m[1]})`);
	}
	const u = /(\d+) could not be read/.exec(out);
	return { holders, unreadable: u ? parseInt(u[1]!, 10) : 0 };
}

export interface DiagnoseDeps {
	/** Who has their cwd inside `dir`; null when that cannot be asked (not Windows, no script). */
	findCwdHolders: (dir: string) => Promise<CwdScan | null>;
	/** Can a file be created and deleted inside `dir` right now? null = could not tell. */
	contentsWritable: (dir: string) => boolean | null;
	/** Folders a sync engine owns (OneDrive's roots). */
	syncRoots: string[];
}

const inside = (p: string, dir: string): boolean => {
	const a = path.resolve(p).toLowerCase(), d = path.resolve(dir).toLowerCase().replace(/[\\/]+$/, '');
	return a === d || a.startsWith(d + path.sep);
};

/** Name the failure mode of an error that happened moving `dir` to `dest`. `text` is git's
 *  message or the Node probe's bare code. */
export async function diagnose(text: string, dir: string, dest: string | null, deps: DiagnoseDeps): Promise<Diagnosis> {
	const kind = errorKind(text);
	if (kind === 'ENOENT') {
		const parent = dest ? path.dirname(dest) : null;
		return { mode: 'parent-missing', message: `No such file or directory: ${parent ? `the destination's parent ${parent} is missing, and` : 'a destination parent is missing, and'} git worktree move will not create it. Create it, then re-run.` };
	}
	if (!kind) return { mode: null, message: text };
	const scan = await deps.findCwdHolders(dir).catch(() => null);
	if (scan && scan.holders.length) return { mode: 'cwd-holder', message: `Held: ${scan.holders.join(', ')} ${scan.holders.length === 1 ? 'has its' : 'have their'} working directory inside ${dir}. Exit ${scan.holders.length === 1 ? 'it' : 'them'} (or cd out), then re-run.` };
	const root = deps.syncRoots.find((r) => inside(dir, r));
	if (root || /resource busy/i.test(text)) {
		return { mode: 'sync-engine', message: `${dir} is busy: ${root ? `it is inside ${root}, which` : 'git says "Device or resource busy", the signature of'} a sync engine such as OneDrive${root ? ' syncs' : ''}. Pause syncing, or keep worktrees out of synced folders.` };
	}
	if (scan) {
		const w = deps.contentsWritable(dir);
		return {
			mode: 'service-handle',
			message: `Held, but no process has its working directory inside ${dir}${scan.unreadable ? ` (${scan.unreadable} processes could not be read, so not certain)` : ''} — a service (antivirus, Windows Search) holds a handle on the directory itself${w === true ? '; its contents are still writable, which fits' : w === false ? '; its contents are not writable either, which does not fit — look closer' : ''}. Nothing built-in names the holder; a reboot clears it.`,
		};
	}
	return { mode: null, message: `${dir} cannot be renamed (${text}): either a process's working directory is inside it, or a service (antivirus, Windows Search) holds the directory — the cwd detector could not run here to tell which. C:/dev/scripts/find-cwd-holder.ps1 names a cwd holder; if it finds none, a reboot clears the other.` };
}

// ---------------------------------------------------------------------------------------------
// The real detectors

/** find-cwd-holder.ps1: beside the bundled CLI in pty-sidecar/, or found from the source tree
 *  when running unbundled (tests). */
export function cwdHolderScript(): string | null {
	const here = typeof __dirname === 'string' ? __dirname : process.cwd();
	for (const p of [path.join(here, 'find-cwd-holder.ps1'), path.join(here, '..', '..', 'pty-sidecar', 'find-cwd-holder.ps1')]) {
		if (fs.existsSync(p)) return p;
	}
	return null;
}

export function realFindCwdHolders(script: string | null = cwdHolderScript()): (dir: string) => Promise<CwdScan | null> {
	return (dir) => new Promise((resolve) => {
		if (process.platform !== 'win32' || !script) { resolve(null); return; }
		execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, dir], { encoding: 'utf8', windowsHide: true, timeout: 120000 }, (err, stdout) => {
			if (err || !/scanned \d+ processes/.test(stdout)) { resolve(null); return; }
			resolve(parseCwdHolderOutput(stdout));
		});
	});
}

export function realContentsWritable(dir: string): boolean | null {
	if (!fs.existsSync(dir)) return null;
	const f = path.join(dir, `.wcc-write-probe-${process.pid}`);
	try { fs.writeFileSync(f, ''); fs.unlinkSync(f); return true; } catch { return false; }
}

/** OneDrive's roots, from the variables its client sets. */
export function syncRootsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
	return [...new Set(['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'].map((k) => env[k]).filter((v): v is string => !!v))];
}

export const realDiagnoseDeps = (): DiagnoseDeps => ({ findCwdHolders: realFindCwdHolders(), contentsWritable: realContentsWritable, syncRoots: syncRootsFromEnv() });
