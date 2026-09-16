import { killProcessTree, unconfirmedKills } from './kill-tree';
import { findUsageProbeStrays, snapshotProcesses } from './process-snapshot';

export interface ReapReport {
	/** Pids found and confirmed dead. */
	reaped: number[];
	/** Pids that survived even a verified, retried kill — reported, never swallowed. */
	failed: Array<{ pid: number; detail: string }>;
}

/** Kill usage-probe sidecars that are alive but owned by nobody, plus any pid whose earlier
 *  kill was never confirmed.
 *
 *  Run at startup: every leaked probe process from a previous app run is still holding a
 *  `claude` (~250 MB) and will hold it until the machine reboots, because nothing in the new
 *  process knows its pid. This is the only thing that can free them.
 *
 *  Safe to run repeatedly — `ownedPids` protects live sessions, and a probe sidecar belonging
 *  to another running instance of the app is never touched (see findUsageProbeStrays).
 */
export async function reapUsageProbeStrays(
	probeCwd: string,
	ownedPids: readonly number[] = [],
	appPid: number = process.pid,
): Promise<ReapReport> {
	const rows = await snapshotProcesses({ withCommandLine: true });
	const strays = findUsageProbeStrays(rows, probeCwd, appPid, ownedPids);
	// Retry anything a previous kill could not confirm. Keeping these pids is the point of
	// tracking them: an unconfirmed kill that is also forgotten is just a leak with a log line.
	const retries = [...unconfirmedKills].filter((p) => !ownedPids.includes(p));
	const report: ReapReport = { reaped: [], failed: [] };
	for (const pid of new Set([...strays, ...retries])) {
		const r = await killProcessTree(pid);
		if (r.ok) report.reaped.push(pid);
		else report.failed.push({ pid, detail: r.detail });
	}
	return report;
}
