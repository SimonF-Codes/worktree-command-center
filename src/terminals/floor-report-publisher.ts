import * as path from 'path';
import { SerialWriter } from '../serial-writer';
import { renderFloorReport, type FloorReport } from './floor-report';

/** The file operations the publisher needs, injectable so its IO is testable without a disk. */
export interface PublishFs {
	mkdir(dir: string): Promise<void>;
	writeFile(file: string, data: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}

/** The only two operations the vault copy is allowed: ask whether a folder exists, and
 *  overwrite a file. No mkdir, no rename, no delete — see writeVaultReport. */
export interface VaultFs {
	isDirectory(dir: string): Promise<boolean>;
	writeFile(file: string, data: string): Promise<void>;
}

/** The two vault files, and the folder they must already sit in. */
export interface VaultTarget { dir: string; markdown: string; json: string }

export interface FloorReportPublisherDeps {
	/** Builds the report from what the app already holds. Called once per publish. */
	gather: () => Promise<FloorReport>;
	/** The in-app copy's folder: `<userData>/.coordination`, the parent of every tab's coord dir,
	 *  so `$COS_COORD_DIR/../floor-report.json` finds it from any session. */
	coordRoot: string;
	fs: PublishFs;
	/** The vault copy. Absent, or a null target, means the vault write is off. */
	vault?: { target: VaultTarget | null; fs: VaultFs };
	now?: () => number;
}

export const FLOOR_REPORT_JSON = 'floor-report.json';
export const FLOOR_REPORT_MD = 'floor-report.md';

/** Write both renderings into `dir`, each via a temp file and a rename, so a tool reading
 *  `floor-report.json` mid-refresh sees the old report or the new one, never half of one.
 *  Returns false on any failure — never throws. */
export async function writeReportPair(dir: string, rendered: { json: string; markdown: string }, fsx: PublishFs): Promise<boolean> {
	try {
		await fsx.mkdir(dir);
		for (const [name, body] of [[FLOOR_REPORT_JSON, rendered.json], [FLOOR_REPORT_MD, rendered.markdown]] as const) {
			const dest = path.join(dir, name);
			await fsx.writeFile(`${dest}.tmp`, body);
			await fsx.rename(`${dest}.tmp`, dest);
		}
		return true;
	} catch {
		return false;
	}
}

/** Where the vault copy goes: `<vault>/Personal/Code/Floor Report.md` + `floor-report.json`.
 *
 *  Derived from config.json's `roleLibrary.path` rather than a second vault setting, because the
 *  role library already IS the app's pointer into the vault. Strictly: the path must end in
 *  `_meta/agents`, and the vault root is the folder above `_meta`. Any other role-library path
 *  turns the vault write OFF rather than guessing where the vault's root is — a guessed root is
 *  how a file lands somewhere in a vault nobody asked for. No role library: off, the same way
 *  role loading is. */
export function vaultReportTarget(roleLibraryPath: string | undefined): VaultTarget | null {
	if (!roleLibraryPath || !roleLibraryPath.trim()) return null;
	const parts = roleLibraryPath.trim().replace(/\\/g, '/').replace(/\/+$/, '').split('/');
	if (parts.length < 3) return null;
	if (parts[parts.length - 1]!.toLowerCase() !== 'agents' || parts[parts.length - 2]!.toLowerCase() !== '_meta') return null;
	const dir = path.join(parts.slice(0, -2).join('/'), 'Personal', 'Code');
	return { dir, markdown: path.join(dir, 'Floor Report.md'), json: path.join(dir, FLOOR_REPORT_JSON) };
}

/** The vault copy's own throttle, separate from the refresh: the in-app report may refresh every
 *  30s, but the vault is in OneDrive and Brain 2.0 indexes it, so a note rewritten every 30s
 *  thrashes sync and re-triggers the indexer continuously. */
export const VAULT_WRITE_MIN_INTERVAL_MS = 5 * 60_000;

/** Whether this publish should also write the vault. The 📊 Report button always may — that is
 *  someone asking for it now; a scan-driven refresh only once the interval has passed. Measured
 *  from the last ATTEMPT, so a vault that keeps failing is retried at the same slow pace, never
 *  every scan. */
export function vaultWriteDue(lastAttemptAt: number | null, now: number, onDemand: boolean): boolean {
	if (onDemand || lastAttemptAt === null) return true;
	return now - lastAttemptAt >= VAULT_WRITE_MIN_INTERVAL_MS;
}

/** THE APP'S ONLY WRITE INTO THE VAULT. It overwrites exactly two files and touches nothing else:
 *
 *  - It never creates a folder. If `Personal/Code` is not there, this vault is not laid out the
 *    way the target assumes, and writing is off.
 *  - It writes in place — no temp file and rename, which would put a third file in a synced,
 *    indexed folder, however briefly.
 *  - Every failure is swallowed and returns false: an online-only OneDrive placeholder, a file
 *    Obsidian has locked, a vault that is not there. None of that may ever break the report or
 *    the app. Callers decide what to log. */
export async function writeVaultReport(target: VaultTarget | null, rendered: { json: string; markdown: string }, fsx: VaultFs): Promise<boolean> {
	if (!target) return false;
	try {
		if (!(await fsx.isDirectory(target.dir))) return false;
		await fsx.writeFile(target.json, rendered.json);
		await fsx.writeFile(target.markdown, rendered.markdown);
		return true;
	} catch {
		return false;
	}
}

/** Rebuilds and writes the floor report. Refreshes ride on the grid's existing worktree scan and
 *  on the 📊 Report button — this class owns no timer. In-app publishes are serialized, so an
 *  on-demand one landing on top of a scan's cannot interleave their writes. */
export class FloorReportPublisher {
	private writer = new SerialWriter();
	private last: FloorReport | null = null;
	private vaultAttemptAt: number | null = null;
	private vaultInFlight: Promise<boolean> | null = null;

