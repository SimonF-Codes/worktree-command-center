import { execFile } from 'child_process';
import type { ProcRow } from './process-snapshot';
import { parseServiceSnapshot, type ServiceSnapshot } from './system-memory';

/** Which services are running in which process, plus the registered WSL distros — ONE spawned
 *  command, asked only while the System view is open.
 *
 *  This is `Win32_Service`, a different class from the monitor's `Win32_Process`, so it is not
 *  the duplicate snapshot the one-poller rule forbids; it is still a PowerShell spawn costing
 *  about what a process snapshot does, which is why nothing asks for it while nobody is looking.
 *
 *  STRICTLY READ-ONLY. Nothing in this app stops, disables or kills a Windows service: ending a
 *  session is reversible, stopping a service can take audio, networking or the firewall down with
 *  no undo. The query selects four fields and returns. Never throws — an unreadable answer is null. */
export async function snapshotServices(): Promise<ServiceSnapshot | null> {
	if (process.platform !== 'win32') return null;
	// The Lxss key not existing means no distro has ever been registered: an empty list, not an error.
	const script =
		'[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
		'$s=@(Get-CimInstance Win32_Service -Filter "ProcessId > 0" | Select-Object Name,DisplayName,ProcessId,PathName);' +
		'$w=@();try{$w=@(Get-ChildItem "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss" -ErrorAction Stop' +
		' | ForEach-Object { $_.GetValue("DistributionName") } | Where-Object { $_ })}catch [System.Management.Automation.ItemNotFoundException]{$w=@()}catch{$w=$null};' +
		'ConvertTo-Json -Compress -Depth 3 -InputObject ([pscustomobject]@{services=$s;wsl=$w})';
	return new Promise((resolve) => {
		execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
			{ windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
			(err, stdout) => resolve(err ? null : parseServiceSnapshot(stdout)));
	});
}

/** Services move far slower than memory does. Re-ask at most this often even when the process
 *  snapshot shows an svchost the last answer did not know about. */
export const SERVICE_MIN_AGE_MS = 60_000;
/** …and unconditionally after this long, so a service that moved between existing hosts is
 *  eventually seen. */
export const SERVICE_MAX_AGE_MS = 5 * 60_000;

/** Should the service map be asked again? Pure.
 *
 *  An svchost pid the map has never heard of is the signal — a service started — but some hosts
 *  never appear in Win32_Service at all, so that signal alone would re-query every poll. Hence
 *  the floor of SERVICE_MIN_AGE_MS under it. */
export function servicesStale(
	rows: readonly ProcRow[],
	svc: ServiceSnapshot | null,
	fetchedAt: number | null,
	now: number,
): boolean {
	if (!svc || fetchedAt === null) return true;
	const age = now - fetchedAt;
	if (age >= SERVICE_MAX_AGE_MS) return true;
	if (age < SERVICE_MIN_AGE_MS) return false;
	const known = new Set(svc.services.map((s) => s.pid));
	return rows.some((r) => r.name.toLowerCase() === 'svchost.exe' && !known.has(r.pid));
}

/** The System view's service map: held only while the view is open, asked again only when
 *  servicesStale() says so, and never two queries at once. */
export class ServiceCache {
	private svc: ServiceSnapshot | null = null;
	private at: number | null = null;
	private inFlight: Promise<ServiceSnapshot | null> | null = null;
	private generation = 0;

	constructor(
		private query: () => Promise<ServiceSnapshot | null> = snapshotServices,
		private now: () => number = Date.now,
	) {}

	latest(): ServiceSnapshot | null { return this.svc; }

	/** Refresh if stale (or `force`), resolving to the map to render with. A failed query keeps
	 *  the previous answer rather than blanking every service name. */
	refresh(rows: readonly ProcRow[], force = false): Promise<ServiceSnapshot | null> {
		if (this.inFlight) return this.inFlight;
		if (!force && !servicesStale(rows, this.svc, this.at, this.now())) return Promise.resolve(this.svc);
		const gen = this.generation;
		const p = this.query().then((s) => {
			if (gen !== this.generation) return null; // the view closed while it was in flight
			if (s) { this.svc = s; this.at = this.now(); }
			return this.svc;
		}, () => this.svc).finally(() => { if (gen === this.generation) this.inFlight = null; });
		this.inFlight = p;
		return p;
	}

	/** The view closed: drop the map, so reopening asks afresh rather than showing a stale one. */
	clear(): void {
		this.generation++;
		this.svc = null;
		this.at = null;
		this.inFlight = null;
	}
}
