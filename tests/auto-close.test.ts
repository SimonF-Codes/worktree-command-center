import { describe, it, expect } from 'vitest';
import {
	autoCloseCandidates, exclusion, parseAutoClose, settleBatch, warningNotice, resultNotice,
	AUTO_CLOSE_OFF, AUTO_CLOSE_MIN_MS, type AutoCloseConfig, type SessionFacts,
} from '../src/terminals/auto-close';
import type { MemoryRow } from '../src/terminals/session-memory';

const HOUR = 60 * 60_000;
const NOW = 1_700_000_000_000;
const ON: AutoCloseConfig = { enabled: true, idleMs: HOUR };

function row(key: string, over: Partial<MemoryRow> = {}): MemoryRow {
	return {
		key, name: key, workspaceId: 'ws', workspaceName: 'W', repo: 'r', branch: `wt/${key}`,
		pid: 1, busy: false, idleSince: NOW - 2 * HOUR, hidden: false,
		rssBytes: 100, procCount: 1, dead: false, ...over,
	};
}

/** A session that has plainly finished: a summary, then Claude's empty input box. */
const FINISHED = 'Merged into main. All 412 tests pass.\n\n╭────────╮\n│ >      │\n╰────────╯\n  ? for shortcuts';
const PROMPT = 'Bash command\n  git push origin main\n\nDo you want to proceed?\n  1) Yes\n  2) No, tell Claude what to do differently';
const MENU = 'Select a model\n  ❯ Opus\n    Sonnet\n\n  ↑/↓ to navigate · Enter to select · Esc to cancel';
const ERRORED = 'npm test\n\n FAIL  tests/foo.test.ts\nError: expected 2 to be 3\n\n│ >      │';

function facts(output: string, over: Partial<SessionFacts> = {}): SessionFacts {
	return { kind: 'worker', output, touchedAt: null, held: false, ...over };
}

const lookup = (m: Record<string, SessionFacts>) => (k: string): SessionFacts | undefined => m[k];

describe('auto-close eligibility — idle is not finished', () => {
	it('a plain finished session idle past the threshold IS eligible', () => {
		const got = autoCloseCandidates([row('a')], lookup({ a: facts(FINISHED) }), ON, NOW);
		expect(got.map((r) => r.key)).toEqual(['a']);
	});

	it('a session idle past the threshold but sitting at a prompt is NOT eligible', () => {
		// The defining case: idle for two hours precisely BECAUSE it is waiting for a person.
		expect(exclusion(facts(PROMPT), ON.idleMs, NOW)).toBe('prompt');
		expect(autoCloseCandidates([row('a')], lookup({ a: facts(PROMPT) }), ON, NOW)).toEqual([]);
	});

	it('a session at a menu is NOT eligible', () => {
		expect(exclusion(facts(MENU), ON.idleMs, NOW)).toBe('menu');
		expect(autoCloseCandidates([row('a')], lookup({ a: facts(MENU) }), ON, NOW)).toEqual([]);
	});

	it('an errored session is NOT eligible', () => {
		expect(exclusion(facts(ERRORED), ON.idleMs, NOW)).toBe('errored');
		expect(autoCloseCandidates([row('a')], lookup({ a: facts(ERRORED) }), ON, NOW)).toEqual([]);
	});

	it('keeps idleLongerThan\'s exclusions: busy, system, dead, not idle long enough', () => {
		const rows = [
			row('busy', { busy: true, idleSince: null }),
			row('sys', { system: true }),
			row('dead', { dead: true }),
			row('fresh', { idleSince: NOW - HOUR / 2 }),
			row('ok'),
		];
		const f = Object.fromEntries(rows.map((r) => [r.key, facts(FINISHED)]));
		expect(autoCloseCandidates(rows, lookup(f), ON, NOW).map((r) => r.key)).toEqual(['ok']);
	});

	it('never the overseer console, a journal, or a folder target', () => {
		for (const kind of ['overseer', 'journal', 'folder'] as const) {
			expect(exclusion(facts(FINISHED, { kind }), ON.idleMs, NOW)).toBe('not-a-worker');
		}
	});

	it('a session nobody can describe fails closed', () => {
		expect(autoCloseCandidates([row('a')], lookup({}), ON, NOW)).toEqual([]);
	});

	it('any interaction inside the threshold resets the clock — quiet is not left alone', () => {
		const touched = facts(FINISHED, { touchedAt: NOW - 10 * 60_000 });
		expect(exclusion(touched, ON.idleMs, NOW)).toBe('touched');
		// Touched long ago counts for nothing.
		expect(exclusion(facts(FINISHED, { touchedAt: NOW - 3 * HOUR }), ON.idleMs, NOW)).toBeNull();
	});

	it('the locked tile is held, not finished', () => {
		expect(exclusion(facts(FINISHED, { held: true }), ON.idleMs, NOW)).toBe('held');
	});
});