	constructor(private deps: FloorReportPublisherDeps) {}

	/** The newest report, or null before the first publish. */
	latest(): FloorReport | null { return this.last; }

	/** Resolves with the report it published, or null when building it failed. Never throws:
	 *  a reporting failure must not reach the scan or the button that asked for it.
	 *
	 *  Resolves once the IN-APP copy is written. The vault copy, when due, is started alongside and
	 *  deliberately not awaited, nor queued behind the in-app chain: a OneDrive write that stalls
	 *  must not hold up every refresh after it. */
	publish(opts: { onDemand?: boolean } = {}): Promise<FloorReport | null> {
		let out: FloorReport | null = null;
		return this.writer.push(async () => {
			let report: FloorReport;
			try { report = await this.deps.gather(); } catch (e) { console.error('[wcc] floor report could not be built:', e); return; }
			this.last = report;
			out = report;
			const rendered = renderFloorReport(report);
			await writeReportPair(this.deps.coordRoot, rendered, this.deps.fs);
			this.maybeWriteVault(rendered, opts.onDemand === true);
		}).then(() => out);
	}

	/** Resolves when any vault write in flight has finished — for tests and teardown. */
	vaultSettled(): Promise<boolean | null> { return this.vaultInFlight ?? Promise.resolve(null); }

	private maybeWriteVault(rendered: { json: string; markdown: string }, onDemand: boolean): void {
		const vault = this.deps.vault;
		if (!vault?.target) return;
		if (this.vaultInFlight) return; // still writing the last one — never stack writes on a slow disk
		const now = (this.deps.now ?? Date.now)();
		if (!vaultWriteDue(this.vaultAttemptAt, now, onDemand)) return;
		this.vaultAttemptAt = now;
		const target = vault.target;
		this.vaultInFlight = writeVaultReport(target, rendered, vault.fs).then((ok) => {
			if (!ok) console.warn(`[wcc] floor report: vault copy not written to ${target.dir} (missing, locked or offline) — the in-app copy is unaffected`);
			return ok;
		}).finally(() => { this.vaultInFlight = null; });
	}
}
