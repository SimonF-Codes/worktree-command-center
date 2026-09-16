import { execFile } from 'child_process';

/** One process as seen by a snapshot. `rssBytes` is the working set — what Task Manager
 *  calls "Memory (active private working set)"'s superset, and the only figure available
 *  without per-process queries. */
export interface ProcRow {
	pid: number;
	ppid: number;
	name: string;
	rssBytes: number;
	/** Only populated when the snapshot was taken with `withCommandLine`. */
	cmd?: string;
}

/** Sidecars are `node <…>/sidecar.cjs <cwd> <command> …`, so this identifies one. */
const SIDECAR_MARK = 'sidecar.cjs';

/** Take ONE snapshot of every process on the machine: pid, parent, working set, and
 *  optionally the command line.
 *
 *  A single spawned command returns everything, parentage included. That is deliberate and
 *  load-bearing: a memory tracker that spawned a process per session to count processes
 *  would be the bug it exists to report. Never throws — an unreadable snapshot yields [].
 *
 *  Windows-only (Win32_Process); other platforms return [] and callers degrade to showing
 *  nothing rather than guessing. */
export async function snapshotProcesses(opts: { withCommandLine?: boolean } = {}): Promise<ProcRow[]> {
	if (process.platform !== 'win32') return [];
	const fields = `ProcessId,ParentProcessId,Name,WorkingSetSize${opts.withCommandLine ? ',CommandLine' : ''}`;
	const script =
		'[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
		`Get-CimInstance Win32_Process | Select-Object ${fields} | ConvertTo-Json -Compress -Depth 2`;
	const raw = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
	return parseSnapshot(raw);
}

/** Parse the snapshot command's JSON. Exported for tests; tolerant by design — a snapshot
 *  that can't be read must degrade to "no data", never throw into a render loop. */
export function parseSnapshot(raw: string): ProcRow[] {
	let data: unknown;
	try { data = JSON.parse(raw); } catch { return []; }
	// ConvertTo-Json emits a bare object, not an array, when exactly one row matches.
	const rows = Array.isArray(data) ? data : [data];
	const out: ProcRow[] = [];
	for (const r of rows) {
		if (!r || typeof r !== 'object') continue;
		const o = r as Record<string, unknown>;
		const pid = num(o.ProcessId);
		if (pid === null) continue;
		out.push({
			pid,
			ppid: num(o.ParentProcessId) ?? 0,
			name: typeof o.Name === 'string' ? o.Name : '',
			rssBytes: num(o.WorkingSetSize) ?? 0,
			...(typeof o.CommandLine === 'string' ? { cmd: o.CommandLine } : {}),
		});
	}
	return out;
}

/** Sidecar processes sitting in the usage probe's dedicated cwd that no live probe owns.
 *
 *  Scoped to that one directory on purpose. A sidecar in a real worktree could be a live
 *  terminal belonging to a SECOND app instance (the dev and installed builds deliberately
 *  share one userData profile), and killing it would destroy someone's session. The probe
 *  cwd carries no such risk: only the probe ever runs there, and only one process at a time
 *  is ever legitimate.
 *
 *  A candidate is a stray when its parent is dead (left over from an earlier app run) or is
 *  this very process yet no live bridge claims it (leaked during this run). A sidecar owned
 *  by a different, still-running instance is left alone.
 */
export function findUsageProbeStrays(
	rows: readonly ProcRow[],
	probeCwd: string,
	appPid: number,
	ownedPids: readonly number[],
): number[] {
	const alive = new Set(rows.map((r) => r.pid));
	const owned = new Set(ownedPids);
	const needle = normPath(probeCwd);
	if (!needle) return [];
	return rows
		.filter((r) => {
			if (!r.cmd) return false;
			const cmd = normPath(r.cmd);
			if (!cmd.includes(SIDECAR_MARK) || !cmd.includes(needle)) return false;
			if (owned.has(r.pid)) return false;
			return !alive.has(r.ppid) || r.ppid === appPid;
		})
		.map((r) => r.pid);
}

/** Lowercase and forward-slash a path so command lines match regardless of how they were
 *  quoted or cased — Windows treats both as insignificant, and the match must too. */
function normPath(s: string): string {
	return s.replace(/\\/g, '/').toLowerCase();
}

function num(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function run(file: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(file, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
			resolve(err ? '' : stdout);
		});
	});
}