describe('auto-close is OFF unless explicitly opted into', () => {
	it('nothing is a candidate while disabled, whatever the rows say', () => {
		const rows = [row('a'), row('b', { idleSince: NOW - 48 * HOUR })];
		const f = lookup({ a: facts(FINISHED), b: facts(FINISHED) });
		expect(autoCloseCandidates(rows, f, AUTO_CLOSE_OFF, NOW)).toEqual([]);
		expect(autoCloseCandidates(rows, f, { enabled: false, idleMs: HOUR }, NOW)).toEqual([]);
	});

	it('a missing or malformed setting reads as off', () => {
		for (const raw of [undefined, null, {}, 'on', { enabled: 'yes', idleMs: HOUR }, { enabled: 1, idleMs: HOUR },
			{ enabled: true }, { enabled: true, idleMs: 0 }, { enabled: true, idleMs: NaN },
			{ enabled: true, idleMs: AUTO_CLOSE_MIN_MS - 1 }, { enabled: true, idleMs: '3600000' }]) {
			expect(parseAutoClose(raw)).toEqual(AUTO_CLOSE_OFF);
		}
	});

	it('an explicit opt-in with a usable threshold is on', () => {
		expect(parseAutoClose({ enabled: true, idleMs: 2 * HOUR })).toEqual({ enabled: true, idleMs: 2 * HOUR });
	});
});

describe('the warning window re-evaluates rather than trusting the first look', () => {
	it('interaction inside the window removes that session from the batch', () => {
		const named = autoCloseCandidates([row('a'), row('b')], lookup({ a: facts(FINISHED), b: facts(FINISHED) }), ON, NOW);
		expect(named.map((r) => r.key)).toEqual(['a', 'b']);
		// 30s later someone typed into b.
		const later = NOW + 30_000;
		const now = autoCloseCandidates([row('a'), row('b')],
			lookup({ a: facts(FINISHED), b: facts(FINISHED, { touchedAt: later }) }), ON, later);
		const { keep, dropped } = settleBatch(named, now);
		expect(keep.map((r) => r.key)).toEqual(['a']);
		expect(dropped.map((r) => r.key)).toEqual(['b']);
	});

	it('a named session that goes busy or hits a prompt is dropped, not closed', () => {
		const named = [row('a'), row('b'), row('c')];
		const rowsNow = [row('a', { busy: true, idleSince: null }), row('b'), row('c')];
		const now = autoCloseCandidates(rowsNow, lookup({ a: facts(FINISHED), b: facts(PROMPT), c: facts(FINISHED) }), ON, NOW);
		const { keep, dropped } = settleBatch(named, now);
		expect(keep.map((r) => r.key)).toEqual(['c']);
		expect(dropped.map((r) => r.key)).toEqual(['a', 'b']);
	});

	it('a session that became a candidate after the notice is not slipped into it', () => {
		const { keep } = settleBatch([row('a')], [row('a'), row('late')]);
		expect(keep.map((r) => r.key)).toEqual(['a']);
	});

	it('a session that vanished (closed by hand) is dropped', () => {
		expect(settleBatch([row('a')], []).dropped.map((r) => r.key)).toEqual(['a']);
	});
});

describe('the notices name what is at stake', () => {
	it('the warning names every session, with its workspace and idle time', () => {
		const v = warningNotice([row('alpha'), row('beta')], HOUR, 59_400, NOW);
		expect(v.title).toContain('2 finished sessions in 60s');
		expect(v.lines).toHaveLength(2);
		expect(v.lines[0]).toMatch(/^alpha \(W, idle /);
		expect(v.lines[1]).toMatch(/^beta \(W, idle /);
		expect(v.detail).toMatch(/Reopen/);
	});

	it('past eight it names eight and counts the rest', () => {
		const rows = Array.from({ length: 11 }, (_, i) => row(`s${i}`));
		const v = warningNotice(rows, HOUR, 60_000, NOW);
		expect(v.lines).toHaveLength(9);
		expect(v.lines[8]).toBe('…and 3 more');
	});

	it('the result says what was closed, what was spared and why, and the way back', () => {
		const v = resultNotice([row('a')], [row('b')], NOW);
		expect(v.title).toBe('Auto-closed 1 finished session');
		expect(v.lines[0]).toContain('a (W');
		expect(v.detail).toContain('b');
		expect(v.detail).toMatch(/Reopen/);
		expect(resultNotice([], [row('b')], NOW).title).toMatch(/stood down/);
	});
});
