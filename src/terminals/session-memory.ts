import { indexProcesses, subtreePids, type ProcRow } from './process-snapshot';
import type { CloseablePlan } from './unattributed-tracker';

/** What a session tells the tracker about itself.
 *
 *  `pid` is its sidecar's pid, taken straight from the bridge that owns it. Memory is rolled
 *  up from that pid's subtree, so attribution is exact — no matching on command-line strings,
 *  which guess at ownership and quietly get it wrong. */
export interface SessionClaim {
	/** Stable across polls: workspace id + tile id. */
	key: string;
	name: string;
	workspaceId: string;
	workspaceName: string;
	repo: string;
	branch: string;
	pid: number | null;
	/** Mid-response. Closing one of these loses the turn — the only real risk in the feature. */
	busy: boolean;
	/** When the session last went idle; null while busy or not yet known. */
	idleSince: number | null;
	hidden: boolean;
	/** Rows the panel must never offer to close — the usage battery's own probe session. */
	system?: boolean;
}

export interface MemoryRow extends SessionClaim {
	/** Working set of the sidecar and everything under it. */
	rssBytes: number;
	procCount: number;
	/** Claimed a pid the snapshot doesn't contain: the tile is on the floor but its session is
	 *  gone. Never attributed memory, and worth showing rather than hiding. */
	dead: boolean;
}

export interface Unattributed {
	rssBytes: number;
	procCount: number;
	pids: number[];
}

export interface MemoryReport {
	sessions: MemoryRow[];
	/** Processes in the app's own subtree that NO session claims.
	 *
	 *  This is the point of the whole panel, not an edge case. A tracker built by summing the
	 *  tile list would have reported "5 terminals, all healthy" on the morning 81 `claude`
	 *  processes were holding 19.5 GB, because 76 of them belonged to no tile. A number here
	 *  that is not near zero means the app is running something it has forgotten about. */
	unattributed: Unattributed;
	/** The app process itself, kept separate so it is never mistaken for a session. */
	appSelfBytes: number;
	totalBytes: number;
}

/** Roll one process snapshot up into per-session memory, plus whatever nothing claims.
 *
 *  Pure: takes rows in, gives a report out. Platform-independent by construction — the
 *  snapshot is the only part that knows about Windows. */
export function attributeMemory(
	rows: readonly ProcRow[],
	appPid: number,
	claims: readonly SessionClaim[],
): MemoryReport {
	// Indexed once: a workspace can hold dozens of sessions, and rebuilding the parent map per
	// session would make the poll quadratic in the process count.
	const ix = indexProcesses(rows);
	const subtree = (root: number): number[] => subtreePids(ix, root);
	const rss = (pids: readonly number[]): number =>
		pids.reduce((sum, p) => sum + (ix.byPid.get(p)?.rssBytes ?? 0), 0);

	const claimed = new Set<number>();
	const sessions: MemoryRow[] = claims.map((c) => {
		const pids = c.pid === null ? [] : subtree(c.pid);
		for (const p of pids) claimed.add(p);
		return { ...c, rssBytes: rss(pids), procCount: pids.length, dead: c.pid !== null && pids.length === 0 };
	});
	// Biggest first: the panel exists to answer "what should I close", and that is the order
	// the answer arrives in.
	sessions.sort((a, b) => b.rssBytes - a.rssBytes || a.name.localeCompare(b.name));

	const strayPids = subtree(appPid).filter((p) => p !== appPid && !claimed.has(p));
	const unattributed: Unattributed = { rssBytes: rss(strayPids), procCount: strayPids.length, pids: strayPids };
	const appSelfBytes = ix.byPid.get(appPid)?.rssBytes ?? 0;

	return {
		sessions,
		unattributed,
		appSelfBytes,
		totalBytes: sessions.reduce((a, s) => a + s.rssBytes, 0) + unattributed.rssBytes + appSelfBytes,
	};
}

/** Sessions that have been idle for at least `ms` — the candidates for a bulk close.
 *
 *  Busy sessions are excluded outright rather than merely warned about: a bulk action can't
 *  ask about each one, and "close everything idle" must never quietly end a running turn.
 *  System rows are excluded too — the usage probe is not the user's to close. */
export function idleLongerThan(sessions: readonly MemoryRow[], ms: number, now: number): MemoryRow[] {
	return sessions.filter((s) => !s.busy && !s.system && !s.dead && s.idleSince !== null && now - s.idleSince >= ms);
}

export interface ConfirmCopy { title: string; body: string; okLabel: string }

/** What the panel asks before closing ONE session.
 *
 *  The busy/idle split is the only real risk in the feature and therefore the only thing the
 *  confirm has to get right: an idle session loses nothing at all, a mid-response one loses the
 *  turn it is in the middle of. Pure, so the wording is testable rather than buried in a
 *  click handler. */
export function closeConfirm(row: Pick<MemoryRow, 'name' | 'busy'>): ConfirmCopy {
	return {
		title: `Close "${row.name}"?`,
		body: row.busy
			? 'This session is WORKING RIGHT NOW — closing it loses the turn in progress. '
				+ 'Everything up to this point is kept, and so are the worktree and branch, so it can be reopened with --continue.'
			: 'The conversation, the worktree and the branch are all kept; uncommitted work is parked as a wip commit first. '
				+ 'Reopen brings it back with --continue.',
		okLabel: 'Close session',
	};
}

/** What the panel asks before a bulk close. Names them — at most eight, then a count — because
 *  "close 7 sessions" is not something anyone can agree to honestly.
 *
 *  It also names the route back, the same promise closeConfirm() makes for a single session.
 *  Closing nine at once and being told only that things are "kept" reads as data loss at the
 *  moment it matters: nothing is lost, but the user has no idea where to look, so the route is
 *  spelled out as a click path rather than left as "it can be reopened". */
