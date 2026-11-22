// V2 Team Floor step 11 — attention.jsonl: how long a session waited on Simon. Pure: no fs, no clock.
//
// The classifier in TerminalsGrid.updateAttention runs every second and, until now, threw its
// result away once the marker and the toast were updated. Nothing recorded how long a session sat
// at a permission prompt or a stuck error, and that is the most direct flow measure the floor can
// produce. This records TRANSITIONS, NOT TICKS: a state that persists for an hour is one line, not
// 3600. The recorder below decides what to write; attention-log.ts (terminals/) only appends.
//
// A line says "from now on, this session is in <to>". An interval ends at the session's next line.
// `unobserved` ends one without starting another: the session ended, its workspace was switched
// away from (only a mounted grid is classified), or the app quit. A `boot` line is written before a
// process's first record, so a reader can tell an interval the previous process never closed (it
// crashed) from one that is still running — and refuse to guess the first one's length.

/** The classifier's coarse buckets (attention.ts AttentionKind), plus `none` for busy and clean. */
export type AttentionBucket = 'input' | 'help' | 'done' | 'none';
export type AttentionLogState = AttentionBucket | 'unobserved';
/** Why observation stopped: the session left the stage (ended, or hidden), the grid unmounted, or the app quit. */
export type UnobservedWhy = 'gone' | 'unmounted' | 'quit';

export interface AttentionTransition {
	v: 1; ts: number; sessionId: string; name: string;
	/** null on the first sighting in this process. */
	from: AttentionLogState | null;
	to: AttentionLogState;
	why?: UnobservedWhy;
}
export interface AttentionBoot { v: 1; ts: number; ev: 'boot' }
export type AttentionLine = AttentionTransition | AttentionBoot;

/** The buckets that mean "waiting on a human": a prompt or menu (input), or a stuck error (help). */
export const BLOCKED: ReadonlySet<AttentionLogState> = new Set(['input', 'help']);

/** Decides what to write. One per grid. Holds only each session's last written state. */
export class AttentionRecorder {
	private last = new Map<string, { state: AttentionLogState; name: string }>();
	private booted = false;

	/** One classifier result. Returns the lines to append — empty when nothing changed. */
	observe(sessionId: string, name: string, to: AttentionBucket, now: number): AttentionLine[] {
		const prev = this.last.get(sessionId);
		if (prev && prev.state === to) { prev.name = name; return []; }
		this.last.set(sessionId, { state: to, name });
		return [...this.boot(now), { v: 1, ts: now, sessionId, name, from: prev?.state ?? null, to }];
	}

	/** Close every session not in `seen` (it ended, or was hidden: either way the tick no longer sees it). */
	forgetMissing(seen: ReadonlySet<string>, now: number): AttentionLine[] {
		const out: AttentionLine[] = [];
		for (const [id, s] of [...this.last]) {
			if (seen.has(id)) continue;
			this.last.delete(id);
			out.push({ v: 1, ts: now, sessionId: id, name: s.name, from: s.state, to: 'unobserved', why: 'gone' });
		}
		return out;
	}

	/** Stop observing everything (the grid unmounted, or the app is quitting). */
	unobserveAll(now: number, why: UnobservedWhy): AttentionLine[] {
		const out: AttentionLine[] = [...this.last].map(([id, s]) => ({ v: 1 as const, ts: now, sessionId: id, name: s.name, from: s.state, to: 'unobserved' as const, why }));
		this.last.clear();
		return out;
	}

	private boot(now: number): AttentionLine[] {
		if (this.booted) return [];
		this.booted = true;
		return [{ v: 1, ts: now, ev: 'boot' }];
	}
}

export function formatAttentionLines(lines: readonly AttentionLine[]): string {
	return lines.map((l) => JSON.stringify(l) + '\n').join('');
}

const STATES: ReadonlySet<string> = new Set(['input', 'help', 'done', 'none', 'unobserved']);

/** Read the log back, skipping anything that is not a line this module writes (a torn write). */
export function parseAttentionLog(text: string): AttentionLine[] {
	const out: AttentionLine[] = [];
	for (const raw of text.split(/\r?\n/)) {
		if (!raw.trim()) continue;
		try {
			const o = JSON.parse(raw) as Record<string, unknown>;
			if (!o || o.v !== 1 || typeof o.ts !== 'number') continue;
			if (o.ev === 'boot') { out.push({ v: 1, ts: o.ts, ev: 'boot' }); continue; }
			if (typeof o.sessionId === 'string' && typeof o.to === 'string' && STATES.has(o.to)) out.push(o as unknown as AttentionTransition);
		} catch { /* skip */ }
	}
	return out;
}

export interface Interval { sessionId: string; name: string; state: AttentionLogState; start: number; end: number }

/** Every interval the log can vouch for, plus how many it cannot. An interval ends at the session's
 *  next line. One still open when a `boot` line appears belonged to a process that died without
 *  saying so: its end is unknown, so it is COUNTED as unknown rather than stretched to the boot
 *  (which would bill a night the app was closed) or dropped silently. The newest open interval runs
 *  to `now` — the caller is the live app, or a CLI run beside it. */
export function attentionIntervals(lines: readonly AttentionLine[], now: number): { intervals: Interval[]; unknownEnd: number } {
	const sorted = [...lines].sort((a, b) => a.ts - b.ts);
	const open = new Map<string, { name: string; state: AttentionLogState; start: number }>();
	const intervals: Interval[] = [];
	let unknownEnd = 0;
	for (const l of sorted) {
		if ('ev' in l) {
			for (const o of open.values()) if (o.state !== 'unobserved') unknownEnd++;
			open.clear();
			continue;
		}
		const o = open.get(l.sessionId);
		if (o) intervals.push({ sessionId: l.sessionId, name: o.name, state: o.state, start: o.start, end: l.ts });
		open.set(l.sessionId, { name: l.name, state: l.to, start: l.ts });
	}
	for (const [sessionId, o] of open) intervals.push({ sessionId, name: o.name, state: o.state, start: o.start, end: Math.max(o.start, now) });
	return { intervals: intervals.filter((i) => i.state !== 'unobserved'), unknownEnd };
}

/** Milliseconds spent in a blocked bucket inside [since, until], every session summed. */
export function blockedMs(intervals: readonly Interval[], since: number, until: number): number {
	let ms = 0;
	for (const i of intervals) {
		if (!BLOCKED.has(i.state)) continue;
		const a = Math.max(i.start, since);
		const b = Math.min(i.end, until);
		if (b > a) ms += b - a;
	}
	return ms;
}

/** The sessions whose newest line puts them in a blocked bucket right now. */
export function blockedNow(lines: readonly AttentionLine[]): Array<{ sessionId: string; name: string; state: AttentionLogState; since: number }> {
	const latest = new Map<string, AttentionTransition>();
	let lastBoot = -Infinity;
	for (const l of lines) {
		if ('ev' in l) { lastBoot = Math.max(lastBoot, l.ts); continue; }
		const cur = latest.get(l.sessionId);
		if (!cur || l.ts >= cur.ts) latest.set(l.sessionId, l);
	}
	return [...latest.values()]
		.filter((l) => BLOCKED.has(l.to) && l.ts >= lastBoot)
		.map((l) => ({ sessionId: l.sessionId, name: l.name, state: l.to, since: l.ts }));
}
