import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	AttentionRecorder, attentionIntervals, blockedMs, blockedNow, parseAttentionLog, formatAttentionLines, type AttentionLine,
} from '../src/core/attention-log';
import { appendAttentionLines, readAttentionLog, ATTENTION_LOG } from '../src/terminals/attention-log';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'attn-')); dirs.push(d); return d; };

describe('AttentionRecorder — transitions, not ticks', () => {
	it('a state that persists is one line, however many ticks see it', () => {
		const r = new AttentionRecorder();
		const out: AttentionLine[] = [];
		for (let s = 0; s < 3600; s++) out.push(...r.observe('s1', 'wt-1', 'input', s * 1000));
		// one boot line, then the first sighting — and nothing for the other 3599 ticks
		expect(out).toEqual([
			{ v: 1, ts: 0, ev: 'boot' },
			{ v: 1, ts: 0, sessionId: 's1', name: 'wt-1', from: null, to: 'input' },
		]);
		expect(r.observe('s1', 'wt-1', 'none', 3_600_000)).toEqual([{ v: 1, ts: 3_600_000, sessionId: 's1', name: 'wt-1', from: 'input', to: 'none' }]);
	});

	it('boots once per process, before its first line only', () => {
		const r = new AttentionRecorder();
		expect(r.observe('a', 'A', 'none', 5).filter((l) => 'ev' in l)).toHaveLength(1);
		expect(r.observe('b', 'B', 'none', 6).filter((l) => 'ev' in l)).toHaveLength(0);
	});

	it('closes a session that left the stage, and everything on unmount or quit', () => {
		const r = new AttentionRecorder();
		r.observe('a', 'A', 'help', 1); r.observe('b', 'B', 'done', 1);
		expect(r.forgetMissing(new Set(['b']), 9)).toEqual([{ v: 1, ts: 9, sessionId: 'a', name: 'A', from: 'help', to: 'unobserved', why: 'gone' }]);
		expect(r.unobserveAll(12, 'unmounted')).toEqual([{ v: 1, ts: 12, sessionId: 'b', name: 'B', from: 'done', to: 'unobserved', why: 'unmounted' }]);
		expect(r.unobserveAll(13, 'quit')).toEqual([]); // nothing left open
		// remounted: the next sighting is a fresh one
		expect(r.observe('b', 'B', 'done', 20)).toEqual([{ v: 1, ts: 20, sessionId: 'b', name: 'B', from: null, to: 'done' }]);
	});
});

describe('reading attention.jsonl', () => {
	const tr = (ts: number, sessionId: string, to: string, from: string | null = null): AttentionLine => ({ v: 1, ts, sessionId, name: sessionId.toUpperCase(), from, to } as AttentionLine);

	it('sums only the blocked buckets, clipped to the window', () => {
		const lines = [tr(0, 'a', 'input'), tr(100, 'a', 'none'), tr(150, 'a', 'help'), tr(200, 'a', 'done'), tr(50, 'b', 'help'), tr(70, 'b', 'unobserved')];
		const { intervals, unknownEnd } = attentionIntervals(lines, 1000);
		expect(unknownEnd).toBe(0);
		expect(blockedMs(intervals, 0, 1000)).toBe(100 + 50 + 20);
		expect(blockedMs(intervals, 60, 160)).toBe(40 + 10 + 10);
	});

	it('an interval the previous process never closed has an unknown end — counted as unknown, never stretched', () => {
		const lines: AttentionLine[] = [{ v: 1, ts: 0, ev: 'boot' }, tr(10, 'a', 'input'), { v: 1, ts: 10_000_000, ev: 'boot' }, tr(10_000_005, 'a', 'none')];
		const { intervals, unknownEnd } = attentionIntervals(lines, 10_000_010);
		expect(unknownEnd).toBe(1);
		expect(blockedMs(intervals, 0, 10_000_010)).toBe(0); // not the ~2.8 hours between the two boots
	});

	it('the newest open interval runs to now', () => {
		const { intervals } = attentionIntervals([tr(100, 'a', 'input')], 400);
		expect(blockedMs(intervals, 0, 400)).toBe(300);
	});

	it('blocked now: the newest line per session, and nothing from before the last boot', () => {
		const lines: AttentionLine[] = [tr(0, 'a', 'input'), tr(5, 'b', 'help'), tr(6, 'b', 'none'), tr(7, 'c', 'help')];
		expect(blockedNow(lines).map((x) => x.sessionId).sort()).toEqual(['a', 'c']);
		expect(blockedNow([...lines, { v: 1, ts: 8, ev: 'boot' }])).toEqual([]);
	});

	it('round-trips through the file, skipping torn and foreign lines', () => {
		const dir = path.join(tmp(), 'ws');
		const r = new AttentionRecorder();
		expect(appendAttentionLines(dir, r.observe('a', 'A', 'input', 1))).toBe(true);
		fs.appendFileSync(path.join(dir, ATTENTION_LOG), '{"v":1,"ts":2,"sessionId":"a","to":"inp\n{"v":1,"ts":3,"sessionId":"a","to":"weird"}\n');
		appendAttentionLines(dir, r.observe('a', 'A', 'none', 4));
		expect(readAttentionLog(dir).map((l) => ('ev' in l ? 'boot' : l.to))).toEqual(['boot', 'input', 'none']);
		expect(readAttentionLog(path.join(dir, 'missing'))).toEqual([]);
		expect(parseAttentionLog(formatAttentionLines([tr(1, 'z', 'done')]))).toHaveLength(1);
	});
});
