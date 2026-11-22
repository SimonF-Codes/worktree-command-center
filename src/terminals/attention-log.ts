// The IO half of attention.jsonl: append the recorder's lines into the coordination directory,
// and read them back. What to write is decided in core/attention-log.ts (AttentionRecorder); this
// only appends. The model is isolation-log.ts.
//
// Append-only on purpose (V2 design D2): persist() rewrites config.json and the sessions file from
// memory, so floor state that outlives the app lives in append-only coordination files. The lines
// keep being written whether or not the Project panel is on (`v2.projectPanel`), so the data
// accumulates and turning the panel on later has history to show.
import * as fs from 'fs';
import * as path from 'path';
import { formatAttentionLines, parseAttentionLog, type AttentionLine } from '../core/attention-log';

export const ATTENTION_LOG = 'attention.jsonl';

/** Append a batch of lines in one write. Never throws: the log is a measurement, and the attention
 *  tick must not fail because the measurement could not be written. Returns whether it was. */
export function appendAttentionLines(coordDir: string, lines: readonly AttentionLine[]): boolean {
	if (!lines.length) return true;
	try {
		fs.mkdirSync(coordDir, { recursive: true });
		fs.appendFileSync(path.join(coordDir, ATTENTION_LOG), formatAttentionLines(lines), 'utf8');
		return true;
	} catch (e) {
		console.warn(`[attention] could not append to ${path.join(coordDir, ATTENTION_LOG)}: ${(e as Error)?.message ?? e}`);
		return false;
	}
}

/** Read the log back, skipping any line that is not one (a torn write, a hand edit). */
export function readAttentionLog(coordDir: string): AttentionLine[] {
	try { return parseAttentionLog(fs.readFileSync(path.join(coordDir, ATTENTION_LOG), 'utf8')); } catch { return []; }
}
