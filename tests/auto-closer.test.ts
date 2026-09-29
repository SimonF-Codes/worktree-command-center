import { describe, it, expect } from 'vitest';
import { AutoCloser, type AutoCloseNotice } from '../src/terminals/auto-closer';
import { parseAutoClose, AUTO_CLOSE_WARN_MS, type AutoCloseConfig, type SessionFacts } from '../src/terminals/auto-close';
import type { MemoryReport, MemoryRow } from '../src/terminals/session-memory';
import type { NoticeView } from '../src/terminals/auto-close';

const HOUR = 60 * 60_000;
const T0 = 1_700_000_000_000;

const FINISHED = 'Merged into main. All tests pass.\n│ >      │';
const PROMPT = 'Do you want to proceed?\n  1) Yes\n  2) No, tell Claude what to do differently';

function row(key: string, over: Partial<MemoryRow> = {}): MemoryRow {
	return {
		key, name: key, workspaceId: 'ws', workspaceName: 'W', repo: 'r', branch: `wt/${key}`,
		pid: 1, busy: false, idleSince: T0 - 2 * HOUR, hidden: false,
		rssBytes: 100, procCount: 1, dead: false, ...over,
	};
}

/** A whole floor under test control: the clock, the timers, what the monitor reports, what the
 *  tiles say about themselves, and every session the closer ends. */
function floor(cfgRaw: unknown) {
	let now = T0;
	let cfg: AutoCloseConfig = parseAutoClose(cfgRaw);
	let rows: MemoryRow[] = [row('a'), row('b')];
	const facts = new Map<string, SessionFacts>([
		['a', { kind: 'worker', output: FINISHED, touchedAt: null, held: false }],
		['b', { kind: 'worker', output: FINISHED, touchedAt: null, held: false }],
	]);
	const subs: Array<(r: MemoryReport) => void> = [];
	let timers: Array<{ at: number; fn: () => void; h: number }> = [];
	let nextH = 1;
	const ended: string[] = [];
	const shown: Array<{ kind: 'warn' | 'result' | 'hide'; view?: NoticeView; deadline?: number }> = [];
	let actions: { keep: () => void; closeNow: () => void } | null = null;

	const report = (): MemoryReport => ({
		sessions: rows, unattributed: { rssBytes: 0, procCount: 0, pids: [] }, appSelfBytes: 0, totalBytes: 0,
	});
	const notice: AutoCloseNotice = {
		warn: (view, deadline, a) => { shown.push({ kind: 'warn', view, deadline }); actions = a; },
		result: (view) => { shown.push({ kind: 'result', view }); },
		hide: () => { shown.push({ kind: 'hide' }); },
	};
	const closer = new AutoCloser({
		config: () => cfg,
		subscribe: (_ms, fn) => { subs.push(fn); return () => { subs.splice(subs.indexOf(fn), 1); }; },
		refresh: async () => report(),
		facts: (k) => facts.get(k),
		endSession: async (_ws, key) => { ended.push(key); rows = rows.filter((r) => r.key !== key); return true; },
		notice,
		now: () => now,
		setTimeout: (fn, ms) => { const h = nextH++; timers.push({ at: now + ms, fn, h }); return h; },
		clearTimeout: (h) => { timers = timers.filter((t) => t.h !== h); },
	});
	const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
	return {
		closer, facts, ended, shown,
		get subs() { return subs.length; },
		setRows: (r: MemoryRow[]) => { rows = r; },
		setCfg: (raw: unknown) => { cfg = parseAutoClose(raw); closer.apply(); },
		actions: () => actions!,
		/** The monitor's periodic poll delivering a report. */
		poll: async () => { for (const s of [...subs]) s(report()); await flush(); },
		/** Advance the clock, firing any timer that comes due along the way. */
		advance: async (ms: number) => {
			const end = now + ms;
			for (;;) {
				const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
				if (!due) break;
				timers = timers.filter((t) => t !== due);
				now = due.at;
				due.fn();
				await flush();
			}
			now = end;
			await flush();
		},
	};
}

const ON = { enabled: true, idleMs: HOUR };

