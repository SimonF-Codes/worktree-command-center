// Is a Windows process with this exact image name running?
//
// Split out of install-local.mjs so the parse can be unit-tested without running the
// installer. The obvious `tasklist /FI "IMAGENAME eq X"` + `stdout.includes(X)` never
// matches a long name: tasklist's default table truncates the Image Name column to 25
// characters ("Worktree Command Center.e"), so the check reads "not running" while the
// app is up. CSV output (/FO CSV /NH) prints the full name, quoted, one process a row.
import { spawnSync } from 'child_process';

/** Parse `tasklist /FO CSV /NH` output: true when any row's first field is `exe`. */
export function csvHasImage(stdout, exe) {
	const want = exe.toLowerCase();
	return String(stdout ?? '').split(/\r?\n/).some((line) => {
		const m = /^"([^"]*)"/.exec(line.trim());
		return !!m && m[1].toLowerCase() === want;
	});
}

/** True when `exe` is running. Unknown (tasklist failed to start) reads as running, so a
 *  guard built on this refuses rather than proceeding blind. */
export function isImageRunning(exe, run = spawnSync) {
	const r = run('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
	if (r.error || r.status !== 0) return true;
	return csvHasImage(r.stdout, exe);
}
