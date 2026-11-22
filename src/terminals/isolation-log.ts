// The IO half of isolation.jsonl: one append per spawn decision, into the coordination directory.
// The record's shape and its formatting are pure (core/isolation.ts isolationRecord /
// formatIsolationLine); this only appends.
//
// Append-only on purpose (V2 design D2): `persist()` rewrites config.json and the sessions file
// from memory, so CLI-writable state lives in append-only coordination files instead. One short
// line per append, so concurrent spawns from different workspaces interleave by whole lines.
import * as fs from 'fs';
import * as path from 'path';
import { formatIsolationLine, type IsolationRecord } from '../core/isolation';

export const ISOLATION_LOG = 'isolation.jsonl';

/** Append one decision. Never throws: the log is a measurement, and a spawn must not fail
 *  because the measurement could not be written. Returns whether it was. */
export function appendIsolationRecord(coordDir: string, record: IsolationRecord): boolean {
	try {
		fs.mkdirSync(coordDir, { recursive: true });
		fs.appendFileSync(path.join(coordDir, ISOLATION_LOG), formatIsolationLine(record), 'utf8');
		return true;
	} catch (e) {
		console.warn(`[isolation] could not append to ${path.join(coordDir, ISOLATION_LOG)}: ${(e as Error)?.message ?? e}`);
		return false;
	}
}

/** Read the log back, skipping any line that is not a record (a torn write, a hand edit). */
export function readIsolationLog(coordDir: string): IsolationRecord[] {
	let text = '';
	try { text = fs.readFileSync(path.join(coordDir, ISOLATION_LOG), 'utf8'); } catch { return []; }
	const out: IsolationRecord[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const r = JSON.parse(line) as IsolationRecord;
			if (r && r.v === 1 && typeof r.ok === 'boolean') out.push(r);
		} catch { /* skip */ }
	}
	return out;
}
