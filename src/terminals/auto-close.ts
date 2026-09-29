import { idleLongerThan, formatIdle, type MemoryRow } from './session-memory';
import { looksLikeMenu, looksErrored } from './prompt-detect';
import { looksLikePrompt } from './chat-room';

/** Auto-closing finished sessions: the rule for WHEN NOT TO, kept pure so it is a test rather
 *  than a judgement buried in a timer.
 *
 *  The memory tracker's design says "never auto-close — which sessions matter is a judgement
 *  only Simon has, and an auto-reaper that gets it wrong corrupts a shared repo". That objection
 *  is overridden knowingly, and it is answered by exactly three things, none of which may be
 *  weakened:
 *   1. the exclusions below — a session waiting on a human, or showing an error, is never a
 *      candidate however long it has been quiet;
 *   2. the warning window, which names every session before anything is closed;
 *   3. closing through endSessionKeepingWork, which parks work and keeps the worktree, branch
 *      and transcript, so Reopen brings the session back.
 *  And it is off unless someone turns it on with an explicit threshold. */

export interface AutoCloseConfig {
	enabled: boolean;
	/** Idle AND untouched for at least this long. Meaningless while disabled. */
	idleMs: number;
}

export const AUTO_CLOSE_OFF: AutoCloseConfig = { enabled: false, idleMs: 0 };

/** The thresholds Settings offers. Hours, like the manual bulk close, because the sessions
 *  worth closing are hours old — and a short threshold is where a wrong call is likeliest. */
export const AUTO_CLOSE_CHOICES: ReadonlyArray<{ label: string; ms: number }> = [
	{ label: '1 hour', ms: 60 * 60_000 },
	{ label: '2 hours', ms: 2 * 60 * 60_000 },
	{ label: '4 hours', ms: 4 * 60 * 60_000 },
	{ label: '8 hours', ms: 8 * 60 * 60_000 },
];

/** Floor on any threshold read from config, whatever was written there by hand. */
export const AUTO_CLOSE_MIN_MS = 30 * 60_000;

/** How long the notice stands before anything is closed. */
export const AUTO_CLOSE_WARN_MS = 60_000;

/** Read the setting from the app config. Anything short of an explicit opt-in with a usable
 *  threshold is OFF: a missing key, a malformed one, `enabled: "yes"`, a threshold of zero.
 *  Off is the default and the failure mode. */
export function parseAutoClose(raw: unknown): AutoCloseConfig {
	if (!raw || typeof raw !== 'object') return AUTO_CLOSE_OFF;
	const r = raw as { enabled?: unknown; idleMs?: unknown };
	if (r.enabled !== true) return AUTO_CLOSE_OFF;
	if (typeof r.idleMs !== 'number' || !Number.isFinite(r.idleMs) || r.idleMs < AUTO_CLOSE_MIN_MS) return AUTO_CLOSE_OFF;
	return { enabled: true, idleMs: r.idleMs };
}

/** The threshold in words, for the notice and the Settings row. */
export function thresholdLabel(ms: number): string {
	return AUTO_CLOSE_CHOICES.find((c) => c.ms === ms)?.label ?? formatIdle(ms);
}

/** What a session's tile knows that the memory report does not. */
export interface SessionFacts {
	/** Only `worker` can ever be auto-closed. A journal and the overseer console are not worker
	 *  sessions; a folder target has no worktree branch for Reopen to find, so closing one is not
	 *  the reversible act the whole feature leans on. */
	kind: 'worker' | 'folder' | 'journal' | 'overseer';
	/** The tile's recent on-screen output — what a person would see if they looked. */
	output: string;
	/** The last time a person did something to this tile — typed into it, centered it,
	 *  resurfaced it, locked it, or pressed Keep on a notice naming it. Null if never. */
	touchedAt: number | null;
	/** Pinned by the individual lock: an explicit "keep this one in front of me". */
	held: boolean;
}

/** Why a session that idleLongerThan would offer is NOT a candidate. */
export type Exclusion = 'unknown' | 'not-a-worker' | 'held' | 'prompt' | 'menu' | 'errored' | 'touched';

/** The reasons, in the order they are checked. Waiting-on-a-human comes before errored because
 *  it is the defining case: idle-longest and waiting-on-you are the same sessions. */
