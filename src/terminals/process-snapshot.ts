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
	/** Win32 creation time, epoch ms. Absent only when the snapshot could not read it.
	 *
	 *  Carried so a process can be IDENTIFIED across polls: Windows recycles pids, and anything
	 *  that accumulates state against a bare pid (an age, a strike count) hands that state to
	 *  whatever inherits the number next. pid + `startedAt` cannot be inherited. */
	startedAt?: number;
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
	// CreationDate rides along in the SAME query. The rule this tracker is built on is that it
	// never runs two Win32_Process queries — a memory tracker that spawned a second PowerShell
	// just to ask when things started would be the bug it exists to report.
	const fields = `ProcessId,ParentProcessId,Name,WorkingSetSize,CreationDate${opts.withCommandLine ? ',CommandLine' : ''}`;
	const script =
		'[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
		`Get-CimInstance Win32_Process | Select-Object ${fields} | ConvertTo-Json -Compress -Depth 2`;
	const { raw, pid } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
	// The snapshot is taken by a child of THIS process, so it is in its own results — roughly
	// 85 MB of PowerShell and its conhost, parented to the app, owned by no session. Left in, it
	// would land in "unattributed" on every single poll: the measuring tool reporting itself as
	// a leak, and the one row that must be trusted crying wolf every 20 seconds.
	return excludeSubtree(parseSnapshot(raw), pid);
}

/** Drop `root` and everything beneath it. Exported for tests; an absent root is a no-op. */
export function excludeSubtree(rows: readonly ProcRow[], root: number | undefined): ProcRow[] {
	if (root === undefined) return [...rows];
	const doomed = new Set(subtreePids(indexProcesses(rows), root));
	return rows.filter((r) => !doomed.has(r.pid));
}

/** A snapshot indexed for subtree walks: pid → row, and parent → children. */
export interface ProcIndex {
	byPid: Map<number, ProcRow>;
	kids: Map<number, number[]>;
}

/** Index a snapshot once so many subtrees can be walked without rebuilding the parent map. */
export function indexProcesses(rows: readonly ProcRow[]): ProcIndex {
	const byPid = new Map<number, ProcRow>();
	const kids = new Map<number, number[]>();
	for (const r of rows) {
		byPid.set(r.pid, r);
		if (r.pid === r.ppid) continue; // a self-parented row would make the walk never finish
		const list = kids.get(r.ppid);
		if (list) list.push(r.pid);
		else kids.set(r.ppid, [r.pid]);
	}
	return { byPid, kids };
}

/** Every pid at or below `root`, or [] if the root is not in the snapshot.
 *
 *  Iterative with a seen-set: the OS recycles pids, so a snapshot's parent map can contain a
 *  cycle, and a recursive walk would blow the stack inside a render loop. */
export function subtreePids(ix: ProcIndex, root: number): number[] {
	if (!ix.byPid.has(root)) return [];
	const out: number[] = [];
	const seen = new Set<number>();
	const stack = [root];
	while (stack.length) {
		const p = stack.pop()!;
		if (seen.has(p)) continue;
		seen.add(p);
		out.push(p);
		for (const c of ix.kids.get(p) ?? []) stack.push(c);
	}
	return out;
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
		const startedAt = cimDate(o.CreationDate);
		out.push({
			pid,
			ppid: num(o.ParentProcessId) ?? 0,
			name: typeof o.Name === 'string' ? o.Name : '',
			rssBytes: num(o.WorkingSetSize) ?? 0,
			...(typeof o.CommandLine === 'string' ? { cmd: o.CommandLine } : {}),
			...(startedAt === null ? {} : { startedAt }),
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

/** A CIM DateTime, as JSON, in epoch ms.
 *
 *  Windows PowerShell 5.1 — which is what the snapshot spawns — renders a DateTime through
 *  ConvertTo-Json as Microsoft's `/Date(1789453890660)/`, sometimes with a `+0100` suffix that
 *  names a zone without moving the instant. PowerShell 7 renders ISO 8601 instead; both are read
 *  here so the field cannot silently go missing if this is ever run under `pwsh`. An
 *  unrecognised shape yields null rather than a guess: a wrong timestamp here is not a wrong
 *  age, it is a wrong IDENTITY, and callers are then free to refuse a process they cannot name. */
export function cimDate(v: unknown): number | null {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v !== 'string') return null;
	const ms = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(v);
	if (ms) return Number(ms[1]);
	const iso = Date.parse(v);
	return Number.isFinite(iso) ? iso : null;
}

function num(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Run the snapshot command, reporting its pid alongside its output so the measurement can be
 *  subtracted from its own result. */
function run(file: string, args: string[]): Promise<{ raw: string; pid: number | undefined }> {
	return new Promise((resolve) => {
		const child = execFile(file, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
			resolve({ raw: err ? '' : stdout, pid: child.pid });
		});
	});
}
