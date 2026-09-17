import { indexProcesses, subtreePids, type ProcRow } from './process-snapshot';

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
 *  "close 7 sessions" is not something anyone can agree to honestly. */
export function bulkConfirm(victims: readonly MemoryRow[], thresholdLabel: string, now: number): ConfirmCopy {
	const shown = victims.slice(0, 8)
		.map((v) => `• ${v.name} (${v.workspaceName}, idle ${formatIdle(now - (v.idleSince ?? now))})`)
		.join('\n');
	const rest = victims.length > 8 ? `\n• …and ${victims.length - 8} more` : '';
	const freed = victims.reduce((a, v) => a + v.rssBytes, 0);
	return {
		title: `Close ${victims.length} session${victims.length === 1 ? '' : 's'} idle over ${thresholdLabel}?`,
		body: `${shown}${rest}\n\nAbout ${formatBytes(freed)}. Sessions that are working are NOT included. `
			+ 'Each conversation, worktree and branch is kept; uncommitted work is parked.',
		okLabel: `Close ${victims.length}`,
	};
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