export function exclusion(facts: SessionFacts | undefined, idleMs: number, now: number): Exclusion | null {
	// No facts means the tile could not be asked — fail closed, never open.
	if (!facts) return 'unknown';
	if (facts.kind !== 'worker') return 'not-a-worker';
	if (facts.held) return 'held';
	// The same judgement handleReady makes before firing a watch: idle but stalled on a
	// question is not finished.
	if (looksLikePrompt(facts.output)) return 'prompt';
	if (looksLikeMenu(facts.output)) return 'menu';
	// Something worth looking at. Sweeping a failure away silently is how it goes unnoticed.
	if (looksErrored(facts.output)) return 'errored';
	// "Left alone" means left alone, not merely quiet.
	if (facts.touchedAt !== null && now - facts.touchedAt < idleMs) return 'touched';
	return null;
}

/** The sessions auto-close may name in a notice right now.
 *
 *  Built ON idleLongerThan rather than beside it, so the busy / system / dead exclusions the
 *  manual bulk close relies on are inherited, not re-derived. Everything this adds is an
 *  additional reason NOT to close. Disabled means nothing, whatever the rows say. */
export function autoCloseCandidates(
	rows: readonly MemoryRow[],
	factsFor: (key: string) => SessionFacts | undefined,
	cfg: AutoCloseConfig,
	now: number,
): MemoryRow[] {
	if (!cfg.enabled) return [];
	return idleLongerThan(rows, cfg.idleMs, now).filter((r) => exclusion(factsFor(r.key), cfg.idleMs, now) === null);
}

/** Re-evaluate a named batch against the candidates as they stand NOW.
 *
 *  Only sessions that were named AND are still candidates are kept: anything that went busy,
 *  hit a prompt, errored or was touched since the notice went up is dropped rather than closed
 *  on the strength of the older look. Sessions that became candidates after the notice are NOT
 *  added — nobody was told about them; they wait for a notice of their own. */
export function settleBatch(
	named: readonly MemoryRow[],
	candidatesNow: readonly MemoryRow[],
): { keep: MemoryRow[]; dropped: MemoryRow[] } {
	const now = new Map(candidatesNow.map((r) => [r.key, r]));
	const keep: MemoryRow[] = [];
	const dropped: MemoryRow[] = [];
	for (const n of named) {
		const fresh = now.get(n.key);
		if (fresh) keep.push(fresh); else dropped.push(n);
	}
	return { keep, dropped };
}

const MAX_NAMED = 8;

function nameList(rows: readonly MemoryRow[], now: number): string[] {
	const lines = rows.slice(0, MAX_NAMED)
		.map((v) => `${v.name} (${v.workspaceName}, idle ${formatIdle(now - (v.idleSince ?? now))})`);
	if (rows.length > MAX_NAMED) lines.push(`…and ${rows.length - MAX_NAMED} more`);
	return lines;
}

export interface NoticeView {
	title: string;
	/** One line per session — names, not a count, for the same reason the tab-close confirm
	 *  lists what is at stake: "closing 7 sessions" is not something anyone can veto honestly. */
	lines: string[];
	detail: string;
}

/** The warning, while the window is open. The countdown itself is the renderer's, so the copy
 *  does not have to be rebuilt every second. */
export function warningNotice(batch: readonly MemoryRow[], idleMs: number, now: number): NoticeView {
	const n = batch.length;
	return {
		title: `Closing ${n} finished session${n === 1 ? '' : 's'} — idle and untouched over ${thresholdLabel(idleMs)}`,
		lines: nameList(batch, now),
		detail: 'Uncommitted work is parked as a wip commit; each conversation, worktree and branch is kept. '
			+ 'Anything that starts working, asks a question or is touched before then is left alone. '
			+ 'Bring one back: Coordination panel → its branch in the worktree list → Reopen.',
	};
}

/** What happened, left on screen until dismissed — a floor that emptied while you were away
 *  must say so when you come back, not in a toast that expired an hour ago. */
export function resultNotice(closed: readonly MemoryRow[], dropped: readonly MemoryRow[], now: number): NoticeView {
	const n = closed.length;
	const kept = dropped.length
		? `Left alone because they changed during the warning: ${dropped.map((d) => d.name).join(', ')}. `
		: '';
	return {
		title: n
			? `Auto-closed ${n} finished session${n === 1 ? '' : 's'}`
			: 'Auto-close stood down — nothing it named was still finished',
		lines: nameList(closed, now),
		detail: `${kept}${n ? 'Reopen any of them from the Coordination panel → its branch in the worktree list → Reopen. ' : ''}`
			+ 'Auto-close is set in ⚙ Settings.',
	};
}