describe('AutoCloser — off by default', () => {
	it('with no setting at all, nothing is watched and nothing closes, however long it runs', async () => {
		const f = floor(undefined);
		f.closer.apply();
		expect(f.subs).toBe(0); // nothing that could close a session even exists
		await f.poll();
		await f.advance(24 * HOUR);
		expect(f.ended).toEqual([]);
		expect(f.shown).toEqual([]);
	});

	it('turning it off during the warning stands the batch down with nothing closed', async () => {
		const f = floor(ON);
		f.closer.apply();
		await f.poll();
		expect(f.closer.pending).toBe(true);
		f.setCfg({ enabled: false, idleMs: HOUR });
		await f.advance(AUTO_CLOSE_WARN_MS * 2);
		expect(f.ended).toEqual([]);
		expect(f.shown.at(-1)!.kind).toBe('hide');
		expect(f.subs).toBe(0);
	});
});

describe('AutoCloser — warn, then close what is still finished', () => {
	it('names the batch first and closes nothing until the window has passed', async () => {
		const f = floor(ON);
		f.closer.apply();
		await f.poll();
		expect(f.shown[0]!.kind).toBe('warn');
		expect(f.shown[0]!.view!.lines.join('\n')).toMatch(/^a \(W.*\nb \(W/);
		await f.advance(AUTO_CLOSE_WARN_MS - 1);
		expect(f.ended).toEqual([]);
		await f.advance(1);
		expect(f.ended).toEqual(['a', 'b']);
		expect(f.shown.at(-1)!.kind).toBe('result');
		expect(f.shown.at(-1)!.view!.title).toBe('Auto-closed 2 finished sessions');
	});

	it('interaction inside the window removes that session from the batch', async () => {
		const f = floor(ON);
		f.closer.apply();
		await f.poll();
		await f.advance(20_000);
		f.facts.set('b', { ...f.facts.get('b')!, touchedAt: T0 + 20_000 }); // someone typed into b
		await f.advance(AUTO_CLOSE_WARN_MS);
		expect(f.ended).toEqual(['a']);
		expect(f.shown.at(-1)!.view!.detail).toContain('b');
	});

	it('a session that hits a prompt inside the window is dropped, not closed', async () => {
		const f = floor(ON);
		f.closer.apply();
		await f.poll();
		f.facts.set('a', { ...f.facts.get('a')!, output: PROMPT });
		await f.advance(AUTO_CLOSE_WARN_MS);
		expect(f.ended).toEqual(['b']);
	});

	it('a session that goes busy inside the window is dropped, and the notice is re-drawn without it', async () => {
		const f = floor(ON);
		f.closer.apply();
		await f.poll();
		f.setRows([row('a', { busy: true, idleSince: null }), row('b')]);
		await f.advance(15_000); // one re-check
		const warns = f.shown.filter((s) => s.kind === 'warn');
		expect(warns.at(-1)!.view!.lines).toHaveLength(1);
		expect(warns.at(-1)!.view!.lines[0]).toMatch(/^b /);
		await f.advance(AUTO_CLOSE_WARN_MS);
		expect(f.ended).toEqual(['b']);
	});

	it('if every named session changes, it stands down and says so', async () => {
		const f = floor(ON);
		f.closer.apply();
		await f.poll();
		f.setRows([row('a', { busy: true, idleSince: null }), row('b', { busy: true, idleSince: null })]);
		await f.advance(AUTO_CLOSE_WARN_MS);
		expect(f.ended).toEqual([]);
		expect(f.shown.at(-1)!.view!.title).toMatch(/stood down/);
	});

	it('Keep closes nothing and does not re-offer them until a whole threshold has passed again', async () => {
		const f = floor(ON);
		f.closer.apply();
		await f.poll();
		f.actions().keep();
		expect(f.shown.at(-1)!.kind).toBe('hide');
		await f.advance(AUTO_CLOSE_WARN_MS * 2);
		await f.poll();
		expect(f.closer.pending).toBe(false);
		expect(f.ended).toEqual([]);
		await f.advance(HOUR);
		await f.poll();
		expect(f.closer.pending).toBe(true);
	});

	it('Close now closes at once — and only once, even if the deadline lands too', async () => {
		const f = floor(ON);
		f.closer.apply();
		await f.poll();
		f.actions().closeNow();
		f.actions().closeNow();
		await f.advance(AUTO_CLOSE_WARN_MS);
		expect(f.ended).toEqual(['a', 'b']);
	});

	it('a session waiting at a prompt is never even named', async () => {
		const f = floor(ON);
		f.facts.set('a', { ...f.facts.get('a')!, output: PROMPT });
		f.closer.apply();
		await f.poll();
		expect(f.shown[0]!.view!.lines).toHaveLength(1);
		await f.advance(AUTO_CLOSE_WARN_MS);
		expect(f.ended).toEqual(['b']);
	});
});