export function bulkConfirm(victims: readonly MemoryRow[], thresholdLabel: string, now: number): ConfirmCopy {
	const shown = victims.slice(0, 8)
		.map((v) => `• ${v.name} (${v.workspaceName}, idle ${formatIdle(now - (v.idleSince ?? now))})`)
		.join('\n');
	const rest = victims.length > 8 ? `\n• …and ${victims.length - 8} more` : '';
	const freed = victims.reduce((a, v) => a + v.rssBytes, 0);
	return {
		title: `Close ${victims.length} session${victims.length === 1 ? '' : 's'} idle over ${thresholdLabel}?`,
		body: `${shown}${rest}\n\nAbout ${formatBytes(freed)}. Sessions that are working are NOT included. `
			+ 'Each conversation, worktree and branch is kept; uncommitted work is parked. '
			+ 'To bring one back: Coordination panel → its branch in the worktree list → Reopen.',
		okLabel: `Close ${victims.length}`,
	};
}

/** What the panel asks before closing unattributed processes.
 *
 *  Every single one is NAMED, with what it is, how long it has been unattributed, how long it
 *  has been alive at all, and what it is holding. Same rule as the tab-close and the bulk-idle
 *  confirms, for the same reason — "close 31 processes" is not something anyone can agree to
 *  honestly — but here it carries more weight, because this is the last gate before a kill that
 *  no session asked for.
 *
 *  The copy also says what is NOT in the list and why. The reason a list is short is as
 *  important as the list: `git` from the coordination hooks lives in this same set and is gone
 *  within seconds, and its absence here is the feature working, not the feature missing things.
 *
 *  Pure, so the wording is a test rather than something buried in a click handler. */
export function unattributedConfirm(plan: CloseablePlan, now: number, thresholdLabel: string): ConfirmCopy {
	const n = plan.victims.length;
	const lines = plan.victims
		.map((v) => `• ${v.name || 'unnamed'} (pid ${v.pid}) — unattributed ${formatIdle(now - v.firstSeen)}, `
			+ `running ${formatIdle(now - v.startedAt)} · ${formatBytes(v.rssBytes)}`)
		.join('\n');
	const trees = plan.trees.length < n
		? ` They are killed as ${plan.trees.length} process tree${plan.trees.length === 1 ? '' : 's'}, so the children go with their parents.`
		: '';
	return {
		title: `Close ${n} unattributed process${n === 1 ? '' : 'es'}?`,
		body: `${lines}\n\nAbout ${formatBytes(plan.totalBytes)} in total.${trees}\n\n`
			+ `Listed only because each has been unattributed in EVERY snapshot for over ${thresholdLabel} `
			+ 'and across several polls. Anything younger is LEFT ALONE: git from the coordination hooks, '
			+ 'cos-coord and their conhosts live in this same set and are gone within seconds, and killing '
			+ 'one mid-write can leave a lock in a repo the other terminals share. Nothing a session claims '
			+ 'is ever included, and nothing here is ever closed automatically.',
		okLabel: `Close ${n}`,
	};
}

/** What actually happened when the unattributed close ran. */
export interface KillOutcome {
	/** Processes confirmed dead, counting everything that went with a killed tree. */
	ended: number;
	freedBytes: number;
	/** Trees whose kill could not be confirmed, with taskkill's own explanation. */
	failed: Array<{ pid: number; detail: string }>;
	/** Process TREES that were in the confirm but no longer eligible when the kill ran — a
	 *  child was spawned under one, or it died on its own, while the dialog was open. */
	skipped: number;
}

/** How the panel reports that outcome.
 *
 *  A kill that silently failed MUST NOT read as a success. taskkill can refuse — access denied,
 *  a process mid-exit — and the pid is kept by kill-tree for a later retry, but the person who
 *  pressed the button has to be told now, or they will believe the memory came back and go
 *  looking for a different explanation.
 *
 *  Pure, because "did it work" is exactly the sentence worth testing. */
export function unattributedResult(o: KillOutcome): { message: string; variant: 'info' | 'warn' | 'error' } {
	const freed = ` — freed about ${formatBytes(o.freedBytes)}`;
	const left = o.skipped
		? `; ${o.skipped} changed while you were deciding and ${o.skipped === 1 ? 'was' : 'were'} left alone`
		: '';
	if (o.failed.length) {
		const first = o.failed[0]!;
		const more = o.failed.length > 1 ? ` (and ${o.failed.length - 1} more)` : '';
		return {
			message: `Closed ${o.ended} process${o.ended === 1 ? '' : 'es'}${o.ended ? freed : ''}. `
				+ `${o.failed.length} REFUSED: pid ${first.pid}: ${first.detail}${more}${left}`,
			variant: 'error',
		};
	}
	if (!o.ended) {
		return {
			message: o.skipped
				? 'Closed nothing: everything in the list changed while you were deciding, and was left alone'
				: 'Closed nothing — they were already gone',
			variant: 'warn',
		};
	}
	return { message: `Closed ${o.ended} unattributed process${o.ended === 1 ? '' : 'es'}${freed}${left}`, variant: 'info' };
}

/** Bytes as the panel shows them: GB once it's worth it, MB below that. */
export function formatBytes(n: number): string {
	if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	return `${Math.round(n / (1024 * 1024))} MB`;
}

/** A duration as "3h 40m" / "12m" / "just now". Coarse on purpose — nobody closes a session
 *  based on the seconds. */
export function formatIdle(ms: number): string {
	if (ms < 60_000) return 'just now';
	const mins = Math.floor(ms / 60_000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	const rem = mins % 60;
	if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d ${hours % 24}h`;
}
