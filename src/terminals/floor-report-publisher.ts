import * as path from 'path';
import { SerialWriter } from '../serial-writer';
import { renderFloorReport, type FloorReport } from './floor-report';

/** The file operations the publisher needs, injectable so its IO is testable without a disk. */
export interface PublishFs {
	mkdir(dir: string): Promise<void>;
	writeFile(file: string, data: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}

export interface FloorReportPublisherDeps {
	/** Builds the report from what the app already holds. Called once per publish. */
	gather: () => Promise<FloorReport>;
	/** The in-app copy's folder: `<userData>/.coordination`, the parent of every tab's coord dir,
	 *  so `$COS_COORD_DIR/../floor-report.json` finds it from any session. */
	coordRoot: string;
	fs: PublishFs;
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

/** Rebuilds and writes the floor report. Refreshes ride on the grid's existing worktree scan and
 *  on the 📊 Report button — this class owns no timer. Publishes are serialized, so an on-demand
 *  one landing on top of a scan's cannot interleave their writes. */
export class FloorReportPublisher {
	private writer = new SerialWriter();
	private last: FloorReport | null = null;

	constructor(private deps: FloorReportPublisherDeps) {}

	/** The newest report, or null before the first publish. */
	latest(): FloorReport | null { return this.last; }

	/** Resolves with the report it published, or null when building it failed. Never throws:
	 *  a reporting failure must not reach the scan or the button that asked for it. */
	publish(): Promise<FloorReport | null> {
		let out: FloorReport | null = null;
		return this.writer.push(async () => {
			let report: FloorReport;
			try { report = await this.deps.gather(); } catch (e) { console.error('[wcc] floor report could not be built:', e); return; }
			this.last = report;
			out = report;
			await writeReportPair(this.deps.coordRoot, renderFloorReport(report), this.deps.fs);
		}).then(() => out);
	}
}
